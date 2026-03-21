#!/bin/bash
# Deploy script for Favor — restarts via systemd user service
set -e

LOGFILE="/tmp/favor.log"

echo "[DEPLOY] Restarting favor.service..."
systemctl --user restart favor.service
sleep 3

# Check status
if systemctl --user is-active favor.service > /dev/null 2>&1; then
  echo "[DEPLOY] OK — favor.service is active"
  systemctl --user status favor.service --no-pager | head -10
  echo ""
  echo "[DEPLOY] Tailing logs (Ctrl+C to stop)..."
  journalctl --user -u favor.service -f --no-pager
else
  echo "[DEPLOY] FAILED — service not active"
  systemctl --user status favor.service --no-pager
  exit 1
fi
