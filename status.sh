#!/bin/bash
# Favor — Quick status check
# Usage: ./status.sh

echo ""

# Find the favor pm2 process
PM2_NAME=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const p = d.find(p => p.pm2_env.pm_exec_path.endsWith('favor.js'));
  if (p) {
    const up = Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000);
    const h = Math.floor(up/3600), m = Math.floor((up%3600)/60);
    const mem = Math.round(p.monit.memory / 1024 / 1024);
    console.log('  Bot:      ' + p.name);
    console.log('  Status:   ' + p.pm2_env.status.toUpperCase());
    console.log('  Uptime:   ' + h + 'h ' + m + 'm');
    console.log('  Memory:   ' + mem + ' MB');
    console.log('  Restarts: ' + p.pm2_env.restart_time);
    console.log('  PID:      ' + p.pid);
  } else {
    console.log('  Bot is not running.');
    console.log('  Start it: pm2 start favor.js --name favor --restart-delay 20000');
  }
" 2>/dev/null)

if [ -z "$PM2_NAME" ]; then
    echo "  pm2 not running or favor not found."
    echo "  Start it: pm2 start favor.js --name favor --restart-delay 20000"
else
    echo "$PM2_NAME"
fi

# Server stats
echo ""
echo "  --- Server ---"
echo "  Disk:   $(df -h / | awk 'NR==2{print $3"/"$2" ("$5" used)"}')"
echo "  RAM:    $(free -h | awk 'NR==2{print $3"/"$2}')"
echo "  Load:   $(uptime | awk -F'average:' '{print $2}' | xargs)"
echo ""
