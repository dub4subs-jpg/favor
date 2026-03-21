#!/bin/bash
# Favor — Re-link WhatsApp (scan QR code again)
# Usage: ./relink.sh

echo ""
echo "  [*] Stopping bot to re-link WhatsApp..."

# Find and stop the pm2 process
PM2_NAME=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const p = d.find(p => p.pm2_env.pm_exec_path.endsWith('favor.js'));
  if (p) console.log(p.name);
" 2>/dev/null || echo "")

if [ -n "$PM2_NAME" ]; then
    pm2 stop "$PM2_NAME" > /dev/null 2>&1
fi

# Clear old session
rm -rf auth-state/*
echo "  [✓] Old session cleared"
echo ""
echo "  Starting bot — scan the QR code with WhatsApp:"
echo "  WhatsApp > Settings > Linked Devices > Link a Device"
echo ""

# Run in foreground to show QR
node favor.js &
BOT_PID=$!

echo ""
read -p "  Press Enter after you've scanned the QR code..." _

kill $BOT_PID 2>/dev/null
sleep 2

# Restart via pm2
if [ -n "$PM2_NAME" ]; then
    pm2 restart "$PM2_NAME"
    echo ""
    echo "  [✓] Re-linked and restarted ($PM2_NAME)"
else
    echo ""
    echo "  [✓] Re-linked. Start with: pm2 start favor.js --name favor --restart-delay 20000"
fi

echo ""
