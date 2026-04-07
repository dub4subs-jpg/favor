'use strict';

/**
 * SiYuan Note Bridge for Favor AI
 * Provides API layer to query and sync data between Favor's memory system
 * and a local SiYuan Note instance.
 *
 * Usage:
 *   const siyuan = require('./siyuan-bridge');
 *   await siyuan.init({ host: 'localhost', port: 6806, token: '...' });
 *   const birthdays = await siyuan.fetchBirthdays();
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '.siyuan-config.json');
const CACHE_DIR = path.join(__dirname, '.cache/siyuan');

let _config = null;
let _sessionCookie = null;
let _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

// ─────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────

async function init(config) {
  _config = config || loadConfig();

  // Ensure cache dir exists
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // Authenticate and test connection
  try {
    await login();
    const status = await apiCall('POST', '/api/system/getConf', {});
    console.log('[SIYUAN] Connected:', status?.conf ? 'OK' : 'No conf');
  } catch (e) {
    console.warn('[SIYUAN] Warning: Could not connect to SiYuan at', _config.host + ':' + _config.port, '-', e.message);
  }
}

/**
 * Authenticate with SiYuan via loginAuth endpoint.
 * SiYuan v3.x uses session cookies (not Authorization headers).
 * Calls /api/system/loginAuth with the authCode and stores the Set-Cookie value.
 */
async function login() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ authCode: _config.token });
    const options = {
      hostname: _config.host,
      port: _config.port,
      path: '/api/system/loginAuth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 0) {
            return reject(new Error(`[SIYUAN] Login failed: ${json.msg}`));
          }
          // Extract session cookie from Set-Cookie header
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            const match = setCookie.find(c => c.startsWith('siyuan='));
            if (match) {
              _sessionCookie = match.split(';')[0]; // "siyuan=<value>"
            }
          }
          if (!_sessionCookie) {
            return reject(new Error('[SIYUAN] Login succeeded but no session cookie returned'));
          }
          console.log('[SIYUAN] Authenticated via loginAuth');
          resolve();
        } catch (e) {
          reject(new Error(`[SIYUAN] Login parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('[SIYUAN] Login timeout')); });
    req.write(postData);
    req.end();
  });
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  // Default config (offline mode)
  return {
    host: 'localhost',
    port: 6806,
    token: process.env.SIYUAN_TOKEN || '',
    enabled: false
  };
}

// ─────────────────────────────────────────────────────────────────────
// HTTP API Layer
// ─────────────────────────────────────────────────────────────────────

async function apiCall(method, apiPath, body = null) {
  if (!_config?.host) {
    throw new Error('[SIYUAN] Not initialized');
  }

  // Re-login if session expired (lazy re-auth)
  if (!_sessionCookie && _config.token) {
    await login();
  }

  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (_sessionCookie) {
      headers['Cookie'] = _sessionCookie;
    }

    const options = {
      hostname: _config.host,
      port: _config.port,
      path: apiPath,
      method,
      headers,
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            // Clear session on auth failure so next call re-authenticates
            if (res.statusCode === 401 || (json.msg && json.msg.includes('Auth failed'))) {
              _sessionCookie = null;
            }
            reject(new Error(`[SIYUAN] HTTP ${res.statusCode}: ${json.msg || 'Unknown error'}`));
          } else if (json.code && json.code !== 0) {
            // SiYuan returns code:-1 for auth failures even with HTTP 200
            if (json.msg && json.msg.includes('Auth failed')) {
              _sessionCookie = null;
            }
            reject(new Error(`[SIYUAN] API error (code ${json.code}): ${json.msg || 'Unknown'}`));
          } else {
            resolve(json.data || json);
          }
        } catch (e) {
          reject(new Error(`[SIYUAN] Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('[SIYUAN] Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────
// Query Functions (primary interface)
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch upcoming birthdays (next N days)
 * Queries the Contacts database block in SiYuan
 */
async function fetchBirthdays(days = 30) {
  const cacheKey = `birthdays_${days}`;

  if (_cache.has(cacheKey)) {
    const { data, expires } = _cache.get(cacheKey);
    if (Date.now() < expires) return data;
  }

  try {
    // Query blocks containing birthday data via SQL
    const results = await apiCall('POST', '/api/query/sql', {
      stmt: "SELECT * FROM blocks WHERE content LIKE '%birthday%' AND type = 'd' ORDER BY updated DESC"
    });

    // Filter and format results
    const birthdays = (results || [])
      .filter(r => r.content)
      .map(r => ({
        id: r.id,
        name: r.content,
        birthday: r.ial?.birthday || '',
        role: r.ial?.role || '',
        linkedTasks: []
      }))
      .filter(r => r.birthday)
      .sort((a, b) => {
        const aMonth = parseInt(a.birthday.split('-')[0]);
        const bMonth = parseInt(b.birthday.split('-')[0]);
        return aMonth - bMonth;
      });

    _cache.set(cacheKey, {
      data: birthdays,
      expires: Date.now() + CACHE_TTL_MS
    });

    return birthdays;
  } catch (e) {
    console.warn('[SIYUAN] fetchBirthdays failed:', e.message);
    return [];
  }
}

/**
 * Fetch invoices for a specific recipient or all
 * Queries the Invoices database block
 */
async function fetchInvoices(recipient = null, status = null) {
  const cacheKey = `invoices_${recipient || 'all'}_${status || 'all'}`;

  if (_cache.has(cacheKey)) {
    const { data, expires } = _cache.get(cacheKey);
    if (Date.now() < expires) return data;
  }

  try {
    // Query blocks containing invoice data via SQL
    const results = await apiCall('POST', '/api/query/sql', {
      stmt: "SELECT * FROM blocks WHERE content LIKE '%invoice%' AND type = 'd' ORDER BY updated DESC"
    });

    let invoices = (results || [])
      .filter(r => r.content)
      .map(r => ({
        id: r.id,
        date: r.ial?.date || '',
        recipient: r.ial?.recipient || '',
        amount: parseFloat(r.ial?.amount) || 0,
        items: r.ial?.items || '',
        status: r.ial?.status || 'draft',
        notes: r.ial?.notes || ''
      }));

    if (recipient) invoices = invoices.filter(i => i.recipient === recipient);
    if (status) invoices = invoices.filter(i => i.status === status);

    invoices.sort((a, b) => new Date(b.date) - new Date(a.date));

    _cache.set(cacheKey, {
      data: invoices,
      expires: Date.now() + CACHE_TTL_MS
    });

    return invoices;
  } catch (e) {
    console.warn('[SIYUAN] fetchInvoices failed:', e.message);
    return [];
  }
}

/**
 * Get all backlinks for a contact (memory graph)
 * Returns blocks that link to a given contact
 */
async function getContactGraph(contactName) {
  const cacheKey = `graph_${contactName}`;

  if (_cache.has(cacheKey)) {
    const { data, expires } = _cache.get(cacheKey);
    if (Date.now() < expires) return data;
  }

  try {
    // First find the contact's doc block by name
    const searchResults = await apiCall('POST', '/api/search/fullTextSearchBlock', {
      query: contactName
    });

    const graph = {
      contact: contactName,
      projects: [],
      relationships: [],
      tasks: [],
      notes: []
    };

    // If we found a matching doc, get its backlinks
    const docBlock = (searchResults?.blocks || []).find(b => b.content?.includes(contactName));
    if (!docBlock) {
      _cache.set(cacheKey, { data: graph, expires: Date.now() + CACHE_TTL_MS });
      return graph;
    }

    const results = await apiCall('POST', '/api/ref/getBacklinkDoc', {
      id: docBlock.id
    });

    // results.backlinks is an array of {dom, blockPaths} objects
    const backlinks = results?.backlinks || [];
    backlinks.forEach(link => {
      const entry = { id: link.id, content: link.dom || '' };
      if (entry.content.includes('project')) graph.projects.push(entry);
      else if (entry.content.includes('contact')) graph.relationships.push(entry);
      else if (entry.content.includes('task')) graph.tasks.push(entry);
      else graph.notes.push(entry);
    });

    _cache.set(cacheKey, {
      data: graph,
      expires: Date.now() + CACHE_TTL_MS
    });

    return graph;
  } catch (e) {
    console.warn('[SIYUAN] getContactGraph failed:', e.message);
    return { contact: contactName, projects: [], relationships: [], tasks: [], notes: [] };
  }
}

/**
 * Full-text search across all SiYuan blocks
 */
async function search(query) {
  try {
    const results = await apiCall('POST', '/api/search/fullTextSearchBlock', {
      query
    });

    return (results?.blocks || []).map(r => ({
      id: r.id,
      rootID: r.rootID,
      content: r.content,
      type: r.type,
      hPath: r.hPath
    }));
  } catch (e) {
    console.warn('[SIYUAN] search failed:', e.message);
    return [];
  }
}

/**
 * Create a new block in SiYuan with optional backlinks
 */
async function createMemory(content, parentID, type = 'fact') {
  try {
    // Format content with metadata
    const timestamp = new Date().toISOString();
    const markdown = `${content}\n{: custom-type="${type}" custom-created="${timestamp}"}`;

    const result = await apiCall('POST', '/api/block/insertBlock', {
      dataType: 'markdown',
      data: markdown,
      parentID
    });

    // Invalidate relevant caches
    _cache.clear();

    return {
      id: result?.[0]?.doOperations?.[0]?.id || null,
      content,
      type,
      parentID,
      created: timestamp
    };
  } catch (e) {
    console.warn('[SIYUAN] createMemory failed:', e.message);
    return null;
  }
}

/**
 * Update an existing block
 */
async function updateMemory(id, content) {
  try {
    const timestamp = new Date().toISOString();
    const markdown = typeof content === 'string'
      ? `${content}\n{: custom-updated="${timestamp}"}`
      : `${content.data || ''}\n{: custom-updated="${timestamp}"}`;

    await apiCall('POST', '/api/block/updateBlock', {
      dataType: 'markdown',
      data: markdown,
      id
    });

    _cache.clear();
    return { id, content, updated: timestamp };
  } catch (e) {
    console.warn('[SIYUAN] updateMemory failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Health & Status
// ─────────────────────────────────────────────────────────────────────

async function health() {
  try {
    const conf = await apiCall('POST', '/api/system/getConf', {});
    return {
      connected: true,
      version: conf?.conf?.system?.kernelVersion,
      workspace: conf?.conf?.system?.workspaceDir
    };
  } catch (e) {
    return {
      connected: false,
      error: e.message
    };
  }
}

function clearCache() {
  _cache.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  init,
  loadConfig,

  // Query API
  fetchBirthdays,
  fetchInvoices,
  getContactGraph,
  search,
  createMemory,
  updateMemory,

  // Health
  health,
  clearCache,

  // Internal
  login,
  apiCall
};
