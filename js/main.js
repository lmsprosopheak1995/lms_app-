// =====================================================================
// main.js — One-time data migration and app initialization: loads state, wires all DOM event listeners, boots the app.
// =====================================================================

// ===================== DATA MIGRATION =====================
// Migration progress is now a single shared flag in the cloud (app_settings.migration_version)
// instead of a per-browser localStorage flag, so it only ever runs once for the whole system —
// not once per officer's browser.
function runDataMigration() {
    const MIGRATION_VERSION = 1;
    const currentVersion = getCloudMigrationVersion();

    if (currentVersion < MIGRATION_VERSION) {
        console.log("Running data migration to version 1...");
        let tempLoans = loadData(LS_KEYS.loans);
        let tempCustomers = loadData(LS_KEYS.customers);
        let updated = false;

        tempLoans.forEach(loan => {
            if (loan.customerName && !loan.customerId) {
                let existingCustomer = tempCustomers.find(c => c.name.toLowerCase() === loan.customerName.toLowerCase());

                if (!existingCustomer) {
                    existingCustomer = {
                        id: 'CUST-' + Date.now() + Math.random().toString(36).substr(2, 5),
                        name: loan.customerName,
                        gender: loan.gender || 'ប្រុស',
                        phone: loan.phone || '',
                        village: loan.village || '',
                        commune: loan.commune || '',
                        district: loan.district || '',
                        province: loan.province || '',
                        isBlacklisted: false,
                        createdAt: loan.processedAt || new Date().toISOString()
                    };
                    tempCustomers.push(existingCustomer);
                }

                loan.customerId = existingCustomer.id;
                
                delete loan.customerName;
                delete loan.gender;
                delete loan.phone;
                delete loan.village;
                delete loan.commune;
                delete loan.district;
                delete loan.province;

                updated = true;
            }
        });

        if (updated) {
            persistData(LS_KEYS.loans, tempLoans);
            persistData(LS_KEYS.customers, tempCustomers);
            saveMigrationVersionToCloud(MIGRATION_VERSION);
            console.log("Migration complete. Loans and Customers data updated.");
            showToast('ទិន្នន័យត្រូវបានធ្វើបច្ចុប្បន្នភាពទៅរចនាសម្ព័ន្ធថ្មី។', 'success');
        } else {
            saveMigrationVersionToCloud(MIGRATION_VERSION);
            console.log("No migration needed or already up to date.");
        }
    }
}


// ===================== INITIALIZATION =====================
function initAppSettings() {
    const defaultSettings = {
        expenseCategories: ["ប្រាក់ខែបុគ្គលិក", "ការជួល", "សម្ភារៈការិយាល័យ", "ទីផ្សារ", "ផ្សេងៗ"],
        messageTemplates: [
            { id: 'tpl-reminder-1', name: 'ការរំលឹកបង់ប្រាក់', content: 'សូមជម្រាបជូនលោក/លោកស្រី [CustomerName], កម្ចី [LoanID] របស់អ្នកត្រូវបង់លើកទី [InstallmentNumber] នៅថ្ងៃទី [DueDate] ជាចំនួនទឹកប្រាក់ [RemainingAmount]។' }
        ]
    };
    appSettings = { ...defaultSettings, ...loadData(LS_KEYS.appSettings, true) };
}

function populateDynamicSelectors() {
    const yearSelect = document.getElementById('annualReportYear');
    if (yearSelect) {
      const currentYear = new Date().getFullYear();
      for (let i = 0; i < 5; i++) {
          yearSelect.innerHTML += `<option value="${currentYear - i}">${currentYear - i}</option>`;
      }
    }
    
    // Populate Customer Report Filters
    populateOfficerDropdown('reportOfficerFilter', true);
    populateOfficerDropdown('reportOfficer', true);
    const provinces = [...new Set(customers.map(c => c.province).filter(p => p))].sort();
    const provinceSelect = document.getElementById('reportProvinceFilter');
    provinceSelect.innerHTML = '<option value="all">ទាំងអស់</option>';
    provinces.forEach(p => provinceSelect.innerHTML += `<option value="${p}">${p}</option>`);

    const districts = [...new Set(customers.map(c => c.district).filter(d => d))].sort();
    const districtSelect = document.getElementById('reportDistrictFilter');
    districtSelect.innerHTML = '<option value="all">ទាំងអស់</option>';
    districts.forEach(d => districtSelect.innerHTML += `<option value="${d}">${d}</option>`);
}

async function initApp() {
  // Pull every entity from Supabase ONCE before anything else runs. Everything below this line
  // is unchanged from before — it just reads the now-populated in-memory arrays/objects via the
  // same loadData() calls as always (see utils.js + db.js for how that's now cloud-backed).
  const loadingOverlay = document.getElementById('appLoadingOverlay');
  if (loadingOverlay) loadingOverlay.style.display = 'flex';
  try {
    await loadAllCloudData();
  } catch (e) {
    console.error('Could not load data from the cloud database:', e);
    showToast('មិនអាចទាញយកទិន្នន័យពី Cloud បានទេ សូមពិនិត្យការតភ្ជាប់អ៊ីនធឺណិត ហើយ Refresh ទំព័រ', 'error');
  }

  initTheme();
  runDataMigration();

  loans = loadData(LS_KEYS.loans);
  customers = loadData(LS_KEYS.customers);
  payments = loadData(LS_KEYS.payments, true);
  refinances = loadData(LS_KEYS.refinances);
  holidays = loadData(LS_KEYS.holidays);
  collaterals = loadData(LS_KEYS.collaterals);
  guarantors = loadData(LS_KEYS.guarantors);
  loanHistory = loadData(LS_KEYS.loanHistory, true);
  expenses = loadData(LS_KEYS.expenses);
  notifications = loadData(LS_KEYS.notifications);
  loanProducts = loadData(LS_KEYS.loanProducts);
  loanRequests = loadData(LS_KEYS.loanRequests);
  savingsAccounts = loadData(LS_KEYS.savingsAccounts);
  savingsPayments = loadData(LS_KEYS.savingsPayments, true);
  savingsWithdrawals = loadData(LS_KEYS.savingsWithdrawals, true);
  initAppSettings();

  // Bring loan.status up to date for any loan that's fully paid but hasn't been flipped to
  // 'completed' yet (e.g. the last payment was recorded through some path other than
  // savePartialPayment). Runs once, right after loans/payments are both loaded — not on every
  // table/dashboard render (see getLoanComputedStatus() in loans.js for why that mattered).
  reconcileLoanStatuses();

  if (loadingOverlay) loadingOverlay.style.display = 'none';
  updateExchangeUI();
  populateOfficerDropdown('creditOfficer', false, currentUser.username);
  populateOfficerDropdown('collectionsOfficerFilter', true);
  populateCustomerDropdowns();
  populateLoanProductDropdown();
  populateDynamicSelectors();
  populateExpenseCategoryDropdown();
  displayLoans();
  clearForm();
  hideCustomerForm(); 
  generateNotifications();
  renderDashboard();
  clearSavingsForm();

  // --- Centralized Event Listeners ---
  document.getElementById('loanProductSelect').addEventListener('change', (e) => applyLoanProductTemplate(e.target.value));
  document.getElementById('customerForm').addEventListener('submit', saveCustomer);
  document.getElementById('expenseForm').addEventListener('submit', saveExpense);
  document.getElementById('customerSelect').addEventListener('change', displaySelectedCustomerInfo);
  document.getElementById('clientAccountSelect').addEventListener('change', renderClientAccountView);
  document.getElementById('collectionsDate').addEventListener('change', renderCollectionsTable);
  document.getElementById('collectionsOfficerFilter').addEventListener('change', renderCollectionsTable);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('holidayForm').addEventListener('submit', saveHoliday);
  document.getElementById('loanProductForm').addEventListener('submit', saveLoanProduct);
  document.getElementById('expenseCategoryForm').addEventListener('submit', saveExpenseCategory);
  document.getElementById('exchangeRateInput').addEventListener('change', e => setExchangeRate(Math.max(1000, Number(e.target.value) || 0)));
  document.getElementById('paymentDateType').addEventListener('change', (e) => { const val = e.target.value; document.getElementById('fixedDayInput').style.display = val === 'fixed-day' ? 'block' : 'none'; document.getElementById('everyXDaysInput').style.display = val === 'every-x-days' ? 'block' : 'none'; });
  document.getElementById('loanForm').addEventListener('submit', e => { e.preventDefault(); saveLoan(); });
  document.getElementById('addPartialPaymentForm').addEventListener('submit', savePartialPayment);
  document.getElementById('resetForm').addEventListener('click', () => { clearForm(); clearScheduleAndSummary(); });
  document.getElementById('attachmentInput').addEventListener('change', handleFileUpload);
  document.getElementById('userAvatarInput').addEventListener('change', (event) => { const file = event.target.files[0]; if (file) { const reader = new FileReader(); reader.onload = (e) => { document.getElementById('avatarPreview').src = e.target.result; }; reader.readAsDataURL(file); } });
  document.getElementById('collateralForm').addEventListener('submit', saveCollateral);
  document.getElementById('guarantorForm').addEventListener('submit', saveGuarantor);
  document.getElementById('generatePlBtn').addEventListener('click', generatePlReport);
  document.getElementById('dashboardDateRange').addEventListener('change', renderDashboard);
  document.getElementById('customerProfileSelect').addEventListener('change', renderCustomerProfile);
  document.getElementById('profileAvatarInput').addEventListener('change', handleProfileAvatarUpload);
  document.getElementById('idCardFrontInput').addEventListener('change', (e) => handleIdCardUpload('front', e));
  document.getElementById('idCardBackInput').addEventListener('change', (e) => handleIdCardUpload('back', e));
  document.getElementById('customerDocumentInput').addEventListener('change', handleCustomerDocumentUpload);

  // --- Savings module listeners ---
  document.getElementById('savingsAccountForm').addEventListener('submit', saveSavingsAccount);
  document.getElementById('addSavingsDepositForm').addEventListener('submit', saveSavingsDeposit);
  document.getElementById('addSavingsWithdrawForm').addEventListener('submit', saveSavingsWithdrawal);
  document.getElementById('savingsGoalAmount').addEventListener('input', updateSavingsTermPreview);
  document.getElementById('savingsMonthlyAmount').addEventListener('input', updateSavingsTermPreview);
  document.getElementById('savingsInterestType').addEventListener('change', updateSavingsInterestTypeUI);
  document.getElementById('savingsHasMembershipFee').addEventListener('change', updateSavingsMembershipFeeUI);

  const debouncedSearch = debounce(() => {
      currentPage = 1;
      displayLoans();
      document.getElementById('clearSearchBtn').style.display = document.getElementById('mainSearchInput').value ? 'block' : 'none';
  }, 300);
  document.getElementById('mainSearchInput').addEventListener('input', debouncedSearch);

  document.getElementById('clearSearchBtn').addEventListener('click', () => { document.getElementById('mainSearchInput').value = ''; document.getElementById('clearSearchBtn').style.display = 'none'; currentPage = 1; displayLoans(); });
  document.getElementById('filterStatus').addEventListener('change', () => { currentPage = 1; displayLoans(); clearForm(); clearScheduleAndSummary(); });
  document.getElementById('filterCurrency').addEventListener('change', () => { currentPage = 1; displayLoans(); clearForm(); clearScheduleAndSummary(); });
  
  document.getElementById('messageTemplateForm').addEventListener('submit', saveMessageTemplate);
  document.getElementById('messageTemplateSelect').addEventListener('change', generateMessage);

  window.addEventListener('mousemove', resetInactivityTimer);
  window.addEventListener('keypress', resetInactivityTimer);
  document.getElementById('pinInput').addEventListener('keyup', e => { if (e.key === 'Enter') checkPin(); });

  document.querySelectorAll('th[data-sortable]').forEach(th => { th.addEventListener('click', () => { const table = th.closest('table'); if (!table) return; const tbody = table.querySelector('tbody'); if (!tbody) return; const column = th.cellIndex; const sortDir = th.dataset.sortDir === 'asc' ? 'desc' : 'asc'; table.querySelectorAll('th').forEach(h => delete h.dataset.sortDir); th.dataset.sortDir = sortDir; Array.from(tbody.querySelectorAll('tr')).sort((a, b) => { let aVal = a.cells[column] ? a.cells[column].textContent.trim() : ''; let bVal = b.cells[column] ? b.cells[column].textContent.trim() : ''; const aNum = parseFloat(aVal.replace(/[^0-9.-]+/g, "")); const bNum = parseFloat(bVal.replace(/[^0-9.-]+/g, "")); if (!isNaN(aNum) && !isNaN(bNum) && aVal.indexOf('/') === -1) { return sortDir === 'asc' ? aNum - bNum : bNum - aNum; } return sortDir === 'asc' ? aVal.localeCompare(bVal, undefined, {numeric: true}) : bVal.localeCompare(aVal, undefined, {numeric: true}); }).forEach(tr => tbody.appendChild(tr)); }); });
}

checkAuth();
