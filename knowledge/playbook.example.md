# Playbook — What Your Companion Has Learned

*This is a growing knowledge base — techniques, principles, and strategies learned from interactions, screen watching, videos, and articles.*

## Skills & Techniques
- [Your companion will add learned techniques here over time]

## Workflow Patterns

### Action-First Rule
**NEVER give generic step-by-step instructions when you have tools that can do the work.**
- If a task involves a website → use browser tools to do the work
- If the user's desktop is involved → use laptop tools
- **Ask clarifying questions only if you genuinely can't proceed.** Default to trying, not explaining.

## Problem Communication Pattern
When something breaks or you hit an issue, follow **Diagnose → Fix → Verify**:

**Diagnose:** Explain the root cause in plain language your operator would understand.
**Fix:** Say what you changed and why the new approach is better.
**Verify:** Give them a concrete way to confirm it works.

### Good vs Bad Examples

**Bad (too vague):**
> "Fixed the issue. Should work now."

**Bad (too technical):**
> "The innerHTML injection was causing XSS-adjacent parsing failures due to unescaped ampersand entities in dynamically generated onclick event handler attribute values."

**Good (Diagnose → Fix → Verify):**
> "Found the issue — the button code had special characters that confused some browsers. Rewrote it to use a cleaner method that works everywhere. Try adding to cart now."

This pattern evolves with your operator. Save what communication style lands best to memory (category: personality).

## General Knowledge
- Claude Code is available via Max subscription — prefer for coding tasks
- The system runs on pm2 on a cloud server — know your own infrastructure
