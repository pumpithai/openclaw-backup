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

const LOG_DIR = path.join(SCRIPT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_LOG_LINES = 500;

let eventLog = [];

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const entry = {
        timestamp,
        level,
        message,
        data
    };
    
    eventLog.unshift(entry);
    if (eventLog.length > MAX_LOG_LINES) {
        eventLog = eventLog.slice(0, MAX_LOG_LINES);
    }
    
    const logLine = data 
        ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(data)}`
        : `[${timestamp}] [${level}] ${message}`;
    
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, logLine + '\n');
    
    if (level === 'error') {
        console.error(logLine);
    } else {
        console.log(logLine);
    }
    
    return entry;
}

function parseMultipart(buffer, boundary) {
    const boundaryBuffer = Buffer.from('--' + boundary);
    const endBoundaryBuffer = Buffer.from('--' + boundary + '--');
    
    let start = 0;
    let parts = [];
    
    while (start < buffer.length) {
        let boundaryIdx = buffer.indexOf(boundaryBuffer, start);
        if (boundaryIdx === -1) break;
        
        if (buffer.compare(boundaryBuffer, 0, boundaryBuffer.length, boundaryIdx, boundaryIdx + boundaryBuffer.length) === 0) {
            if (buffer.compare(endBoundaryBuffer, 0, endBoundaryBuffer.length, boundaryIdx, boundaryIdx + endBoundaryBuffer.length) === 0) {
                break;
            }
            
            let nextBoundaryIdx = buffer.indexOf(boundaryBuffer, boundaryIdx + boundaryBuffer.length);
            if (nextBoundaryIdx === -1) break;
            
            let partStart = boundaryIdx + boundaryBuffer.length;
            while (partStart < nextBoundaryIdx && buffer[partStart] === 0x0D) partStart++;
            if (partStart < nextBoundaryIdx && buffer[partStart] === 0x0A) partStart++;
            
            let partEnd = nextBoundaryIdx - 2;
            while (partEnd > partStart && (buffer[partEnd] === 0x0D || buffer[partEnd] === 0x0A)) partEnd--;
            partEnd++;
            
            let headerEndIdx = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
            if (headerEndIdx !== -1 && headerEndIdx < partEnd) {
                let contentStart = headerEndIdx + 4;
                let content = buffer.slice(contentStart, partEnd);
                
                let header = buffer.slice(partStart, contentStart).toString();
                let filenameMatch = header.match(/filename="([^"]+)"/);
                
                if (filenameMatch) {
                    parts.push({
                        filename: filenameMatch[1],
                        data: content
                    });
                }
            }
            
            start = nextBoundaryIdx;
        } else {
            start = boundaryIdx + 1;
        }
    }
    
    return parts;
}

function isValidGzip(buffer) {
    if (buffer.length < 2) return false;
    return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

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
    const hostname = os.hostname();
    const patterns = options.patterns || [];
    const backupName = `${hostname}_${type}_${timestamp}`;
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

// Simple copy directory function
function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    const items = fs.readdirSync(src);
    for (const item of items) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
            copyDir(srcPath, destPath);
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
        log('error', `Backup file not found: ${filename}`);
        restoreStatus = { ...restoreStatus, inProgress: false, error: 'Backup file not found', message: 'Error: File not found' };
        throw new Error('Backup file not found');
    }
    
    const fileBuffer = fs.readFileSync(tarPath);
    if (!isValidGzip(fileBuffer)) {
        log('error', `Invalid gzip format: ${filename}`);
        restoreStatus = { ...restoreStatus, inProgress: false, error: 'Invalid gzip format', message: 'Error: Invalid backup file format' };
        throw new Error('Invalid gzip format - file may be corrupted');
    }
    
    try {
        restoreStatus.message = 'Extracting backup...';
        restoreStatus.progress = 10;
        log('info', 'Extracting backup archive...');
        const tempDir = path.join(BACKUP_DIR, 'temp_restore_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        
        await execPromise(`tar -xzf "${tarPath}" -C "${tempDir}"`);
        
        const items = fs.readdirSync(tempDir);
        const extractedDir = path.join(tempDir, items[0]);
        
        restoreStatus.message = 'Restoring all files...';
        restoreStatus.progress = 50;
        log('info', 'Restoring all files...');
        
        await execPromise(`rsync -a --exclude='backups' --exclude='backups/*' '${extractedDir}/' '${OPENCLAW_DIR}/'`);
        
        restoreStatus.message = 'Setting up gateway...';
        log('info', 'Setting up gateway...');
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
                    log('info', 'Updated openclaw.json paths');
                }
            } catch (e) {
                log('error', `Failed to update openclaw.json: ${e.message}`);
            }
        }
        
        try {
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
            log('warn', `Gateway setup skipped: ${e.message}`);
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
        log('info', 'Restore completed successfully');
    } catch (err) {
        log('error', `Restore failed: ${err.message}`);
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
                log('info', `Starting backup: ${type}`);
                const filename = await createBackup(type, options);
                log('info', `Backup completed: ${filename}`);
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
                log('info', `Starting restore: ${filename}`);
                restoreBackup(filename).catch(err => {
                    log('error', `Restore failed: ${err.message}`);
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
                
                const contentType = req.headers['content-type'] || '';
                let originalName = 'uploaded_backup.tar.gz';
                let fileData = buffer;
                
                if (contentType.includes('multipart/form-data')) {
                    const boundary = contentType.split('boundary=')[1];
                    if (boundary) {
                        const parts = parseMultipart(buffer, boundary);
                        if (parts.length > 0) {
                            originalName = parts[0].filename;
                            fileData = parts[0].data;
                        }
                    }
                }
                
                if (!originalName.endsWith('.tar.gz')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Only .tar.gz files allowed' }));
                    return;
                }
                
                if (!isValidGzip(fileData)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid gzip format' }));
                    return;
                }
                
                const uploadPath = path.join(BACKUP_DIR, originalName);
                fs.writeFileSync(uploadPath, fileData);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, filename: originalName }));
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
        
        // GET /api/backup/logs
        if (req.method === 'GET' && pathname === '/api/backup/logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ logs: eventLog }));
            return;
        }
        
        // DELETE /api/backup/logs
        if (req.method === 'DELETE' && pathname === '/api/backup/logs') {
            eventLog = [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
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
