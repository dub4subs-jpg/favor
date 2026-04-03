// ─── MEDIA HANDLER ───
// Handles message text extraction, media download, voice transcription,
// image processing, video processing, and message deduplication.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

class MediaHandler {
  constructor({ config, videoProcessor, PLATFORM, botDir }) {
    this.config = config;
    this.videoProcessor = videoProcessor;
    this.PLATFORM = PLATFORM;
    this.botDir = botDir;

    // Platform-specific media download functions (set after connection)
    this._downloadMediaMessage = null; // Baileys downloadMediaMessage
    this._telegramAdapter = null;
    this._sock = null;
    this._logger = null;

    // Deduplication state
    this._recentMessages = new Map();
    this.DEDUP_WINDOW_MS = 5000;

    // Last received image (for forwarding via send_image tool)
    this.lastReceivedImage = null;
  }

  setSock(sock) { this._sock = sock; }
  setLogger(logger) { this._logger = logger; }
  setDownloadMediaMessage(fn) { this._downloadMediaMessage = fn; }
  setTelegramAdapter(adapter) { this._telegramAdapter = adapter; }
  updateConfig(config) { this.config = config; }

  // ─── LOCAL TRANSCRIPTION (faster-whisper via Python, free) ───
  localTranscribe(audioPath, language = 'en') {
    try {
      const { execSync } = require('child_process');
      const result = execSync(
        `python3 ${path.join(this.botDir, 'transcribe.py')} "${audioPath}" ${language}`,
        { timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 }
      ).trim();
      return result || '';
    } catch (e) {
      console.warn('[TRANSCRIBE] Local whisper failed:', e.message);
      return '';
    }
  }

  // ─── VOICE TRANSCRIPTION (OpenAI Whisper API) ───
  async transcribeVoice(audioBuffer, mimetype) {
    const openaiKey = this.config.api?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!openaiKey) return null;

    try {
      const ext = mimetype?.includes('ogg') ? 'ogg' : mimetype?.includes('mp4') ? 'mp4' : 'webm';
      const tmpPath = path.join(this.botDir, 'data', `voice_${Date.now()}.${ext}`);
      fs.writeFileSync(tmpPath, audioBuffer);

      const result = await new Promise((resolve) => {
        exec(
          `curl -s -X POST https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer ${openaiKey}" -F "file=@${tmpPath}" -F "model=whisper-1" -F "response_format=text"`,
          { timeout: 30000 },
          (err, stdout) => {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            if (err) resolve(null);
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

  // ─── EXTRACT MESSAGE TEXT ───
  extractText(msg) {
    const m = msg.message;
    if (!m) return '';
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;
    return '';
  }

  getMessageType(msg) {
    const m = msg.message;
    if (!m) return 'unknown';
    if (m.imageMessage) return 'image';
    if (m.audioMessage || m.pttMessage) return 'voice';
    if (m.videoMessage) return 'video';
    if (m.documentMessage) return 'document';
    if (m.stickerMessage) return 'sticker';
    return 'text';
  }

  // ─── MEDIA DOWNLOAD (platform-agnostic) ───
  async downloadMedia(msg) {
    if (this.PLATFORM === 'telegram' && this._telegramAdapter) {
      return this._telegramAdapter.downloadMedia(msg);
    }
    return this._downloadMediaMessage(msg, 'buffer', {}, {
      logger: this._logger,
      reuploadRequest: this._sock.updateMediaMessage
    });
  }

  // ─── IMAGE PROCESSING ───
  async processImage(msg) {
    try {
      const buffer = await this.downloadMedia(msg);
      if (!buffer) return null;

      const mime = msg.message?.imageMessage?.mimetype || msg.message?.stickerMessage?.mimetype || 'image/jpeg';
      const mimeType = mime.split(';')[0];
      console.log(`[VISION] Processing image: ${mimeType} (${Math.round(buffer.length / 1024)}KB)`);

      // Store for forwarding via send_image tool
      this.lastReceivedImage = { buffer, mimetype: mimeType };

      const base64 = buffer.toString('base64');
      return {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${base64}` }
      };
    } catch (e) {
      console.error('[VISION] Download failed:', e.message);
      return null;
    }
  }

  // ─── VOICE PROCESSING ───
  async processVoice(msg) {
    try {
      const buffer = await this.downloadMedia(msg);
      if (!buffer) return null;

      const mime = msg.message?.audioMessage?.mimetype || msg.message?.pttMessage?.mimetype || 'audio/ogg';
      console.log(`[VOICE] Processing voice note: ${mime}`);
      const transcript = await this.transcribeVoice(buffer, mime);

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

  // ─── VIDEO PROCESSING ───
  async processVideoMessage(msg) {
    try {
      const buffer = await this.downloadMedia(msg);
      if (!buffer) return null;

      const size = buffer.length;
      console.log(`[VIDEO] Processing WhatsApp video: ${Math.round(size / 1024 / 1024 * 10) / 10}MB`);

      if (size > 50 * 1024 * 1024) {
        return { error: 'Video too large (>50MB). Send a shorter clip or share a link instead.' };
      }

      const saved = this.videoProcessor.saveBuffer(buffer);
      const result = await this.videoProcessor.processVideo(saved.path, saved.dir);
      this.videoProcessor.cleanup(saved.dir);
      return result;
    } catch (e) {
      console.error('[VIDEO] Processing failed:', e.message);
      return { error: 'Video processing failed: ' + e.message };
    }
  }

  // ─── MESSAGE DEDUPLICATION ───
  isDuplicateMessage(msg) {
    const text = this.extractText(msg) || '';
    const jid = msg.key.remoteJid || '';
    const key = `${jid}:${text.substring(0, 100)}`;
    const hash = crypto.createHash('md5').update(key).digest('hex');
    const now = Date.now();

    if (this._recentMessages.has(hash) && now - this._recentMessages.get(hash) < this.DEDUP_WINDOW_MS) {
      return true;
    }
    this._recentMessages.set(hash, now);

    // Cleanup old entries every 100 messages
    if (this._recentMessages.size > 200) {
      for (const [k, t] of this._recentMessages) {
        if (now - t > this.DEDUP_WINDOW_MS * 2) this._recentMessages.delete(k);
      }
    }
    return false;
  }
}

module.exports = MediaHandler;
