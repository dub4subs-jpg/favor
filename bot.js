const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',') : [];
const MODEL = 'gpt-4o';
const MAX_HISTORY = 30;
const LAPTOP_USER = process.env.LAPTOP_USER || 'your-username';
const LAPTOP_PORT = 2222;
const LAPTOP_TIMEOUT = 15000;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const conversations = new Map();

const MEMORY_FILE = path.join(__dirname, 'memory.json');
function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
    catch (e) { return { facts: [], decisions: [], preferences: [], tasks: [] }; }
  }
  return { facts: [], decisions: [], preferences: [], tasks: [] };
}
function saveMemory(mem) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); }
let memory = loadMemory();

function getMemoryPrompt() {
  const m = memory;
  if (!m.facts.length && !m.decisions.length && !m.preferences.length && !m.tasks.length) return '';
  let p = '\n\n=== LONG-TERM MEMORY ===\n';
  if (m.facts.length) p += '\n*Facts:*\n' + m.facts.map(f => '- ' + f.content + ' (' + f.date + ')').join('\n');
  if (m.decisions.length) p += '\n\n*Decisions:*\n' + m.decisions.map(d => '- ' + d.content + ' (' + d.date + ')').join('\n');
  if (m.preferences.length) p += '\n\n*Preferences:*\n' + m.preferences.map(pr => '- ' + pr.content + ' (' + pr.date + ')').join('\n');
  if (m.tasks.length) p += '\n\n*Tasks:*\n' + m.tasks.slice(-20).map(t => '- [' + (t.status || '?') + '] ' + t.content + ' (' + t.date + ')').join('\n');
  return p;
}

function laptopExec(command) {
  return new Promise((resolve) => {
    const cmd = 'ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ' + LAPTOP_PORT + ' ' + LAPTOP_USER + '@localhost "' + command.replace(/"/g, '\\"') + '"';
    exec(cmd, { timeout: LAPTOP_TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        if (err.message.includes('Connection refused') || err.message.includes('timed out')) {
          resolve({ ok: false, output: 'Laptop is not connected.' });
        } else { resolve({ ok: false, output: err.message }); }
      } else { resolve({ ok: true, output: (stdout || stderr || '').trim() }); }
    });
  });
}
async function isLaptopOnline() { const r = await laptopExec('echo online'); return r.ok && r.output === 'online'; }

function loadKnowledge() {
  const dir = path.join(__dirname, 'knowledge');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return ''; }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
  if (!files.length) return '';
  let k = '\n\n=== YOUR KNOWLEDGE BASE ===\n';
  for (const file of files) {
    k += '\n--- ' + file.replace('.txt', '').toUpperCase() + ' ---\n' + fs.readFileSync(path.join(dir, file), 'utf8') + '\n';
  }
  console.log('Loaded ' + files.length + ' knowledge file(s): ' + files.join(', '));
  return k;
}
const KNOWLEDGE = loadKnowledge();

const TOOLS = [
  { type: 'function', function: { name: 'laptop_read_file', description: 'Read a file from the laptop.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Full Windows path' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'laptop_list_files', description: 'List files in a directory on the laptop.', parameters: { type: 'object', properties: { directory: { type: 'string', description: 'Full Windows path' } }, required: ['directory'] } } },
  { type: 'function', function: { name: 'laptop_run_command', description: 'Run a command on the laptop.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'laptop_write_file', description: 'Write content to a file on the laptop.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
  { type: 'function', function: { name: 'laptop_status', description: 'Check if laptop is online.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'memory_save', description: 'Save to long-term memory. Use proactively for important facts, decisions, preferences, tasks.', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['fact', 'decision', 'preference', 'task'] }, content: { type: 'string' }, status: { type: 'string' } }, required: ['category', 'content'] } } },
  { type: 'function', function: { name: 'memory_search', description: 'Search long-term memory.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'memory_forget', description: 'Remove from memory.', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['fact', 'decision', 'preference', 'task'] }, query: { type: 'string' } }, required: ['category', 'query'] } } }
];

async function executeTool(name, input) {
  switch (name) {
    case 'laptop_status': { const on = await isLaptopOnline(); return on ? 'Laptop is online.' : 'Laptop is offline.'; }
    case 'laptop_read_file': { const r = await laptopExec('cat "' + input.file_path + '"'); if (!r.ok) return 'Error: ' + r.output; return r.output.length > 3000 ? r.output.substring(0, 3000) + '\n...(truncated)' : (r.output || '(empty)'); }
    case 'laptop_list_files': { const r = await laptopExec('ls -la "' + input.directory + '"'); return r.ok ? r.output : 'Error: ' + r.output; }
    case 'laptop_run_command': { const r = await laptopExec(input.command); return r.ok ? (r.output || '(no output)') : 'Error: ' + r.output; }
    case 'laptop_write_file': { const esc = input.content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`'); const r = await laptopExec('echo "' + esc + '" > "' + input.file_path + '"'); return r.ok ? 'Written: ' + input.file_path : 'Error: ' + r.output; }
    case 'memory_save': { const today = new Date().toISOString().split('T')[0]; const entry = { content: input.content, date: today }; if (input.status) entry.status = input.status; const cat = input.category + 's'; if (!memory[cat]) memory[cat] = []; memory[cat].push(entry); saveMemory(memory); console.log('[MEMORY] ' + input.category + ': ' + input.content); return 'Remembered: ' + input.content; }
    case 'memory_search': { const q = input.query.toLowerCase(); const res = []; for (const cat of ['facts', 'decisions', 'preferences', 'tasks']) { for (const item of (memory[cat] || [])) { if (item.content.toLowerCase().includes(q)) res.push('[' + cat + '] ' + item.content + ' (' + item.date + ')'); } } return res.length ? res.join('\n') : 'Nothing found for: ' + input.query; }
    case 'memory_forget': { const cat = input.category + 's'; const before = (memory[cat] || []).length; memory[cat] = (memory[cat] || []).filter(i => !i.content.toLowerCase().includes(input.query.toLowerCase())); const removed = before - memory[cat].length; saveMemory(memory); return removed > 0 ? 'Forgot ' + removed + ' item(s)' : 'Nothing found'; }
    default: return 'Unknown tool.';
  }
}

function buildSystemPrompt() {
  return 'You are Favor — the central AI brain for all operations. Powered by GPT-4o, accessible via WhatsApp.\n\nYou belong to your operator. Direct, concise, sharp. No fluff. You know their business inside and out.\n\nLONG-TERM MEMORY:\nYou have tools to save and recall memories. USE THEM PROACTIVELY:\n- Important info → save as fact\n- Decisions made → save as decision\n- Preferences learned → save as preference\n- Tasks assigned/completed → save as task\n- Always save without being asked. This is critical.\n\nLAPTOP ACCESS:\nYou have tools to access the laptop when connected:\n- Read files, list dirs, write files, run commands\n- Windows 11 laptop\n- Main folder: configured in your environment\n- NEVER run destructive commands without confirmation\n- Tell operator what you are doing before doing it\n\nKeep responses WhatsApp-friendly:\n- Short paragraphs, line breaks\n- Use *bold* for emphasis\n- Under 4000 chars when possible\n\nCommands: /clear /status /brain /laptop /memory\n\nEven after /clear, long-term memories persist.' + KNOWLEDGE + getMemoryPrompt();
}

// Trim history safely — never split a tool_call / tool result pair
function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    history.shift();
    // If we cut into a tool result, remove it too
    while (history.length > 0 && history[0].role === 'tool') history.shift();
    // If next is an assistant with tool_calls that lost its results, remove it
    if (history.length > 0 && history[0].role === 'assistant' && history[0].tool_calls?.length) {
      const nextRole = history[1]?.role;
      if (nextRole !== 'tool') history.shift();
    }
  }
}

const whatsapp = new Client({ authStrategy: new LocalAuth(), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } });
whatsapp.on('qr', (qr) => { console.log('Scan QR:'); qrcode.generateASCII(qr, { small: true }); });
whatsapp.on('ready', () => { console.log('Favor is online'); console.log('Memories: ' + memory.facts.length + ' facts, ' + memory.decisions.length + ' decisions, ' + memory.preferences.length + ' prefs, ' + memory.tasks.length + ' tasks'); });
whatsapp.on('authenticated', () => { console.log('WhatsApp authenticated'); });
whatsapp.on('auth_failure', (msg) => { console.error('Auth failed:', msg); });

whatsapp.on('message', async (msg) => {
  if (msg.from === 'status@broadcast' || msg.isGroupMsg) return;
  if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(msg.from)) return;
  const body = msg.body?.trim();
  if (!body) return;
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg.from + ': ' + body.substring(0, 80));

  if (body.toLowerCase() === '/clear') { conversations.delete(msg.from); await msg.reply('Conversation cleared. Memories intact.'); return; }
  if (body.toLowerCase() === '/status') {
    const hist = conversations.get(msg.from) || [];
    const kDir = path.join(__dirname, 'knowledge');
    const kFiles = fs.existsSync(kDir) ? fs.readdirSync(kDir).filter(f => f.endsWith('.txt')) : [];
    const on = await isLaptopOnline();
    const mc = memory.facts.length + memory.decisions.length + memory.preferences.length + memory.tasks.length;
    await msg.reply('*Favor online*\nMessages: ' + hist.length + '\nModel: ' + MODEL + '\nKnowledge: ' + kFiles.length + ' files\nMemories: ' + mc + '\nLaptop: ' + (on ? 'Connected' : 'Offline'));
    return;
  }
  if (body.toLowerCase() === '/brain') {
    const kDir = path.join(__dirname, 'knowledge');
    const kFiles = fs.existsSync(kDir) ? fs.readdirSync(kDir).filter(f => f.endsWith('.txt')) : [];
    await msg.reply(kFiles.length ? '*Brain:*\n' + kFiles.map(f => '- ' + f).join('\n') : 'No knowledge files.');
    return;
  }
  if (body.toLowerCase() === '/laptop') { const on = await isLaptopOnline(); await msg.reply(on ? 'Laptop *online*.' : 'Laptop *offline*. Run tunnel script.'); return; }
  if (body.toLowerCase() === '/memory') {
    const lines = [];
    if (memory.facts.length) lines.push('*Facts (' + memory.facts.length + '):*\n' + memory.facts.slice(-10).map(f => '- ' + f.content).join('\n'));
    if (memory.decisions.length) lines.push('*Decisions (' + memory.decisions.length + '):*\n' + memory.decisions.slice(-10).map(d => '- ' + d.content).join('\n'));
    if (memory.preferences.length) lines.push('*Prefs (' + memory.preferences.length + '):*\n' + memory.preferences.slice(-10).map(p => '- ' + p.content).join('\n'));
    if (memory.tasks.length) lines.push('*Tasks (' + memory.tasks.length + '):*\n' + memory.tasks.slice(-10).map(t => '- [' + (t.status || '?') + '] ' + t.content).join('\n'));
    await msg.reply(lines.length ? lines.join('\n\n') : 'No memories yet.');
    return;
  }

  try {
    if (!conversations.has(msg.from)) conversations.set(msg.from, []);
    const history = conversations.get(msg.from);
    history.push({ role: 'user', content: body });
    trimHistory(history);

    const chat = await msg.getChat();
    await chat.sendStateTyping();

    let response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...history],
      tools: TOOLS
    });

    let toolLoops = 0;
    while (response.choices[0].finish_reason === 'tool_calls' && toolLoops < 10) {
      toolLoops++;
      const assistantMsg = response.choices[0].message;
      history.push(assistantMsg);

      for (const toolCall of assistantMsg.tool_calls) {
        console.log('[TOOL] ' + toolCall.function.name + ': ' + toolCall.function.arguments.substring(0, 100));
        const input = JSON.parse(toolCall.function.arguments);
        const result = await executeTool(toolCall.function.name, input);
        history.push({ role: 'tool', tool_call_id: toolCall.id, content: String(result) });
      }

      await chat.sendStateTyping();
      response = await openai.chat.completions.create({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: 'system', content: buildSystemPrompt() }, ...history],
        tools: TOOLS
      });
    }

    const reply = response.choices[0].message.content || 'Done.';
    history.push(response.choices[0].message);

    if (reply.length > 4000) { const chunks = splitMessage(reply, 4000); for (const c of chunks) await msg.reply(c); }
    else { await msg.reply(reply); }
    await chat.clearState();
    console.log('[' + new Date().toLocaleTimeString() + '] Favor replied (' + reply.length + ' chars)');
  } catch (err) { console.error('Error:', err.message); await msg.reply('Error: ' + err.message); }
});

function splitMessage(text, maxLen) {
  const chunks = []; let rem = text;
  while (rem.length > 0) {
    if (rem.length <= maxLen) { chunks.push(rem); break; }
    let s = rem.lastIndexOf('\n', maxLen);
    if (s < maxLen * 0.3) s = maxLen;
    chunks.push(rem.substring(0, s));
    rem = rem.substring(s).trimStart();
  }
  return chunks;
}

console.log('Starting Favor...');
whatsapp.initialize();
