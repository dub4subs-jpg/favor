const { psSafeString, psEncodedCommand, safePowerShell } = require('../utils/shell');

describe('psSafeString', () => {
  test('wraps in single quotes', () => {
    expect(psSafeString('hello')).toBe("'hello'");
  });

  test('escapes embedded single quotes', () => {
    expect(psSafeString("it's")).toBe("'it''s'");
  });

  test('handles paths with spaces', () => {
    expect(psSafeString('C:\\Program Files\\App')).toBe("'C:\\Program Files\\App'");
  });

  test('handles empty string', () => {
    expect(psSafeString('')).toBe("''");
  });

  test('neutralizes shell metacharacters', () => {
    // These should be safely wrapped, not interpreted
    const dangerous = 'test; rm -rf /; echo pwned';
    const result = psSafeString(dangerous);
    expect(result).toBe("'test; rm -rf /; echo pwned'");
  });

  test('handles backticks (PowerShell escape char)', () => {
    const result = psSafeString('`whoami`');
    expect(result).toBe("'`whoami`'");
  });
});

describe('psEncodedCommand', () => {
  test('produces base64 string', () => {
    const result = psEncodedCommand('Write-Output "hello"');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => Buffer.from(result, 'base64')).not.toThrow();
  });

  test('encodes as UTF-16LE (PowerShell requirement)', () => {
    const encoded = psEncodedCommand('echo hi');
    const decoded = Buffer.from(encoded, 'base64');
    // UTF-16LE has null bytes between ASCII chars
    expect(decoded[1]).toBe(0); // 'e' followed by 0x00
  });
});

describe('safePowerShell', () => {
  test('produces powershell -NoProfile -EncodedCommand ...', () => {
    const result = safePowerShell('Get-Date');
    expect(result).toMatch(/^powershell -NoProfile -EncodedCommand /);
  });

  test('does not contain the raw command text', () => {
    const cmd = 'Remove-Item C:\\important -Force';
    const result = safePowerShell(cmd);
    expect(result).not.toContain('Remove-Item');
    expect(result).not.toContain('important');
  });
});
