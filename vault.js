/**
 * Encrypted Vault — stores sensitive personal info (cards, addresses, IDs)
 * AES-256-GCM encryption at rest, keyed from config secret
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

class Vault {
  constructor(db, encryptionKey) {
    if (!encryptionKey || encryptionKey.length < 8) {
      throw new Error('Vault requires an encryption key (min 8 chars) in config.vault.secret');
    }
    this.db = db;
    // Derive a 32-byte key from the passphrase
    this.key = crypto.scryptSync(encryptionKey, 'favor-vault-salt', 32);
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT 'general',
        encrypted_data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vault_category ON vault(category);
      CREATE INDEX IF NOT EXISTS idx_vault_label ON vault(label);
    `);
  }

  _encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    let enc = cipher.update(plaintext, 'utf8', 'hex');
    enc += cipher.final('hex');
    const tag = cipher.getAuthTag();
    // Store as iv:tag:ciphertext (all hex)
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc;
  }

  _decrypt(stored) {
    const parts = stored.split(':');
    if (parts.length < 3) throw new Error('Invalid vault data format');
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const enc = parts.slice(2).join(':'); // rejoin in case data had colons
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  }

  /**
   * Save or update a vault entry
   * @param {string} label - unique key (e.g. "visa_card", "home_address", "passport")
   * @param {string} category - "card", "address", "identity", "general"
   * @param {object|string} data - the sensitive data to store
   */
  save(label, category, data) {
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const encrypted = this._encrypt(plaintext);
    const existing = this.db.prepare('SELECT id FROM vault WHERE label = ?').get(label);
    if (existing) {
      this.db.prepare('UPDATE vault SET category = ?, encrypted_data = ?, updated_at = datetime(\'now\') WHERE label = ?')
        .run(category, encrypted, label);
      return { action: 'updated', label };
    } else {
      const result = this.db.prepare('INSERT INTO vault (label, category, encrypted_data) VALUES (?, ?, ?)')
        .run(label, category, encrypted);
      return { action: 'created', label, id: result.lastInsertRowid };
    }
  }

  /**
   * Retrieve and decrypt a vault entry
   */
  get(label) {
    const row = this.db.prepare('SELECT * FROM vault WHERE label = ?').get(label);
    if (!row) return null;
    try {
      const decrypted = this._decrypt(row.encrypted_data);
      // Try to parse as JSON, fall back to string
      try { return { ...row, data: JSON.parse(decrypted) }; }
      catch { return { ...row, data: decrypted }; }
    } catch (e) {
      return { ...row, data: null, error: 'Decryption failed: ' + e.message };
    }
  }

  /**
   * List all vault entries (labels + categories only, no decrypted data)
   */
  list(category = null) {
    if (category) {
      return this.db.prepare('SELECT id, label, category, created_at, updated_at FROM vault WHERE category = ? ORDER BY label')
        .all(category);
    }
    return this.db.prepare('SELECT id, label, category, created_at, updated_at FROM vault ORDER BY category, label').all();
  }

  /**
   * Delete a vault entry
   */
  delete(label) {
    const result = this.db.prepare('DELETE FROM vault WHERE label = ?').run(label);
    return result.changes > 0;
  }

  /**
   * Get a card formatted for form filling
   */
  getCard(label) {
    const entry = this.get(label);
    if (!entry || !entry.data) return null;
    const d = entry.data;
    return {
      number: d.number || d.card_number,
      exp: d.exp || d.expiration || d.exp_date,
      cvv: d.cvv || d.cvc || d.security_code,
      name: d.name || d.cardholder || d.card_name,
      zip: d.zip || d.billing_zip || d.postal_code,
      billing_address: d.billing_address || d.address
    };
  }

  /**
   * Get personal info formatted for form filling
   */
  getIdentity(label) {
    const entry = this.get(label);
    if (!entry || !entry.data) return null;
    return entry.data;
  }
}

module.exports = Vault;
