const { TOOLS, oaiTool } = require('../core/tool-definitions');

describe('Tool Definitions', () => {
  test('TOOLS is a non-empty array', () => {
    expect(Array.isArray(TOOLS)).toBe(true);
    expect(TOOLS.length).toBeGreaterThan(30);
  });

  test('all tools have required OpenAI format', () => {
    for (const tool of TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.function).toBeDefined();
      expect(typeof tool.function.name).toBe('string');
      expect(tool.function.name.length).toBeGreaterThan(0);
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters).toBeDefined();
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  test('no duplicate tool names', () => {
    const names = TOOLS.map(t => t.function.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('critical tools are present', () => {
    const names = new Set(TOOLS.map(t => t.function.name));
    const required = [
      'laptop_screenshot', 'laptop_open_app', 'laptop_open_url',
      'memory_save', 'memory_search', 'web_search',
      'vault_save', 'vault_get', 'vault_list',
      'browser_navigate', 'browser_screenshot', 'browser_click',
      'video_analyze', 'cron_create', 'cron_list',
      'send_message', 'send_email', 'server_exec',
      'guardian_scan', 'build_plan', 'selfcheck',
    ];
    for (const name of required) {
      expect(names.has(name)).toBe(true);
    }
  });

  test('oaiTool helper creates correct format', () => {
    const tool = oaiTool('test_tool', 'A test tool', {
      type: 'object',
      properties: { arg1: { type: 'string' } },
      required: ['arg1'],
    });
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('test_tool');
    expect(tool.function.description).toBe('A test tool');
    expect(tool.function.parameters.required).toEqual(['arg1']);
  });
});
