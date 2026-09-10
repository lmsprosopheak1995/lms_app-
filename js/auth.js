// =====================================================================
// auth.js — Login/logout, Supabase Auth session handling, user management (CRUD), inactivity/PIN lock.
// =====================================================================

// ===================== INACTIVITY LOCK =====================
function lockSession() {
    const pinOverlay = document.getElementById('pinLockOverlay');
    if (currentUser && currentUser.pin && pinOverlay.style.display === 'none') {
        pinOverlay.style.display = 'flex';
        document.getElementById('pinInput').value = '';
        document.getElementById('pinInput').focus();
    }
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(lockSession, INACTIVITY_TIMEOUT);
}

function checkPin() {
    const pinInput = document.getElementById('pinInput').value;
    if (currentUser && pinInput === currentUser.pin) {
        document.getElementById('pinLockOverlay').style.display = 'none';
        resetInactivityTimer();
    } else {
        showToast('Incorrect PIN.', 'error');
        document.getElementById('pinInput').value = '';
    }
}


// ===================== SECURITY & USER MANAGEMENT =====================
// User accounts (login credentials, role, PIN, avatar, theme) live entirely in Supabase —
// the app_user_roles table plus Supabase Auth itself — via upsertUserRoleProfile() /
// createAppUserViaEdgeFunction() / deleteAppUserViaEdgeFunction() below. `__usersMemoryCache`
// is just an in-memory (never localStorage) copy of the last fetch, kept around so screens
// like the officer dropdown or avatar lookups don't need a network round-trip on every render.
// It's refreshed from Supabase whenever renderUsersTable() runs (Admin > Users tab) or right
// after login.
let __usersMemoryCache = [];
function getUsers() { return __usersMemoryCache; }
function setUsersCache(users) { __usersMemoryCache = users; }
// Set only while the user-edit form is open, by showUserForm() below — holds the ONE full
// row (including pin) an admin is currently editing, fetched directly from app_user_roles
// rather than from the shared roster. See the comment on refreshUsersCache() for why.
let __editingUserFullProfile = null;

// Kept as a no-op async function so existing call sites (checkAuth) don't need to change —
// there's nothing left to migrate locally now that accounts are 100% Supabase-backed.
async function initializeUsers() {}

async function showUserForm(username = null) {
  if (!hasPermission('canManageUsers')) return;
  const users = getUsers();
  const user = username ? users.find(u => u.username === username) : null;
  document.getElementById('userAvatarInput').value = '';
  __editingUserFullProfile = null;
  if (user) {
      document.getElementById('userFormTitle').innerHTML = `<i class="fas fa-user-edit"></i> កែប្រែព័ត៌មានអ្នកប្រើប្រាស់`;
      document.getElementById('editUsername').value = user.username;
      document.getElementById('newUsername').value = user.username;
      document.getElementById('newUsername').disabled = true;
      document.getElementById('newUserAuthHint').style.display = 'none';
      document.getElementById('newUserPasswordField').style.display = 'none';
      document.getElementById('newUid').value = user.uid || '';
      document.getElementById('newFullName').value = user.fullName;
      document.getElementById('newRole').value = user.role;
      document.getElementById('frozenAccount').checked = user.isFrozen || false;
      document.getElementById('avatarPreview').src = user.avatar || DEFAULT_AVATAR_SRC;
      document.getElementById('userFormCard').style.display = 'block';

      // The shared roster (getUsers(), from the app_user_roster VIEW) never carries `pin` — see
      // refreshUsersCache(). To show/edit THIS one user's PIN, fetch their row from the real
      // table directly instead; RLS allows an admin to read any single row there (see
      // is_admin() in schema.sql), it just no longer hands out every row's PIN to everyone via
      // the bulk roster fetch.
      document.getElementById('newPin').value = '';
      if (user.uid) {
          try {
              __editingUserFullProfile = await fetchUserRoleProfile(user.uid);
              document.getElementById('newPin').value = __editingUserFullProfile?.pin || '';
          } catch (e) {
              console.error('Could not load PIN for editing:', e);
              showToast('មិនអាចទាញយក PIN បានទេ (សូមព្យាយាមម្តងទៀត)', 'error');
          }
      }
  } else {
      document.getElementById('userFormTitle').innerHTML = `<i class="fas fa-user-plus"></i> បន្ថែមអ្នកប្រើប្រាស់ថ្មី`;
      document.getElementById('editUsername').value = '';
      document.getElementById('newUsername').value = '';
      document.getElementById('newUsername').disabled = false;
      document.getElementById('newUserAuthHint').style.display = 'block';
      document.getElementById('newUserPasswordField').style.display = 'block';
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserPassword').type = 'password';
      document.getElementById('newUid').value = '';
      document.getElementById('newPin').value = '1234';
      document.getElementById('newFullName').value = '';
      document.getElementById('newRole').value = 'officer';
      document.getElementById('frozenAccount').checked = false;
      document.getElementById('avatarPreview').src = DEFAULT_AVATAR_SRC;
      document.getElementById('userFormCard').style.display = 'block';
  }
}

function hideUserForm() { document.getElementById('userFormCard').style.display = 'none'; }

async function saveUser() {
  if (!hasPermission('canManageUsers')) return;
  const usernameToEdit = document.getElementById('editUsername').value;
  const newAvatarData = document.getElementById('avatarPreview').src.startsWith('data:image') ? document.getElementById('avatarPreview').src : null;
  const newFullName = document.getElementById('newFullName').value.trim();
  const newRole = document.getElementById('newRole').value;
  const isFrozen = document.getElementById('frozenAccount').checked;
  const newPin = document.getElementById('newPin').value.trim();

  try {
      if (usernameToEdit) {
          // Editing an existing user: update role / PIN / frozen-status / avatar in Supabase.
          // (Their login password lives only in Supabase Auth now — reset it from the Supabase
          // Dashboard, or the user can change it themselves via their Profile menu.)
          const existing = getUsers().find(u => u.username === usernameToEdit);
          if (!existing || !existing.uid) { showToast('រកមិនឃើញ Supabase UID សម្រាប់អ្នកប្រើនេះ សូមបើក Users tab ម្តងទៀតដើម្បី Refresh', 'error'); return; }
          // existing.pin no longer exists (the shared roster excludes it) — fall back to the
          // full row showUserForm() fetched when this edit form was opened.
          const existingPin = __editingUserFullProfile?.pin;
          // Un-freezing here also clears the 3-strikes counter (see record_failed_login() in
          // schema.sql) — otherwise a single further mistyped password would hit 3 again
          // immediately and re-freeze the account the admin just unlocked.
          await upsertUserRoleProfile({
              uid: existing.uid,
              username: usernameToEdit,
              full_name: newFullName,
              role: newRole,
              pin: newPin || existingPin || '1234',
              is_frozen: isFrozen,
              avatar: newAvatarData || existing.avatar || null,
              failed_attempts: isFrozen ? undefined : 0
          });
      } else {
          // New user: the Edge Function creates BOTH the Supabase Auth login (email+password)
          // and this role/PIN profile in one call — no more copying a UID from the Dashboard.
          const newUsername = document.getElementById('newUsername').value.trim();
          const newUserPassword = document.getElementById('newUserPassword').value;
          if (!newUsername || !newFullName || !newUserPassword) { showToast("សូមបំពេញគ្រប់ផ្នែក (រួមទាំងពាក្យសម្ងាត់)", "error"); return; }
          if (newUserPassword.length < 8) { showToast("ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 8 តួអក្សរ", "error"); return; }
          if (getUsers().some(u => u.username === newUsername)) { showToast("ឈ្មោះអ្នកប្រើនេះមានរួចហើយ", "error"); return; }

          await createAppUserViaEdgeFunction({
              username: newUsername,
              password: newUserPassword,
              full_name: newFullName,
              role: newRole,
              pin: newPin || '1234',
              is_frozen: isFrozen,
              avatar: newAvatarData || null
          });
      }

      hideUserForm();
      await renderUsersTable();
      showToast('រក្សាទុកព័ត៌មានបានជោគជ័យ!', 'success');

      const roleLabel = (USER_ROLES[newRole] && USER_ROLES[newRole].name) || newRole;
      notifyTelegram(`${usernameToEdit ? '✏️ <b>គណនីអ្នកប្រើប្រាស់ត្រូវបានកែប្រែ</b>' : '👤 <b>គណនីអ្នកប្រើប្រាស់ថ្មីត្រូវបានបង្កើត</b>'}\nឈ្មោះអ្នកប្រើ: ${usernameToEdit || document.getElementById('newUsername').value.trim()}\nឈ្មោះពេញ: ${newFullName}\nតួនាទី: ${roleLabel}${isFrozen ? '\n🔒 ស្ថានភាព: បានផ្អាក (Frozen)' : ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
  } catch (e) {
      console.error('saveUser error:', e);
      showToast(`រក្សាទុកបរាជ័យ: ${String(e.message || e)}`, 'error');
  }
}

async function deleteUser(username) {
    if (!hasPermission('canManageUsers')) return;
    if (username === currentUser.username) { showToast('មិនអាចលុបគណនីផ្ទាល់ខ្លួនបានទេ', 'error'); return; }

    const loansAssigned = loans.filter(l => l.creditOfficer === username).length;

    if (loansAssigned > 0) {
        const newOfficer = await customPrompt(`${username} មាន ${loansAssigned} កម្ចីដែលបានផ្ដល់ឱ្យ។ សូមបញ្ចូលឈ្មោះអ្នកប្រើប្រាស់របស់មន្ត្រីថ្មីដើម្បីផ្ទេរកម្ចីទាំងនេះទៅ (ត្រូវតែបញ្ចូល)`);
        
        if (newOfficer) {
            const officerExists = getUsers().some(u => u.username === newOfficer && u.username !== username);
            if (officerExists) {
                loans.forEach(loan => {
                    if (loan.creditOfficer === username) {
                        loan.creditOfficer = newOfficer;
                    }
                });
                persistData(LS_KEYS.loans, loans);
                showToast(`កម្ចីត្រូវបានផ្ទេរទៅឱ្យ ${newOfficer}`, 'success');
            } else {
                showToast('រកមិនឃើញមន្ត្រីថ្មី ឬអ្នកបានបញ្ចូលឈ្មោះដដែល។ ការលុបត្រូវបានបោះបង់។', 'error');
                return;
            }
        } else {
            showToast('ការលុបត្រូវបានបោះបង់។ អ្នកត្រូវតែផ្ទេរកម្ចីជាមុនសិន។', 'info');
            return;
        }
    }

    if (await customConfirm(`តើអ្នកប្រាកដទេថាចង់លុបអ្នកប្រើប្រាស់ "${username}"? សកម្មភាពនេះនឹងលុបគណនីចូលប្រព័ន្ធ (email/password) និងទិន្នន័យតួនាទី/PIN ចេញពី Supabase ទាំងស្រុង មិនអាចត្រឡប់វិញបានទេ។`)) {
        try {
            const target = getUsers().find(u => u.username === username);
            if (target?.uid) { await deleteAppUserViaEdgeFunction(target.uid); }
            let users = getUsers();
            users = users.filter(u => u.username !== username);
            setUsersCache(users);
            await renderUsersTable();
            displayLoans();
            showToast(`អ្នកប្រើប្រាស់ ${username} ត្រូវបានលុប។`, 'success');

            notifyTelegram(`🗑️ <b>គណនីអ្នកប្រើប្រាស់ត្រូវបានលុប</b>\nឈ្មោះអ្នកប្រើ: ${username}${target ? `\nឈ្មោះពេញ: ${target.fullName || 'N/A'}` : ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
        } catch (e) {
            console.error('deleteUser error:', e);
            showToast(`ការលុបបរាជ័យ: ${String(e.message || e)}`, 'error');
        }
    }
}


// Pulls the authoritative user list from Supabase into the in-memory cache (see getUsers()).
// Used both by renderUsersTable() (Admin > Users) and once at startup (initApp) — the officer
// roster (Credit Officer dropdowns, filters, ...) needs every user, not just whoever happens to
// have already logged in on this particular browser, and not just when an admin happens to open
// the Users tab. Reads the app_user_roster VIEW (safe columns only) rather than the
// app_user_roles table directly — see fetchUserRoster() above — because EVERY logged-in user
// calls this, regardless of role, so it must never carry pin/failed_attempts. An admin editing
// one specific user's PIN gets it separately, via showUserForm()'s direct per-row fetch.
async function refreshUsersCache() {
  try {
      const remoteProfiles = await fetchUserRoster();
      const mergedUsers = remoteProfiles.map(p => ({
          uid: p.uid, username: p.username, fullName: p.full_name, role: p.role,
          isFrozen: !!p.is_frozen, avatar: p.avatar || null, createdAt: p.created_at
      }));
      setUsersCache(mergedUsers);
  } catch (e) {
      console.error('Could not refresh users list from Supabase, showing cached list:', e);
  }
}

async function renderUsersTable() {
  // Pull the authoritative list from Supabase first (so admins see every user, not just ones who
  // have logged in on this browser). Falls back to the local cache if offline / not configured.
  await refreshUsersCache();
  const users = getUsers();
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = "";
  const fragment = document.createDocumentFragment();
  users.forEach((user, index) => {
      const tr = document.createElement('tr');
      const roleInfo = USER_ROLES[user.role] || USER_ROLES.viewer;
      const statusText = user.isFrozen ? 'បានបង្កក' : 'សកម្ម';
      const isCurrentUser = user.username === currentUser.username;

      const statusCell = `<td class="status-cell"><span class="status-badge ${user.isFrozen ? 'status-unpaid' : 'status-paid'}">${statusText}</span></td>`;
      const actionButtons = `<td class="actions">
          <button class="btn btn-info btn-sm" onclick="showUserForm('${escJsAttr(user.username)}')"><i class="fas fa-edit"></i> កែប្រែ</button>
          <button class="btn btn-warning btn-sm" onclick="resetUserPasswordPrompt('${escJsAttr(user.username)}')"><i class="fas fa-key"></i> ប្តូរពាក្យសម្ងាត់</button>
          <button class="btn btn-danger btn-sm" onclick="deleteUser('${escJsAttr(user.username)}')" ${isCurrentUser ? 'disabled' : ''}><i class="fas fa-trash-alt"></i> លុប</button>
      </td>`;

      tr.innerHTML = `<td><img src="${esc(user.avatar || DEFAULT_AVATAR_SRC)}" class="avatar"></td><td>${index + 1}</td><td>${esc(user.username)}</td><td>${esc(user.fullName)}</td><td><span class="role-badge role-${esc(user.role)}"><i class="${roleInfo.icon}"></i> ${roleInfo.name}</span></td>${statusCell}${actionButtons}`;
      fragment.appendChild(tr);
  });
  tbody.appendChild(fragment);
}

function updatePasswordStrength(password, barId, textId) {
    const bar = document.getElementById(barId);
    const text = document.getElementById(textId);
    let score = 0;
    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    const width = (score / 5) * 100;
    let color = '#dc3545';
    let strengthText = 'ខ្សោយ';
    if (score >= 3) { color = '#fd7e14'; strengthText = 'មធ្យម'; }
    if (score >= 4) { color = '#28a745'; strengthText = 'ខ្លាំង'; }

    bar.style.width = `${width}%`;
    bar.style.backgroundColor = color;
    text.textContent = password.length > 0 ? `កម្លាំង: ${strengthText}` : '';
}
function openProfileModal() {
  document.getElementById('profileFullName').value = currentUser.fullName;
  document.getElementById('profileNewPassword').value = '';
  document.getElementById('profilePin').value = currentUser.pin || '';
  document.getElementById('profileModal').style.display = 'flex';
}
function closeProfileModal() {
  document.getElementById('profileModal').style.display = 'none';
}
async function saveProfile() {
    const newFullName = document.getElementById('profileFullName').value.trim();
    const newPassword = document.getElementById('profileNewPassword').value.trim();
    const newPin = document.getElementById('profilePin').value.trim();

    if (!newFullName) { showToast('ឈ្មោះពេញមិនអាចទទេបានទេ', 'error'); return; }
    if (newPin && (newPin.length !== 4 || !/^\d{4}$/.test(newPin))) {
        showToast('PIN ត្រូវតែជាលេខ 4 ខ្ទង់', 'error'); return;
    }

    try {
        if (newPassword) {
            await supabaseUpdateOwnPassword(newPassword); // changes the real login password in Supabase Auth
        }
        await upsertUserRoleProfile({
            uid: currentUser.uid,
            username: currentUser.username,
            full_name: newFullName,
            role: currentUser.role,
            pin: newPin || currentUser.pin,
            is_frozen: currentUser.isFrozen
        });

        const users = getUsers();
        const userIndex = users.findIndex(u => u.username === currentUser.username);
        if (userIndex > -1) {
            users[userIndex].fullName = newFullName;
            if (newPin) { users[userIndex].pin = newPin; }
            setUsersCache(users);
        }

        currentUser.fullName = newFullName;
        if (newPin) { currentUser.pin = newPin; }
        // currentUser is in-memory only now — Supabase (updated above) is the system of record,
        // and checkAuth() re-derives currentUser from there on every page load.

        updateUserInfoHeader();
        showToast('បានធ្វើបច្ចុប្បន្នភាពប្រវត្តិរូប!', 'success');
        closeProfileModal();
    } catch (e) {
        console.error('saveProfile error:', e);
        showToast(`ធ្វើបច្ចុប្បន្នភាពបរាជ័យ: ${String(e.message || e)}`, 'error');
    }
}

// ===================== SUPABASE AUTH (LOGIN) =====================
// Login now authenticates against Supabase Auth (Authentication > Users in your Supabase project)
// instead of the old local password store. Role / PIN / frozen-status are kept in a Supabase table
// (see USER_ROLES_TABLE) keyed by the Supabase Auth user's UID. Reuses the same Project URL/Key
// already configured above under Cloud Sync.
const AUTH_EMAIL_DOMAIN = 'lms.local';       // username "sopheak" -> auth email "sopheak@lms.local"
const USER_ROLES_TABLE = 'app_user_roles';   // see supabase/schema.sql for the table + RLS definition
const SUPABASE_SESSION_KEY = 'lms_supabaseSession_v1';

function getSupabaseAuthConfig() {
    const s = getCloudSettings();
    return { url: s.supabaseUrl, key: s.supabaseKey };
}

function saveSupabaseSession(session) { try { localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(session)); } catch (e) {} }
function getSupabaseSession() { try { return JSON.parse(localStorage.getItem(SUPABASE_SESSION_KEY) || 'null'); } catch (e) { return null; } }
function clearSupabaseSession() { localStorage.removeItem(SUPABASE_SESSION_KEY); }

// Refreshes the Supabase access token if it's expired (or about to expire). Called before any
// authenticated call to the roles table so long-open sessions don't silently start failing.
async function ensureSupabaseSession() {
    const session = getSupabaseSession();
    if (!session) return null;
    if (session.expires_at && Date.now() < session.expires_at - 60000) return session;
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key || !session.refresh_token) return session;
    try {
        const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': key },
            body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        if (!res.ok) return session;
        const body = await res.json();
        const updated = {
            access_token: body.access_token,
            refresh_token: body.refresh_token || session.refresh_token,
            uid: session.uid,
            expires_at: Date.now() + (body.expires_in || 3600) * 1000
        };
        saveSupabaseSession(updated);
        return updated;
    } catch (e) {
        console.error('Supabase session refresh failed:', e);
        return session;
    }
}

async function supabaseAuthSignIn(email, password) {
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key) throw new Error('សូមកំណត់ Supabase URL/Key (Cloud Sync) ជាមុនសិន');
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': key },
        body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error_description || body?.msg || `HTTP ${res.status}`);
    return body; // { access_token, refresh_token, expires_in, user: { id, ... } }
}

// Lets a logged-in user change their OWN password (self-service; no service_role key needed).
async function supabaseUpdateOwnPassword(newPassword) {
    const { url, key } = getSupabaseAuthConfig();
    const session = await ensureSupabaseSession();
    if (!session?.access_token) throw new Error('គ្មាន Session សូមចូលប្រព័ន្ធម្តងទៀត');
    const res = await fetch(`${url}/auth/v1/user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify({ password: newPassword })
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}: ${t}`); }
    return res.json();
}

async function fetchUserRoleProfile(uid) {
    const { url, key } = getSupabaseAuthConfig();
    const session = await ensureSupabaseSession();
    const res = await fetch(`${url}/rest/v1/${USER_ROLES_TABLE}?uid=eq.${uid}&select=*`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${session?.access_token || key}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    return rows[0] || null;
}

// Full-table fetch (every column, every row this caller's RLS allows). No longer called
// automatically for the general roster (see fetchUserRoster()/refreshUsersCache() above) —
// kept in case a future admin-only feature needs the whole table at once; for admins RLS
// still permits it, for anyone else it now correctly returns only their own row.
async function fetchAllUserRoleProfiles() {
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key) throw new Error('NO_SUPABASE_CONFIG');
    const session = await ensureSupabaseSession();
    const res = await fetch(`${url}/rest/v1/${USER_ROLES_TABLE}?select=*&order=created_at.asc`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${session?.access_token || key}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// RLS on app_user_roles now only lets a row's own owner (or an admin) read that row at all —
// otherwise a plain SELECT * would hand every officer's PIN and failed-login counter to every
// OTHER logged-in officer, since RLS restricts which ROWS you see, not which COLUMNS (see
// schema.sql). Everyone still needs the basic roster (username/name/role/frozen-status) for
// dropdowns though, so that comes from this VIEW instead — it deliberately omits pin and
// failed_attempts from its column list, and runs with the view-owner's privileges so it can
// still show every row (not just the caller's own) despite the table's tighter RLS.
const USER_ROSTER_VIEW = 'app_user_roster'; // see schema.sql
async function fetchUserRoster() {
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key) throw new Error('NO_SUPABASE_CONFIG');
    const session = await ensureSupabaseSession();
    const res = await fetch(`${url}/rest/v1/${USER_ROSTER_VIEW}?select=*&order=created_at.asc`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${session?.access_token || key}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// Creates or updates a user's role/PIN/frozen record. The Supabase Auth account itself (email +
// password) must be created separately (via createAppUserViaEdgeFunction) — this only ever
// UPDATES the app-side profile row for an already-existing uid; it never creates a new row.
//
// This is a real PATCH-by-uid, not an INSERT-based upsert. It used to be
// `POST .../app_user_roles` with `Prefer: resolution=merge-duplicates` (PostgREST upsert), but
// that performs an INSERT ... ON CONFLICT DO UPDATE under the hood — and Postgres validates
// NOT NULL columns (like `username`) while building the row for that INSERT attempt, BEFORE the
// ON CONFLICT branch is even considered. So any partial update that didn't happen to include
// every NOT NULL column (e.g. `{ uid, failed_attempts: 0 }` from login(), or
// `{ uid, theme_preference }` from toggleTheme()) failed with a
// "null value in column ... violates not-null constraint" error, even though the row already
// existed and only needed a couple of fields touched. A PATCH only ever touches the columns it's
// given, so partial updates work correctly regardless of which columns are included.
async function upsertUserRoleProfile(profile) {
    const { url, key } = getSupabaseAuthConfig();
    const session = await ensureSupabaseSession();
    const { uid, ...fields } = profile;
    if (!uid) throw new Error('upsertUserRoleProfile: missing uid');
    const res = await fetch(`${url}/rest/v1/${USER_ROLES_TABLE}?uid=eq.${encodeURIComponent(uid)}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json', 'apikey': key,
            'Authorization': `Bearer ${session?.access_token || key}`,
            'Prefer': 'return=representation'
        },
        body: JSON.stringify(fields)
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}: ${t}`); }
    return res.json();
}

// Deletes a user completely: the Supabase Auth login AND (via DB cascade) its role/PIN
// profile row, via the "delete-app-user" Edge Function. Previously this only removed the
// profile row via a direct DELETE on app_user_roles, leaving the real login behind in
// Supabase Auth (an admin had to finish the job by hand in the Dashboard).
async function deleteAppUserViaEdgeFunction(uid) {
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key) throw new Error('សូមកំណត់ Supabase URL/Key (Cloud Sync) ជាមុនសិន');
    const session = await ensureSupabaseSession();
    if (!session?.access_token) throw new Error('គ្មាន Session សូមចូលប្រព័ន្ធម្តងទៀត');
    const res = await fetch(`${url}/functions/v1/delete-app-user`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', 'apikey': key,
            'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ uid })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
}

// Lets an admin set another user's login password directly (no recovery email needed), via
// the "reset-user-password" Edge Function. Same pattern as create/delete: the browser only
// ever sends its own session token; the Edge Function itself verifies the caller is an admin
// and holds the service_role key server-side.
async function resetUserPasswordViaEdgeFunction(uid, newPassword) {
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key) throw new Error('សូមកំណត់ Supabase URL/Key (Cloud Sync) ជាមុនសិន');
    const session = await ensureSupabaseSession();
    if (!session?.access_token) throw new Error('គ្មាន Session សូមចូលប្រព័ន្ធម្តងទៀត');
    const res = await fetch(`${url}/functions/v1/reset-user-password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', 'apikey': key,
            'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ uid, newPassword })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
}

// UI entry point (called from the "ប្តូរពាក្យសម្ងាត់" button in renderUsersTable): prompts the
// admin for a new password for the given username, then pushes it via the Edge Function above.
async function resetUserPasswordPrompt(username) {
    if (!hasPermission('canManageUsers')) return;
    const user = getUsers().find(u => u.username === username);
    if (!user?.uid) { showToast('រកមិនឃើញ UID', 'error'); return; }

    const newPassword = await customPrompt(`បញ្ចូលពាក្យសម្ងាត់ថ្មីសម្រាប់ ${username} (យ៉ាងតិច 8 តួអក្សរ)`);
    if (!newPassword) return;
    if (newPassword.length < 8) { showToast('ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច 8 តួអក្សរ', 'error'); return; }

    try {
        await resetUserPasswordViaEdgeFunction(user.uid, newPassword);
        showToast(`បានប្តូរពាក្យសម្ងាត់សម្រាប់ ${username} ជោគជ័យ!`, 'success');
    } catch (e) {
        console.error('resetUserPasswordPrompt error:', e);
        showToast(`បរាជ័យ: ${String(e.message || e)}`, 'error');
    }
}

// Creates a brand-new user in one step: the Supabase Auth login (email+password) AND the
// role/PIN profile row, via the "create-app-user" Edge Function (see supabase/functions/).
// That function holds the service_role key server-side — script.js only ever sends the
// caller's own session token, so no privileged key is ever exposed in the browser.
async function createAppUserViaEdgeFunction(payload) {
    const { url, key } = getSupabaseAuthConfig();
    if (!url || !key) throw new Error('សូមកំណត់ Supabase URL/Key (Cloud Sync) ជាមុនសិន');
    const session = await ensureSupabaseSession();
    if (!session?.access_token) throw new Error('គ្មាន Session សូមចូលប្រព័ន្ធម្តងទៀត');
    const res = await fetch(`${url}/functions/v1/create-app-user`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', 'apikey': key,
            'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body; // { uid, username, email }
}

// Generates a random password for the "Add user" form (10 chars, mixed case + digits + symbols).
function generateRandomPassword(length = 10) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
    const arr = new Uint32Array(length);
    crypto.getRandomValues(arr);
    let pwd = '';
    for (let i = 0; i < length; i++) pwd += chars[arr[i] % chars.length];
    return pwd;
}
function generateNewUserPassword() {
    const input = document.getElementById('newUserPassword');
    input.type = 'text';
    input.value = generateRandomPassword();
}
function toggleNewUserPasswordVisibility() {
    const input = document.getElementById('newUserPassword');
    input.type = input.type === 'password' ? 'text' : 'password';
}

// "Am I logged in?" is now answered purely by "does a valid Supabase Auth session exist?" —
// there is no separate lms_loggedIn/lms_currentUser cache anymore. currentUser is rebuilt fresh
// from the Supabase session + the app_user_roles profile every time this runs (page load, or
// after login() calls this directly), which also means a role/PIN/avatar/theme change made by
// an admin elsewhere takes effect the next time this device checks in — not just at next login.
async function checkAuth() {
  await initializeUsers();
  const session = await ensureSupabaseSession();

  if (session && session.access_token) {
      try {
          const profile = await fetchUserRoleProfile(session.uid);
          if (!profile) { showToast('គណនីនេះមិនទាន់មានទិន្នន័យតួនាទី (role) ក្នុង Supabase ទេ។ សូមទាក់ទងអ្នកគ្រប់គ្រង', 'error'); logout(); return; }
          if (profile.is_frozen) { showFrozenAccountMessage(); logout(); return; }

          currentUser = {
              uid: session.uid,
              username: profile.username,
              fullName: profile.full_name,
              role: profile.role || 'viewer',
              pin: profile.pin || '1234',
              isFrozen: !!profile.is_frozen,
              avatar: profile.avatar || null,
              themePreference: profile.theme_preference || 'light'
          };

          // MAINTENANCE MODE: a shared on/off flag + message that lives in the same app_settings
          // cloud row as the exchange rate (see db.js), so it's the same for every officer and
          // updates live over Realtime — no per-browser setting to forget. Only 'admin' bypasses
          // it; every other role is turned away here, both on a fresh login (login() always ends
          // by calling checkAuth(), which is this function) and on every later page load, so a
          // maintenance window an admin turns on while someone is mid-session still applies the
          // next time that tab re-checks auth. The live-kick case (already open tab, mode flipped
          // on right now) is handled separately in db.js's app_settings Realtime handler.
          await loadAppSettingsEntity();
          if (getCloudMaintenanceMode() && currentUser.role !== 'admin') {
              showMaintenanceBlockedMessage();
              logout();
              return;
          }
      } catch (e) {
          // Can't reach Supabase to verify the session (offline, or the token is no longer
          // valid) — since Supabase is now the only place account data lives, there's nothing
          // safe to fall back to. Send the person back to the login screen rather than letting
          // them use the app with stale/unverified permissions.
          console.error('Could not verify session with Supabase:', e);
          logout();
          return;
      }

      document.getElementById("loginSection").style.display = "none"; document.getElementById("appSection").style.display = "block";
      syncStickyHeaderHeight();
      updateUserInfoHeader();
      document.getElementById("adminTabButton").style.display = hasPermission('canManageSystem') ? 'inline-flex' : 'none';
      document.getElementById('exchangeRateInput').readOnly = !hasPermission('canManageSystem');

      await refreshUsersCache(); // full officer roster for Credit Officer dropdowns etc. — not just whoever mirrored in via login() on this browser
      await initApp();
      await initRealtimeSync(); // start receiving other people's changes live from here on
      resetInactivityTimer();
  } else {
      document.getElementById("loginSection").style.display = "block"; document.getElementById("appSection").style.display = "none";
  }
}

function updateUserInfoHeader() {
    const roleInfo = USER_ROLES[currentUser.role] || USER_ROLES.viewer;
    const userForAvatar = getUsers().find(u => u.username === currentUser.username);
    const avatarSrc = userForAvatar?.avatar || DEFAULT_AVATAR_SRC;
    document.getElementById("userInfo").innerHTML = `<img src="${esc(avatarSrc)}" class="header-avatar"> <div><span class="role-badge role-${esc(currentUser.role)}"><i class="${roleInfo.icon}"></i> ${roleInfo.name}</span><div style="font-size: 0.9em; margin-top:2px;">${esc(currentUser.fullName||currentUser.username)}</div></div>`;
}

function toggleLoginSupabaseConfig() {
    const box = document.getElementById('loginSupabaseConfigBox');
    const isHidden = box.style.display === 'none';
    box.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
        const s = getCloudSettings();
        document.getElementById('loginSupabaseUrl').value = s.supabaseUrl || '';
        document.getElementById('loginSupabaseKey').value = s.supabaseKey || '';
    }
}

function toggleForgotPasswordBox() {
    const box = document.getElementById('forgotPasswordBox');
    box.style.display = (box.style.display === 'none') ? 'block' : 'none';
}

// Toggles one of the three login-page action boxes (ស្នើសុំកម្ចី / ទាក់ទងក្រុមហ៊ុន / សុំជំនួយ),
// closing the other two so only one is open at a time.
function toggleLoginActionBox(boxId) {
    ['loanRequestBox', 'contactCompanyBox', 'helpRequestBox', 'checkStatusBox', 'downloadScheduleBox'].forEach(id => {
        const box = document.getElementById(id);
        if (!box) return;
        const opening = (id === boxId && box.style.display === 'none');
        box.style.display = opening ? 'block' : 'none';
        // Whenever the loan-request wizard opens (or gets closed via "បដិសេធ" on the terms
        // step), always reset it back to the terms step for the next visitor/attempt.
        if (id === 'loanRequestBox') lrResetWizard();
    });
}

// ===================== PUBLIC LOAN REQUEST WIZARD (login page) =====================
// PLACEHOLDER eligibility numbers — replace with the real product terms whenever they're ready.
// Everything else (terms checklist text, term dropdown options, the min/max hint under the
// amount field) is generated FROM this object, so editing it here is the only change needed.
const LR_TERMS = {
    amountMinKHR: 200000, amountMaxKHR: 1000000,
    amountMinUSD: 50,     amountMaxUSD: 250,
    termOptions: [ // { label, days } — shown in the "រយៈពេលខ្ចី" dropdown on the form step
        { label: '1 ខែ (30 ថ្ងៃ)', days: 30 },
        { label: '3 ខែ (90 ថ្ងៃ)', days: 90 },
        { label: '6 ខែ (180 ថ្ងៃ)', days: 180 },
        { label: '12 ខែ (360 ថ្ងៃ)', days: 360 }
    ],
    monthlyRatePercent: 3, // "គំរូ" — flat placeholder rate shown on the terms screen
    minAgeYears: 18
};

function lrRenderTermsList() {
    const list = document.getElementById('lrTermsList');
    if (!list) return;
    const items = [
        `ទំហំកម្ចី អប្បបរមា ${LR_TERMS.amountMinKHR.toLocaleString()}៛ (${LR_TERMS.amountMinUSD}$) អតិបរមា ${LR_TERMS.amountMaxKHR.toLocaleString()}៛ (${LR_TERMS.amountMaxUSD}$)`,
        `រយៈពេលកម្ចី ចាប់ពី ${LR_TERMS.termOptions[0].days} ដល់ ${LR_TERMS.termOptions[LR_TERMS.termOptions.length - 1].days} ថ្ងៃ`,
        `អត្រាការប្រាក់ អតិបរមា ${LR_TERMS.monthlyRatePercent}% ក្នុងមួយខែ`,
        `ត្រូវមានអាយុចាប់ពី ${LR_TERMS.minAgeYears} ឆ្នាំឡើងទៅ`,
        'មានទីលំនៅអចិន្ត្រៃយ៍ក្នុងប្រទេសកម្ពុជា',
        'មានការងារធ្វើ ឬ មុខរបរផ្តល់ចំណូលច្បាស់លាស់',
        'មិនស្ថិតក្នុងបញ្ជីខ្មៅ (Blacklist) នៅគ្រឹះស្ថានហិរញ្ញវត្ថុផ្សេងៗ'
    ];
    list.innerHTML = items.map(t => `<li><i class="fas fa-check-circle"></i> ${t}</li>`).join('');
}

function lrPopulateTermSelect() {
    const sel = document.getElementById('lrTerm');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- ជ្រើសរើសរយៈពេល --</option>' +
        LR_TERMS.termOptions.map(o => `<option value="${o.days}">${esc(o.label)}</option>`).join('');
}

function lrUpdateAmountHint() {
    const hint = document.getElementById('lrAmountHint');
    if (!hint) return;
    const currency = document.getElementById('lrCurrency').value;
    hint.textContent = currency === 'USD'
        ? `អប្បបរមា ${LR_TERMS.amountMinUSD}$ / អតិបរមា ${LR_TERMS.amountMaxUSD}$`
        : `អប្បបរមា ${LR_TERMS.amountMinKHR.toLocaleString()}៛ / អតិបរមា ${LR_TERMS.amountMaxKHR.toLocaleString()}៛`;
}

// Switches between the two visual steps of the wizard. Re-renders the terms list / term
// dropdown / amount hint each time "terms" is (re)shown so LR_TERMS edits always take effect
// without needing a page reload.
function lrGoToStep(step) {
    const termsStep = document.getElementById('lrStepTerms');
    const formStep = document.getElementById('lrStepForm');
    if (!termsStep || !formStep) return;
    if (step === 'form') {
        lrPopulateTermSelect();
        lrUpdateAmountHint();
        termsStep.style.display = 'none';
        formStep.style.display = 'block';
    } else {
        lrRenderTermsList();
        formStep.style.display = 'none';
        termsStep.style.display = 'block';
    }
}

function lrResetWizard() {
    const termsStep = document.getElementById('lrStepTerms');
    const formStep = document.getElementById('lrStepForm');
    if (!termsStep || !formStep) return;
    lrRenderTermsList();
    termsStep.style.display = 'block';
    formStep.style.display = 'none';
}

function lrSelectCurrency(currency) {
    document.getElementById('lrCurrency').value = currency;
    document.querySelectorAll('#lrCurrencyToggle .lr-currency-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.currency === currency);
    });
    lrUpdateAmountHint();
}

// When submitting on behalf of someone else, "ឈ្មោះពេញ" switches to meaning the *requester*
// (the person filling the form), and a separate required "ឈ្មោះអ្នកខ្ចី" field appears for the
// actual borrower — mirrors the toggle shown in the reference design.
function lrToggleOnBehalf() {
    const onBehalf = document.getElementById('lrOnBehalf').checked;
    document.getElementById('lrBorrowerNameWrap').style.display = onBehalf ? 'block' : 'none';
    document.getElementById('lrBorrowerName').required = onBehalf;
    document.getElementById('lrNameLabel').textContent = onBehalf ? 'ឈ្មោះអ្នកស្នើសុំ (អ្នកតំណាង) *' : 'ឈ្មោះពេញ *';
}

// Public loan-request form on the login page (no login required). Uses the same
// persistData()/LS_KEYS.loanRequests pipeline the rest of the app uses (see admin.js's
// saveHoliday/saveExpense for the identical pattern) — persistData() -> scheduleCloudPush()
// -> dbContext() in db.js, which falls back to the Supabase anon key when there's no logged-in
// session yet, so this works from the login screen. Requires a `loan_requests` table in
// Supabase (same generic `id text primary key, data jsonb` shape as holidays/expenses/etc.)
// with an RLS policy allowing INSERT for the anon role; submitted requests then show up for
// staff under Admin > សំណើសុំកម្ចី once they log in (see renderLoanRequestsTable() in admin.js).
function submitLoanRequest(e) {
    e.preventDefault();
    const onBehalf = document.getElementById('lrOnBehalf').checked;
    const borrowerName = document.getElementById('lrBorrowerName').value.trim();
    const name = document.getElementById('lrName').value.trim(); // requester's name when onBehalf, else the borrower's own name
    const phone = document.getElementById('lrPhone').value.trim();
    const amountRaw = document.getElementById('lrAmount').value;
    const amount = amountRaw === '' ? null : parseFloat(amountRaw);
    const currency = document.getElementById('lrCurrency').value;
    const purpose = document.getElementById('lrPurpose').value.trim();
    const termDays = document.getElementById('lrTerm').value || null;
    const collateral = document.getElementById('lrCollateral').value || '';
    const province = document.getElementById('lrProvince').value.trim();
    const district = document.getElementById('lrDistrict').value.trim();
    const commune = document.getElementById('lrCommune').value.trim();
    const village = document.getElementById('lrVillage').value.trim();

    if (!name || !phone || (onBehalf && !borrowerName)) {
        showToast('សូមបំពេញព័ត៌មានដែលមានសញ្ញា * ឲ្យបានគ្រប់ (ឈ្មោះ, ឈ្មោះអ្នកខ្ចី, លេខទូរស័ព្ទ)', 'error');
        return;
    }

    const submitBtn = document.getElementById('lrSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> កំពុងផ្ញើ...';

    // `address` is kept as a single joined line too, alongside the separate parts, so any older
    // code/report still reading request.address (e.g. an export or older admin build) keeps
    // working — see createLoanFromRequest() in admin.js for where the separate parts get used.
    const address = [village, commune, district, province].filter(Boolean).join(', ');

    const newRequest = {
        id: 'REQ-' + Date.now(),
        name: onBehalf ? borrowerName : name,
        requesterName: onBehalf ? name : '',
        onBehalf,
        phone,
        amount: (amount != null && !isNaN(amount)) ? amount : null,
        currency: currency || 'KHR',
        termDays: termDays ? Number(termDays) : null,
        collateral,
        village, commune, district, province,
        address,
        purpose: purpose || '',
        status: 'pending',
        submittedAt: new Date().toISOString()
    };

    loanRequests.push(newRequest);
    persistData(LS_KEYS.loanRequests, loanRequests);

    const collateralLabels = { none: 'គ្មានវត្ថុបញ្ចាំ', property: 'ប័ណ្ណដី/ផ្ទះ', vehicle: 'ប័ណ្ណរថយន្ត/ម៉ូតូ', guarantor: 'អ្នកធានា', other: 'ផ្សេងៗ' };
    notifyTelegram(`📩 <b>មានសំណើសុំកម្ចីថ្មី</b>\nឈ្មោះ: ${newRequest.name}${newRequest.onBehalf ? ` (ស្នើសុំដោយ: ${newRequest.requesterName})` : ''}\nទូរស័ព្ទ: ${newRequest.phone}${newRequest.amount ? `\nចំនួនស្នើសុំ: ${newRequest.amount} ${newRequest.currency}` : ''}${newRequest.termDays ? `\nរយៈពេល: ${newRequest.termDays} ថ្ងៃ` : ''}${newRequest.collateral ? `\nការធានា: ${collateralLabels[newRequest.collateral] || newRequest.collateral}` : ''}${newRequest.address ? `\nអាសយដ្ឋាន: ${newRequest.address}` : ''}${newRequest.purpose ? `\nគោលបំណង/ចំណូល: ${newRequest.purpose}` : ''}`);

    showToast('សំណើសុំកម្ចីរបស់អ្នកបានផ្ញើដោយជោគជ័យ! ក្រុមការងារនឹងទាក់ទងទៅអ្នកឆាប់ៗនេះ។', 'success');
    document.getElementById('loanRequestForm').reset();
    document.getElementById('lrBorrowerNameWrap').style.display = 'none';
    lrSelectCurrency('KHR');
    document.getElementById('loanRequestBox').style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> ដាក់ស្នើសុំកម្ចី';
}

// Public "check my loan-request status" lookup on the login page (no login required). Deliberately
// does NOT select the loan_requests table directly the way an admin screen would — a blanket anon
// SELECT policy on that table would let any visitor page through every customer's name/phone/amount,
// not just their own. Instead this calls a Postgres RPC (see schema/loan_request_status_rpc.sql)
// that runs as SECURITY DEFINER and returns only status/amount/currency/date for rows matching the
// phone number the visitor typed in — the same "server decides what you can see" pattern proper
// RLS relies on, just implemented as a function since the underlying table is generic id/data jsonb.
// Run that SQL file once in the Supabase SQL editor before this feature will return results.
async function checkLoanRequestStatus(e) {
    e.preventDefault();
    const phone = document.getElementById('csPhone').value.trim();
    const resultsBox = document.getElementById('csResults');
    if (!phone) return;

    const submitBtn = document.getElementById('csSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> កំពុងស្វែងរក...';
    resultsBox.innerHTML = '';

    try {
        const rows = await dbRpc('get_loan_request_status_by_phone', { p_phone: phone });
        if (!rows || rows.length === 0) {
            resultsBox.innerHTML = `<p style="font-size:13px; color:#888; text-align:center; margin:0;">រកមិនឃើញសំណើសុំកម្ចីជាមួយលេខទូរស័ព្ទនេះទេ។</p>`;
        } else {
            resultsBox.innerHTML = rows.map(r => {
                const st = LOAN_REQUEST_STATUS[r.status] || LOAN_REQUEST_STATUS.pending;
                return `
                    <div style="border:1px solid #eee; border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span class="status-badge ${st.badgeClass}">${esc(st.label)}</span>
                            <span style="font-size:12px; color:#888;">${esc(formatDateDMY(r.submitted_at))}</span>
                        </div>
                        ${r.amount ? `<div style="margin-top:6px; font-size:13px;">ចំនួនស្នើសុំ: ${esc(fmtMoney(r.amount, r.currency || 'USD'))}</div>` : ''}
                    </div>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('checkLoanRequestStatus error:', err);
        resultsBox.innerHTML = `<p style="font-size:13px; color:#c0392b; text-align:center; margin:0;">មិនអាចពិនិត្យស្ថានភាពបានទេ សូមព្យាយាមម្តងទៀត។</p>`;
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-search"></i> ពិនិត្យស្ថានភាព';
    }
}

// Public "download my payment schedule" lookup on the login page (no login required). Same
// security shape as checkLoanRequestStatus() above: never grants anon a general SELECT policy
// on loans/customers/partial_payments (which would let any visitor browse every customer's full
// loan terms and payment history) — calls a SECURITY DEFINER RPC that only returns loans
// belonging to a customer whose phone matches what was typed in. Run
// schema/loan_schedule_download_rpc.sql once in the Supabase SQL editor before this works.
//
// Reuses buildSchedule()/exportScheduleToExcel() (loans.js) instead of a second schedule-math
// implementation, by populating the same globals (currentLoan, payments, holidays) those
// functions already read from — so what the customer downloads is guaranteed to match what an
// officer sees, not a parallel calculation that could drift out of sync.
let __publicLoanScheduleData = [];

async function checkMyLoanSchedule(e) {
    e.preventDefault();
    const phone = document.getElementById('dsPhone').value.trim();
    const resultsBox = document.getElementById('dsResults');
    if (!phone) return;

    const submitBtn = document.getElementById('dsSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> កំពុងស្វែងរក...';
    resultsBox.innerHTML = '';
    __publicLoanScheduleData = [];

    try {
        const rows = await dbRpc('get_customer_loan_schedule_data', { p_phone: phone });
        const row = (rows && rows[0]) || {};
        const loanEntries = row.loans || [];

        holidays = row.holidays || [];
        payments = {};
        loanEntries.forEach(entry => {
            (entry.payments || []).forEach(p => {
                const key = `${entry.loan.loanId}-${p.installment_index}`;
                if (!payments[key]) payments[key] = [];
                payments[key].push(p.data);
            });
        });
        scheduleCache = {};

        if (loanEntries.length === 0) {
            resultsBox.innerHTML = `<p style="font-size:13px; color:#888; text-align:center; margin:0;">រកមិនឃើញកម្ចីជាមួយលេខទូរស័ព្ទនេះទេ។</p>`;
        } else {
            __publicLoanScheduleData = loanEntries;
            resultsBox.innerHTML = loanEntries.map((entry, idx) => {
                const loan = entry.loan;
                const st = getLoanComputedStatus(loan);
                return `
                    <div style="border:1px solid #eee; border-radius:8px; padding:10px 12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
                        <div>
                            <div style="font-weight:600;">${esc(loan.loanId)}</div>
                            <div style="font-size:12px; color:#888;">${esc(fmtMoney(loan.loanAmount, loan.currency || 'USD'))} — ${esc(st.text)}</div>
                        </div>
                        ${loan.status === 'pending' || loan.status === 'rejected'
                            ? `<span style="font-size:12px; color:#888;">មិនទាន់មានតារាង</span>`
                            : `<button type="button" class="btn btn-sm btn-info" onclick="downloadMyLoanSchedule(${idx})"><i class="fas fa-file-excel"></i> ទាញយក</button>`
                        }
                    </div>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('checkMyLoanSchedule error:', err);
        resultsBox.innerHTML = `<p style="font-size:13px; color:#c0392b; text-align:center; margin:0;">មិនអាចទាញយកទិន្នន័យបានទេ សូមព្យាយាមម្តងទៀត។</p>`;
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-search"></i> ស្វែងរកកម្ចី';
    }
}

function downloadMyLoanSchedule(index) {
    const entry = __publicLoanScheduleData[index];
    if (!entry) return;
    currentLoan = entry.loan;
    exportScheduleToExcel();
}

// Lets someone set the Supabase URL/Key on a fresh browser BEFORE logging in (Cloud Sync settings
// used to only be editable from inside the app, but login now depends on them being present here
// first — this breaks that chicken-and-egg problem). Writes into the same CLOUD_SETTINGS_KEY that
// the in-app Cloud Sync form uses, so once someone logs in, Admin > Cloud Sync shows the same values.
function saveLoginSupabaseConfig() {
    const url = document.getElementById('loginSupabaseUrl').value.trim().replace(/\/+$/, '');
    const key = document.getElementById('loginSupabaseKey').value.trim();
    if (!url || !key) { showToast('សូមបំពេញ URL និង Key ទាំងពីរ', 'error'); return; }
    const existing = getCloudSettings();
    const settings = { ...existing, supabaseUrl: url, supabaseKey: key };
    localStorage.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(settings));
    showToast('រក្សាទុកការតភ្ជាប់ Supabase បានជោគជ័យ! ឥឡូវអាចចូលប្រព័ន្ធបាន។', 'success');
    document.getElementById('loginSupabaseConfigBox').style.display = 'none';
}

async function login(){
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value.trim();
  if (!username || !password) { showToast('សូមបំពេញឈ្មោះអ្នកប្រើនិងពាក្យសម្ងាត់', 'error'); return; }

  const { url, key } = getSupabaseAuthConfig();
  if (!url || !key) {
      showToast('សូមកំណត់ Supabase URL/Key (Cloud Sync) ជាមុនសិន ព្រោះឥឡូវនេះការចូលប្រព័ន្ធត្រូវការវា', 'error');
      return;
  }

  try {
      const authResult = await supabaseAuthSignIn(`${username}@${AUTH_EMAIL_DOMAIN}`, password);
      saveSupabaseSession({
          access_token: authResult.access_token,
          refresh_token: authResult.refresh_token,
          uid: authResult.user.id,
          expires_at: Date.now() + (authResult.expires_in || 3600) * 1000
      });

      const profile = await fetchUserRoleProfile(authResult.user.id);
      if (!profile) {
          showToast('គណនីនេះមិនទាន់មានទិន្នន័យតួនាទី (role) ក្នុង Supabase ទេ។ សូមទាក់ទងអ្នកគ្រប់គ្រង', 'error');
          clearSupabaseSession();
          return;
      }
      if (profile.is_frozen) {
          showToast("គណនីរបស់អ្នកត្រូវបានបង្កក សូមទាក់ទងអ្នកគ្រប់គ្រង", 'error');
          clearSupabaseSession();
          return;
      }

      currentUser = {
          uid: authResult.user.id,
          username: profile.username || username,
          fullName: profile.full_name || username,
          role: profile.role || 'viewer',
          pin: profile.pin || '1234',
          isFrozen: !!profile.is_frozen,
          avatar: profile.avatar || null
      };

      // Successful login — clear any failed-attempt count this account had built up.
      try { await upsertUserRoleProfile({ uid: currentUser.uid, failed_attempts: 0 }); } catch (e) { console.error('Could not reset failed_attempts:', e); }

      // Mirror into the local users cache so existing screens (avatar, users table, loan-transfer
      // lookups by username) keep working without a network round-trip every time.
      let users = getUsers();
      const idx = users.findIndex(u => u.username === currentUser.username);
      const mirrored = {
          uid: currentUser.uid, username: currentUser.username, fullName: currentUser.fullName,
          role: currentUser.role, pin: currentUser.pin, isFrozen: currentUser.isFrozen,
          avatar: currentUser.avatar, createdAt: (idx > -1 ? users[idx].createdAt : new Date().toISOString())
      };
      if (idx > -1) users[idx] = { ...users[idx], ...mirrored }; else users.push(mirrored);
      setUsersCache(users);

      // checkAuth() re-derives currentUser from the (now-saved) Supabase session + profile and
      // drives the rest of app startup — there's no separate "logged in" flag to set locally.
      await checkAuth();
  } catch (e) {
      console.error('Supabase login error:', e);
      const msg = String(e.message || e);
      if (/Invalid login credentials/i.test(msg)) {
          // Wrong username or password. Count it against this account (a small SECURITY DEFINER
          // function on the Supabase side does this — see record_failed_login() in schema.sql —
          // because at this point the browser isn't authenticated yet, so it has no other way to
          // touch the database). After 3 strikes the account is frozen and can only be unfrozen
          // by an admin (Admin > Users > un-freeze), matching what was asked for.
          let attempts = null;
          try { attempts = await dbRpc('record_failed_login', { p_username: username }); } catch (e2) { console.error('record_failed_login failed:', e2); }
          if (attempts !== null && attempts >= 3) {
              showFrozenAccountMessage();
          } else if (attempts !== null) {
              showToast(`ឈ្មោះអ្នកប្រើប្រាស់ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ (ព្យាយាមខុស ${attempts}/3 ដង — ខុសដល់ 3 ដង គណនីនឹងត្រូវបានបង្កក)`, 'error');
          } else {
              // Unknown username, or the account was already frozen from an earlier session.
              showToast("ឈ្មោះអ្នកប្រើប្រាស់ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ", 'error');
          }
      } else {
          showToast(`ការចូលប្រព័ន្ធបរាជ័យ: ${msg}`, 'error');
      }
      clearSupabaseSession();
  }
}

// Shown both when login itself reveals the account is frozen (3 wrong attempts) and when
// checkAuth() finds is_frozen on an account that somehow still has a valid session.
function showFrozenAccountMessage() {
    showToast("គណនីរបស់អ្នកត្រូវបានបង្កក ដោយសារព្យាយាមបញ្ចូលពាក្យសម្ងាត់ខុសលើសពី 3 ដង។ សូមទាក់ទងអ្នកគ្រប់គ្រងដើម្បីដោះការបង្កក។", 'error');
}

// Shown when Maintenance Mode is on and the signed-in (or signing-in) user isn't 'admin' —
// both when checkAuth() turns them away up front, and when db.js's Realtime handler kicks out
// someone whose tab was already open when an admin flipped the mode on. Falls back to a
// generic line if the admin didn't set a custom message.
function showMaintenanceBlockedMessage() {
    const customMsg = (typeof getCloudMaintenanceMessage === 'function') ? getCloudMaintenanceMessage() : '';
    showToast(customMsg || 'ប្រព័ន្ធកំពុងស្ថិតក្នុងអំឡុងពេលថែទាំ (Maintenance) សូមព្យាយាមម្តងទៀតពេលក្រោយ។', 'error');
}

function logout(){
    const { url, key } = getSupabaseAuthConfig();
    const session = getSupabaseSession();
    if (url && key && session?.access_token) {
        fetch(`${url}/auth/v1/logout`, { method: 'POST', headers: { 'apikey': key, 'Authorization': `Bearer ${session.access_token}` } }).catch(() => {});
    }
    teardownRealtimeSync();
    clearSupabaseSession(); // this is the one piece of session state that has to live in the
                             // browser (it's the actual login token) — see db.js header comment.
    currentUser = null;
    __usersMemoryCache = [];
    clearTimeout(inactivityTimer);
    scheduleCache = {}; 
    location.reload(); 
}

