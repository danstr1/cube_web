// User System JavaScript

// State
let currentInput = '';
let currentUserId = null;
let currentBox = null;
let timeoutId = null;
const TIMEOUT_SECONDS = 10;

// DOM Elements - initialized after DOM loads
let loginScreen, connectedScreen, notFoundScreen, inputDisplay;

// Initialize
function init() {
    // Get DOM elements
    loginScreen = document.getElementById('loginScreen');
    connectedScreen = document.getElementById('connectedScreen');
    notFoundScreen = document.getElementById('notFoundScreen');
    inputDisplay = document.getElementById('inputValue');
    
    // Listen for keyboard input (for tag reader)
    document.addEventListener('keydown', handleKeyboard);
    
    // Attach keypad event listeners
    setupKeypad();
    
    console.log('User system initialized');
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

// Handle keyboard input
function handleKeyboard(e) {
    if (!loginScreen.classList.contains('hidden')) {
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
}

// Add digit to input
function addDigit(digit) {
    if (currentInput.length < 14) {
        currentInput += digit;
        updateDisplay();
        resetTimeout();
    }
}

// Delete last digit
function deleteDigit() {
    currentInput = currentInput.slice(0, -1);
    updateDisplay();
    if (currentInput.length > 0) {
        resetTimeout();
    } else {
        clearTimeoutTimer();
    }
}

// Update display
function updateDisplay() {
    inputDisplay.textContent = currentInput;
}

// Reset timeout (without visual progress bar)
function resetTimeout() {
    clearTimeoutTimer();
    
    timeoutId = setTimeout(() => {
        currentInput = '';
        updateDisplay();
        clearTimeoutTimer();
    }, TIMEOUT_SECONDS * 1000);
}

// Clear timeout
function clearTimeoutTimer() {
    if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
    }
}

// Submit login
async function submitLogin() {
    if (!currentInput) {
        showNotification('נא להזין מספר זיהוי', 'warning');
        return;
    }
    
    clearTimeoutTimer();
    
    const result = await apiGet(`/api/users/${currentInput}`);
    
    if (!result) {
        showNotification('שגיאה בבדיקת מזהה', 'error');
        return;
    }
    
    currentUserId = currentInput;
    
    if (result.found) {
        showConnected(result);
    } else {
        showNotFound();
    }
}

// Show connected screen
function showConnected(result) {
    loginScreen.classList.add('hidden');
    connectedScreen.classList.remove('hidden');
    notFoundScreen.classList.add('hidden');
    
    currentBox = result.box;
    
    const welcomeMsg = document.getElementById('welcomeMessage');
    const boxNumber = document.getElementById('boxNumber');
    const ipAddress = document.getElementById('ipAddress');
    const connectLink = document.getElementById('connectLink');
    
    if (result.name) {
        welcomeMsg.innerHTML = `<h2>שלום ${result.name}!</h2>`;
    } else {
        welcomeMsg.innerHTML = `<h2>שלום!</h2>`;
    }
    
    boxNumber.textContent = result.box.boxNumber;
    ipAddress.textContent = result.box.ipAddress;
    connectLink.href = `http://${result.box.ipAddress}`;
}

// Show not found screen
function showNotFound() {
    loginScreen.classList.add('hidden');
    connectedScreen.classList.add('hidden');
    notFoundScreen.classList.remove('hidden');
}

// Disconnect session (Yellow button) - stays registered
async function disconnectSession() {
    const result = await apiPost(`/api/users/${currentUserId}/disconnect`);
    
    if (result && result.success) {
        showNotification(result.message, 'success');
        backToLogin();
    } else {
        showNotification('שגיאה בהתנתקות', 'error');
    }
}

// Release box (Red button) - frees the box
async function releaseBox() {
    const result = await apiPost(`/api/users/${currentUserId}/release`);
    
    if (result && result.success) {
        showNotification(result.message, 'success');
        backToLogin();
    } else {
        showNotification('שגיאה בשחרור התא', 'error');
    }
}

// Back to login
function backToLogin() {
    loginScreen.classList.remove('hidden');
    connectedScreen.classList.add('hidden');
    notFoundScreen.classList.add('hidden');
    currentInput = '';
    currentUserId = null;
    currentBox = null;
    updateDisplay();
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
