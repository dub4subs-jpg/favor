#!/usr/bin/env node
'use strict';

/**
 * sync-cli.js — CLI interface for the Memory Sync Bot
 * Used by Claude Code to read/write shared state with the bot.
 *
 * Usage:
 *   node sync-cli.js status          — Show current state summary
 *   node sync-cli.js recover         — Full recovery report
 *   node sync-cli.js events [N]      — Show last N events (default 20)
 *   node sync-cli.js sync <json>     — Write a sync update from Claude
 *   node sync-cli.js handoff <json>  — Write a handoff note from Claude
 *   node sync-cli.js checkpoint [reason] — Create a checkpoint
 *   node sync-cli.js drift           — Check for drift
 *   node sync-cli.js state           — Raw master state JSON
 */

const syncBot = require('./sync');
const cmd = process.argv[2];
const arg = process.argv[3];

switch (cmd) {
  case 'status': {
    const state = syncBot.loadState();
    const drift = syncBot.detectDrift(state);
    const events = syncBot.readRecentEvents(5);
    console.log('=== Memory Sync Status ===');
    console.log(`Objective: ${state.current_objective}`);
    console.log(`Bot: ${state.current_agents.bot.status} — ${state.current_agents.bot.current_action || 'idle'}`);
    console.log(`Claude: ${state.current_agents.claude.status} — ${state.current_agents.claude.current_action || 'idle'}`);
    console.log(`Active tasks: ${(state.active_tasks || []).filter(t => t.status !== 'done').length}`);
    console.log(`Blockers: ${(state.open_blockers || []).length}`);
    console.log(`Last updated: ${state.last_updated_at} by ${state.last_updated_by}`);
    console.log(`\nRecent events:`);
    for (const e of events) {
      console.log(`  [${e.timestamp.slice(11,19)}] ${e.source_agent}: ${e.summary}`);
    }
    if (drift.length > 0) {
      console.log(`\nDrift detected:`);
      for (const d of drift) console.log(`  ⚠ ${d.message}`);
    } else {
      console.log('\nNo drift detected.');
    }
    break;
  }

  case 'recover': {
    const recovery = syncBot.recover();
    console.log(JSON.stringify(recovery, null, 2));
    break;
  }

  case 'events': {
    const count = parseInt(arg) || 20;
    const events = syncBot.readRecentEvents(count);
    for (const e of events) {
      console.log(JSON.stringify(e));
    }
    break;
  }

  case 'sync': {
    if (!arg) { console.error('Usage: sync-cli.js sync \'{"summary":"...","type":"..."}\''); process.exit(1); }
    const data = JSON.parse(arg);
    syncBot.sync('claude', data);
    console.log('Synced:', data.summary);
    break;
  }

  case 'handoff': {
    if (!arg) { console.error('Usage: sync-cli.js handoff \'{"done":"...","next":"..."}\''); process.exit(1); }
    const note = JSON.parse(arg);
    syncBot.writeHandoff('claude', note);
    console.log('Handoff written.');
    break;
  }

  case 'checkpoint': {
    const state = syncBot.loadState();
    const cp = syncBot.createCheckpoint(state, arg || 'manual');
    console.log('Checkpoint created:', cp);
    break;
  }

  case 'drift': {
    const state = syncBot.loadState();
    const drift = syncBot.detectDrift(state);
    if (drift.length === 0) { console.log('No drift detected.'); }
    else { console.log(JSON.stringify(drift, null, 2)); }
    break;
  }

  case 'state': {
    const state = syncBot.loadState();
    console.log(JSON.stringify(state, null, 2));
    break;
  }

  default:
    console.log('Usage: sync-cli.js <status|recover|events|sync|handoff|checkpoint|drift|state>');
    process.exit(1);
}
