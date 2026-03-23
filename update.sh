#!/bin/bash
# Favor — Update to latest version (preserves your custom changes)
# Usage: ./update.sh

echo ""
echo "  [*] Updating Favor..."

# Check for local changes
LOCAL_CHANGES=$(git status --porcelain 2>/dev/null | grep -v '??' || true)

if [ -n "$LOCAL_CHANGES" ]; then
    echo "  [*] Saving your local changes..."
    git stash push -m "favor-update-$(date +%Y%m%d-%H%M%S)" 2>&1
    STASHED=true
else
    STASHED=false
fi

# Pull latest code
PULL_OUTPUT=$(git pull origin master 2>&1)
PULL_STATUS=$?

echo "  $PULL_OUTPUT"

if [ $PULL_STATUS -ne 0 ]; then
    echo "  [!] Pull failed."
    if [ "$STASHED" = true ]; then
        echo "  [*] Restoring your local changes..."
        git stash pop 2>&1
    fi
    echo ""
    exit 1
fi

# Restore local changes
if [ "$STASHED" = true ]; then
    echo "  [*] Restoring your local changes..."
    if git stash pop 2>&1; then
        echo "  [✓] Your custom code preserved"
    else
        echo ""
        echo "  [!] Merge conflict — your changes clash with the update."
        echo "  [!] Your changes are saved. Fix conflicts in the affected files,"
        echo "      then run: git add . && git stash drop"
        echo ""
        echo "  [i] Or to undo the update and go back:"
        echo "      git checkout . && git stash pop"
        echo ""
        exit 1
    fi
fi

# Install any new dependencies
npm install --silent 2>&1 | tail -1

# Get pm2 process name and restart
PM2_NAME=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const p = d.find(p => p.pm2_env.pm_exec_path.endsWith('favor.js'));
  if (p) console.log(p.name);
" 2>/dev/null || echo "")

if [ -n "$PM2_NAME" ]; then
    pm2 restart "$PM2_NAME"
    echo "  [✓] Updated and restarted ($PM2_NAME)"
else
    echo "  [✓] Code updated. Start with: node favor.js"
fi

# ─── Show what's new ───
if [ -f CHANGELOG.md ]; then
    echo ""
    echo "  ╔═══════════════════════════════════════════════════╗"
    echo "  ║               What's New in Favor                 ║"
    echo "  ╚═══════════════════════════════════════════════════╝"
    echo ""
    # Show the latest changelog entry (between first two --- markers)
    awk '/^## \[/{if(seen) exit; seen=1} seen{print "  " $0}' CHANGELOG.md
    echo ""
    echo "  Full changelog: cat CHANGELOG.md"
fi

echo ""
