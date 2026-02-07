const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

// Set FFmpeg paths relative to project root or use system environment
const ffmpegPath = path.resolve(__dirname, '../../ffmpeg.exe');
const ffprobePath = path.resolve(__dirname, '../../ffprobe.exe');

if (fs.existsSync(ffmpegPath)) {
    ffmpeg.setFfmpegPath(ffmpegPath);
} else {
    console.warn('ffmpeg.exe not found in project root, relying on system PATH');
}

if (fs.existsSync(ffprobePath)) {
    ffmpeg.setFfprobePath(ffprobePath);
} else {
    console.warn('ffprobe.exe not found in project root, relying on system PATH');
}

function processVideo(inputPath, outputPath, start, end) {
    return new Promise(async (resolve, reject) => {
        console.log(`Processing video: ${inputPath} from ${start} to ${end}`);

        // Enforce 16:9 output (1920x1080)
        // scale=1920:1080:force_original_aspect_ratio=decrease ensures it fits within 1920x1080 maintaining aspect ratio
        // pad=1920:1080:-1:-1 adds black bars if necessary to fill the 16:9 frame
        const finalFilterString = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black';

        // To avoid ENAMETOOLONG, write the filter string to a temp file
        const tempFilterPath = path.resolve(path.dirname(outputPath), `vfilter_${Date.now()}.txt`);
        fs.writeFileSync(tempFilterPath, finalFilterString);

        ffmpeg(inputPath)
            .setStartTime(start)
            .setDuration(end - start)
            // Use -filter_script:v to read from file
            .outputOptions(['-filter_script:v', tempFilterPath])
            .output(outputPath)
            .on('end', () => {
                console.log(`Video processed successfully: ${outputPath}`);
                // Cleanup temp filter
                try { if (fs.existsSync(tempFilterPath)) fs.unlinkSync(tempFilterPath); } catch (e) { }
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error(`Error processing video: ${err.message}`);
                // Cleanup temp filter
                try { if (fs.existsSync(tempFilterPath)) fs.unlinkSync(tempFilterPath); } catch (e) { }
                reject(err);
            })
            .run();
    });
}

function extractAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`Extracting audio from: ${inputPath} to ${outputPath}`);
        ffmpeg(inputPath)
            .output(outputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .on('end', () => {
                console.log(`Audio extraction complete: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error(`Error extracting audio: ${err.message}`);
                reject(err);
            })
            .run();
    });
}

function removeSilence(inputPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        console.log(`Removing silence from: ${inputPath}...`);

        try {
            // Configuration for silence detection
            const SILENCE_THRESHOLD = -30; // dB
            const MIN_SILENCE_DURATION = 0.5; // seconds
            const PADDING = 0.1; // seconds

            // Helper to get duration
            const getDuration = (file) => {
                try {
                    const ffprobeCmd = fs.existsSync(ffprobePath) ? `"${ffprobePath}"` : 'ffprobe';
                    const out = execSync(`${ffprobeCmd} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`);
                    return parseFloat(out.toString());
                } catch (e) {
                    throw new Error(`Failed to get duration: ${e.message}`);
                }
            };

            // Helper to detect silence segments
            const getSilenceSegments = (file) => {
                return new Promise((resSec, rejSec) => {
                    const ffmpegCmd = fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';
                    const proc = spawn(ffmpegCmd, [
                        '-i', file,
                        '-af', `silencedetect=n=${SILENCE_THRESHOLD}dB:d=${MIN_SILENCE_DURATION}`,
                        '-f', 'null', '-'
                    ]);

                    let output = '';
                    proc.stderr.on('data', (data) => output += data.toString());
                    proc.on('close', (code) => {
                        if (code !== 0) {
                            rejSec(new Error(`FFmpeg silence detection failed with code ${code}`));
                            return;
                        }

                        const silentSegments = [];
                        const startRegex = /silence_start: ([\d.]+)/g;
                        const endRegex = /silence_end: ([\d.]+)/g;

                        const starts = [];
                        let startMatch;
                        while ((startMatch = startRegex.exec(output)) !== null) starts.push(parseFloat(startMatch[1]));

                        let endMatch;
                        let i = 0;
                        while ((endMatch = endRegex.exec(output)) !== null) {
                            if (starts[i] !== undefined) {
                                silentSegments.push({ start: starts[i], end: parseFloat(endMatch[1]) });
                            }
                            i++;
                        }
                        resSec(silentSegments);
                    });
                });
            };

            const totalDuration = getDuration(inputPath);
            const silences = await getSilenceSegments(inputPath);

            if (silences.length === 0) {
                console.log('No silence detected. Copying original file.');
                fs.copyFileSync(inputPath, outputPath);
                return resolve(outputPath);
            }

            // Invert silences to find sound segments
            const sounds = [];
            let lastEnd = 0;

            silences.forEach(s => {
                if (s.start - lastEnd > 0.1) {
                    sounds.push({
                        start: Math.max(0, lastEnd - PADDING),
                        end: Math.min(totalDuration, s.start + PADDING)
                    });
                }
                lastEnd = s.end;
            });

            if (lastEnd < totalDuration) {
                sounds.push({ start: lastEnd - PADDING, end: totalDuration });
            }

            if (sounds.length === 0) {
                console.warn('Video seems to be entirely silent?');
                fs.copyFileSync(inputPath, outputPath);
                return resolve(outputPath);
            }

            // FILTER GENERATION
            let videoFilter = '';
            let audioFilter = '';
            let concatParts = '';

            sounds.forEach((seg, i) => {
                videoFilter += `[0:v]trim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},setpts=PTS-STARTPTS[v${i}];`;
                audioFilter += `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[a${i}];`;
                concatParts += `[v${i}][a${i}]`;
            });

            const finalFilter = `${videoFilter}${audioFilter}${concatParts}concat=n=${sounds.length}:v=1:a=1[outv][outa]`;

            // FIX ENAMETOOLONG: Write filter to file
            const filterPath = path.resolve(path.dirname(outputPath), `filter_${Date.now()}.txt`);
            // Escape backslashes in path just in case, though usually fine in simple strings.
            // Actually, for filter_complex_script, we just put the filter content in the file.
            fs.writeFileSync(filterPath, finalFilter);

            console.log(`Generating cut: ${sounds.length} segments using filter file...`);

            const ffmpegCmd = fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';
            const args = [
                '-i', inputPath,
                '-filter_complex_script', filterPath,
                '-map', '[outv]', '-map', '[outa]',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '28',
                '-y', outputPath
            ];

            const proc = spawn(ffmpegCmd, args);

            proc.stderr.on('data', (d) => process.stdout.write('.'));

            proc.on('close', (code) => {
                console.log('\n');

                // Cleanup filter file
                try {
                    if (fs.existsSync(filterPath)) fs.unlinkSync(filterPath);
                } catch (e) { console.warn('Filter cleanup failed', e); }

                if (code === 0) {
                    console.log(`Silence removal complete: ${outputPath}`);
                    resolve(outputPath);
                } else {
                    reject(new Error(`FFmpeg trim failed with code ${code}`));
                }
            });

        } catch (err) {
            reject(err);
        }
    });
}


function concatenateVideos(videoPaths, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`Concatenating ${videoPaths.length} videos to ${outputPath}...`);

        if (videoPaths.length === 0) {
            return reject(new Error("No videos to concatenate"));
        }

        // Create a temporary file list for ffmpeg
        const listPath = path.resolve(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
        const fileContent = videoPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(listPath, fileContent);

        const ffmpegCmd = fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg';

        // Use concat demuxer for fast merging (requires same codec/resolution)
        // Since we process all clips with the same settings in processVideo, this should work.
        const args = [
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            '-y', outputPath
        ];

        const proc = spawn(ffmpegCmd, args);

        proc.stderr.on('data', (d) => process.stdout.write('.'));

        proc.on('close', (code) => {
            console.log('\n');
            // Cleanup list file
            try {
                if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
            } catch (e) { }

            if (code === 0) {
                console.log(`Concatenation complete: ${outputPath}`);
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg concat failed with code ${code}`));
            }
        });
    });
}

module.exports = { processVideo, extractAudio, removeSilence, concatenateVideos };
