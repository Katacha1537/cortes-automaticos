const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Helper: Convert SRT timestamp "00:00:00,000" to seconds
function parseTimestamp(timeStr) {
    if (!timeStr) return 0;
    const [h, m, s] = timeStr.split(':');
    const [sec, ms] = s.split(',');
    return (parseInt(h) * 3600) + (parseInt(m) * 60) + parseInt(sec) + (parseInt(ms) / 1000);
}

// Helper: Parse raw SRT string into structured array
function parseSRT(srtContent) {
    // Normalize line endings and split by double blank lines
    const blocks = srtContent.replace(/\r\n/g, '\n').split('\n\n');
    const entries = [];

    blocks.forEach(block => {
        const lines = block.split('\n').filter(l => l.trim() !== '');
        if (lines.length >= 3) {
            const id = lines[0];
            const timeLine = lines[1];
            const text = lines.slice(2).join(' '); // Join remaining lines as text

            // Extract start time for sorting/chunking
            const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3}) -->/);
            const startSeconds = timeMatch ? parseTimestamp(timeMatch[1]) : 0;

            entries.push({
                id,
                timeLine,
                startSeconds,
                text,
                fullBlock: block
            });
        }
    });

    return entries;
}

// Helper: Group parsed entries into chunks of ~duration minutes
function chunkSRTByDuration(entries, durationMinutes = 10) {
    const durationSeconds = durationMinutes * 60;
    const chunks = [];
    let currentChunk = [];
    let chunkStartTime = -1;

    entries.forEach(entry => {
        if (chunkStartTime === -1) chunkStartTime = entry.startSeconds;

        // If adding this entry exceeds the chunk duration (and chunk is not empty)
        if (entry.startSeconds - chunkStartTime > durationSeconds && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            chunkStartTime = entry.startSeconds;
        }
        currentChunk.push(entry);
    });

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

// Helper: Remove overlapping clips (Greedy algorithm based on score/length)
function removeOverlaps(momentsMap) {
    // Convert to array
    let clips = Object.entries(momentsMap).map(([key, val]) => ({
        key,
        ...val,
        duration: val.end - val.start
    }));

    // Sort by Score (high to low), then by Duration (long to short)
    clips.sort((a, b) => {
        const scoreA = a.score || 0;
        const scoreB = b.score || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return b.duration - a.duration;
    });

    const selectedClips = [];
    const rejectedClips = [];

    for (const clip of clips) {
        let isOverlap = false;
        for (const selected of selectedClips) {
            // Check for overlap: StartA < EndB && StartB < EndA
            // Added a small buffer (0.5s) to define "overlap"
            if (clip.start < selected.end - 0.5 && selected.start < clip.end - 0.5) {
                isOverlap = true;
                break;
            }
        }

        if (!isOverlap) {
            selectedClips.push(clip);
        } else {
            rejectedClips.push(clip);
        }
    }

    // Convert back to map structure
    const result = {};
    selectedClips.forEach(clip => {
        const k = clip.key;
        delete clip.key;
        delete clip.duration; // Clean up aux property
        result[k] = clip;
    });

    console.log(`Overlap Removal: Kept ${selectedClips.length} clips, removed ${rejectedClips.length} overlapping.`);
    return result;
}

async function analyzeTranscription(transcriptionText) {
    try {
        console.log("Parsing SRT and splitting into chunks...");
        // 1. Parse SRT properly
        const parsedEntries = parseSRT(transcriptionText);

        if (parsedEntries.length === 0) {
            console.warn("Could not parse SRT or empty file. Running fallback logic (treat as raw text).");
            // Basic fallback if SRT parsing fails drastically (unlikely)
            return {};
        }

        // 2. Chunk by 12 minutes (to fit context window safely and give good context)
        const chunks = chunkSRTByDuration(parsedEntries, 12);
        console.log(`Analysis: Split transcript into ${chunks.length} time-based chunks.`);

        let allMoments = {};

        for (let i = 0; i < chunks.length; i++) {
            console.log(`Analyzing chunk ${i + 1}/${chunks.length}... (${chunks[i].length} lines)`);

            // Reconstruct SRT text for this chunk
            const chunkText = chunks[i].map(e => e.fullBlock).join('\n\n');

            const chunkMoments = await analyzeChunk(chunkText, i);

            // Merge results
            for (const [key, val] of Object.entries(chunkMoments)) {
                allMoments[`chunk${i}_${key}`] = val;
            }
        }

        // 3. Remove Overlaps
        console.log("Detecting and removing overlapping clips...");
        const finalMoments = removeOverlaps(allMoments);

        return finalMoments;

    } catch (error) {
        console.error("Analysis error:", error);
        throw error;
    }
}

async function analyzeChunk(textChunk, chunkIndex) {
    try {
        const prompt = `
Você é um editor de vídeos especialista em retenção para TikTok e Instagram Reels.
Estamos analisando a PARTE ${chunkIndex + 1} de uma transcrição longa em formato SRT.

SUA MISSÃO:
1. Encontre momentos virais (cortes) com alto potencial de engajamento.
2. APENAS UM TEMA POR CORTE.
3. Critérios OBRIGATÓRIOS:
   - ARCO NARRATIVO: Início, Meio e Fim.
   - SEM SILÊNCIOS EXTRAS: Use os timestamps exatos da fala.
   - DURAÇÃO: 40s a 90s.
   - EVITE cortes que dependam de contexto anterior não incluído.

Retorne APENAS um JSON válido com os cortes encontrados.
Adicione um campo "score" (0-100) baseando-se na viralidade percebida (gancho forte, emoção, plot twist).

Exemplo de Saída:
{
  "c1": { "start": 10.5, "end": 60.2, "titulo": "O segredo do sucesso", "score": 95 },
  "c2": { "start": 100.0, "end": 150.0, "titulo": "Erro comum", "score": 80 }
}

Transcrição (Trecho):
${textChunk}
        `;

        const completion = await openai.chat.completions.create({
            messages: [{ role: "system", content: "You output raw JSON." }, { role: "user", content: prompt }],
            model: "gpt-5-nano",
            response_format: { type: "json_object" }
        });

        const content = completion.choices[0].message.content;
        return JSON.parse(content);
    } catch (err) {
        console.warn(`Error analyzing chunk ${chunkIndex}:`, err.message);
        return {};
    }
}

module.exports = { analyzeTranscription };
