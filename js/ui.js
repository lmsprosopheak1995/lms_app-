// =====================================================================
// ui.js — Theme switching, custom confirm/prompt modals, audit-log/history modal, notification panel, tab switching.
// =====================================================================

// ===================== HEADER CLOCK =====================
// Live time + date shown in the middle of the app header. Purely a display element — reads
// nothing from currentUser/loans/etc. — so it's safe to just start ticking as soon as this
// script loads, whether or not the person is logged in yet.
function updateHeaderClock() {
    const timeEl = document.getElementById('headerClockTime');
    const dateEl = document.getElementById('headerClockDate');
    if (!timeEl || !dateEl) return;
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('en-GB'); // HH:MM:SS
    dateEl.textContent = formatDateDMY(now); // DD/MM/YYYY
}
updateHeaderClock();
setInterval(updateHeaderClock, 1000);

// ===================== STICKY HEADER + TABS =====================
// .app-header and .tabs are both `position: sticky` (see styles.css) so they stay pinned to the
// top of the screen together while the rest of the page scrolls. The tabs bar needs to know
// exactly how tall the header is so it can sit right below it instead of overlapping it — and
// that height isn't fixed (it can wrap to two lines on narrow screens, or change if the
// username/notification bell content reflows). This keeps a CSS var in sync with the header's
// actual rendered height so .tabs's `top: var(--app-header-height)` always lines up.
function syncStickyHeaderHeight() {
    const header = document.querySelector('.app-header');
    const tabs = document.querySelector('.tabs');
    if (!header || header.offsetHeight === 0) return; // hidden (e.g. still on the login screen)
    document.documentElement.style.setProperty('--app-header-height', header.offsetHeight + 'px');
    // Table column headers (th) are sticky too (see styles.css) so long lists like the customer
    // table stay readable while scrolling — but they need to stick just below the frozen
    // header+tabs stack, not at the very top of the window, or they'd end up hidden behind it.
    const tabsHeight = tabs ? tabs.offsetHeight : 0;
    document.documentElement.style.setProperty('--sticky-stack-height', (header.offsetHeight + tabsHeight) + 'px');
}
window.addEventListener('resize', debounce(syncStickyHeaderHeight, 150));
if (document.querySelector('.app-header')) {
    new ResizeObserver(syncStickyHeaderHeight).observe(document.querySelector('.app-header'));
}
if (document.querySelector('.tabs')) {
    new ResizeObserver(syncStickyHeaderHeight).observe(document.querySelector('.tabs'));
}


function applyTheme(theme) {
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
        document.getElementById('darkModeToggle').checked = true;
    } else {
        document.body.classList.remove('dark-mode');
        document.getElementById('darkModeToggle').checked = false;
    }
    updateChartTheme(theme);
}

// Theme is now a per-user cloud preference (app_user_roles.theme_preference) instead of a
// per-browser localStorage value, so it follows the officer between devices.
async function toggleTheme() {
    const isDark = document.getElementById('darkModeToggle').checked;
    const newTheme = isDark ? 'dark' : 'light';
    applyTheme(newTheme);
    if (currentUser) {
        currentUser.themePreference = newTheme;
        try {
            await upsertUserRoleProfile({ uid: currentUser.uid, theme_preference: newTheme });
        } catch (e) {
            console.error('Could not save theme preference to cloud:', e);
        }
    }
}

function initTheme() {
    const savedTheme = (currentUser && currentUser.themePreference) || 'light';
    applyTheme(savedTheme);
    document.getElementById('darkModeToggle').addEventListener('change', toggleTheme);
}

function updateChartTheme(theme) {
    if (!window.Chart) return;
    const isDark = theme === 'dark';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDark ? '#e0e0e0' : '#333';

    Chart.defaults.color = textColor;
    Chart.defaults.borderColor = gridColor;

    // Force-update any existing charts
    Object.values(charts).forEach(chart => {
        if (chart.options) {
            if(chart.options.scales && chart.options.scales.x) {
                chart.options.scales.x.grid.color = gridColor;
                chart.options.scales.x.ticks.color = textColor;
            }
            if(chart.options.scales && chart.options.scales.y) {
                chart.options.scales.y.grid.color = gridColor;
                chart.options.scales.y.ticks.color = textColor;
            }
            chart.update();
        }
    });
}

// ===================== AUDIT LOG =====================
function logChange(loanId, action, details = {}) {
    if (!loanId && action !== 'Expense Action' && action !== 'System Event') return;
    const key = loanId || 'system';
    if (!loanHistory[key]) {
        loanHistory[key] = [];
    }
    const logEntry = {
        ts: new Date().toISOString(),
        user: currentUser ? currentUser.username : 'System',
        action,
        details: JSON.stringify(details)
    };
    loanHistory[key].unshift(logEntry);
    persistData(LS_KEYS.loanHistory, loanHistory);
}
// Khmer labels for the most common audit-log field names, so the History modal shows readable
// labels instead of raw JSON keys. Anything not listed here falls back to a spaced-out version
// of the camelCase key (e.g. "loanTerm" -> "Loan Term").
const HISTORY_FIELD_LABELS = {
    isNew: 'ប្រភេទប្រតិបត្តិការ', data: null,
    loanDate: 'កាលបរិច្ឆេទកម្ចី', currency: 'រូបិយប័ណ្ណ', loanAmount: 'ចំនួនប្រាក់កម្ចី',
    interestRate: 'អត្រាការប្រាក់', interestRateType: 'ប្រភេទអត្រាការប្រាក់',
    serviceRate: 'អត្រាសេវា', adminFee: 'កម្រៃរដ្ឋបាល', insuranceFee: 'កម្រៃធានារ៉ាប់រង',
    loanTerm: 'រយៈពេលកម្ចី', interestUnit: 'ឯកតារយៈពេល', paymentMethod: 'វិធីបង់ប្រាក់',
    paymentDateType: 'ប្រភេទកាលបរិច្ឆេទបង់ប្រាក់', creditOfficer: 'មន្ត្រីឥណទាន',
    calculationType: 'របៀបគណនា', fixedDayOfMonth: 'ថ្ងៃទីកំណត់ក្នុងខែ', everyXDays: 'រៀងរាល់ (ថ្ងៃ)',
    penaltyFee: 'ប្រាក់ពិន័យ', penaltyType: 'ប្រភេទប្រាក់ពិន័យ', latitude: 'រយៈទទឹង', longitude: 'រយៈបណ្តោយ',
    customerId: 'លេខសម្គាល់អតិថិជន', loanId: 'លេខសម្គាល់កម្ចី', processedBy: 'ដំណើរការដោយ',
    processedAt: 'ដំណើរការនៅ', status: 'ស្ថានភាព', isArchived: 'ទុកក្នុងបណ្ណសារ',
    newStatus: 'ស្ថានភាពថ្មី', reason: 'មូលហេតុ', installment: 'រំលោះទី', paymentId: 'លេខសម្គាល់ការទូទាត់',
    amount: 'ចំនួនទឹកប្រាក់', date: 'កាលបរិច្ឆេទ', event: 'ព្រឹត្តិការណ៍', newRate: 'អត្រាប្តូរប្រាក់ថ្មី',
    action: 'សកម្មភាព', expenseId: 'លេខសម្គាល់ចំណាយ'
};

function historyFieldLabel(key) {
    if (Object.prototype.hasOwnProperty.call(HISTORY_FIELD_LABELS, key)) return HISTORY_FIELD_LABELS[key];
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function formatHistoryScalar(value) {
    if (value === null || value === undefined || value === '') return '<span style="color:#999;">-</span>';
    if (typeof value === 'boolean') {
        return value ? '<span style="color:var(--success,#28a745);"><i class="fas fa-check"></i> បាទ/ចាស</span>'
                     : '<span style="color:var(--muted,#6c757d);"><i class="fas fa-times"></i> ទេ</span>';
    }
    if (typeof value === 'number') return esc(value.toLocaleString());
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        const d = new Date(value);
        if (!isNaN(d)) return esc(d.toLocaleString('en-GB'));
    }
    return esc(String(value));
}

// Renders a log entry's `details` object as a small nested key/value table instead of a raw JSON
// blob, so the History modal is actually readable. A wrapped "data" object (used by Create/Update
// Loan entries) is flattened into the parent so its fields show up directly rather than one level
// deeper. Nested objects/arrays get their own sub-table; everything else is a plain row.
function renderHistoryDetailsTable(details) {
    if (details === null || details === undefined) return '<span style="color:#999;">-</span>';
    if (typeof details !== 'object') return formatHistoryScalar(details);

    let obj = details;
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
        obj = { ...obj, ...obj.data };
        delete obj.data;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) return '<span style="color:#999;">-</span>';

    const rows = entries.map(([key, value]) => {
        const label = historyFieldLabel(key);
        if (label === null) return ''; // explicitly hidden field
        let displayValue;
        if (Array.isArray(value)) {
            displayValue = value.length ? esc(value.map(v => (v && typeof v === 'object') ? JSON.stringify(v) : String(v)).join(', ')) : '<span style="color:#999;">-</span>';
        } else if (value && typeof value === 'object') {
            displayValue = renderHistoryDetailsTable(value);
        } else {
            displayValue = formatHistoryScalar(value);
        }
        return `<tr><td class="history-detail-label">${esc(label)}</td><td class="history-detail-value">${displayValue}</td></tr>`;
    }).join('');

    return `<table class="history-detail-table">${rows}</table>`;
}

function openHistoryModal() {
  if(!currentLoan) return;
  document.getElementById('historyLoanId').textContent = currentLoan.loanId;
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = '';
  const history = loanHistory[currentLoan.loanId] || [];
  if(history.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="center">No history recorded.</td></tr>`;
  } else {
      const fragment = document.createDocumentFragment();
      history.forEach(log => {
          const tr = document.createElement('tr');
          let parsedDetails;
          try { parsedDetails = JSON.parse(log.details); } catch (e) { parsedDetails = log.details; }
          tr.innerHTML = `
              <td>${new Date(log.ts).toLocaleString('en-GB')}</td>
              <td>${esc(getOfficerFullName(log.user))}</td>
              <td>${esc(log.action)}</td>
              <td class="history-detail-cell">${renderHistoryDetailsTable(parsedDetails)}</td>
          `;
          fragment.appendChild(tr);
      });
      tbody.appendChild(fragment);
  }
  document.getElementById('historyModal').style.display = 'flex';
}
function closeHistoryModal() { document.getElementById('historyModal').style.display = 'none'; }


function switchTab(t) {
    document.querySelectorAll(".tab-content").forEach(e => e.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(e => e.classList.remove("active"));
    document.getElementById(t + "Tab").classList.add("active");
    document.querySelector(`.tab[onclick="switchTab('${t}')"]`).classList.add("active");
    
    if (t === 'dashboard') { renderDashboard(); }
    else if (t === 'analysis') { renderAnalysisCharts(); }
    else if (t === 'customers') { 
        renderCustomersListTable();
        hideCustomerForm();
    }
    else if (t === 'customerProfile') {
        populateCustomerDropdowns();
        renderCustomerProfile();
    }
     else if (t === 'clientAccount') { 
        populateCustomerDropdowns(); 
        renderClientAccountView(); 
    }
    else if (t === 'collections') {
        populateOfficerDropdown('collectionsOfficerFilter', true, 'all');
        if (!document.getElementById('collectionsDate').value) {
            document.getElementById('collectionsDate').value = formatDateISO(new Date());
        }
        renderCollectionsTable();
    }
    else if (t === 'reports') {
        populateOfficerDropdown('reportOfficer', true);
    }
    else if (t === 'admin') { renderAdminTabs(); }
    else if (t === 'expenses') { renderExpensesTable(); }
    else if (t === 'map') { initMap(); }
    else if (t === 'savings') { displaySavingsAccounts(); }
}

function switchSubTab(parentTab, subTab) {
    document.querySelectorAll(`#${parentTab}Tab .sub-tab-content`).forEach(e => e.classList.remove("active"));
    document.querySelectorAll(`#${parentTab}Tab .sub-tab`).forEach(e => e.classList.remove("active"));
    document.getElementById(subTab + "SubTab").classList.add("active");
    document.querySelector(`#${parentTab}Tab .sub-tab[onclick*="'${subTab}'"]`).classList.add("active");
}

function renderAdminTabs() {
    renderUsersTable();
    checkBackupReminder();
    renderHolidaysTable();
    renderLoanProductsTable();
    renderLoanRequestsTable();
    renderExpenseCategories();
    renderMessageTemplates();
    loadCloudSettingsIntoForm();
    loadMaintenanceSettingsIntoForm();
}

function toggleFormLock(locked) {
  const formElements = document.getElementById('loanForm').querySelectorAll('input, select, textarea');
  formElements.forEach(el => { 
      if (el.id !== 'customerSelect') {
          el.readOnly = locked; 
          el.disabled = locked; 
      }
  });
  document.getElementById('formActions').querySelectorAll('button').forEach(btn => btn.style.display = 'inline-block');
  if (locked) {
      document.getElementById('formActions').querySelectorAll('button:not(#historyBtn)').forEach(btn => btn.style.display = 'none');
  }
}

// ===================== NOTIFICATION SYSTEM =====================
function createNotification(id, icon, text, link, loanId = null) {
    if (!notifications.some(n => n.id === id)) {
        notifications.unshift({ id, icon, text, link, read: false, ts: new Date().toISOString(), loanId });
        persistData(LS_KEYS.notifications, notifications);
    }
}

function generateNotifications() {
    const today = new Date();
    const thirtyDaysFromNow = addDays(today, 30);

    loans.forEach(loan => {
        const status = getLoanComputedStatus(loan);
        if (status.key === 'active' || status.key === 'overdue') {
            const schedule = buildSchedule(loan);
            if (schedule.length > 0) {
                const lastInstallmentDate = parseDate(schedule[schedule.length - 1].date);
                if (lastInstallmentDate <= thirtyDaysFromNow && lastInstallmentDate >= today) {
                    createNotification(`ending-${loan.loanId}`, 'fa-hourglass-end', `កម្ចី ${loan.loanId} នឹងបញ្ចប់ឆាប់ៗនេះ។`, `javascript:goToLoan('${loan.loanId}')`, loan.loanId);
                }
            }
        }
    });
    
    if (hasPermission('canApproveLoan')) {
        const pendingLoans = loans.filter(l => l.status === 'pending');
        pendingLoans.forEach(loan => {
            createNotification(`pending-${loan.loanId}`, 'fa-gavel', `កម្ចី ${loan.loanId} កំពុងរង់ចាំការអនុម័ត។`, `javascript:goToLoan('${loan.loanId}')`, loan.loanId);
        });

        const pendingRequests = loanRequests.filter(r => r.status === 'pending');
        pendingRequests.forEach(req => {
            createNotification(`loanreq-${req.id}`, 'fa-file-signature', `${req.name} បានស្នើសុំកម្ចីថ្មី។`, `javascript:goToLoanRequest('${req.id}')`);
        });
    }

    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById('notificationList');
    const countBadge = document.getElementById('notificationCount');
    list.innerHTML = '';

    const unreadCount = notifications.filter(n => !n.read).length;

    if (unreadCount > 0) {
        countBadge.textContent = unreadCount;
        countBadge.style.display = 'block';
    } else {
        countBadge.style.display = 'none';
    }

    if (notifications.length === 0) {
        list.innerHTML = `<div class="notification-item" style="text-align: center; color: #888;">មិនមានការជូនដំណឹងថ្មី</div>`;
        return;
    }

    notifications.forEach(n => {
        const item = document.createElement('a');
        item.href = n.link;
        item.className = `notification-item ${n.read ? 'read' : 'unread'}`;
        item.onclick = () => markNotificationAsRead(n.id);
        item.innerHTML = `<i class="fas ${n.icon}"></i> <div>${esc(n.text)}<div style="font-size:11px; color:#777; font-weight:normal;">${new Date(n.ts).toLocaleString('en-GB')}</div></div>`;
        list.appendChild(item);
    });
}
function goToLoan(loanId) {
    switchTab('loans');
    loadLoan(loanId);
    toggleNotificationPanel();
}
function goToLoanRequest(requestId) {
    switchTab('admin');
    switchSubTab('admin', 'loanRequests');
    toggleNotificationPanel();
    if (requestId) {
        const row = Array.from(document.querySelectorAll('#loanRequestsTableBody tr'))
            .find(tr => tr.querySelector(`[onclick*="'${requestId}'"]`));
        if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.add('selected-row');
            setTimeout(() => row.classList.remove('selected-row'), 3000);
        }
    }
}
function toggleNotificationPanel() {
    const panel = document.getElementById('notificationPanel');
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

function markNotificationAsRead(id) {
    const index = notifications.findIndex(n => n.id === id);
    if (index > -1) {
        notifications[index].read = true;
        persistData(LS_KEYS.notifications, notifications);
        renderNotifications();
    }
}
function markAllNotificationsAsRead() {
    notifications.forEach(n => n.read = true);
    persistData(LS_KEYS.notifications, notifications);
    renderNotifications();
}

async function clearNotifications() {
    if (await customConfirm('Are you sure you want to clear all notifications?')) {
        notifications = [];
        persistData(LS_KEYS.notifications, notifications);
        renderNotifications();
    }
}

