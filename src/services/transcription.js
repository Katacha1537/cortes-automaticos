const fs = require('fs');
const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // Add a timeout to prevent the connection from hanging
    timeout: 60000,
});

async function transcribeAudio(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    try {
        const transcription = await openai.audio.transcriptions.create({
            // Passing the stream directly
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            response_format: "srt",
        });

        // For SRT, the transcription variable is already the string we need
        return transcription;
    } catch (error) {
        // Log the specific error message to help debug
        console.error("Transcription error detail:", error.message);
        throw error;
    }
}


module.exports = { transcribeAudio };