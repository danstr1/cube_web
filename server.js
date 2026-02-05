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
            password: 'root', // Default PiKVM root password - adjust if needed
            readyTimeout: 10000
        });
    });
}

// Middleware
app.use(cors());
app.use(express.json());
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
