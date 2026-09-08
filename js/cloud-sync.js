// =====================================================================
// cloud-sync.js — Supabase connection settings, Telegram notifications,
// JSON export/import, and application reset.
// =====================================================================
// NOTE ON WHAT CHANGED: this file used to push the ENTIRE app state as one
// JSON blob to a single "lms_backups" row (syncToSupabaseNow/
// restoreFromSupabaseNow), because localStorage was the real system of
// record and Supabase was just an occasional mirror of it. Now that every
// entity lives directly in its own Supabase table and syncs automatically
// on every change (see db.js), that whole mechanism is redundant — there's
// no separate "push to cloud" step anymore, and no separate "restore from
// cloud" step either (loadAllCloudData() already does that on every app
// load). What's left here is: (1) the one-time connection settings that
// tell the browser which Supabase project to talk to, (2) Telegram
// notifications (used throughout the app for business events — new loan,
// payment, etc. — unrelated to the old blob sync), and (3) a plain JSON
// export/import for the admin's own offline records.

// ===================== EXPORT / IMPORT SNAPSHOT (JSON file) =====================
// Downloads the data currently loaded in memory (i.e. what's in Supabase right now) as a JSON
// file, purely for the admin's own offline record-keeping — nothing here reads or writes
// localStorage or Supabase.
function backupData() {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    try {
        const snapshot = {
            [LS_KEYS.loans]: loans, [LS_KEYS.customers]: customers, [LS_KEYS.payments]: payments,
            [LS_KEYS.refinances]: refinances, [LS_KEYS.holidays]: holidays, [LS_KEYS.collaterals]: collaterals,
            [LS_KEYS.guarantors]: guarantors, [LS_KEYS.loanHistory]: loanHistory, [LS_KEYS.expenses]: expenses,
            [LS_KEYS.notifications]: notifications, [LS_KEYS.loanProducts]: loanProducts,
            [LS_KEYS.savingsAccounts]: savingsAccounts, [LS_KEYS.savingsPayments]: savingsPayments,
            [LS_KEYS.savingsWithdrawals]: savingsWithdrawals, [LS_KEYS.appSettings]: appSettings,
            exportedAt: new Date().toISOString()
        };
        const dataStr = JSON.stringify(snapshot, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const a = document.createElement('a');
        a.href = url; a.download = `lms_export_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('បាននាំចេញទិន្នន័យទៅឯកសារ JSON ជោគជ័យ!', 'success');
    } catch(e) {
        showToast("Export failed. Data may be too large.", "error");
        console.error(e);
    }
}

// Imports a JSON file produced by backupData() and pushes each entity into Supabase — this
// OVERWRITES the corresponding cloud tables with what's in the file, one entity at a time.
async function restoreData(event) {
  if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
  if (!await customConfirm('ការនាំចូលនេះនឹងសរសេរជាន់លើទិន្នន័យនៅលើ Cloud Database ទាំងអស់។\nតើអ្នកប្រាកដទេថាចង់បន្ត? (Importing will overwrite the corresponding cloud data. Are you sure you want to continue?)')) {
      event.target.value = ''; return;
  }
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
      try {
          const snapshot = JSON.parse(e.target.result);
          const push = (key, fallback) => { if (snapshot[key] !== undefined) persistData(key, snapshot[key]); else if (fallback !== undefined) persistData(key, fallback); };
          push(LS_KEYS.loans, []); push(LS_KEYS.customers, []); push(LS_KEYS.payments, {});
          push(LS_KEYS.refinances, []); push(LS_KEYS.holidays, []); push(LS_KEYS.collaterals, []);
          push(LS_KEYS.guarantors, []); push(LS_KEYS.loanHistory, {}); push(LS_KEYS.expenses, []);
          push(LS_KEYS.notifications, []); push(LS_KEYS.loanProducts, []);
          push(LS_KEYS.savingsAccounts, []); push(LS_KEYS.savingsPayments, {});
          push(LS_KEYS.savingsWithdrawals, {}); push(LS_KEYS.appSettings, {});
          showToast('កំពុងផ្ញើទិន្នន័យទៅ Cloud... ប្រព័ន្ធនឹងផ្ទុកឡើងវិញក្នុងពេលបន្តិច', 'success');
          setTimeout(() => location.reload(), 3000); // give the debounced cloud pushes time to go out
      } catch (error) {
          showToast('ឯកសារនាំចូលមិនត្រឹមត្រូវ', 'error'); console.error("Import error: ", error);
      }
  };
  reader.readAsText(file); event.target.value = '';
}

// The old "you haven't backed up in 7 days" nag doesn't make sense anymore — the whole point of
// storing everything in Supabase is that there's no local-only copy at risk of being lost.
// Kept as a function (still called from ui.js) so nothing else needs to change; it just makes
// sure the banner stays hidden.
function checkBackupReminder() {
    const reminderElem = document.getElementById('backupReminder');
    if (reminderElem) reminderElem.style.display = 'none';
}

// ===================== SUPABASE CONNECTION SETTINGS & TELEGRAM NOTIFICATIONS =====================
// This is the one piece of configuration that legitimately has to live in the browser: it's
// what tells this browser WHICH Supabase project to talk to in the first place, before any
// data request is even possible — every other page on the internet that talks to a
// client-configured backend works the same way. It is not "app data" in the sense the rest of
// this migration is about.
const CLOUD_SETTINGS_KEY = 'lms_cloudSettings_v1';

// SECURITY NOTE: the anon key below is meant to be public (it's the standard Supabase
// client-side key, and the project's Row Level Security policies — not secrecy of this key —
// are what actually control who can read/write which rows). It is NOT a technical bug on its
// own. What IS worth double-checking, especially before copying this codebase to run a second,
// independent deployment: every table this app touches (loans, customers, payments, ...) needs
// an RLS policy that actually restricts access appropriately (e.g. to authenticated
// app_user_roles users) — an anon key against a table with RLS disabled, or a too-permissive
// policy, would let anyone with this key read/write that data directly via the REST API,
// bypassing the app entirely. Verify this in Supabase under Authentication > Policies for every
// table before treating this deployment (or any clone of it) as production-ready.
const DEFAULT_SUPABASE_URL = 'https://elspwzalqdwvexjaycsx.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsc3B3emFscWR3dmV4amF5Y3N4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2OTE3NzUsImV4cCI6MjEwNDI2Nzc3NX0.bBFPMgIGPjkvSnUnTaDf34pcRZkR7OV7BYoo-yr6nBg';

function getCloudSettings() {
    const defaults = { supabaseUrl: DEFAULT_SUPABASE_URL, supabaseKey: DEFAULT_SUPABASE_ANON_KEY, telegramToken: '', telegramChatId: '', telegramEnabled: false };
    try {
        const raw = localStorage.getItem(CLOUD_SETTINGS_KEY);
        return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    } catch (e) {
        return defaults;
    }
}

function loadCloudSettingsIntoForm() {
    const s = getCloudSettings();
    const el = id => document.getElementById(id);
    if (!el('cloudSupabaseUrl')) return; // UI not on screen yet
    el('cloudSupabaseUrl').value = s.supabaseUrl || '';
    el('cloudSupabaseKey').value = s.supabaseKey || '';
    el('cloudTelegramToken').value = s.telegramToken || '';
    el('cloudTelegramChatId').value = s.telegramChatId || '';
    el('cloudTelegramEnabled').checked = !!s.telegramEnabled;
    updateCloudSyncStatusUI();
}

async function saveCloudSettingsFromForm() {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const el = id => document.getElementById(id);
    const settings = {
        supabaseUrl: el('cloudSupabaseUrl').value.trim().replace(/\/+$/, ''),
        supabaseKey: el('cloudSupabaseKey').value.trim(),
        telegramToken: el('cloudTelegramToken').value.trim(),
        telegramChatId: el('cloudTelegramChatId').value.trim(),
        telegramEnabled: el('cloudTelegramEnabled').checked
    };
    localStorage.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(settings));
    updateCloudSyncStatusUI();
    showToast('រក្សាទុកការកំណត់បានជោគជ័យ! សូម Refresh ទំព័រ ដើម្បីភ្ជាប់ទៅ Project ថ្មី', 'success');
}

function updateCloudSyncStatusUI() {
    const statusEl = document.getElementById('cloudSyncStatusText');
    if (!statusEl) return;
    const s = getCloudSettings();
    statusEl.innerHTML = (s.supabaseUrl && s.supabaseKey)
        ? '<span style="color:var(--success,#28a745);"><i class="fas fa-check-circle"></i> ភ្ជាប់ជាមួយ Cloud Database — រាល់ការផ្លាស់ប្តូរត្រូវបានរក្សាទុកដោយស្វ័យប្រវត្តិ</span>'
        : '<span style="color:var(--danger);"><i class="fas fa-times-circle"></i> មិនទាន់កំណត់ Supabase URL/Key ទេ</span>';
}

// ===================== MAINTENANCE MODE =====================
// Shared on/off flag + custom message for the whole system, stored in the same app_settings
// cloud row as the exchange rate (see db.js). Only role 'admin' can still log in / stay logged
// in while it's on — everyone else is turned away in checkAuth() (auth.js) and, for anyone
// already mid-session, kicked out live over Realtime (db.js refreshEntityFromCloud).
function loadMaintenanceSettingsIntoForm() {
    const el = id => document.getElementById(id);
    if (!el('maintenanceModeEnabled')) return; // UI not on screen yet
    el('maintenanceModeEnabled').checked = getCloudMaintenanceMode();
    el('maintenanceMessage').value = getCloudMaintenanceMessage();
}

async function saveMaintenanceModeFromForm() {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const enabled = document.getElementById('maintenanceModeEnabled').checked;
    const message = document.getElementById('maintenanceMessage').value.trim();

    if (enabled && !await customConfirm('ការបើក Maintenance Mode នឹងធ្វើឲ្យអ្នកប្រើប្រាស់ទាំងអស់ (លើកលែងតែ admin) មិនអាចចូល ឬបន្តប្រើប្រព័ន្ធបានទេ រួមទាំងអ្នកដែលកំពុងប្រើប្រាស់ស្រាប់នឹងត្រូវបានដកចេញភ្លាមៗ។\nតើអ្នកប្រាកដទេ?')) {
        return;
    }

    try {
        await saveMaintenanceModeToCloud(enabled, message);
        logChange(null, 'System Event', { event: 'Maintenance Mode Updated', enabled, message });
        showToast(enabled ? 'បានបើក Maintenance Mode!' : 'បានបិទ Maintenance Mode។ អ្នកប្រើប្រាស់អាចចូលបានធម្មតាវិញ។', 'success');
    } catch (e) {
        showToast(`រក្សាទុកបរាជ័យ: ${String((e && e.message) || e)}`, 'error');
    }
}

async function testSupabaseConnection() {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const url = document.getElementById('cloudSupabaseUrl').value.trim().replace(/\/+$/, '');
    const key = document.getElementById('cloudSupabaseKey').value.trim();
    if (!url || !key) { showToast('សូមបំពេញ URL និង Key ជាមុនសិន', 'error'); return; }
    showToast('កំពុងសាកល្បងតភ្ជាប់...', 'info');
    try {
        const session = await ensureSupabaseSession();
        const res = await fetch(`${url}/rest/v1/customers?select=id&limit=1`, {
            headers: { 'apikey': key, 'Authorization': `Bearer ${session?.access_token || key}` }
        });
        if (res.ok) {
            showToast('តភ្ជាប់ទៅ Supabase បានជោគជ័យ! Table រកឃើញត្រឹមត្រូវ។', 'success');
        } else if (res.status === 404 || res.status === 400) {
            showToast('តភ្ជាប់ទៅ Project បាន ប៉ុន្តែរកមិនឃើញ Tables។ សូមរត់ schema.sql ក្នុង Supabase SQL Editor ជាមុនសិន។', 'error');
        } else {
            showToast(`តភ្ជាប់មិនបានជោគជ័យ: HTTP ${res.status}. សូមពិនិត្យ URL/Key.`, 'error');
        }
    } catch (e) {
        showToast('មិនអាចតភ្ជាប់បានទេ។ សូមពិនិត្យ URL និង Internet.', 'error');
        console.error(e);
    }
}

async function notifyTelegram(message) {
    const s = getCloudSettings();
    if (!s.telegramEnabled || !s.telegramToken || !s.telegramChatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: s.telegramChatId, text: message, parse_mode: 'HTML' })
        });
    } catch (e) {
        console.error('Telegram notify error:', e);
    }
}

async function testTelegramConnection() {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const token = document.getElementById('cloudTelegramToken').value.trim();
    const chatId = document.getElementById('cloudTelegramChatId').value.trim();
    if (!token || !chatId) { showToast('សូមបំពេញ Bot Token និង Chat ID ជាមុនសិន', 'error'); return; }
    showToast('កំពុងផ្ញើសារសាកល្បង...', 'info');
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '✅ ការតភ្ជាប់ Telegram ជោគជ័យ! (ប្រព័ន្ធគ្រប់គ្រងកម្ចី)', parse_mode: 'HTML' })
        });
        const data = await res.json();
        if (data.ok) { showToast('ផ្ញើសារ Telegram ជោគជ័យ! សូមពិនិត្យ Chat របស់អ្នក។', 'success'); }
        else { showToast(`ផ្ញើសារបរាជ័យ: ${data.description || 'Unknown error'}`, 'error'); }
    } catch (e) {
        showToast('មិនអាចភ្ជាប់ទៅ Telegram API បានទេ។', 'error');
        console.error(e);
    }
}

// ===================== HARD RESET =====================
// Wiping the CLOUD database (every officer's real data) from a single button in the browser,
// with only a typed confirmation phrase standing in the way, is too dangerous to wire up
// automatically for a system holding real loan/customer records — a mistaken click here would
// be a production data-loss incident, not a "clear my browser" inconvenience like it used to be.
// This now only clears this browser's own local connection settings/session; deleting the
// actual cloud data is left as a deliberate action in the Supabase Dashboard / SQL Editor,
// where it belongs.
async function hardResetApplication() {
    if (!hasPermission('canManageSystem')) {
        showToast('Permission Denied.', 'error');
        return;
    }
    const confirmation = await customPrompt('សកម្មភាពនេះនឹងផ្ដាច់ browser នេះចេញពី Cloud (លុបការកំណត់ Supabase URL/Key និង Session នៅលើ browser នេះតែប៉ុណ្ណោះ — ទិន្នន័យពិតនៅលើ Cloud មិនត្រូវបានប៉ះពាល់ទេ)។ ដើម្បីលុបទិន្នន័យពិតទាំងស្រុង សូមប្រើ Supabase Dashboard។ វាយ "DISCONNECT" ដើម្បីបញ្ជាក់។');
    if (confirmation === "DISCONNECT") {
        localStorage.removeItem(CLOUD_SETTINGS_KEY);
        clearSupabaseSession();
        showToast('Browser នេះត្រូវបានផ្ដាច់ចេញពី Cloud។ កំពុងផ្ទុកទំព័រឡើងវិញ...', 'success');
        setTimeout(() => location.reload(), 2000);
    } else {
        showToast('Reset cancelled.', 'info');
    }
}
