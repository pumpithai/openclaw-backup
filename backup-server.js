const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn, execSync } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const HOME_DIR = os.homedir();
const OPENCLAW_DIR = path.join(HOME_DIR, '.openclaw');
const SCRIPT_DIR = __dirname;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(OPENCLAW_DIR, 'backups');
const CRON_DIR = process.env.CRON_DIR || path.join(OPENCLAW_DIR, 'cron');
const CONFIG_FILE = path.join(SCRIPT_DIR, 'config.json');
const PORT = process.env.PORT || 4000;

// Default config (all in one file)
let allConfig = {
    maxBackups: 10,
    maxBackupsSize: 0,
    patterns: [
        '.log', '.tmp', '.temp', '.cache',
        '.bak', '_bak',
        '.DS_Store', 'Thumbs.db',
        '*.log', '*.tmp',
        'backup', 'backups'
    ],
    schedules: []
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(allConfig, null, 2));
}

// Load all config
function loadAllConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            allConfig = { ...allConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        } else {
            saveConfig();
        }
    } catch (e) {}
}

// Cleanup old backups
function cleanupBackups() {
    if (allConfig.maxBackups <= 0) return;
    
    // Get all auto backups sorted by time
    const allFiles = fs.readdirSync(BACKUP_DIR)
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
        .sort((a, b) => b.time - a.time);
    
    const autoFiles = allFiles.filter(f => f.type === 'auto');
    
    // Cleanup auto backups over limit
    if (autoFiles.length > allConfig.maxBackups) {
        const toDelete = autoFiles.slice(allConfig.maxBackups);
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

// Ensure backup directory exists before any file operations
fs.mkdirSync(BACKUP_DIR, { recursive: true });

loadAllConfig();

// Restore status tracking
let restoreStatus = {
    inProgress: false,
    filename: '',
    progress: 0,
    message: 'Idle',
    completed: false,
    error: null
};

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

function getDirSize(dirPath) {
    let size = 0;
    try {
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            try {
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    size += getDirSize(itemPath);
                } else {
                    size += stat.size;
                }
            } catch (e) {}
        }
    } catch (e) {}
    return size;
}

// Create backup
async function createBackup(type = 'manual', options = {}) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const patterns = options.patterns || [];
    const suffix = patterns.length > 0 ? `_patterns_${patterns.length}` : '';
    const backupName = `openclaw_${type}_backup_${timestamp}${suffix}`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    
    fs.mkdirSync(backupPath, { recursive: true });
    
    let rsyncOpts = `-a --exclude=.git --exclude=node_modules --exclude=.openclaw --exclude='backups' --exclude='${backupName}'`;
    
    for (const p of patterns) {
        const pattern = p;
        if (pattern.startsWith('.')) {
            rsyncOpts += ` --exclude='*${pattern}'`;
        } else if (pattern.startsWith('*')) {
            rsyncOpts += ` --exclude='*${pattern.slice(1)}'`;
        } else if (pattern.endsWith('*')) {
            rsyncOpts += ` --exclude='${pattern.slice(0, -1)}*'`;
        } else if (pattern.includes('*')) {
            rsyncOpts += ` --exclude='${pattern}'`;
        } else {
            rsyncOpts += ` --exclude='${pattern}' --exclude='${pattern}/*'`;
        }
    }
    
    await execPromise(`rsync ${rsyncOpts} '${OPENCLAW_DIR}/' '${backupPath}/'`);
    
    const tarPath = path.join(BACKUP_DIR, `${backupName}.tar.gz`);
    await execPromise(`tar -czf "${tarPath}" -C "${BACKUP_DIR}" "${backupName}"`);
    
    fs.rmSync(backupPath, { recursive: true });
    
    const metaPath = path.join(BACKUP_DIR, `${backupName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ 
        type, 
        patterns,
        created: new Date().toISOString() 
    }));
    
    cleanupBackups();
    
    return `${backupName}.tar.gz`;
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
        const currentGroup = process.platform === 'darwin' ? 'staff' : currentUser;
        await execPromise(`chown -R ${currentUser}:${currentGroup} ${OPENCLAW_DIR}`);
        
        // Update openclaw.json with correct paths FIRST
        const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
        if (fs.existsSync(configPath)) {
            try {
                let configContent = fs.readFileSync(configPath, 'utf8');
                
                if (configContent.includes('/home/') || configContent.includes('/Users/')) {
                    configContent = configContent.replace(/\/home\/[^\/]+/g, os.homedir());
                    configContent = configContent.replace(/\/Users\/[^\/]+/g, os.homedir());
                    fs.writeFileSync(configPath, configContent);
                    console.log('Updated openclaw.json paths');
                }
            } catch (e) {
                console.log('Failed to update openclaw.json:', e.message);
            }
        }
        
        // Update status for gateway setup steps
        try {
            restoreStatus.message = 'Fixing config paths...';
            restoreStatus.progress = 92;
            
            // Update openclaw.json with correct paths FIRST
            const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
            if (fs.existsSync(configPath)) {
                try {
                    let configContent = fs.readFileSync(configPath, 'utf8');
                    
                    if (configContent.includes('/home/') || configContent.includes('/Users/')) {
                        configContent = configContent.replace(/\/home\/[^\/]+/g, os.homedir());
                        configContent = configContent.replace(/\/Users\/[^\/]+/g, os.homedir());
                        fs.writeFileSync(configPath, configContent);
                        console.log('Updated openclaw.json paths');
                    }
                } catch (e) {
                    console.log('Failed to update openclaw.json:', e.message);
                }
            }
            
            restoreStatus.message = 'Running openclaw doctor --fix...';
            restoreStatus.progress = 94;
            await execPromise('openclaw doctor --fix');
            
            restoreStatus.message = 'Installing gateway...';
            restoreStatus.progress = 96;
            await execPromise('openclaw gateway install');
            
            if (process.platform !== 'darwin') {
                restoreStatus.message = 'Starting gateway service...';
                restoreStatus.progress = 98;
                await execPromise('systemctl --user start openclaw-gateway.service');
            }
        } catch (e) {
            console.log('Gateway setup skipped:', e.message);
        }
        
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
    return allConfig.schedules || [];
}

function syncCrontab(schedules) {
    const enabledSchedules = schedules.filter(s => s.enabled);
    
    // Update schedules in config
    allConfig.schedules = schedules;
    saveConfig();
    
    // Remove existing backup cron entries
    let currentCrontab = '';
    try {
        currentCrontab = execSync('crontab -l 2>/dev/null || echo ""').toString();
    } catch (e) {
        currentCrontab = '';
    }
    
    const lines = currentCrontab.split('\n').filter(line => 
        !line.includes('openclaw-backup.sh') && !line.includes('/api/backup/create')
    );
    
    // Add new schedules (use curl to call API for proper cleanup)
    enabledSchedules.forEach(schedule => {
        const logPath = path.join(OPENCLAW_DIR, 'backups/backup.log');
        const cronLine = schedule.cron + ' curl -s -X POST \'http://localhost:' + PORT + '/api/backup/create\' -H \'Content-Type: application/json\' -d \'{"type":"auto"}\' >> \'' + logPath + '\' 2>&1';
        lines.push(cronLine);
    });
    
    // Write new crontab
    const newCrontab = lines.filter(l => l.trim()).join('\n') + '\n';
    try {
        const proc = require('child_process').spawn('crontab', ['-']);
        proc.stdin.write(newCrontab);
        proc.stdin.end();
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
                let options = {};
                try {
                    const data = JSON.parse(body || '{}');
                    type = data.type || 'manual';
                    options = { 
                        patterns: data.patterns || [],
                        exclude: data.exclude, 
                        includeOnly: data.includeOnly
                    };
                } catch (e) {
                    // Use default
                }
                const filename = await createBackup(type, options);
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
        
        // GET /api/backup/hostname
        if (req.method === 'GET' && pathname === '/api/backup/hostname') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hostname: os.hostname() }));
            return;
        }
        
        // GET /api/backup/config
        if (req.method === 'GET' && pathname === '/api/backup/config') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }
        
        // GET /api/backup/folders
        if (req.method === 'GET' && pathname === '/api/backup/folders') {
            const folders = [];
            try {
                const items = fs.readdirSync(OPENCLAW_DIR);
                for (const item of items) {
                    const itemPath = path.join(OPENCLAW_DIR, item);
                    const stat = fs.statSync(itemPath);
                    if (stat.isDirectory() && !item.startsWith('.')) {
                        folders.push({ name: item, size: getDirSize(itemPath) });
                    }
                }
            } catch (e) {}
            folders.sort((a, b) => b.size - a.size);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ folders }));
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
        
        // GET /api/backup/options
        if (req.method === 'GET' && pathname === '/api/backup/options') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ patterns: allConfig.patterns, maxBackups: allConfig.maxBackups }));
            return;
        }
        
        // POST /api/backup/options
        if (req.method === 'POST' && pathname === '/api/backup/options') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                const newOptions = JSON.parse(body);
                if (newOptions.patterns) allConfig.patterns = newOptions.patterns;
                if (newOptions.maxBackups) allConfig.maxBackups = newOptions.maxBackups;
                saveConfig();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ patterns: allConfig.patterns, maxBackups: allConfig.maxBackups }));
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
