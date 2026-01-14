// Hive System JavaScript

// State
let currentInput = '';
let currentHiveId = 1;
let timeoutId = null;
let timeoutInterval = null;
let resultTimeoutId = null;
let resultTimeoutInterval = null;
let currentUserId = null;
const TIMEOUT_SECONDS = 10;

// DOM Elements - initialized after DOM loads
let loginScreen, resultScreen, adminPanel, inputDisplay, resultTimeoutContainer, resultTimeoutBar;

// Initialize
async function init() {
    // Get DOM elements
    loginScreen = document.getElementById('loginScreen');
    resultScreen = document.getElementById('resultScreen');
    adminPanel = document.getElementById('adminPanel');
    inputDisplay = document.getElementById('inputValue');
    resultTimeoutContainer = document.getElementById('resultTimeoutContainer');
    resultTimeoutBar = document.getElementById('resultTimeoutBar');
    
    // Get hive ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    const hiveIdParam = urlParams.get('id');
    if (hiveIdParam) {
        currentHiveId = parseInt(hiveIdParam);
    } else {
        // Only load settings if no URL parameter
        const settings = await apiGet('/api/settings');
        if (settings && settings.currentHive) {
            currentHiveId = settings.currentHive;
        }
    }
    
    // Update screen title
    updateScreenTitle();
    
    // Listen for keyboard input (for tag reader)
    document.addEventListener('keydown', handleKeyboard);
    
    // Attach keypad event listeners
    setupKeypad();
    
    console.log('Hive system initialized');
}

// Setup keypad click handlers
function setupKeypad() {
    const keypad = document.getElementById('keypad');
    if (!keypad) return;
    
    keypad.addEventListener('click', function(e) {
        const button = e.target.closest('.key');
        if (!button) return;
        
        e.preventDefault();
        
        if (button.dataset.digit) {
            addDigit(button.dataset.digit);
        } else if (button.dataset.action === 'delete') {
            deleteDigit();
        } else if (button.dataset.action === 'enter') {
            submitLogin();
        }
    });
}

// Update screen title
async function updateScreenTitle() {
    const hives = await apiGet('/api/hives');
    const hive = hives?.find(h => h.id === currentHiveId);
    const title = document.getElementById('screenTitle');
    if (title && hive) {
        title.textContent = hive.name;
    }
}

// Handle keyboard input
function handleKeyboard(e) {
    if (adminPanel.classList.contains('hidden') === false) return;
    if (resultScreen.classList.contains('hidden') === false) return;
    
    // Only allow digits in the input field
    if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        addDigit(e.key);
    } else if (e.key === 'Backspace') {
        e.preventDefault();
        deleteDigit();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        submitLogin();
    } else {
        // Prevent all other keys from being added
        e.preventDefault();
    }
}

// Add digit to input
function addDigit(digit) {
    if (currentInput.length < 14) {
        currentInput += digit;
        updateDisplay();
        resetInputTimeout();
    }
}

// Delete last digit
function deleteDigit() {
    currentInput = currentInput.slice(0, -1);
    updateDisplay();
    if (currentInput.length > 0) {
        resetInputTimeout();
    } else {
        clearInputTimeout();
    }
}

// Update display
function updateDisplay() {
    inputDisplay.textContent = currentInput;
}

// Reset input timeout (without visual progress bar)
function resetInputTimeout() {
    clearInputTimeout();
    
    timeoutId = setTimeout(() => {
        currentInput = '';
        updateDisplay();
        clearInputTimeout();
    }, TIMEOUT_SECONDS * 1000);
}

// Clear input timeout
function clearInputTimeout() {
    if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
    }
}

// Start result screen timeout
function startResultTimeout() {
    clearResultTimeout();
    
    resultTimeoutContainer.style.display = 'block';
    let remaining = TIMEOUT_SECONDS;
    
    resultTimeoutBar.style.width = '100%';
    
    resultTimeoutInterval = setInterval(() => {
        remaining -= 0.1;
        const percentage = (remaining / TIMEOUT_SECONDS) * 100;
        resultTimeoutBar.style.width = percentage + '%';
    }, 100);
    
    resultTimeoutId = setTimeout(() => {
        backToLogin();
    }, TIMEOUT_SECONDS * 1000);
}

// Clear result timeout
function clearResultTimeout() {
    if (resultTimeoutId) {
        window.clearTimeout(resultTimeoutId);
        resultTimeoutId = null;
    }
    if (resultTimeoutInterval) {
        window.clearInterval(resultTimeoutInterval);
        resultTimeoutInterval = null;
    }
    resultTimeoutContainer.style.display = 'none';
    resultTimeoutBar.style.width = '100%';
}

// Submit login
async function submitLogin() {
    if (!currentInput) {
        showNotification('נא להזין מספר זיהוי', 'warning');
        return;
    }
    
    clearInputTimeout();
    
    const result = await apiPost('/api/users/login', {
        id: currentInput,
        hiveId: currentHiveId
    });
    
    if (!result) {
        showNotification('שגיאה בהתחברות', 'error');
        return;
    }
    
    currentUserId = currentInput;
    
    if (result.isAdmin) {
        showAdminChoiceModal();
    } else if (result.error === 'noAvailableBox') {
        showNotification(result.message, 'error');
        currentInput = '';
        updateDisplay();
    } else if (result.exists) {
        showExistingUser(result);
    } else if (result.success) {
        showNewUser(result);
    }
}

// Show existing user
function showExistingUser(result) {
    loginScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    
    const welcomeMsg = document.getElementById('welcomeMessage');
    const statusMsg = document.getElementById('statusMessage');
    const boxNumber = document.getElementById('boxNumber');
    const ipAddress = document.getElementById('ipAddress');
    const disconnectBtn = document.getElementById('disconnectBtn');
    
    if (result.name) {
        welcomeMsg.innerHTML = `<h2>שלום ${result.name}!</h2>`;
    } else {
        welcomeMsg.innerHTML = `<h2>שלום!</h2>`;
    }
    
    statusMsg.className = 'status-message warning';
    statusMsg.textContent = 'נמצא מיפוי קיים עבור מזהה זה';
    
    boxNumber.textContent = result.box.boxNumber;
    ipAddress.textContent = result.box.ipAddress;
    
    disconnectBtn.textContent = 'התנתק מהמערכת';
    disconnectBtn.className = 'btn btn-danger';
    
    startResultTimeout();
}

// Show new user allocation
function showNewUser(result) {
    loginScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    
    const welcomeMsg = document.getElementById('welcomeMessage');
    const statusMsg = document.getElementById('statusMessage');
    const boxNumber = document.getElementById('boxNumber');
    const ipAddress = document.getElementById('ipAddress');
    
    if (result.name) {
        welcomeMsg.innerHTML = `<h2>ברוך הבא ${result.name}!</h2>`;
    } else {
        welcomeMsg.innerHTML = `<h2>ברוך הבא!</h2>`;
    }
    
    statusMsg.className = 'status-message success';
    statusMsg.textContent = 'הוקצה לך תא בהצלחה!';
    
    boxNumber.textContent = result.box.boxNumber;
    ipAddress.textContent = result.box.ipAddress;
    
    startResultTimeout();
}

// Disconnect user
async function disconnectUser() {
    const result = await apiPost(`/api/users/${currentUserId}/release`);
    
    if (result && result.success) {
        showNotification(result.message, 'success');
        backToLogin();
    } else {
        showNotification('שגיאה בהתנתקות', 'error');
    }
}

// Back to login
function backToLogin() {
    clearResultTimeout();
    loginScreen.classList.remove('hidden');
    resultScreen.classList.add('hidden');
    adminPanel.classList.add('hidden');
    currentInput = '';
    currentUserId = null;
    updateDisplay();
}

// =====================
// Admin Functions
// =====================

let adminChoiceTimeoutId = null;

function showAdminChoiceModal() {
    openModal('adminChoiceModal');
    
    // Start progress bar animation
    const progressBar = document.getElementById('adminChoiceProgress');
    if (progressBar) {
        // Reset and start animation
        progressBar.style.width = '0%';
        setTimeout(() => {
            progressBar.style.width = '100%';
        }, 10);
    }
    
    // Auto-select "Get Box" after 3 seconds
    adminChoiceTimeoutId = setTimeout(() => {
        proceedAsUser();
    }, 3000);
}

function proceedAsAdmin() {
    clearAdminChoiceTimeout();
    closeModal('adminChoiceModal');
    showAdminPanel();
}

async function proceedAsUser() {
    clearAdminChoiceTimeout();
    closeModal('adminChoiceModal');
    
    // Login as regular user to get a box
    const result = await apiPost('/api/users/login', {
        id: currentUserId,
        hiveId: currentHiveId,
        forceUser: true
    });
    
    if (!result) {
        showNotification('שגיאה בהתחברות', 'error');
        backToLogin();
        return;
    }
    
    if (result.error === 'noAvailableBox') {
        showNotification(result.message, 'error');
        backToLogin();
    } else if (result.exists) {
        showExistingUser(result);
    } else if (result.success) {
        showNewUser(result);
    }
}

function clearAdminChoiceTimeout() {
    if (adminChoiceTimeoutId) {
        clearTimeout(adminChoiceTimeoutId);
        adminChoiceTimeoutId = null;
    }
    
    // Reset progress bar
    const progressBar = document.getElementById('adminChoiceProgress');
    if (progressBar) {
        progressBar.style.transition = 'none';
        progressBar.style.width = '0%';
        setTimeout(() => {
            progressBar.style.transition = 'width 3s linear';
        }, 10);
    }
}

function showAdminPanel() {
    loginScreen.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    loadMappings();
    showAdminTab('mappings');
}

function showAdminTab(tabName) {
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.add('hidden'));
    document.getElementById(tabName + 'Tab').classList.remove('hidden');
    
    switch(tabName) {
        case 'mappings':
            loadMappings();
            break;
        case 'boxes':
            loadBoxes();
            break;
        case 'hives':
            loadHives();
            break;
        case 'identities':
            loadIdentities();
            break;
        case 'admins':
            loadAdmins();
            break;
        case 'stats':
            loadStats();
            break;
    }
}

// Load mappings
async function loadMappings() {
    const users = await apiGet('/api/users');
    const tbody = document.getElementById('mappingsTable');
    
    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">אין מיפויים פעילים</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => `
        <tr>
            <td>${user.id}</td>
            <td>${user.name || '-'}</td>
            <td>${user.box ? user.box.boxNumber : '-'}</td>
            <td>${user.hiveId}</td>
            <td>${formatDate(user.connectedAt)}</td>
            <td>
                <button class="btn btn-danger" style="padding: 5px 10px; font-size: 0.8rem;" onclick="deleteMapping('${user.id}')">מחק</button>
            </td>
        </tr>
    `).join('');
}

// Delete mapping
async function deleteMapping(userId) {
    document.getElementById('deleteModalText').textContent = 'האם אתה בטוח שברצונך למחוק את המיפוי?';
    openModal('deleteModal');
    
    document.getElementById('confirmDeleteBtn').onclick = async () => {
        await apiDelete(`/api/users/${userId}`);
        closeModal('deleteModal');
        loadMappings();
        showNotification('המיפוי נמחק בהצלחה', 'success');
    };
}

// Load boxes
async function loadBoxes() {
    const [boxes, hives] = await Promise.all([
        apiGet('/api/boxes'),
        apiGet('/api/hives')
    ]);
    
    // Update hive select for new box
    const hiveSelect = document.getElementById('newBoxHive');
    hiveSelect.innerHTML = hives.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    
    // Update hive filter select
    const filterSelect = document.getElementById('filterBoxHive');
    const currentFilter = filterSelect.value;
    filterSelect.innerHTML = '<option value="">כל הכוורות</option>' + 
        hives.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    filterSelect.value = currentFilter; // Preserve selection
    
    // Create hive map for display
    const hiveMap = {};
    hives.forEach(h => hiveMap[h.id] = h.name);
    
    // Filter boxes if filter is set
    const filterHiveId = filterSelect.value;
    const filteredBoxes = filterHiveId ? boxes.filter(box => box.hiveId == filterHiveId) : boxes;
    
    // Sort boxes by box number if checkbox is checked
    const sortById = document.getElementById('sortBoxesById').checked;
    if (sortById) {
        filteredBoxes.sort((a, b) => a.boxNumber - b.boxNumber);
    }
    
    // Update boxes grid
    const grid = document.getElementById('boxesGrid');
    if (filteredBoxes.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">אין תאים להצגה</div>';
        return;
    }
    
    grid.innerHTML = filteredBoxes.map(box => `
        <div class="box-item ${box.status}" onclick="showBoxDetails(${box.id})">
            <div class="box-num">${box.boxNumber}</div>
            <div class="box-status">${box.status === 'free' ? 'פנוי' : 'תפוס'}</div>
            <div style="font-size: 0.75rem; margin-top: 3px; color: var(--secondary-color);">${hiveMap[box.hiveId] || 'כוורת ' + box.hiveId}</div>
            <div style="font-size: 0.8rem; margin-top: 5px; direction: ltr;">${box.ipAddress}</div>
        </div>
    `).join('');
}

// Suggest IP
async function suggestIp() {
    const hiveId = document.getElementById('newBoxHive').value;
    const boxNumber = document.getElementById('newBoxNumber').value;
    
    if (!boxNumber) {
        showNotification('נא להזין מספר תא', 'warning');
        return;
    }
    
    const result = await apiGet(`/api/boxes/suggest-ip/${hiveId}/${boxNumber}`);
    if (result) {
        document.getElementById('newBoxIp').value = result.suggestedIp;
    }
}

// Add box
async function addBox() {
    const hiveId = parseInt(document.getElementById('newBoxHive').value);
    const boxNumber = parseInt(document.getElementById('newBoxNumber').value);
    const ipAddress = document.getElementById('newBoxIp').value;
    
    if (!boxNumber || !ipAddress) {
        showNotification('נא למלא את כל השדות', 'warning');
        return;
    }
    
    await apiPost('/api/boxes', { hiveId, boxNumber, ipAddress });
    showNotification('התא נוסף בהצלחה', 'success');
    
    document.getElementById('newBoxNumber').value = '';
    document.getElementById('newBoxIp').value = '';
    loadBoxes();
}

// Show box details
async function showBoxDetails(boxId) {
    const boxes = await apiGet('/api/boxes');
    const box = boxes.find(b => b.id === boxId);
    
    if (!box) return;
    
    document.getElementById('deleteModalText').innerHTML = `
        <div style="text-align: right;">
            <p><strong>תא מספר:</strong> ${box.boxNumber}</p>
            <p><strong>כתובת IP:</strong> ${box.ipAddress}</p>
            <p><strong>סטטוס:</strong> ${box.status === 'free' ? 'פנוי' : 'תפוס'}</p>
        </div>
        <p style="margin-top: 15px;">האם למחוק את התא?</p>
    `;
    openModal('deleteModal');
    
    document.getElementById('confirmDeleteBtn').onclick = async () => {
        await apiDelete(`/api/boxes/${boxId}`);
        closeModal('deleteModal');
        loadBoxes();
        showNotification('התא נמחק בהצלחה', 'success');
    };
}

// Load hives
async function loadHives() {
    const [hives, settings] = await Promise.all([
        apiGet('/api/hives'),
        apiGet('/api/settings')
    ]);
    
    const grid = document.getElementById('hivesGrid');
    grid.innerHTML = hives.map(h => `
        <button class="hive-btn ${h.id === currentHiveId ? 'active' : ''}" onclick="selectHive(${h.id})">
            ${h.name}
            <button onclick="event.stopPropagation(); deleteHive(${h.id})" style="margin-right: 10px; background: none; border: none; color: var(--danger-color); cursor: pointer;">&times;</button>
        </button>
    `).join('');
    
    const select = document.getElementById('currentHiveSelect');
    select.innerHTML = hives.map(h => `<option value="${h.id}" ${h.id === currentHiveId ? 'selected' : ''}>${h.name}</option>`).join('');
}

// Add hive
async function addHive() {
    const name = document.getElementById('newHiveName').value;
    
    if (!name) {
        showNotification('נא להזין שם כוורת', 'warning');
        return;
    }
    
    await apiPost('/api/hives', { name });
    showNotification('הכוורת נוספה בהצלחה', 'success');
    
    document.getElementById('newHiveName').value = '';
    loadHives();
}

// Delete hive
async function deleteHive(hiveId) {
    document.getElementById('deleteModalText').textContent = 'האם אתה בטוח שברצונך למחוק את הכוורת וכל התאים שלה?';
    openModal('deleteModal');
    
    document.getElementById('confirmDeleteBtn').onclick = async () => {
        await apiDelete(`/api/hives/${hiveId}`);
        closeModal('deleteModal');
        loadHives();
        showNotification('הכוורת נמחקה בהצלחה', 'success');
    };
}

// Select hive
function selectHive(hiveId) {
    currentHiveId = hiveId;
    window.location.href = `/box?id=${hiveId}`;
}

// Change current hive
async function changeCurrentHive() {
    const hiveId = parseInt(document.getElementById('currentHiveSelect').value);
    await apiPost('/api/settings', { currentHive: hiveId });
    selectHive(hiveId);
}

// Load identities
async function loadIdentities() {
    const identities = await apiGet('/api/identity-mappings');
    const tbody = document.getElementById('identitiesTable');
    
    if (!identities || identities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">אין מיפויי זהות</td></tr>';
        return;
    }
    
    tbody.innerHTML = identities.map(identity => `
        <tr>
            <td>${identity.id}</td>
            <td>${identity.name}</td>
            <td>
                <button class="btn btn-danger" style="padding: 5px 10px; font-size: 0.8rem;" onclick="deleteIdentity('${identity.id}')">מחק</button>
            </td>
        </tr>
    `).join('');
}

// Add identity
async function addIdentity() {
    const id = document.getElementById('newIdentityId').value;
    const name = document.getElementById('newIdentityName').value;
    
    if (!id || !name) {
        showNotification('נא למלא את כל השדות', 'warning');
        return;
    }
    
    await apiPost('/api/identity-mappings', { id, name });
    showNotification('מיפוי הזהות נוסף בהצלחה', 'success');
    
    document.getElementById('newIdentityId').value = '';
    document.getElementById('newIdentityName').value = '';
    loadIdentities();
}

// Delete identity
async function deleteIdentity(identityId) {
    await apiDelete(`/api/identity-mappings/${identityId}`);
    showNotification('מיפוי הזהות נמחק', 'success');
    loadIdentities();
}

// Load admins
async function loadAdmins() {
    const admins = await apiGet('/api/admins');
    const tbody = document.getElementById('adminsTable');
    
    if (!admins || admins.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">אין מנהלים</td></tr>';
        return;
    }
    
    tbody.innerHTML = admins.map(admin => `
        <tr>
            <td>${admin.id}</td>
            <td>${admin.name}</td>
            <td>
                <button class="btn btn-danger" style="padding: 5px 10px; font-size: 0.8rem;" onclick="deleteAdmin('${admin.id}')">מחק</button>
            </td>
        </tr>
    `).join('');
}

// Add admin
async function addAdmin() {
    const id = document.getElementById('newAdminId').value;
    const name = document.getElementById('newAdminName').value;
    
    if (!id || !name) {
        showNotification('נא למלא את כל השדות', 'warning');
        return;
    }
    
    await apiPost('/api/admins', { id, name });
    showNotification('המנהל נוסף בהצלחה', 'success');
    
    document.getElementById('newAdminId').value = '';
    document.getElementById('newAdminName').value = '';
    loadAdmins();
}

// Delete admin
async function deleteAdmin(adminId) {
    await apiDelete(`/api/admins/${adminId}`);
    showNotification('המנהל נמחק', 'success');
    loadAdmins();
}

// Load stats
let hourlyUsageChart = null;

async function loadStats() {
    const stats = await apiGet('/api/stats');
    
    if (!stats) return;
    
    document.getElementById('statTotalUsers').textContent = stats.totalUsers;
    document.getElementById('statTotalBoxes').textContent = stats.totalBoxes;
    document.getElementById('statFreeBoxes').textContent = stats.freeBoxes;
    document.getElementById('statOccupiedBoxes').textContent = stats.occupiedBoxes;
    
    // Users per day
    const usersTable = document.getElementById('usersPerDayTable');
    usersTable.innerHTML = stats.usersPerDay.map(day => `
        <tr>
            <td>${day.date}</td>
            <td>${day.count}</td>
        </tr>
    `).join('');
    
    // Hourly usage chart
    createHourlyUsageChart(stats.usageStats);
    
    // Box usage
    const boxTable = document.getElementById('boxUsageTable');
    boxTable.innerHTML = stats.boxUsage.map(box => `
        <tr>
            <td>${box.boxNumber}</td>
            <td>${box.hiveId}</td>
            <td>${box.currentStatus === 'free' ? 'פנוי' : 'תפוס'}</td>
            <td>${box.usageCount}</td>
        </tr>
    `).join('');
}

// Create hourly usage chart
function createHourlyUsageChart(usageStats) {
    const canvas = document.getElementById('hourlyUsageChart');
    if (!canvas) return;
    
    // Calculate data for past week by hour
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Initialize hourly counts (0-23 hours)
    const hourCounts = new Array(24).fill(0);
    
    // Filter stats from past week and count connects by hour
    if (usageStats && Array.isArray(usageStats)) {
        usageStats.forEach(stat => {
            if (stat.action === 'connect' && stat.timestamp) {
                const statDate = new Date(stat.timestamp);
                if (statDate >= weekAgo && statDate <= now) {
                    const hour = statDate.getHours();
                    hourCounts[hour]++;
                }
            }
        });
    }
    
    // Destroy existing chart if it exists
    if (hourlyUsageChart) {
        hourlyUsageChart.destroy();
    }
    
    // Create chart
    const ctx = canvas.getContext('2d');
    hourlyUsageChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Array.from({length: 24}, (_, i) => `${i}:00`),
            datasets: [{
                label: 'מספר חיבורים',
                data: hourCounts,
                backgroundColor: 'rgba(52, 152, 219, 0.6)',
                borderColor: 'rgba(52, 152, 219, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#ecf0f1'
                    }
                },
                title: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1,
                        color: '#ecf0f1'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                x: {
                    ticks: {
                        color: '#ecf0f1'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Reset system
async function resetSystem() {
    document.getElementById('deleteModalText').textContent = 'אם אתה בטוח שברצונך לאפס את המערכת? כל המיפויים הפעילים יימחקו.';
    openModal('deleteModal');
    
    document.getElementById('confirmDeleteBtn').onclick = async () => {
        await apiPost('/api/reset');
        closeModal('deleteModal');
        loadMappings();
        showNotification('המערכת אופסה בהצלחה', 'success');
    };
}

// Clear history
async function clearHistory() {
    document.getElementById('deleteModalText').textContent = 'אם אתה בטוח שברצונך למחוק את כל ההיסטוריה? הפעולה לא ניתנת לביטול.';
    openModal('deleteModal');
    
    document.getElementById('confirmDeleteBtn').onclick = async () => {
        const result = await apiPost('/api/clear-history');
        closeModal('deleteModal');
        if (result && result.success) {
            showNotification('ההיסטוריה נמחקה בהצלחה', 'success');
            loadStats();
        } else {
            showNotification('שגיאה במחיקת ההיסטוריה', 'error');
        }
    };
}

// Add cursor blink animation
(function() {
    const blinkStyle = document.createElement('style');
    blinkStyle.textContent = `
        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
        }
    `;
    document.head.appendChild(blinkStyle);
})();

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
