// Client Setup Script

// Stage definitions
const STAGES = {
    installCert: {
        id: 'installCert',
        name: 'התקנת תעודת SSL',
        icon: '🔒'
    },
    configureNtp: {
        id: 'configureNtp',
        name: 'הגדרת שעון (NTP)',
        icon: '⏰'
    },
    installChrome: {
        id: 'installChrome',
        name: 'התקנת Google Chrome',
        icon: '🌐'
    },
    createShortcut: {
        id: 'createShortcut',
        name: 'יצירת קיצור דרך בשולחן העבודה',
        icon: '🖥️'
    },
    disableKeyring: {
        id: 'disableKeyring',
        name: 'ביטול בקשת סיסמה בדפדפן',
        icon: '🔓'
    }
};

let isRunning = false;
let currentAbortController = null;
let skipRequested = false;
let currentMode = 'script'; // 'script' or 'ssh'

const STAGE_TIMEOUT_MS = 120000; // 120 second timeout per stage (Chrome install may take longer)

// ==============================
// Initialization
// ==============================
document.addEventListener('DOMContentLoaded', () => {
    loadDefaults();
    setMode('script'); // default mode
});

// ==============================
// Mode Toggle
// ==============================
function setMode(mode) {
    currentMode = mode;

    // Toggle active button
    document.getElementById('modeScript').classList.toggle('active', mode === 'script');
    document.getElementById('modeSsh').classList.toggle('active', mode === 'ssh');

    // Update description
    const desc = document.getElementById('modeDesc');
    if (mode === 'script') {
        desc.textContent = 'מצב סקריפט — יופק קובץ bash שניתן להוריד ולהריץ ישירות על העמדה. מתאים כאשר אין SSH מותקן.';
    } else {
        desc.textContent = 'מצב SSH — השרת מתחבר ישירות לעמדה דרך SSH ומבצע את כל השלבים. דורש SSH פעיל בעמדה.';
    }

    // Show/hide sections
    document.querySelectorAll('.ssh-only').forEach(el => {
        el.style.display = mode === 'ssh' ? '' : 'none';
    });
    document.querySelectorAll('.script-only').forEach(el => {
        el.style.display = mode === 'script' ? '' : 'none';
    });

    // Auto-detect IP only in SSH mode
    if (mode === 'ssh') {
        autoDetectClientIp();
    }
}

// Auto-detect the browsing machine's IP and fill the field
async function autoDetectClientIp() {
    const input = document.getElementById('clientIp');
    if (!input || input.value.trim()) return; // don't overwrite if already filled
    try {
        const response = await fetch('/api/client-ip');
        const data = await response.json();
        if (data.ip && data.ip !== '127.0.0.1' && data.ip !== '::1') {
            input.value = data.ip;
        }
    } catch (err) {
        // silently ignore - user can type manually
    }
}

// Load default values from CLIENT_DEFAULTS config block in client.html
function loadDefaults() {
    if (typeof CLIENT_DEFAULTS === 'undefined') return;

    const fieldMap = {
        SSH_USERNAME: 'sshUsername',
        SSH_PASSWORD: 'sshPassword',
        NTP_SERVER:   'ntpServer',
        CUBE_URL:     'cubeUrl',
        CHROME_PATH:  'chromePath',
        SERVER_URL:   'serverUrl',
    };

    for (const [key, elementId] of Object.entries(fieldMap)) {
        const value = CLIENT_DEFAULTS[key];
        if (value) {
            const el = document.getElementById(elementId);
            if (el) el.value = value;
        }
    }
}

// Toggle password visibility
function togglePasswordVisibility() {
    const input = document.getElementById('sshPassword');
    const icon = document.getElementById('eyeIcon');
    if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
    } else {
        input.type = 'password';
        icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
    }
}

// Toggle a stage checkbox
function toggleStage(element) {
    if (isRunning) return;
    element.classList.toggle('checked');
}

// Select all stages
function selectAll() {
    if (isRunning) return;
    document.querySelectorAll('.stage-item').forEach(item => item.classList.add('checked'));
}

// Deselect all stages
function deselectAll() {
    if (isRunning) return;
    document.querySelectorAll('.stage-item').forEach(item => item.classList.remove('checked'));
}

// Get selected stages
function getSelectedStages() {
    const selected = [];
    document.querySelectorAll('.stage-item.checked').forEach(item => {
        selected.push(item.dataset.stage);
    });
    return selected;
}

// Test SSH connection
async function testConnection() {
    const ip = document.getElementById('clientIp').value.trim();
    const username = document.getElementById('sshUsername').value.trim();
    const password = document.getElementById('sshPassword').value.trim();

    if (!ip) {
        showConnectionStatus('error', 'אנא הזן כתובת IP');
        return;
    }

    if (!isValidIp(ip)) {
        showConnectionStatus('error', 'כתובת IP אינה תקינה');
        return;
    }

    if (!username) {
        showConnectionStatus('error', 'אנא הזן שם משתמש SSH');
        return;
    }

    if (!password) {
        showConnectionStatus('error', 'אנא הזן סיסמת SSH');
        return;
    }

    const testBtn = document.getElementById('testBtn');
    testBtn.disabled = true;
    showConnectionStatus('testing', 'בודק חיבור...');

    try {
        const response = await fetch('/api/client-setup/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, username, password })
        });

        const result = await response.json();

        if (result.success) {
            showConnectionStatus('success', `חיבור תקין! (${result.message || 'SSH פעיל'})`);
        } else {
            showConnectionStatus('error', result.message || 'החיבור נכשל');
        }
    } catch (err) {
        showConnectionStatus('error', 'שגיאת רשת - לא ניתן להתחבר לשרת');
    } finally {
        testBtn.disabled = false;
    }
}

// Show connection status
function showConnectionStatus(type, message) {
    const status = document.getElementById('connectionStatus');
    status.className = `connection-status ${type}`;

    const dotClass = type === 'testing' ? 'status-dot pulse' : 'status-dot';
    status.innerHTML = `<div class="${dotClass}"></div><span>${message}</span>`;
}

// Validate IP address
function isValidIp(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
        const num = parseInt(part, 10);
        return !isNaN(num) && num >= 0 && num <= 255 && String(num) === part;
    });
}

// Toggle log visibility
function toggleLog() {
    const toggle = document.getElementById('logToggle');
    const content = document.getElementById('logContent');
    toggle.classList.toggle('open');
    content.classList.toggle('open');
}

// Add log line
function addLog(message, type = 'info') {
    const logContent = document.getElementById('logContent');
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    const timestamp = new Date().toLocaleTimeString('he-IL');
    line.textContent = `[${timestamp}] ${message}`;
    logContent.appendChild(line);
    logContent.scrollTop = logContent.scrollHeight;
}

// Build the progress UI for selected stages
function buildProgressUI(selectedStages) {
    const list = document.getElementById('stageProgressList');
    list.innerHTML = '';

    selectedStages.forEach(stageId => {
        const stage = STAGES[stageId];
        if (!stage) return;

        const item = document.createElement('div');
        item.className = 'stage-progress-item';
        item.id = `progress-${stageId}`;
        item.innerHTML = `
            <div class="stage-progress-icon">${stage.icon}</div>
            <div class="stage-progress-name">${stage.name}</div>
            <div class="stage-progress-status">ממתין</div>
        `;
        list.appendChild(item);
    });
}

// Update stage progress
function updateStageProgress(stageId, state, statusText) {
    const item = document.getElementById(`progress-${stageId}`);
    if (!item) return;

    item.className = `stage-progress-item ${state}`;
    const statusEl = item.querySelector('.stage-progress-status');
    if (statusEl) statusEl.textContent = statusText;

    const iconEl = item.querySelector('.stage-progress-icon');
    if (state === 'completed') {
        iconEl.textContent = '✅';
    } else if (state === 'failed') {
        iconEl.textContent = '❌';
    } else if (state === 'running') {
        iconEl.textContent = '⏳';
    }
}

// Update overall progress
function updateOverallProgress(current, total, title) {
    const percent = Math.round((current / total) * 100);
    document.getElementById('progressPercent').textContent = `${percent}%`;
    document.getElementById('progressFill').style.width = `${percent}%`;
    if (title) document.getElementById('progressTitle').textContent = title;
}

// Run the client setup process
async function runSetup() {
    const clientIp = document.getElementById('clientIp').value.trim();
    const username = document.getElementById('sshUsername').value.trim();
    const password = document.getElementById('sshPassword').value.trim();
    const ntpServer = document.getElementById('ntpServer').value.trim();
    const cubeUrl = document.getElementById('cubeUrl').value.trim();
    const chromePath = document.getElementById('chromePath').value.trim();
    const selectedStages = getSelectedStages();

    // Validation
    if (!clientIp) {
        showConnectionStatus('error', 'אנא הזן את כתובת ה-IP של העמדה');
        return;
    }

    if (!isValidIp(clientIp)) {
        showConnectionStatus('error', 'כתובת IP אינה תקינה');
        return;
    }

    if (!username) {
        showConnectionStatus('error', 'אנא הזן שם משתמש SSH');
        return;
    }

    if (!password) {
        showConnectionStatus('error', 'אנא הזן סיסמת SSH');
        return;
    }

    if (selectedStages.length === 0) {
        alert('אנא בחר לפחות שלב אחד להרצה');
        return;
    }

    if (selectedStages.includes('configureNtp') && !ntpServer) {
        alert('אנא הזן כתובת שרת NTP עבור שלב הגדרת השעון');
        return;
    }

    if (selectedStages.includes('createShortcut') && !cubeUrl) {
        alert('אנא הזן כתובת CUBE URL עבור שלב יצירת קיצור הדרך');
        return;
    }

    if (selectedStages.includes('installChrome') && !chromePath) {
        alert('אנא הזן את הנתיב לקובץ ההתקנה של Chrome בשרת');
        return;
    }

    // Start setup
    isRunning = true;
    document.getElementById('runBtn').disabled = true;
    document.getElementById('runBtn').classList.add('running');
    document.getElementById('runBtn').innerHTML = `
        <div class="spinner" style="width:24px; height:24px; border-width:3px;"></div>
        מריץ...
    `;

    // Show progress
    const progressSection = document.getElementById('progressSection');
    progressSection.classList.add('active');
    progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Clear log
    document.getElementById('logContent').innerHTML = '';

    addLog(`מתחיל תהליך הגדרת עמדה ${clientIp}`, 'info');
    addLog(`שלבים נבחרים: ${selectedStages.length}`, 'info');

    // Build progress UI
    buildProgressUI(selectedStages);

    let completedCount = 0;
    let failedCount = 0;
    const totalStages = selectedStages.length;

    // Show skip button
    showSkipButton(true);

    // Run each stage sequentially
    for (let i = 0; i < selectedStages.length; i++) {
        const stageId = selectedStages[i];
        const stage = STAGES[stageId];
        skipRequested = false;

        updateOverallProgress(i, totalStages, `מריץ: ${stage.name}...`);
        updateStageProgress(stageId, 'running', 'מריץ...');
        addLog(`[שלב ${i + 1}/${totalStages}] מתחיל: ${stage.name}`, 'command');

        try {
            const result = await executeStage(stageId, clientIp, username, password, ntpServer, cubeUrl, chromePath);

            if (result.skipped) {
                updateStageProgress(stageId, 'failed', 'דולג');
                addLog(`⏭️ ${stage.name} דולג על ידי המשתמש`, 'warning');
                failedCount++;
            } else if (result.success) {
                updateStageProgress(stageId, 'completed', 'הושלם');
                addLog(`✅ ${stage.name} הושלם בהצלחה`, 'success');
                if (result.message) addLog(`   ${result.message}`, 'info');
                completedCount++;
            } else {
                updateStageProgress(stageId, 'failed', result.message || 'נכשל');
                addLog(`❌ ${stage.name} נכשל: ${result.message || 'שגיאה לא ידועה'}`, 'error');
                failedCount++;
            }
        } catch (err) {
            if (skipRequested) {
                updateStageProgress(stageId, 'failed', 'דולג');
                addLog(`⏭️ ${stage.name} דולג על ידי המשתמש`, 'warning');
            } else {
                updateStageProgress(stageId, 'failed', err.message.includes('timeout') ? 'חריגת זמן' : 'שגיאת רשת');
                addLog(`❌ ${stage.name} נכשל: ${err.message}`, 'error');
            }
            failedCount++;
        }
    }

    // Hide skip button
    showSkipButton(false);

    // Final progress
    updateOverallProgress(totalStages, totalStages, failedCount === 0 ? 'הושלם!' : 'הושלם עם שגיאות');

    if (failedCount > 0) {
        document.getElementById('progressFill').classList.add('error');
    }

    // Show result summary
    showResultSummary(completedCount, failedCount, totalStages);

    // Show post actions
    document.getElementById('postActions').style.display = 'flex';

    addLog('', 'info');
    addLog(`===== סיכום: ${completedCount} הצליחו, ${failedCount} נכשלו מתוך ${totalStages} =====`,
        failedCount === 0 ? 'success' : 'warning');

    isRunning = false;
}

// Skip the current running stage
function skipCurrentStage() {
    if (!currentAbortController) return;
    skipRequested = true;
    currentAbortController.abort();
    addLog('⏭️ המשתמש ביקש לדלג על השלב הנוכחי...', 'warning');
}

// Show/hide skip button
function showSkipButton(show) {
    const btn = document.getElementById('skipStageBtn');
    if (btn) btn.style.display = show ? 'flex' : 'none';
}

// Execute a single stage via API
async function executeStage(stageId, clientIp, username, password, ntpServer, cubeUrl, chromePath) {
    const body = {
        stage: stageId,
        clientIp,
        username,
        password,
        ntpServer,
        cubeUrl,
        chromePath
    };

    // Create abort controller for skip/timeout support
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // Auto-timeout after STAGE_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
        addLog(`⏰ חריגת זמן (${STAGE_TIMEOUT_MS / 1000} שניות) - עובר לשלב הבא`, 'warning');
        currentAbortController.abort();
    }, STAGE_TIMEOUT_MS);

    try {
        const response = await fetch('/api/client-setup/run-stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            return { success: false, message: errData.message || `HTTP ${response.status}` };
        }

        return await response.json();
    } catch (err) {
        clearTimeout(timeoutId);
        if (signal.aborted) {
            if (skipRequested) {
                return { success: false, skipped: true, message: 'דולג על ידי המשתמש' };
            }
            return { success: false, message: 'חריגת זמן - השלב לא הגיב' };
        }
        throw err;
    } finally {
        currentAbortController = null;
    }
}

// Show result summary
function showResultSummary(completed, failed, total) {
    const summary = document.getElementById('resultSummary');
    summary.classList.remove('hidden');

    const icon = document.getElementById('resultIcon');
    const text = document.getElementById('resultText');
    const detail = document.getElementById('resultDetail');

    if (failed === 0) {
        summary.className = 'result-summary success';
        icon.textContent = '🎉';
        text.textContent = 'ההגדרה הושלמה בהצלחה!';
        detail.textContent = `כל ${total} השלבים הושלמו ללא שגיאות`;
    } else if (completed > 0) {
        summary.className = 'result-summary partial';
        icon.textContent = '⚠️';
        text.textContent = 'ההגדרה הושלמה באופן חלקי';
        detail.textContent = `${completed} שלבים הצליחו, ${failed} נכשלו`;
    } else {
        summary.className = 'result-summary failure';
        icon.textContent = '😞';
        text.textContent = 'ההגדרה נכשלה';
        detail.textContent = `כל ${total} השלבים נכשלו`;
    }
}

// Reset form for another client
function resetForm() {
    isRunning = false;
    document.getElementById('clientIp').value = '';
    document.getElementById('runBtn').disabled = false;
    document.getElementById('runBtn').classList.remove('running');
    document.getElementById('runBtn').innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        התחל הגדרה
    `;

    document.getElementById('progressSection').classList.remove('active');
    document.getElementById('progressFill').classList.remove('error');
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('resultSummary').classList.add('hidden');
    document.getElementById('postActions').style.display = 'none';
    document.getElementById('logContent').innerHTML = '';
    document.getElementById('logContent').classList.remove('open');
    document.getElementById('logToggle').classList.remove('open');

    showConnectionStatus('idle', 'הזן כתובת IP ולחץ על "בדוק חיבור"');

    // Re-select all stages
    selectAll();

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==============================
// Script Mode - Download Script
// ==============================
async function downloadScript() {
    const ntpServer = document.getElementById('ntpServer').value.trim();
    const cubeUrl = document.getElementById('cubeUrl').value.trim();
    const chromePath = document.getElementById('chromePath').value.trim();
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const selectedStages = getSelectedStages();

    // Validation
    if (selectedStages.length === 0) {
        alert('אנא בחר לפחות שלב אחד');
        return;
    }

    if (selectedStages.includes('configureNtp') && !ntpServer) {
        alert('אנא הזן כתובת שרת NTP עבור שלב הגדרת השעון');
        return;
    }

    if (selectedStages.includes('createShortcut') && !cubeUrl) {
        alert('אנא הזן כתובת CUBE URL עבור שלב יצירת קיצור הדרך');
        return;
    }

    if (selectedStages.includes('installChrome') && !chromePath && !serverUrl) {
        alert('אנא הזן נתיב Chrome או כתובת שרת כדי להוריד את Chrome');
        return;
    }

    if ((selectedStages.includes('installChrome') || selectedStages.includes('installCert')) && !serverUrl) {
        alert('אנא הזן את כתובת השרת — הסקריפט צריך להוריד ממנו קבצים');
        return;
    }

    const btn = document.getElementById('downloadBtn');
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner" style="width:24px; height:24px; border-width:3px;"></div> מייצר סקריפט...`;

    try {
        const response = await fetch('/api/client-setup/generate-script', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stages: selectedStages,
                ntpServer,
                cubeUrl,
                chromePath,
                serverUrl
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            alert(err.message || 'שגיאה ביצירת הסקריפט');
            return;
        }

        // Download the script file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'setup-client.sh';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        // Show post-download instructions
        const instructionsEl = document.getElementById('scriptInstructions');
        if (instructionsEl) {
            instructionsEl.style.display = 'block';
            instructionsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    } catch (err) {
        alert('שגיאת רשת: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            הורד סקריפט הגדרה
        `;
    }
}

// Copy the bash command to clipboard
function copyScriptCommand() {
    const cmd = document.getElementById('scriptCommand');
    if (!cmd) return;
    const text = cmd.textContent;
    navigator.clipboard.writeText(text).then(() => {
        const original = cmd.style.borderColor;
        cmd.style.borderColor = 'var(--secondary-color)';
        setTimeout(() => { cmd.style.borderColor = original; }, 1000);
    }).catch(() => {
        // Fallback: select the text
        const range = document.createRange();
        range.selectNodeContents(cmd);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
}
