/**
 * Evolution API Adapter for Favor
 *
 * Connects to a self-hosted Evolution API instance via REST + webhooks.
 * Users run Evolution API in Docker and Favor talks to it over HTTP
 * instead of managing Baileys connections directly.
 *
 * Config (config.json):
 *   "platform": "evolution",
 *   "evolution": {
 *     "apiUrl": "http://localhost:8080",
 *     "apiKey": "your-evolution-api-key",
 *     "instanceName": "favor",
 *     "webhookPort": 3300
 *   }
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

class EvolutionAdapter extends EventEmitter {
  constructor(config) {
    super();
    const evo = config.evolution || {};
    this.apiUrl = (evo.apiUrl || 'http://localhost:8080').replace(/\/$/, '');
    this.apiKey = evo.apiKey || '';
    this.instanceName = evo.instanceName || 'favor';
    this.webhookPort = evo.webhookPort || 3300;
    this.operatorNumber = config.operatorNumber || '';
    this.webhookServer = null;
    this.connected = false;

    // Provide a sock-compatible interface so favor.js can use it
    this.sock = this._createSockProxy();
  }

  // ─── REST helpers ───

  async _request(method, endpoint, body = null) {
    const url = `${this.apiUrl}${endpoint}`;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiKey
        }
      };

      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async _get(endpoint) { return this._request('GET', endpoint); }
  async _post(endpoint, body) { return this._request('POST', endpoint, body); }
  async _put(endpoint, body) { return this._request('PUT', endpoint, body); }
  async _delete(endpoint) { return this._request('DELETE', endpoint); }

  // ─── Instance management ───

  async createInstance() {
    const res = await this._post('/instance/create', {
      instanceName: this.instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: false,
      webhookByEvents: true,
      webhookBase64: true,
      webhookEvents: [
        'MESSAGES_UPSERT',
        'CONNECTION_UPDATE',
        'QRCODE_UPDATED'
      ],
      webhookUrl: `http://localhost:${this.webhookPort}/webhook`
    });
    return res.data;
  }

  async getInstance() {
    const res = await this._get(`/instance/fetchInstances?instanceName=${this.instanceName}`);
    return res.data;
  }

  async connectInstance() {
    const res = await this._get(`/instance/connect/${this.instanceName}`);
    return res.data;
  }

  async getQRCode() {
    const res = await this._get(`/instance/connect/${this.instanceName}`);
    return res.data;
  }

  // ─── Messaging ───

  async sendText(jid, text) {
    const number = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    const res = await this._post(`/message/sendText/${this.instanceName}`, {
      number,
      text
    });
    return res.data;
  }

  async sendImage(jid, imageUrl, caption = '') {
    const number = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    const res = await this._post(`/message/sendMedia/${this.instanceName}`, {
      number,
      mediatype: 'image',
      media: imageUrl,
      caption
    });
    return res.data;
  }

  async sendDocument(jid, docUrl, fileName, caption = '') {
    const number = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    const res = await this._post(`/message/sendMedia/${this.instanceName}`, {
      number,
      mediatype: 'document',
      media: docUrl,
      fileName,
      caption
    });
    return res.data;
  }

  async sendAudio(jid, audioUrl) {
    const number = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    const res = await this._post(`/message/sendWhatsAppAudio/${this.instanceName}`, {
      number,
      audio: audioUrl
    });
    return res.data;
  }

  // ─── Webhook server ───

  startWebhookServer() {
    this.webhookServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          res.writeHead(200);
          res.end('ok');
          try {
            const event = JSON.parse(body);
            this._handleWebhookEvent(event);
          } catch (e) {
            console.error('[EVOLUTION] Webhook parse error:', e.message);
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.webhookServer.listen(this.webhookPort, () => {
      console.log(`[EVOLUTION] Webhook server listening on port ${this.webhookPort}`);
    });
  }

  _handleWebhookEvent(event) {
    const eventType = event.event;

    switch (eventType) {
      case 'messages.upsert': {
        const msg = event.data;
        if (!msg || msg.key?.fromMe) return; // skip own messages

        // Normalize to Baileys-like message format for favor.js compatibility
        const normalized = {
          key: {
            remoteJid: msg.key?.remoteJid || '',
            fromMe: false,
            id: msg.key?.id || ''
          },
          message: msg.message || {},
          pushName: msg.pushName || '',
          messageTimestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
          // Preserve raw Evolution data for adapters that need it
          _evolution: msg
        };

        this.emit('message', normalized);
        break;
      }

      case 'connection.update': {
        const state = event.data?.state;
        if (state === 'open') {
          this.connected = true;
          console.log('[EVOLUTION] WhatsApp connected');
          this.emit('connection', { status: 'open' });
        } else if (state === 'close') {
          this.connected = false;
          console.log('[EVOLUTION] WhatsApp disconnected');
          this.emit('connection', { status: 'close' });
        }
        break;
      }

      case 'qrcode.updated': {
        const qr = event.data?.qrcode;
        if (qr) {
          console.log('[EVOLUTION] Scan QR code in Evolution API dashboard or use:');
          console.log(`[EVOLUTION] ${this.apiUrl}/instance/connect/${this.instanceName}`);
          this.emit('qr', qr);
        }
        break;
      }
    }
  }

  // ─── Sock-compatible proxy ───
  // Makes this adapter work as a drop-in replacement for Baileys sock in favor.js

  _createSockProxy() {
    const self = this;
    return {
      sendMessage: async (jid, content) => {
        if (content.text) {
          return self.sendText(jid, content.text);
        }
        if (content.image) {
          return self.sendImage(jid, content.image.url, content.caption || '');
        }
        if (content.document) {
          return self.sendDocument(jid, content.document.url, content.fileName || 'file', content.caption || '');
        }
        if (content.audio) {
          return self.sendAudio(jid, content.audio.url);
        }
        console.warn('[EVOLUTION] Unsupported message type:', Object.keys(content));
      },
      // Read receipts
      readMessages: async (keys) => {
        // Evolution API handles read receipts differently
        // This is a no-op for compatibility
      },
      // Presence updates
      sendPresenceUpdate: async (type, jid) => {
        // Optional: implement via Evolution API
      },
      ev: self, // event emitter compatibility
      user: { id: self.operatorNumber }
    };
  }

  // ─── Main connect flow ───

  async connect() {
    console.log('[EVOLUTION] Connecting to Evolution API at', this.apiUrl);

    // Start webhook server first
    this.startWebhookServer();

    // Check if instance exists
    try {
      const instance = await this.getInstance();
      if (!instance || (Array.isArray(instance) && instance.length === 0)) {
        console.log('[EVOLUTION] Creating new instance:', this.instanceName);
        await this.createInstance();
      }
    } catch (e) {
      console.log('[EVOLUTION] Creating new instance:', this.instanceName);
      await this.createInstance();
    }

    // Connect the instance
    try {
      const conn = await this.connectInstance();
      if (conn?.base64) {
        console.log('[EVOLUTION] QR code available at Evolution API dashboard');
      } else {
        console.log('[EVOLUTION] Instance connected or connecting...');
      }
    } catch (e) {
      console.error('[EVOLUTION] Connection error:', e.message);
    }

    return this.sock;
  }

  async disconnect() {
    if (this.webhookServer) {
      this.webhookServer.close();
    }
    try {
      await this._delete(`/instance/logout/${this.instanceName}`);
    } catch (e) {
      // ignore
    }
  }

}

module.exports = EvolutionAdapter;
