#!/bin/bash
# Favor — Set up SiYuan structured memory
# Usage: ./setup-siyuan.sh

echo ""
echo "  [*] Setting up SiYuan structured memory..."

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "  [!] Docker not found. Install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

# Generate random auth code
AUTH_CODE=$(openssl rand -hex 12)

# Check if already running
if docker ps --format '{{.Names}}' | grep -q '^siyuan$'; then
    echo "  [✓] SiYuan is already running"
    echo "  [i] To reset: docker rm -f siyuan && ./setup-siyuan.sh"
    exit 0
fi

# Remove stopped container if exists
docker rm -f siyuan 2>/dev/null

# Pull and run
echo "  [*] Pulling SiYuan image..."
docker pull b3log/siyuan:latest

echo "  [*] Starting SiYuan container..."
VAULT_DIR="$(pwd)/siyuan-vault"
mkdir -p "$VAULT_DIR"

docker run -d --name siyuan \
  --restart unless-stopped \
  -p 6806:6806 \
  -v "$VAULT_DIR:/siyuan/workspace" \
  b3log/siyuan:latest \
  --workspace /siyuan/workspace \
  --accessAuthCode "$AUTH_CODE" \
  > /dev/null 2>&1

# Wait for startup
sleep 3

# Verify
if curl -s http://localhost:6806/api/system/version > /dev/null 2>&1; then
    echo "  [✓] SiYuan is running on port 6806"
else
    echo "  [!] SiYuan failed to start. Check: docker logs siyuan"
    exit 1
fi

# Write config
cat > .siyuan-config.json << EOF
{
  "host": "localhost",
  "port": 6806,
  "token": "$AUTH_CODE",
  "enabled": true
}
EOF

echo "  [✓] Config written to .siyuan-config.json"
echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║          SiYuan Structured Memory Ready            ║"
echo "  ╠═══════════════════════════════════════════════════╣"
echo "  ║                                                    ║"
echo "  ║  Web UI: http://localhost:6806                     ║"
echo "  ║  Auth:   $AUTH_CODE      ║"
echo "  ║                                                    ║"
echo "  ║  Restart your bot to connect:                      ║"
echo "  ║  pm2 restart <your-bot-name>                       ║"
echo "  ║                                                    ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
