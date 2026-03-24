// core/plugin-loader.js — Plugin system for the Favor framework
// Scans plugins/ directory on startup, validates plugin contracts,
// and registers them with the tool dispatcher and tool-selector.
//
// Plugin contract:
//   module.exports = {
//     name: 'my_tool',              // unique tool name (required)
//     description: 'What it does',  // for AI function calling (required)
//     keywords: ['word1', 'word2'], // for tool-selector keyword matching
//     trustLevel: 'operator',       // minimum trust: 'operator' | 'staff' | 'customer'
//     parameters: { ... },          // JSON Schema for parameters
//     execute: async (args, ctx) => { ... }  // ctx = { config, db, vault, contact }
//   }

const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

class PluginLoader {
  constructor() {
    this.plugins = new Map(); // name -> plugin
    this.loadErrors = [];
  }

  /**
   * Scan plugins/ directory and load all valid plugins.
   * Invalid plugins are logged as warnings, not crashes.
   * @returns {{ loaded: number, errors: string[] }}
   */
  load() {
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      return { loaded: 0, errors: [] };
    }

    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));

    for (const file of files) {
      try {
        const plugin = require(path.join(PLUGINS_DIR, file));
        const errors = this._validate(plugin, file);
        if (errors.length) {
          const msg = `[PLUGIN] Invalid plugin ${file}: ${errors.join(', ')}`;
          console.warn(msg);
          this.loadErrors.push(msg);
          continue;
        }

        if (this.plugins.has(plugin.name)) {
          const msg = `[PLUGIN] Duplicate plugin name "${plugin.name}" in ${file} — skipped`;
          console.warn(msg);
          this.loadErrors.push(msg);
          continue;
        }

        this.plugins.set(plugin.name, {
          ...plugin,
          _file: file,
        });
      } catch (e) {
        const msg = `[PLUGIN] Failed to load ${file}: ${e.message}`;
        console.warn(msg);
        this.loadErrors.push(msg);
      }
    }

    if (this.plugins.size > 0) {
      console.log(`[PLUGIN] Loaded ${this.plugins.size} plugin(s): ${[...this.plugins.keys()].join(', ')}`);
    }

    return { loaded: this.plugins.size, errors: this.loadErrors };
  }

  /**
   * Validate a plugin's contract.
   * @param {Object} plugin
   * @param {string} filename
   * @returns {string[]} validation errors (empty = valid)
   */
  _validate(plugin, filename) {
    const errors = [];
    if (!plugin || typeof plugin !== 'object') errors.push('must export an object');
    else {
      if (!plugin.name || typeof plugin.name !== 'string') errors.push('missing "name" (string)');
      if (!plugin.description || typeof plugin.description !== 'string') errors.push('missing "description" (string)');
      if (typeof plugin.execute !== 'function') errors.push('missing "execute" (async function)');
      if (plugin.keywords && !Array.isArray(plugin.keywords)) errors.push('"keywords" must be an array');
      if (plugin.trustLevel && !['operator', 'staff', 'customer'].includes(plugin.trustLevel)) {
        errors.push('"trustLevel" must be "operator", "staff", or "customer"');
      }
    }
    return errors;
  }

  /**
   * Get OpenAI-format tool definitions for all loaded plugins.
   * These can be appended to the TOOLS array.
   * @returns {Array} OpenAI tool definitions
   */
  getToolDefinitions() {
    const tools = [];
    for (const [name, plugin] of this.plugins) {
      tools.push({
        type: 'function',
        function: {
          name,
          description: plugin.description,
          parameters: plugin.parameters || { type: 'object', properties: {} },
        },
      });
    }
    return tools;
  }

  /**
   * Get keyword groups for tool-selector integration.
   * @returns {Object} { toolName: ['keyword1', 'keyword2'] }
   */
  getKeywordMap() {
    const map = {};
    for (const [name, plugin] of this.plugins) {
      if (plugin.keywords?.length) {
        map[name] = plugin.keywords;
      }
    }
    return map;
  }

  /**
   * Get trust level requirements for all plugins.
   * @returns {Object} { toolName: 'operator'|'staff'|'customer' }
   */
  getTrustLevels() {
    const levels = {};
    for (const [name, plugin] of this.plugins) {
      levels[name] = plugin.trustLevel || 'operator';
    }
    return levels;
  }

  /**
   * Execute a plugin tool.
   * @param {string} toolName
   * @param {Object} args - Tool arguments
   * @param {Object} context - { config, db, vault, contact, ... }
   * @returns {Promise<any>} Tool result
   */
  async execute(toolName, args, context) {
    const plugin = this.plugins.get(toolName);
    if (!plugin) return null; // not a plugin tool

    try {
      return await plugin.execute(args, context);
    } catch (e) {
      console.error(`[PLUGIN] ${toolName} error:`, e.message);
      return `Plugin error (${toolName}): ${e.message}`;
    }
  }

  /**
   * Check if a tool name belongs to a plugin.
   * @param {string} toolName
   * @returns {boolean}
   */
  has(toolName) {
    return this.plugins.has(toolName);
  }

  /**
   * Get a summary of loaded plugins for debugging.
   * @returns {string}
   */
  status() {
    if (this.plugins.size === 0) return 'No plugins loaded.';
    const lines = [];
    for (const [name, p] of this.plugins) {
      lines.push(`  ${name} (${p._file}) — ${p.trustLevel || 'operator'} — ${p.description.substring(0, 60)}`);
    }
    return `${this.plugins.size} plugin(s):\n${lines.join('\n')}`;
  }
}

module.exports = PluginLoader;
