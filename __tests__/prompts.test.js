const { buildSystemPrompt, buildMemoryPrompt, buildThreadPrompt, scoreMemoryByRecency } = require('../core/prompts');

// Mock db that returns controlled data
function mockDb(overrides = {}) {
  return {
    getAllMemories: () => ({
      facts: overrides.facts || [],
      decisions: overrides.decisions || [],
      preferences: overrides.preferences || [],
      tasks: overrides.tasks || [],
      workflows: overrides.workflows || [],
    }),
    getOpenThreads: () => overrides.threads || [],
  };
}

function mockCompactor() {
  return { getContextPrefix: () => '' };
}

describe('scoreMemoryByRecency', () => {
  test('recent memory scores close to 1.0', () => {
    const now = new Date().toISOString();
    expect(scoreMemoryByRecency({ created_at: now })).toBeGreaterThan(0.9);
  });

  test('old memory scores close to 0.3', () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    expect(scoreMemoryByRecency({ created_at: old })).toBeCloseTo(0.3, 1);
  });
});

describe('buildMemoryPrompt', () => {
  test('returns empty string with no memories', () => {
    const result = buildMemoryPrompt(mockDb(), []);
    expect(result).toBe('');
  });

  test('includes facts section', () => {
    const db = mockDb({ facts: [{ id: 1, content: 'User likes coffee', created_at: new Date().toISOString() }] });
    const result = buildMemoryPrompt(db, []);
    expect(result).toContain('LONG-TERM MEMORY');
    expect(result).toContain('User likes coffee');
  });

  test('deduplicates relevant memories against category memories', () => {
    const mem = { id: 1, content: 'Test fact', created_at: new Date().toISOString() };
    const db = mockDb({ facts: [mem] });
    // Same memory appears in both categories and relevant
    const result = buildMemoryPrompt(db, [{ ...mem, category: 'fact', score: 0.9 }]);
    // Should only appear once (in facts, not in relevant)
    const matches = result.match(/Test fact/g);
    expect(matches.length).toBe(1);
  });
});

describe('buildThreadPrompt', () => {
  test('returns empty with no threads', () => {
    expect(buildThreadPrompt(mockDb(), 'contact123')).toBe('');
  });

  test('returns empty with null contact', () => {
    expect(buildThreadPrompt(mockDb(), null)).toBe('');
  });

  test('includes thread summaries', () => {
    const db = mockDb({
      threads: [{ summary: 'Fix the login bug', created_at: new Date().toISOString() }],
    });
    const result = buildThreadPrompt(db, 'contact123');
    expect(result).toContain('OPEN THREADS');
    expect(result).toContain('Fix the login bug');
  });
});

describe('buildSystemPrompt', () => {
  test('includes bot name from config', () => {
    const result = buildSystemPrompt({
      config: { identity: { name: 'TestBot' }, laptop: { user: 'user', host: '1.2.3.4' }, whatsapp: {} },
      db: mockDb(),
      compactor: mockCompactor(),
      platform: 'whatsapp',
      contact: 'test@s.whatsapp.net',
    });
    expect(result).toContain('You are TestBot');
  });

  test('includes critical rules', () => {
    const result = buildSystemPrompt({
      config: { identity: { name: 'Bot' }, laptop: { user: 'u', host: 'h' }, whatsapp: {} },
      db: mockDb(),
      compactor: mockCompactor(),
      platform: 'whatsapp',
      contact: 'test',
    });
    expect(result).toContain('AGENT, not a chatbot');
    expect(result).toContain('NEVER fabricate');
    expect(result).toContain('PLANNING');
  });

  test('includes dynamic knowledge when provided', () => {
    const result = buildSystemPrompt({
      config: { identity: { name: 'Bot' }, laptop: { user: 'u', host: 'h' }, telegram: {} },
      db: mockDb(),
      compactor: mockCompactor(),
      platform: 'telegram',
      contact: 'test',
      dynamicKnowledge: '\n\n=== KNOWLEDGE ===\nCustom knowledge here\n=== END ===',
    });
    expect(result).toContain('Custom knowledge here');
  });
});
