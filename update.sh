#!/bin/bash
# Favor — Update to latest version
# Usage: ./update.sh

set -e

echo ""
echo "  [*] Updating Favor..."

# Pull latest code
git pull origin master 2>&1

# Install any new dependencies
npm install --silent 2>&1 | tail -1

# Get pm2 process name
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

echo ""
