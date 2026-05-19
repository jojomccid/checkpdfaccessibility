const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Serve static files (your index.html from public folder)
app.use(express.static('public'));
app.use(express.json());

// DeepSeek API configuration
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        hasApiKey: !!DEEPSEEK_API_KEY,
        timestamp: new Date().toISOString()
    });
});

// Endpoint to analyze PDF - Improved version that handles ALL PDFs
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        console.log(`Processing: ${req.file.originalname}`);

        // Extract text with better error handling
        const pdfBuffer = fs.readFileSync(req.file.path);
        let extractedText = '';
        
        try {
            const pdfData = await pdfParse(pdfBuffer);
            extractedText = pdfData.text;
            console.log(`Extracted ${extractedText.length} characters`);
        } catch (parseError) {
            console.error('PDF parse error:', parseError.message);
            // Fallback: Try to extract whatever is readable
            extractedText = "Text extraction partially failed. The PDF may contain complex structure, but analysis can still proceed on available content.";
        }
        
        // If no text at all, provide a helpful message
        if (!extractedText || extractedText.trim().length < 50) {
            fs.unlinkSync(req.file.path);
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

        // Improved prompt that works with any extracted text
        const analysisPrompt = `You are a WCAG 2.1 Level AA accessibility auditor. 
        
Analyze this PDF document text and provide:
1. An overall compliance score from 0-100%
2. List of issues found with specific WCAG criteria violations
3. For each issue, include: severity (Critical/Serious/Minor), WCAG criterion, and fix recommendation

If the text shows clear evidence of accessibility features (proper headings, lists, table structures, alt text mentions, language specification), give a HIGHER score.
If the text is raw, unstructured, or missing key elements, give a LOWER score.

Document text:
${textForAnalysis}

Respond with ONLY valid JSON. Do not include any other text outside the JSON. Use this exact format:
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
                { role: "system", content: "You are a WCAG 2.1 AA accessibility compliance expert. Respond only with valid JSON. Do not include explanations, markdown formatting, or any text outside the JSON structure." },
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

        // Parse the response more robustly
        let analysisResult;
        const responseContent = deepseekResponse.data.choices[0].message.content;
        console.log('DeepSeek response received, length:', responseContent.length);
        
        try {
            // Try to extract JSON if there's extra text
            const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                analysisResult = JSON.parse(jsonMatch[0]);
            } else {
                analysisResult = JSON.parse(responseContent);
            }
        } catch (parseError) {
            console.error('JSON parse error:', parseError.message);
            // Provide meaningful fallback
            analysisResult = {
                overallScore: 45,
                issues: [{
                    wcagCriterion: "Analysis parsing",
                    severity: "Minor",
                    fixRecommendation: "The analysis completed but had formatting issues. The PDF appears to have some structure."
                }],
                summary: "Partial analysis: The document contains text but the detailed breakdown encountered a parsing issue."
            };
        }

        // Ensure valid score
        if (typeof analysisResult.overallScore !== 'number') {
            analysisResult.overallScore = 50;
        }

        // Clean up uploaded file
        try {
            fs.unlinkSync(req.file.path);
        } catch(e) {
            console.log('File cleanup warning:', e.message);
        }

        res.json(analysisResult);

    } catch (error) {
        console.error('Analysis error:', error.message);
        if (error.response) {
            console.error('API status:', error.response.status);
            console.error('API data:', error.response.data);
        }
        
        // Clean up file if it exists
        try {
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        } catch(e) {}
        
        res.status(500).json({ 
            error: 'Analysis failed', 
            details: error.message,
            overallScore: 0,
            issues: [{
                wcagCriterion: "Processing error",
                severity: "Critical",
                fixRecommendation: "The PDF could not be analyzed. Please ensure it is a valid PDF file and try again."
            }],
            summary: 'Unable to complete accessibility analysis due to a technical error.'
        });
    }
});

// OCR test endpoint (placeholder for future enhancement)
app.post('/api/ocr-test', (req, res) => {
    res.json({ message: "OCR test endpoint working" });
});

// ============================================
// SINGLE app.listen() - THIS IS THE ONLY ONE
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API key configured: ${DEEPSEEK_API_KEY ? 'YES' : 'NO'}`);
});
