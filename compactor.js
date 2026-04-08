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
    // Token budget: compact when estimated tokens exceed this (default ~25k tokens)
    this.tokenBudget = opts.tokenBudget || 25000;
    // Create full_transcripts table on startup
    this._initTranscriptsTable();
  }

  // Create full_transcripts table for archiving original messages
  _initTranscriptsTable() {
    try {
      // db might be a FavorMemory wrapper — access underlying .db if needed
      const raw = this.db.db || this.db;
      if (typeof raw.exec === 'function') {
        raw.exec(`
          CREATE TABLE IF NOT EXISTS full_transcripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact TEXT NOT NULL,
            topic TEXT DEFAULT 'general',
            messages TEXT NOT NULL,
            compacted_at TEXT DEFAULT (datetime('now')),
            message_count INTEGER DEFAULT 0,
            token_estimate INTEGER DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_transcripts_contact ON full_transcripts(contact);
          CREATE INDEX IF NOT EXISTS idx_transcripts_date ON full_transcripts(compacted_at);
        `);
        console.log('[COMPACTOR] full_transcripts table ready');
      }
    } catch (e) {
      console.warn('[COMPACTOR] Failed to create full_transcripts table:', e.message);
    }
  }

  // Get raw sqlite db handle (handles FavorMemory wrapper)
  _rawDb() {
    return this.db.db || this.db;
  }

  // Estimate token count from messages (~4 chars per token)
  _estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      chars += c.length;
    }
    return Math.ceil(chars / 4);
  }

  // Check if a conversation needs compaction and do it
  async compactIfNeeded(contact, messages) {
    const estimatedTokens = this._estimateTokens(messages);
    const needsCompaction = messages.length > this.threshold || estimatedTokens > this.tokenBudget;
    if (!needsCompaction) return { compacted: false, messages };

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

      // ─── ARCHIVE ORIGINALS BEFORE COMPACTION ───
      try {
        const raw = this._rawDb();
        const topic = toCompact[0]?._tag || toCompact[0]?.topicTag || 'general';
        raw.prepare(
          `INSERT INTO full_transcripts (contact, topic, messages, message_count, token_estimate) VALUES (?, ?, ?, ?, ?)`
        ).run(
          contact,
          topic,
          JSON.stringify(toCompact),
          toCompact.length,
          this._estimateTokens(toCompact)
        );
        console.log(`[COMPACTOR] Archived ${toCompact.length} original messages for ${contact.substring(0, 15)}`);
      } catch (archiveErr) {
        console.warn(`[COMPACTOR] Failed to archive originals (non-fatal):`, archiveErr.message);
      }

      await this._extractFacts(toCompact, contact);
      this.db.saveCompactionSummary(contact, summary, toCompact.length);
      this.db.audit('compaction', `contact=${contact.substring(0, 15)} msgs=${toCompact.length}`);

      // Audit trail: log compaction event + preserve compacted messages
      try {
        this.db.logEvent(contact, 'compaction', summary, {
          metadata: {
            messagesCompacted: toCompact.length,
            messagesKept: toKeep.length,
            tokensBeforeEst: this._estimateTokens(messages),
            tokensAfterEst: this._estimateTokens([...toKeep])
          }
        });
        for (const msg of toCompact) {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          this.db.logEvent(contact, 'compacted_message', content, { role: msg.role });
        }
      } catch (_) {}

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
      // IMPORTANT: Don't drop old messages without a summary — return the full history
      // so we can try again next time rather than silently losing context
      return { compacted: false, messages };
    }
  }

  async _summarize(messages) {
    // Group messages by topic tag for structured summarization
    const tagGroups = {};
    for (const m of messages) {
      const tag = m._tag || 'general';
      if (!tagGroups[tag]) tagGroups[tag] = [];
      tagGroups[tag].push(m);
    }

    const formatMsg = (m) => {
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
    };

    // Build topic-grouped transcript
    const hasMultipleTopics = Object.keys(tagGroups).length > 1;
    let transcript;
    if (hasMultipleTopics) {
      transcript = Object.entries(tagGroups).map(([tag, msgs]) => {
        const lines = msgs.map(formatMsg).filter(Boolean).join('\n');
        return `[Topic: ${tag} (${msgs.length} messages)]\n${lines}`;
      }).join('\n\n');
    } else {
      transcript = messages.map(formatMsg).filter(Boolean).join('\n');
    }

    const prompt = `You are compressing a conversation into a reference document. The AI will read this summary to continue the conversation seamlessly — it MUST contain enough detail to avoid asking the user to repeat themselves.

RULES:
- Preserve ALL specific names, numbers, file paths, URLs, prices, dates, and technical details
- Keep direct quotes of decisions or commitments ("decided to X", "agreed on Y")
- Record the current state of any ongoing task (what's done vs what's pending)
- Use bullet points, not prose — density over narrative
- If the user asked a question that was answered, record BOTH the question and answer
- If the user asked something NOT YET answered, mark it: [PENDING: question]

Format:${hasMultipleTopics ? ' Group by topic tags.\n' : ''}
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

  async _extractFacts(messages, contact = null) {
    try {
      const transcript = messages.map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.map(c => c.text || '').filter(Boolean).join(' ');
        return '';
      }).filter(Boolean).join('\n').substring(0, 4000);

      if (transcript.length < 50) return;

      const factPrompt = `Extract concrete, reusable knowledge from this conversation before it gets summarized. Return JSON with categorized items:
{"facts": ["specific name/date/price/detail"], "decisions": ["what was decided and why"], "promises": ["commitments made to someone"]}

CRITICAL: Summarize what HAPPENED and what the RESULT was, not what was asked for. If a task was completed, say it was completed. If it failed, say it failed. If it's still pending, say it's pending with the reason.
- BAD: "Invoice 102: Generate and send to jerry@example.com"
- GOOD: "Invoice 102: Sent successfully to jerry@example.com on March 31"
- BAD: "Look up flight prices to destination"
- GOOD: "Flight prices checked — cheapest was $342 on Copa Airlines for April 15"

Rules:
- Include: names, dates, prices, decisions, preferences, contact info, deadlines, commitments
- Always record the OUTCOME — was it done, sent, failed, or still pending?
- Skip: greetings, small talk, tool call details, generic statements
- Each item max 200 chars, max 5 items per category
- Return {"facts":[],"decisions":[],"promises":[]} if nothing worth saving
- Respond ONLY with valid JSON, no other text

${transcript}`;

      let raw = (await runClaudeHaiku(factPrompt)) || '{"facts":[],"decisions":[],"promises":[]}';
      // Strip markdown code fences that Claude sometimes wraps around JSON
      raw = raw.replace(/^\`\`\`(?:json)?\s*\n?/i, '').replace(/\n?\`\`\`\s*$/i, '').trim();
      const parsed = JSON.parse(raw);
      let savedCount = 0;

      // Save facts (scoped to contact to prevent cross-contact leakage)
      for (const fact of (parsed.facts || []).slice(0, 5)) {
        if (typeof fact === 'string' && fact.length > 5) {
          this.db.save('fact', `[pre-compact] ${fact}`, null, null, contact);
          savedCount++;
        }
      }
      // Save decisions (these are high-value — often lost in compaction)
      for (const dec of (parsed.decisions || []).slice(0, 5)) {
        if (typeof dec === 'string' && dec.length > 5) {
          this.db.save('decision', `[pre-compact] ${dec}`, null, null, contact);
          savedCount++;
        }
      }
      // Save promises/commitments (critical — user will expect follow-through)
      for (const promise of (parsed.promises || []).slice(0, 3)) {
        if (typeof promise === 'string' && promise.length > 5) {
          this.db.save('task', `[pre-compact] ${promise}`, 'pending', null, contact);
          savedCount++;
        }
      }
      if (savedCount > 0) console.log(`[COMPACT] Extracted ${savedCount} items (facts/decisions/promises) before compaction`);
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
      // Safety: if >4 today, condense oldest ones
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

  // ─── RECALL ORIGINAL TRANSCRIPTS ───
  // Retrieve archived original messages (before compaction destroyed them)
  recallTranscript(contact, query, limit = 5) {
    try {
      const raw = this._rawDb();
      const rows = raw.prepare(
        `SELECT messages, compacted_at, topic, message_count FROM full_transcripts WHERE contact = ? ORDER BY compacted_at DESC LIMIT ?`
      ).all(contact, limit);

      if (!rows.length) return [];

      if (!query) {
        return rows.map(r => ({
          messages: JSON.parse(r.messages),
          date: r.compacted_at,
          topic: r.topic,
          messageCount: r.message_count
        }));
      }

      // Keyword search through archived messages
      const queryLower = query.toLowerCase();
      return rows
        .map(r => {
          const messages = JSON.parse(r.messages);
          const matches = messages.filter(m => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return content.toLowerCase().includes(queryLower);
          });
          return matches.length ? {
            messages: matches,
            date: r.compacted_at,
            topic: r.topic,
            matchCount: matches.length
          } : null;
        })
        .filter(Boolean);
    } catch (e) {
      console.warn('[COMPACTOR] recallTranscript failed:', e.message);
      return [];
    }
  }

  // ─── CLEANUP OLD TRANSCRIPTS ───
  // Auto-delete transcript archives older than N days (default 90)
  cleanOldTranscripts(days = 90) {
    try {
      const raw = this._rawDb();
      const result = raw.prepare(
        `DELETE FROM full_transcripts WHERE compacted_at < datetime('now', '-' || ? || ' days')`
      ).run(days);
      if (result.changes) console.log(`[COMPACTOR] Cleaned ${result.changes} old transcript archives (>${days} days)`);
      return result.changes;
    } catch (e) {
      console.warn('[COMPACTOR] cleanOldTranscripts failed:', e.message);
      return 0;
    }
  }
}

module.exports = Compactor;
