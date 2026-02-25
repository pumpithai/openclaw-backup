# OpenClaw Backup 🗂️

Web UI สำหรับ backup และ restore OpenClaw data

## Features

- 📦 Create/Restore backups
- ⬆️ Upload backup files
- ⏰ Schedule automatic backups
- 📱 Modern dark theme UI

## Installation

```bash
# Clone or download
git clone https://github.com/your-repo/openclaw-backup.git
cd openclaw-backup

# Run installer
chmod +x install.sh
./install.sh
```

## Usage

```bash
# Start server
./start.sh

# Or with custom port
./install.sh 4000
```

Then open: `http://localhost:3847`

## Backup Contents

- `openclaw.json` - Main config
- `credentials/` - API keys & tokens
- `agents/` - Agent configs
- `workspace/` - Memory, files
- `telegram/` - Session data
- `cron/` - Scheduled tasks
- `skills/` - Custom skills

## Systemd (Auto Start)

```bash
systemctl --user enable --now openclaw-backup
```

## Stop Server

```bash
pkill -f 'node backup-server.js'
```
