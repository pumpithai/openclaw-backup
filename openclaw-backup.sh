#!/bin/bash
# OpenClaw Backup Script
# Usage: ./backup.sh [--restore]

set -e

BACKUP_DIR="${BACKUP_DIR:-/home/cloudm9n/.openclaw/backups}"
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
    cp -r ~/.openclaw/openclaw.json "$BACKUP_PATH/" 2>/dev/null || true
    cp -r ~/.openclaw/openclaw.json.bak "$BACKUP_PATH/" 2>/dev/null || true
    
    # Backup credentials (masked)
    log_info "Backing up credentials..."
    mkdir -p "$BACKUP_PATH/credentials"
    if [ -d ~/.openclaw/credentials ]; then
        cp -r ~/.openclaw/credentials/* "$BACKUP_PATH/credentials/" 2>/dev/null || true
    fi
    
    # Backup workspace
    log_info "Backing up workspace..."
    mkdir -p "$BACKUP_PATH/workspace"
    rsync -a --exclude='.git' --exclude='node_modules' --exclude='.openclaw' \
        /home/cloudm9n/.openclaw/workspace/ "$BACKUP_PATH/workspace/"
    
    # Backup telegram
    log_info "Backing up telegram..."
    mkdir -p "$BACKUP_PATH/telegram"
    if [ -d ~/.openclaw/telegram ]; then
        cp -r ~/.openclaw/telegram/* "$BACKUP_PATH/telegram/" 2>/dev/null || true
    fi
    
    # Backup cron
    log_info "Backing up cron jobs..."
    mkdir -p "$BACKUP_PATH/cron"
    if [ -d ~/.openclaw/cron ]; then
        cp -r ~/.openclaw/cron/* "$BACKUP_PATH/cron/" 2>/dev/null || true
    fi
    
    # Backup skills
    log_info "Backing up skills..."
    mkdir -p "$BACKUP_PATH/skills"
    if [ -d ~/.openclaw/skills ]; then
        cp -r ~/.openclaw/skills/* "$BACKUP_PATH/skills/" 2>/dev/null || true
    fi
    if [ -d /home/cloudm9n/.openclaw/workspace/skills ]; then
        mkdir -p "$BACKUP_PATH/workspace_skills"
        cp -r /home/cloudm9n/.openclaw/workspace/skills/* "$BACKUP_PATH/workspace_skills/" 2>/dev/null || true
    fi
    
    # Backup agents config
    log_info "Backing up agents config..."
    mkdir -p "$BACKUP_PATH/agents"
    if [ -d ~/.openclaw/agents ]; then
        cp -r ~/.openclaw/agents/* "$BACKUP_PATH/agents/" 2>/dev/null || true
    fi
    
    # Backup cron jobs
    log_info "Backing up cron jobs..."
    mkdir -p "$BACKUP_PATH/cron"
    if [ -d ~/.openclaw/cron ]; then
        cp -r ~/.openclaw/cron/* "$BACKUP_PATH/cron/" 2>/dev/null || true
    fi
    
    # Create archive
    log_info "Creating archive..."
    cd "$BACKUP_DIR"
    tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
    rm -rf "$BACKUP_PATH"
    
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
    
    # Restore files
    log_info "Restoring config..."
    cp "$extracted_dir/openclaw.json" ~/.openclaw/ 2>/dev/null || true
    
    log_info "Restoring credentials..."
    if [ -d "$extracted_dir/credentials" ]; then
        mkdir -p ~/.openclaw/credentials
        cp -r "$extracted_dir/credentials"/* ~/.openclaw/credentials/ 2>/dev/null || true
    fi
    
    log_info "Restoring workspace..."
    rm -rf /home/cloudm9n/.openclaw/workspace/*
    cp -r "$extracted_dir/workspace/"* /home/cloudm9n/.openclaw/workspace/ 2>/dev/null || true
    
    log_info "Restoring telegram..."
    if [ -d "$extracted_dir/telegram" ]; then
        mkdir -p ~/.openclaw/telegram
        cp -r "$extracted_dir/telegram"/* ~/.openclaw/telegram/ 2>/dev/null || true
    fi
    
    log_info "Restoring cron..."
    if [ -d "$extracted_dir/cron" ]; then
        mkdir -p ~/.openclaw/cron
        cp -r "$extracted_dir/cron"/* ~/.openclaw/cron/ 2>/dev/null || true
    fi
    
    log_info "Restoring skills..."
    if [ -d "$extracted_dir/skills" ]; then
        mkdir -p ~/.openclaw/skills
        cp -r "$extracted_dir/skills"/* ~/.openclaw/skills/ 2>/dev/null || true
    fi
    if [ -d "$extracted_dir/workspace_skills" ]; then
        mkdir -p /home/cloudm9n/.openclaw/workspace/skills
        cp -r "$extracted_dir/workspace_skills"/* /home/cloudm9n/.openclaw/workspace/skills/ 2>/dev/null || true
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
