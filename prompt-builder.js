// prompt-builder.js — Extracted prompt building functions
// These are loaded by favor.js and called with dependencies injected at init time.
// Keeps all prompt construction logic in one place for easier testing and modification.

let _deps = {};

// Initialize with dependencies from favor.js
function init(deps) {
  _deps = deps;
}

function _checkInit() {
  if (!_deps.db) throw new Error('prompt-builder not initialized — call init() first');
}

function buildDirectivesPrompt() {
  _checkInit();
  const directives = _deps.db.getDirectives();
  if (!directives.length) return '';
  const MAX_DIRECTIVES = 30;
  const MAX_CHARS = 4000;
  const lines = [];
  let totalChars = 0;
  for (const d of directives.slice(0, MAX_DIRECTIVES)) {
    const line = `- ${d.rule}${d.context ? ` (${d.context})` : ''}`;
    if (totalChars + line.length > MAX_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }
  if (!lines.length) return '';
  return '\n\n=== STANDING DIRECTIVES (permanent operator rules — ALWAYS obey these) ===\n' +
    'These are direct orders from your operator. They override preferences and default behavior. Never ignore, reinterpret, or work around them.\n' +
    lines.join('\n');
}

function buildEntityPrompt() {
  _checkInit();
  const entities = _deps.db.getRecentEntities(14, 8);
  if (!entities.length) return '';
  const lines = [];
  for (const e of entities) {
    const rels = _deps.db.getEntityRelationships(e.id).slice(0, 3);
    const relStr = rels.map(r => {
      const other = r.entity_a === e.id ? r.to_name : r.from_name;
      return `${r.relationship} ${other}`;
    }).join(', ');
    lines.push(`- ${e.name} (${e.type})${relStr ? ' → ' + relStr : ''}`);
  }
  return '\n\n=== KNOWN ENTITIES (people/companies/projects you interact with) ===\n' +
    lines.join('\n') + '\n=== END ENTITIES ===';
}

function buildRecipesPrompt(contact) {
  _checkInit();
  const recipes = _deps.db.getRecipes(contact);
  if (!recipes.length) return '';
  return '\n\n=== AVAILABLE RECIPES (use teach_run with input_text to execute) ===\n' +
    recipes.map(r => `- #${r.id} "${r.trigger_phrase}" — ${r.description || r.command_name}`).join('\n') +
    '\n=== END RECIPES ===';
}

function buildLessonsPrompt() {
  _checkInit();
  const lessons = _deps.db.getActiveLessons(12);
  if (!lessons.length) return '';
  const grouped = {};
  for (const l of lessons) {
    (grouped[l.type] = grouped[l.type] || []).push(l.lesson);
  }
  return '\n\n=== LEARNED LESSONS (from your own experience — follow these) ===\n' +
    Object.entries(grouped).map(([t, items]) => `${t}:\n${items.map(i => '- ' + i).join('\n')}`).join('\n') +
    '\n=== END LESSONS ===';
}

module.exports = {
  init,
  buildDirectivesPrompt,
  buildEntityPrompt,
  buildRecipesPrompt,
  buildLessonsPrompt,
};
