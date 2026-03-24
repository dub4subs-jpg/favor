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

    const prompt = `You are summarizing a conversation between an AI companion and its operator. Extract:
1. Key topics discussed
2. Decisions made
3. Tasks mentioned or assigned
4. Important facts shared
5. Emotional tone / relationship context

Be concise but preserve anything the AI would need to continue the conversation naturally. Write in third person past tense.

Summarize this conversation:

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
    const summaries = this.db.getCompactionSummaries(contact, 3);
    if (!summaries.length) return '';
    return '\n\n=== PREVIOUS CONVERSATION CONTEXT ===\n' +
      summaries.reverse().map((s, i) => `[Session ${i + 1} — ${s.message_count} messages, ${s.created_at}]\n${s.summary}`).join('\n\n') +
      '\n=== END PREVIOUS CONTEXT ===';
  }
}

module.exports = Compactor;
