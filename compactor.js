// ─── FAVOR SMART COMPACTION ───
// Instead of just dropping old messages, summarizes them into context blocks
// so the bot never truly forgets a conversation

const { runCLI, isAvailable } = require('./utils/claude');

function runClaudeHaiku(prompt, timeoutMs = 30000) {
  if (!isAvailable()) return Promise.reject(new Error('Claude Code CLI not installed'));
  return runCLI(prompt, { model: 'haiku', timeout: timeoutMs });
}

class Compactor {
  constructor(db, opts = {}) {
    this.db = db;
    this.threshold = opts.threshold || 30;
    this.keepRecent = opts.keepRecent || 12;
    this.summaryTokens = opts.summaryTokens || 512;
  }

  // Check if a conversation needs compaction and do it
  async compactIfNeeded(contact, messages) {
    if (messages.length <= this.threshold) return { compacted: false, messages };

    // Find a safe split point that doesn't break tool_use/tool_result pairs
    let splitAt = messages.length - this.keepRecent;
    while (splitAt > 0 && splitAt < messages.length) {
      const msg = messages[splitAt];
      if (msg.role === 'user' && Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result') {
        splitAt--;
      } else if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_use')) {
        splitAt--;
      } else {
        break;
      }
    }
    const toCompact = messages.slice(0, splitAt);
    const toKeep = messages.slice(splitAt);

    console.log(`[COMPACT] Compacting ${toCompact.length} messages for ${contact.substring(0, 15)}...`);

    try {
      const summary = await this._summarize(toCompact);

      // Safety: reject summaries that lack real content
      const trimmed = (summary || '').trim();
      const contentLines = trimmed.split('\n').filter(l => /[a-zA-Z]{3,}/.test(l));
      if (!trimmed || contentLines.length < 2) {
        console.warn(`[COMPACT] Summary lacks real content (${contentLines.length} content lines, ${trimmed.length} chars) — keeping original messages`);
        return { compacted: false, messages };
      }

      await this._extractFacts(toCompact);
      this.db.saveCompactionSummary(contact, summary, toCompact.length);
      this.db.audit('compaction', `contact=${contact.substring(0, 15)} msgs=${toCompact.length}`);

      const summaryMessage = {
        role: 'user',
        content: `[CONVERSATION CONTEXT — summarized from ${toCompact.length} earlier messages]\n${summary}\n[END CONTEXT — conversation continues below]`
      };
      const assistantAck = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood, I have the context from our earlier conversation.' }]
      };

      const compactedHistory = [summaryMessage, assistantAck, ...toKeep];
      console.log(`[COMPACT] Done. ${messages.length} -> ${compactedHistory.length} messages`);

      return { compacted: true, messages: compactedHistory, summary };
    } catch (err) {
      console.error('[COMPACT] Summarization failed:', err.message);
      return { compacted: false, messages: toKeep };
    }
  }

  async _summarize(messages) {
    const transcript = messages.map(m => {
      if (m.role === 'user') {
        if (typeof m.content === 'string') return `User: ${m.content}`;
        if (Array.isArray(m.content)) {
          return m.content.map(c => {
            if (c.type === 'tool_result') return `[Tool Result: ${c.content?.substring(0, 200) || ''}]`;
            return `User: ${c.text || ''}`;
          }).join('\n');
        }
      }
      if (m.role === 'assistant') {
        if (typeof m.content === 'string') return `Assistant: ${m.content}`;
        if (Array.isArray(m.content)) {
          return m.content.map(c => {
            if (c.type === 'text') return `Assistant: ${c.text}`;
            if (c.type === 'tool_use') return `[Used tool: ${c.name}]`;
            return '';
          }).filter(Boolean).join('\n');
        }
      }
      return '';
    }).filter(Boolean).join('\n');

    const prompt = `You are compressing a conversation into a reference document. The AI will read this summary to continue the conversation seamlessly — it MUST contain enough detail to avoid asking the user to repeat themselves.

RULES:
- Preserve ALL specific names, numbers, file paths, URLs, prices, dates, and technical details
- Keep direct quotes of decisions or commitments ("decided to X", "agreed on Y")
- Record the current state of any ongoing task (what's done vs what's pending)
- Use bullet points, not prose — density over narrative
- If the user asked a question that was answered, record BOTH the question and answer
- If the user asked something NOT YET answered, mark it: [PENDING: question]

Format:
## Topics
- topic: specific details...

## Decisions & Commitments
- decided/agreed: specifics...

## Current State (in-progress work)
- task: status...

## Key Details (names, numbers, paths, prices)
- detail...

Compress this conversation:

${transcript.substring(0, 8000)}`;

    const result = await runClaudeHaiku(prompt);
    return result || '';
  }

  async _extractFacts(messages) {
    try {
      const transcript = messages.map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.map(c => c.text || '').filter(Boolean).join(' ');
        return '';
      }).filter(Boolean).join('\n').substring(0, 4000);

      if (transcript.length < 50) return;

      const factPrompt = `Extract ONLY concrete, reusable facts from this conversation. Return JSON: {"facts": ["fact1", "fact2", ...]}. Include: names, dates, prices, decisions, preferences, contact info, project details, deadlines. Skip: greetings, small talk, tool call details, generic statements. Return {"facts": []} if nothing worth saving. MAX 5 items. Respond ONLY with valid JSON, no other text.

Extract key facts:

${transcript}`;

      const raw = (await runClaudeHaiku(factPrompt)) || '{"facts":[]}';
      const facts = JSON.parse(raw).facts || [];

      if (Array.isArray(facts)) {
        for (const fact of facts.slice(0, 5)) {
          if (typeof fact === 'string' && fact.length > 5) {
            this.db.save('fact', `[auto-extracted] ${fact}`, null);
          }
        }
        if (facts.length > 0) console.log(`[COMPACT] Extracted ${facts.length} facts before compaction`);
      }
    } catch (e) {
      console.warn('[COMPACT] Fact extraction failed (non-fatal):', e.message);
    }
  }

  getContextPrefix(contact) {
    // Tier 1: ALL of today's summaries (never lose same-day context)
    const todaySummaries = this.db.getTodayCompactionSummaries(contact);

    // Tier 2: Last 2 from previous days (multi-day continuity)
    const olderSummaries = this.db.getCompactionSummaries(contact, 2)
      .filter(s => !todaySummaries.some(t => t.id === s.id))
      .reverse();

    if (!todaySummaries.length && !olderSummaries.length) return '';

    let prefix = '\n\n=== PREVIOUS CONVERSATION CONTEXT ===\n';

    if (todaySummaries.length) {
      if (todaySummaries.length > 4) {
        const recent = todaySummaries.slice(-2);
        const older = todaySummaries.slice(0, -2);
        const condensed = older.map(s => s.summary).join('\n').substring(0, 1500);
        prefix += `[Earlier today — ${older.reduce((sum, s) => sum + s.message_count, 0)} messages condensed]\n${condensed}\n\n`;
        for (const s of recent) {
          const time = s.created_at.substring(11, 16);
          prefix += `[${time} — ${s.message_count} messages]\n${s.summary}\n\n`;
        }
      } else {
        for (const s of todaySummaries) {
          const time = s.created_at.substring(11, 16);
          prefix += `[${time} — ${s.message_count} messages]\n${s.summary}\n\n`;
        }
      }
    }

    if (olderSummaries.length) {
      prefix += '--- Earlier Days ---\n';
      for (const s of olderSummaries) {
        prefix += `[${s.created_at.substring(0, 10)} — ${s.message_count} messages]\n${s.summary}\n\n`;
      }
    }

    prefix += '=== END PREVIOUS CONTEXT ===';
    return prefix;
  }
}

module.exports = Compactor;
