// history-builder.js — Extracted from favor.js
// Reusable history text builder (was duplicated 6+ times in favor.js)

/**
 * Build a human-readable text representation of conversation history.
 * Replaces the duplicated .slice(-N).map(...) pattern used throughout favor.js.
 *
 * @param {Array} history - The messages array from session/topic
 * @param {number} sliceSize - How many recent messages to include (default 25)
 * @returns {string} Formatted history text
 */
function buildHistoryText(history, sliceSize = 25) {
  return history.slice(-sliceSize).map((m, idx, arr) => {
    if (m.role === 'tool') {
      const parentCall = arr.slice(0, idx).reverse().find(p => p.tool_calls?.some(tc => tc.id === m.tool_call_id));
      const toolName = parentCall?.tool_calls?.find(tc => tc.id === m.tool_call_id)?.function?.name || 'unknown';
      const resultPreview = typeof m.content === 'string' ? m.content.slice(0, 200) : '';
      if (!resultPreview) return null;
      return `[Tool Result - ${toolName}]: ${resultPreview}`;
    }
    if (m.tool_calls?.length) {
      const callSummaries = m.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ');
      const content = typeof m.content === 'string' ? m.content : m.content?.map(c => c.text || '').join(' ') || '';
      return `Assistant: ${content ? content + ' ' : ''}[Used tools: ${callSummaries}]`;
    }
    const content = typeof m.content === 'string' ? m.content : m.content?.map(c => c.text || '').join(' ') || '';
    if (!content) return null;
    return `${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`;
  }).filter(Boolean).join('\n\n');
}

/**
 * Wrap history text in conversation delimiters.
 * @param {string} historyText - Output from buildHistoryText
 * @returns {string} Wrapped history or empty string
 */
function wrapHistory(historyText) {
  if (!historyText) return '';
  return `=== RECENT CONVERSATION ===\n${historyText}\n=== END CONVERSATION ===`;
}

module.exports = { buildHistoryText, wrapHistory };
