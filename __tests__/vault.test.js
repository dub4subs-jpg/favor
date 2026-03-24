const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const Vault = require('../vault');

const TEST_DB_PATH = path.join(__dirname, '.test-vault.db');
let sqliteDb;
let vault;

beforeEach(() => {
  // Fresh database for each test
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  sqliteDb = new Database(TEST_DB_PATH);
  vault = new Vault(sqliteDb, 'test-secret-key-12345');
});

afterEach(() => {
  sqliteDb.close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
});

describe('Vault', () => {
  test('requires encryption key of min 8 chars', () => {
    expect(() => new Vault(sqliteDb, 'short')).toThrow('min 8 chars');
    expect(() => new Vault(sqliteDb, '')).toThrow();
    expect(() => new Vault(sqliteDb, null)).toThrow();
  });

  test('save and retrieve string data', () => {
    vault.save('test_entry', 'general', 'secret data');
    const result = vault.get('test_entry');
    expect(result).not.toBeNull();
    expect(result.data).toBe('secret data');
    expect(result.label).toBe('test_entry');
    expect(result.category).toBe('general');
  });

  test('save and retrieve object data', () => {
    const cardData = { number: '4111111111111111', exp: '12/25', cvv: '123', name: 'Test User' };
    vault.save('visa_card', 'card', cardData);
    const result = vault.get('visa_card');
    expect(result.data).toEqual(cardData);
  });

  test('encrypted data is not plaintext in DB', () => {
    vault.save('secret', 'general', 'my secret password');
    const row = sqliteDb.prepare('SELECT encrypted_data FROM vault WHERE label = ?').get('secret');
    expect(row.encrypted_data).not.toContain('my secret password');
    expect(row.encrypted_data).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/); // iv:tag:ciphertext
  });

  test('update existing entry', () => {
    vault.save('entry', 'general', 'version 1');
    const r1 = vault.save('entry', 'general', 'version 2');
    expect(r1.action).toBe('updated');

    const result = vault.get('entry');
    expect(result.data).toBe('version 2');
  });

  test('create new entry returns id', () => {
    const result = vault.save('new_entry', 'general', 'data');
    expect(result.action).toBe('created');
    expect(result.id).toBeDefined();
  });

  test('list entries without decrypted data', () => {
    vault.save('card1', 'card', { number: '4111' });
    vault.save('addr1', 'address', { street: '123 Main' });
    vault.save('card2', 'card', { number: '5500' });

    const all = vault.list();
    expect(all.length).toBe(3);
    expect(all[0]).not.toHaveProperty('encrypted_data');
    expect(all[0]).toHaveProperty('label');
    expect(all[0]).toHaveProperty('category');

    const cards = vault.list('card');
    expect(cards.length).toBe(2);
  });

  test('delete entry', () => {
    vault.save('to_delete', 'general', 'temp');
    expect(vault.delete('to_delete')).toBe(true);
    expect(vault.get('to_delete')).toBeNull();
    expect(vault.delete('nonexistent')).toBe(false);
  });

  test('get nonexistent entry returns null', () => {
    expect(vault.get('nope')).toBeNull();
  });

  test('getCard extracts card fields', () => {
    vault.save('my_visa', 'card', {
      number: '4111111111111111',
      exp: '12/25',
      cvv: '123',
      name: 'John Doe',
      zip: '33101',
    });
    const card = vault.getCard('my_visa');
    expect(card.number).toBe('4111111111111111');
    expect(card.exp).toBe('12/25');
    expect(card.cvv).toBe('123');
    expect(card.name).toBe('John Doe');
  });

  test('wrong key cannot decrypt', () => {
    vault.save('secret', 'general', 'hidden data');
    // Create a new vault with different key
    const vault2 = new Vault(sqliteDb, 'different-key-67890');
    const result = vault2.get('secret');
    expect(result.data).toBeNull();
    expect(result.error).toContain('Decryption failed');
  });
});
