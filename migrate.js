// Migrate OpenClaw memory -> Favor
const Database = require('better-sqlite3');
const FavorMemory = require('./db');
const fs = require('fs');
const path = require('path');

const OPENCLAW_DB = '/root/.openclaw/memory/main.sqlite';
const FAVOR_DB = './data/favor.db';
const KNOWLEDGE_DIR = './knowledge';

console.log('=== OpenClaw -> Favor Memory Migration ===\n');

const oc = new Database(OPENCLAW_DB, { readonly: true });
const favor = new FavorMemory(FAVOR_DB);

// Schema: files(path, source, hash, mtime, size), chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
const files = oc.prepare("SELECT path, mtime, size FROM files ORDER BY mtime").all();
console.log(`Found ${files.length} memory files in OpenClaw`);

const chunks = oc.prepare("SELECT path, text, start_line FROM chunks ORDER BY path, start_line").all();
console.log(`Found ${chunks.length} text chunks\n`);

// Group chunks by file path
const fileChunks = {};
for (const chunk of chunks) {
  if (!fileChunks[chunk.path]) fileChunks[chunk.path] = [];
  fileChunks[chunk.path].push(chunk.text);
}

let savedFiles = 0;
let savedFacts = 0;

for (const file of files) {
  const content = (fileChunks[file.path] || []).join('\n\n');
  if (!content.trim()) continue;

  const basename = path.basename(file.path, '.md');

  // Save important memory files to knowledge dir
  if (file.path.startsWith('memory/') && content.length > 50) {
    if (basename.match(/^2026-03-1[0-1]/) ||
        basename.includes('cost') ||
        basename.includes('compliance') ||
        basename.includes('invoice') ||
        basename.includes('product') ||
        basename.includes('node_monitor')) {
      const destPath = path.join(KNOWLEDGE_DIR, `oc_${basename}.md`);
      fs.writeFileSync(destPath, content);
      savedFiles++;
      console.log(`  Saved: ${destPath} (${content.length} chars)`);
    }
  }

  // Extract key facts
  const lines = content.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const trimmed = line.replace(/^[-*#>\s]+/, '').trim();
    if (trimmed.length < 10 || trimmed.length > 500) continue;
    if (trimmed.startsWith('```') || trimmed.match(/^\d{4}-\d{2}-\d{2}T/) || trimmed.startsWith('|')) continue;

    if (trimmed.match(/owner|contact|phone|email|address|business|client|invoice|product|batch|compliance/i)) {
      favor.save('fact', trimmed);
      savedFacts++;
    }
  }
}

// Extract decisions/preferences from MEMORY.md
const memoryMd = fs.readFileSync('/root/.openclaw/workspace/MEMORY.md', 'utf8');
const sections = memoryMd.split(/^##\s+/m);
for (const section of sections) {
  const lines = section.split('\n');
  const header = lines[0]?.trim().toLowerCase() || '';

  if (header.includes('routing') || header.includes('preference') || header.includes('workflow')) {
    for (const line of lines.slice(1)) {
      const t = line.replace(/^[-*>\s]+/, '').trim();
      if (t.length > 15 && t.length < 400) {
        favor.save('preference', t);
      }
    }
  }

  if (header.includes('decision') || header.includes('architecture') || header.includes('setup')) {
    for (const line of lines.slice(1)) {
      const t = line.replace(/^[-*>\s]+/, '').trim();
      if (t.length > 15 && t.length < 400) {
        favor.save('decision', t);
      }
    }
  }
}

console.log(`\n=== Migration Complete ===`);
console.log(`Knowledge files saved: ${savedFiles}`);
console.log(`Facts imported: ${savedFacts}`);
const counts = favor.getMemoryCount();
console.log(`Favor memory totals: ${counts.facts}F ${counts.decisions}D ${counts.preferences}P ${counts.tasks}T`);

oc.close();
favor.close();
