// voice-handler.js — Extracted from favor.js
// Voice transcription and processing functions
// NOTE: The inline voice routing logic (pipeline fast-path, operator vs contact)
// remains in favor.js because it's deeply coupled to the message handler context.
// This module extracts the reusable transcription functions.

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const BOT_DIR = path.join(__dirname, '..');

/**
 * Local transcription via faster-whisper Python script.
 * @param {string} audioPath - Path to audio file
 * @param {string} language - Language code (default 'en')
 * @returns {string} Transcribed text or empty string
 */
function localTranscribe(audioPath, language = 'en') {
  try {
    const result = execSync(
      `python3 ${path.join(BOT_DIR, 'transcribe.py')} "${audioPath}" ${language}`,
      { timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    ).trim();
    return result || '';
  } catch (e) {
    console.warn('[TRANSCRIBE] Local whisper failed:', e.message);
    return '';
  }
}

/**
 * Transcribe a voice audio buffer using the Python transcribe script.
 * @param {Buffer} audioBuffer - Raw audio buffer
 * @param {string} mimetype - Audio MIME type
 * @returns {Promise<string|null>} Transcribed text or null
 */
async function transcribeVoice(audioBuffer, mimetype) {
  try {
    const ext = mimetype?.includes('ogg') ? 'ogg' : mimetype?.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(BOT_DIR, 'data', `voice_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, audioBuffer);

    const result = await new Promise((resolve) => {
      exec(
        `python3 "${path.join(BOT_DIR, 'transcribe.py')}" "${tmpPath}"`,
        { timeout: 60000 },
        (err, stdout, stderr) => {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          if (err) { console.error('[VOICE] transcribe.py error:', stderr || err.message); resolve(null); }
          else resolve(stdout?.trim() || null);
        }
      );
    });
    return result;
  } catch (e) {
    console.error('[VOICE] Transcription error:', e.message);
    return null;
  }
}

/**
 * Process a voice message: download and transcribe.
 * @param {Object} msg - Baileys message object
 * @param {Object} deps - Dependencies from favor.js
 * @param {Function} deps.downloadMediaMessage - Baileys download function
 * @param {Object} deps.logger - Pino logger
 * @param {Object} deps.sock - Baileys socket (for reupload)
 * @returns {Promise<string|null>} Transcribed text or null
 */
async function processVoice(msg, deps) {
  try {
    const buffer = await deps.downloadMediaMessage(msg, 'buffer', {}, { logger: deps.logger, reuploadRequest: deps.sock.updateMediaMessage });
    if (!buffer) return null;

    const mime = msg.message?.audioMessage?.mimetype || msg.message?.pttMessage?.mimetype || 'audio/ogg';
    console.log(`[VOICE] Processing voice note: ${mime}`);
    const transcript = await transcribeVoice(buffer, mime);

    if (transcript) {
      console.log(`[VOICE] Transcribed: ${transcript.substring(0, 80)}`);
      return transcript;
    }
    return null;
  } catch (e) {
    console.error('[VOICE] Processing failed:', e.message);
    return null;
  }
}

module.exports = { localTranscribe, transcribeVoice, processVoice };
