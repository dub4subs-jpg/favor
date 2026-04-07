// core/tool-definitions.js — OpenAI-format tool definitions for the Favor framework
// Extracted from favor.js to keep tool metadata separate from execution logic.
// These definitions are used by the OpenAI function-calling loop (GPT-4o fallback).

function oaiTool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

const TOOLS = [
  // ─── LAPTOP TOOLS ───
  oaiTool('laptop_read_file', 'Read a file from the laptop.', { type: 'object', properties: { file_path: { type: 'string', description: 'Full Windows path' } }, required: ['file_path'] }),
  oaiTool('laptop_list_files', 'List files in a directory on the laptop.', { type: 'object', properties: { directory: { type: 'string', description: 'Full Windows path' } }, required: ['directory'] }),
  oaiTool('laptop_run_command', 'Run a command on the laptop.', { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }),
  oaiTool('laptop_write_file', 'Write content to a file on the laptop.', { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }),
  oaiTool('laptop_open_app', 'Open a GUI application on the laptop screen. ALWAYS use the full executable path (e.g. "C:\\Program Files\\Adobe\\Adobe Illustrator 2025\\Support Files\\Contents\\Windows\\Illustrator.exe"). Never pass just the app name.', { type: 'object', properties: { app: { type: 'string', description: 'Full path to the executable, e.g. C:\\Program Files\\Adobe\\Adobe Illustrator 2025\\Support Files\\Contents\\Windows\\Illustrator.exe' } }, required: ['app'] }),
  oaiTool('laptop_open_url', 'Open a URL in the default browser on the laptop screen. Use this for opening websites, YouTube videos, search results, etc. The URL will open visibly on the desktop.', { type: 'object', properties: { url: { type: 'string', description: 'Full URL to open, e.g. https://www.youtube.com/results?search_query=snoop+dogg' } }, required: ['url'] }),
  oaiTool('laptop_status', 'Check if laptop is online.', { type: 'object', properties: {} }),
  oaiTool('laptop_screenshot', 'Take a screenshot of the laptop screen and send it to the operator. Always use this when asked for a screenshot.', { type: 'object', properties: {} }),

  // ─── MEMORY TOOLS ───
  oaiTool('memory_save', 'Save to long-term memory. Use proactively for important facts, decisions, preferences, tasks, workflow observations, or personality observations about your own communication style.', { type: 'object', properties: { category: { type: 'string', enum: ['fact', 'decision', 'preference', 'task', 'workflow', 'personality'] }, content: { type: 'string' }, status: { type: 'string' } }, required: ['category', 'content'] }),
  oaiTool('memory_search', 'Search long-term memory.', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  oaiTool('memory_forget', 'Soft-forget memories matching a query (marks as superseded instead of deleting).', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  oaiTool('memory_pin', 'Pin a memory so it never decays (for birthdays, core facts, allergies, etc). Use memory_search first to find the ID.', { type: 'object', properties: { id: { type: 'integer' }, unpin: { type: 'boolean', description: 'Set true to unpin instead' } }, required: ['id'] }),
  oaiTool('memory_resolve', 'Mark a memory/task as DONE so it stops being resurfaced. Use this when a task is completed, an invoice is sent, a decision is finalized, or any memory is no longer actionable. Search for the memory first to get its ID.', { type: 'object', properties: { id: { type: 'number', description: 'Memory ID to mark as resolved' } }, required: ['id'] }),

  // ─── SERVER TOOLS ───
  oaiTool('server_exec', 'Run a shell command on the server (DigitalOcean droplet).', { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] }),
  oaiTool('read_file', 'Read a file on the server.', { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path on server' } }, required: ['file_path'] }),
  oaiTool('write_file', 'Write content to a file on the server.', { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }),

  // ─── WEB TOOLS ───
  oaiTool('web_search', 'Search the web using Brave Search API.', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),

  // ─── SCHEDULING TOOLS ───
  oaiTool('cron_create', 'Create a scheduled task. Schedule formats: "every 5m", "every 2h", "daily 09:00", "weekly mon 09:00".', { type: 'object', properties: { label: { type: 'string', description: 'Short name for this cron' }, schedule: { type: 'string', description: 'Schedule expression' }, task: { type: 'string', description: 'What to do when triggered' } }, required: ['label', 'schedule', 'task'] }),
  oaiTool('cron_list', 'List all scheduled tasks.', { type: 'object', properties: {} }),
  oaiTool('cron_delete', 'Delete a scheduled task by ID.', { type: 'object', properties: { id: { type: 'number', description: 'Cron ID to delete' } }, required: ['id'] }),
  oaiTool('cron_toggle', 'Enable or disable a scheduled task.', { type: 'object', properties: { id: { type: 'number' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] }),

  // ─── SYSTEM TOOLS ───
  oaiTool('self_update', 'Update the bot to the latest version from GitHub. Pulls new code, checks for errors, and restarts. Only the operator can use this. The bot will briefly go offline during restart.', { type: 'object', properties: { confirm: { type: 'boolean', description: 'Set to true to confirm the update' } }, required: ['confirm'] }),

  // ─── TOPIC TOOLS ───
  oaiTool('topic_create', 'Create a new conversation topic/branch.', { type: 'object', properties: { name: { type: 'string', description: 'Topic name' } }, required: ['name'] }),
  oaiTool('topic_switch', 'Switch to an existing topic by ID.', { type: 'object', properties: { id: { type: 'number', description: 'Topic ID to switch to' } }, required: ['id'] }),
  oaiTool('topic_list', 'List all conversation topics for the current contact.', { type: 'object', properties: {} }),

  // ─── EMAIL TOOLS ───
  oaiTool('email_search', 'Search the operator\'s Gmail inbox. Use Gmail search syntax (e.g. "from:amazon subject:order", "is:unread", "newer_than:7d"). Returns subject, sender, date, and body preview for each result.', { type: 'object', properties: { query: { type: 'string', description: 'Gmail search query' }, max_results: { type: 'number', description: 'Max emails to return (default 5, max 10)' } }, required: ['query'] }),
  oaiTool('email_read', 'Read the full content of a specific email by message ID. Use after email_search to get the full body of a specific email.', { type: 'object', properties: { message_id: { type: 'string', description: 'Gmail message ID from email_search results' } }, required: ['message_id'] }),
  oaiTool('send_email', 'Send an email via Gmail API. Can include a PDF attachment. Use for invoices, follow-ups, etc.', { type: 'object', properties: { to: { type: 'string', description: 'Recipient email address' }, subject: { type: 'string', description: 'Email subject line' }, body: { type: 'string', description: 'Email body text' }, attachment: { type: 'string', description: 'Optional absolute path to a file to attach (e.g. /tmp/inv101.pdf)' } }, required: ['to', 'subject', 'body'] }),
  oaiTool('send_message', 'Proactively send a message to a contact.', { type: 'object', properties: { contact: { type: 'string', description: 'Phone number with country code (e.g. +1XXXXXXXXXX)' }, message: { type: 'string' } }, required: ['contact', 'message'] }),
  oaiTool('send_image', 'Forward the last received image to a contact, with an optional caption.', { type: 'object', properties: { contact: { type: 'string', description: 'Phone number with country code (e.g. +1XXXXXXXXXX)' }, caption: { type: 'string', description: 'Optional caption to send with the image' } }, required: ['contact'] }),

  // ─── VAULT TOOLS ───
  oaiTool('vault_save', 'Save sensitive info (card, address, ID, personal details) to the encrypted vault. For cards: include number, exp, cvv, name, zip. For addresses: include full address fields. For identity: include name, dob, email, phone, passport, etc.', { type: 'object', properties: { label: { type: 'string', description: 'Unique key e.g. "visa_card", "home_address", "passport"' }, category: { type: 'string', enum: ['card', 'address', 'identity', 'general'], description: 'Type of data' }, data: { type: 'object', description: 'The data to store (will be encrypted)' } }, required: ['label', 'category', 'data'] }),
  oaiTool('vault_get', 'Retrieve decrypted data from the vault by label.', { type: 'object', properties: { label: { type: 'string', description: 'The vault entry label' } }, required: ['label'] }),
  oaiTool('vault_list', 'List all vault entries (labels and categories only, no sensitive data shown).', { type: 'object', properties: { category: { type: 'string', description: 'Optional filter by category' } } }),
  oaiTool('vault_delete', 'Delete a vault entry by label.', { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }),

  // ─── BROWSER TOOLS ───
  oaiTool('browser_navigate', 'Open a URL in the headless browser. Use this to visit websites for booking, shopping, research.', { type: 'object', properties: { url: { type: 'string', description: 'Full URL to navigate to' } }, required: ['url'] }),
  oaiTool('browser_screenshot', 'Take a screenshot of the current browser page and send it to the operator. Use to show search results, booking options, checkout pages.', { type: 'object', properties: { label: { type: 'string', description: 'Short label for the screenshot (e.g. "checkout", "flights")' } } }),
  oaiTool('browser_click', 'Click an element on the page by CSS selector.', { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the element to click' } }, required: ['selector'] }),
  oaiTool('browser_type', 'Type text into an input field by CSS selector.', { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the input' }, text: { type: 'string', description: 'Text to type' }, clear: { type: 'boolean', description: 'Clear the field first (default true)' } }, required: ['selector', 'text'] }),
  oaiTool('browser_select', 'Select an option from a dropdown.', { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] }),
  oaiTool('browser_fill_form', 'Fill multiple form fields at once. Pass a map of CSS selector to value.', { type: 'object', properties: { fields: { type: 'object', description: 'Map of CSS selector -> value to fill' } }, required: ['fields'] }),
  oaiTool('browser_get_fields', 'Get all visible form fields on the current page. Use this to understand what fields need to be filled.', { type: 'object', properties: {} }),
  oaiTool('browser_get_clickables', 'Get all visible buttons and links on the page. Use to find what to click next.', { type: 'object', properties: {} }),
  oaiTool('browser_get_text', 'Get the text content of the page or a specific element.', { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector (default: body)' } } }),
  oaiTool('browser_scroll', 'Scroll the page up or down.', { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number', description: 'Pixels to scroll (default 500)' } } }),
  oaiTool('browser_evaluate', 'Run JavaScript code in the browser page context. Use for complex interactions.', { type: 'object', properties: { code: { type: 'string', description: 'JavaScript to execute in the page' } }, required: ['code'] }),
  oaiTool('browser_close', 'Close the browser session.', { type: 'object', properties: {} }),
  oaiTool('browser_status', 'Check if a browser session is active and get current page info.', { type: 'object', properties: {} }),
  oaiTool('browser_read_page', 'Read a webpage and extract clean text content (strips nav, ads, footers). Much better than browser_get_text for understanding page content. Optionally navigate to a URL first.', { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to and read (optional — reads current page if omitted)' } } }),
  oaiTool('browser_crawl', 'Crawl multiple pages starting from a URL. Follows links on the same domain and extracts clean content from each page. Good for researching a website.', { type: 'object', properties: { url: { type: 'string', description: 'Starting URL to crawl' }, maxPages: { type: 'number', description: 'Max pages to crawl (default 5)' }, maxDepth: { type: 'number', description: 'Max link depth (default 2)' }, match: { type: 'string', description: 'Glob pattern to filter URLs (e.g. "**/products/*")' } }, required: ['url'] }),
  oaiTool('browser_fill_from_vault', 'Fill a checkout/payment form using saved vault data. Card numbers and sensitive data are decrypted LOCALLY and filled directly into the browser — they never pass through this conversation. Use this instead of vault_get + browser_fill_form for payment info.', { type: 'object', properties: { vault_label: { type: 'string', description: 'Vault entry label (e.g. "visa_card", "home_address")' }, field_mapping: { type: 'object', description: 'Map of CSS selector -> vault field name (e.g. {"#card-number": "number", "#exp": "exp", "#cvv": "cvv", "#name": "name"})' } }, required: ['vault_label', 'field_mapping'] }),

  // ─── PLAYWRIGHT TOOLS (advanced browser automation via @playwright/cli) ───
  // Uses accessibility snapshots with ref-based targeting — more reliable than CSS selectors
  // Install: npm install -g @playwright/cli
  oaiTool('playwright_navigate', 'Open a URL in the Playwright browser (advanced, headless). Better than browser_navigate for modern SPAs and anti-bot sites. Uses accessibility-based element targeting.', { type: 'object', properties: { url: { type: 'string', description: 'Full URL to navigate to' } }, required: ['url'] }),
  oaiTool('playwright_snapshot', 'Get an accessibility snapshot of the Playwright browser page. Returns an element tree with ref numbers (e.g. ref=42) you can use with playwright_click and playwright_fill. Always call this before interacting with elements.', { type: 'object', properties: { element: { type: 'string', description: 'Optional ref to focus snapshot on (e.g. "ref=42")' } } }),
  oaiTool('playwright_click', 'Click an element in the Playwright browser by ref number or text. Use playwright_snapshot first to find the ref. Examples: "ref=42", "Submit", "Login".', { type: 'object', properties: { target: { type: 'string', description: 'Element ref (e.g. "ref=42") or visible text to click' } }, required: ['target'] }),
  oaiTool('playwright_fill', 'Fill a form field in the Playwright browser. Use playwright_snapshot to find the ref first.', { type: 'object', properties: { target: { type: 'string', description: 'Element ref (e.g. "ref=15") or label text' }, text: { type: 'string', description: 'Text to fill into the field' } }, required: ['target', 'text'] }),
  oaiTool('playwright_screenshot', 'Take a screenshot of the Playwright browser page and send it.', { type: 'object', properties: { label: { type: 'string', description: 'Short label (e.g. "checkout", "results")' } } }),
  oaiTool('playwright_type', 'Type text using keyboard simulation in the Playwright browser. Unlike fill, this simulates individual keystrokes. Good for autocomplete fields or search boxes.', { type: 'object', properties: { text: { type: 'string', description: 'Text to type' } }, required: ['text'] }),
  oaiTool('playwright_press', 'Press a key in the Playwright browser (Enter, Tab, Escape, ArrowDown, etc.).', { type: 'object', properties: { key: { type: 'string', description: 'Key name: Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace, etc.' } }, required: ['key'] }),
  oaiTool('playwright_select', 'Select a dropdown option in the Playwright browser.', { type: 'object', properties: { target: { type: 'string', description: 'Element ref or label' }, value: { type: 'string', description: 'Value to select' } }, required: ['target', 'value'] }),
  oaiTool('playwright_hover', 'Hover over an element in the Playwright browser.', { type: 'object', properties: { target: { type: 'string', description: 'Element ref or text' } }, required: ['target'] }),
  oaiTool('playwright_evaluate', 'Run JavaScript code in the Playwright browser page context.', { type: 'object', properties: { code: { type: 'string', description: 'JavaScript to execute' } }, required: ['code'] }),
  oaiTool('playwright_tabs', 'List all open tabs, open a new tab, select a tab, or close a tab in the Playwright browser.', { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'Tab action' }, value: { type: 'string', description: 'URL for new tab, or tab index for select/close' } }, required: ['action'] }),
  oaiTool('playwright_close', 'Close the Playwright browser session.', { type: 'object', properties: {} }),
  oaiTool('playwright_status', 'Check if a Playwright browser session is active.', { type: 'object', properties: {} }),

  // ─── VIDEO TOOLS ───
  oaiTool('video_analyze', 'Analyze a video from a URL (YouTube, TikTok, Twitter, direct links). Downloads, extracts frames + audio, transcribes, and provides a full analysis. Use when the operator shares a video link and wants to understand, learn from, or discuss its content.', { type: 'object', properties: { url: { type: 'string', description: 'Video URL (YouTube, TikTok, Twitter, direct .mp4, etc.)' }, context: { type: 'string', description: 'Optional context about what to focus on' } }, required: ['url'] }),
  oaiTool('video_learn', 'Analyze a video AND save the key learnings to long-term memory. Use when the operator wants to learn from or remember a video\'s content.', { type: 'object', properties: { url: { type: 'string', description: 'Video URL' }, context: { type: 'string', description: 'What topic or aspect to focus on' } }, required: ['url'] }),

  // ─── LEARNING TOOLS ───
  oaiTool('learn_from_url', 'Read a webpage/article/course page and extract techniques, principles, and knowledge. Saves learnings to operator profile. Use when operator says "learn this", "study this", or shares an article/course URL to learn from.', { type: 'object', properties: { url: { type: 'string', description: 'URL to learn from' }, context: { type: 'string', description: 'What to focus on or how to apply it' } }, required: ['url'] }),

  // ─── KNOWLEDGE SEARCH ───
  oaiTool('knowledge_search', 'Search the knowledge base files for relevant information. Uses fast keyword search (BM25) across all indexed markdown docs. Use when you need to look up skills, procedures, or any documented knowledge.', {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (keywords work best, e.g. "laptop tools", "scheduling", "browser automation")' },
      num_results: { type: 'number', description: 'Number of results to return (default: 5)' }
    },
    required: ['query']
  }),

  // ─── UI/UX DESIGN SYSTEM TOOLS ───
  oaiTool('design_system', 'Generate a complete UI/UX design system recommendation for any product, website, or app. Returns style, colors, typography, layout pattern, effects, and anti-patterns based on 161 industry-specific rules. Use when the operator asks to design something, needs a color palette, wants UI style advice, or is starting a new website/app project.', {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What is being designed (e.g. "beauty spa website", "SaaS dashboard", "e-commerce luxury store", "fitness app")' },
      project_name: { type: 'string', description: 'Optional project name for the output header' },
      format: { type: 'string', enum: ['compact', 'markdown'], description: 'Output format: compact (WhatsApp-friendly, default) or markdown (detailed)' }
    },
    required: ['query']
  }),
  oaiTool('design_search', 'Search the UI/UX knowledge base for specific design guidance. Domains: style (67 UI styles), color (161 palettes), typography (57 font pairings), landing (24 page patterns), product (161 product types). Use for quick lookups like "glassmorphism", "serif fonts", or "SaaS color palette".', {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (e.g. "glassmorphism", "luxury fonts", "fintech colors")' },
      domain: { type: 'string', enum: ['style', 'color', 'typography', 'landing', 'product'], description: 'Which design domain to search' },
      num_results: { type: 'number', description: 'Number of results (default: 3)' }
    },
    required: ['query', 'domain']
  }),

  // ─── SYNC TOOLS ───
  oaiTool('sync_update', 'Update the shared memory sync state. Use this to log important actions, decisions, task changes, or file changes so Claude Code stays in sync.', {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What happened or changed' },
      type: { type: 'string', enum: ['action', 'decision', 'task_update', 'file_change', 'error', 'milestone'], description: 'Type of update' },
      objective: { type: 'string', description: 'Current mission/objective (if changed)' },
      next: { type: 'string', description: 'What should happen next' },
      decision: { type: 'string', description: 'Decision made (if applicable)' },
      reason: { type: 'string', description: 'Why this decision was made' }
    },
    required: ['summary', 'type']
  }),
  oaiTool('sync_recover', 'Recover shared state after crash/disconnect. Returns the last known state, unfinished tasks, recent events, and recommended next action.', {
    type: 'object', properties: {}, required: []
  }),

  // ─── BUILD MODE TOOLS ───
  oaiTool('build_plan', 'Plan a software project. Claude Code analyzes requirements and creates a phased build plan. Use when operator says "build this", "build me", "create an app", etc.', {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What to build — features, tech stack, purpose' },
      work_dir: { type: 'string', description: 'Directory to build in (default: /root/builds/<project-name>)' },
    },
    required: ['description']
  }),
  oaiTool('build_execute', 'Execute a build task using Claude Code. Runs a specific step from the build plan — creates files, writes code, installs deps, commits. Use after build_plan to run each phase.', {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The specific task to execute (from the build plan)' },
      work_dir: { type: 'string', description: 'Project directory' },
      context: { type: 'string', description: 'Additional context (previous plan, requirements, etc.)' },
    },
    required: ['task', 'work_dir']
  }),
  oaiTool('build_verify', 'Verify a build — Claude Code reviews the project, runs tests, checks requirements are met.', {
    type: 'object',
    properties: {
      work_dir: { type: 'string', description: 'Project directory to verify' },
      requirements: { type: 'string', description: 'What the project should do (from original description)' },
    },
    required: ['work_dir', 'requirements']
  }),
  oaiTool('build_raw', 'Run a freeform Claude Code command in a project. For quick fixes, adding features, debugging — anything that doesn\'t need the full plan/execute flow.', {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to do (Claude Code gets full tool access)' },
      work_dir: { type: 'string', description: 'Working directory' },
    },
    required: ['prompt', 'work_dir']
  }),

  // ─── GUARDIAN TOOLS ───
  oaiTool('guardian_scan', 'Run a Guardian health scan on a project. Discovers features, validates code quality, checks security, detects regressions. Use when operator asks to "scan", "check health", "run guardian", "audit", or "test" a project.', {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Project directory to scan (e.g. /root/he-qc-hub)' },
      mode: { type: 'string', enum: ['smoke', 'quick', 'feature', 'deep', 'regression', 'deploy'], description: 'Scan depth (default: quick)' },
      scope: { type: 'string', enum: ['full', 'frontend', 'backend', 'api', 'database', 'security'], description: 'What to scan (default: full)' },
    },
    required: ['target']
  }),
  oaiTool('guardian_report', 'Get the last Guardian scan report. Use after guardian_scan to retrieve formatted results, or when operator asks about the last scan.', {
    type: 'object', properties: {},
  }),
  oaiTool('guardian_status', 'Show Guardian runtime protection status — current API spend, request counts, rate limits, and recent security alerts.', {
    type: 'object', properties: {},
  }),

  // ─── REMOTE + SELFCHECK ───
  oaiTool('start_remote', 'Start a remote Claude Code session. Spins up a tmux session with claude --rc and sends the session URL to the operator. Use when operator says "start remote", "remote session", "code from phone", etc.', { type: 'object', properties: { directory: { type: 'string', description: 'Working directory for the session (default: /root)' } } }),
  oaiTool('selfcheck', 'Run a self-check on the bot — checks process health, system resources, database integrity, config validity, security, and runs cleanup/sanitization. Use when operator asks for "self check", "health report", "system status", "clean up", or "sanitize".', {
    type: 'object', properties: {},
  }),

  // ─── TEACH MODE ───
  oaiTool('teach_create', 'Create a new custom command. The operator teaches you a reusable sequence of steps that can be triggered later by a short phrase. Use when operator says "teach:", "when I say X do Y", "create a command", "add a shortcut". Extract the trigger phrase and pipeline of tool steps.', {
    type: 'object',
    properties: {
      command_name: { type: 'string', description: 'Human-readable name (e.g. "Morning Briefing", "Weekly Report")' },
      trigger_phrase: { type: 'string', description: 'Short phrase to trigger this command (e.g. "morning", "weekly report")' },
      description: { type: 'string', description: 'What this command does' },
      pipeline: {
        type: 'array',
        description: 'Ordered list of tool steps to execute',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name to call (e.g. "memory_search", "web_search", "server_exec")' },
            params: { type: 'object', description: 'Parameters for the tool call' },
            description: { type: 'string', description: 'What this step does' },
          },
          required: ['tool', 'params'],
        },
      },
    },
    required: ['command_name', 'trigger_phrase', 'pipeline'],
  }),
  oaiTool('teach_list', 'List all custom commands the operator has taught. Shows name, trigger, usage count, and status.', {
    type: 'object', properties: {},
  }),
  oaiTool('teach_run', 'Execute a taught command by ID. Runs each step in the pipeline sequentially.', {
    type: 'object',
    properties: { id: { type: 'number', description: 'Taught command ID' } },
    required: ['id'],
  }),
  oaiTool('teach_update', 'Update an existing taught command — change its name, trigger, description, pipeline, or enable/disable it.', {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Taught command ID' },
      command_name: { type: 'string' },
      trigger_phrase: { type: 'string' },
      description: { type: 'string' },
      pipeline: { type: 'array', items: { type: 'object' } },
      enabled: { type: 'boolean' },
    },
    required: ['id'],
  }),
  oaiTool('teach_delete', 'Delete a taught command by ID.', {
    type: 'object',
    properties: { id: { type: 'number', description: 'Taught command ID' } },
    required: ['id'],
  }),
];

// ─── TOOL RISK CLASSIFICATION ───
// Used by sandbox (Phase 1) and MCP server (Phase 3) to determine execution safety.
// 'dangerous' = goes through sandbox, 'moderate' = monitored, 'safe' = default (no restrictions)
const TOOL_RISK = {
  server_exec: 'dangerous',
  laptop_run_command: 'dangerous',
  phone_shell: 'dangerous',
  browser_evaluate: 'dangerous',
  write_file: 'moderate',
  laptop_write_file: 'moderate',
  build_execute: 'moderate',
  build_raw: 'moderate',
};

module.exports = { TOOLS, oaiTool, TOOL_RISK };
