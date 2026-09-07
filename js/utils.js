// =====================================================================
// utils.js — Generic helpers: HTML escaping, localStorage persistence, formatting (date/currency), toast/permission checks, pagination.
// =====================================================================

// ===================== SECURITY: HTML ESCAPING =====================
// Any value that originated as free-text user input (customer name, phone, notes, guarantor
// info, message templates, etc.) MUST be passed through esc() before being placed inside an
// innerHTML template string. Without this, a malicious value (e.g. a customer name containing
// "<img src=x onerror=...>") would execute as script in the browser of whoever views that
// record (stored XSS) — including admin accounts.
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ===================== PERMISSIONS & NOTIFICATIONS =====================
function hasPermission(action) {
  if (!currentUser || !currentUser.role) return false;
  const userPermissions = PERMISSIONS[currentUser.role];
  return userPermissions ? userPermissions[action] === true : false;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-triangle' : 'fa-info-circle';
    toast.innerHTML = `<i class="fas ${icon}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toast-out 0.5s forwards';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

// ===================== CUSTOM CONFIRM / PROMPT MODALS =====================
// Replaces native browser confirm()/prompt() ("This page says...") dialogs with
// in-app popup windows styled like the rest of the application. Both return a
// Promise so existing `if (confirm(...))` call sites just become
// `if (await customConfirm(...))`.
function customConfirm(message, title = 'បញ្ជាក់ការសម្រេចចិត្ត') {
    return new Promise((resolve) => {
        const modal = document.getElementById('customConfirmModal');
        document.getElementById('customConfirmTitle').innerHTML = `<i class="fas fa-question-circle"></i> ${title}`;
        document.getElementById('customConfirmMessage').textContent = message;
        modal.style.display = 'flex';

        const okBtn = document.getElementById('customConfirmOkBtn');
        const cancelBtn = document.getElementById('customConfirmCancelBtn');

        const cleanup = (result) => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKeydown);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onKeydown = (e) => {
            if (e.key === 'Escape') cleanup(false);
            if (e.key === 'Enter') cleanup(true);
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKeydown);
    });
}

function customPrompt(message, defaultValue = '', title = 'បញ្ចូលព័ត៌មាន') {
    return new Promise((resolve) => {
        const modal = document.getElementById('customPromptModal');
        document.getElementById('customPromptTitle').innerHTML = `<i class="fas fa-keyboard"></i> ${title}`;
        document.getElementById('customPromptMessage').textContent = message;
        const input = document.getElementById('customPromptInput');
        input.value = defaultValue || '';
        modal.style.display = 'flex';
        setTimeout(() => input.focus(), 50);

        const okBtn = document.getElementById('customPromptOkBtn');
        const cancelBtn = document.getElementById('customPromptCancelBtn');

        const cleanup = (result) => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKeydown);
            resolve(result);
        };
        const onOk = () => cleanup(input.value);
        const onCancel = () => cleanup(null);
        const onKeydown = (e) => {
            if (e.key === 'Escape') cleanup(null);
            if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKeydown);
    });
}

// ===================== DATA PERSISTENCE & HELPERS =====================
// NOTE: this used to write straight to localStorage. It's now backed entirely by Supabase
// (see db.js) — nothing here touches the browser's local storage anymore. The function
// signature is unchanged on purpose so every existing call site across the app (loans.js,
// customers.js, savings.js, admin.js, ui.js...) keeps working without modification: update
// the in-memory array/object as before, call persistData(key, data), and the new data
// layer figures out what changed and pushes just that to the right Supabase table in the
// background (debounced, so rapid edits don't spam the network).
function persistData(key, data) {
  try {
    __cloudCache[key] = data;
    if (key === LS_KEYS.appSettings) {
      scheduleAppSettingsPush(data); // single shared settings row — handled separately, see db.js
    } else {
      scheduleCloudPush(key, data);
    }
  } catch (e) {
    console.error("Error saving to cloud database", e);
    showToast("Error saving data.", "error");
  }
}

// Returns whatever is currently in the in-memory cloud cache for this key. That cache is
// filled once at startup by loadAllCloudData() (db.js), awaited before the rest of the app
// initializes — so by the time any screen calls loadData(), the data is already there.
function loadData(key, isObject = false) {
  const defaultData = isObject ? {} : [];
  return (key in __cloudCache) ? __cloudCache[key] : defaultData;
}

function getOfficerFullName(username) {
    const users = getUsers();
    const user = users.find(u => u.username === username);
    return user ? user.fullName : (username || 'N/A');
}
function getCustomer(customerId) {
    return customers.find(c => c.id === customerId) || { id: null, name: 'អតិថិជនមិនស្គាល់', gender: 'ប្រុស', phone: '', village: '', commune: '', district: '', province: '', residency: 'resident' };
}

function populateOfficerDropdown(selectElementId, includeAll = true, selectedUser = null) {
    const select = document.getElementById(selectElementId);
    if (!select) return;
    const users = getUsers();
    const officers = users.filter(u => u.role === 'officer' || u.role === 'manager' || u.role === 'admin');
    select.innerHTML = includeAll ? '<option value="all">ទាំងអស់</option>' : '';

    officers.sort((a,b) => a.fullName.localeCompare(b.fullName)).forEach(o => {
        select.innerHTML += `<option value="${esc(o.username)}">${esc(o.fullName)}</option>`;
    });

    if (selectedUser) {
        select.value = selectedUser;
    }

    if (!hasPermission('canViewAllLoans') && !includeAll) {
       select.value = currentUser.username;
       select.disabled = true;
    }
}

// ===================== UTILITY FUNCTIONS =====================
// Exchange rate now lives in the shared app_settings row on Supabase (see db.js) instead of
// localStorage, so every officer sees the same rate rather than whatever was last set in their
// own browser.
function getExchangeRate(){const t=Number(getCloudExchangeRate());return Number.isFinite(t)&&t>0?t:4100}
function setExchangeRate(t){saveExchangeRateToCloud(t,(new Date).toLocaleDateString("en-GB")),updateExchangeUI(),logChange(null,'System Event',{event:'Exchange Rate Updated',newRate:t})}
function updateExchangeUI(){
    document.getElementById("exchangeRateInput").value=getExchangeRate();
    document.getElementById("exDateTag").textContent=getCloudExchangeRateDate()||(new Date).toLocaleDateString("en-GB");
    const displayRateEl = document.getElementById('exchangeRateDisplay');
    if (displayRateEl) {
        displayRateEl.innerHTML = `<i class="fas fa-dollar-sign"></i> 1 = <span style="font-family: sans-serif;">${getExchangeRate().toLocaleString()}</span> ៛`;
    }
}
function updateInterestRateTypeUI() {
    const typeEl = document.getElementById('interestRateType');
    const icon = document.getElementById('interestRateIcon');
    const input = document.getElementById('interestRate');
    if (!typeEl || !icon || !input) return;
    if (typeEl.value === 'fixed') {
        icon.className = 'fas fa-dollar-sign';
        input.title = 'ចំនួនការប្រាក់ថេរក្នុងមួយដងបង់ (មិនមែនជាភាគរយ)';
    } else {
        icon.className = 'fas fa-percent';
        input.title = 'អត្រាការប្រាក់ជាភាគរយ';
    }
}

function formatDateDMY(t){if(!t)return"";try{const e=parseDate(t),n=String(e.getDate()).padStart(2,"0"),a=String(e.getMonth()+1).padStart(2,"0");return`${n}/${a}/${e.getFullYear()}`}catch(e){return "Invalid Date"}}
function formatDateISO(t){if(!t)return"";try{const e=parseDate(t);return new Date(e.getTime()-(e.getTimezoneOffset()*6e4)).toISOString().split("T")[0]}catch(e){return""}}
function parseDate(t){if(t instanceof Date&&!isNaN(t))return new Date(t);if(typeof t==="string"){const e=new Date(t);if(!isNaN(e.getTime()))return e;const n=t.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(n)return new Date(n[1],n[2]-1,n[3])}return new Date(NaN)}
function convertCurrency(t,e,n){const a=Number(t)||0,o=getExchangeRate();return e===n?a:"USD"===e&&"KHR"===n?Math.round(a*o):"KHR"===e&&"USD"===n?parseFloat((a/o).toFixed(2)):a}
function fmtMoney(t,e){const n=Number(t)||0;return"USD"===e?"$"+n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):n.toLocaleString("en-US",{maximumFractionDigits:0})+"៛"}
function genId(){return Date.now().toString(36) + Math.random().toString(36).substr(2);}
function daysInMonth(t,e){return new Date(t,e+1,0).getDate()}
function addMonthsClamped(t,e,n){const a=parseDate(t),o=a.getFullYear(),r=a.getMonth(),l=new Date(o,r+e,1),s=daysInMonth(l.getFullYear(),l.getMonth()),i=Math.min(n??a.getDate(),s);return l.setDate(i),l.setHours(0,0,0,0),l}
function addDays(t,e){const n=parseDate(t);return n.setDate(n.getDate()+e),n.setHours(0,0,0,0),n}
function debounce(func, delay) {let timeout; return function(...args) { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), delay); };}
function getCurrentLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                document.getElementById('latitude').value = position.coords.latitude.toFixed(6);
                document.getElementById('longitude').value = position.coords.longitude.toFixed(6);
                showToast('Location captured!', 'success');
            },
            (error) => {
                showToast(`Error getting location: ${error.message}`, 'error');
            }
        );
    } else {
        showToast('Geolocation is not supported by this browser.', 'error');
    }
}
function setDualCurrencyText(elementId, amount, currency) {
    const el = document.getElementById(elementId);
    if (!el) return;
    
    const primaryAmount = fmtMoney(amount, currency);
    const secondaryCurrency = currency === 'USD' ? 'KHR' : 'USD';
    const secondaryAmount = fmtMoney(convertCurrency(amount, currency, secondaryCurrency), secondaryCurrency);
    
    el.innerHTML = `<div>${primaryAmount}</div><div class="secondary-amount">${secondaryAmount}</div>`;
}

// ===================== PAGINATION =====================
function renderPaginationControls(totalRows) {
    const container = document.getElementById('paginationControls'); container.innerHTML = '';
    if (totalRows <= ROWS_PER_PAGE) return;
    const totalPages = Math.ceil(totalRows / ROWS_PER_PAGE);
    container.innerHTML = `<button class="btn btn-muted btn-sm" id="prevPageBtn" ${currentPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button><span class="page-info">Page ${currentPage} of ${totalPages}</span><button class="btn btn-muted btn-sm" id="nextPageBtn" ${currentPage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
    document.getElementById('prevPageBtn').addEventListener('click', () => { if (currentPage > 1) { currentPage--; displayLoans(); } });
    document.getElementById('nextPageBtn').addEventListener('click', () => { if (currentPage < totalPages) { currentPage++; displayLoans(); } });
}

