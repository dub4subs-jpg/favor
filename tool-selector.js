// tool-selector.js — Smart Tool Selection for Favor
// Pre-filters tools based on route + message keywords to reduce token waste
// Typically reduces 89 tools (~2700 tokens) to 10-20 tools (~300-800 tokens)

const TOOL_GROUPS = {
  core: new Set(['memory_save', 'memory_search', 'web_search', 'send_message', 'knowledge_search', 'entity_search', 'conversation_recall']),
  laptop: /^laptop_/,
  phone: /^phone_/,
  browser: /^browser_/,
  vault: /^vault_/,
  build: /^build_/,
  guardian: /^guardian_|^selfcheck$/,
  video: /^video_/,
  cron: /^cron_/,
  topic: /^topic_/,
  teach: /^teach_/,
  email: /^email_|^send_email$/,
  remote: /^device_|^offload_|^wake_|^start_remote$/,
  misc: new Set([
    'server_exec', 'read_file', 'write_file', 'send_image', 'get_2fa_code',
    'learn_from_url', 'location_get', 'create_barcode', 'generate_flyer',
    'save_to_drive', 'design_system', 'design_search', 'glasses_status',
    'glasses_analyze', 'spawn_research', 'check_tasks', 'memory_forget',
    'sync_update', 'sync_recover', 'phone_notify', 'phone_notifications',
  ]),
};

// Which tool groups to include per route
const ROUTE_GROUPS = {
  tool: null,     // null = all groups
  hybrid: null,
  agent: null,
  full: ['core', 'browser', 'vault', 'email', 'misc', 'video'],
  chat: ['core'],
  mini: ['core', 'misc'],
  memory: ['core'],
  claude: ['core', 'misc'],
  gemini: [],
  kimi: [],
};

// Keywords that activate specific tool groups
const KEYWORD_GROUPS = {
  laptop: /screenshot|screen|my computer|laptop|desktop|file on my/i,
  phone: /phone|camera|sms|text message|selfie|adb/i,
  browser: /browser|navigate|fill form|checkout|open.*url|website|click on/i,
  vault: /vault|card|address|my info|payment|credit/i,
  build: /build|code|create.*app|project|deploy/i,
  guardian: /scan|guardian|health|audit/i,
  video: /video|youtube|tiktok|watch this|learn from/i,
  cron: /cron|schedule|reminder|alarm|every day/i,
  email: /email|inbox|send.*mail|gmail/i,
  teach: /teach|command|recipe|shortcut/i,
  remote: /remote|offload|device|wake laptop/i,
};

// Trust-level restrictions (same as favor.js)
const STAFF_BLOCKED = new Set([
  'server_exec', 'write_file', 'laptop_write_file', 'laptop_run_command',
  'guardian_scan', 'guardian_status', 'build_plan', 'build_execute',
  'build_verify', 'build_raw', 'offload_task', 'selfcheck',
]);
const CUSTOMER_ONLY = new Set(['web_search', 'memory_search', 'knowledge_search']);

function toolMatchesGroup(toolName, group) {
  if (group instanceof Set) return group.has(toolName);
  if (group instanceof RegExp) return group.test(toolName);
  return false;
}

function selectTools(allTools, route, messageText, trustLevel) {
  // Determine which groups to include
  const baseGroups = ROUTE_GROUPS[route];
  const activeGroups = new Set(baseGroups || Object.keys(TOOL_GROUPS));

  // Always include core
  activeGroups.add('core');

  // Scan message for keyword-activated groups
  if (messageText) {
    for (const [group, pattern] of Object.entries(KEYWORD_GROUPS)) {
      if (pattern.test(messageText)) activeGroups.add(group);
    }
  }

  // Filter tools by active groups
  let filtered = allTools.filter(tool => {
    const name = tool.function.name;
    for (const groupName of activeGroups) {
      const group = TOOL_GROUPS[groupName];
      if (group && toolMatchesGroup(name, group)) return true;
    }
    return false;
  });

  // Apply trust-level filtering
  if (trustLevel === 'staff') {
    filtered = filtered.filter(t => !STAFF_BLOCKED.has(t.function.name));
  } else if (trustLevel === 'customer') {
    filtered = filtered.filter(t => CUSTOMER_ONLY.has(t.function.name));
  } else if (trustLevel === 'guest') {
    return [];
  }

  return filtered;
}

module.exports = { selectTools };
