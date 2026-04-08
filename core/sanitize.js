// sanitize.js — Extracted from favor.js
// History sanitization (tool call/result pairing)
// NOTE: This is the HISTORY sanitizer (fixes broken tool call sequences).
// The INPUT sanitizer (stripInjectionPatterns) lives in ./utils/sanitize.js

/**
 * Sanitize conversation history to ensure tool_calls and tool results are properly paired.
 * - Injects synthetic results for missing tool responses
 * - Drops orphaned tool results with no preceding assistant tool_calls
 * - Strips leading assistant messages (history must start with user)
 *
 * @param {Array} messages - Raw message history array
 * @returns {Array} Cleaned message array
 */
function sanitizeHistory(messages) {
  const clean = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Collect all consecutive tool result messages that follow
      const toolMsgs = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        toolMsgs.push(messages[j]);
        j++;
      }
      const foundIds = new Set(toolMsgs.map(m => m.tool_call_id));
      const missing = msg.tool_calls.filter(tc => !foundIds.has(tc.id));

      clean.push(msg);
      // Push each tool_call's result — existing if found, synthetic if missing
      for (const tc of msg.tool_calls) {
        const existing = toolMsgs.find(m => m.tool_call_id === tc.id);
        if (existing) {
          clean.push(existing);
        } else {
          console.log(`[SANITIZE] Injecting synthetic result for tool_call ${tc.id}`);
          clean.push({ role: 'tool', tool_call_id: tc.id, content: '[Result was not recorded. The tool may have succeeded or failed. If the user needs this information, offer to re-run the tool.]' });
        }
      }
      if (missing.length) console.log(`[SANITIZE] Fixed ${missing.length} missing tool result(s)`);
      i = j; // skip past all tool messages we already handled
    } else if (msg.role === 'tool') {
      // Orphaned tool result with no preceding assistant tool_calls
      console.log('[SANITIZE] Dropping orphaned tool result at index ' + i);
      i++;
    } else {
      clean.push(msg);
      i++;
    }
  }
  while (clean.length > 0 && clean[0].role === 'assistant') clean.shift();
  return clean;
}

module.exports = { sanitizeHistory };
