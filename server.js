const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();

// Configure multer with unique filenames to prevent conflicts
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = './uploads';
        // Create uploads directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Serve static files (your index.html from public folder)
app.use(express.static('public'));
app.use(express.json());

// DeepSeek API configuration
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Clean up old files periodically (every hour)
setInterval(() => {
    const uploadDir = './uploads';
    if (fs.existsSync(uploadDir)) {
        const files = fs.readdirSync(uploadDir);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            // Delete files older than 1 hour
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up old file: ${file}`);
            }
        });
    }
}, 60 * 60 * 1000);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        hasApiKey: !!DEEPSEEK_API_KEY,
        timestamp: new Date().toISOString()
    });
});

// Endpoint to analyze PDF
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
    let filePath = null;
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        filePath = req.file.path;
        console.log(`[${new Date().toISOString()}] Processing: ${req.file.originalname}`);

        // Extract text from PDF
        const pdfBuffer = fs.readFileSync(filePath);
        let extractedText = '';
        
        try {
            const pdfData = await pdfParse(pdfBuffer);
            extractedText = pdfData.text;
            console.log(`Extracted ${extractedText.length} characters`);
        } catch (parseError) {
            console.error('PDF parse error:', parseError.message);
            extractedText = "Text extraction encountered issues. Analysis will proceed on available content.";
        }
        
        // If no text at all, provide a helpful message
        if (!extractedText || extractedText.trim().length < 50) {
            // Clean up file before responding
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return res.json({
                overallScore: 0,
                issues: [{
                    wcagCriterion: "No readable text",
                    severity: "Critical",
                    fixRecommendation: "This PDF appears to be an image or has no selectable text. OCR processing is required."
                }],
                summary: "No text content could be extracted. This may be a scanned document or an image-only PDF."
            });
        }

        // Truncate for API limits
        const textForAnalysis = extractedText.substring(0, 8000);

        const analysisPrompt = `You are a WCAG 2.1 Level AA accessibility auditor. 
        
Analyze this PDF document text and provide:
1. An overall compliance score from 0-100%
2. List of issues found with specific WCAG criteria violations
3. For each issue, include: severity (Critical/Serious/Minor), WCAG criterion, and fix recommendation

If the text shows clear evidence of accessibility features (proper headings, lists, table structures, alt text mentions, language specification), give a HIGHER score.
If the text is raw, unstructured, or missing key elements, give a LOWER score.

Document text:
${textForAnalysis}

Respond with ONLY valid JSON. Use this exact format:
{
    "overallScore": number,
    "issues": [
        {
            "wcagCriterion": string,
            "severity": string,
            "fixRecommendation": string
        }
    ],
    "summary": string
}`;

        console.log('Calling DeepSeek API...');
        
        const deepseekResponse = await axios.post(DEEPSEEK_API_URL, {
            model: "deepseek-chat",
            messages: [
                { role: "system", content: "You are a WCAG 2.1 AA accessibility compliance expert. Respond only with valid JSON. No explanations, no markdown, just JSON." },
                { role: "user", content: analysisPrompt }
            ],
            temperature: 0.3
        }, {
            headers: { 
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        // Parse the response
        let analysisResult;
        const responseContent = deepseekResponse.data.choices[0].message.content;
        console.log('DeepSeek response received');
        
        try {
            const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                analysisResult = JSON.parse(jsonMatch[0]);
            } else {
                analysisResult = JSON.parse(responseContent);
            }
        } catch (parseError) {
            console.error('JSON parse error:', parseError.message);
            analysisResult = {
                overallScore: 50,
                issues: [{
                    wcagCriterion: "Analysis parsing",
                    severity: "Minor",
                    fixRecommendation: "The analysis completed but had formatting issues."
                }],
                summary: "Partial analysis completed."
            };
        }

        // Ensure valid score
        if (typeof analysisResult.overallScore !== 'number') {
            analysisResult.overallScore = 50;
        }

        // ALWAYS clean up the uploaded file
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up: ${filePath}`);
        }

        res.json(analysisResult);

    } catch (error) {
        console.error('Analysis error:', error.message);
        
        // ALWAYS clean up the uploaded file, even on error
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up on error: ${filePath}`);
            } catch(e) {
                console.log('Cleanup error:', e.message);
            }
        }
        
        res.status(500).json({ 
            error: 'Analysis failed', 
            details: error.message,
            overallScore: 0,
            issues: [{
                wcagCriterion: "Processing error",
                severity: "Critical",
                fixRecommendation: "The PDF could not be analyzed. Please try again."
            }],
            summary: 'Unable to complete accessibility analysis.'
        });
    }
});

// Debug endpoint
app.get('/api/debug', (req, res) => {
    res.json({
        hasApiKey: !!process.env.DEEPSEEK_API_KEY,
        apiKeyPrefix: process.env.DEEPSEEK_API_KEY ? process.env.DEEPSEEK_API_KEY.substring(0, 10) + '...' : 'missing',
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// SINGLE app.listen() - THIS IS THE ONLY ONE
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API key configured: ${DEEPSEEK_API_KEY ? 'YES' : 'NO'}`);
    console.log(`Uploads directory: ./uploads`);
});
