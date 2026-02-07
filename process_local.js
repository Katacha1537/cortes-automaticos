const path = require('path');
const fs = require('fs');
const transcriptionService = require('./src/services/transcription');
const analysisService = require('./src/services/analysis');
const videoProcessor = require('./src/services/videoProcessor');
require('dotenv').config();

// Get video path from command line arguments
const videoArg = process.argv[2];

if (!videoArg) {
    console.error('Please provide a video path. Usage: node process_local.js <path_to_video>');
    process.exit(1);
}

const inputVideoPath = path.resolve(videoArg);

if (!fs.existsSync(inputVideoPath)) {
    console.error(`File not found: ${inputVideoPath}`);
    process.exit(1);
}

async function run() {
    try {
        console.log(`[1/4] Processing local video: ${inputVideoPath}`);

        // Step 0: Silence Removal (Preprocessing)
        console.log('[1/4] Removing silence from video (Preprocessing)...');
        const cleanVideoPath = inputVideoPath.replace(path.extname(inputVideoPath), '_clean.mp4');

        if (fs.existsSync(cleanVideoPath)) {
            console.log('Found pre-processed video, skipping silence removal.');
        } else {
            await videoProcessor.removeSilence(inputVideoPath, cleanVideoPath);
        }

        const workingVideoPath = cleanVideoPath;

        // Step 1: Transcription
        console.log('[2/4] Starting transcription...');
        // Extract audio from CLEAN video for better transcription? Or original?
        // server.js extracts audio from clean video.
        const audioPath = workingVideoPath.replace(path.extname(workingVideoPath), '.mp3');
        await videoProcessor.extractAudio(workingVideoPath, audioPath);

        const transcription = await transcriptionService.transcribeAudio(audioPath);
        console.log('Transcription complete.');

        // Cleanup temp audio
        try { fs.unlinkSync(audioPath); } catch (e) { }

        // Step 2: Analysis
        console.log('[3/4] Analyzing for viral moments...');
        const textToAnalyze = typeof transcription === 'string' ? transcription : JSON.stringify(transcription);
        const viralMoments = await analysisService.analyzeTranscription(textToAnalyze);
        console.log('Analysis complete. Moments found:', viralMoments);

        // Step 3: Processing
        console.log('[4/4] Processing video clips...');

        // Ensure output directory exists
        const outputDir = path.join(__dirname, 'output');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }

        // Generate individual videos per viral moment
        console.log(`Processing ${Object.keys(viralMoments).length} viral moments...`);

        for (const [key, moment] of Object.entries(viralMoments)) {
            // Sanitize title for filename
            const safeTitle = (moment.titulo || 'clip').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
            const outputFilename = `${path.basename(inputVideoPath, path.extname(inputVideoPath))}_${key}_${safeTitle}.mp4`;
            const outputPath = path.join(outputDir, outputFilename);

            await videoProcessor.processVideo(workingVideoPath, outputPath, moment.start, moment.end);
            console.log(`Clip saved: ${outputPath}`);
        }

        console.log('All done!');

    } catch (error) {
        console.error('Error processing video:', error);
    }
}

run();
