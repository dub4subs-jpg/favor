// extract-text.js — Extracted from favor.js
// Message text extraction and type detection

const { stripInjectionPatterns } = require("../utils/sanitize");

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';

  // Extract the main text
  let text = '';
  if (m.conversation) text = m.conversation;
  else if (m.extendedTextMessage?.text) text = m.extendedTextMessage.text;
  else if (m.imageMessage?.caption) text = m.imageMessage.caption;
  else if (m.videoMessage?.caption) text = m.videoMessage.caption;
  else if (m.documentMessage?.caption) text = m.documentMessage.caption;

  // Extract quoted/replied-to message if present
  const contextInfo = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo;
  if (contextInfo?.quotedMessage) {
    const q = contextInfo.quotedMessage;
    const quotedText = q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || q.documentMessage?.caption || '';
    if (quotedText) {
      text = `[Replying to: "${stripInjectionPatterns(quotedText.slice(0, 500))}"]\n${text}`;
    }
  }

  return text;
}

function getMessageType(msg) {
  const m = msg.message;
  if (!m) return 'unknown';
  if (m.imageMessage) return 'image';
  if (m.audioMessage || m.pttMessage) return 'voice';
  if (m.videoMessage) return 'video';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  return 'text';
}

module.exports = { extractText, getMessageType };
