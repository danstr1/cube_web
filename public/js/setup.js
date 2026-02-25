// PiKVM Setup Script

// Stage definitions
const STAGES = {
    changeIp: {
        id: 'changeIp',
        name: 'שינוי כתובת IP',
        icon: '🌐'
    },
    setEdid: {
        id: 'setEdid',
        name: 'הגדרת EDID',
        icon: '🖥️'
    },
    copySsl: {
        id: 'copySsl',
        name: 'העתקת תעודות SSL',
        icon: '🔒'
    },
    replaceIndex: {
        id: 'replaceIndex',
        name: 'החלפת index.html',
        icon: '📄'
    },
    replaceLogo: {
        id: 'replaceLogo',
        name: 'החלפת לוגו',
        icon: '🎨'
    },
    configureNtp: {
        id: 'configureNtp',
        name: 'הגדרת NTP',
        icon: '⏰'
    },
    relativeMouse: {
        id: 'relativeMouse',
        name: 'העבר עכבר למצב relative',
        icon: '🖱️'
    },
    disableClosePopup: {
        id: 'disableClosePopup',
        name: 'בטל חלון קופץ בעת יציאה',
        icon: '🚫'
    }
};

let isRunning = false;
let uploadedLogoBase64 = null;
let logoSource = 'default'; // 'default' or 'upload'
let currentAbortController = null; // For skipping stages
let skipRequested = false;

const STAGE_TIMEOUT_MS = 60000; // 60 second timeout per stage

// ==============================
// Initialization
// ==============================
document.addEventListener('DOMContentLoaded', () => {
    loadSshPassword();
    setupLogoDragDrop();
});

// Load SSH password from server
async function loadSshPassword() {
    const input = document.getElementById('sshPassword');
    const source = document.getElementById('passwordSource');

    try {
        const response = await fetch('/api/setup/ssh-password');
        const data = await response.json();
        if (data.password) {
            input.value = data.password;
            source.textContent = `נטען מ-ssh_password`;
            source.style.color = 'var(--secondary-color)';
        } else {
            source.textContent = 'לא נמצא קובץ';
            source.style.color = 'var(--danger-color)';
        }
    } catch (err) {
        source.textContent = 'שגיאת טעינה';
        source.style.color = 'var(--danger-color)';
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

// ==============================
// Logo Upload
// ==============================
function setLogoSource(source) {
    logoSource = source;
    document.getElementById('logoSrcDefault').classList.toggle('active', source === 'default');
    document.getElementById('logoSrcUpload').classList.toggle('active', source === 'upload');
    document.getElementById('logoUploadArea').classList.toggle('active', source === 'upload');
}

function handleLogoUpload(input) {
    const file = input.files[0];
    if (!file) return;

    if (!file.name.endsWith('.svg') && file.type !== 'image/svg+xml') {
        alert('אנא בחר קובץ SVG בלבד');
        input.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        uploadedLogoBase64 = e.target.result.split(',')[1] || btoa(e.target.result);

        // Show filename
        const nameEl = document.getElementById('logoFileName');
        nameEl.textContent = `✅ ${file.name}`;
        nameEl.style.display = 'block';

        // Update dropzone look
        document.getElementById('logoDropzone').classList.add('has-file');

        // Show preview
        const preview = document.getElementById('logoPreview');
        const previewImg = document.getElementById('logoPreviewImg');
        previewImg.src = e.target.result;
        preview.classList.add('active');
    };
    reader.readAsDataURL(file);
}

function setupLogoDragDrop() {
    const dropzone = document.getElementById('logoDropzone');
    if (!dropzone) return;

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) {
            const input = document.getElementById('logoFileInput');
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            handleLogoUpload(input);
        }
    });
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
    const ip = document.getElementById('currentIp').value.trim();
    const password = document.getElementById('sshPassword').value.trim();

    if (!ip) {
        showConnectionStatus('error', 'אנא הזן כתובת IP');
        return;
    }

    if (!isValidIp(ip)) {
        showConnectionStatus('error', 'כתובת IP אינה תקינה');
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
        const response = await fetch('/api/setup/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, password })
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

// Run the setup process
async function runSetup() {
    const currentIp = document.getElementById('currentIp').value.trim();
    const newIp = document.getElementById('newIpAddress').value.trim();
    const password = document.getElementById('sshPassword').value.trim();
    const selectedStages = getSelectedStages();

    // Validation
    if (!currentIp) {
        showConnectionStatus('error', 'אנא הזן את כתובת ה-IP הנוכחית של ה-PiKVM');
        return;
    }

    if (!isValidIp(currentIp)) {
        showConnectionStatus('error', 'כתובת IP נוכחית אינה תקינה');
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

    if (selectedStages.includes('changeIp')) {
        if (!newIp) {
            alert('אנא הזן כתובת IP חדשה עבור שלב שינוי IP');
            return;
        }
        if (!isValidIp(newIp)) {
            alert('כתובת IP חדשה אינה תקינה');
            return;
        }
    }

    if (selectedStages.includes('replaceLogo') && logoSource === 'upload' && !uploadedLogoBase64) {
        alert('בחרת להעלות לוגו מותאם אישית אך לא העלית קובץ. אנא העלה קובץ SVG או עבור לקובץ ברירת מחדל.');
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

    addLog(`מתחיל תהליך הגדרה עבור PiKVM ב-${currentIp}`, 'info');
    addLog(`שלבים נבחרים: ${selectedStages.length}`, 'info');

    // Reorder: move changeIp to last since it changes the IP and drops the connection
    if (selectedStages.includes('changeIp') && selectedStages.length > 1) {
        const idx = selectedStages.indexOf('changeIp');
        selectedStages.splice(idx, 1);
        selectedStages.push('changeIp');
        addLog('⚠️ שלב שינוי IP הועבר לסוף כדי למנוע ניתוק באמצע התהליך', 'warning');
    }

    // Build progress UI (after reorder)
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
            const result = await executeStage(stageId, currentIp, newIp);

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
async function executeStage(stageId, currentIp, newIp) {
    const password = document.getElementById('sshPassword').value.trim();
    const body = { 
        stage: stageId, 
        currentIp,
        newIp,
        password
    };

    // If this is the logo stage and user uploaded a file, send it
    if (stageId === 'replaceLogo' && logoSource === 'upload' && uploadedLogoBase64) {
        body.uploadedLogo = uploadedLogoBase64;
    }

    // Create abort controller for skip/timeout support
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // Auto-timeout after STAGE_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
        addLog(`⏰ חריגת זמן (${STAGE_TIMEOUT_MS / 1000} שניות) - עובר לשלב הבא`, 'warning');
        currentAbortController.abort();
    }, STAGE_TIMEOUT_MS);

    try {
        const response = await fetch('/api/setup/run-stage', {
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

// Reset form for another PiKVM
function resetForm() {
    isRunning = false;
    document.getElementById('currentIp').value = '';
    document.getElementById('newIpAddress').value = '';
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

    // Reset logo upload
    uploadedLogoBase64 = null;
    setLogoSource('default');
    document.getElementById('logoFileInput').value = '';
    document.getElementById('logoFileName').style.display = 'none';
    document.getElementById('logoDropzone').classList.remove('has-file');
    document.getElementById('logoPreview').classList.remove('active');

    // Re-select all stages
    selectAll();

    window.scrollTo({ top: 0, behavior: 'smooth' });
}
