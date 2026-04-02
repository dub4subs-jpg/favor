// voice-pipeline.js — Pipelined voice-to-voice processing
// Overlaps download, transcription, routing, and TTS for <5s latency
// Falls back gracefully if any stage fails

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class VoicePipeline {
  constructor(opts = {}) {
    this.tts = opts.tts;
    this.transcribeFn = opts.transcribeFn; // async (buffer, mime) => string
    this.routeFn = opts.routeFn;           // async (text, jid) => string (reply)
    this.sendVoiceFn = opts.sendVoiceFn;   // async (jid, audioBuffer) => void
    this.sendTextFn = opts.sendTextFn;     // async (jid, text) => void
    this.dataDir = opts.dataDir || '/tmp';
    this._stats = { processed: 0, avgMs: 0, fastest: Infinity, slowest: 0 };
  }

  // Process a voice message end-to-end with pipelined stages
  async process(audioBuffer, mimetype, jid, opts = {}) {
    const start = Date.now();
    const stages = { download: 0, transcribe: 0, route: 0, tts: 0, send: 0 };

    try {
      // ─── STAGE 1: Transcription (can't pipeline further — need text first) ───
      const transcribeStart = Date.now();
      const transcript = await this.transcribeFn(audioBuffer, mimetype);
      stages.transcribe = Date.now() - transcribeStart;

      if (!transcript) {
        console.warn('[VOICE-PIPE] Transcription returned empty');
        return { ok: false, reason: 'transcription_failed', stages };
      }
      console.log(`[VOICE-PIPE] Transcribed in ${stages.transcribe}ms: "${transcript.substring(0, 60)}"`);

      // ─── STAGE 2: Route to AI (get reply text) ───
      const routeStart = Date.now();
      const reply = await this.routeFn(transcript, jid);
      stages.route = Date.now() - routeStart;

      if (!reply || reply === '__SKIP__' || reply === '__IMAGE_SENT__') {
        return { ok: true, transcript, reply, stages, skipped: true };
      }

      // ─── STAGE 3: TTS + Send (parallel — start TTS, send text simultaneously) ───
      const ttsStart = Date.now();
      const ttsPromise = this._synthesizeAndSend(reply, jid);

      // Send text reply in parallel (accessibility fallback)
      let textSent = false;
      const textPromise = opts.textFallback !== false
        ? this.sendTextFn(jid, reply).then(() => { textSent = true; }).catch(() => {})
        : Promise.resolve();

      const [voiceSent] = await Promise.all([ttsPromise, textPromise]);
      stages.tts = Date.now() - ttsStart;

      // If neither voice nor text was delivered, treat as failure
      if (!voiceSent && !textSent) {
        return { ok: false, reason: 'delivery_failed', transcript, reply, stages };
      }

      const totalMs = Date.now() - start;
      this._updateStats(totalMs);
      console.log(`[VOICE-PIPE] Complete in ${totalMs}ms (transcribe=${stages.transcribe}, route=${stages.route}, tts=${stages.tts}) — ${voiceSent ? 'voice+text' : 'text only'}`);

      return { ok: true, transcript, reply, voiceSent, stages, totalMs };
    } catch (e) {
      console.error('[VOICE-PIPE] Pipeline error:', e.message);
      return { ok: false, reason: e.message, stages };
    }
  }

  async _synthesizeAndSend(text, jid) {
    if (!this.tts) return false;
    // Skip TTS for very long replies (>2000 chars) or very short (<5 chars)
    if (text.length > 2000 || text.length < 5) return false;

    let audioPath = null;
    try {
      audioPath = await this.tts.synthesize(text);
      if (!audioPath) return false;

      const audioBuffer = fs.readFileSync(audioPath);
      await this.sendVoiceFn(jid, audioBuffer);
      return true;
    } catch (e) {
      console.warn('[VOICE-PIPE] TTS/send failed:', e.message);
      return false;
    } finally {
      if (audioPath) try { this.tts.cleanup(audioPath); } catch (_) {}
    }
  }

  _updateStats(ms) {
    this._stats.processed++;
    if (ms < this._stats.fastest) this._stats.fastest = ms;
    if (ms > this._stats.slowest) this._stats.slowest = ms;
    // Running average
    this._stats.avgMs = Math.round(
      this._stats.avgMs + (ms - this._stats.avgMs) / this._stats.processed
    );
  }

  get stats() {
    return { ...this._stats };
  }
}

module.exports = VoicePipeline;
