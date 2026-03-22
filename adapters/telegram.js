/**
 * Telegram Adapter for Favor
 *
 * Provides a sock-compatible interface so favor.js can use Telegram
 * as a drop-in replacement for WhatsApp/Baileys.
 *
 * Users create a bot via @BotFather on Telegram, get a token,
 * and set it in config.json under telegram.botToken.
 */

const { Bot, InputFile } = require('grammy');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class TelegramAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.telegramConfig = config.telegram || {};
    this.bot = null;
    this.onMessage = options.onMessage || null; // callback for incoming messages
    this.onReady = options.onReady || null;
    this.onDisconnect = options.onDisconnect || null;

    // Map Telegram chat IDs to a consistent contact format
    // Telegram uses numeric chat IDs, WhatsApp uses phone@s.whatsapp.net
    // We'll use "tg_CHATID" as the contact identifier
    this.chatIdMap = new Map(); // chatId -> user info
  }

  /**
   * Start the Telegram bot
   */
  async start() {
    const token = this.telegramConfig.botToken;
    if (!token) {
      throw new Error('telegram.botToken not set in config.json. Get one from @BotFather on Telegram.');
    }

    this.bot = new Bot(token);

    // Handle incoming messages
    this.bot.on('message', async (ctx) => {
      try {
        const msg = this._convertMessage(ctx);
        if (msg && this.onMessage) {
          await this.onMessage(msg);
        }
      } catch (err) {
        console.error('[TELEGRAM] Error handling message:', err.message);
      }
    });

    // Handle callback queries (button presses) — future use
    this.bot.on('callback_query', async (ctx) => {
      await ctx.answerCallbackQuery();
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('[TELEGRAM] Bot error:', err.message);
    });

    // Start polling
    console.log('[TELEGRAM] Starting bot...');
    this.bot.start({
      onStart: (botInfo) => {
        console.log(`[TELEGRAM] Bot online: @${botInfo.username} (${botInfo.first_name})`);
        if (this.onReady) this.onReady(botInfo);
      },
    });

    return this;
  }

  /**
   * Convert a grammy message context to the internal message format
   * that handleMessage() expects (mimics Baileys message structure)
   */
  _convertMessage(ctx) {
    const msg = ctx.message;
    if (!msg) return null;

    const chatId = msg.chat.id;
    const contactId = `tg_${chatId}`;

    // Store user info for later lookups
    this.chatIdMap.set(chatId, {
      id: chatId,
      firstName: msg.from?.first_name || '',
      lastName: msg.from?.last_name || '',
      username: msg.from?.username || '',
    });

    // Build a Baileys-compatible message object
    const converted = {
      key: {
        fromMe: false,
        remoteJid: contactId,
        id: String(msg.message_id),
      },
      message: {},
      messageTimestamp: msg.date,
      // Store the original ctx for media downloads
      _telegramCtx: ctx,
      _telegramChatId: chatId,
    };

    // Text messages
    if (msg.text) {
      converted.message.conversation = msg.text;
    }
    // Photo messages
    else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1]; // highest resolution
      converted.message.imageMessage = {
        caption: msg.caption || '',
        mimetype: 'image/jpeg',
        _telegramFileId: largest.file_id,
      };
    }
    // Voice messages
    else if (msg.voice) {
      converted.message.audioMessage = {
        mimetype: msg.voice.mime_type || 'audio/ogg',
        _telegramFileId: msg.voice.file_id,
      };
      // Also set pttMessage for compatibility
      converted.message.pttMessage = converted.message.audioMessage;
    }
    // Video messages
    else if (msg.video) {
      converted.message.videoMessage = {
        caption: msg.caption || '',
        mimetype: msg.video.mime_type || 'video/mp4',
        _telegramFileId: msg.video.file_id,
      };
    }
    // Document messages
    else if (msg.document) {
      converted.message.documentMessage = {
        caption: msg.caption || '',
        mimetype: msg.document.mime_type || 'application/octet-stream',
        fileName: msg.document.file_name || 'document',
        _telegramFileId: msg.document.file_id,
      };
    }
    // Sticker messages
    else if (msg.sticker) {
      converted.message.stickerMessage = {
        mimetype: msg.sticker.is_animated ? 'application/tgs' : 'image/webp',
        _telegramFileId: msg.sticker.file_id,
      };
    }

    return converted;
  }

  /**
   * Download media from a Telegram message
   * Returns a Buffer (same as Baileys downloadMediaMessage)
   */
  async downloadMedia(msg) {
    // Find the file_id from the message
    const m = msg.message;
    if (!m) return null;

    const fileId =
      m.imageMessage?._telegramFileId ||
      m.audioMessage?._telegramFileId ||
      m.pttMessage?._telegramFileId ||
      m.videoMessage?._telegramFileId ||
      m.documentMessage?._telegramFileId ||
      m.stickerMessage?._telegramFileId;

    if (!fileId) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      const filePath = file.file_path;
      const url = `https://api.telegram.org/file/bot${this.telegramConfig.botToken}/${filePath}`;

      return new Promise((resolve, reject) => {
        https.get(url, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });
    } catch (err) {
      console.error('[TELEGRAM] Media download failed:', err.message);
      return null;
    }
  }

  /**
   * Create a sock-compatible interface
   * This is the key abstraction — favor.js calls sock.sendMessage everywhere,
   * so we provide the same interface backed by Telegram's API.
   */
  createSockInterface() {
    const adapter = this;
    return {
      // Main send method — mimics Baileys sock.sendMessage(jid, content)
      sendMessage: async (contactId, content) => {
        const chatId = adapter._resolveChatId(contactId);
        if (!chatId) {
          console.error(`[TELEGRAM] Cannot resolve chat ID for: ${contactId}`);
          return;
        }

        try {
          // Text message
          if (content.text) {
            // Telegram has a 4096 char limit per message
            const text = content.text;
            if (text.length > 4096) {
              const chunks = [];
              let remaining = text;
              while (remaining.length > 0) {
                chunks.push(remaining.slice(0, 4096));
                remaining = remaining.slice(4096);
              }
              for (const chunk of chunks) {
                await adapter.bot.api.sendMessage(chatId, chunk, { parse_mode: undefined });
              }
            } else {
              await adapter.bot.api.sendMessage(chatId, text, { parse_mode: undefined });
            }
          }
          // Image message
          else if (content.image) {
            const source = new InputFile(content.image);
            await adapter.bot.api.sendPhoto(chatId, source, {
              caption: content.caption || undefined,
            });
          }
          // Document message
          else if (content.document) {
            const source = new InputFile(content.document, content.fileName || 'file');
            await adapter.bot.api.sendDocument(chatId, source, {
              caption: content.caption || undefined,
            });
          }
        } catch (err) {
          console.error(`[TELEGRAM] Send failed to ${chatId}:`, err.message);
        }
      },

      // Typing indicator — mimics Baileys sock.sendPresenceUpdate
      sendPresenceUpdate: async (status, contactId) => {
        if (!contactId) return;
        const chatId = adapter._resolveChatId(contactId);
        if (!chatId) return;

        try {
          if (status === 'composing') {
            await adapter.bot.api.sendChatAction(chatId, 'typing');
          }
          // 'paused' / 'available' — no Telegram equivalent, just skip
        } catch (err) {
          // Non-critical, don't log noise
        }
      },

      // Compatibility stubs
      ev: {
        on: () => {},
        removeAllListeners: () => {},
      },
      end: () => {
        if (adapter.bot) adapter.bot.stop();
      },
      user: {
        id: 'telegram-bot',
        lid: null,
      },
      updateMediaMessage: async () => {},
    };
  }

  /**
   * Resolve a contact ID to a Telegram chat ID
   * Handles both "tg_12345" format and raw WhatsApp JIDs (for operator messages)
   */
  _resolveChatId(contactId) {
    if (!contactId) return null;

    // Already a tg_ prefixed ID
    if (typeof contactId === 'string' && contactId.startsWith('tg_')) {
      return parseInt(contactId.replace('tg_', ''), 10);
    }

    // If it's a WhatsApp JID format (from operator config), try to find operator's Telegram chat
    if (typeof contactId === 'string' && contactId.includes('@')) {
      // Check if operator has a configured Telegram chat ID
      const operatorChatId = this.telegramConfig.operatorChatId;
      if (operatorChatId) return parseInt(operatorChatId, 10);
    }

    // Raw number — try as chat ID
    const num = parseInt(contactId, 10);
    if (!isNaN(num)) return num;

    return null;
  }

  /**
   * Stop the bot
   */
  stop() {
    if (this.bot) {
      this.bot.stop();
      console.log('[TELEGRAM] Bot stopped');
    }
  }
}

module.exports = TelegramAdapter;
