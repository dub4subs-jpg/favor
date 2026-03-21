/**
 * Video Processing — extract frames + audio from videos for AI analysis
 * Supports: WhatsApp video messages, YouTube URLs, direct video URLs
 */
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VIDEO_DIR = path.join(__dirname, 'data', 'videos');
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

function shell(cmd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout?.trim() || '', stderr: stderr?.trim() || '', error: err?.message });
    });
  });
}

class VideoProcessor {
  constructor(openai) {
    this.openai = openai;
  }

  /**
   * Download a video from URL (YouTube, direct links, etc.)
   * Returns path to downloaded file
   */
  async downloadFromUrl(url) {
    const ts = Date.now();
    const outDir = path.join(VIDEO_DIR, String(ts));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'video.mp4');

    // Try yt-dlp first (handles YouTube, Vimeo, Twitter, TikTok, etc.)
    const ytResult = await shell(
      `yt-dlp --js-runtimes node -f "bestvideo[height<=720]+bestaudio/best[height<=720]/best" --merge-output-format mp4 -o "${outPath}" --no-playlist --max-filesize 50M "${url}"`,
      120000
    );

    if (ytResult.ok && fs.existsSync(outPath) && this._isValidVideo(outPath)) {
      return { ok: true, path: outPath, dir: outDir };
    }

    // Check for bot-detection / sign-in errors from yt-dlp
    const ytErr = (ytResult.stderr || '') + (ytResult.stdout || '');
    if (ytErr.includes('Sign in to confirm') || ytErr.includes('bot')) {
      this.cleanup(outDir);
      return { ok: false, error: 'YouTube is blocking downloads from this server. Try sending the video directly in WhatsApp instead of a link.' };
    }

    // Fallback: direct download with curl (only for non-YouTube direct video URLs)
    const curlResult = await shell(`curl -sL -o "${outPath}" --max-filesize 52428800 --max-time 60 "${url}"`);
    if (curlResult.ok && fs.existsSync(outPath) && this._isValidVideo(outPath)) {
      return { ok: true, path: outPath, dir: outDir };
    }

    this.cleanup(outDir);
    return { ok: false, error: ytResult.stderr || curlResult.stderr || 'Download failed' };
  }

  /**
   * Save a WhatsApp video buffer to disk
   */
  saveBuffer(buffer) {
    const ts = Date.now();
    const outDir = path.join(VIDEO_DIR, String(ts));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'video.mp4');
    fs.writeFileSync(outPath, buffer);
    return { ok: true, path: outPath, dir: outDir };
  }

  /**
   * Check if a file is actually a video (not HTML or other junk)
   */
  _isValidVideo(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);
      const head = buf.toString('ascii', 0, 16);
      // Reject HTML pages saved as .mp4
      if (head.includes('<!') || head.includes('<html') || head.includes('<HTML')) return false;
      // Check file size — anything under 1KB is probably not a real video
      const stats = fs.statSync(filePath);
      if (stats.size < 1024) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get video duration in seconds
   */
  async getDuration(videoPath) {
    const result = await shell(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    return result.ok ? parseFloat(result.stdout) : 0;
  }

  /**
   * Extract key frames at regular intervals
   * Returns array of { path, timestamp } for each frame
   */
  async extractFrames(videoPath, dir, maxFrames = 10) {
    const duration = await this.getDuration(videoPath);
    if (!duration) return [];

    // Calculate interval between frames
    const interval = Math.max(duration / (maxFrames + 1), 1);
    const frameDir = path.join(dir, 'frames');
    fs.mkdirSync(frameDir, { recursive: true });

    // Extract frames using ffmpeg — one frame every N seconds
    const result = await shell(
      `ffmpeg -i "${videoPath}" -vf "fps=1/${interval},scale=640:-1" -frames:v ${maxFrames} -q:v 3 "${frameDir}/frame_%03d.jpg" -y`,
      30000
    );

    if (!result.ok) {
      console.error('[VIDEO] Frame extraction failed:', result.stderr);
      return [];
    }

    const frames = [];
    const files = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort();
    for (let i = 0; i < files.length; i++) {
      frames.push({
        path: path.join(frameDir, files[i]),
        timestamp: Math.round(interval * (i + 1)),
        filename: files[i]
      });
    }
    return frames;
  }

  /**
   * Extract and transcribe audio track
   */
  async transcribeAudio(videoPath, dir) {
    const audioPath = path.join(dir, 'audio.mp3');

    // Extract audio
    const extract = await shell(
      `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 -ac 1 -ar 16000 "${audioPath}" -y`,
      30000
    );

    if (!extract.ok || !fs.existsSync(audioPath)) {
      return { ok: false, error: 'Audio extraction failed: ' + extract.stderr };
    }

    const stats = fs.statSync(audioPath);
    if (stats.size < 1000) {
      return { ok: false, error: 'No audio track or audio too short' };
    }

    // Cap at 25MB (Whisper limit)
    if (stats.size > 25 * 1024 * 1024) {
      return { ok: false, error: 'Audio too large for transcription (>25MB)' };
    }

    try {
      const transcript = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(audioPath),
        response_format: 'text'
      });
      return { ok: true, text: transcript };
    } catch (e) {
      return { ok: false, error: 'Transcription failed: ' + e.message };
    }
  }

  /**
   * Analyze frames with GPT-4o vision
   */
  async analyzeFrames(frames, context = '') {
    if (!frames.length) return 'No frames to analyze.';

    const imageBlocks = frames.map(f => {
      const buffer = fs.readFileSync(f.path);
      const base64 = buffer.toString('base64');
      return {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' }
      };
    });

    const timeLabels = frames.map(f => `Frame at ${f.timestamp}s`).join(', ');

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `These are ${frames.length} key frames from a video (${timeLabels}).${context ? ' Context: ' + context : ''}\n\nDescribe what's happening in this video. Note key visual elements, text on screen, actions, people, products, locations, or anything important. Be specific and detailed.` },
            ...imageBlocks
          ]
        }]
      });
      return response.choices[0].message.content;
    } catch (e) {
      return 'Vision analysis failed: ' + e.message;
    }
  }

  /**
   * Full video processing pipeline
   * Returns { transcript, visualAnalysis, summary, duration }
   */
  async processVideo(videoPath, dir, context = '') {
    const duration = await this.getDuration(videoPath);
    console.log(`[VIDEO] Processing: ${Math.round(duration)}s video`);

    // Run frame extraction and audio transcription in parallel
    const [frames, audioResult] = await Promise.all([
      this.extractFrames(videoPath, dir, Math.min(Math.ceil(duration / 10), 12)),
      this.transcribeAudio(videoPath, dir)
    ]);

    console.log(`[VIDEO] Extracted ${frames.length} frames, audio: ${audioResult.ok ? 'transcribed' : audioResult.error}`);

    // Analyze frames with vision
    const visualAnalysis = await this.analyzeFrames(frames, context);

    // Build combined summary
    const transcript = audioResult.ok ? audioResult.text : null;

    let summary = '';
    if (transcript && visualAnalysis) {
      try {
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `Combine these two analyses of the same video into a coherent summary:\n\n**Visual analysis:**\n${visualAnalysis}\n\n**Audio transcript:**\n${transcript}\n\nProvide a clear, organized summary of the video content. Include key points, any instructions or information shared, and notable details.`
          }]
        });
        summary = response.choices[0].message.content;
      } catch (e) {
        summary = `**Visual:** ${visualAnalysis}\n\n**Audio:** ${transcript}`;
      }
    } else {
      summary = visualAnalysis || transcript || 'Could not process video.';
    }

    return {
      duration: Math.round(duration),
      frameCount: frames.length,
      transcript,
      visualAnalysis,
      summary
    };
  }

  /**
   * Clean up processed video files
   */
  cleanup(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[VIDEO] Cleanup failed:', e.message);
    }
  }
}

module.exports = VideoProcessor;
