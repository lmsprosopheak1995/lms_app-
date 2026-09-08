// =====================================================================
// config.js — Global configuration, permission map, and shared application state (loans/customers/savings/etc. arrays).
// =====================================================================

// ===================== CONFIG & STATE =====================
const USER_ROLES = { admin: { name: 'អ្នកគ្រប់គ្រង', icon: 'fas fa-user-shield' }, manager: { name: 'អ្នកគ្រប់គ្រងកម្ចី', icon: 'fas fa-user-tie' }, officer: { name: 'មន្ត្រីឥណទាន', icon: 'fas fa-user-edit' }, viewer: { name: 'អ្នកមើល', icon: 'fas fa-user-secret' } };
// NOTE: these were originally literal localStorage key names. They're now just internal
// identifiers used as lookup keys into the in-memory cloud cache (see utils.js/db.js) — the
// actual data lives in Supabase tables, not in the browser. Kept as-is (not renamed) so none of
// the hundreds of existing `persistData(LS_KEYS.x, x)` / `loadData(LS_KEYS.x)` call sites across
// the app needed to change. A few entries below are no longer used at all now that their data
// moved elsewhere: `loggedIn`/`currentUser` (derived fresh from the Supabase session on every
// load — see checkAuth() in auth.js), `users` (already lived in Supabase via app_user_roles;
// the local copy is in-memory only now), `loanIdCounter` (replaced by the next_loan_id() RPC —
// see db.js), `savingsIdCounter` (was never actually persisted even before this migration),
// `theme` (moved to app_user_roles.theme_preference), `exRate`/`exDate`/`migrationVersion`
// (folded into the shared app_settings row), and `lastBackup` (the "haven't backed up" reminder
// no longer applies once Supabase is the system of record).
const LS_KEYS = {
    loans: 'lms_loans_v3', loggedIn: 'lms_loggedIn', currentUser: 'lms_currentUser', users: 'lms_users_v3',
    exRate: 'lms_exchangeRate', exDate: 'lms_exchangeRateDate', payments: 'lms_payments_v3',
    refinances: 'lms_refinances_v3', lastBackup: 'lms_lastBackupDate', holidays: 'lms_holidays_v3',
    collaterals: 'lms_collaterals_v3', guarantors: 'lms_guarantors_v3', loanIdCounter: 'lms_loanIdCounter_v3',
    loanHistory: 'lms_loanHistory_v3', expenses: 'lms_expenses_v1', notifications: 'lms_notifications_v1',
    loanProducts: 'lms_loanProducts_v1', appSettings: 'lms_appSettings_v1',
    customers: 'lms_customers_v1',
    loanRequests: 'lms_loanRequests_v1',
    migrationVersion: 'lms_migration_version',
    theme: 'lms_theme_v1',
    savingsAccounts: 'lms_savingsAccounts_v1', savingsPayments: 'lms_savingsPayments_v1', savingsIdCounter: 'lms_savingsIdCounter_v1', savingsWithdrawals: 'lms_savingsWithdrawals_v1'
};
const DEFAULT_AVATAR_SRC = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2NjYyI+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCA0LTEuNzkgNC00cy0xLjc5LTQtNC00LTQgMS43OS00IDQgMS43OSA0IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIvPjwvc3ZnPg==';
const PERMISSIONS = {
  admin:   { canManageUsers: true, canDeleteCustomer: true, canArchiveLoan: true, canDeleteLoan: true, canDeleteSavings: true, canEditLoan: true, canRefinanceLoan: true, canViewAllLoans: true, canManageSystem: true, canManagePayments: true, canWriteOff: true, canApproveLoan: true },
  manager: { canManageUsers: false, canDeleteCustomer: true, canArchiveLoan: true, canDeleteLoan: true, canDeleteSavings: true, canEditLoan: true, canRefinanceLoan: true, canViewAllLoans: true, canManageSystem: false, canManagePayments: true, canWriteOff: true, canApproveLoan: true },
  officer: { canManageUsers: false, canDeleteCustomer: false, canArchiveLoan: false, canDeleteLoan: false, canDeleteSavings: false, canEditLoan: false, canRefinanceLoan: false, canViewAllLoans: false, canManageSystem: false, canManagePayments: true, canWriteOff: false, canApproveLoan: false },
  viewer:  { canManageUsers: false, canDeleteCustomer: false, canArchiveLoan: false, canDeleteLoan: false, canDeleteSavings: false, canEditLoan: false, canRefinanceLoan: false, canViewAllLoans: true, canManageSystem: false, canManagePayments: false, canWriteOff: false, canApproveLoan: false }
};
const ROWS_PER_PAGE = 25;
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

let loans = [];
let customers = [];
let payments = {};
let refinances = [];
let holidays = [];
let collaterals = [];
let guarantors = [];
let loanHistory = {};
let expenses = [];
let notifications = [];
let loanProducts = [];
let loanRequests = [];
let appSettings = {};

let currentUser = null;
let currentLoan = null;
let currentPayment = { loanId: null, installmentIndex: null };
let charts = {};
let currentPage = 1;
let scheduleCache = {};
let inactivityTimer;
let mapInstance = null;

// Savings module state (independent of Loans)
let savingsAccounts = [];
let savingsPayments = {};
let savingsWithdrawals = {};
let currentSavingsAccount = null;
let currentSavingsPayment = { accountId: null, installmentIndex: null };
let savingsScheduleCache = {};

