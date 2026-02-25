const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const app = express();
const PORT = process.env.PORT || 3000;

// Generate random password
function generateRandomPassword(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// SSH into PiKVM and change password
async function changePiKVMPassword(ipAddress, newPassword) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        // Python script to change password - using base64 encoding to avoid escaping issues
        const pythonScript = `
import os
import pty
import time

USER = "admin"
PASSWORD = "${newPassword}"
CMD = ["kvmd-htpasswd", "set", USER]

def automate():
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(CMD[0], CMD)
        except FileNotFoundError:
            print(f"Error: Command {CMD[0]} not found.")
            os._exit(1)
    else:
        time.sleep(1)
        os.write(fd, (PASSWORD + "\\n").encode())
        time.sleep(0.5)
        os.write(fd, (PASSWORD + "\\n").encode())
        time.sleep(0.5)
        print("Password changed successfully.")

if __name__ == "__main__":
    automate()
`;

        conn.on('ready', () => {
            console.log(`SSH connected to ${ipAddress}`);
            
            // First, ensure filesystem is writable
            console.log('Setting filesystem to read-write mode...');
            conn.exec('rw', (err, stream) => {
                if (err) {
                    console.error('Error setting rw mode:', err);
                    conn.end();
                    return reject(err);
                }
                
                stream.on('exit', (code) => {
                    console.log(`Filesystem set to rw mode. Exit code: ${code}`);
                    
                    // Use base64 encoding to avoid shell escaping issues
                    const base64Script = Buffer.from(pythonScript).toString('base64');
                    const writeScriptCmd = `echo '${base64Script}' | base64 -d > /tmp/change_password.py`;
                    
                    console.log('Writing Python script...');
                    conn.exec(writeScriptCmd, (err, stream) => {
                        if (err) {
                            console.error('Error writing script:', err);
                            conn.end();
                            return reject(err);
                        }
                        
                        let writeOutput = '';
                        let writeError = '';
                        
                        stream.on('data', (data) => {
                            writeOutput += data.toString();
                        });
                        
                        stream.stderr.on('data', (data) => {
                            writeError += data.toString();
                        });
                        
                        stream.on('close', (code) => {
                            console.log(`Script write completed. Exit code: ${code}`);
                            if (writeError) console.log('Write stderr:', writeError);
                            
                            // Step 2: Save the password to a temp file
                            const savePasswordCmd = `echo '${newPassword}' > /tmp/current_password.txt`;
                            
                            console.log('Saving password to file...');
                            conn.exec(savePasswordCmd, (err, stream) => {
                                if (err) {
                                    console.error('Error saving password:', err);
                                    conn.end();
                                    return reject(err);
                                }
                                
                                stream.on('exit', (code) => {
                                    console.log(`Password file saved. Exit code: ${code}`);
                                    
                                    // Step 3: Run the Python script
                                    console.log('Running Python script...');
                                    conn.exec('python3 /tmp/change_password.py 2>&1', (err, stream) => {
                                        if (err) {
                                            console.error('Error running script:', err);
                                            conn.end();
                                            return reject(err);
                                        }
                                        
                                        let output = '';
                                        stream.on('data', (data) => {
                                            output += data.toString();
                                            console.log('Script output:', data.toString());
                                        });
                                        
                                        stream.on('exit', (code) => {
                                            console.log(`Python script completed. Exit code: ${code}`);
                                            console.log('Full output:', output);
                                            
                                            // Step 4: Restart kvmd services
                                            console.log('Restarting kvmd services...');
                                            conn.exec('systemctl restart kvmd kvmd-nginx 2>&1', (err, stream) => {
                                                if (err) {
                                                    console.error('Error restarting services:', err);
                                                    conn.end();
                                                    return reject(err);
                                                }
                                                
                                                let restartOutput = '';
                                                stream.on('data', (data) => {
                                                    restartOutput += data.toString();
                                                });
                                                
                                                stream.on('exit', (code) => {
                                                    console.log(`Services restart completed. Exit code: ${code}`);
                                                    if (restartOutput) console.log('Restart output:', restartOutput);
                                                    conn.end();
                                                    resolve({ success: true, password: newPassword });
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
        
        conn.on('error', (err) => {
            console.error(`SSH connection error to ${ipAddress}:`, err.message);
            reject(err);
        });
        
        // Connect to the PiKVM
        conn.connect({
            host: ipAddress,
            port: 22,
            username: 'root',
            password: getSetupSshPassword(),
            readyTimeout: 10000
        });
    });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database path
const DB_PATH = path.join(__dirname, 'data', 'database.json');

// Helper functions
function readDatabase() {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return null;
    }
}

function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error writing database:', error);
        return false;
    }
}

// Normalize ID (trim and convert to string)
function normalizeId(id) {
    return String(id).trim();
}

// Log usage statistics
function logUsage(userId, boxId, action) {
    const db = readDatabase();
    if (!db) return;
    
    db.usageStats.push({
        userId,
        boxId,
        action,
        timestamp: new Date().toISOString()
    });
    
    writeDatabase(db);
}

// API Routes

// Get settings
app.get('/api/settings', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    res.json(db.settings);
});

// Update settings
app.post('/api/settings', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    db.settings = { ...db.settings, ...req.body };
    writeDatabase(db);
    res.json(db.settings);
});

// Check if ID is admin
app.get('/api/admin/check/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const numericId = normalizeId(req.params.id);
    const isAdmin = db.admins.some(admin => admin.id === numericId);
    res.json({ isAdmin, id: numericId });
});

// Get all admins
app.get('/api/admins', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    res.json(db.admins);
});

// Add admin
app.post('/api/admins', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const { id, name } = req.body;
    const numericId = normalizeId(id);
    
    if (!db.admins.some(admin => admin.id === numericId)) {
        db.admins.push({ id: numericId, name });
        writeDatabase(db);
    }
    res.json(db.admins);
});

// Delete admin
app.delete('/api/admins/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    db.admins = db.admins.filter(admin => admin.id !== req.params.id);
    writeDatabase(db);
    res.json(db.admins);
});

// Get all hives
app.get('/api/hives', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    res.json(db.hives);
});

// Add hive
app.post('/api/hives', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const { name } = req.body;
    const maxId = db.hives.reduce((max, h) => Math.max(max, h.id), 0);
    const newHive = { id: maxId + 1, name };
    db.hives.push(newHive);
    writeDatabase(db);
    res.json(newHive);
});

// Delete hive
app.delete('/api/hives/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const hiveId = parseInt(req.params.id);
    db.hives = db.hives.filter(h => h.id !== hiveId);
    db.boxes = db.boxes.filter(b => b.hiveId !== hiveId);
    writeDatabase(db);
    res.json({ success: true });
});

// Get boxes for a hive
app.get('/api/boxes', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const hiveId = req.query.hiveId ? parseInt(req.query.hiveId) : null;
    const boxes = hiveId ? db.boxes.filter(b => b.hiveId === hiveId) : db.boxes;
    res.json(boxes);
});

// Add box
app.post('/api/boxes', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const { hiveId, boxNumber, ipAddress } = req.body;
    const maxId = db.boxes.reduce((max, b) => Math.max(max, b.id), 0);
    const newBox = {
        id: maxId + 1,
        hiveId,
        boxNumber,
        ipAddress,
        status: 'free'
    };
    db.boxes.push(newBox);
    writeDatabase(db);
    res.json(newBox);
});

// Update box
app.put('/api/boxes/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const boxId = parseInt(req.params.id);
    const boxIndex = db.boxes.findIndex(b => b.id === boxId);
    
    if (boxIndex === -1) {
        return res.status(404).json({ error: 'Box not found' });
    }
    
    db.boxes[boxIndex] = { ...db.boxes[boxIndex], ...req.body };
    writeDatabase(db);
    res.json(db.boxes[boxIndex]);
});

// Delete box
app.delete('/api/boxes/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const boxId = parseInt(req.params.id);
    db.boxes = db.boxes.filter(b => b.id !== boxId);
    db.users = db.users.filter(u => u.boxId !== boxId);
    writeDatabase(db);
    res.json({ success: true });
});

// Get suggested IP for new box
app.get('/api/boxes/suggest-ip/:hiveId/:boxNumber', (req, res) => {
    const hiveId = parseInt(req.params.hiveId);
    const boxNumber = parseInt(req.params.boxNumber);
    const suggestedIp = `10.1.${hiveId}.${boxNumber}`;
    res.json({ suggestedIp });
});

// Login/Register user (Hive side)
app.post('/api/users/login', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    let { id, hiveId, forceUser } = req.body;
    const numericId = normalizeId(id);
    hiveId = parseInt(hiveId) || db.settings.currentHive;
    
    // Check if admin (unless forceUser is true)
    if (!forceUser) {
        const isAdmin = db.admins.some(admin => admin.id === numericId);
        if (isAdmin) {
            return res.json({ isAdmin: true, id: numericId });
        }
    }
    
    // Check if user already exists
    const existingUser = db.users.find(u => u.id === numericId);
    if (existingUser) {
        const box = db.boxes.find(b => b.id === existingUser.boxId);
        const identityMapping = db.identityMappings.find(m => m.id === numericId);
        return res.json({
            exists: true,
            user: existingUser,
            box,
            name: identityMapping ? identityMapping.name : null
        });
    }
    
    // Find available box
    const availableBox = db.boxes.find(b => b.hiveId === hiveId && b.status === 'free');
    if (!availableBox) {
        return res.json({ error: 'noAvailableBox', message: 'אין תאים פנויים' });
    }
    
    // Register new user
    const newUser = {
        id: numericId,
        boxId: availableBox.id,
        hiveId,
        connectedAt: new Date().toISOString()
    };
    
    db.users.push(newUser);
    availableBox.status = 'occupied';
    availableBox.userId = numericId;
    
    writeDatabase(db);
    logUsage(numericId, availableBox.id, 'connect');
    
    const identityMapping = db.identityMappings.find(m => m.id === numericId);
    
    res.json({
        success: true,
        user: newUser,
        box: availableBox,
        name: identityMapping ? identityMapping.name : null
    });
});

// Get user by ID (User side)
app.get('/api/users/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const numericId = normalizeId(req.params.id);
    const user = db.users.find(u => u.id === numericId);
    
    if (!user) {
        return res.json({ found: false });
    }
    
    const box = db.boxes.find(b => b.id === user.boxId);
    const identityMapping = db.identityMappings.find(m => m.id === numericId);
    
    res.json({
        found: true,
        user,
        box,
        name: identityMapping ? identityMapping.name : null
    });
});

// Disconnect user (Yellow button - just disconnect session)
app.post('/api/users/:id/disconnect', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const numericId = normalizeId(req.params.id);
    // Just log the disconnect action, don't free the box
    logUsage(numericId, null, 'disconnect-session');
    
    res.json({ success: true, message: 'התנתקת מהמערכת' });
});

// Release box (Red button - free the box)
app.post('/api/users/:id/release', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const numericId = normalizeId(req.params.id);
    const user = db.users.find(u => u.id === numericId);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    // Free the box
    const box = db.boxes.find(b => b.id === user.boxId);
    if (box) {
        box.status = 'free';
        delete box.userId;
    }
    
    // Remove user
    db.users = db.users.filter(u => u.id !== numericId);
    
    writeDatabase(db);
    logUsage(numericId, user.boxId, 'release');
    
    res.json({ success: true, message: 'התא שוחרר בהצלחה' });
});

// Get all users (for admin)
app.get('/api/users', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const usersWithBoxes = db.users.map(user => {
        const box = db.boxes.find(b => b.id === user.boxId);
        const identityMapping = db.identityMappings.find(m => m.id === user.id);
        return { ...user, box, name: identityMapping ? identityMapping.name : null };
    });
    
    res.json(usersWithBoxes);
});

// Delete user (admin)
app.delete('/api/users/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const numericId = normalizeId(req.params.id);
    const user = db.users.find(u => u.id === numericId);
    
    if (user) {
        const box = db.boxes.find(b => b.id === user.boxId);
        if (box) {
            box.status = 'free';
            delete box.userId;
        }
        db.users = db.users.filter(u => u.id !== numericId);
        writeDatabase(db);
        logUsage(numericId, user ? user.boxId : null, 'admin-delete');
    }
    
    res.json({ success: true });
});

// Identity mappings
app.get('/api/identity-mappings', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    res.json(db.identityMappings);
});

app.post('/api/identity-mappings', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const { id, name } = req.body;
    const numericId = normalizeId(id);
    
    const existing = db.identityMappings.findIndex(m => m.id === numericId);
    if (existing !== -1) {
        db.identityMappings[existing].name = name;
    } else {
        db.identityMappings.push({ id: numericId, name });
    }
    
    writeDatabase(db);
    res.json(db.identityMappings);
});

app.delete('/api/identity-mappings/:id', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    db.identityMappings = db.identityMappings.filter(m => m.id !== req.params.id);
    writeDatabase(db);
    res.json(db.identityMappings);
});

// Statistics
app.get('/api/stats', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Users per day (last 7 days)
    const usersPerDay = {};
    for (let i = 0; i < 7; i++) {
        const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().split('T')[0];
        usersPerDay[dateStr] = new Set();
    }
    
    db.usageStats.forEach(stat => {
        const statDate = new Date(stat.timestamp);
        const dateStr = statDate.toISOString().split('T')[0];
        if (usersPerDay[dateStr]) {
            usersPerDay[dateStr].add(stat.userId);
        }
    });
    
    const usersPerDayArray = Object.entries(usersPerDay).map(([date, users]) => ({
        date,
        count: users.size
    })).reverse();
    
    // Box usage
    const boxUsage = {};
    db.boxes.forEach(box => {
        boxUsage[box.id] = {
            boxNumber: box.boxNumber,
            hiveId: box.hiveId,
            currentStatus: box.status,
            usageCount: 0
        };
    });
    
    db.usageStats.filter(s => s.action === 'connect').forEach(stat => {
        if (boxUsage[stat.boxId]) {
            boxUsage[stat.boxId].usageCount++;
        }
    });
    
    // User usage
    const userUsage = {};
    db.usageStats.forEach(stat => {
        if (!userUsage[stat.userId]) {
            userUsage[stat.userId] = { connects: 0, releases: 0 };
        }
        if (stat.action === 'connect') userUsage[stat.userId].connects++;
        if (stat.action === 'release') userUsage[stat.userId].releases++;
    });
    
    res.json({
        usersPerDay: usersPerDayArray,
        boxUsage: Object.values(boxUsage),
        userUsage,
        usageStats: db.usageStats,
        totalUsers: db.users.length,
        totalBoxes: db.boxes.length,
        freeBoxes: db.boxes.filter(b => b.status === 'free').length,
        occupiedBoxes: db.boxes.filter(b => b.status === 'occupied').length
    });
});

// Reset system
app.post('/api/reset', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    // Free all boxes
    db.boxes.forEach(box => {
        box.status = 'free';
        delete box.userId;
    });
    
    // Clear users
    db.users = [];
    
    writeDatabase(db);
    res.json({ success: true, message: 'המערכת אופסה בהצלחה' });
});

// Clear history (statistics)
app.post('/api/clear-history', (req, res) => {
    const db = readDatabase();
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    // Clear usage statistics
    db.usageStats = [];
    
    writeDatabase(db);
    res.json({ success: true, message: 'ההיסטוריה נמחקה בהצלחה' });
});

// ============================================================
// PiKVM Setup API
// ============================================================

const SETUP_DIR = path.join(__dirname, 'public', 'setup');

// Read SSH password from file
function getSetupSshPassword() {
    try {
        return fs.readFileSync(path.join(SETUP_DIR, 'ssh_password'), 'utf8').trim();
    } catch (err) {
        console.error('Error reading ssh_password file:', err.message);
        return 'root';
    }
}

// Helper: run a single SSH command and return output (with timeout)
function sshExec(conn, command, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let timer = null;
        conn.exec(command, (err, stream) => {
            if (err) return reject(err);
            let stdout = '';
            let stderr = '';

            timer = setTimeout(() => {
                try { stream.close(); } catch (e) {}
                reject(new Error(`SSH command timed out after ${timeoutMs / 1000}s: ${command.substring(0, 80)}`));
            }, timeoutMs);

            stream.on('data', (data) => { stdout += data.toString(); });
            stream.stderr.on('data', (data) => { stderr += data.toString(); });
            stream.on('close', (code) => {
                if (timer) clearTimeout(timer);
                resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
            });
        });
    });
}

// Helper: upload file content via SFTP (with timeout)
function sshUploadFile(conn, localFilePath, remotePath, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let fileContent;
        try {
            fileContent = fs.readFileSync(localFilePath);
        } catch (err) {
            return reject(new Error(`Cannot read local file: ${localFilePath}`));
        }

        let timer = setTimeout(() => {
            reject(new Error(`File upload timed out after ${timeoutMs / 1000}s for ${remotePath}`));
        }, timeoutMs);

        conn.sftp((err, sftp) => {
            if (err) {
                clearTimeout(timer);
                return reject(new Error(`SFTP session failed: ${err.message}`));
            }

            const writeStream = sftp.createWriteStream(remotePath);

            writeStream.on('error', (writeErr) => {
                clearTimeout(timer);
                sftp.end();
                reject(new Error(`SFTP write failed for ${remotePath}: ${writeErr.message}`));
            });

            writeStream.on('close', () => {
                clearTimeout(timer);
                sftp.end();
                resolve({ code: 0, stderr: '' });
            });

            writeStream.end(fileContent);
        });
    });
}

// Helper: create SSH connection (optional custom password overrides file)
function createSshConnection(ip, customPassword) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        const password = customPassword || getSetupSshPassword();

        conn.on('ready', () => resolve(conn));
        conn.on('error', (err) => reject(err));

        conn.connect({
            host: ip,
            port: 22,
            username: 'root',
            password: password,
            readyTimeout: 15000
        });
    });
}

// Get SSH password from file
app.get('/api/setup/ssh-password', (req, res) => {
    const password = getSetupSshPassword();
    res.json({ password });
});

// Test connection endpoint
app.post('/api/setup/test-connection', async (req, res) => {
    const { ip, password } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: 'IP is required' });

    let conn;
    try {
        conn = await createSshConnection(ip, password);
        const result = await sshExec(conn, 'hostname');
        conn.end();
        res.json({ success: true, message: `מחובר - hostname: ${result.stdout}` });
    } catch (err) {
        if (conn) conn.end();
        console.error('Test connection error:', err.message);
        res.json({ success: false, message: `שגיאת חיבור: ${err.message}` });
    }
});

// Run a setup stage
app.post('/api/setup/run-stage', async (req, res) => {
    const { stage, currentIp, newIp, password, uploadedLogo } = req.body;

    if (!stage || !currentIp) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    let conn;
    try {
        conn = await createSshConnection(currentIp, password);

        // Enable write mode first
        await sshExec(conn, 'rw');

        let result;
        switch (stage) {
            case 'changeIp':
                result = await stageChangeIp(conn, newIp);
                break;
            case 'setEdid':
                result = await stageSetEdid(conn);
                break;
            case 'copySsl':
                result = await stageCopySsl(conn);
                break;
            case 'replaceIndex':
                result = await stageReplaceIndex(conn);
                break;
            case 'replaceLogo':
                result = await stageReplaceLogo(conn, uploadedLogo);
                break;
            case 'configureNtp':
                result = await stageConfigureNtp(conn);
                break;
            case 'relativeMouse':
                result = await stageRelativeMouse(conn);
                break;
            case 'disableClosePopup':
                result = await stageDisableClosePopup(conn);
                break;
            default:
                result = { success: false, message: `Unknown stage: ${stage}` };
        }

        conn.end();
        res.json(result);
    } catch (err) {
        if (conn) conn.end();
        console.error(`Setup stage ${stage} error:`, err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Stage: Change IP address
async function stageChangeIp(conn, newIp) {
    if (!newIp) return { success: false, message: 'New IP address is required' };

    const networkConfig = `[Match]
Name=eth0

[Network]
Address=${newIp}/8
DNS=10.0.0.1
`;

    const base64Config = Buffer.from(networkConfig).toString('base64');
    const writeCmd = `echo '${base64Config}' | base64 -d > /etc/systemd/network/eth0.network`;

    const writeResult = await sshExec(conn, writeCmd);
    if (writeResult.code !== 0) {
        return { success: false, message: `Failed to write network config: ${writeResult.stderr}` };
    }

    // Restart networkd to apply
    const restartResult = await sshExec(conn, 'systemctl restart systemd-networkd 2>&1');
    
    return { 
        success: true, 
        message: `כתובת IP עודכנה ל-${newIp}/8` 
    };
}

// Stage: Set EDID
async function stageSetEdid(conn) {
    const edidHex = `00FFFFFFFFFFFF0010AC132045393639
201E0103803C22782ACD25A3574B9F27
0D5054A54B00714F8180A9C0D1C00101
010101010101023A801871382D40582C
450056502100001E000000FF00335335
475132330A2020202020000000FC0044
454C4C204432373231480A20000000FD
00384C1E5311000A2020202020200181
02031AB14F9005040302071601061112
1513141F65030C001000023A80187138
2D40582C450056502100001E011D8018
711C1620582C250056502100009E011D
007251D01E206E28550056502100001E
8C0AD08A20E02D10103E960056502100
00180000000000000000000000000000
0000000000000000000000000000004F`;

    const writeCmd = `echo '${edidHex}' > /etc/kvmd/tc358743-edid.hex`;
    const writeResult = await sshExec(conn, writeCmd);
    if (writeResult.code !== 0) {
        return { success: false, message: `Failed to write EDID: ${writeResult.stderr}` };
    }

    const applyResult = await sshExec(conn, 'kvmd-edidconf --apply 2>&1');
    if (applyResult.code !== 0) {
        return { success: false, message: `Failed to apply EDID: ${applyResult.stderr || applyResult.stdout}` };
    }

    return { success: true, message: 'EDID הוגדר והוחל בהצלחה' };
}

// Stage: Copy SSL certificates
async function stageCopySsl(conn) {
    const certPath = path.join(SETUP_DIR, 'server.crt');
    const keyPath = path.join(SETUP_DIR, 'server.key');

    // Backup existing certs
    await sshExec(conn, 'cp /etc/kvmd/nginx/ssl/server.crt /etc/kvmd/nginx/ssl/server.crt.bak 2>/dev/null');
    await sshExec(conn, 'cp /etc/kvmd/nginx/ssl/server.key /etc/kvmd/nginx/ssl/server.key.bak 2>/dev/null');

    // Upload new certs
    await sshUploadFile(conn, certPath, '/etc/kvmd/nginx/ssl/server.crt');
    await sshUploadFile(conn, keyPath, '/etc/kvmd/nginx/ssl/server.key');

    // Set permissions
    await sshExec(conn, 'chmod 644 /etc/kvmd/nginx/ssl/server.crt');
    await sshExec(conn, 'chmod 600 /etc/kvmd/nginx/ssl/server.key');

    // Restart nginx (don't wait too long - use shorter timeout)
    const restartResult = await sshExec(conn, 'systemctl restart kvmd-nginx 2>&1', 15000).catch(err => {
        console.warn('kvmd-nginx restart timeout/error (non-fatal):', err.message);
        return { code: -1, stdout: '', stderr: err.message };
    });

    return { success: true, message: 'תעודות SSL הועתקו והשירות הופעל מחדש' };
}

// Stage: Replace index.html
async function stageReplaceIndex(conn) {
    const indexPath = path.join(SETUP_DIR, 'pikvm_index.html');

    // Backup existing
    await sshExec(conn, 'cp /usr/share/kvmd/web/kvm/index.html /usr/share/kvmd/web/kvm/index.html.bak 2>/dev/null');

    // Upload new
    await sshUploadFile(conn, indexPath, '/usr/share/kvmd/web/kvm/index.html');

    return { success: true, message: 'index.html הוחלף בהצלחה' };
}

// Stage: Replace logo (supports uploaded base64 or default file)
async function stageReplaceLogo(conn, uploadedLogoBase64) {
    // Backup existing
    await sshExec(conn, 'cp /usr/share/kvmd/web/share/svg/logo.svg /usr/share/kvmd/web/share/svg/logo.svg.bak 2>/dev/null');

    if (uploadedLogoBase64) {
        // User uploaded a custom logo - send it via base64
        const cmd = `echo '${uploadedLogoBase64}' | base64 -d > /usr/share/kvmd/web/share/svg/logo.svg`;
        const result = await sshExec(conn, cmd);
        if (result.code !== 0) {
            return { success: false, message: `Failed to upload custom logo: ${result.stderr}` };
        }
        return { success: true, message: 'logo.svg הוחלף בהצלחה (קובץ מותאם אישית)' };
    } else {
        // Use default file from setup folder
        const logoPath = path.join(SETUP_DIR, 'pikvm_logo.svg');
        await sshUploadFile(conn, logoPath, '/usr/share/kvmd/web/share/svg/logo.svg');
        return { success: true, message: 'logo.svg הוחלף בהצלחה (קובץ ברירת מחדל)' };
    }
}

// Stage: Set relative mouse mode in override.yaml
async function stageRelativeMouse(conn) {
    const requiredBlock = `kvmd:
    hid:
        mouse:
            absolute: false`;

    // Check if override.yaml exists and already has the config
    const checkResult = await sshExec(conn, 'cat /etc/kvmd/override.yaml 2>/dev/null');
    
    if (checkResult.code === 0 && checkResult.stdout.includes('absolute: false')) {
        return { success: true, message: 'override.yaml כבר מכיל הגדרת עכבר relative' };
    }

    if (checkResult.code === 0 && checkResult.stdout.trim().length > 0) {
        // File exists with content - check if it already has kvmd.hid section
        const existing = checkResult.stdout;
        if (existing.includes('hid:') && existing.includes('mouse:')) {
            // Has mouse section but wrong value - use sed to fix
            const sedResult = await sshExec(conn, "sed -i 's/absolute: true/absolute: false/g' /etc/kvmd/override.yaml");
            if (sedResult.code !== 0) {
                return { success: false, message: `Failed to update override.yaml: ${sedResult.stderr}` };
            }
            // Verify it was changed
            const verifyResult = await sshExec(conn, 'cat /etc/kvmd/override.yaml');
            if (verifyResult.stdout.includes('absolute: false')) {
                return { success: true, message: 'override.yaml עודכן - עכבר הועבר למצב relative' };
            }
        }
        // Append the block to existing file
        const appendBase64 = Buffer.from('\n' + requiredBlock + '\n').toString('base64');
        const appendCmd = `echo '${appendBase64}' | base64 -d >> /etc/kvmd/override.yaml`;
        const appendResult = await sshExec(conn, appendCmd);
        if (appendResult.code !== 0) {
            return { success: false, message: `Failed to append to override.yaml: ${appendResult.stderr}` };
        }
    } else {
        // File doesn't exist or is empty - create it
        const createBase64 = Buffer.from(requiredBlock + '\n').toString('base64');
        const createCmd = `echo '${createBase64}' | base64 -d > /etc/kvmd/override.yaml`;
        const createResult = await sshExec(conn, createCmd);
        if (createResult.code !== 0) {
            return { success: false, message: `Failed to create override.yaml: ${createResult.stderr}` };
        }
    }

    return { success: true, message: 'override.yaml עודכן - עכבר הוגדר למצב relative' };
}

// Stage: Disable close popup (page.close.ask = false)
async function stageDisableClosePopup(conn) {
    const targetFile = '/usr/share/kvmd/web/share/js/kvm/main.js';

    // Backup existing file
    await sshExec(conn, `cp ${targetFile} ${targetFile}.bak 2>/dev/null`);

    // Check if file exists
    const checkResult = await sshExec(conn, `test -f ${targetFile} && echo exists`);
    if (!checkResult.stdout.includes('exists')) {
        return { success: false, message: `הקובץ ${targetFile} לא נמצא` };
    }

    // Check current state
    const grepResult = await sshExec(conn, `grep 'page.close.ask' ${targetFile}`);
    if (grepResult.code !== 0 || !grepResult.stdout) {
        return { success: false, message: 'לא נמצאה שורת page.close.ask בקובץ main.js' };
    }

    // Already set to false?
    if (grepResult.stdout.includes('"page.close.ask", false') || grepResult.stdout.includes("'page.close.ask', false")) {
        return { success: true, message: 'page.close.ask כבר מוגדר כ-false' };
    }

    // Replace true with false for page.close.ask
    const sedCmd = `sed -i 's/"page.close.ask", true/"page.close.ask", false/g' ${targetFile}`;
    const sedResult = await sshExec(conn, sedCmd);
    if (sedResult.code !== 0) {
        return { success: false, message: `שגיאה בעריכת main.js: ${sedResult.stderr}` };
    }

    // Verify the change
    const verifyResult = await sshExec(conn, `grep 'page.close.ask' ${targetFile}`);
    if (verifyResult.stdout.includes('false')) {
        return { success: true, message: 'חלון קופץ בעת יציאה בוטל בהצלחה (page.close.ask = false)' };
    }

    return { success: false, message: 'השינוי לא אומת - ייתכן שהפורמט בקובץ שונה מהצפוי' };
}

// Stage: Configure NTP
async function stageConfigureNtp(conn) {
    // Configure NTP server in timesyncd
    const ntpConfig = `[Time]
NTP=10.253.253.1
FallbackNTP=10.253.253.1
`;

    const base64Config = Buffer.from(ntpConfig).toString('base64');
    const writeCmd = `echo '${base64Config}' | base64 -d > /etc/systemd/timesyncd.conf`;

    const writeResult = await sshExec(conn, writeCmd);
    if (writeResult.code !== 0) {
        return { success: false, message: `Failed to write NTP config: ${writeResult.stderr}` };
    }

    // Enable and restart timesyncd
    await sshExec(conn, 'systemctl enable systemd-timesyncd 2>&1');
    const restartResult = await sshExec(conn, 'systemctl restart systemd-timesyncd 2>&1');

    // Verify NTP status
    const statusResult = await sshExec(conn, 'timedatectl show --property=NTP --value 2>&1');

    return { 
        success: true, 
        message: `NTP הופעל עם שרת 10.253.253.1 (סטטוס: ${statusResult.stdout || 'active'})` 
    };
}

// Setup page route
app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// Hive system route
app.get('/box', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'hive.html'));
});

// API endpoint to change PiKVM password and get redirect credentials
app.post('/api/pikvm/connect', async (req, res) => {
    const { ipAddress } = req.body;
    
    if (!ipAddress) {
        return res.status(400).json({ error: 'IP address is required' });
    }
    
    try {
        // Generate a random 12-character password
        const newPassword = generateRandomPassword(12);
        
        console.log(`Changing password for PiKVM at ${ipAddress}...`);
        
        // SSH into the machine and change password
        await changePiKVMPassword(ipAddress, newPassword);
        
        // Brief wait for services to start restarting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        res.json({
            success: true,
            password: newPassword,
            ipAddress: ipAddress,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Error changing PiKVM password:', error);
        res.status(500).json({
            error: 'Failed to change password',
            message: error.message
        });
    }
});

// User system route
app.get('/screen', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Web Shell System running on port ${PORT}`);
    console.log(`Hive System: http://localhost:${PORT}/box?id=1`);
    console.log(`User System: http://localhost:${PORT}/screen`);
});
