#!/usr/bin/env node
// tool-runner.js — Standalone tool executor for Claude CLI integration
// Usage: node tool-runner.js <tool_name> '<json_args>'
// Returns: tool result as plain text (stdout)
//
// This file is invoked by Claude CLI (via Bash tool) when the bot routes
// a message to the "tool" route. Claude CLI reads the user's request,
// picks a tool, and runs: node /path/to/tool-runner.js <tool> '{"key":"value"}'
//
// ─── CONFIGURATION ───
// Device IPs, SSH users, and ADB paths are read from config.json.
// Set these in your config.json before using device tools:
//
//   "laptop": {
//     "enabled": true,
//     "user": "YOUR_SSH_USER",
//     "host": "YOUR_LAPTOP_IP",
//     "port": 22,
//     "connectTimeout": 5000,
//     "execTimeout": 15000
//   },
//   "phone": {
//     "enabled": false,
//     "host": "YOUR_PHONE_IP",
//     "adbPort": "5555",
//     "adbBinary": "/usr/local/bin/adb"
//   }

const path = require('path');
process.chdir(path.join(__dirname));

const toolName = process.argv[2];
const toolArgs = process.argv[3] || '{}';

if (!toolName) {
  console.error('Usage: node tool-runner.js <tool_name> \'<json_args>\'');
  process.exit(1);
}

let input;
try {
  input = JSON.parse(toolArgs);
} catch (e) {
  console.error('Invalid JSON args: ' + e.message);
  process.exit(1);
}

// Load config for device connection details
function loadConfig() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Lazy-load only what we need to keep startup fast
async function run() {
  try {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const config = loadConfig();

    // ─── LAPTOP TOOLS ───
    // Reads SSH connection details from config.json "laptop" section
    const laptopConfig = config.laptop || {};
    const LAPTOP_USER = laptopConfig.user || process.env.FAVOR_LAPTOP_USER || '';
    const LAPTOP_HOST = laptopConfig.host || process.env.FAVOR_LAPTOP_IP || '';
    const LAPTOP_PORT = laptopConfig.port || 22;
    const LAPTOP_TIMEOUT = Math.floor((laptopConfig.connectTimeout || 5000) / 1000);
    const LAPTOP_SSH = `ssh -o ConnectTimeout=${LAPTOP_TIMEOUT} -o StrictHostKeyChecking=no -p ${LAPTOP_PORT} ${LAPTOP_USER}@${LAPTOP_HOST}`;
    const LAPTOP_ENABLED = laptopConfig.enabled && LAPTOP_USER && LAPTOP_HOST;

    // ─── PHONE TOOLS ───
    // Reads ADB connection details from config.json "phone" section
    const phoneConfig = config.phone || {};
    const PHONE_HOST = phoneConfig.host || process.env.FAVOR_PHONE_IP || '';
    const PHONE_ADB_PORT = phoneConfig.adbPort || '5555';
    const ADB = phoneConfig.adbBinary || process.env.FAVOR_ADB_BINARY || '/usr/local/bin/adb';
    const PHONE_ENABLED = phoneConfig.enabled && PHONE_HOST;

    // Notify port + auth token — matches favor.js
    const NOTIFY_PORT = 3099;
    const NOTIFY_TOKEN = config.notifyToken || '';

    switch (toolName) {

      // ─── LAPTOP TOOLS ───

      case 'laptop_screenshot': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured. Set laptop.enabled, laptop.user, and laptop.host in config.json.'); break; }
        // Use favor.js's /trigger endpoint (has proper screenshot capture + send)
        execSync(`curl -s -X POST http://localhost:${NOTIFY_PORT}/trigger -H 'Authorization: Bearer ${NOTIFY_TOKEN}' -H 'Content-Type: application/json' -d '{"action":"laptop_screenshot"}'`, { timeout: 30000 });
        console.log('Screenshot captured and sent.');
        break;
      }
      case 'laptop_open_app': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured.'); break; }
        let app = input.app;
        // Map common app names to full paths
        // Users should customize this map for their own installed applications
        const laptopApps = {
          'chrome': 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'google chrome': 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'notepad': 'C:\\Windows\\System32\\notepad.exe',
          'explorer': 'C:\\Windows\\explorer.exe',
          'file explorer': 'C:\\Windows\\explorer.exe',
          'terminal': 'C:\\Windows\\System32\\WindowsTerminal.exe',
          // Add your own app paths here:
          // 'myapp': 'C:\\Path\\To\\MyApp.exe',
        };
        const mapped = laptopApps[app.toLowerCase()];
        if (mapped) app = mapped;
        execSync(`${LAPTOP_SSH} 'powershell -Command "Register-ScheduledTask -TaskName TmpOpen -Action (New-ScheduledTaskAction -Execute \\"${app}\\") -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)) -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) -Force; Start-ScheduledTask -TaskName TmpOpen"'`, { timeout: 15000, encoding: 'utf8' });
        console.log(`Opened: ${app}`);
        break;
      }
      case 'laptop_open_url': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured.'); break; }
        const url = input.url;
        execSync(`${LAPTOP_SSH} 'powershell -Command "Start-Process \\"${url}\\""'`, { timeout: 10000 });
        console.log(`Opened URL: ${url}`);
        break;
      }
      case 'laptop_run_command': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured.'); break; }
        const result = execSync(`${LAPTOP_SSH} 'powershell -Command "${input.command.replace(/"/g, '\\"')}"'`, { timeout: 30000, encoding: 'utf8' });
        console.log(result.trim());
        break;
      }
      case 'laptop_read_file': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured.'); break; }
        const result = execSync(`${LAPTOP_SSH} 'powershell -Command "Get-Content \\"${input.file_path}\\" -Raw"'`, { timeout: 15000, encoding: 'utf8' });
        console.log(result.trim());
        break;
      }
      case 'laptop_list_files': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured.'); break; }
        const result = execSync(`${LAPTOP_SSH} 'powershell -Command "Get-ChildItem \\"${input.directory}\\" | Format-Table Name, Length, LastWriteTime"'`, { timeout: 15000, encoding: 'utf8' });
        console.log(result.trim());
        break;
      }
      case 'laptop_status': {
        if (!LAPTOP_ENABLED) { console.log('Laptop access not configured.'); break; }
        try {
          execSync(`${LAPTOP_SSH} 'echo online'`, { timeout: 5000 });
          console.log('Laptop is ONLINE');
        } catch {
          console.log('Laptop is OFFLINE');
        }
        break;
      }

      // ─── PHONE TOOLS ───

      case 'phone_screenshot': {
        if (!PHONE_ENABLED) { console.log('Phone access not configured. Set phone.enabled and phone.host in config.json.'); break; }
        // Use favor.js's /trigger endpoint (sends screenshot via messaging platform)
        execSync(`curl -s -X POST http://localhost:${NOTIFY_PORT}/trigger -H 'Authorization: Bearer ${NOTIFY_TOKEN}' -H 'Content-Type: application/json' -d '{"action":"phone_screenshot"}'`, { timeout: 30000 });
        console.log('Phone screenshot captured and sent.');
        break;
      }
      case 'phone_open_app': {
        if (!PHONE_ENABLED) { console.log('Phone access not configured.'); break; }
        const portFile = path.join(__dirname, 'data', '.adb-port');
        let port = PHONE_ADB_PORT;
        try { port = fs.readFileSync(portFile, 'utf8').trim(); } catch {}
        const target = `${PHONE_HOST}:${port}`;
        const app = input.app;
        // Common app name -> Android package mappings
        const pkgMap = {
          'chrome': 'com.android.chrome', 'instagram': 'com.instagram.android',
          'whatsapp': 'com.whatsapp', 'settings': 'com.android.settings',
          'camera': 'com.sec.android.app.camera', 'gallery': 'com.sec.android.gallery3d',
          'youtube': 'com.google.android.youtube', 'spotify': 'com.spotify.music',
          'twitter': 'com.twitter.android', 'x': 'com.twitter.android',
          'tiktok': 'com.zhiliaoapp.musically', 'snapchat': 'com.snapchat.android',
          'telegram': 'org.telegram.messenger', 'facebook': 'com.facebook.katana',
          'messenger': 'com.facebook.orca', 'maps': 'com.google.android.apps.maps',
          'gmail': 'com.google.android.gm', 'phone': 'com.samsung.android.dialer',
          'messages': 'com.samsung.android.messaging', 'files': 'com.sec.android.app.myfiles',
          'calculator': 'com.sec.android.app.popupcalculator', 'clock': 'com.sec.android.app.clockpackage',
          'calendar': 'com.samsung.android.calendar', 'notes': 'com.samsung.android.app.notes',
        };
        let pkg = pkgMap[app.toLowerCase()] || app;
        // If not in map and doesn't look like a package name, try to find it
        if (!pkg.includes('.')) {
          try {
            const found = execSync(`${ADB} -s ${target} shell pm list packages | grep -i "${app.toLowerCase()}" | head -1`, { timeout: 5000, encoding: 'utf8' }).trim();
            if (found) pkg = found.replace('package:', '');
          } catch {}
        }
        execSync(`${ADB} -s ${target} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 10000, encoding: 'utf8' });
        console.log(`Opened: ${app} (${pkg})`);
        break;
      }
      case 'phone_status': {
        if (!PHONE_ENABLED) { console.log('Phone access not configured.'); break; }
        const portFile2 = path.join(__dirname, 'data', '.adb-port');
        let port2 = PHONE_ADB_PORT;
        try { port2 = fs.readFileSync(portFile2, 'utf8').trim(); } catch {}
        const target2 = `${PHONE_HOST}:${port2}`;
        try {
          const battery = execSync(`${ADB} -s ${target2} shell dumpsys battery | grep -E "level|status"`, { timeout: 5000, encoding: 'utf8' });
          console.log(`Phone ONLINE\n${battery.trim()}`);
        } catch {
          console.log('Phone OFFLINE');
        }
        break;
      }
      case 'phone_shell': {
        if (!PHONE_ENABLED) { console.log('Phone access not configured.'); break; }
        const portFile3 = path.join(__dirname, 'data', '.adb-port');
        let port3 = PHONE_ADB_PORT;
        try { port3 = fs.readFileSync(portFile3, 'utf8').trim(); } catch {}
        const target3 = `${PHONE_HOST}:${port3}`;
        const result = execSync(`${ADB} -s ${target3} shell ${input.command}`, { timeout: 15000, encoding: 'utf8' });
        console.log(result.trim());
        break;
      }

      // ─── SERVER TOOLS ───

      case 'server_exec': {
        const result = execSync(input.command, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
        console.log(result.trim());
        break;
      }
      case 'read_file': {
        const content = fs.readFileSync(input.file_path, 'utf8');
        console.log(content);
        break;
      }
      case 'write_file': {
        fs.writeFileSync(input.file_path, input.content);
        console.log(`Written: ${input.file_path}`);
        break;
      }

      // ─── MEMORY TOOLS ───

      case 'memory_save': {
        const DB = require('./db');
        const db = new DB(config.memory?.dbPath || './data/favor.db');
        const id = db.save(input.category, input.content, input.status || null);
        console.log(`Saved memory #${id}: [${input.category}] ${input.content.substring(0, 80)}`);
        break;
      }
      case 'memory_search': {
        const DB = require('./db');
        const db = new DB(config.memory?.dbPath || './data/favor.db');
        const results = db.findByKeyword(input.query, 10);
        if (!results.length) { console.log('No memories found.'); break; }
        results.forEach(r => console.log(`#${r.id} [${r.category}] ${r.content.substring(0, 120)}`));
        break;
      }

      // ─── CRON TOOLS ───

      case 'cron_list': {
        const DB = require('./db');
        const db = new DB(config.memory?.dbPath || './data/favor.db');
        const crons = db.db.prepare('SELECT * FROM crons WHERE enabled = 1').all();
        if (!crons.length) { console.log('No active crons.'); break; }
        crons.forEach(c => console.log(`#${c.id} "${c.label}" — ${c.schedule} — ${c.task.substring(0, 80)}`));
        break;
      }

      // ─── WEB SEARCH ───

      case 'web_search': {
        const result = execSync(`claude -p "Search the web for: ${input.query.replace(/"/g, '\\"')}. Summarize the top results concisely." --allowedTools WebSearch --model haiku`, { timeout: 60000, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY')) });
        console.log(result.trim());
        break;
      }

      default:
        console.log(`Unknown tool: ${toolName}. Available: laptop_screenshot, laptop_open_app, laptop_open_url, laptop_run_command, laptop_read_file, laptop_list_files, laptop_status, phone_screenshot, phone_open_app, phone_status, phone_shell, server_exec, read_file, write_file, memory_save, memory_search, cron_list, web_search`);
    }
  } catch (e) {
    console.error(`Tool error: ${e.message}`);
    process.exit(1);
  }
}

run();
