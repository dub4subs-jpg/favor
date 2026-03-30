// claude-env.js — Shared env builder for Claude CLI subprocesses
// Uses Max subscription OAuth token (free) instead of paid API key
const fs = require('fs');

function claudeEnv() {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, PATH: `/root/.local/bin:${process.env.PATH}` })
      .filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC_REUSE') && k !== 'ANTHROPIC_API_KEY')
  );
  // CLI --print mode doesn't use OAuth natively — inject the OAuth token as API key
  try {
    const creds = JSON.parse(fs.readFileSync('/root/.claude/.credentials.json', 'utf8'));
    if (creds.claudeAiOauth?.accessToken) {
      env.ANTHROPIC_API_KEY = creds.claudeAiOauth.accessToken;
    }
  } catch (_) {}
  return env;
}

module.exports = claudeEnv;
