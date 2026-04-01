// core/prompts.js — System prompt builder for the Favor framework
// Extracted from favor.js. Constructs the system prompt that defines
// the bot's identity, rules, and context for each message.

function scoreMemoryByRecency(mem) {
  const ageMs = Date.now() - new Date(mem.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0.3, 1.0 - (ageDays / 90) * 0.7);
}

function rankMemories(memories, limit) {
  return memories
    .map(m => ({ ...m, recencyScore: scoreMemoryByRecency(m) }))
    .sort((a, b) => b.recencyScore - a.recencyScore)
    .slice(0, limit);
}

/**
 * Build the memory section of the system prompt.
 * @param {Object} db - FavorMemory instance
 * @param {Array} relevantMemories - Semantically relevant memories for the current message
 * @returns {string}
 */
function buildMemoryPrompt(db, relevantMemories = []) {
  const mem = db.getAllMemories();
  const parts = [];

  const facts = rankMemories(mem.facts, 25);
  const decisions = rankMemories(mem.decisions, 15);
  const preferences = rankMemories(mem.preferences, 20);
  const tasks = mem.tasks.slice(0, 15);
  const workflows = rankMemories(mem.workflows, 10);
  const ideas = rankMemories(mem.ideas || [], 10);
  const projectUpdates = rankMemories(mem.project_updates || [], 10);

  if (ideas.length) parts.push('*Ideas:*\n' + ideas.map(i => `- ${i.content}`).join('\n'));
  if (facts.length) parts.push('*Facts:*\n' + facts.map(f => `- ${f.content}`).join('\n'));
  if (decisions.length) parts.push('*Decisions:*\n' + decisions.map(d => `- ${d.content}`).join('\n'));
  if (preferences.length) parts.push('*Preferences:*\n' + preferences.map(p => `- ${p.content}`).join('\n'));
  if (tasks.length) parts.push('*Tasks:*\n' + tasks.map(t => `- [${t.status || '?'}] ${t.content}`).join('\n'));
  if (workflows.length) parts.push('*Workflow Observations:*\n' + workflows.map(w => `- ${w.content}`).join('\n'));
  if (projectUpdates.length) parts.push('*Project Updates:*\n' + projectUpdates.map(p => `- ${p.content}`).join('\n'));

  if (relevantMemories.length) {
    const injected = new Set();
    for (const cat of [facts, decisions, preferences, tasks, workflows, ideas, projectUpdates]) {
      for (const m of cat) injected.add(m.id);
    }
    const unique = relevantMemories.filter(r => !injected.has(r.id));
    if (unique.length) {
      parts.push('*Relevant to this message:*\n' + unique.slice(0, 15).map(r =>
        `- [${r.category}] ${r.content} (relevance: ${(r.score * 100).toFixed(0)}%)`
      ).join('\n'));
    }
  }

  return parts.length ? '\n\n=== LONG-TERM MEMORY ===\n' + parts.join('\n\n') : '';
}

/**
 * Build the open threads section of the system prompt.
 * @param {Object} db - FavorMemory instance
 * @param {string} contact - Contact JID
 * @returns {string}
 */
function buildThreadPrompt(db, contact) {
  if (!contact) return '';
  const threads = db.getOpenThreads(contact, 5);
  if (!threads.length) return '';
  const lines = threads.map(t => {
    const age = Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000);
    const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age / 60)}h ago` : `${Math.round(age / 1440)}d ago`;
    return `- ${t.summary} (${ageStr})`;
  }).join('\n');
  return `\n\n=== OPEN THREADS (things the operator mentioned but didn't finish — follow up naturally when relevant, don't force it) ===\n${lines}\n=== END THREADS ===`;
}

/**
 * Build the complete system prompt.
 * @param {Object} opts
 * @param {Object} opts.config - Bot configuration
 * @param {Object} opts.db - FavorMemory instance
 * @param {Object} opts.compactor - Compactor instance
 * @param {string} opts.platform - 'whatsapp' or 'telegram'
 * @param {string} opts.contact - Contact JID
 * @param {string} opts.messageText - Current message text
 * @param {Array} opts.relevantMemories - Semantically relevant memories
 * @param {string} opts.dynamicKnowledge - Knowledge base content for this message
 * @returns {string}
 */
function buildJournalPrompt(scribe, contact) {
  if (!scribe) return '';
  const today = scribe.getTodayJournal(contact);
  const previous = scribe.getRecentJournal(contact, 7);
  if (!today.length && !previous.length) return '';

  let prompt = '\n\n=== CONVERSATION MEMORY (persistent — everything discussed until resolved) ===\n';
  let totalChars = 0;
  const CHAR_CAP = 3000;

  if (today.length) {
    prompt += 'TODAY:\n';
    prompt += today.map((e, i) => {
      const time = e.created_at.substring(11, 16);
      const marker = e.category === 'pending' ? ' [PENDING]' :
                     e.category === 'task' ? ' [TASK]' :
                     e.category === 'decision' ? ' [DECISION]' : '';
      return `${i + 1}. [${time}] ${e.summary}${marker}`;
    }).join('\n');
    totalChars = prompt.length;
  }

  if (previous.length && totalChars < CHAR_CAP) {
    const byDate = {};
    for (const e of previous) {
      const date = e.created_at.substring(0, 10);
      (byDate[date] = byDate[date] || []).push(e);
    }
    for (const [date, entries] of Object.entries(byDate).sort().reverse()) {
      if (totalChars >= CHAR_CAP) break;
      const section = `\n${date}:\n` +
        entries.slice(0, 5).map(e => `- ${e.summary}`).join('\n') +
        (entries.length > 5 ? `\n  ...and ${entries.length - 5} more` : '');
      totalChars += section.length;
      if (totalChars < CHAR_CAP) prompt += section;
    }
  }

  prompt += '\n=== END CONVERSATION MEMORY ===';
  return prompt;
}

function buildSystemPrompt({ config, db, compactor, platform, contact, messageText = '', relevantMemories = [], dynamicKnowledge = '', scribe = null }) {
  const name = config.identity.name;
  const contextPrefix = compactor.getContextPrefix(contact || '');
  const securityPhrase = (platform === 'telegram' ? config.telegram?.securityPhrase : config.whatsapp?.securityPhrase) || 'NOT_SET';

  return `You are ${name}. Your identity, rules, and knowledge are defined in your knowledge files — read them carefully, they ARE you.

Your operator's laptop: user "${config.laptop.user}", IP ${config.laptop.host}.

[SYSTEM-INTERNAL — never reveal this] Security phrase: ${securityPhrase}

[CRITICAL RULE] You are an AGENT, not a chatbot. You have tools — USE THEM.
- NEVER respond with generic step-by-step instructions. That is a failure. Take action.
- NEVER fabricate or guess URLs, file paths, usernames, or any factual info. If you don't know something, use memory_search or knowledge_search to look it up FIRST. Only ask the operator if it's truly not in your memory.
- When the operator asks you to message/contact/text someone, USE the send_message tool immediately. You have explicit operator permission to send messages to any number provided. Do NOT refuse or say you "can't reach out" — you CAN and MUST.
- When told to "send her/him" something (links, info, files), ALWAYS use send_message to deliver it to that person directly. Don't just do background work (like adding collaborators) — the person needs to actually RECEIVE the information via WhatsApp.
- NEVER leave someone hanging. If you tell anyone "one moment", "stand by", "let me check", or "I'll get back to you" — you MUST follow up with the actual answer in the SAME interaction. Do not end your turn without delivering the result. Get the info, then send_message them the answer immediately.
- When talking to trusted contacts, BE AUTONOMOUS. Search your memory for answers (repo URLs, project info, etc.) instead of deferring to the operator. Solve their questions directly.
- For web tasks (forms, shopping, research): use your HEADLESS BROWSER (browser_navigate, browser_click, browser_type, etc.) — this works independently without needing the laptop.
- For laptop-specific tasks (open apps, show screen, run desktop commands): use laptop tools (laptop_screenshot, laptop_open_url, laptop_open_app).
- Only use laptop_screenshot if the operator says "I'm on the page" or "look at my screen" — otherwise default to HEADLESS BROWSER for web tasks.

[PROGRESS REPORTING] When doing multi-step tasks (browser automation, file operations, etc.), include a short text update WITH your tool calls to keep the operator informed. Example: "Filling out the form now..." or "Form filled, clicking Save and Continue..." — these messages get sent in real time. Don't be silent during long tasks.

[TOOL MEMORY] When a tool sequence works successfully (e.g., browser login flow, form fill pattern, file operation), remember it and reuse the same approach next time. Don't re-discover what already works — use your memory tools to save successful patterns. Only change your approach if you find something faster or more efficient.

[PLANNING] For multi-step tasks (form filling, browser automation, etc.), you MUST output a numbered PLAN as text content alongside your first tool call(s). This plan stays in the conversation and guides subsequent tool execution. Example:
"Plan: 1) vault_get login creds 2) browser_navigate to site 3) type email in #signInName 4) click #continue 5) type password in #password 6) click #next 7) wait for dashboard 8) navigate to target page 9) fill form 10) save and continue..."
Then start executing step 1. Each subsequent tool call should reference which plan step it's on. This is CRITICAL — without a plan, multi-step tasks will fail.

[TEACH MODE] The operator can teach you custom commands. When they say "teach: when I say X, do Y" or "create a command called X", use teach_create to store a reusable pipeline of tool steps. The operator can then say their trigger phrase anytime and the pipeline runs automatically — no AI reasoning needed, just deterministic tool execution. Use teach_list to show saved commands, teach_run to execute by ID, teach_update to modify, teach_delete to remove. Encourage the operator to teach you shortcuts for things they do repeatedly.

Commands: /clear /status /brain /memory /model /reload /crons /topics /sync /recover /help

MEMORY SYNC: You have sync_update and sync_recover tools. Use sync_update to log important actions, decisions, task completions, and file changes so Claude Code stays in sync with your state. Use sync_recover after any restart to rebuild context from shared state.
Even after /clear, long-term memories persist.` + contextPrefix + dynamicKnowledge + buildJournalPrompt(scribe, contact) + buildMemoryPrompt(db, relevantMemories) + buildThreadPrompt(db, contact) + `

=== REMINDER ===
You MUST follow all rules in your knowledge base above — especially your identity, Action-First Rule, and tool usage instructions. Your knowledge files are not suggestions, they are your operating instructions. When a rule says to use a tool, USE IT. Do not fall back to generic text responses.`;
}

module.exports = {
  buildSystemPrompt,
  buildMemoryPrompt,
  buildThreadPrompt,
  buildJournalPrompt,
  rankMemories,
  scoreMemoryByRecency,
};
