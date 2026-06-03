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
                            const savePasswordCmd = `echo '${newPassword}' > /tmp/current_password.txt && echo '${newPassword}' > /tmp/web.txt`;
                            
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

// Return the client's IP address (the machine browsing the page)
app.get('/api/client-ip', (req, res) => {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || '';
    // Handle IPv6-mapped IPv4 (e.g. ::ffff:10.1.1.50)
    if (ip.startsWith('::ffff:')) ip = ip.substring(7);
    // If multiple IPs in x-forwarded-for, take the first
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    res.json({ ip });
});

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
    
    // Set heartbeat color to red (occupied) asynchronously
    setPiKVMHeartbeatColor(availableBox.ipAddress, 'red').catch(err => {
        console.error(`Failed to set heartbeat color to red for ${availableBox.ipAddress}: ${err.message}`);
    });
    
    // Trigger ATX long press click (shutdown) asynchronously
    triggerPiKVMATXClick(availableBox.ipAddress, 'power_long').catch(err => {
        console.error(`Failed to trigger ATX power_long for ${availableBox.ipAddress}: ${err.message}`);
    });
    
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
        
        // Reset heartbeat color back to green asynchronously
        setPiKVMHeartbeatColor(box.ipAddress, 'green').catch(err => {
            console.error(`Failed to reset heartbeat color to green for ${box.ipAddress}: ${err.message}`);
        });
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
            
            // Reset heartbeat color back to green asynchronously
            setPiKVMHeartbeatColor(box.ipAddress, 'green').catch(err => {
                console.error(`Failed to reset heartbeat color to green for ${box.ipAddress}: ${err.message}`);
            });
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
        
        // Reset heartbeat color back to green asynchronously
        setPiKVMHeartbeatColor(box.ipAddress, 'green').catch(err => {
            console.error(`Failed to reset heartbeat color to green for ${box.ipAddress}: ${err.message}`);
        });
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
const PYTHON_LIB_DIR = path.join(__dirname, 'public', 'pikvm', 'python_lib');

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

// Get new SSH password from file
app.get('/api/setup/new-ssh-password', (req, res) => {
    try {
        const password = fs.readFileSync(path.join(SETUP_DIR, 'new_ssh_password'), 'utf8').trim();
        res.json({ password });
    } catch (err) {
        console.error('Error reading new_ssh_password file:', err.message);
        res.json({ password: '' });
    }
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

const http = require('http');
const https = require('https');

// Global cache for PiKVM admin passwords to avoid SSH connection overhead
const adminPasswordCache = new Map(); // ip -> adminPassword

// Helper to check if string is valid JSON
function isValidJson(str) {
    try {
        const obj = JSON.parse(str);
        return typeof obj === 'object' && obj !== null;
    } catch (e) {
        return false;
    }
}

// Helper to make direct HTTPS requests to the local PiKVM API
function directPikvmRequest(ip, path, method, adminPassword, bodyData = null) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(`admin:${adminPassword}`).toString('base64');
        const options = {
            hostname: ip,
            port: 443,
            path: path,
            method: method,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            rejectUnauthorized: false, // Insecure: equivalent to curl -k
            timeout: 5000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ statusCode: res.statusCode, body: data });
                } else {
                    reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (bodyData) {
            req.write(bodyData);
        }
        req.end();
    });
}

// Test ATX components endpoint
app.post('/api/setup/test-atx', async (req, res) => {
    const { ip, password, action } = req.body;
    if (!ip || !action) {
        return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    try {
        // 1. Get or retrieve admin password
        let adminPassword = adminPasswordCache.get(ip);
        if (!adminPassword) {
            let conn;
            try {
                conn = await createSshConnection(ip, password);
                const passResult = await sshExec(conn, 'cat /tmp/web.txt 2>/dev/null || echo "admin"');
                adminPassword = passResult.stdout.trim() || 'admin';
                adminPasswordCache.set(ip, adminPassword);
            } catch (sshErr) {
                console.error(`SSH connection failed to get admin password, assuming 'admin':`, sshErr.message);
                adminPassword = 'admin';
            } finally {
                if (conn) conn.end();
            }
        }

        // 2. Perform action
        if (action === 'led' || action === 'led_green' || action === 'led_red' || action === 'led_off') {
            const color = action === 'led' ? 'colorized' : (action === 'led_green' ? 'green' : (action === 'led_red' ? 'red' : 'off'));
            let conn;
            try {
                conn = await createSshConnection(ip, password);
                // Write color to /tmp/heartbeat.color (the running heartbeat script reads this dynamically)
                const cmd = `echo "${color}" > /tmp/heartbeat.color`;
                const result = await sshExec(conn, cmd);
                if (result.code !== 0) {
                    res.json({ success: false, message: `שינוי מצב LED נכשל: ${result.stderr}` });
                } else {
                    const colorHeb = color === 'colorized' ? 'צבעוני' : (color === 'green' ? 'ירוק' : (color === 'red' ? 'אדום' : 'כבוי'));
                    res.json({ success: true, message: `הגדרת פעימות LED ל-${colorHeb} בוצעה בהצלחה` });
                }
            } catch (err) {
                res.json({ success: false, message: `שגיאה בחיבור ל-PiKVM: ${err.message}` });
            } finally {
                if (conn) conn.end();
            }
        } 
        else if (action === 'status') {
            try {
                const response = await directPikvmRequest(ip, '/api/atx', 'GET', adminPassword);
                res.json({ success: true, status: response.body });
            } catch (err) {
                // Try reading Prometheus endpoint as fallback
                try {
                    const promResponse = await new Promise((resolve, reject) => {
                        const options = {
                            hostname: ip,
                            port: 80,
                            path: '/api/export/prometheus/metrics',
                            method: 'GET',
                            timeout: 3000
                        };
                        const preq = http.get(options, (pres) => {
                            let pdata = '';
                            pres.on('data', (chunk) => { pdata += chunk; });
                            pres.on('end', () => {
                                if (pres.statusCode === 200) resolve(pdata);
                                else reject(new Error(`Status ${pres.statusCode}`));
                            });
                        });
                        preq.on('error', (pe) => reject(pe));
                        preq.on('timeout', () => { preq.destroy(); reject(new Error('Timeout')); });
                    });

                    const powerMetric = promResponse.match(/pikvm_atx_power\s+(\d+)/);
                    const hddMetric = promResponse.match(/pikvm_atx_hdd\s+(\d+)/);
                    const powerOn = powerMetric ? powerMetric[1] === '1' : false;
                    const hddActive = hddMetric ? hddMetric[1] === '1' : false;
                    res.json({ 
                        success: true, 
                        status: JSON.stringify({ ok: true, result: { leds: { power: powerOn, hdd: hddActive } } }) 
                    });
                } catch (promErr) {
                    res.json({ success: false, message: `Failed to query ATX status: ${err.message} (Prometheus: ${promErr.message})` });
                }
            }
        }
        else if (action === 'power' || action === 'power_long' || action === 'reset') {
            try {
                await directPikvmRequest(ip, `/api/atx/click?button=${action}`, 'POST', adminPassword);
                res.json({ success: true, message: 'הפקודה נשלחה בהצלחה' });
            } catch (err) {
                res.json({ success: false, message: `נכשל בשליחת פקודה: ${err.message}` });
            }
        }
        else {
            res.status(400).json({ success: false, message: `Unknown action: ${action}` });
        }
    } catch (err) {
        console.error('Test ATX component error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Run a setup stage
app.post('/api/setup/run-stage', async (req, res) => {
    const { stage, currentIp, newIp, password, uploadedLogo, skipNetworkRestart } = req.body;

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
                result = await stageChangeIp(conn, newIp, skipNetworkRestart);
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
            case 'configureAtxDelay':
                result = await stageConfigureAtxDelay(conn, req.body.atxDelay);
                break;
            case 'disableClosePopup':
                result = await stageDisableClosePopup(conn);
                break;
            case 'installPythonLibs':
                result = await stageInstallPythonLibs(conn);
                break;
            case 'configureHeartbeat':
                result = await stageConfigureHeartbeat(conn, req.body.heartbeatMode);
                break;
            case 'changePassword':
                result = await stageChangePassword(conn, req.body.newPassword);
                break;
            case 'rebootPikvm':
                result = await stageRebootPikvm(conn);
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
async function stageChangeIp(conn, newIp, skipNetworkRestart) {
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

    if (skipNetworkRestart) {
        // Reboot stage will apply the new IP
        return { 
            success: true, 
            message: `קובץ רשת עודכן ל-${newIp}/8 (יוחל באתחול מחדש)` 
        };
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
// Stage: Set relative mouse mode in override.yaml
async function stageRelativeMouse(conn) {
    const pythonScript = `import yaml
try:
    with open('/etc/kvmd/override.yaml', 'r') as f:
        data = yaml.safe_load(f) or {}
except Exception:
    data = {}

if 'kvmd' not in data or not isinstance(data['kvmd'], dict):
    data['kvmd'] = {}
if 'hid' not in data['kvmd'] or not isinstance(data['kvmd']['hid'], dict):
    data['kvmd']['hid'] = {}
if 'mouse' not in data['kvmd']['hid'] or not isinstance(data['kvmd']['hid']['mouse'], dict):
    data['kvmd']['hid']['mouse'] = {}

data['kvmd']['hid']['mouse']['absolute'] = False

with open('/etc/kvmd/override.yaml', 'w') as f:
    yaml.safe_dump(data, f, default_flow_style=False)
`;

    const base64Script = Buffer.from(pythonScript).toString('base64');
    const updateCmd = `echo '${base64Script}' | base64 -d | python3 -`;
    const execResult = await sshExec(conn, updateCmd);
    
    if (execResult.code !== 0) {
        return { success: false, message: `Failed to update override.yaml for mouse: ${execResult.stderr}` };
    }
    return { success: true, message: 'override.yaml עודכן - עכבר הועבר למצב relative' };
}

// Stage: Configure ATX long click delay in override.yaml
async function stageConfigureAtxDelay(conn, delay) {
    const targetDelay = parseFloat(delay) || 1.0;
    const pythonScript = `import yaml
try:
    with open('/etc/kvmd/override.yaml', 'r') as f:
        data = yaml.safe_load(f) or {}
except Exception:
    data = {}

if 'kvmd' not in data or not isinstance(data['kvmd'], dict):
    data['kvmd'] = {}
if 'atx' not in data['kvmd'] or not isinstance(data['kvmd']['atx'], dict):
    data['kvmd']['atx'] = {}

data['kvmd']['atx']['long_click_delay'] = float(${targetDelay})

with open('/etc/kvmd/override.yaml', 'w') as f:
    yaml.safe_dump(data, f, default_flow_style=False)
`;

    const base64Script = Buffer.from(pythonScript).toString('base64');
    const updateCmd = `echo '${base64Script}' | base64 -d | python3 -`;
    const execResult = await sshExec(conn, updateCmd);
    
    if (execResult.code !== 0) {
        return { success: false, message: `Failed to configure ATX delay: ${execResult.stderr}` };
    }
    return { success: true, message: `השהיית לחיצה ארוכה הוגדרה ל-${targetDelay} שניות ב-override.yaml` };
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

// Stage: Install Python libraries offline
async function stageInstallPythonLibs(conn) {
    const logs = [];
    
    if (!fs.existsSync(PYTHON_LIB_DIR)) {
        return { success: false, message: `Local directory not found: ${PYTHON_LIB_DIR}` };
    }

    let files;
    try {
        files = fs.readdirSync(PYTHON_LIB_DIR);
    } catch (err) {
        return { success: false, message: `Failed to read local python_lib directory: ${err.message}` };
    }

    if (files.length === 0) {
        return { success: false, message: `No library files found in local directory: ${PYTHON_LIB_DIR}` };
    }

    logs.push(`Found ${files.length} library files to deliver.`);

    // Create remote folder /tmp/python_lib
    logs.push(`Creating remote directory /tmp/python_lib on PiKVM...`);
    const mkdirResult = await sshExec(conn, 'mkdir -p /tmp/python_lib');
    if (mkdirResult.code !== 0) {
        logs.push(`ERROR: Failed to create remote directory: ${mkdirResult.stderr || mkdirResult.stdout}`);
        return { success: false, message: 'Failed to create remote directory', logs };
    }
    logs.push(`Remote directory created successfully.`);

    // Upload files sequentially
    logs.push(`Starting file transfer (delivering libraries)...`);
    for (const file of files) {
        const localPath = path.join(PYTHON_LIB_DIR, file);
        const remotePath = `/tmp/python_lib/${file}`;
        
        // Skip directories if any
        if (fs.statSync(localPath).isDirectory()) {
            continue;
        }

        logs.push(`Uploading: ${file} (${fs.statSync(localPath).size} bytes)`);
        try {
            await sshUploadFile(conn, localPath, remotePath);
        } catch (err) {
            logs.push(`ERROR: Failed to upload ${file}: ${err.message}`);
            // Clean up directory on error
            await sshExec(conn, 'rm -rf /tmp/python_lib');
            return { success: false, message: `Failed to upload file ${file}`, logs };
        }
    }
    logs.push(`All library files delivered successfully to PiKVM.`);

    // Run installation command
    // Set a long timeout (120000ms) for compiling/installing python packages
    logs.push(`Executing offline pip installation script...`);
    const installCmd = `cd /tmp/python_lib
# 1. Create a temporary virtual environment to bootstrap pip
echo "Creating temporary virtual environment to bootstrap pip..."
python3 -m venv --system-site-packages /tmp/temp_venv
if [ ! -f /tmp/temp_venv/bin/pip ]; then
    echo "ERROR: Failed to bootstrap pip inside virtual environment." >&2
    exit 1
fi

# 2. Get system site-packages path
SITE_PKG=$(python3 -c "import site; print(site.getsitepackages()[0])" 2>/dev/null)
if [ -z "$SITE_PKG" ]; then
    SITE_PKG="/usr/lib/python3.10/site-packages"
fi
echo "Target site-packages directory: $SITE_PKG"

# 3. Install build tools (setuptools, wheel, packaging) inside venv
echo "Installing build tools (setuptools, wheel, packaging) inside venv..."
/tmp/temp_venv/bin/pip install --no-index --find-links . setuptools wheel packaging

# 4. Install packages to system site-packages using venv's pip
echo "Installing python libraries to system site-packages..."
if /tmp/temp_venv/bin/pip install --target "$SITE_PKG" --no-build-isolation --break-system-packages --no-index --find-links . adafruit-blinka adafruit-circuitpython-neopixel rpi_ws281x 2>&1; then
    echo "Installation successful."
else
    echo "Retrying without --break-system-packages..."
    /tmp/temp_venv/bin/pip install --target "$SITE_PKG" --no-build-isolation --no-index --find-links . adafruit-blinka adafruit-circuitpython-neopixel rpi_ws281x
fi

# 5. Clean up the temporary venv
rm -rf /tmp/temp_venv`;

    const installResult = await sshExec(conn, installCmd, 120000).catch(err => {
        return { code: -1, stderr: err.message, stdout: '' };
    });

    // Parse command outputs
    if (installResult.stdout) {
        installResult.stdout.split('\n').forEach(line => {
            if (line.trim()) logs.push(line.trim());
        });
    }
    if (installResult.stderr) {
        installResult.stderr.split('\n').forEach(line => {
            if (line.trim()) logs.push(`ERROR: ${line.trim()}`);
        });
    }

    // Clean up uploaded files in all cases
    logs.push(`Cleaning up temporary remote files...`);
    await sshExec(conn, 'rm -rf /tmp/python_lib');
    logs.push(`Cleanup complete.`);

    if (installResult.code !== 0) {
        logs.push(`ERROR: Installation script exited with code ${installResult.code}`);
        return { 
            success: false, 
            message: 'pip installation command failed', 
            logs 
        };
    }

    logs.push(`Installation process finished successfully.`);
    return { 
        success: true, 
        message: 'ספריות Python הועתקו והותקנו בהצלחה במערכת',
        logs
    };
}

// Stage: Reboot PiKVM
async function stageRebootPikvm(conn) {
    // Send reboot command - connection will drop, which is expected
    try {
        await sshExec(conn, 'reboot', 5000);
    } catch (err) {
        // Connection drop or timeout is expected after reboot
    }
    return { success: true, message: 'PiKVM בתהליך אתחול מחדש' };
}

// Stage: Change root password
async function stageChangePassword(conn, newPassword) {
    if (!newPassword) return { success: false, message: 'New password is required' };

    // Use chpasswd to change the root password
    const escapedPassword = newPassword.replace(/'/g, "'\\''");
    const cmd = `echo 'root:${escapedPassword}' | chpasswd`;

    const result = await sshExec(conn, cmd);
    if (result.code !== 0) {
        return { success: false, message: `שינוי סיסמה נכשל: ${result.stderr}` };
    }

    return { success: true, message: 'סיסמת root שונתה בהצלחה' };
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

// Stage: Configure Heartbeat LED
async function stageConfigureHeartbeat(conn, heartbeatMode = 'green_red') {
    const targetMode = heartbeatMode || 'green_red';
    
    // 1. Python heartbeat script contents
    const pythonScript = `#!/usr/bin/env python3
import sys
import time
import board
import neopixel
import os
import signal
import argparse

PID_FILE = "/tmp/heartbeat.pid"

def kill_existing():
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE, 'r') as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, signal.SIGTERM)
            time.sleep(0.3)
    except Exception:
        pass

def write_pid():
    try:
        with open(PID_FILE, 'w') as f:
            f.write(str(os.getpid()))
    except Exception:
        pass

def get_current_state():
    color = 'green'
    try:
        if os.path.exists('/tmp/heartbeat.color'):
            with open('/tmp/heartbeat.color', 'r') as f:
                color = f.read().strip()
    except Exception:
        pass
    
    mode = 'green_red'
    try:
        if os.path.exists('/etc/kvmd/heartbeat.mode'):
            with open('/etc/kvmd/heartbeat.mode', 'r') as f:
                mode = f.read().strip()
    except Exception:
        pass
        
    return color, mode

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--color', type=str, default='green', choices=['green', 'red', 'off'])
    args = parser.parse_args()

    kill_existing()
    write_pid()

    # Configure NeoPixel D12
    try:
        led = neopixel.NeoPixel(board.D12, 1, pixel_order=neopixel.RGB)
    except Exception as e:
        print(f"Error initializing NeoPixel: {e}", file=sys.stderr)
        sys.exit(1)

    MAX_VAL = 120
    MIN_VAL = 40
    
    # If argparse got a command line flag (used when called from shell directly), write it to color file
    if args.color != 'green':
        try:
            with open('/tmp/heartbeat.color', 'w') as f:
                f.write(args.color)
        except Exception:
            pass

    def set_color(color_name, val):
        if color_name == 'green':
            led[0] = (0, val, 0)
        elif color_name == 'red':
            led[0] = (val, 0, 0)
        else:
            led[0] = (0, 0, 0)

    def handle_exit(signum, frame):
        led[0] = (0, 0, 0)
        sys.exit(0)
        
    signal.signal(signal.SIGTERM, handle_exit)
    signal.signal(signal.SIGINT, handle_exit)

    try:
        while True:
            color, mode = get_current_state()

            if mode == 'disabled' or color == 'off':
                led[0] = (0, 0, 0)
                time.sleep(0.2)
                continue

            if color == 'colorized':
                state_changed = False
                for i in range(50):
                    # Cycling Step 1: Red to Yellow
                    led[0] = (255, 3 * i, 0)
                    for _ in range(20):
                        time.sleep(0.01)
                        c, m = get_current_state()
                        if c != 'colorized' or m == 'disabled':
                            state_changed = True
                            break
                    if state_changed: break

                    # Cycling Step 2: Green to Cyan
                    led[0] = (0, 255, 3 * i)
                    for _ in range(20):
                        time.sleep(0.01)
                        c, m = get_current_state()
                        if c != 'colorized' or m == 'disabled':
                            state_changed = True
                            break
                    if state_changed: break

                    # Cycling Step 3: Blue to Magenta
                    led[0] = (3 * i, 0, 255)
                    for _ in range(20):
                        time.sleep(0.01)
                        c, m = get_current_state()
                        if c != 'colorized' or m == 'disabled':
                            state_changed = True
                            break
                    if state_changed: break
                
                if state_changed:
                    continue
                
                # After cycling test completes, revert color state to green heartbeat
                try:
                    with open('/tmp/heartbeat.color', 'w') as f:
                        f.write('green')
                except Exception:
                    pass
                continue

            if color == 'red' and mode == 'green_off':
                led[0] = (0, 0, 0)
                time.sleep(0.2)
                continue

            # Pulse 1: Fade up from MIN_VAL to MAX_VAL
            state_changed = False
            for val in range(MIN_VAL, MAX_VAL + 1, 4):
                set_color(color, val)
                time.sleep(0.015)
                c, m = get_current_state()
                if c != color or m != mode:
                    state_changed = True
                    break
            if state_changed: continue

            # Pulse 1: Fade down from MAX_VAL to MIN_VAL + 20
            for val in range(MAX_VAL, MIN_VAL + 19, -4):
                set_color(color, val)
                time.sleep(0.015)
                c, m = get_current_state()
                if c != color or m != mode:
                    state_changed = True
                    break
            if state_changed: continue

            # Pulse 2: Fade up from MIN_VAL + 20 to MAX_VAL
            for val in range(MIN_VAL + 20, MAX_VAL + 1, 4):
                set_color(color, val)
                time.sleep(0.015)
                c, m = get_current_state()
                if c != color or m != mode:
                    state_changed = True
                    break
            if state_changed: continue

            # Pulse 2: Fade down from MAX_VAL to MIN_VAL
            for val in range(MAX_VAL, MIN_VAL - 1, -4):
                set_color(color, val)
                time.sleep(0.015)
                c, m = get_current_state()
                if c != color or m != mode:
                    state_changed = True
                    break
            if state_changed: continue

            # Pause: stay at MIN_VAL for 1.5 seconds (check state every 100ms)
            set_color(color, MIN_VAL)
            for _ in range(15):
                time.sleep(0.1)
                c, m = get_current_state()
                if c != color or m != mode:
                    state_changed = True
                    break
            if state_changed: continue

    except KeyboardInterrupt:
        pass
    finally:
        led[0] = (0, 0, 0)

if __name__ == "__main__":
    main()
`;

    // 2. Systemd service file contents
    const serviceFile = `[Unit]
Description=PiKVM LED Heartbeat Daemon
After=kvmd.service

[Service]
Type=simple
ExecStart=/usr/local/bin/heartbeat.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

    // 3. Write files using base64 representation to preserve syntax cleanly
    const base64Script = Buffer.from(pythonScript).toString('base64');
    const base64Service = Buffer.from(serviceFile).toString('base64');
    
    // Write python script
    const scriptCmd = `echo '${base64Script}' | base64 -d > /usr/local/bin/heartbeat.py && chmod +x /usr/local/bin/heartbeat.py`;
    const scriptResult = await sshExec(conn, scriptCmd);
    if (scriptResult.code !== 0) {
        return { success: false, message: `Failed to write heartbeat script: ${scriptResult.stderr}` };
    }
    
    // Write mode to /etc/kvmd/heartbeat.mode
    const modeCmd = `echo '${targetMode}' > /etc/kvmd/heartbeat.mode`;
    const modeResult = await sshExec(conn, modeCmd);
    if (modeResult.code !== 0) {
        return { success: false, message: `Failed to write heartbeat mode: ${modeResult.stderr}` };
    }

    // Write systemd service file
    const serviceCmd = `echo '${base64Service}' | base64 -d > /etc/systemd/system/heartbeat.service`;
    const serviceResult = await sshExec(conn, serviceCmd);
    if (serviceResult.code !== 0) {
        return { success: false, message: `Failed to write heartbeat service file: ${serviceResult.stderr}` };
    }

    // Reload systemd daemon, enable and start the service
    await sshExec(conn, 'systemctl daemon-reload');
    await sshExec(conn, 'systemctl enable heartbeat');
    const startResult = await sshExec(conn, 'systemctl restart heartbeat 2>&1');
    
    if (startResult.code !== 0) {
        return { success: false, message: `Failed to start heartbeat service: ${startResult.stderr || startResult.stdout}` };
    }

    return { 
        success: true, 
        message: `שירות פעימות לב (Heartbeat) הוגדר והופעל בהצלחה במצב: ${targetMode}` 
    };
}

// Helper: Set heartbeat color on a box asynchronously
async function setPiKVMHeartbeatColor(ipAddress, color) {
    let conn;
    try {
        conn = await createSshConnection(ipAddress);
        // Write color to /tmp/heartbeat.color (no service restart needed, the script reads this dynamically)
        // /tmp is a writeable memory partition (tmpfs) so we do not need "rw" mode
        await sshExec(conn, `echo "${color}" > /tmp/heartbeat.color`);
        console.log(`Successfully set heartbeat color to ${color} on PiKVM at ${ipAddress}`);
    } catch (err) {
        console.error(`Failed to set heartbeat color to ${color} on PiKVM at ${ipAddress}:`, err.message);
    } finally {
        if (conn) conn.end();
    }
}

// Helper: trigger ATX button click on a box asynchronously
async function triggerPiKVMATXClick(ipAddress, action) {
    try {
        let adminPassword = adminPasswordCache.get(ipAddress);
        if (!adminPassword) {
            let conn;
            try {
                conn = await createSshConnection(ipAddress);
                const passResult = await sshExec(conn, 'cat /tmp/web.txt 2>/dev/null || echo "admin"');
                adminPassword = passResult.stdout.trim() || 'admin';
                adminPasswordCache.set(ipAddress, adminPassword);
            } catch (sshErr) {
                console.error(`SSH connection failed to get admin password for ATX click on ${ipAddress}:`, sshErr.message);
                adminPassword = 'admin';
            } finally {
                if (conn) conn.end();
            }
        }
        await directPikvmRequest(ipAddress, `/api/atx/click?button=${action}`, 'POST', adminPassword);
        console.log(`Successfully triggered ATX ${action} click on PiKVM at ${ipAddress}`);
    } catch (err) {
        console.error(`Failed to trigger ATX ${action} click on PiKVM at ${ipAddress}:`, err.message);
    }
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
        
        // Update the admin password cache so that direct API requests use it immediately
        adminPasswordCache.set(ipAddress, newPassword);
        
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

// ============================================================
// Client Setup API
// ============================================================

// Helper: create SSH connection for client (Ubuntu) machines
function createClientSshConnection(ip, username, password) {
    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => resolve(conn));
        conn.on('error', (err) => reject(err));

        conn.connect({
            host: ip,
            port: 22,
            username: username,
            password: password,
            readyTimeout: 15000
        });
    });
}

// Helper: upload buffer content via SFTP
function sshUploadBuffer(conn, buffer, remotePath, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
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

            writeStream.end(buffer);
        });
    });
}

// Test connection to client Ubuntu machine
app.post('/api/client-setup/test-connection', async (req, res) => {
    const { ip, username, password } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: 'IP is required' });
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });
    if (!password) return res.status(400).json({ success: false, message: 'Password is required' });

    let conn;
    try {
        conn = await createClientSshConnection(ip, username, password);
        const result = await sshExec(conn, 'hostname');
        conn.end();
        res.json({ success: true, message: `מחובר - hostname: ${result.stdout}` });
    } catch (err) {
        if (conn) conn.end();
        console.error('Client test connection error:', err.message);
        res.json({ success: false, message: `שגיאת חיבור: ${err.message}` });
    }
});

// Run a client setup stage
app.post('/api/client-setup/run-stage', async (req, res) => {
    const { stage, clientIp, username, password, ntpServer, cubeUrl, chromePath } = req.body;

    if (!stage || !clientIp || !username || !password) {
        return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    let conn;
    try {
        conn = await createClientSshConnection(clientIp, username, password);

        let result;
        switch (stage) {
            case 'installCert':
                result = await clientStageInstallCert(conn, username);
                break;
            case 'configureNtp':
                result = await clientStageConfigureNtp(conn, password, ntpServer);
                break;
            case 'installChrome':
                result = await clientStageInstallChrome(conn, password, chromePath);
                break;
            case 'createShortcut':
                result = await clientStageCreateShortcut(conn, username, cubeUrl);
                break;
            case 'disableKeyring':
                result = await clientStageDisableKeyring(conn, username, password);
                break;
            default:
                result = { success: false, message: `Unknown stage: ${stage}` };
        }

        conn.end();
        res.json(result);
    } catch (err) {
        if (conn) conn.end();
        console.error(`Client setup stage ${stage} error:`, err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Client Stage: Install Root CA Certificate into Chrome NSS database
// This mimics: Chrome Settings → Privacy → Manage certificates → Authorities → Import
async function clientStageInstallCert(conn, username) {
    const certPath = path.join(SETUP_DIR, 'myRootCA.crt');

    // Check if cert file exists on server
    if (!fs.existsSync(certPath)) {
        return { success: false, message: 'קובץ myRootCA.crt לא נמצא בתיקיית public/setup בשרת' };
    }

    // Read the certificate and validate it looks like a real PEM certificate
    const certContent = fs.readFileSync(certPath);
    const certText = certContent.toString('utf8');
    if (!certText.includes('-----BEGIN CERTIFICATE-----') || !certText.includes('-----END CERTIFICATE-----')) {
        return { success: false, message: 'קובץ myRootCA.crt אינו תעודת PEM תקינה' };
    }

    // Upload cert to temp location on client
    await sshUploadBuffer(conn, certContent, '/tmp/myRootCA.crt');

    // Check if certutil is available
    const certutilCheck = await sshExec(conn, 'which certutil 2>/dev/null', 5000).catch(() => ({ stdout: '' }));
    if (!certutilCheck.stdout.includes('certutil')) {
        // Try to install from local .deb if available
        const nssDebPath = path.join(SETUP_DIR, 'libnss3-tools.deb');
        if (fs.existsSync(nssDebPath)) {
            const nssDebContent = fs.readFileSync(nssDebPath);
            await sshUploadBuffer(conn, nssDebContent, '/tmp/libnss3-tools.deb', 30000);
            await sshExec(conn, 'sudo dpkg -i /tmp/libnss3-tools.deb 2>&1 || true', 30000);
            await sshExec(conn, 'rm -f /tmp/libnss3-tools.deb', 5000);
        }

        // Verify it's now available
        const recheck = await sshExec(conn, 'which certutil 2>/dev/null', 5000).catch(() => ({ stdout: '' }));
        if (!recheck.stdout.includes('certutil')) {
            await sshExec(conn, 'rm -f /tmp/myRootCA.crt', 5000).catch(() => {});
            return { success: false, message: 'certutil (libnss3-tools) לא מותקן — נדרש להתקנת תעודה בדפדפן Chrome. הנח libnss3-tools.deb בתיקיית setup.' };
        }
    }

    // Build a script that imports the Root CA into Chrome's NSS database for the SSH user
    // This is the equivalent of: Chrome → Settings → Privacy → Manage Certificates → Authorities → Import
    const homeDir = `/home/${username}`;
    const nssScript = [
        '#!/bin/bash',
        'CERT_FILE="/tmp/myRootCA.crt"',
        `HOME_DIR="${homeDir}"`,
        'ADDED=0',
        '',
        '# Import into existing Chrome/Chromium NSS databases',
        'for certDB in $(find "$HOME_DIR" -name "cert9.db" 2>/dev/null | sed \'s|/cert9.db||\'); do',
        '    certutil -A -n "MyRootCA" -t "CT,C,C" -i "$CERT_FILE" -d sql:"$certDB" 2>/dev/null && ADDED=$((ADDED+1))',
        'done',
        '',
        '# Also ensure the default NSS db exists at ~/.pki/nssdb and import there',
        'nss_dir="$HOME_DIR/.pki/nssdb"',
        'mkdir -p "$nss_dir" 2>/dev/null || true',
        'certutil -d sql:"$nss_dir" -N --empty-password 2>/dev/null || true',
        'certutil -A -n "MyRootCA" -t "CT,C,C" -i "$CERT_FILE" -d sql:"$nss_dir" 2>/dev/null && ADDED=$((ADDED+1))',
        `chown -R ${username}:${username} "$nss_dir" 2>/dev/null || true`,
        '',
        'echo "NSS_ADDED=$ADDED"',
    ].join('\n');

    await sshUploadBuffer(conn, Buffer.from(nssScript, 'utf8'), '/tmp/nss_cert_install.sh', 5000);
    await sshExec(conn, 'chmod +x /tmp/nss_cert_install.sh', 5000).catch(() => {});
    const nssResult = await sshExec(conn, 'bash /tmp/nss_cert_install.sh 2>&1', 30000).catch(() => ({ stdout: '' }));

    // Verify the import
    const verifyResult = await sshExec(conn, `certutil -L -d sql:${homeDir}/.pki/nssdb 2>/dev/null | grep -i MyRootCA`, 10000).catch(() => ({ stdout: '' }));

    // Clean up
    await sshExec(conn, 'rm -f /tmp/myRootCA.crt /tmp/nss_cert_install.sh', 5000).catch(() => {});

    // Build result message
    let added = 0;
    if (nssResult.stdout) {
        const match = nssResult.stdout.match(/NSS_ADDED=(\d+)/);
        if (match) added = parseInt(match[1]);
    }

    if (added > 0 || verifyResult.stdout.includes('MyRootCA')) {
        return { success: true, message: `תעודת Root CA הותקנה בהצלחה ב-Chrome (${added} מסדי NSS עודכנו)` };
    } else {
        return { success: false, message: 'לא הצלחתי לייבא את התעודה למסד NSS של Chrome — ודא שקובץ myRootCA.crt תקין' };
    }
}

// Client Stage: Configure NTP
async function clientStageConfigureNtp(conn, sudoPassword, ntpServer) {
    if (!ntpServer) {
        return { success: false, message: 'כתובת שרת NTP לא סופקה' };
    }

    const ntpConfig = `[Time]
NTP=${ntpServer}
FallbackNTP=${ntpServer}
`;

    const base64Config = Buffer.from(ntpConfig).toString('base64');
    
    const commands = [
        // Write NTP config
        `echo '${base64Config}' | base64 -d | sudo tee /etc/systemd/timesyncd.conf > /dev/null`,
        // Enable and restart timesyncd
        `echo '${sudoPassword}' | sudo -S systemctl enable systemd-timesyncd 2>&1`,
        `echo '${sudoPassword}' | sudo -S systemctl restart systemd-timesyncd 2>&1`,
        // Force time sync
        `echo '${sudoPassword}' | sudo -S timedatectl set-ntp true 2>&1`
    ];

    // Provide sudo password for the tee command via stdin
    const writeCmd = `echo '${sudoPassword}' | sudo -S bash -c "echo '${base64Config}' | base64 -d > /etc/systemd/timesyncd.conf" 2>&1`;
    const writeResult = await sshExec(conn, writeCmd, 15000);

    // Enable and restart
    await sshExec(conn, `echo '${sudoPassword}' | sudo -S systemctl enable systemd-timesyncd 2>&1`, 15000);
    await sshExec(conn, `echo '${sudoPassword}' | sudo -S systemctl restart systemd-timesyncd 2>&1`, 15000);
    await sshExec(conn, `echo '${sudoPassword}' | sudo -S timedatectl set-ntp true 2>&1`, 15000);

    // Verify
    const statusResult = await sshExec(conn, 'timedatectl show --property=NTP --value 2>&1', 10000);

    return {
        success: true,
        message: `NTP הוגדר עם שרת ${ntpServer} (סטטוס: ${statusResult.stdout || 'active'})`
    };
}

// Client Stage: Install Google Chrome
async function clientStageInstallChrome(conn, sudoPassword, chromePath) {
    if (!chromePath) {
        return { success: false, message: 'נתיב קובץ Chrome לא סופק' };
    }

    // Check if Chrome deb file exists on the server
    const absoluteChromePath = path.isAbsolute(chromePath) ? chromePath : path.join(__dirname, chromePath);
    if (!fs.existsSync(absoluteChromePath)) {
        return { success: false, message: `קובץ Chrome לא נמצא בנתיב: ${chromePath}` };
    }

    // Read the .deb file
    const debContent = fs.readFileSync(absoluteChromePath);

    // Upload to client
    await sshUploadBuffer(conn, debContent, '/tmp/google-chrome.deb', 120000);

    // Install Chrome
    const installCmd = `echo '${sudoPassword}' | sudo -S dpkg -i /tmp/google-chrome.deb 2>&1 || echo '${sudoPassword}' | sudo -S apt-get install -f -y 2>&1`;
    const installResult = await sshExec(conn, installCmd, 120000);

    // Clean up
    await sshExec(conn, 'rm -f /tmp/google-chrome.deb', 10000);

    // Verify installation
    const verifyResult = await sshExec(conn, 'which google-chrome-stable || which google-chrome 2>/dev/null', 10000);
    
    if (verifyResult.stdout && verifyResult.stdout.includes('chrome')) {
        return { success: true, message: 'Google Chrome הותקן בהצלחה' };
    }

    // Maybe it installed but binary name is different
    const dpkgCheck = await sshExec(conn, 'dpkg -l | grep -i chrome 2>/dev/null', 10000);
    if (dpkgCheck.stdout && dpkgCheck.stdout.includes('chrome')) {
        return { success: true, message: 'Google Chrome הותקן בהצלחה (אומת דרך dpkg)' };
    }

    return { 
        success: false, 
        message: `ייתכן שההתקנה נכשלה. פלט: ${installResult.stdout.substring(0, 200)}` 
    };
}

// Client Stage: Create Desktop Shortcut
async function clientStageCreateShortcut(conn, username, cubeUrl) {
    if (!cubeUrl) {
        return { success: false, message: 'כתובת CUBE URL לא סופקה' };
    }

    // Determine home directory
    const homeResult = await sshExec(conn, `echo $HOME`, 10000);
    const homeDir = homeResult.stdout.trim() || `/home/${username}`;

    // Create a large SVG icon for the desktop shortcut
    const iconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3498db;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2ecc71;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="40" fill="url(#bg)"/>
  <text x="128" y="100" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white">טל</text>
  <text x="128" y="160" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white">טק</text>
  <rect x="48" y="180" width="160" height="4" rx="2" fill="rgba(255,255,255,0.5)"/>
  <text x="128" y="215" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="rgba(255,255,255,0.9)">CUBE</text>
</svg>`;

    const iconBase64 = Buffer.from(iconSvg).toString('base64');

    // Create icon directory and save icon
    const iconDir = `${homeDir}/.local/share/icons`;
    await sshExec(conn, `mkdir -p ${iconDir}`, 10000);
    
    const writeIconCmd = `echo '${iconBase64}' | base64 -d > ${iconDir}/taltek-cube.svg`;
    await sshExec(conn, writeIconCmd, 10000);

    // Also create a PNG version using rsvg-convert if available, or use the SVG directly
    // Try to create a large PNG icon for better display
    await sshExec(conn, `which rsvg-convert >/dev/null 2>&1 && rsvg-convert -w 256 -h 256 ${iconDir}/taltek-cube.svg > ${iconDir}/taltek-cube.png 2>/dev/null || true`, 15000);

    // Determine which icon to use (PNG preferred, fallback to SVG)
    const pngCheck = await sshExec(conn, `test -f ${iconDir}/taltek-cube.png && echo exists`, 5000);
    const iconFile = pngCheck.stdout.includes('exists') ? `${iconDir}/taltek-cube.png` : `${iconDir}/taltek-cube.svg`;

    // Create the .desktop file
    const desktopContent = `[Desktop Entry]
Name=טל טק
Comment=פתח את מערכת CUBE
Exec=google-chrome-stable --start-fullscreen --no-first-run --disable-session-crashed-bubble --disable-infobars --password-store=basic "${cubeUrl}"
Icon=${iconFile}
Terminal=false
Type=Application
Categories=Network;WebBrowser;
StartupWMClass=Google-chrome-stable
`;

    const desktopBase64 = Buffer.from(desktopContent).toString('base64');
    const desktopPath = `${homeDir}/Desktop/taltek-cube.desktop`;

    // Ensure Desktop directory exists
    await sshExec(conn, `mkdir -p ${homeDir}/Desktop`, 10000);

    // Write .desktop file
    const writeDesktopCmd = `echo '${desktopBase64}' | base64 -d > '${desktopPath}'`;
    const writeResult = await sshExec(conn, writeDesktopCmd, 10000);
    if (writeResult.code !== 0) {
        return { success: false, message: `שגיאה ביצירת קיצור דרך: ${writeResult.stderr}` };
    }

    // Make it executable
    await sshExec(conn, `chmod +x '${desktopPath}'`, 10000);

    // Trust the desktop file (GNOME) — create a one-time autostart entry
    // that runs on next login, trusts the .desktop file, then removes itself.
    // This is the only reliable way because gio needs the user's D-Bus session.
    const autostartDir = `${homeDir}/.config/autostart`;
    await sshExec(conn, `mkdir -p '${autostartDir}'`, 5000);

    const trustScript = `[Desktop Entry]
Type=Application
Name=Trust TalTek Shortcut
Exec=bash -c 'sleep 3 && gio set "${desktopPath}" metadata::trusted true 2>/dev/null; rm -f "${autostartDir}/trust-taltek.desktop"'
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
    const trustBase64 = Buffer.from(trustScript).toString('base64');
    await sshExec(conn, `echo '${trustBase64}' | base64 -d > '${autostartDir}/trust-taltek.desktop'`, 10000);
    await sshExec(conn, `chmod +x '${autostartDir}/trust-taltek.desktop'`, 5000);

    // Also try direct gio in case user is currently logged in
    await sshExec(conn, `su - ${username} -c "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u ${username})/bus gio set '${desktopPath}' metadata::trusted true" 2>/dev/null || true`, 10000);

    // Make the icon larger on the desktop by updating desktop grid settings if possible
    // Set GNOME desktop icon size to large
    await sshExec(conn, `gsettings set org.gnome.nautilus.icon-view default-zoom-level 'large' 2>/dev/null || true`, 10000);
    await sshExec(conn, `gsettings set org.gnome.nautilus.icon-view default-zoom-level 'extra-large' 2>/dev/null || true`, 10000);

    return { success: true, message: `קיצור דרך "טל טק" נוצר בשולחן העבודה עם מסך מלא ל-${cubeUrl}` };
}

// Client Stage: Disable Keyring (password popup in Chrome)
async function clientStageDisableKeyring(conn, username, sudoPassword) {
    const homeDir = (await sshExec(conn, 'echo $HOME', 5000)).stdout.trim() || `/home/${username}`;

    // Method 1: Set Chrome to use basic password store (no keyring)
    // This is already done in the desktop shortcut, but also set it for default Chrome launches
    const chromeDesktopFiles = [
        '/usr/share/applications/google-chrome.desktop',
        '/usr/share/applications/google-chrome-stable.desktop'
    ];

    for (const file of chromeDesktopFiles) {
        // Replace Exec lines to include --password-store=basic
        const sedCmd = `echo '${sudoPassword}' | sudo -S sed -i 's|Exec=/usr/bin/google-chrome-stable|Exec=/usr/bin/google-chrome-stable --password-store=basic|g' ${file} 2>/dev/null || true`;
        await sshExec(conn, sedCmd, 15000);
    }

    // Method 2: Disable gnome-keyring daemon auto-start for Chrome
    // Create an autostart override that disables the keyring SSH and secrets components
    const autostartDir = `${homeDir}/.config/autostart`;
    await sshExec(conn, `mkdir -p ${autostartDir}`, 5000);

    // Disable the keyring secrets component
    const keyringOverride = `[Desktop Entry]
Type=Application
Name=Secret Storage Service
Exec=/usr/bin/gnome-keyring-daemon --start --components=pkcs11
Hidden=false
X-GNOME-Autostart-enabled=true
`;
    const keyringBase64 = Buffer.from(keyringOverride).toString('base64');
    await sshExec(conn, `echo '${keyringBase64}' | base64 -d > ${autostartDir}/gnome-keyring-secrets.desktop 2>/dev/null || true`, 10000);

    // Method 3: Create a blank default keyring with empty password
    // This allows Chrome to access it without prompting for a password
    const keyringDir = `${homeDir}/.local/share/keyrings`;
    await sshExec(conn, `mkdir -p ${keyringDir}`, 5000);

    // Create default keyring file with empty password
    // Check if a default keyring already exists
    const keyringCheck = await sshExec(conn, `test -f ${keyringDir}/Default_keyring.keyring && echo exists || test -f ${keyringDir}/default && echo exists`, 5000);
    
    if (!keyringCheck.stdout.includes('exists')) {
        // Use python to create an unlocked keyring (or just set up the blank one)
        const createKeyringCmd = `
            python3 -c "
import os, hashlib

keyring_dir = os.path.expanduser('${keyringDir}')
os.makedirs(keyring_dir, exist_ok=True)

# Write default keyring config
with open(os.path.join(keyring_dir, 'default'), 'w') as f:
    f.write('Default_keyring')
" 2>/dev/null || true
        `;
        await sshExec(conn, createKeyringCmd, 10000);
    }

    // Method 4: Set Chrome flags to disable password manager prompts
    const chromePrefsDir = `${homeDir}/.config/google-chrome/Default`;
    await sshExec(conn, `mkdir -p '${chromePrefsDir}'`, 5000);

    // Check if Preferences file exists
    const prefsCheck = await sshExec(conn, `test -f '${chromePrefsDir}/Preferences' && echo exists`, 5000);
    
    if (prefsCheck.stdout.includes('exists')) {
        // Update existing preferences to disable password manager
        const updatePrefsCmd = `python3 -c "
import json
prefs_path = '${chromePrefsDir}/Preferences'
try:
    with open(prefs_path, 'r') as f:
        prefs = json.load(f)
except:
    prefs = {}

if 'credentials_enable_service' not in prefs:
    prefs['credentials_enable_service'] = False
if 'profile' not in prefs:
    prefs['profile'] = {}
prefs['profile']['password_manager_enabled'] = False

with open(prefs_path, 'w') as f:
    json.dump(prefs, f, indent=2)
print('Updated')
" 2>/dev/null || true`;
        await sshExec(conn, updatePrefsCmd, 10000);
    }

    return { success: true, message: 'בקשת סיסמה של Keyring בוטלה - Chrome יפעל ללא חלון סיסמה' };
}

// ============================================================
// Client Setup - Script Mode (generate downloadable bash script)
// ============================================================

// Serve Root CA certificate for script download
app.get('/api/client-setup/download/cert', (req, res) => {
    const certPath = path.join(SETUP_DIR, 'myRootCA.crt');
    if (!fs.existsSync(certPath)) {
        return res.status(404).json({ message: 'myRootCA.crt not found in setup folder' });
    }
    res.download(certPath, 'myRootCA.crt');
});

// Serve libnss3-tools deb for script download
app.get('/api/client-setup/download/libnss3-tools', (req, res) => {
    const debPath = path.join(SETUP_DIR, 'libnss3-tools.deb');
    if (!fs.existsSync(debPath)) {
        return res.status(404).json({ message: 'libnss3-tools.deb not found in setup folder' });
    }
    res.download(debPath, 'libnss3-tools.deb');
});

// Serve Chrome deb for script download
app.get('/api/client-setup/download/chrome', (req, res) => {
    const chromePath = path.join(SETUP_DIR, 'google-chrome.deb');
    if (!fs.existsSync(chromePath)) {
        return res.status(404).json({ message: 'google-chrome.deb not found in setup folder' });
    }
    res.download(chromePath, 'google-chrome.deb');
});

// Generate setup bash script
app.post('/api/client-setup/generate-script', (req, res) => {
    const { stages, ntpServer, cubeUrl, chromePath, serverUrl } = req.body;

    if (!stages || stages.length === 0) {
        return res.status(400).json({ message: 'No stages selected' });
    }

    // Read Root CA certificate for embedding in script
    let certBase64 = '';
    let certValid = false;
    if (stages.includes('installCert')) {
        const certPath = path.join(SETUP_DIR, 'myRootCA.crt');
        if (fs.existsSync(certPath)) {
            const certText = fs.readFileSync(certPath, 'utf8');
            if (!certText.includes('-----BEGIN CERTIFICATE-----') || !certText.includes('-----END CERTIFICATE-----')) {
                return res.status(400).json({ message: 'קובץ myRootCA.crt אינו תעודת PEM תקינה' });
            }
            certBase64 = Buffer.from(certText).toString('base64');
            certValid = true;
        }
    }

    // Determine chrome download URL
    let chromeDownloadUrl = '';
    if (stages.includes('installChrome') && serverUrl) {
        chromeDownloadUrl = `${serverUrl.replace(/\/+$/, '')}/api/client-setup/download/chrome`;
    }

    // Build the script
    let script = `#!/bin/bash
# =============================================================
# סקריפט הגדרת עמדת לקוח - טל טק
# נוצר אוטומטית ב-$(date)
# =============================================================

set -e

# Colors for output
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m' # No Color

echo -e "\${BLUE}========================================\${NC}"
echo -e "\${BLUE}   הגדרת עמדת לקוח - טל טק\${NC}"
echo -e "\${BLUE}========================================\${NC}"
echo ""

# Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "\${YELLOW}[!] הסקריפט דורש הרשאות root. מנסה עם sudo...\${NC}"
    exec sudo bash "$0" "$@"
fi

FAILED=0
PASSED=0
TOTAL=${stages.length}

`;

    // Stage: Install SSL Certificate
    if (stages.includes('installCert')) {
        script += `
# ──────────────────────────────────────
# שלב: התקנת תעודת SSL
# ──────────────────────────────────────
echo -e "\${BLUE}[*] מתקין תעודת SSL...\${NC}"
`;
        if (certBase64 && certValid) {
            script += `CERT_B64="${certBase64}"
echo "$CERT_B64" | base64 -d > /tmp/myRootCA.crt

# Verify decoded certificate is valid PEM
if ! grep -q "BEGIN CERTIFICATE" /tmp/myRootCA.crt 2>/dev/null; then
    echo -e "\${RED}[✗] התעודה שהופקה אינה תקינה (לא PEM)\${NC}"
    rm -f /tmp/myRootCA.crt
    FAILED=$((FAILED + 1))
else
    # Install certutil (libnss3-tools) if not available
    if ! command -v certutil &>/dev/null; then
        echo -e "\${YELLOW}[*] certutil לא נמצא, מנסה להתקין libnss3-tools מהשרת...\${NC}"
        NSS_DEB="/tmp/libnss3-tools.deb"
        NSS_URL="${serverUrl ? serverUrl.replace(/\/+$/, '') + '/api/client-setup/download/libnss3-tools' : ''}"
        if [ -n "$NSS_URL" ]; then
            if command -v wget &>/dev/null; then
                wget -q --no-check-certificate -O "$NSS_DEB" "$NSS_URL" 2>/dev/null
            elif command -v curl &>/dev/null; then
                curl -sLk -o "$NSS_DEB" "$NSS_URL" 2>/dev/null
            fi
            if [ -f "$NSS_DEB" ] && [ -s "$NSS_DEB" ]; then
                dpkg -i "$NSS_DEB" 2>/dev/null || true
                rm -f "$NSS_DEB"
            else
                echo -e "\${YELLOW}[!] לא הצלחתי להוריד libnss3-tools.deb\${NC}"
            fi
        fi
    fi

    if ! command -v certutil &>/dev/null; then
        echo -e "\${RED}[✗] certutil לא זמין — לא ניתן להתקין תעודה בדפדפן Chrome\${NC}"
        rm -f /tmp/myRootCA.crt
        FAILED=$((FAILED + 1))
    else
        # Import Root CA into Chrome NSS database for all users
        # This is equivalent to: Chrome → Settings → Privacy → Manage Certificates → Authorities → Import
        NSS_ADDED=0
        for user_home in /home/*; do
            if [ -d "$user_home" ]; then
                real_user=$(basename "$user_home")

                # Import into any existing cert9.db locations
                for certDB in $(find "$user_home" -name "cert9.db" 2>/dev/null | sed 's|/cert9.db||'); do
                    certutil -A -n "MyRootCA" -t "CT,C,C" -i /tmp/myRootCA.crt -d sql:"$certDB" 2>/dev/null && NSS_ADDED=$((NSS_ADDED+1))
                done

                # Ensure default NSS db exists and import there
                nss_dir="$user_home/.pki/nssdb"
                mkdir -p "$nss_dir" 2>/dev/null || true
                certutil -d sql:"$nss_dir" -N --empty-password 2>/dev/null || true
                certutil -A -n "MyRootCA" -t "CT,C,C" -i /tmp/myRootCA.crt -d sql:"$nss_dir" 2>/dev/null && NSS_ADDED=$((NSS_ADDED+1))
                chown -R "$real_user:$real_user" "$nss_dir" 2>/dev/null || true
            fi
        done

        if [ $NSS_ADDED -gt 0 ]; then
            echo -e "\${GREEN}[✓] תעודת Root CA הותקנה בהצלחה ב-Chrome ($NSS_ADDED מסדי NSS)\${NC}"
            PASSED=$((PASSED + 1))
        else
            echo -e "\${RED}[✗] לא הצלחתי לייבא את התעודה למסד NSS של Chrome\${NC}"
            FAILED=$((FAILED + 1))
        fi
    fi
    rm -f /tmp/myRootCA.crt
fi
`;
        } else {
            script += `echo -e "\${RED}[✗] תעודת Root CA לא נמצאה בשרת — ודא שקובץ myRootCA.crt נמצא בתיקיית public/setup\${NC}"
FAILED=$((FAILED + 1))
`;
        }
    }

    // Stage: Configure NTP
    if (stages.includes('configureNtp')) {
        script += `
# ──────────────────────────────────────
# שלב: הגדרת NTP
# ──────────────────────────────────────
echo -e "\${BLUE}[*] מגדיר שעון NTP (${ntpServer || 'NOT SET'})...\${NC}"
`;
        if (ntpServer) {
            script += `cat > /etc/systemd/timesyncd.conf << 'NTPEOF'
[Time]
NTP=${ntpServer}
FallbackNTP=${ntpServer}
NTPEOF

systemctl enable systemd-timesyncd 2>/dev/null
systemctl restart systemd-timesyncd 2>/dev/null
timedatectl set-ntp true 2>/dev/null
echo -e "\${GREEN}[✓] NTP הוגדר עם שרת ${ntpServer}\${NC}"
PASSED=$((PASSED + 1))
`;
        } else {
            script += `echo -e "\${RED}[✗] כתובת שרת NTP לא הוגדרה\${NC}"
FAILED=$((FAILED + 1))
`;
        }
    }

    // Stage: Install Chrome
    if (stages.includes('installChrome')) {
        script += `
# ──────────────────────────────────────
# שלב: התקנת Google Chrome
# ──────────────────────────────────────
echo -e "\${BLUE}[*] מתקין Google Chrome...\${NC}"
`;
        if (chromeDownloadUrl) {
            script += `CHROME_URL="${chromeDownloadUrl}"
CHROME_DEB="/tmp/google-chrome.deb"

# Try wget first, then curl
if command -v wget &>/dev/null; then
    wget -q --no-check-certificate -O "$CHROME_DEB" "$CHROME_URL"
elif command -v curl &>/dev/null; then
    curl -sLk -o "$CHROME_DEB" "$CHROME_URL"
else
    echo -e "\${RED}[✗] לא נמצא wget או curl - לא ניתן להוריד Chrome\${NC}"
    FAILED=$((FAILED + 1))
    CHROME_DEB=""
fi

if [ -n "$CHROME_DEB" ] && [ -f "$CHROME_DEB" ]; then
    dpkg -i "$CHROME_DEB" 2>/dev/null || apt-get install -f -y 2>/dev/null
    rm -f "$CHROME_DEB"

    if command -v google-chrome-stable &>/dev/null || command -v google-chrome &>/dev/null; then
        echo -e "\${GREEN}[✓] Google Chrome הותקן בהצלחה\${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "\${RED}[✗] ההתקנה נכשלה - Chrome לא נמצא\${NC}"
        FAILED=$((FAILED + 1))
    fi
fi
`;
        } else {
            script += `echo -e "\${RED}[✗] כתובת שרת לא הוגדרה - לא ניתן להוריד Chrome\${NC}"
FAILED=$((FAILED + 1))
`;
        }
    }

    // Stage: Create Desktop Shortcut
    if (stages.includes('createShortcut')) {
        const escapedUrl = (cubeUrl || '').replace(/'/g, "'\\''");
        script += `
# ──────────────────────────────────────
# שלב: יצירת קיצור דרך בשולחן העבודה
# ──────────────────────────────────────
echo -e "\${BLUE}[*] יוצר קיצור דרך בשולחן העבודה...\${NC}"
`;
        if (cubeUrl) {
            script += `
# Create icon SVG
ICON_SVG='<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3498db;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2ecc71;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="40" fill="url(#bg)"/>
  <text x="128" y="100" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white">טל</text>
  <text x="128" y="160" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white">טק</text>
  <rect x="48" y="180" width="160" height="4" rx="2" fill="rgba(255,255,255,0.5)"/>
  <text x="128" y="215" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="rgba(255,255,255,0.9)">CUBE</text>
</svg>'

for user_home in /home/*; do
    if [ -d "$user_home" ]; then
        real_user=$(basename "$user_home")

        # Save icon
        icon_dir="$user_home/.local/share/icons"
        mkdir -p "$icon_dir"
        echo "$ICON_SVG" > "$icon_dir/taltek-cube.svg"

        # Try to make PNG version
        if command -v rsvg-convert &>/dev/null; then
            rsvg-convert -w 256 -h 256 "$icon_dir/taltek-cube.svg" > "$icon_dir/taltek-cube.png" 2>/dev/null || true
        fi

        # Determine icon path
        if [ -f "$icon_dir/taltek-cube.png" ]; then
            ICON_PATH="$icon_dir/taltek-cube.png"
        else
            ICON_PATH="$icon_dir/taltek-cube.svg"
        fi

        # Create desktop file
        desktop_dir="$user_home/Desktop"
        mkdir -p "$desktop_dir"
        cat > "$desktop_dir/taltek-cube.desktop" << DESKTOPEOF
[Desktop Entry]
Name=טל טק
Comment=פתח את מערכת CUBE
Exec=google-chrome-stable --start-fullscreen --no-first-run --disable-session-crashed-bubble --disable-infobars --password-store=basic '${escapedUrl}'
Icon=$ICON_PATH
Terminal=false
Type=Application
Categories=Network;WebBrowser;
StartupWMClass=Google-chrome-stable
DESKTOPEOF

        chmod +x "$desktop_dir/taltek-cube.desktop"
        chown -R "$real_user:$real_user" "$icon_dir" "$desktop_dir/taltek-cube.desktop" 2>/dev/null || true

        # Trust the desktop file (GNOME) — create one-time autostart entry
        # This runs on next login inside the user's D-Bus session and removes itself
        autostart_dir="$user_home/.config/autostart"
        mkdir -p "$autostart_dir"
        cat > "$autostart_dir/trust-taltek.desktop" << TRUSTEOF
[Desktop Entry]
Type=Application
Name=Trust TalTek Shortcut
Exec=bash -c 'sleep 3 && gio set "$desktop_dir/taltek-cube.desktop" metadata::trusted true 2>/dev/null; rm -f "$autostart_dir/trust-taltek.desktop"'
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
TRUSTEOF
        chmod +x "$autostart_dir/trust-taltek.desktop"
        chown -R "$real_user:$real_user" "$autostart_dir" 2>/dev/null || true

        # Also try directly in case user is currently logged in
        user_uid=$(id -u "$real_user" 2>/dev/null)
        su - "$real_user" -c "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$user_uid/bus gio set '$desktop_dir/taltek-cube.desktop' metadata::trusted true" 2>/dev/null || true
    fi
done

# Set desktop icon size to large
for user_home in /home/*; do
    real_user=$(basename "$user_home")
    su - "$real_user" -c "gsettings set org.gnome.nautilus.icon-view default-zoom-level 'extra-large'" 2>/dev/null || true
done

echo -e "\${GREEN}[✓] קיצור דרך 'טל טק' נוצר בשולחן העבודה\${NC}"
PASSED=$((PASSED + 1))
`;
        } else {
            script += `echo -e "\${RED}[✗] כתובת CUBE URL לא הוגדרה\${NC}"
FAILED=$((FAILED + 1))
`;
        }
    }

    // Stage: Disable Keyring
    if (stages.includes('disableKeyring')) {
        script += `
# ──────────────────────────────────────
# שלב: ביטול בקשת סיסמה (Keyring)
# ──────────────────────────────────────
echo -e "\${BLUE}[*] מבטל בקשת סיסמה של Keyring...\${NC}"

# Fix Chrome desktop files system-wide
for f in /usr/share/applications/google-chrome.desktop /usr/share/applications/google-chrome-stable.desktop; do
    if [ -f "$f" ]; then
        sed -i 's|Exec=/usr/bin/google-chrome-stable|Exec=/usr/bin/google-chrome-stable --password-store=basic|g' "$f" 2>/dev/null || true
        # Avoid duplicating the flag
        sed -i 's|--password-store=basic --password-store=basic|--password-store=basic|g' "$f" 2>/dev/null || true
    fi
done

for user_home in /home/*; do
    if [ -d "$user_home" ]; then
        real_user=$(basename "$user_home")

        # Create keyring directory and default keyring with empty password
        keyring_dir="$user_home/.local/share/keyrings"
        mkdir -p "$keyring_dir"
        
        if [ ! -f "$keyring_dir/default" ]; then
            echo "Default_keyring" > "$keyring_dir/default"
        fi
        chown -R "$real_user:$real_user" "$keyring_dir" 2>/dev/null || true

        # Disable keyring secrets autostart override
        autostart_dir="$user_home/.config/autostart"
        mkdir -p "$autostart_dir"
        cat > "$autostart_dir/gnome-keyring-secrets.desktop" << 'KEYRINGEOF'
[Desktop Entry]
Type=Application
Name=Secret Storage Service
Exec=/usr/bin/gnome-keyring-daemon --start --components=pkcs11
Hidden=false
X-GNOME-Autostart-enabled=true
KEYRINGEOF
        chown -R "$real_user:$real_user" "$autostart_dir" 2>/dev/null || true

        # Disable Chrome password manager via Preferences
        chrome_prefs_dir="$user_home/.config/google-chrome/Default"
        prefs_file="$chrome_prefs_dir/Preferences"
        if [ -f "$prefs_file" ]; then
            python3 -c "
import json
try:
    with open('$prefs_file', 'r') as f:
        prefs = json.load(f)
except:
    prefs = {}
prefs['credentials_enable_service'] = False
if 'profile' not in prefs:
    prefs['profile'] = {}
prefs['profile']['password_manager_enabled'] = False
with open('$prefs_file', 'w') as f:
    json.dump(prefs, f, indent=2)
" 2>/dev/null || true
            chown "$real_user:$real_user" "$prefs_file" 2>/dev/null || true
        fi
    fi
done

echo -e "\${GREEN}[✓] בקשת סיסמה של Keyring בוטלה\${NC}"
PASSED=$((PASSED + 1))
`;
    }

    // Summary
    script += `
# ──────────────────────────────────────
# סיכום
# ──────────────────────────────────────
echo ""
echo -e "\${BLUE}========================================\${NC}"
if [ $FAILED -eq 0 ]; then
    echo -e "\${GREEN}  ✅ כל $TOTAL השלבים הושלמו בהצלחה!\${NC}"
else
    echo -e "\${YELLOW}  ⚠️  $PASSED הצליחו, $FAILED נכשלו מתוך $TOTAL\${NC}"
fi
echo -e "\${BLUE}========================================\${NC}"
echo ""
`;

    // Send the script as a downloadable file
    res.setHeader('Content-Type', 'application/x-sh');
    res.setHeader('Content-Disposition', 'attachment; filename="setup-client.sh"');
    res.send(script);
});

// Client setup page route
app.get('/client', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
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
    console.log(`Client Setup: http://localhost:${PORT}/client`);
});
