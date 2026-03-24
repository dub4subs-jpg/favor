// tts.js — Text-to-Speech module for Favor
// Supports edge-tts (free, no API key) and OpenAI TTS (paid)
// edge-tts requires: pip install edge-tts

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class TTS {
  constructor(opts = {}) {
    this.voice = opts.voice || 'en-US-GuyNeural';
    this.tmpDir = opts.tmpDir || '/tmp';
    this._available = null; // lazy-check
  }

  async isAvailable() {
    if (this._available !== null) return this._available;
    return new Promise((resolve) => {
      exec('edge-tts --version', { timeout: 5000 }, (err) => {
        this._available = !err;
        if (!this._available) console.log('[TTS] edge-tts not installed — voice replies disabled (pip install edge-tts)');
        resolve(this._available);
      });
    });
  }

  async synthesize(text, voice) {
    if (!await this.isAvailable()) return null;
    const v = voice || this.voice;
    const outPath = path.join(this.tmpDir, `tts_${Date.now()}.mp3`);
    // Sanitize text for shell safety
    const safe = text.replace(/['"\\`$]/g, '').substring(0, 2000);
    if (!safe || safe.length < 2) return null;

    return new Promise((resolve) => {
      exec(
        `edge-tts --voice "${v}" --text "${safe}" --write-media "${outPath}"`,
        { timeout: 30000 },
        (err) => {
          if (err || !fs.existsSync(outPath)) {
            resolve(null);
          } else {
            resolve(outPath);
          }
        }
      );
    });
  }

  // OpenAI TTS fallback (costs money)
  async synthesizeOpenAI(openai, text, voice = 'onyx') {
    try {
      const outPath = path.join(this.tmpDir, `tts_${Date.now()}.mp3`);
      const response = await openai.audio.speech.create({
        model: 'tts-1',
        voice,
        input: text.substring(0, 2000),
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(outPath, buffer);
      return outPath;
    } catch (e) {
      console.warn('[TTS] OpenAI TTS failed:', e.message);
      return null;
    }
  }

  cleanup(filePath) {
    try { if (filePath) fs.unlinkSync(filePath); } catch (_) {}
  }
}

module.exports = TTS;
