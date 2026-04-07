// ─── ACCESS CONTROL ───
// Role-based access control for contacts, tools, and commands.
// Pure logic — no I/O, no platform connections.

class AccessControl {
  constructor({ config, PLATFORM, TOOLS }) {
    this.config = config;
    this.PLATFORM = PLATFORM;
    this.TOOLS = TOOLS;

    // LID-to-phone mapping (Baileys uses LID JIDs for incoming messages)
    this.lidToPhone = new Map();
    this.phoneToLid = new Map();

    // Track numbers verified via security phrase (resets on restart)
    this.verifiedNumbers = new Set();
    // Track numbers awaiting security phrase answer
    this.pendingAuth = new Set();

    // Tool access by role
    this.OPERATOR_ONLY_TOOLS = new Set([
      'self_update',
      'server_exec', 'read_file', 'write_file',
      'laptop_run_command', 'laptop_write_file', 'laptop_read_file', 'laptop_list_files',
      'laptop_open_app', 'laptop_open_url', 'laptop_screenshot', 'laptop_status',
      'browser_evaluate', 'browser_fill_from_vault',
      'email_search', 'email_read'
    ]);

    this.STAFF_TOOLS = new Set([
      'memory_save', 'memory_search', 'memory_forget',
      'web_search', 'knowledge_search',
      'cron_create', 'cron_list', 'cron_delete', 'cron_toggle',
      'topic_create', 'topic_switch', 'topic_list',
      'send_message', 'send_email', 'send_image',
      'vault_save', 'vault_get', 'vault_list', 'vault_delete',
      'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
      'browser_select', 'browser_fill_form', 'browser_get_fields',
      'browser_get_clickables', 'browser_get_text', 'browser_scroll',
      'browser_close', 'browser_status',
      'video_analyze', 'video_learn', 'learn_from_url'
    ]);

    this.CUSTOMER_TOOLS = new Set([
      'knowledge_search', 'web_search', 'memory_search'
    ]);

    // Admin slash commands — operator only
    this.ADMIN_COMMANDS = new Set(['/update', '/model', '/reload', '/clear', '/sync', '/recover']);
    // Staff slash commands
    this.STAFF_COMMANDS = new Set(['/status', '/memory', '/brain', '/crons', '/topics', '/help', '/laptop']);
  }

  // Allow config hot-reload
  updateConfig(config) {
    this.config = config;
  }

  registerLidMapping(lidJid, phoneJid) {
    if (lidJid && phoneJid) {
      this.lidToPhone.set(lidJid.split('@')[0].split(':')[0], phoneJid.split('@')[0].split(':')[0]);
      this.phoneToLid.set(phoneJid.split('@')[0].split(':')[0], lidJid.split('@')[0].split(':')[0]);
    }
  }

  resolvePhone(jid) {
    if (jid && jid.startsWith('tg_')) return jid;
    if (jid.endsWith('@lid')) {
      const lidNum = jid.split('@')[0].split(':')[0];
      return this.lidToPhone.get(lidNum) || null;
    }
    return jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  }

  isOperator(jid) {
    if (this.PLATFORM === 'telegram') {
      const opChatId = this.config.telegram?.operatorChatId;
      if (!opChatId) return true;
      return jid === `tg_${opChatId}` || this.verifiedNumbers.has(jid);
    }
    const opNum = (this.config.whatsapp.operatorNumber || '').replace('+', '');
    if (!opNum) return true;
    const phone = this.resolvePhone(jid);
    if (!phone) return false;
    return phone.includes(opNum) || this.verifiedNumbers.has(phone);
  }

  isStaff(jid) {
    const pConfig = this.PLATFORM === 'telegram' ? (this.config.telegram || {}) : this.config.whatsapp;
    const staffList = pConfig.staff || [];
    if (!staffList.length) return false;
    const phone = this.resolvePhone(jid);
    if (!phone) return false;
    if (this.PLATFORM === 'telegram') {
      return staffList.some(s => jid === `tg_${s}` || jid === s);
    }
    return staffList.some(s => phone.includes(s.replace('+', '')));
  }

  getRole(jid) {
    if (this.isOperator(jid)) return 'operator';
    if (this.isStaff(jid)) return 'staff';
    return 'customer';
  }

  canUseTool(role, toolName) {
    if (role === 'operator') return true;
    if (role === 'staff') return this.STAFF_TOOLS.has(toolName);
    return this.CUSTOMER_TOOLS.has(toolName);
  }

  canUseCommand(role, cmd) {
    if (role === 'operator') return true;
    if (role === 'staff') return this.STAFF_COMMANDS.has(cmd) || !this.ADMIN_COMMANDS.has(cmd);
    return cmd === '/help' || cmd === '/status';
  }

  getToolsForRole(role) {
    if (role === 'operator') return this.TOOLS;
    return this.TOOLS.filter(t => this.canUseTool(role, t.function.name));
  }

  isAllowed(jid) {
    if (this.PLATFORM === 'telegram') {
      const policy = this.config.telegram?.dmPolicy || 'open';
      if (policy !== 'allowlist') return true;
      const allowed = this.config.telegram?.allowFrom || [];
      if (!allowed.length) return true;
      return allowed.includes(jid) || allowed.some(a => jid === `tg_${a}`);
    }
    if (this.config.whatsapp.dmPolicy !== 'allowlist') return true;
    const combined = [...new Set([
      ...(this.config.whatsapp.allowFrom || []),
      ...(this.config.whatsapp.trustedContacts || []),
      ...(this.config.whatsapp.staff || [])
    ])];
    if (!combined.length) return true;

    const phone = this.resolvePhone(jid);
    if (phone) {
      return combined.some(a => phone.includes(a.replace('+', '')));
    }

    // Unknown LID — pass through to auth gate (they can authenticate via security phrase)
    if (jid.endsWith('@lid')) {
      console.log(`[SECURITY] Unknown LID ${jid.split('@')[0].split(':')[0]} — passing to auth gate`);
      return true;
    }

    return false;
  }

  isGroup(jid) {
    if (this.PLATFORM === 'telegram') {
      if (jid && jid.startsWith('tg_-')) return true;
      return false;
    }
    return jid.endsWith('@g.us');
  }

  // Periodic cleanup to prevent memory leaks
  cleanup() {
    if (this.lidToPhone.size > 5000) {
      const keys = [...this.lidToPhone.keys()];
      const excess = keys.length - 5000;
      for (let i = 0; i < excess; i++) {
        const phone = this.lidToPhone.get(keys[i]);
        this.lidToPhone.delete(keys[i]);
        if (phone) this.phoneToLid.delete(phone);
      }
    }
    if (this.pendingAuth.size > 100) this.pendingAuth.clear();
  }
}

module.exports = AccessControl;
