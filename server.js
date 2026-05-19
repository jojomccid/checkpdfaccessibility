const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Serve static files (your index.html)
app.use(express.static('public'));
app.use(express.json());

// DeepSeek API configuration
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Endpoint to analyze PDF
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        // Extract text from PDF
        const pdfBuffer = require('fs').readFileSync(req.file.path);
        const pdfData = await pdfParse(pdfBuffer);
        const extractedText = pdfData.text.substring(0, 8000); // Limit for API

        // Call DeepSeek API for WCAG analysis
        const analysisPrompt = `You are a WCAG 2.1 Level AA accessibility auditor. 
        Analyze this PDF document and provide:
        1. An overall compliance score from 0-100%
        2. List of issues found with specific WCAG criteria violations
        3. For each issue, include: severity (Critical/Serious/Minor), WCAG criterion, and fix recommendation
        
        Document text: ${extractedText}
        
        Respond with ONLY valid JSON in this format:
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

        const deepseekResponse = await axios.post(DEEPSEEK_API_URL, {
            model: "deepseek-chat",
            messages: [
                { role: "system", content: "You are a WCAG 2.1 AA accessibility compliance expert. Respond only with valid JSON." },
                { role: "user", content: analysisPrompt }
            ],
            temperature: 0.3
        }, {
            headers: { 
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // Parse and return the analysis
        let analysisResult;
        try {
            analysisResult = JSON.parse(deepseekResponse.data.choices[0].message.content);
        } catch (parseError) {
            // Fallback if DeepSeek doesn't return clean JSON
            analysisResult = {
                overallScore: 50,
                issues: [{
                    wcagCriterion: "Parsing error",
                    severity: "Minor",
                    fixRecommendation: "The analysis encountered a parsing issue. Please try again."
                }],
                summary: "Partial analysis completed."
            };
        }

        // Clean up uploaded file
        require('fs').unlinkSync(req.file.path);

        res.json(analysisResult);

    } catch (error) {
        console.error('Analysis error:', error.message);
        res.status(500).json({ 
            error: 'Analysis failed', 
            details: error.message,
            overallScore: 0,
            issues: [],
            summary: 'Unable to complete accessibility analysis. Please try again.'
        });
    }
});

// Simple health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// For local development
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});