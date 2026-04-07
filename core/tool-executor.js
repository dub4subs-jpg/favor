// ─── TOOL EXECUTOR ───
// Handles execution of all 40+ tools. Extracted from favor.js.
// Returns a factory function that creates executeTool with injected dependencies.

const fs = require('fs');
const path = require('path');

function createToolExecutor(deps) {
  let {
    db, config, vault, browser, pw, videoProcessor, buildMode, guardian, selfCheck,
    pluginLoader, accessControl, mediaHandler, syncBot,
    getEmbedding, runClaudeCLI, semanticSearch, updateOperatorProfile,
    laptopExec, isLaptopOnline, captureScreenshotBuffer,
    sanitizeExternalInput, sanitizeBrowserOutput,
    PLATFORM, botDir,
  } = deps;

  // Mutable refs — updated on reconnect
  let sock = null;

  const SENSITIVE_TOOLS = new Set([
    'vault_get', 'vault_save', 'vault_delete', 'send_message', 'send_image',
    'send_email', 'browser_fill_from_vault', 'server_exec', 'write_file',
    'laptop_run_command', 'laptop_write_file'
  ]);
  let lastToolWasBrowser = false;

  async function executeTool(name, input, context = {}) {
    const role = context.role || 'customer';
    if (!accessControl.canUseTool(role, name)) {
      console.log(`[SECURITY] Blocked tool "${name}" — ${role} does not have access`);
      db.audit('security.tool_blocked', `${role} tried to use ${name}`);
      return `This tool is not available. Please contact the operator for help with this request.`;
    }

    if (pluginLoader.has(name)) {
      return await pluginLoader.execute(name, input, { config, db, vault, contact: context.contact, role });
    }

    if (lastToolWasBrowser && SENSITIVE_TOOLS.has(name)) {
      console.warn(`[SECURITY] Blocked ${name} — called immediately after browser content read. Possible injection.`);
      db.audit('security.blocked', `Blocked ${name} after browser read — possible injection`);
      lastToolWasBrowser = false;
      return `SECURITY BLOCK: "${name}" cannot be called immediately after reading browser content. This is a safety measure against prompt injection. If the operator actually wants this action, they should send a new message requesting it directly.`;
    }
    lastToolWasBrowser = false;

    switch (name) {
      case 'laptop_screenshot': {
        const result = await captureScreenshotBuffer();
        if (!result) return 'Screenshot failed — laptop may be offline or capture timed out.';
        try {
          await sock.sendMessage(context.contact, { image: result.buffer, caption: `Screenshot — ${result.dateStr} ${result.timeStr.replace(/-/g, ':')} — saved to Favor/Screenshots/${result.dateStr}/` });
          return '__IMAGE_SENT__';
        } catch (e) {
          return 'Screenshot captured but could not send: ' + e.message;
        }
      }
      case 'laptop_open_app': {
        const { safePowerShell, psSafeString } = require('../utils/shell');
        const psCode = `Register-ScheduledTask -TaskName TmpOpen -Action (New-ScheduledTaskAction -Execute ${psSafeString(input.app)}) -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)) -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) -Force; Start-ScheduledTask -TaskName TmpOpen`;
        const create = await laptopExec(safePowerShell(psCode));
        if (!create.ok) return 'Error creating launch task: ' + create.output;
        return `Launched "${input.app}" on the laptop desktop.`;
      }
      case 'laptop_open_url': {
        const { safePowerShell, psSafeString } = require('../utils/shell');
        const psCode = `Start-Process ${psSafeString(input.url)}`;
        const create = await laptopExec(safePowerShell(psCode));
        if (!create.ok) return 'Error opening URL: ' + create.output;
        return `Opened ${input.url} on the laptop browser.`;
      }
      case 'laptop_status': {
        const on = await isLaptopOnline();
        return on ? 'Laptop is online and connected.' : 'Laptop is offline.';
      }
      case 'laptop_read_file': {
        const { safePowerShell, psSafeString } = require('../utils/shell');
        const r = await laptopExec(safePowerShell(`Get-Content ${psSafeString(input.file_path)} -Raw`));
        if (!r.ok) return 'Error: ' + r.output;
        return r.output.length > 3000 ? r.output.substring(0, 3000) + '\n...(truncated)' : (r.output || '(empty)');
      }
      case 'laptop_list_files': {
        const { safePowerShell, psSafeString } = require('../utils/shell');
        const r = await laptopExec(safePowerShell(`Get-ChildItem ${psSafeString(input.directory)} | Format-Table Name, Length, LastWriteTime`));
        return r.ok ? r.output : 'Error: ' + r.output;
      }
      case 'laptop_run_command': {
        const r = await laptopExec(input.command);
        return r.ok ? (r.output || '(no output)') : 'Error: ' + r.output;
      }
      case 'laptop_write_file': {
        const { psSafeString: psStr } = require('../utils/shell');
        const r = await laptopExec(`cat > ${psStr(input.file_path)}`, { stdin: input.content });
        return r.ok ? 'Written: ' + input.file_path : 'Error: ' + r.output;
      }
      case 'memory_save': {
        const similar = db.findSimilar(input.category, input.content);
        if (similar.length > 0) {
          console.log(`[MEMORY] Dedup: found ${similar.length} similar memories, updating instead`);
          const target = similar[0];
          db.db.prepare('UPDATE memories SET content = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(input.content, input.status || null, target.id);
          getEmbedding(input.content).then(emb => db.updateEmbedding(target.id, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${target.id}:`, e.message));
          // Invalidate recall cache so new memory is immediately findable
          if (typeof global._favorQueryCacheClear === 'function') global._favorQueryCacheClear();
          return `Updated existing memory (was similar): ${input.content}`;
        }
        const memId = db.save(input.category, input.content, input.status);
        console.log(`[MEMORY] ${input.category}: ${input.content}`);
        getEmbedding(input.content).then(emb => db.updateEmbedding(memId, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${memId}:`, e.message));
        // Invalidate recall cache so new memory is immediately findable
        if (typeof global._favorQueryCacheClear === 'function') global._favorQueryCacheClear();
        return 'Remembered: ' + input.content;
      }
      case 'memory_search': {
        const results = await semanticSearch(input.query);
        if (!results.length) return 'Nothing found for: ' + input.query;
        return results.map(r => `[#${r.id} ${r.category}] ${r.content}${r.score ? ` (relevance: ${(r.score * 100).toFixed(0)}%)` : ''}`).join('\n');
      }
      case 'memory_forget': {
        const removed = db.softForget(input.query);
        return removed > 0 ? `Forgot ${removed} item(s) (marked as superseded)` : 'Nothing found to forget.';
      }
      case 'memory_pin': {
        if (input.unpin) { db.unpin(input.id); return `Unpinned memory #${input.id}`; }
        db.pin(input.id); return `Pinned memory #${input.id} — it will never decay`;
      }
      case 'memory_resolve': {
        const resolveId = Number(input.id);
        if (!Number.isInteger(resolveId) || resolveId <= 0) return 'Need a valid memory ID (positive integer) to resolve.';
        const updated = db.db.prepare("UPDATE memories SET status = 'resolved', updated_at = datetime('now') WHERE id = ?").run(resolveId);
        return updated.changes > 0 ? `Memory #${resolveId} marked as resolved — won't be resurfaced.` : `Memory #${resolveId} not found.`;
      }
      case 'server_exec': {
        const { safExec } = require('../core/sandbox');
        const result = safExec(input.command, { timeout: 15000, cwd: '/root' });
        return result.ok ? (result.output || '(no output)').trim().substring(0, 3000) : 'Blocked: ' + result.error;
      }
      case 'read_file': {
        try {
          const content = fs.readFileSync(input.file_path, 'utf8');
          return content.length > 3000 ? content.substring(0, 3000) + '\n...(truncated)' : (content || '(empty)');
        } catch (e) { return 'Error: ' + e.message; }
      }
      case 'write_file': {
        try {
          const dir = path.dirname(input.file_path);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(input.file_path, input.content);
          return 'Written: ' + input.file_path;
        } catch (e) { return 'Error: ' + e.message; }
      }
      case 'web_search': {
        const braveKey = process.env.BRAVE_API_KEY || config.api?.braveApiKey;
        if (!braveKey) return 'Web search not configured (no BRAVE_API_KEY).';
        try {
          const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=5`;
          const resp = await fetch(url, { headers: { 'X-Subscription-Token': braveKey, 'Accept': 'application/json' } });
          const data = await resp.json();
          if (!data.web?.results?.length) return 'No results found.';
          const raw = data.web.results.map(r => `${r.title}\n${r.url}\n${r.description || ''}`).join('\n\n');
          return sanitizeExternalInput(raw, 'web_search');
        } catch (e) { return 'Search error: ' + e.message; }
      }
      case 'cron_create': {
        const contact = context.contact || null;
        const id = db.createCron(contact, input.label, input.schedule, JSON.stringify({ type: 'proactive', prompt: input.task }));
        console.log(`[CRON] Created #${id}: "${input.label}" (${input.schedule})`);
        return `Scheduled: "${input.label}" (${input.schedule}) — ID #${id}`;
      }
      case 'cron_list': {
        const crons = db.getCrons(context.contact);
        if (!crons.length) return 'No scheduled tasks.';
        return crons.map(c => `#${c.id} [${c.enabled ? 'ON' : 'OFF'}] "${c.label}" — ${c.schedule}\n  Task: ${c.task.substring(0, 80)}\n  Next: ${c.next_run || 'N/A'}`).join('\n\n');
      }
      case 'cron_delete': {
        const removed = db.deleteCron(input.id);
        return removed ? `Deleted cron #${input.id}` : `Cron #${input.id} not found.`;
      }
      case 'cron_toggle': {
        db.toggleCron(input.id, input.enabled);
        return `Cron #${input.id} ${input.enabled ? 'enabled' : 'disabled'}.`;
      }
      case 'topic_create': {
        const id = db.createTopic(context.contact, input.name);
        console.log(`[TOPIC] Created: "${input.name}" for ${context.contact?.substring(0, 15)}`);
        return `Topic created: "${input.name}" (ID #${id}) — now active.`;
      }
      case 'topic_switch': {
        db.switchTopic(context.contact, input.id);
        return `Switched to topic #${input.id}.`;
      }
      case 'topic_list': {
        const topics = db.getTopics(context.contact);
        if (!topics.length) return 'No topics. All conversation is in the main thread.';
        return topics.map(t => `#${t.id} ${t.active ? '\u2192' : ' '} "${t.name}" (${t.updated_at})`).join('\n');
      }
      case 'send_message': {
        try {
          let jid;
          const contact = input.contact || '';
          if (PLATFORM === 'telegram') {
            jid = contact.startsWith('tg_') ? contact : `tg_${contact}`;
          } else {
            const cleaned = contact.replace(/[^0-9+]/g, '');
            if (!cleaned || cleaned.replace('+', '').length < 10) {
              return 'Invalid phone number. Use full number with country code (e.g. +13055551234).';
            }
            jid = cleaned.replace('+', '') + '@s.whatsapp.net';
          }
          await sock.sendMessage(jid, { text: input.message });
          console.log(`[PROACTIVE] Sent to ${contact}: ${input.message.substring(0, 60)}`);
          return `Message sent to ${contact}`;
        } catch (e) { return 'Send failed: ' + e.message; }
      }
      case 'email_search': {
        try {
          const { query, max_results } = input;
          const max = Math.min(max_results || 5, 10);
          const result = await new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile('python3', [path.join(botDir, 'read-gmail.py'), 'search', query, String(max)], { timeout: 30000 }, (err, stdout, stderr) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve(stdout.trim());
            });
          });
          console.log(`[EMAIL] Searched: "${query}"`);
          return sanitizeExternalInput(result, 'email');
        } catch (e) { return 'Email search failed: ' + e.message; }
      }
      case 'email_read': {
        try {
          const { message_id } = input;
          const result = await new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile('python3', [path.join(botDir, 'read-gmail.py'), 'read', message_id], { timeout: 30000 }, (err, stdout, stderr) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve(stdout.trim());
            });
          });
          console.log(`[EMAIL] Read message: ${message_id}`);
          return sanitizeExternalInput(result, 'email');
        } catch (e) { return 'Email read failed: ' + e.message; }
      }
      case 'send_email': {
        try {
          const { to, subject, body: emailBody, attachment } = input;
          if (!to || !subject || !emailBody) return 'Missing required fields: to, subject, body';
          const args = ['python3', path.join(botDir, 'send-gmail.py'), to, subject, emailBody];
          if (attachment) args.push(attachment);
          const result = await new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile(args[0], args.slice(1), { timeout: 30000 }, (err, stdout, stderr) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve(stdout.trim());
            });
          });
          console.log(`[EMAIL] Sent to ${to}: "${subject}" ${attachment ? '(+attachment)' : ''}`);
          return `Email sent to ${to} — ${result}`;
        } catch (e) { return 'Email send failed: ' + e.message; }
      }
      case 'send_image': {
        try {
          if (!mediaHandler.lastReceivedImage) return 'No image available to forward. The operator needs to send an image first.';
          let jid;
          const contact = input.contact || '';
          if (PLATFORM === 'telegram') {
            jid = contact.startsWith('tg_') ? contact : `tg_${contact}`;
          } else {
            const cleaned = contact.replace(/[^0-9+]/g, '');
            if (!cleaned || cleaned.replace('+', '').length < 10) {
              return 'Invalid phone number. Use full number with country code (e.g. +13055551234).';
            }
            jid = cleaned.replace('+', '') + '@s.whatsapp.net';
          }
          const msgPayload = { image: mediaHandler.lastReceivedImage.buffer };
          if (input.caption) msgPayload.caption = input.caption;
          await sock.sendMessage(jid, msgPayload);
          console.log(`[PROACTIVE] Sent image to ${contact}${input.caption ? ': ' + input.caption.substring(0, 60) : ''}`);
          return `Image sent to ${contact}${input.caption ? ' with caption' : ''}`;
        } catch (e) { return 'Send image failed: ' + e.message; }
      }
      // ─── VAULT TOOLS ───
      case 'vault_save': {
        if (!vault) return 'Vault not configured. Add vault.secret to config.json.';
        try {
          const result = vault.save(input.label, input.category, input.data);
          console.log(`[VAULT] ${result.action}: ${input.label} (${input.category})`);
          db.audit('vault.save', `${result.action} ${input.label}`);
          return `Vault ${result.action}: "${input.label}" (${input.category}) — encrypted and stored securely.`;
        } catch (e) { return 'Vault save error: ' + e.message; }
      }
      case 'vault_get': {
        if (!vault) return 'Vault not configured.';
        const entry = vault.get(input.label);
        if (!entry) return `No vault entry found for "${input.label}".`;
        if (entry.error) return entry.error;
        console.log(`[VAULT] Retrieved: ${input.label} (redacted for AI)`);
        const data = typeof entry.data === 'object' ? { ...entry.data } : entry.data;
        if (typeof data === 'object') {
          if (data.number || data.card_number) {
            const num = data.number || data.card_number;
            data.number = '****' + num.slice(-4);
            delete data.card_number;
          }
          if (data.cvv || data.cvc || data.security_code) {
            data.cvv = '***';
            delete data.cvc;
            delete data.security_code;
          }
          if (data.ssn) data.ssn = '***-**-' + data.ssn.slice(-4);
          if (data.passport) data.passport = '***' + data.passport.slice(-3);
        }
        return JSON.stringify(data, null, 2);
      }
      case 'vault_list': {
        if (!vault) return 'Vault not configured.';
        const entries = vault.list(input.category);
        if (!entries.length) return 'Vault is empty.';
        return entries.map(e => `\u2022 ${e.label} (${e.category}) — saved ${e.created_at}`).join('\n');
      }
      case 'vault_delete': {
        if (!vault) return 'Vault not configured.';
        const deleted = vault.delete(input.label);
        if (deleted) {
          db.audit('vault.delete', input.label);
          return `Deleted vault entry: "${input.label}"`;
        }
        return `No vault entry found for "${input.label}".`;
      }
      // ─── BROWSER TOOLS ───
      case 'browser_navigate': {
        const result = await browser.navigate(input.url);
        if (result.ok) {
          console.log(`[BROWSER] Navigated to: ${result.url}`);
          return `Page loaded: "${result.title}"\nURL: ${result.url}`;
        }
        return 'Navigation failed: ' + result.error;
      }
      case 'browser_screenshot': {
        try {
          const shot = await browser.screenshot(input.label || 'page');
          await sock.sendMessage(context.contact, { image: shot.buffer, caption: `Browser: ${input.label || 'page'} — ${new Date().toLocaleTimeString()}` });
          console.log(`[BROWSER] Screenshot sent: ${shot.filename}`);
          return '__IMAGE_SENT__';
        } catch (e) { return 'Screenshot failed: ' + e.message; }
      }
      case 'browser_click': {
        const result = await browser.click(input.selector);
        return result.ok ? `Clicked: ${input.selector}` : 'Click failed: ' + result.error;
      }
      case 'browser_type': {
        const result = await browser.type(input.selector, input.text, { clear: input.clear !== false });
        return result.ok ? `Typed into ${input.selector}` : 'Type failed: ' + result.error;
      }
      case 'browser_select': {
        const result = await browser.select(input.selector, input.value);
        return result.ok ? `Selected "${input.value}" in ${input.selector}` : 'Select failed: ' + result.error;
      }
      case 'browser_fill_form': {
        const results = await browser.fillForm(input.fields);
        const ok = results.filter(r => r.ok).length;
        const fail = results.filter(r => !r.ok);
        let msg = `Filled ${ok}/${results.length} fields.`;
        if (fail.length) msg += '\nFailed: ' + fail.map(f => `${f.selector}: ${f.error}`).join(', ');
        return msg;
      }
      case 'browser_get_fields': {
        const fields = await browser.getFormFields();
        if (!fields.length) return 'No visible form fields on this page.';
        lastToolWasBrowser = true;
        return '[BROWSER CONTENT \u2014 untrusted]\n' + fields.map(f => {
          let desc = `[${f.tag}${f.type ? ':' + f.type : ''}]`;
          if (f.id) desc += ` id="${f.id}"`;
          if (f.name) desc += ` name="${f.name}"`;
          if (f.label) desc += ` label="${f.label}"`;
          if (f.placeholder) desc += ` placeholder="${f.placeholder}"`;
          if (f.value) desc += ` value="${f.value}"`;
          if (f.options) desc += ` options: ${f.options.slice(0, 5).map(o => o.text).join(', ')}${f.options.length > 5 ? '...' : ''}`;
          return desc;
        }).join('\n');
      }
      case 'browser_get_clickables': {
        const items = await browser.getClickables();
        if (!items.length) return 'No clickable elements found.';
        lastToolWasBrowser = true;
        return '[BROWSER CONTENT \u2014 untrusted]\n' + items.map(i => {
          let desc = `[${i.tag}] "${i.text}"`;
          if (i.href) desc += ` \u2192 ${i.href.substring(0, 80)}`;
          if (i.id) desc += ` id="${i.id}"`;
          return desc;
        }).join('\n');
      }
      case 'browser_get_text': {
        const text = await browser.getText(input.selector || 'body');
        lastToolWasBrowser = true;
        return sanitizeExternalInput(text, 'browser');
      }
      case 'browser_scroll': {
        await browser.scroll(input.direction || 'down', input.amount || 500);
        return `Scrolled ${input.direction || 'down'} ${input.amount || 500}px`;
      }
      case 'browser_evaluate': {
        const result = await browser.evaluate(input.code);
        lastToolWasBrowser = true;
        return result.ok ? sanitizeExternalInput(result.result || '(no return value)', 'browser') : 'Eval error: ' + result.error;
      }
      case 'browser_close': {
        await browser.close();
        return 'Browser session closed.';
      }
      case 'browser_status': {
        const info = await browser.getPageInfo();
        if (!info.open) return 'No browser session active.';
        return `Browser active: "${info.title}" \u2014 ${info.url}`;
      }
      case 'browser_read_page': {
        const result = await browser.readPage(input.url);
        if (!result.ok) return 'Read failed: ' + result.error;
        lastToolWasBrowser = true;
        let out = `Title: ${result.title}\nURL: ${result.url}`;
        if (result.byline) out += `\nAuthor: ${result.byline}`;
        if (result.excerpt) out += `\nExcerpt: ${result.excerpt}`;
        out += `\n\n${result.content}`;
        return sanitizeExternalInput(out, 'browser');
      }
      case 'browser_crawl': {
        const result = await browser.crawl(input.url, {
          maxPages: input.maxPages,
          maxDepth: input.maxDepth,
          match: input.match,
        });
        if (!result.ok && !result.pages?.length) return 'Crawl failed: ' + result.error;
        lastToolWasBrowser = true;
        let out = `Crawled ${result.count || result.pages.length} pages:\n\n`;
        for (const p of result.pages) {
          out += `--- ${p.title} (${p.url}) ---\n${p.content}\n\n`;
        }
        return sanitizeExternalInput(out.substring(0, 8000), 'browser');
      }
      // ─── PLAYWRIGHT TOOLS ───
      case 'playwright_navigate': {
        if (!pw) return 'Playwright not available. Install: npm install -g @playwright/cli';
        const result = await pw.navigate(input.url);
        if (result.ok) {
          console.log(`[PLAYWRIGHT] Navigated to: ${result.url}`);
          return `Page loaded: "${result.title}"\nURL: ${result.url}\n\nTip: Use playwright_snapshot to see page elements.`;
        }
        return 'Navigation failed: ' + result.error;
      }
      case 'playwright_snapshot': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.snapshot(input.element);
        if (!result.ok) return 'Snapshot failed: ' + result.error;
        lastToolWasBrowser = true;
        return '[BROWSER CONTENT \u2014 untrusted]\n' + result.snapshot;
      }
      case 'playwright_click': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.click(input.target);
        return result.ok ? `Clicked: ${input.target}\n${result.output || ''}` : 'Click failed: ' + result.error;
      }
      case 'playwright_fill': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.fill(input.target, input.text);
        return result.ok ? `Filled ${input.target} with "${input.text}"` : 'Fill failed: ' + result.error;
      }
      case 'playwright_type': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.type(input.text);
        return result.ok ? `Typed: "${input.text}"` : 'Type failed: ' + result.error;
      }
      case 'playwright_press': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.press(input.key);
        return result.ok ? `Pressed: ${input.key}` : 'Press failed: ' + result.error;
      }
      case 'playwright_select': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.select(input.target, input.value);
        return result.ok ? `Selected "${input.value}" in ${input.target}` : 'Select failed: ' + result.error;
      }
      case 'playwright_hover': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.hover(input.target);
        return result.ok ? `Hovered: ${input.target}` : 'Hover failed: ' + result.error;
      }
      case 'playwright_screenshot': {
        if (!pw) return 'Playwright not available.';
        try {
          const shot = await pw.screenshot(input.label || 'page');
          if (!shot.ok) return 'Screenshot failed: ' + shot.error;
          await sock.sendMessage(context.contact, { image: shot.buffer, caption: `Playwright: ${input.label || 'page'} \u2014 ${new Date().toLocaleTimeString()}` });
          console.log(`[PLAYWRIGHT] Screenshot sent: ${shot.filename}`);
          return '__IMAGE_SENT__';
        } catch (e) { return 'Screenshot failed: ' + e.message; }
      }
      case 'playwright_evaluate': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.evaluate(input.code);
        if (!result.ok) return 'Eval error: ' + result.error;
        lastToolWasBrowser = true;
        return sanitizeExternalInput(result.result || '(no return value)', 'browser');
      }
      case 'playwright_tabs': {
        if (!pw) return 'Playwright not available.';
        switch (input.action) {
          case 'list': {
            const r = await pw.tabList();
            return r.ok ? r.tabs : 'Failed: ' + r.error;
          }
          case 'new': {
            const r = await pw.tabNew(input.value);
            return r.ok ? `New tab opened${input.value ? ': ' + input.value : ''}` : 'Failed: ' + r.error;
          }
          case 'select': {
            const r = await pw.tabSelect(input.value);
            return r.ok ? `Switched to tab ${input.value}` : 'Failed: ' + r.error;
          }
          case 'close': {
            const r = await pw.tabClose(input.value);
            return r.ok ? 'Tab closed' : 'Failed: ' + r.error;
          }
          default: return 'Unknown tab action: ' + input.action;
        }
      }
      case 'playwright_close': {
        if (!pw) return 'Playwright not available.';
        const result = await pw.close();
        return result.ok ? 'Playwright browser session closed.' : 'Close failed: ' + result.error;
      }
      case 'playwright_status': {
        if (!pw) return 'Playwright not installed.';
        const result = await pw.status();
        return result.active ? `Playwright session active.\n${result.output}` : 'No Playwright session active.';
      }
      case 'browser_fill_from_vault': {
        if (!vault) return 'Vault not configured.';
        const entry = vault.get(input.vault_label);
        if (!entry || !entry.data) return `Vault entry "${input.vault_label}" not found or empty.`;
        const data = entry.data;
        const resolved = {
          number: data.number || data.card_number,
          exp: data.exp || data.expiration || data.exp_date,
          cvv: data.cvv || data.cvc || data.security_code,
          name: data.name || data.cardholder || data.card_name,
          zip: data.zip || data.billing_zip || data.postal_code,
          address: data.address || data.billing_address || data.street,
          city: data.city,
          state: data.state,
          country: data.country,
          email: data.email,
          phone: data.phone,
          first_name: data.first_name,
          last_name: data.last_name,
          dob: data.dob || data.date_of_birth,
          ...data
        };
        const fields = {};
        let filled = 0, skipped = [];
        for (const [selector, fieldName] of Object.entries(input.field_mapping)) {
          const value = resolved[fieldName];
          if (value) {
            fields[selector] = String(value);
            filled++;
          } else {
            skipped.push(fieldName);
          }
        }
        if (filled === 0) return 'No matching vault fields found for the given mapping.';
        const results = await browser.fillForm(fields);
        const ok = results.filter(r => r.ok).length;
        const fail = results.filter(r => !r.ok);
        console.log(`[VAULT+BROWSER] Filled ${ok} fields from "${input.vault_label}" (${skipped.length} skipped)`);
        db.audit('vault.browser_fill', `${input.vault_label}: ${ok} fields filled`);
        let msg = `Securely filled ${ok}/${filled} fields from vault "${input.vault_label}".`;
        if (skipped.length) msg += `\nSkipped (not in vault): ${skipped.join(', ')}`;
        if (fail.length) msg += `\nFailed: ${fail.map(f => f.selector).join(', ')}`;
        msg += '\n(Card data was decrypted locally \u2014 never sent through this conversation.)';
        return msg;
      }
      // ─── VIDEO TOOLS ───
      case 'video_analyze': {
        if (!videoProcessor) return 'Video processor not initialized.';
        try {
          await sock.sendMessage(context.contact, { text: '\ud83c\udfac Downloading and analyzing video... this may take a minute.' });
          const download = await videoProcessor.downloadFromUrl(input.url);
          if (!download.ok) return 'Download failed: ' + download.error;
          const result = await videoProcessor.processVideo(download.path, download.dir, input.context || '');
          videoProcessor.cleanup(download.dir);
          console.log(`[VIDEO] Analyzed: ${result.duration}s, ${result.frameCount} frames, transcript: ${result.transcript ? 'yes' : 'no'}`);
          return `**Video Analysis** (${result.duration}s, ${result.frameCount} frames)\n\n${result.summary}`;
        } catch (e) {
          return 'Video analysis failed: ' + e.message;
        }
      }
      case 'video_learn': {
        if (!videoProcessor) return 'Video processor not initialized.';
        try {
          await sock.sendMessage(context.contact, { text: '\ud83c\udfac Downloading, analyzing, and learning from video...' });
          const download = await videoProcessor.downloadFromUrl(input.url);
          if (!download.ok) return 'Download failed: ' + download.error;
          const result = await videoProcessor.processVideo(download.path, download.dir, input.context || '');
          videoProcessor.cleanup(download.dir);

          const memContent = `Video learning (${input.url}):\n${result.summary}`;
          const memId = db.save('fact', memContent.substring(0, 2000), null);
          getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${memId}:`, e.message));

          const techPrompt = `Extract actionable techniques, shortcuts, and design/business principles from this video summary. Format as bullet points. Only include things that could be applied to the operator's work. If there are no actionable techniques, respond with: NO_TECHNIQUES

Video: ${input.url}
Context: ${input.context || 'general'}

Summary:
${result.summary}`;
          const techniques = await runClaudeCLI(techPrompt, 30000) || '';
          if (techniques && !techniques.includes('NO_TECHNIQUES')) {
            const wfContent = `[Learned from video] ${input.context || 'course'}: ${techniques}`;
            const wfId = db.save('workflow', wfContent.substring(0, 2000), null);
            getEmbedding(wfContent.substring(0, 512)).then(emb => db.updateEmbedding(wfId, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${wfId}:`, e.message));

            await updateOperatorProfile(`**From video (${input.context || input.url}):**\n${techniques}`);
            console.log(`[VIDEO] Learned from video: ${result.duration}s \u2192 fact #${memId} + workflow #${wfId}`);
            return `**Video Learned** (${result.duration}s, ${result.frameCount} frames)\n\n${result.summary}\n\n**Techniques extracted:**\n${techniques}\n\n\u2705 Saved to memory + operator profile.`;
          }

          console.log(`[VIDEO] Learned from video: ${result.duration}s \u2192 memory #${memId}`);
          return `**Video Learned** (${result.duration}s, ${result.frameCount} frames)\n\n${result.summary}\n\n\u2705 Saved to long-term memory (ID #${memId}).`;
        } catch (e) {
          return 'Video learning failed: ' + e.message;
        }
      }
      case 'learn_from_url': {
        try {
          await sock.sendMessage(context.contact, { text: '\ud83d\udcd6 Reading and learning from that page...' });
          const navResult = await browser.navigate(input.url);
          if (!navResult.ok) return 'Could not load page: ' + (navResult.error || 'unknown error');

          const pageText = await browser.evaluate('document.body.innerText.substring(0, 8000)');
          const pageContent = sanitizeBrowserOutput(pageText.ok ? pageText.result : navResult.title);
          await browser.close();

          const learnPrompt = `You are extracting actionable knowledge from a webpage.

Extract:
1. **Key techniques** \u2014 specific methods, shortcuts, or approaches that can be replicated
2. **Design principles** \u2014 any visual/design insights (color theory, layout, typography, branding)
3. **Business insights** \u2014 strategies, pricing, marketing, client management tips
4. **Tools/resources** \u2014 any software, services, or resources mentioned worth knowing

Format as organized bullet points under relevant headers. Only include genuinely useful, actionable information.
If the page has no useful content (404, paywall, login wall, etc.), respond with: NO_CONTENT

URL: ${input.url}
Focus: ${input.context || 'general'}

Page content:
${pageContent}`;
          const learnings = await runClaudeCLI(learnPrompt, 60000) || '';
          if (!learnings || learnings.includes('NO_CONTENT')) return 'Could not extract useful content from that page.';

          const memContent = `[Learned from ${input.url}] ${input.context || ''}: ${learnings}`;
          const memId = db.save('workflow', memContent.substring(0, 2000), null);
          getEmbedding(memContent.substring(0, 512)).then(emb => db.updateEmbedding(memId, emb)).catch(e => console.warn(`[EMBED] Failed for memory #${memId}:`, e.message));

          await updateOperatorProfile(`**From article/course (${input.context || input.url}):**\n${learnings}`);
          console.log(`[LEARN] Learned from URL: ${input.url} \u2192 workflow #${memId}`);
          return `**Learned from page:**\n\n${learnings}\n\n\u2705 Saved to operator profile + memory.`;
        } catch (e) {
          return 'Learning from URL failed: ' + e.message;
        }
      }
      case 'knowledge_search': {
        try {
          const { execSync } = require('child_process');
          try { execSync('which qmd', { encoding: 'utf8', timeout: 3000 }); } catch (_) {
            return 'knowledge_search is not available \u2014 qmd is not installed. Use memory_search instead.';
          }
          const n = input.num_results || 5;
          const query = input.query.replace(/'/g, "'\\''");
          const result = execSync(
            `export PATH="$HOME/.bun/bin:$PATH" && qmd search '${query}' -c favor-knowledge -n ${n} --json`,
            { encoding: 'utf8', timeout: 10000 }
          );
          const parsed = JSON.parse(result);
          const results = Array.isArray(parsed) ? parsed : (parsed.results || []);
          if (!results.length) return 'No results found for: ' + input.query;
          return results.map((r, i) =>
            `[${i+1}] ${r.title || r.file} (score: ${Math.round((r.score || 0) * 100)}%)\n${r.snippet || ''}`
          ).join('\n\n---\n\n');
        } catch(e) {
          return 'Knowledge search error: ' + e.message;
        }
      }
      case 'design_system': {
        try {
          const { generateDesignSystem, formatMarkdown, formatCompact } = require('../uiux');
          const ds = generateDesignSystem(input.query, input.project_name);
          const fmt = input.format === 'markdown' ? formatMarkdown(ds) : formatCompact(ds);
          return fmt;
        } catch (e) {
          return 'Design system error: ' + e.message;
        }
      }
      case 'design_search': {
        try {
          const { searchDomain } = require('../uiux');
          return searchDomain(input.query, input.domain, input.num_results || 3);
        } catch (e) {
          return 'Design search error: ' + e.message;
        }
      }
      case 'sync_update': {
        syncBot.sync('bot', {
          type: input.type || 'action',
          summary: input.summary,
          objective: input.objective,
          next: input.next,
          decision: input.decision,
          reason: input.reason,
          status: 'success'
        });
        return `Sync updated: ${input.summary}`;
      }
      case 'sync_recover': {
        const recovery = syncBot.recover();
        return JSON.stringify({
          mission: recovery.mission,
          unfinished_tasks: recovery.unfinished_tasks,
          last_success: recovery.last_successful_action,
          last_failure: recovery.last_failed_action,
          blockers: recovery.open_blockers,
          next_step: recovery.recommended_next,
          recent: recovery.recent_events_summary.slice(-5)
        }, null, 2);
      }
      // ─── BUILD MODE ───
      case 'build_plan': {
        const workDir = input.work_dir || `/root/builds/${input.description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
        await sock.sendMessage(context.contact, { text: `\ud83d\udd28 *Build Mode* \u2014 Planning project in \`${workDir}\`...\nThis may take a minute or two.` });
        try {
          const plan = await buildMode.plan(input.description, workDir);
          buildMode.setState(context.contact, { workDir, description: input.description, plan, phase: 'planned' });
          return `Build plan created for ${workDir}:\n\n${plan}`;
        } catch (e) {
          return `Build planning failed: ${e.message}`;
        }
      }
      case 'build_execute': {
        await sock.sendMessage(context.contact, { text: `\u26a1 *Build Mode* \u2014 Executing task in \`${input.work_dir}\`...\nClaude Code is writing code. This may take a few minutes.` });
        try {
          const result = await buildMode.execute(input.task, input.work_dir, { context: input.context || '' });
          const state = buildMode.getState(context.contact);
          if (state) buildMode.setState(context.contact, { ...state, phase: 'building', lastTask: input.task });
          return `Build step completed:\n\n${result}`;
        } catch (e) {
          return `Build execution failed: ${e.message}`;
        }
      }
      case 'build_verify': {
        await sock.sendMessage(context.contact, { text: `\ud83d\udd0d *Build Mode* \u2014 Verifying build in \`${input.work_dir}\`...` });
        try {
          const result = await buildMode.verify(input.work_dir, input.requirements);
          const state = buildMode.getState(context.contact);
          if (state) buildMode.setState(context.contact, { ...state, phase: 'verified' });
          return `Build verification:\n\n${result}`;
        } catch (e) {
          return `Build verification failed: ${e.message}`;
        }
      }
      case 'build_raw': {
        await sock.sendMessage(context.contact, { text: `\ud83d\udd28 *Build Mode* \u2014 Running Claude Code in \`${input.work_dir}\`...` });
        try {
          const result = await buildMode.raw(input.prompt, input.work_dir);
          return `Claude Code result:\n\n${result}`;
        } catch (e) {
          return `Build command failed: ${e.message}`;
        }
      }
      // ─── GUARDIAN ───
      case 'guardian_scan': {
        const mode = input.mode || 'quick';
        await sock.sendMessage(context.contact, { text: `\ud83d\udee1\ufe0f *Guardian* \u2014 Running ${mode} scan on \`${input.target}\`...\nThis may take a few minutes.` });
        try {
          const { report, logs } = await guardian.scan(input.target, {
            mode,
            scope: input.scope || 'full',
          });
          const formatted = guardian.formatReport(report);
          return formatted;
        } catch (e) {
          return `Guardian scan failed: ${e.message}`;
        }
      }
      case 'guardian_report': {
        const last = guardian.getLastReport();
        if (!last) return 'No previous Guardian scan found. Run guardian_scan first.';
        return `Last scan: ${last.scannedAt}\n\n${guardian.formatReport(last.report)}`;
      }
      case 'guardian_status': {
        return guardian.formatGuardStatus();
      }
      // ─── SELF-CHECK / REMOTE ───
      case 'start_remote': {
        try {
          const dir = input.directory || '/root';
          const { execSync } = require('child_process');
          try { execSync('tmux kill-session -t claude-rc 2>/dev/null'); } catch {}
          execSync(`tmux new-session -d -s claude-rc -c "${dir}"`);
          execSync(`tmux send-keys -t claude-rc "claude --remote-control" Enter`);
          let sessionUrl = null;
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const pane = execSync('tmux capture-pane -t claude-rc -p', { encoding: 'utf8' });
              const match = pane.match(/(https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+)/);
              if (match) { sessionUrl = match[1]; break; }
              if (pane.includes('Yes, I trust this folder')) {
                execSync('tmux send-keys -t claude-rc Enter');
              }
            } catch {}
          }
          if (sessionUrl) {
            await sock.sendMessage(context.contact, { text: `\ud83d\udda5\ufe0f *Remote Code Session Ready*\n\nOpen on your phone:\n${sessionUrl}\n\nRunning in: ${dir}\nSession: tmux (survives disconnects)` });
            return '__IMAGE_SENT__';
          }
          return 'Remote session started but could not capture URL. Check tmux session "claude-rc" manually.';
        } catch (e) {
          return 'Failed to start remote session: ' + e.message;
        }
      }
      case 'selfcheck': {
        await sock.sendMessage(context.contact, { text: '\ud83d\udee1\ufe0f *Self-Check* \u2014 Running health checks and cleanup...' });
        try {
          const report = await selfCheck.runAll();
          return selfCheck.formatReport(report);
        } catch (e) {
          return `Self-check failed: ${e.message}`;
        }
      }
      // ─── TEACH MODE ───
      case 'teach_create': {
        try {
          const id = db.saveTeachCommand(
            context.contact,
            input.command_name,
            input.description || '',
            input.trigger_phrase,
            input.pipeline || []
          );
          return `\u2705 Taught command created!\n*#${id} \u2014 ${input.command_name}*\nTrigger: "${input.trigger_phrase}"\nSteps: ${(input.pipeline || []).length}\n\nSay "${input.trigger_phrase}" anytime to run it.`;
        } catch (e) {
          return `Failed to create taught command: ${e.message}`;
        }
      }
      case 'teach_list': {
        const commands = db.listTeachCommands(context.contact);
        if (!commands.length) return 'No taught commands yet. Teach me something! Say "teach: when I say X, do Y"';
        return '*Your Commands:*\n\n' + commands.map(c =>
          `*#${c.id} \u2014 ${c.command_name}* ${c.enabled ? '\u2705' : '\u23f8\ufe0f'}\n` +
          `  Trigger: "${c.trigger_phrase}"\n` +
          (c.description ? `  ${c.description}\n` : '') +
          `  Used ${c.execution_count}x` + (c.last_executed ? ` (last: ${c.last_executed})` : '')
        ).join('\n\n');
      }
      case 'teach_run': {
        const cmd = db.getTeachCommand(input.id);
        if (!cmd) return `Taught command #${input.id} not found.`;
        if (!cmd.enabled) return `Command "${cmd.command_name}" is disabled.`;
        const pipeline = JSON.parse(cmd.pipeline);
        if (!pipeline.length) return `Command "${cmd.command_name}" has no steps.`;

        await sock.sendMessage(context.contact, { text: `\u26a1 Running: *${cmd.command_name}* (${pipeline.length} steps)` });
        const results = [];
        for (let i = 0; i < pipeline.length; i++) {
          const step = pipeline[i];
          try {
            const result = await executeTool(step.tool, step.params || {}, context);
            results.push(`\u2713 Step ${i + 1}: ${step.description || step.tool} \u2014 OK`);
          } catch (e) {
            results.push(`\u2717 Step ${i + 1}: ${step.description || step.tool} \u2014 ${e.message}`);
            break;
          }
        }
        db.recordTeachExecution(cmd.id);
        return `*${cmd.command_name}* \u2014 Done\n\n${results.join('\n')}`;
      }
      case 'teach_update': {
        const cmd = db.getTeachCommand(input.id);
        if (!cmd) return `Taught command #${input.id} not found.`;
        const updates = {};
        if (input.command_name) updates.commandName = input.command_name;
        if (input.trigger_phrase) updates.triggerPhrase = input.trigger_phrase;
        if (input.description) updates.description = input.description;
        if (input.pipeline) updates.pipeline = input.pipeline;
        if (input.enabled !== undefined) updates.enabled = input.enabled;
        db.updateTeachCommand(input.id, updates);
        return `\u2705 Updated command #${input.id} \u2014 ${input.command_name || cmd.command_name}`;
      }
      case 'teach_delete': {
        const removed = db.deleteTeachCommand(input.id);
        return removed ? `\ud83d\uddd1\ufe0f Deleted taught command #${input.id}` : `Command #${input.id} not found.`;
      }

      default: return 'Unknown tool: ' + name;
    }
  }

  return {
    execute: executeTool,
    setSock(s) { sock = s; },
    updateConfig(c) { config = c; },
  };
}

module.exports = { createToolExecutor };
