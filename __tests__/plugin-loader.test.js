const path = require('path');
const fs = require('fs');
const PluginLoader = require('../core/plugin-loader');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const TEST_PLUGIN_PATH = path.join(PLUGINS_DIR, '_test_plugin.js');

afterEach(() => {
  // Clean up test plugin file if created
  try { fs.unlinkSync(TEST_PLUGIN_PATH); } catch {}
  // Clear require cache for test plugin (only if it exists)
  try {
    const resolved = require.resolve(TEST_PLUGIN_PATH);
    delete require.cache[resolved];
  } catch {}
});

describe('PluginLoader', () => {
  test('loads valid plugins from plugins/ directory', () => {
    const loader = new PluginLoader();
    const result = loader.load();
    // At minimum, example-plugin.js should be loaded
    expect(result.loaded).toBeGreaterThanOrEqual(1);
    expect(loader.has('example_hello')).toBe(true);
  });

  test('generates OpenAI tool definitions', () => {
    const loader = new PluginLoader();
    loader.load();
    const defs = loader.getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);

    const exampleDef = defs.find(d => d.function.name === 'example_hello');
    expect(exampleDef).toBeDefined();
    expect(exampleDef.type).toBe('function');
    expect(exampleDef.function.description).toContain('Example plugin');
  });

  test('executes a plugin', async () => {
    const loader = new PluginLoader();
    loader.load();
    const result = await loader.execute('example_hello', { name: 'TestUser' }, {
      config: { identity: { name: 'TestBot' } },
    });
    expect(result).toContain('Hello TestUser');
    expect(result).toContain('TestBot');
  });

  test('returns null for non-plugin tools', async () => {
    const loader = new PluginLoader();
    loader.load();
    const result = await loader.execute('nonexistent_tool', {}, {});
    expect(result).toBeNull();
  });

  test('rejects plugins without required fields', () => {
    // Write an invalid plugin
    fs.writeFileSync(TEST_PLUGIN_PATH, 'module.exports = { name: "bad" };');

    const loader = new PluginLoader();
    const result = loader.load();
    expect(loader.has('bad')).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('rejects duplicate plugin names', () => {
    // Write a plugin with same name as the example plugin
    const dupPath = path.join(PLUGINS_DIR, 'zzz_dup_test.js');
    try {
      fs.writeFileSync(dupPath, `module.exports = {
        name: 'example_hello',
        description: 'Duplicate',
        execute: async () => 'dup',
      };`);

      const loader = new PluginLoader();
      const result = loader.load();
      // The second file alphabetically gets flagged as duplicate
      expect(result.errors.some(e => e.includes('Duplicate') || e.includes('duplicate'))).toBe(true);
    } finally {
      try { fs.unlinkSync(dupPath); } catch {}
      try { delete require.cache[require.resolve(dupPath)]; } catch {}
    }
  });

  test('returns keyword map for tool-selector', () => {
    const loader = new PluginLoader();
    loader.load();
    const map = loader.getKeywordMap();
    expect(map.example_hello).toBeDefined();
    expect(Array.isArray(map.example_hello)).toBe(true);
  });

  test('returns trust levels', () => {
    const loader = new PluginLoader();
    loader.load();
    const levels = loader.getTrustLevels();
    expect(levels.example_hello).toBe('operator');
  });

  test('status() returns formatted summary', () => {
    const loader = new PluginLoader();
    loader.load();
    const status = loader.status();
    expect(status).toContain('plugin(s)');
    expect(status).toContain('example_hello');
  });
});
