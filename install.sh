#!/bin/bash
# OpenClaw Backup Installer
# Usage: ./install.sh [port]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$HOME/.openclaw/backups"

# Default port
PORT=${1:-3847}

echo "🔧 OpenClaw Backup Installer"
echo "============================"

# Check Node.js
if ! command -v node &> /dev/null; then
    log_warn "Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Create backup directory
log_info "Creating backup directory..."
mkdir -p "$BACKUP_DIR"

# Check if port is in use
if lsof -i :$PORT &> /dev/null; then
    log_warn "Port $PORT is already in use. Using port $((PORT + 1)) instead."
    PORT=$((PORT + 1))
fi

# Create environment file
cat > "$SCRIPT_DIR/.env" << EOF
PORT=$PORT
BACKUP_DIR=$BACKUP_DIR
EOF

# Create start script
cat > "$SCRIPT_DIR/start.sh" << EOF
#!/bin/bash
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
source "\$SCRIPT_DIR/.env"
cd "\$SCRIPT_DIR"
exec node backup-server.js
EOF
chmod +x "$SCRIPT_DIR/start.sh"

# Create systemd service (optional)
if command -v systemctl &> /dev/null; then
    log_info "Creating systemd service..."
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/openclaw-backup.service" << EOF
[Unit]
Description=OpenClaw Backup Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/start.sh
Restart=always
Environment=PORT=$PORT

[Install]
WantedBy=default.target
EOF
    log_info "Run: systemctl --user enable --now openclaw-backup"
fi

# Try to get local IP
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
log_info "✅ Installation complete!"
echo ""
echo "🌐 Local:   http://localhost:$PORT"
echo "🌐 Network: http://$LOCAL_IP:$PORT"
echo "📁 Backups: $BACKUP_DIR"
echo ""
echo "📝 Commands:"
echo "   Start: ./start.sh"
echo "   Stop:  pkill -f 'node backup-server.js'"
if command -v systemctl &> /dev/null; then
    echo "   Auto:  systemctl --user enable --now openclaw-backup"
fi

# Start the server
echo ""
read -p "Start server now? (Y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    cd "$SCRIPT_DIR"
    PORT=$PORT node backup-server.js &
    sleep 2
    log_info "Server started!"
fi
