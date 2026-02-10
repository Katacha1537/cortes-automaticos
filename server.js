// FIX: Disable SSL verification to avoid EPROTO errors on some local Windows networks
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';


const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const transcriptionService = require('./src/services/transcription');
const analysisService = require('./src/services/analysis');
const videoProcessor = require('./src/services/videoProcessor');
require('dotenv').config();

const app = express();
const port = 3000;

// Configure Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// Helper function for processing logic
async function processVideoPipeline(videoPath, res) {
    try {
        console.log(`[1/5] Processing started for: ${videoPath}`);
        const baseName = path.basename(videoPath, path.extname(videoPath));
        const outputDir = path.dirname(videoPath);

        // CHECKPOINT 1: Silence Removal (Preprocessing)
        const cleanVideoPath = videoPath.replace(path.extname(videoPath), '_clean.mp4');
        if (fs.existsSync(cleanVideoPath)) {
            console.log('[1/5] Found pre-processed video, skipping silence removal.');
        } else {
            console.log('[1/5] Removing silence from video (Preprocessing)...');
            await videoProcessor.removeSilence(videoPath, cleanVideoPath);
        }

        // Use the clean video for subsequent steps
        const workingVideoPath = cleanVideoPath;

        // CHECKPOINT 2: Transcription
        const transcriptionCachePath = path.join(outputDir, `${baseName}_transcription.json`);
        let transcription;

        if (fs.existsSync(transcriptionCachePath)) {
            console.log('[2/5] & [3/5] Found existing transcription, loading from cache...');
            transcription = JSON.parse(fs.readFileSync(transcriptionCachePath, 'utf8'));
        } else {
            // Step 1: Extract Audio
            console.log('[2/5] Extracting audio from clean video...');
            const audioPath = workingVideoPath.replace(path.extname(workingVideoPath), '.mp3');
            await videoProcessor.extractAudio(workingVideoPath, audioPath);

            // Step 2: Transcription
            console.log('[3/5] Starting transcription...');
            const rawTranscription = await transcriptionService.transcribeAudio(audioPath);
            console.log('Transcription complete.');

            // Normalize transcription
            transcription = rawTranscription;
            fs.writeFileSync(transcriptionCachePath, JSON.stringify(transcription, null, 2));

            // Clean up audio file
            try {
                fs.unlinkSync(audioPath);
            } catch (e) {
                console.warn('Could not delete temp audio file:', e);
            }
        }

        // CHECKPOINT 3: Analysis
        const analysisCachePath = path.join(outputDir, `${baseName}_analysis.json`);
        let viralMoments;

        if (fs.existsSync(analysisCachePath)) {
            console.log('[4/5] Found existing analysis, loading from cache...');
            console.log(`NOTE: If you want to re-analyze with updated prompts, delete this file: ${analysisCachePath}`);
            viralMoments = JSON.parse(fs.readFileSync(analysisCachePath, 'utf8'));
        } else {
            console.log('[4/5] Analyzing for viral moments...');
            const textToAnalyze = typeof transcription === 'string' ? transcription : JSON.stringify(transcription);
            viralMoments = await analysisService.analyzeTranscription(textToAnalyze);
            console.log('Analysis complete. Moments found:', viralMoments);
            fs.writeFileSync(analysisCachePath, JSON.stringify(viralMoments, null, 2));
        }

        // Step 4: Processing
        console.log('[5/5] Processing video clips...');
        const processedClips = [];

        // Ensure output directory exists
        if (!fs.existsSync('output')) {
            fs.mkdirSync('output');
        }

        const keys = Object.keys(viralMoments);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const moment = viralMoments[key];
            const outputPath = `output/${baseName}_${key}.mp4`;

            // Checkpoint: Skip existing clips
            if (fs.existsSync(outputPath)) {
                console.log(`Clip already exists: ${outputPath}, skipping...`);
                processedClips.push({ name: key, path: outputPath, ...moment });
                continue;
            }

            console.log(`Processing clip ${i + 1}/${keys.length}: ${key}`);
            await videoProcessor.processVideo(workingVideoPath, outputPath, moment.start, moment.end);
            processedClips.push({
                name: key,
                path: outputPath,
                ...moment
            });
        }

        res.json({
            message: 'Video processed successfully',
            clips: processedClips
        });

    } catch (error) {
        console.error('Error processing video:', error);
        res.status(500).json({ error: error.message });
    }
}

// Route 1: List videos in 'videos' folder
app.get('/list-videos', (req, res) => {
    const videosDir = path.join(__dirname, 'videos');
    if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir);
    }

    fs.readdir(videosDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Unable to scan directory: ' + err });
        }
        // Filter for video files (simple extension check)
        const videoFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.mp4', '.mov', '.avi', '.mkv'].includes(ext);
        });
        res.json({ videos: videoFiles });
    });
});

// Route 2: Process a local file from confirm 'videos' folder
app.post('/process-server-file', async (req, res) => {
    const filename = req.body.filename;
    if (!filename) {
        return res.status(400).send('Filename is required.');
    }

    const videoPath = path.resolve(__dirname, 'videos', filename);

    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('File not found on server.');
    }

    await processVideoPipeline(videoPath, res);
});

// Route 3: Upload and process (Legacy but kept)
app.post('/process-video', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    await processVideoPipeline(req.file.path, res);
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log('Place videos in the "videos" folder to use Library Mode.');
});
