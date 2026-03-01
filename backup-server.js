const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn, execSync } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const HOME_DIR = os.homedir();
const OPENCLAW_DIR = path.join(HOME_DIR, '.openclaw');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(OPENCLAW_DIR, 'backups');
const CRON_DIR = process.env.CRON_DIR || path.join(OPENCLAW_DIR, 'cron');
const CONFIG_FILE = path.join(BACKUP_DIR, 'config.json');
const PORT = process.env.PORT || 3847;

// Default config
let config = {
    maxBackups: 10,
    maxBackupsSize: 0  // 0 = no limit
};

// Load config
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (e) {}
}

// Save config
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Cleanup old backups
function cleanupBackups() {
    if (config.maxBackups <= 0) return;
    
    // Get all auto backups sorted by time
    const autoFiles = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.tar.gz'))
        .map(f => {
            const metaPath = path.join(BACKUP_DIR, f.replace('.tar.gz', '.json'));
            let type = 'manual';
            try {
                if (fs.existsSync(metaPath)) {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    type = meta.type || 'manual';
                }
            } catch (e) {}
            return {
                name: f,
                path: path.join(BACKUP_DIR, f),
                metaPath,
                type,
                time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime()
            };
        })
        .filter(f => f.type === 'auto')
        .sort((a, b) => b.time - a.time);
    
    if (autoFiles.length > config.maxBackups) {
        const toDelete = autoFiles.slice(config.maxBackups);
        toDelete.forEach(f => {
            try {
                fs.unlinkSync(f.path);
                if (fs.existsSync(f.metaPath)) {
                    fs.unlinkSync(f.metaPath);
                }
                console.log('Deleted auto backup:', f.name);
            } catch (e) {
                console.error('Failed to delete:', f.name, e.message);
            }
        });
    }
}

loadConfig();

// Restore status tracking
let restoreStatus = {
    inProgress: false,
    filename: '',
    progress: 0,
    message: 'Idle',
    completed: false,
    error: null
};

// Ensure backup directory exists
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.tar.gz': 'application/x-tar-gz'
};

// Parse URL
function parseUrl(url) {
    const [pathname, query] = url.split('?');
    const params = new URLSearchParams(query);
    return { pathname, params };
}

// Get list of backups
async function listBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR);
        const backups = files
            .filter(f => f.endsWith('.tar.gz'))
            .map(f => {
                const filepath = path.join(BACKUP_DIR, f);
                const stats = fs.statSync(filepath);
                const date = stats.mtime.toLocaleString('th-TH');
                const timestamp = stats.mtime.getTime();
                const size = formatSize(stats.size);
                
                // Get backup type from metadata
                const metaPath = path.join(BACKUP_DIR, f.replace('.tar.gz', '.json'));
                let type = 'manual';
                try {
                    if (fs.existsSync(metaPath)) {
                        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                        type = meta.type || 'manual';
                    }
                } catch (e) {}
                
                return { name: f, size, date, timestamp, type };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        return backups;
    } catch (err) {
        return [];
    }
}

// Format file size
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// Create backup
async function createBackup(type = 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `openclaw_${type}_backup_${timestamp}`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    
    // Create temp backup folder
    fs.mkdirSync(backupPath, { recursive: true });
    
    // Copy OpenClaw config
    const configSrc = path.join(OPENCLAW_DIR, 'openclaw.json');
    if (fs.existsSync(configSrc)) {
        fs.copyFileSync(configSrc, path.join(backupPath, 'openclaw.json'));
    }
    
    // Copy workspace (exclude git, node_modules)
    const workspaceSrc = path.join(OPENCLAW_DIR, 'workspace');
    const workspaceDest = path.join(backupPath, 'workspace');
    fs.mkdirSync(workspaceDest, { recursive: true });
    
    if (fs.existsSync(workspaceSrc)) {
        copyDir(workspaceSrc, workspaceDest, ['.git', 'node_modules', '.openclaw']);
    }
    
    // Copy credentials (masked)
    const credsSrc = path.join(OPENCLAW_DIR, 'credentials');
    const credsDest = path.join(backupPath, 'credentials');
    if (fs.existsSync(credsSrc)) {
        fs.mkdirSync(credsDest, { recursive: true });
        copyDir(credsSrc, credsDest);
    }
    
    // Copy agents
    const agentsSrc = path.join(OPENCLAW_DIR, 'agents');
    const agentsDest = path.join(backupPath, 'agents');
    if (fs.existsSync(agentsSrc)) {
        fs.mkdirSync(agentsDest, { recursive: true });
        copyDir(agentsSrc, agentsDest);
    }
    
    // Copy telegram
    const telegramSrc = path.join(OPENCLAW_DIR, 'telegram');
    const telegramDest = path.join(backupPath, 'telegram');
    if (fs.existsSync(telegramSrc)) {
        fs.mkdirSync(telegramDest, { recursive: true });
        copyDir(telegramSrc, telegramDest);
    }
    
    // Copy cron
    const cronSrc = path.join(OPENCLAW_DIR, 'cron');
    const cronDest = path.join(backupPath, 'cron');
    if (fs.existsSync(cronSrc)) {
        fs.mkdirSync(cronDest, { recursive: true });
        copyDir(cronSrc, cronDest);
    }
    
    // Copy devices
    const devicesSrc = path.join(OPENCLAW_DIR, 'devices');
    const devicesDest = path.join(backupPath, 'devices');
    if (fs.existsSync(devicesSrc)) {
        fs.mkdirSync(devicesDest, { recursive: true });
        copyDir(devicesSrc, devicesDest);
    }
    
    // Copy identity
    const identitySrc = path.join(OPENCLAW_DIR, 'identity');
    const identityDest = path.join(backupPath, 'identity');
    if (fs.existsSync(identitySrc)) {
        fs.mkdirSync(identityDest, { recursive: true });
        copyDir(identitySrc, identityDest);
    }
    
    // Copy memory
    const memorySrc = path.join(OPENCLAW_DIR, 'memory');
    const memoryDest = path.join(backupPath, 'memory');
    if (fs.existsSync(memorySrc)) {
        fs.mkdirSync(memoryDest, { recursive: true });
        copyDir(memorySrc, memoryDest);
    }
    
    // Copy canvas
    const canvasSrc = path.join(OPENCLAW_DIR, 'canvas');
    const canvasDest = path.join(backupPath, 'canvas');
    if (fs.existsSync(canvasSrc)) {
        fs.mkdirSync(canvasDest, { recursive: true });
        copyDir(canvasSrc, canvasDest);
    }
    
    // Copy completions
    const completionsSrc = path.join(OPENCLAW_DIR, 'completions');
    const completionsDest = path.join(backupPath, 'completions');
    if (fs.existsSync(completionsSrc)) {
        fs.mkdirSync(completionsDest, { recursive: true });
        copyDir(completionsSrc, completionsDest);
    }
    
    // Copy media
    const mediaSrc = path.join(OPENCLAW_DIR, 'media');
    const mediaDest = path.join(backupPath, 'media');
    if (fs.existsSync(mediaSrc)) {
        fs.mkdirSync(mediaDest, { recursive: true });
        copyDir(mediaSrc, mediaDest);
    }
    
    // Create tar.gz
    const tarPath = path.join(BACKUP_DIR, `${backupName}.tar.gz`);
    await execPromise(`tar -czf "${tarPath}" -C "${BACKUP_DIR}" "${backupName}"`);
    
    // Clean up temp folder
    fs.rmSync(backupPath, { recursive: true });
    
    // Save backup metadata
    const metaPath = path.join(BACKUP_DIR, `${backupName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ type, created: new Date().toISOString() }));
    
    // Cleanup old backups (only auto)
    if (type === 'auto') {
        cleanupBackups();
    }
    
    return `${backupName}.tar.gz`;
}

// Copy directory recursively
function copyDir(src, dest, exclude = []) {
    if (!fs.existsSync(src)) return;
    
    const items = fs.readdirSync(src);
    for (const item of items) {
        if (exclude.includes(item)) continue;
        
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyDir(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Restore backup
async function restoreBackup(filename) {
    // Reset status
    restoreStatus = {
        inProgress: true,
        filename: filename,
        progress: 0,
        message: 'Starting restore...',
        completed: false,
        error: null
    };
    
    const tarPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(tarPath)) {
        restoreStatus = { ...restoreStatus, inProgress: false, error: 'Backup file not found', message: 'Error: File not found' };
        throw new Error('Backup file not found');
    }
    
    try {
        // Extract to temp
        restoreStatus.message = 'Extracting backup...';
        restoreStatus.progress = 10;
        const tempDir = path.join(BACKUP_DIR, 'temp_restore_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        
        await execPromise(`tar -xzf "${tarPath}" -C "${tempDir}"`);
        
        // Find extracted folder
        const items = fs.readdirSync(tempDir);
        const extractedDir = path.join(tempDir, items[0]);
        
        // Restore config
        restoreStatus.message = 'Restoring config...';
        restoreStatus.progress = 20;
        const configSrc = path.join(extractedDir, 'openclaw.json');
        const configDest = path.join(OPENCLAW_DIR, 'openclaw.json');
        if (fs.existsSync(configSrc)) {
            fs.copyFileSync(configSrc, configDest);
        }
        
        // Restore workspace
        restoreStatus.message = 'Restoring workspace...';
        restoreStatus.progress = 40;
        const workspaceSrc = path.join(extractedDir, 'workspace');
        const workspaceDest = path.join(OPENCLAW_DIR, 'workspace');
        if (fs.existsSync(workspaceSrc)) {
            if (fs.existsSync(workspaceDest)) {
                fs.rmSync(workspaceDest, { recursive: true });
            }
            fs.mkdirSync(workspaceDest, { recursive: true });
            copyDir(workspaceSrc, workspaceDest, ['.git']);
        }
        
        // Restore credentials
        restoreStatus.message = 'Restoring credentials...';
        restoreStatus.progress = 55;
        const credsSrc = path.join(extractedDir, 'credentials');
        const credsDest = path.join(OPENCLAW_DIR, 'credentials');
        if (fs.existsSync(credsSrc)) {
            fs.mkdirSync(credsDest, { recursive: true });
            copyDir(credsSrc, credsDest);
        }
        
        // Restore agents
        restoreStatus.message = 'Restoring agents...';
        restoreStatus.progress = 70;
        const agentsSrc = path.join(extractedDir, 'agents');
        const agentsDest = path.join(OPENCLAW_DIR, 'agents');
        if (fs.existsSync(agentsSrc)) {
            fs.mkdirSync(agentsDest, { recursive: true });
            copyDir(agentsSrc, agentsDest);
        }
        
        // Restore telegram
        restoreStatus.message = 'Restoring telegram...';
        restoreStatus.progress = 85;
        const telegramSrc = path.join(extractedDir, 'telegram');
        const telegramDest = path.join(OPENCLAW_DIR, 'telegram');
        if (fs.existsSync(telegramSrc)) {
            fs.mkdirSync(telegramDest, { recursive: true });
            copyDir(telegramSrc, telegramDest);
        }
        
        // Restore cron
        restoreStatus.message = 'Restoring cron...';
        restoreStatus.progress = 95;
        const cronSrc = path.join(extractedDir, 'cron');
        const cronDest = path.join(OPENCLAW_DIR, 'cron');
        if (fs.existsSync(cronSrc)) {
            fs.mkdirSync(cronDest, { recursive: true });
            copyDir(cronSrc, cronDest);
        }
        
        // Restore devices
        restoreStatus.message = 'Restoring devices...';
        const devicesSrc = path.join(extractedDir, 'devices');
        const devicesDest = path.join(OPENCLAW_DIR, 'devices');
        if (fs.existsSync(devicesSrc)) {
            fs.mkdirSync(devicesDest, { recursive: true });
            copyDir(devicesSrc, devicesDest);
        }
        
        // Restore identity
        restoreStatus.message = 'Restoring identity...';
        const identitySrc = path.join(extractedDir, 'identity');
        const identityDest = path.join(OPENCLAW_DIR, 'identity');
        if (fs.existsSync(identitySrc)) {
            fs.mkdirSync(identityDest, { recursive: true });
            copyDir(identitySrc, identityDest);
        }
        
        // Restore memory
        restoreStatus.message = 'Restoring memory...';
        const memorySrc = path.join(extractedDir, 'memory');
        const memoryDest = path.join(OPENCLAW_DIR, 'memory');
        if (fs.existsSync(memorySrc)) {
            fs.mkdirSync(memoryDest, { recursive: true });
            copyDir(memorySrc, memoryDest);
        }
        
        // Restore canvas
        restoreStatus.message = 'Restoring canvas...';
        const canvasSrc = path.join(extractedDir, 'canvas');
        const canvasDest = path.join(OPENCLAW_DIR, 'canvas');
        if (fs.existsSync(canvasSrc)) {
            fs.mkdirSync(canvasDest, { recursive: true });
            copyDir(canvasSrc, canvasDest);
        }
        
        // Restore completions
        restoreStatus.message = 'Restoring completions...';
        const completionsSrc = path.join(extractedDir, 'completions');
        const completionsDest = path.join(OPENCLAW_DIR, 'completions');
        if (fs.existsSync(completionsSrc)) {
            fs.mkdirSync(completionsDest, { recursive: true });
            copyDir(completionsSrc, completionsDest);
        }
        
        // Restore media
        restoreStatus.message = 'Restoring media...';
        const mediaSrc = path.join(extractedDir, 'media');
        const mediaDest = path.join(OPENCLAW_DIR, 'media');
        if (fs.existsSync(mediaSrc)) {
            fs.mkdirSync(mediaDest, { recursive: true });
            copyDir(mediaSrc, mediaDest);
        }
        
        // Restore skills
        restoreStatus.message = 'Restoring skills...';
        const skillsSrc = path.join(extractedDir, 'skills');
        const skillsDest = path.join(OPENCLAW_DIR, 'skills');
        if (fs.existsSync(skillsSrc)) {
            fs.mkdirSync(skillsDest, { recursive: true });
            copyDir(skillsSrc, skillsDest);
        }
        
        // Restore workspace skills
        const wsSkillsSrc = path.join(extractedDir, 'workspace_skills');
        const wsSkillsDest = path.join(OPENCLAW_DIR, 'workspace/skills');
        if (fs.existsSync(wsSkillsSrc)) {
            fs.mkdirSync(wsSkillsDest, { recursive: true });
            copyDir(wsSkillsSrc, wsSkillsDest);
        }
        
        // Restore gateway service
        restoreStatus.message = 'Setting up gateway...';
        const currentUser = os.userInfo().username;
        await execPromise(`chown -R ${currentUser}:${currentUser} ${OPENCLAW_DIR}`);
        await execPromise('openclaw gateway install');
        await execPromise('systemctl --user start openclaw-gateway.service');
        
        // Sync crontab after restore
        const schedules = listSchedules();
        syncCrontab(schedules);
        
        // Clean up temp
        fs.rmSync(tempDir, { recursive: true });
        
        restoreStatus.progress = 100;
        restoreStatus.message = 'Restore completed!';
        restoreStatus.completed = true;
        restoreStatus.inProgress = false;
    } catch (err) {
        restoreStatus.error = err.message;
        restoreStatus.message = 'Error: ' + err.message;
        restoreStatus.inProgress = false;
        throw err;
    }
    
    return true;
}

// Schedule functions
function listSchedules() {
    const schedules = [];
    const cronFile = path.join(CRON_DIR, 'backup.json');
    
    if (fs.existsSync(cronFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
            return data.schedules || [];
        } catch (e) {
            return [];
        }
    }
    return [];
}

function syncCrontab(schedules) {
    const enabledSchedules = schedules.filter(s => s.enabled);
    
    // Remove existing backup cron entries
    let currentCrontab = '';
    try {
        currentCrontab = execSync('crontab -l 2>/dev/null || echo ""').toString();
    } catch (e) {
        currentCrontab = '';
    }
    
    const lines = currentCrontab.split('\n').filter(line => 
        !line.includes('openclaw-backup.sh')
    );
    
    // Add new schedules
    enabledSchedules.forEach(schedule => {
        const possiblePaths = [
            path.join(OPENCLAW_DIR, 'workspace/scripts/openclaw-backup.sh'),
            path.join(OPENCLAW_DIR, 'openclaw-backup/openclaw-backup.sh'),
            path.join(path.dirname(__dirname), 'openclaw-backup/openclaw-backup.sh')
        ];
        
        let scriptPath = possiblePaths.find(p => fs.existsSync(p));
        
        if (!scriptPath) {
            console.error('Could not find openclaw-backup.sh');
            return;
        }
        
        const logPath = path.join(OPENCLAW_DIR, 'backups/backup.log');
        const cronLine = `${schedule.cron} "${scriptPath}" --auto >> "${logPath}" 2>&1`;
        lines.push(cronLine);
    });
    
    // Write new crontab
    const newCrontab = lines.filter(l => l.trim()).join('\n') + '\n';
    try {
        execSync(`echo "${newCrontab}" | crontab -`, { stdio: 'pipe' });
    } catch (e) {
        console.error('Failed to update crontab:', e.message);
    }
}

function createSchedule(cronExpression, enabled = true) {
    const id = 'backup_' + Date.now();
    const schedules = listSchedules();
    
    schedules.push({
        id,
        cron: cronExpression,
        enabled,
        created: new Date().toISOString()
    });
    
    const cronFile = path.join(CRON_DIR, 'backup.json');
    fs.mkdirSync(CRON_DIR, { recursive: true });
    fs.writeFileSync(cronFile, JSON.stringify({ schedules }, null, 2));
    
    // Sync to system crontab
    syncCrontab(schedules);
    
    return { success: true, id, schedules };
}

function deleteSchedule(id) {
    let schedules = listSchedules();
    schedules = schedules.filter(s => s.id !== id);
    
    const cronFile = path.join(CRON_DIR, 'backup.json');
    fs.writeFileSync(cronFile, JSON.stringify({ schedules }, null, 2));
    
    // Sync to system crontab
    syncCrontab(schedules);
    
    return { success: true, schedules };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    const { pathname, params } = parseUrl(req.url);
    
    // API routes
    try {
        // GET /api/backup/list
        if (req.method === 'GET' && pathname === '/api/backup/list') {
            const allBackups = await listBackups();
            const page = parseInt(params.get('page')) || 1;
            const limit = parseInt(params.get('limit')) || 10;
            const total = allBackups.length;
            const totalPages = Math.ceil(total / limit);
            const backups = allBackups.slice((page - 1) * limit, page * limit);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ backups, page, limit, total, totalPages }));
            return;
        }
        
        // POST /api/backup/create
        if (req.method === 'POST' && pathname === '/api/backup/create') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                let type = 'manual';
                try {
                    const data = JSON.parse(body || '{}');
                    type = data.type || 'manual';
                } catch (e) {
                    // Use default
                }
                const filename = await createBackup(type);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, filename }));
            });
            return;
        }
        
        // POST /api/backup/restore
        if (req.method === 'POST' && pathname === '/api/backup/restore') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { filename } = JSON.parse(body);
                restoreBackup(filename).catch(err => {
                    console.error('Restore error:', err);
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, status: restoreStatus }));
            });
            return;
        }
        
        // GET /api/backup/restore/status
        if (req.method === 'GET' && pathname === '/api/backup/restore/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(restoreStatus));
            return;
        }
        
        // GET /api/backup/download/:filename
        if (req.method === 'GET' && pathname.startsWith('/api/backup/download/')) {
            const filename = pathname.split('/').pop();
            const filepath = path.join(BACKUP_DIR, filename);
            
            if (!fs.existsSync(filepath)) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            
            res.writeHead(200, {
                'Content-Type': 'application/x-tar-gz',
                'Content-Disposition': `attachment; filename="${filename}"`
            });
            fs.createReadStream(filepath).pipe(res);
            return;
        }
        
        // POST /api/backup/upload
        if (req.method === 'POST' && pathname === '/api/backup/upload') {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', async () => {
                const buffer = Buffer.concat(chunks);
                
                // Extract filename from Content-Disposition header
                const contentDisposition = req.headers['content-disposition'] || '';
                const match = contentDisposition.match(/filename="(.+)"/);
                const originalName = match ? match[1] : 'uploaded_backup.tar.gz';
                
                // Validate it's a tar.gz file
                if (!originalName.endsWith('.tar.gz')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Only .tar.gz files allowed' }));
                    return;
                }
                
                // Sanitize filename
                const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
                const uploadPath = path.join(BACKUP_DIR, safeName);
                fs.writeFileSync(uploadPath, buffer);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, filename: safeName }));
            });
            return;
        }
        
        // DELETE /api/backup/delete/:filename
        if (req.method === 'DELETE' && pathname.startsWith('/api/backup/delete/')) {
            const filename = pathname.split('/').pop();
            const filepath = path.join(BACKUP_DIR, filename);
            
            if (!fs.existsSync(filepath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }
            
            fs.unlinkSync(filepath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }
        
        // GET /api/backup/config
        if (req.method === 'GET' && pathname === '/api/backup/config') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }
        
        // POST /api/backup/config
        if (req.method === 'POST' && pathname === '/api/backup/config') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const newConfig = JSON.parse(body);
                config = { ...config, ...newConfig };
                saveConfig();
                cleanupBackups();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(config));
            });
            return;
        }
        
        // GET /api/backup/schedules
        if (req.method === 'GET' && pathname === '/api/backup/schedules') {
            const schedules = listSchedules();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ schedules }));
            return;
        }
        
        // POST /api/backup/schedules
        if (req.method === 'POST' && pathname === '/api/backup/schedules') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                const { cron, enabled } = JSON.parse(body);
                const result = createSchedule(cron, enabled);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            });
            return;
        }
        
        // DELETE /api/backup/schedules/:id
        if (req.method === 'DELETE' && pathname.startsWith('/api/backup/schedules/')) {
            const id = pathname.split('/').pop();
            const result = deleteSchedule(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }
        
        // POST /api/gateway/restart
        if (req.method === 'POST' && pathname === '/api/gateway/restart') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Gateway restart scheduled' }));
            
            // Restart gateway after 5 seconds
            setTimeout(async () => {
                try {
                    await execPromise('openclaw gateway install');
                    await new Promise(r => setTimeout(r, 5000));
                    await execPromise('openclaw gateway restart');
                    console.log('Gateway restarted after restore');
                } catch (e) {
                    console.error('Gateway restart failed:', e.message);
                }
            }, 5000);
            return;
        }
        
        // Serve static files
        let filepath = pathname === '/' 
            ? path.join(__dirname, 'backup-web.html')
            : path.join(__dirname, pathname);
        
        if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
            const ext = path.extname(filepath);
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
            res.end(fs.readFileSync(filepath));
            return;
        }
        
        // 404
        res.writeHead(404);
        res.end('Not found');
        
    } catch (err) {
        console.error('Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Backup UI: http://localhost:${PORT}/`);
    console.log(`📁 Backups: ${BACKUP_DIR}`);
});
