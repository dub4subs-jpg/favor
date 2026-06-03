// claude-env.js — Shared env builder for Claude CLI subprocesses
// Uses Max/Pro subscription OAuth (free) read natively from /root/.claude/.credentials.json by the CLI.
// IMPORTANT: do NOT set ANTHROPIC_API_KEY from the OAuth token — as of CLI v2.1.143 the
// server rejects sk-ant-oat* tokens when presented via the API-key path ("Invalid API key").
// The CLI loads OAuth from disk on its own when ANTHROPIC_API_KEY is absent.

function claudeEnv() {
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: `/root/.local/bin:${process.env.PATH}` })
      .filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC_REUSE') && k !== 'ANTHROPIC_API_KEY')
  );
}

module.exports = claudeEnv;
