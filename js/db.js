// =====================================================================
// db.js — Cloud database layer (Supabase Postgres + Storage). This file
// is what makes persistData()/loadData() in utils.js talk to Supabase
// tables instead of localStorage. See schema.sql for the tables this
// expects, and SECURITY NOTE there about RLS.
//
// Everything else in the app (loans.js, customers.js, savings.js, ...)
// is UNCHANGED — it still just calls persistData(LS_KEYS.x, x) and
// loadData(LS_KEYS.x) exactly like before. Only the two functions
// themselves (in utils.js) and this file are new/different.
// =====================================================================

// In-memory mirror of "what's currently loaded" — this is what loadData()
// returns. Populated once at startup by loadAllCloudData(), then kept in
// sync locally every time persistData() is called (so a loadData() right
// after a save sees the fresh value immediately, without waiting on the
// network).
let __cloudCache = {};

// Per-key JSON snapshot of the last state we successfully pushed to
// Supabase, used to work out what changed (added/edited vs. removed) the
// next time persistData() is called for that key, so we only send the
// rows that actually changed instead of re-uploading everything.
let __lastPushedSnapshot = {};

// Per-key debounce timers so rapid-fire persistData() calls (e.g. typing)
// collapse into one network push instead of one per keystroke.
let __pushDebounceTimers = {};
const DB_PUSH_DEBOUNCE_MS = 600;

// Maps each LS_KEYS.* value to the table (and shape) it lives in. Keys not
// listed here are handled elsewhere on purpose (see NOTE below) and are
// simply left out of cloud sync entirely.
//
// NOTE — entities deliberately NOT in this table:
//   users            -> already lives in app_user_roles via
//                        upsertUserRoleProfile/createAppUserViaEdgeFunction/
//                        deleteAppUserViaEdgeFunction (auth.js). The local
//                        "users" cache is in-memory only now (see utils.js).
//   currentUser/loggedIn -> derived fresh from the Supabase Auth session +
//                        profile on every load (see checkAuth() in auth.js).
//   loanIdCounter    -> replaced by the next_loan_id() RPC (atomic, avoids
//                        two officers getting the same loan number).
//   savingsIdCounter -> never actually persisted even in the old code
//                        (it's derived by counting existing accounts).
//   theme            -> folded into app_user_roles.theme_preference.
function getEntityConfig(key) {
  const map = {
    [LS_KEYS.customers]:          { table: 'customers',            shape: 'array' },
    [LS_KEYS.loans]:              { table: 'loans',                 shape: 'array', pk: 'loanId', pkColumn: 'loan_id' },
    [LS_KEYS.refinances]:         { table: 'refinances',            shape: 'array' },
    [LS_KEYS.holidays]:           { table: 'holidays',              shape: 'array' },
    [LS_KEYS.collaterals]:        { table: 'collaterals',           shape: 'array', extra: row => ({ loan_id: row.loanId || null }) },
    [LS_KEYS.guarantors]:         { table: 'guarantors',            shape: 'array', extra: row => ({ loan_id: row.loanId || null }) },
    [LS_KEYS.expenses]:           { table: 'expenses',              shape: 'array' },
    [LS_KEYS.notifications]:      { table: 'notifications',         shape: 'array' },
    [LS_KEYS.loanProducts]:       { table: 'loan_products',         shape: 'array' },
    [LS_KEYS.savingsAccounts]:    { table: 'savings_accounts',      shape: 'array' },

    [LS_KEYS.payments]:           { table: 'partial_payments',      shape: 'keyed-pair', parentColumn: 'loan_id' },
    [LS_KEYS.savingsPayments]:    { table: 'savings_deposits',      shape: 'keyed-pair', parentColumn: 'account_id' },
    [LS_KEYS.savingsWithdrawals]: { table: 'savings_withdrawals',   shape: 'keyed-single', parentColumn: 'account_id' },
    [LS_KEYS.loanHistory]:        { table: 'loan_history',          shape: 'history' },
  };
  return map[key] || null;
}

// ---------------------------------------------------------------------
// Low-level REST helpers (reuse the same Supabase URL/Key + session that
// auth.js and cloud-sync.js already manage — no new configuration needed)
// ---------------------------------------------------------------------
async function dbContext() {
  const { url, key } = getSupabaseAuthConfig();
  if (!url || !key) throw new Error('Supabase URL/Key មិនទាន់កំណត់ទេ (សូមចូល Admin > Cloud Sync)');
  const session = await ensureSupabaseSession();
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${session?.access_token || key}`
    }
  };
}

async function dbSelectAll(table, extraQuery = '') {
  const { url, headers } = await dbContext();
  const res = await fetch(`${url}/rest/v1/${table}?select=*${extraQuery}`, { headers });
  if (!res.ok) throw new Error(`DB select "${table}" failed: HTTP ${res.status}`);
  return res.json();
}

async function dbUpsertRows(table, rows) {
  if (!rows.length) return;
  const { url, headers } = await dbContext();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`DB upsert "${table}" failed: HTTP ${res.status}: ${await res.text().catch(() => '')}`);
}

async function dbDeleteRows(table, pkColumn, values) {
  if (!values.length) return;
  const { url, headers } = await dbContext();
  const inList = values.map(v => encodeURIComponent(v)).join(',');
  const res = await fetch(`${url}/rest/v1/${table}?${pkColumn}=in.(${inList})`, { method: 'DELETE', headers });
  if (!res.ok) throw new Error(`DB delete "${table}" failed: HTTP ${res.status}`);
}

async function dbRpc(fnName, args) {
  const { url, headers } = await dbContext();
  const res = await fetch(`${url}/rest/v1/rpc/${fnName}`, { method: 'POST', headers, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`RPC "${fnName}" failed: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------
// Bootstrap: fetch every entity from Supabase ONCE at app start, and
// populate __cloudCache so loadData() can return it synchronously from
// then on. Call this (awaited) before initApp() runs.
// ---------------------------------------------------------------------
// Real business logic throughout the app (loans.js, customers.js, ...) reads/writes the actual
// top-level globals (`loans`, `customers`, `payments`, ...) directly — not __cloudCache. Those
// globals get their first value from loadData() at startup (main.js), but when a LIVE update
// arrives later (see the Realtime section below) we need to update the *same* global variables
// in place, not just __cloudCache, or the screens reading them would never see the change. Since
// every <script> tag on this page shares one global scope, a plain assignment here really does
// reach the `let loans = []` declared back in config.js.
function assignGlobal(key, value) {
  __cloudCache[key] = value;
  switch (key) {
    case LS_KEYS.customers: customers = value; break;
    case LS_KEYS.loans: loans = value; break;
    case LS_KEYS.refinances: refinances = value; break;
    case LS_KEYS.holidays: holidays = value; break;
    case LS_KEYS.collaterals: collaterals = value; break;
    case LS_KEYS.guarantors: guarantors = value; break;
    case LS_KEYS.expenses: expenses = value; break;
    case LS_KEYS.notifications: notifications = value; break;
    case LS_KEYS.loanProducts: loanProducts = value; break;
    case LS_KEYS.savingsAccounts: savingsAccounts = value; break;
    case LS_KEYS.payments: payments = value; break;
    case LS_KEYS.savingsPayments: savingsPayments = value; break;
    case LS_KEYS.savingsWithdrawals: savingsWithdrawals = value; break;
    case LS_KEYS.loanHistory: loanHistory = value; break;
    case LS_KEYS.appSettings: appSettings = value; break;
  }
}

async function loadAllCloudData() {
  const arrayKeys = [
    LS_KEYS.customers, LS_KEYS.loans, LS_KEYS.refinances, LS_KEYS.holidays,
    LS_KEYS.collaterals, LS_KEYS.guarantors, LS_KEYS.expenses,
    LS_KEYS.notifications, LS_KEYS.loanProducts, LS_KEYS.savingsAccounts
  ];

  await Promise.all(arrayKeys.map(async key => {
    const cfg = getEntityConfig(key);
    try {
      const rows = await dbSelectAll(cfg.table);
      const arr = rows.map(r => r.data);
      assignGlobal(key, arr);
      __lastPushedSnapshot[key] = snapshotArray(arr, cfg);
    } catch (e) {
      console.error(`Could not load "${cfg.table}" from Supabase:`, e);
      assignGlobal(key, []);
    }
  }));

  await loadKeyedPairEntity(LS_KEYS.payments);
  await loadKeyedPairEntity(LS_KEYS.savingsPayments);
  await loadKeyedSingleEntity(LS_KEYS.savingsWithdrawals);
  await loadHistoryEntity(LS_KEYS.loanHistory);
  await loadAppSettingsEntity();
}

function snapshotArray(arr, cfg) {
  const pk = cfg.pk || 'id';
  const snap = {};
  arr.forEach(o => { if (o && o[pk] != null) snap[o[pk]] = JSON.stringify(o); });
  return snap;
}

async function loadKeyedPairEntity(key) {
  const cfg = getEntityConfig(key);
  try {
    const rows = await dbSelectAll(cfg.table);
    const obj = {};
    rows.forEach(r => {
      const parentId = r[cfg.parentColumn];
      const paymentKey = `${parentId}-${r.installment_index}`;
      if (!obj[paymentKey]) obj[paymentKey] = [];
      obj[paymentKey].push(r.data);
    });
    assignGlobal(key, obj);
    __lastPushedSnapshot[key] = snapshotKeyedRows(rows);
  } catch (e) {
    console.error(`Could not load "${cfg.table}" from Supabase:`, e);
    assignGlobal(key, {});
  }
}

async function loadKeyedSingleEntity(key) {
  const cfg = getEntityConfig(key);
  try {
    const rows = await dbSelectAll(cfg.table);
    const obj = {};
    rows.forEach(r => {
      const parentId = r[cfg.parentColumn];
      if (!obj[parentId]) obj[parentId] = [];
      obj[parentId].push(r.data);
    });
    assignGlobal(key, obj);
    __lastPushedSnapshot[key] = snapshotKeyedRows(rows);
  } catch (e) {
    console.error(`Could not load "${cfg.table}" from Supabase:`, e);
    assignGlobal(key, {});
  }
}

function snapshotKeyedRows(rows) {
  const snap = {};
  rows.forEach(r => { snap[r.id] = JSON.stringify(r.data); });
  return snap;
}

async function loadHistoryEntity(key) {
  try {
    const rows = await dbSelectAll('loan_history');
    const obj = {};
    rows.forEach(r => {
      const groupKey = r.loan_id || 'system';
      if (!obj[groupKey]) obj[groupKey] = [];
      obj[groupKey].push(r.data);
    });
    // newest-first, matching the old unshift()-based ordering
    Object.values(obj).forEach(list => list.sort((a, b) => new Date(b.ts) - new Date(a.ts)));
    assignGlobal(key, obj);
    __lastPushedSnapshot[key] = new Set(rows.map(r => r.id)); // history is append-only: we only ever need to know what's already there
  } catch (e) {
    console.error('Could not load "loan_history" from Supabase:', e);
    assignGlobal(key, {});
    __lastPushedSnapshot[key] = new Set();
  }
}

async function loadAppSettingsEntity() {
  try {
    const rows = await dbSelectAll('app_settings', '&id=eq.main');
    const row = rows[0] || {};
    assignGlobal(LS_KEYS.appSettings, {
      expenseCategories: row.expense_categories || undefined,
      messageTemplates: row.message_templates || undefined
    });
    // exchange rate + migration version travel in the same row but are
    // read via their own small helpers below, not through loadData().
    __appSettingsRowCache = row;
  } catch (e) {
    console.error('Could not load "app_settings" from Supabase:', e);
    assignGlobal(LS_KEYS.appSettings, {});
    __appSettingsRowCache = {};
  }
}
let __appSettingsRowCache = {};

function getCloudExchangeRate() { return __appSettingsRowCache.exchange_rate ?? null; }
function getCloudExchangeRateDate() { return __appSettingsRowCache.exchange_rate_date ?? null; }
function getCloudMigrationVersion() { return __appSettingsRowCache.migration_version ?? 0; }
function getCloudMaintenanceMode() { return !!__appSettingsRowCache.maintenance_mode; }
function getCloudMaintenanceMessage() { return __appSettingsRowCache.maintenance_message || ''; }

async function saveExchangeRateToCloud(rate, dateStr) {
  __appSettingsRowCache.exchange_rate = rate;
  __appSettingsRowCache.exchange_rate_date = dateStr;
  try {
    await dbUpsertRows('app_settings', [{ id: 'main', exchange_rate: rate, exchange_rate_date: dateStr }]);
  } catch (e) { console.error('Could not save exchange rate to cloud:', e); }
}

// Unlike the other app_settings writers here, this one re-throws on failure instead of just
// logging — the admin flipping this switch needs to know for sure whether it actually took,
// since silently failing to turn it off would leave every non-admin locked out with no feedback.
async function saveMaintenanceModeToCloud(enabled, message) {
  const prevMode = __appSettingsRowCache.maintenance_mode;
  const prevMessage = __appSettingsRowCache.maintenance_message;
  __appSettingsRowCache.maintenance_mode = enabled;
  __appSettingsRowCache.maintenance_message = message;
  try {
    await dbUpsertRows('app_settings', [{ id: 'main', maintenance_mode: enabled, maintenance_message: message }]);
  } catch (e) {
    __appSettingsRowCache.maintenance_mode = prevMode;
    __appSettingsRowCache.maintenance_message = prevMessage;
    console.error('Could not save maintenance mode to cloud:', e);
    throw e;
  }
}

async function saveMigrationVersionToCloud(version) {
  __appSettingsRowCache.migration_version = version;
  try {
    await dbUpsertRows('app_settings', [{ id: 'main', migration_version: version }]);
  } catch (e) { console.error('Could not save migration version to cloud:', e); }
}


// ---------------------------------------------------------------------
// Push: called by persistData() every time an entity's in-memory array
// changes. Diffs against the last-pushed snapshot so only what actually
// changed goes over the wire, debounced per key.
// ---------------------------------------------------------------------
function scheduleCloudPush(key, data) {
  __cloudCache[key] = data;
  clearTimeout(__pushDebounceTimers[key]);
  __pushDebounceTimers[key] = setTimeout(() => pushEntity(key, data).catch(e => {
    console.error(`Cloud sync failed for "${key}":`, e);
    showToast(`មិនអាចរក្សាទុកលើ Cloud បានទេ (${key}) — សូមពិនិត្យការតភ្ជាប់អ៊ីនធឺណិត`, 'error');
  }), DB_PUSH_DEBOUNCE_MS);
}

async function pushEntity(key, data) {
  const cfg = getEntityConfig(key);
  if (!cfg) return; // not a cloud-synced entity (users/session/theme/etc — handled elsewhere)

  if (cfg.shape === 'array') return pushArrayEntity(key, data, cfg);
  if (cfg.shape === 'keyed-pair') return pushKeyedPairEntity(key, data, cfg);
  if (cfg.shape === 'keyed-single') return pushKeyedSingleEntity(key, data, cfg);
  if (cfg.shape === 'history') return pushHistoryEntity(key, data);
}

async function pushArrayEntity(key, arr, cfg) {
  const pk = cfg.pk || 'id';
  const pkColumn = cfg.pkColumn || pk;
  const prevSnapshot = __lastPushedSnapshot[key] || {};
  const nextSnapshot = {};
  const rowsToUpsert = [];

  arr.forEach(obj => {
    if (!obj || obj[pk] == null) return;
    const pkValue = String(obj[pk]);
    const json = JSON.stringify(obj);
    nextSnapshot[pkValue] = json;
    if (prevSnapshot[pkValue] !== json) {
      const row = { [pkColumn]: pkValue, data: obj };
      if (cfg.extra) Object.assign(row, cfg.extra(obj));
      rowsToUpsert.push(row);
    }
  });

  const removedIds = Object.keys(prevSnapshot).filter(id => !(id in nextSnapshot));

  if (rowsToUpsert.length) await dbUpsertRows(cfg.table, rowsToUpsert);
  if (removedIds.length) await dbDeleteRows(cfg.table, pkColumn, removedIds);

  __lastPushedSnapshot[key] = nextSnapshot;
}

// payments / savingsPayments: keyed by `${parentId}-${installmentIndex}` -> array of records
async function pushKeyedPairEntity(key, obj, cfg) {
  const prevSnapshot = __lastPushedSnapshot[key] || {};
  const nextSnapshot = {};
  const rowsToUpsert = [];

  Object.entries(obj).forEach(([pairKey, records]) => {
    const sep = pairKey.lastIndexOf('-');
    const parentId = pairKey.slice(0, sep);
    const installmentIndex = parseInt(pairKey.slice(sep + 1), 10);
    (records || []).forEach(record => {
      if (!record || record.id == null) return;
      const json = JSON.stringify(record);
      nextSnapshot[record.id] = json;
      if (prevSnapshot[record.id] !== json) {
        rowsToUpsert.push({
          id: record.id,
          [cfg.parentColumn]: parentId,
          installment_index: installmentIndex,
          data: record
        });
      }
    });
  });

  const removedIds = Object.keys(prevSnapshot).filter(id => !(id in nextSnapshot));
  if (rowsToUpsert.length) await dbUpsertRows(cfg.table, rowsToUpsert);
  if (removedIds.length) await dbDeleteRows(cfg.table, 'id', removedIds);
  __lastPushedSnapshot[key] = nextSnapshot;
}

// savingsWithdrawals: keyed directly by accountId -> array of records
async function pushKeyedSingleEntity(key, obj, cfg) {
  const prevSnapshot = __lastPushedSnapshot[key] || {};
  const nextSnapshot = {};
  const rowsToUpsert = [];

  Object.entries(obj).forEach(([parentId, records]) => {
    (records || []).forEach(record => {
      if (!record || record.id == null) return;
      const json = JSON.stringify(record);
      nextSnapshot[record.id] = json;
      if (prevSnapshot[record.id] !== json) {
        rowsToUpsert.push({ id: record.id, [cfg.parentColumn]: parentId, data: record });
      }
    });
  });

  const removedIds = Object.keys(prevSnapshot).filter(id => !(id in nextSnapshot));
  if (rowsToUpsert.length) await dbUpsertRows(cfg.table, rowsToUpsert);
  if (removedIds.length) await dbDeleteRows(cfg.table, 'id', removedIds);
  __lastPushedSnapshot[key] = nextSnapshot;
}

// loanHistory: append-only audit log, keyed by loanId (or 'system') -> array of entries.
// Entries never change or get deleted once written, so we only ever INSERT new ones —
// we track "already-pushed" as a Set of synthetic ids (loanId/system + index isn't stable
// across reloads, so instead we key on a hash of the entry content).
async function pushHistoryEntity(key, obj) {
  const alreadyPushed = __lastPushedSnapshot[key] || new Set();
  const rowsToInsert = [];
  const stillPresent = new Set();

  Object.entries(obj).forEach(([groupKey, entries]) => {
    const loanId = groupKey === 'system' ? null : groupKey;
    (entries || []).forEach(entry => {
      const fingerprint = `${groupKey}|${entry.ts}|${entry.action}`;
      stillPresent.add(fingerprint);
      if (!alreadyPushed.has(fingerprint)) {
        rowsToInsert.push({ loan_id: loanId, data: entry });
      }
    });
  });

  if (rowsToInsert.length) {
    const { url, headers } = await dbContext();
    const res = await fetch(`${url}/rest/v1/loan_history`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(rowsToInsert)
    });
    if (!res.ok) throw new Error(`DB insert "loan_history" failed: HTTP ${res.status}`);
  }
  __lastPushedSnapshot[key] = stillPresent;
}

// app_settings (expenseCategories / messageTemplates sub-object)
function scheduleAppSettingsPush(appSettingsObj) {
  clearTimeout(__pushDebounceTimers[LS_KEYS.appSettings]);
  __pushDebounceTimers[LS_KEYS.appSettings] = setTimeout(async () => {
    try {
      await dbUpsertRows('app_settings', [{
        id: 'main',
        expense_categories: appSettingsObj.expenseCategories || [],
        message_templates: appSettingsObj.messageTemplates || []
      }]);
    } catch (e) {
      console.error('Cloud sync failed for app_settings:', e);
      showToast('មិនអាចរក្សាទុកការកំណត់លើ Cloud បានទេ', 'error');
    }
  }, DB_PUSH_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------
// Loan attachments (Supabase Storage bucket "loan-attachments" + the
// loan_attachments metadata table). Replaces the old IndexedDB store.
// ---------------------------------------------------------------------
async function cloudUploadLoanAttachment(loanId, file) {
  const { url, headers } = await dbContext();
  const path = `${loanId}/${Date.now()}-${file.name}`;
  const uploadRes = await fetch(`${url}/storage/v1/object/loan-attachments/${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { apikey: headers.apikey, Authorization: headers.Authorization, 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  if (!uploadRes.ok) throw new Error(`Upload failed: HTTP ${uploadRes.status}`);
  await dbUpsertRows('loan_attachments', [{
    loan_id: loanId, file_name: file.name, file_type: file.type, storage_path: path,
    created_by: currentUser ? currentUser.username : null
  }]);
}

async function cloudListLoanAttachments(loanId) {
  return dbSelectAll('loan_attachments', `&loan_id=eq.${encodeURIComponent(loanId)}&order=created_at.desc`);
}

async function cloudGetLoanAttachmentUrl(storagePath) {
  const { url, headers } = await dbContext();
  const res = await fetch(`${url}/storage/v1/object/sign/loan-attachments/${encodeURIComponent(storagePath)}`, {
    method: 'POST', headers, body: JSON.stringify({ expiresIn: 300 })
  });
  if (!res.ok) throw new Error(`Could not sign file URL: HTTP ${res.status}`);
  const body = await res.json();
  return `${url}/storage/v1${body.signedURL}`;
}

async function cloudDeleteLoanAttachment(attachmentId, storagePath) {
  const { url, headers } = await dbContext();
  await fetch(`${url}/storage/v1/object/loan-attachments/${encodeURIComponent(storagePath)}`, { method: 'DELETE', headers });
  await dbDeleteRows('loan_attachments', 'id', [attachmentId]);
}

// ---------------------------------------------------------------------
// Customer documents (Supabase Storage bucket "customer-documents" +
// the customer_documents metadata table). Replaces the old IndexedDB store.
// ---------------------------------------------------------------------
async function cloudUploadCustomerDocument(customerId, file, category) {
  const { url, headers } = await dbContext();
  const path = `${customerId}/${Date.now()}-${file.name}`;
  const uploadRes = await fetch(`${url}/storage/v1/object/customer-documents/${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { apikey: headers.apikey, Authorization: headers.Authorization, 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  if (!uploadRes.ok) throw new Error(`Upload failed: HTTP ${uploadRes.status}`);
  await dbUpsertRows('customer_documents', [{
    customer_id: customerId, file_name: file.name, file_type: file.type, category: category || null,
    storage_path: path, created_by: currentUser ? currentUser.username : null
  }]);
  return path;
}

async function cloudListCustomerDocuments(customerId) {
  return dbSelectAll('customer_documents', `&customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc`);
}

async function cloudGetCustomerDocumentUrl(storagePath) {
  const { url, headers } = await dbContext();
  const res = await fetch(`${url}/storage/v1/object/sign/customer-documents/${encodeURIComponent(storagePath)}`, {
    method: 'POST', headers, body: JSON.stringify({ expiresIn: 300 })
  });
  if (!res.ok) throw new Error(`Could not sign file URL: HTTP ${res.status}`);
  const body = await res.json();
  return `${url}/storage/v1${body.signedURL}`;
}

async function cloudDeleteCustomerDocument(docId, storagePath) {
  const { url, headers } = await dbContext();
  await fetch(`${url}/storage/v1/object/customer-documents/${encodeURIComponent(storagePath)}`, { method: 'DELETE', headers });
  await dbDeleteRows('customer_documents', 'id', [docId]);
}

// =====================================================================
// LIVE SYNC (Supabase Realtime) — pushes other people's changes to this
// browser over a WebSocket, without needing to refresh the page.
//
// Everything above this point (loadAllCloudData, persistData/scheduleCloudPush, ...) uses plain
// fetch() calls to Supabase's REST API — no extra library needed. Realtime is different: it's a
// WebSocket protocol, and hand-rolling that is a lot of surface area to get right for something
// this size. So JUST for this feature, the app also loads Supabase's own small JS client
// (@supabase/supabase-js, via CDN in index.html) and uses ONLY its realtime piece — every actual
// read/write of data still goes through our own db.js functions above, unchanged.
//
// SCOPE: when a change comes in for a table, we re-fetch just that table (debounced, so a burst
// of edits collapses into one fetch) and update the same in-memory globals everything else
// already reads. We then refresh only READ-ONLY list/dashboard views that are safe to redraw
// silently. We deliberately do NOT auto-refresh open edit forms (the loan/customer/savings entry
// forms) — overwriting a field someone is actively typing into would be worse than making them
// refresh manually. loan_history (the audit log) is also excluded — see schema.sql for why.
//
// KNOWN LIMITATION: the realtime connection is authenticated once, when it's opened, using the
// session token at that moment. If someone leaves a tab open for a very long time and their
// session token is refreshed in the background (see ensureSupabaseSession), the realtime socket
// itself doesn't automatically pick up the new token. In practice Supabase's client reconnects
// the socket on its own fairly readily, and simply reloading the page (which most people do at
// least once a day) re-authenticates it — but this isn't bulletproof for multi-day, never-closed
// tabs.

let __realtimeClient = null;
let __realtimeChannel = null;
let __realtimeRefreshTimers = {};
const REALTIME_DEBOUNCE_MS = 800;

const REALTIME_WATCHED_TABLES = [
  'customers', 'loans', 'partial_payments', 'refinances', 'holidays',
  'collaterals', 'guarantors', 'expenses', 'notifications', 'loan_products',
  'savings_accounts', 'savings_deposits', 'savings_withdrawals', 'app_settings',
  'app_user_roles'
];

async function initRealtimeSync() {
  if (typeof supabase === 'undefined' || typeof supabase.createClient !== 'function') {
    console.warn('Supabase JS client (for live sync) did not load — falling back to refresh-to-see-updates.');
    return;
  }
  const { url, key } = getSupabaseAuthConfig();
  if (!url || !key) return;

  teardownRealtimeSync(); // avoid stacking duplicate subscriptions across repeated logins in one tab

  const session = await ensureSupabaseSession();
  __realtimeClient = supabase.createClient(url, key);
  if (session?.access_token) {
    try { __realtimeClient.realtime.setAuth(session.access_token); } catch (e) { console.error('Realtime setAuth failed:', e); }
  }

  __realtimeChannel = __realtimeClient.channel('lms-live-sync');
  REALTIME_WATCHED_TABLES.forEach(table => {
    __realtimeChannel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
      scheduleRealtimeRefresh(table);
    });
  });
  __realtimeChannel.subscribe(status => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.error('Live sync connection issue:', status);
    }
  });
}

function teardownRealtimeSync() {
  if (__realtimeChannel && __realtimeClient) {
    try { __realtimeClient.removeChannel(__realtimeChannel); } catch (e) {}
  }
  __realtimeChannel = null;
  Object.values(__realtimeRefreshTimers).forEach(clearTimeout);
  __realtimeRefreshTimers = {};
}

function scheduleRealtimeRefresh(table) {
  clearTimeout(__realtimeRefreshTimers[table]);
  __realtimeRefreshTimers[table] = setTimeout(() => refreshEntityFromCloud(table), REALTIME_DEBOUNCE_MS);
}

const REALTIME_TABLE_TO_KEY = {
  customers: LS_KEYS.customers, loans: LS_KEYS.loans, refinances: LS_KEYS.refinances,
  holidays: LS_KEYS.holidays, collaterals: LS_KEYS.collaterals, guarantors: LS_KEYS.guarantors,
  expenses: LS_KEYS.expenses, notifications: LS_KEYS.notifications, loan_products: LS_KEYS.loanProducts,
  savings_accounts: LS_KEYS.savingsAccounts
};

async function refreshEntityFromCloud(table) {
  try {
    if (table === 'app_settings') {
      await loadAppSettingsEntity();
      updateExchangeUI();
      // Live kick-out: an admin can flip Maintenance Mode on while a non-admin's tab is already
      // open and mid-session — this is what catches that case instantly via Realtime, rather
      // than waiting for their next page load / checkAuth() to notice.
      if (getCloudMaintenanceMode() && currentUser && currentUser.role !== 'admin') {
        showMaintenanceBlockedMessage();
        logout();
        return;
      }
    } else if (table === 'app_user_roles') {
      await refreshUsersCache();
    } else if (table === 'partial_payments') {
      await loadKeyedPairEntity(LS_KEYS.payments);
    } else if (table === 'savings_deposits') {
      await loadKeyedPairEntity(LS_KEYS.savingsPayments);
    } else if (table === 'savings_withdrawals') {
      await loadKeyedSingleEntity(LS_KEYS.savingsWithdrawals);
    } else {
      const key = REALTIME_TABLE_TO_KEY[table];
      const cfg = getEntityConfig(key);
      const rows = await dbSelectAll(cfg.table);
      const arr = rows.map(r => r.data);
      assignGlobal(key, arr);
      __lastPushedSnapshot[key] = snapshotArray(arr, cfg);
    }
  } catch (e) {
    console.error(`Live refresh failed for "${table}":`, e);
    return;
  }
  refreshVisibleUI();
}

// Re-draws only the currently-visible READ-ONLY screen (list/table/dashboard), never an open
// entry form — see the SCOPE note above.
function refreshVisibleUI() {
  try {
    const activeTab = document.querySelector('.tab-content.active');
    switch (activeTab && activeTab.id) {
      case 'loansTab': displayLoans(); break;
      case 'dashboardTab': renderDashboard(); break;
      case 'customersTab': renderCustomersListTable(); break;
      case 'clientAccountTab': renderClientAccountView(); break;
      case 'collectionsTab': renderCollectionsTable(); break;
      case 'savingsTab': displaySavingsAccounts(); break;
      case 'analysisTab': renderAnalysisCharts(); break;
      case 'expensesTab': renderExpensesTable(); break;
    }
  } catch (e) {
    console.error('Live UI refresh failed:', e);
  }
  // Safe and worth doing regardless of which tab is open (it re-renders the bell itself).
  try { generateNotifications(); } catch (e) {}
}

// ---------------------------------------------------------------------
// Atomic loan-ID generation via the next_loan_id() RPC (see schema.sql)
// ---------------------------------------------------------------------
async function cloudNextLoanId(year) {
  return dbRpc('next_loan_id', { p_year: year });
}

