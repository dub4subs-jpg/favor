// plugins/example-plugin.js — Example plugin demonstrating the Favor plugin contract
//
// This file shows how to create a custom tool plugin.
// Drop any .js file in this directory that exports the required fields,
// and it will be automatically loaded on startup.
//
// Required fields:
//   name        - Unique tool name (string)
//   description - What this tool does (string, shown to the AI)
//   execute     - Async function(args, context) that runs the tool
//
// Optional fields:
//   keywords    - Array of trigger words for tool-selector matching
//   trustLevel  - Minimum trust: 'operator' (default), 'staff', or 'customer'
//   parameters  - JSON Schema describing the tool's parameters

module.exports = {
  name: 'example_hello',
  description: 'Example plugin that greets a user. Use this to test that the plugin system is working.',
  keywords: ['hello plugin', 'test plugin', 'example plugin'],
  trustLevel: 'operator',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet (default: World)' },
    },
  },

  /**
   * Execute the tool.
   * @param {Object} args - Parsed arguments matching the parameters schema
   * @param {Object} context - Runtime context with dependencies:
   *   context.config  - Bot configuration (config.json)
   *   context.db      - FavorMemory database instance
   *   context.vault   - Vault encryption instance (if configured)
   *   context.contact - JID of the requesting contact
   *   context.role    - Trust level of the requesting contact ('operator'|'staff'|'customer')
   * @returns {string|Object} Result to send back to the AI
   */
  async execute(args, context) {
    const name = args.name || 'World';
    const botName = context.config?.identity?.name || 'Favor';
    return `Hello ${name}! This is the example plugin running inside ${botName}. Plugin system is working.`;
  },
};
