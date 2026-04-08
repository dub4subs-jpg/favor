const EventEmitter = require('events');
const registry = require('../process-registry');

function mockProc(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  return proc;
}

afterEach(() => {
  // The module is a singleton — clean up all entries between tests
  for (const entry of registry.getAll()) {
    registry.unregister(entry.pid);
  }
});

describe('process-registry', () => {
  describe('register()', () => {
    test('registers a process with all fields', () => {
      const proc = mockProc(1001);
      const entry = registry.register(proc, {
        source: 'router',
        purpose: 'classify message',
        timeoutMs: 60000,
        model: 'sonnet',
      });

      expect(entry).toBeDefined();
      expect(entry.pid).toBe(1001);
      expect(entry.source).toBe('router');
      expect(entry.purpose).toBe('classify message');
      expect(entry.timeoutMs).toBe(60000);
      expect(entry.model).toBe('sonnet');
      expect(entry.startedAt).toBeLessThanOrEqual(Date.now());
    });

    test('uses defaults when options are omitted', () => {
      const proc = mockProc(2001);
      const entry = registry.register(proc);

      expect(entry.source).toBe('unknown');
      expect(entry.purpose).toBe('');
      expect(entry.timeoutMs).toBe(120000);
      expect(entry.model).toBe('');
    });

    test('truncates purpose to 120 characters', () => {
      const proc = mockProc(3001);
      const longPurpose = 'a'.repeat(200);
      const entry = registry.register(proc, { purpose: longPurpose });

      expect(entry.purpose).toHaveLength(120);
    });

    test('returns undefined for null or pid-less proc', () => {
      expect(registry.register(null)).toBeUndefined();
      expect(registry.register({})).toBeUndefined();
      expect(registry.register({ pid: 0 })).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    test('returns empty array when no processes registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    test('returns all registered processes', () => {
      registry.register(mockProc(100), { source: 'a' });
      registry.register(mockProc(200), { source: 'b' });
      registry.register(mockProc(300), { source: 'c' });

      const all = registry.getAll();
      expect(all).toHaveLength(3);

      const pids = all.map((e) => e.pid);
      expect(pids).toContain(100);
      expect(pids).toContain(200);
      expect(pids).toContain(300);
    });

    test('each entry includes pid at top level', () => {
      registry.register(mockProc(400), { source: 'test' });
      const [entry] = registry.getAll();
      expect(entry.pid).toBe(400);
      expect(entry.source).toBe('test');
    });
  });

  describe('count()', () => {
    test('returns 0 when empty', () => {
      expect(registry.count()).toBe(0);
    });

    test('returns correct count after registrations', () => {
      registry.register(mockProc(10));
      registry.register(mockProc(20));
      expect(registry.count()).toBe(2);
    });

    test('decrements after unregister', () => {
      registry.register(mockProc(10));
      registry.register(mockProc(20));
      registry.unregister(10);
      expect(registry.count()).toBe(1);
    });
  });

  describe('has() / get()', () => {
    test('has() returns true for registered pid', () => {
      registry.register(mockProc(5000));
      expect(registry.has(5000)).toBe(true);
    });

    test('has() returns false for unregistered pid', () => {
      expect(registry.has(9999)).toBe(false);
    });

    test('get() returns entry for registered pid', () => {
      registry.register(mockProc(6000), { source: 'compactor', model: 'haiku' });
      const entry = registry.get(6000);
      expect(entry).toBeDefined();
      expect(entry.pid).toBe(6000);
      expect(entry.source).toBe('compactor');
      expect(entry.model).toBe('haiku');
    });

    test('get() returns undefined for unregistered pid', () => {
      expect(registry.get(9999)).toBeUndefined();
    });
  });

  describe('unregister()', () => {
    test('removes a registered entry and returns true', () => {
      registry.register(mockProc(7000));
      expect(registry.has(7000)).toBe(true);
      expect(registry.unregister(7000)).toBe(true);
      expect(registry.has(7000)).toBe(false);
    });

    test('returns false for non-existent pid', () => {
      expect(registry.unregister(8888)).toBe(false);
    });
  });

  describe('auto-cleanup on process close', () => {
    test('entry is removed when proc emits close', () => {
      const proc = mockProc(4001);
      registry.register(proc, { source: 'tool-runner' });
      expect(registry.has(4001)).toBe(true);

      proc.emit('close', 0);
      expect(registry.has(4001)).toBe(false);
      expect(registry.count()).toBe(0);
    });
  });

  describe('auto-cleanup on process error', () => {
    test('entry is removed when proc emits error', () => {
      const proc = mockProc(4002);
      registry.register(proc, { source: 'alive' });
      expect(registry.has(4002)).toBe(true);

      proc.emit('error', new Error('spawn failed'));
      expect(registry.has(4002)).toBe(false);
      expect(registry.count()).toBe(0);
    });
  });
});
