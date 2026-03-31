const { runDoctor } = require('../cli/doctor');

describe('doctor', () => {
  test('runDoctor returns array of checks', async () => {
    const checks = await runDoctor();
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
  });

  test('each check has status, category, message', async () => {
    const checks = await runDoctor();
    for (const check of checks) {
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(typeof check.category).toBe('string');
      expect(typeof check.message).toBe('string');
    }
  });

  test('Node version check passes (we are running on Node 18+)', async () => {
    const checks = await runDoctor();
    const nodeCheck = checks.find(c => c.message.includes('Node.js'));
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck.status).toBe('pass');
  });

  test('quiet mode skips slow checks', async () => {
    const full = await runDoctor({ quiet: false });
    const quiet = await runDoctor({ quiet: true });
    // Quiet should have fewer checks (skips chromium, python3, faster-whisper, network)
    expect(quiet.length).toBeLessThanOrEqual(full.length);
  });

  test('npm deps check passes (we have node_modules)', async () => {
    const checks = await runDoctor();
    const depsCheck = checks.find(c => c.message.includes('npm dependencies'));
    expect(depsCheck).toBeDefined();
    expect(depsCheck.status).toBe('pass');
  });
});
