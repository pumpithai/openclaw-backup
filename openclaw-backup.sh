#!/bin/bash
# OpenClaw Backup Script
# Usage: ./backup.sh [--restore]

set -e

HOME_DIR="${HOME:-$HOME}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME_DIR/.openclaw}"
BACKUP_DIR="${BACKUP_DIR:-$OPENCLAW_DIR/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="openclaw_backup_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Create backup directory
mkdir -p "$BACKUP_DIR"

backup() {
    log_info "Starting backup..."
    
    # Create backup folder
    mkdir -p "$BACKUP_PATH"
    
    # Backup OpenClaw config
    log_info "Backing up OpenClaw config..."
    cp -r "$OPENCLAW_DIR/openclaw.json" "$BACKUP_PATH/" 2>/dev/null || true
    cp -r "$OPENCLAW_DIR/openclaw.json.bak" "$BACKUP_PATH/" 2>/dev/null || true
    
    # Backup credentials (masked)
    log_info "Backing up credentials..."
    mkdir -p "$BACKUP_PATH/credentials"
    if [ -d "$OPENCLAW_DIR/credentials" ]; then
        cp -r "$OPENCLAW_DIR/credentials/"* "$BACKUP_PATH/credentials/" 2>/dev/null || true
    fi
    
    # Backup workspace
    log_info "Backing up workspace..."
    mkdir -p "$BACKUP_PATH/workspace"
    rsync -a --exclude='.git' --exclude='node_modules' --exclude='.openclaw' \
        "$OPENCLAW_DIR/workspace/" "$BACKUP_PATH/workspace/"
    
    # Backup telegram
    log_info "Backing up telegram..."
    mkdir -p "$BACKUP_PATH/telegram"
    if [ -d "$OPENCLAW_DIR/telegram" ]; then
        cp -r "$OPENCLAW_DIR/telegram/"* "$BACKUP_PATH/telegram/" 2>/dev/null || true
    fi
    
    # Backup cron
    log_info "Backing up cron jobs..."
    mkdir -p "$BACKUP_PATH/cron"
    if [ -d "$OPENCLAW_DIR/cron" ]; then
        cp -r "$OPENCLAW_DIR/cron/"* "$BACKUP_PATH/cron/" 2>/dev/null || true
    fi
    
    # Backup devices
    log_info "Backing up devices..."
    mkdir -p "$BACKUP_PATH/devices"
    if [ -d "$OPENCLAW_DIR/devices" ]; then
        cp -r "$OPENCLAW_DIR/devices/"* "$BACKUP_PATH/devices/" 2>/dev/null || true
    fi
    
    # Backup identity
    log_info "Backing up identity..."
    mkdir -p "$BACKUP_PATH/identity"
    if [ -d "$OPENCLAW_DIR/identity" ]; then
        cp -r "$OPENCLAW_DIR/identity/"* "$BACKUP_PATH/identity/" 2>/dev/null || true
    fi
    
    # Backup memory
    log_info "Backing up memory..."
    mkdir -p "$BACKUP_PATH/memory"
    if [ -d "$OPENCLAW_DIR/memory" ]; then
        cp -r "$OPENCLAW_DIR/memory/"* "$BACKUP_PATH/memory/" 2>/dev/null || true
    fi
    
    # Backup canvas
    log_info "Backing up canvas..."
    mkdir -p "$BACKUP_PATH/canvas"
    if [ -d "$OPENCLAW_DIR/canvas" ]; then
        cp -r "$OPENCLAW_DIR/canvas/"* "$BACKUP_PATH/canvas/" 2>/dev/null || true
    fi
    
    # Backup completions
    log_info "Backing up completions..."
    mkdir -p "$BACKUP_PATH/completions"
    if [ -d "$OPENCLAW_DIR/completions" ]; then
        cp -r "$OPENCLAW_DIR/completions/"* "$BACKUP_PATH/completions/" 2>/dev/null || true
    fi
    
    # Backup media
    log_info "Backing up media..."
    mkdir -p "$BACKUP_PATH/media"
    if [ -d "$OPENCLAW_DIR/media" ]; then
        cp -r "$OPENCLAW_DIR/media/"* "$BACKUP_PATH/media/" 2>/dev/null || true
    fi
    
    # Backup skills
    log_info "Backing up skills..."
    mkdir -p "$BACKUP_PATH/skills"
    if [ -d "$OPENCLAW_DIR/skills" ]; then
        cp -r "$OPENCLAW_DIR/skills/"* "$BACKUP_PATH/skills/" 2>/dev/null || true
    fi
    if [ -d "$OPENCLAW_DIR/workspace/skills" ]; then
        mkdir -p "$BACKUP_PATH/workspace_skills"
        cp -r "$OPENCLAW_DIR/workspace/skills/"* "$BACKUP_PATH/workspace_skills/" 2>/dev/null || true
    fi
    
    # Backup agents config
    log_info "Backing up agents config..."
    mkdir -p "$BACKUP_PATH/agents"
    if [ -d "$OPENCLAW_DIR/agents" ]; then
        cp -r "$OPENCLAW_DIR/agents/"* "$BACKUP_PATH/agents/" 2>/dev/null || true
    fi
    
    # Create archive
    log_info "Creating archive..."
    cd "$BACKUP_DIR"
    tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
    rm -rf "$BACKUP_PATH"
    
    # Create metadata
    echo '{"type":"auto","created":"'$(date -Iseconds)'"}' > "${BACKUP_DIR}/${BACKUP_NAME}.json"
    
    # List backups
    ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -5
    
    log_info "Backup complete: ${BACKUP_NAME}.tar.gz"
    echo "$BACKUP_DIR/${BACKUP_NAME}.tar.gz"
}

restore() {
    local backup_file="$1"
    
    if [ -z "$backup_file" ]; then
        log_warn "Available backups:"
        ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null || log_error "No backups found"
        echo ""
        echo "Usage: $0 --restore /path/to/backup.tar.gz"
        exit 1
    fi
    
    if [ ! -f "$backup_file" ]; then
        log_error "Backup file not found: $backup_file"
        exit 1
    fi
    
    log_warn "This will overwrite current OpenClaw config!"
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Restore cancelled"
        exit 0
    fi
    
    # Extract to temp
    local temp_dir=$(mktemp -d)
    tar -xzf "$backup_file" -C "$temp_dir"
    
    # Find extracted folder
    local extracted_dir=$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d | head -1)
    
    # Restore config
    log_info "Restoring config..."
    cp "$extracted_dir/openclaw.json" "$OPENCLAW_DIR/" 2>/dev/null || true
    
    # Restore credentials
    log_info "Restoring credentials..."
    if [ -d "$extracted_dir/credentials" ]; then
        mkdir -p "$OPENCLAW_DIR/credentials"
        cp -r "$extracted_dir/credentials/"* "$OPENCLAW_DIR/credentials/" 2>/dev/null || true
    fi
    
    # Restore workspace
    log_info "Restoring workspace..."
    rm -rf "$OPENCLAW_DIR/workspace/"*
    cp -r "$extracted_dir/workspace/"* "$OPENCLAW_DIR/workspace/" 2>/dev/null || true
    
    # Restore telegram
    log_info "Restoring telegram..."
    if [ -d "$extracted_dir/telegram" ]; then
        mkdir -p "$OPENCLAW_DIR/telegram"
        cp -r "$extracted_dir/telegram/"* "$OPENCLAW_DIR/telegram/" 2>/dev/null || true
    fi
    
    # Restore cron
    log_info "Restoring cron..."
    if [ -d "$extracted_dir/cron" ]; then
        mkdir -p "$OPENCLAW_DIR/cron"
        cp -r "$extracted_dir/cron/"* "$OPENCLAW_DIR/cron/" 2>/dev/null || true
    fi
    
    # Restore devices
    log_info "Restoring devices..."
    if [ -d "$extracted_dir/devices" ]; then
        mkdir -p "$OPENCLAW_DIR/devices"
        cp -r "$extracted_dir/devices/"* "$OPENCLAW_DIR/devices/" 2>/dev/null || true
    fi
    
    # Restore identity
    log_info "Restoring identity..."
    if [ -d "$extracted_dir/identity" ]; then
        mkdir -p "$OPENCLAW_DIR/identity"
        cp -r "$extracted_dir/identity/"* "$OPENCLAW_DIR/identity/" 2>/dev/null || true
    fi
    
    # Restore memory
    log_info "Restoring memory..."
    if [ -d "$extracted_dir/memory" ]; then
        mkdir -p "$OPENCLAW_DIR/memory"
        cp -r "$extracted_dir/memory/"* "$OPENCLAW_DIR/memory/" 2>/dev/null || true
    fi
    
    # Restore canvas
    log_info "Restoring canvas..."
    if [ -d "$extracted_dir/canvas" ]; then
        mkdir -p "$OPENCLAW_DIR/canvas"
        cp -r "$extracted_dir/canvas/"* "$OPENCLAW_DIR/canvas/" 2>/dev/null || true
    fi
    
    # Restore completions
    log_info "Restoring completions..."
    if [ -d "$extracted_dir/completions" ]; then
        mkdir -p "$OPENCLAW_DIR/completions"
        cp -r "$extracted_dir/completions/"* "$OPENCLAW_DIR/completions/" 2>/dev/null || true
    fi
    
    # Restore media
    log_info "Restoring media..."
    if [ -d "$extracted_dir/media" ]; then
        mkdir -p "$OPENCLAW_DIR/media"
        cp -r "$extracted_dir/media/"* "$OPENCLAW_DIR/media/" 2>/dev/null || true
    fi
    
    # Restore skills
    log_info "Restoring skills..."
    if [ -d "$extracted_dir/skills" ]; then
        mkdir -p "$OPENCLAW_DIR/skills"
        cp -r "$extracted_dir/skills/"* "$OPENCLAW_DIR/skills/" 2>/dev/null || true
    fi
    if [ -d "$extracted_dir/workspace_skills" ]; then
        mkdir -p "$OPENCLAW_DIR/workspace/skills"
        cp -r "$extracted_dir/workspace_skills/"* "$OPENCLAW_DIR/workspace/skills/" 2>/dev/null || true
    fi
    
    # Restore agents
    log_info "Restoring agents..."
    if [ -d "$extracted_dir/agents" ]; then
        mkdir -p "$OPENCLAW_DIR/agents"
        cp -r "$extracted_dir/agents/"* "$OPENCLAW_DIR/agents/" 2>/dev/null || true
    fi
    
    # Clean up
    rm -rf "$temp_dir"
    
    log_info "Restore complete!"
}

list_backups() {
    log_info "Available backups:"
    ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null || log_error "No backups found"
}

case "${1:-}" in
    --restore|-r)
        restore "$2"
        ;;
    --list|-l)
        list_backups
        ;;
    *)
        backup
        ;;
esac
