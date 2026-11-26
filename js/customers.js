// =====================================================================
// customers.js — Customer (CRM) CRUD, dropdown population, customer profile tab (avatar, ID card, documents, printing).
// =====================================================================

// ===================== CUSTOMER (CRM) FUNCTIONS =====================
function clearCustomerForm() {
    document.getElementById('customerForm').reset();
    document.getElementById('customerId').value = '';
    document.getElementById('customerFormTitle').innerHTML = '<i class="fas fa-user-plus"></i> បន្ថែមអតិថិជនថ្មី';
    toggleBlacklistFields();
}

function showCustomerForm(customerId = null) {
    if (customerId) {
        const canEdit = currentUser.role === 'admin' || currentUser.role === 'manager';
        if (!canEdit) {
            showToast('Permission Denied.', 'error');
            return;
        }
        loadCustomerIntoForm(customerId);
    } else {
        clearCustomerForm();
    }
    document.getElementById('customerFormCard').style.display = 'block';
    document.getElementById('custName').focus();
}

function hideCustomerForm() {
    document.getElementById('customerFormCard').style.display = 'none';
    clearCustomerForm();
}

async function saveCustomer(e) {
    if (e) e.preventDefault();
    const customerId = document.getElementById('customerId').value;

    if (customerId && currentUser.role !== 'admin' && currentUser.role !== 'manager') {
        showToast('Permission Denied: You cannot update an existing customer.', 'error');
        return;
    }

    const isNewCustomer = !customerId;

    const isBl = document.getElementById('custBlacklisted').checked;
    const customerData = {
        id: customerId || 'CUST-' + Date.now(),
        name: document.getElementById('custName').value.trim(),
        gender: document.getElementById('custGender').value,
        phone: document.getElementById('custPhone').value.trim(),
        idNumber: document.getElementById('custIdNumber').value.trim(),
        village: document.getElementById('custVillage').value.trim(),
        commune: document.getElementById('custCommune').value.trim(),
        district: document.getElementById('custDistrict').value.trim(),
        province: document.getElementById('custProvince').value.trim(),
        residency: document.getElementById('custResidency').value,
        isBlacklisted: isBl,
        blacklistReason: isBl ? document.getElementById('custBlacklistReason').value.trim() : '',
        blacklistDate: isBl ? document.getElementById('custBlacklistDate').value : '',
        blacklistApprover: isBl ? document.getElementById('custBlacklistApprover').value : '',
    };

    if (isNewCustomer) {
        customerData.createdAt = new Date().toISOString();
    }


    if (!customerData.name) {
        showToast('សូមបញ្ចូលឈ្មោះអតិថិជន', 'error');
        return;
    }

    // Duplicate warnings: same ID number (strong) or same phone (families may share one, so only a warning).
    const normPhone = p => String(p || '').replace(/\D/g, '').slice(-8);
    const normId = v => String(v || '').replace(/\s/g, '').toLowerCase();
    const dupId = customerData.idNumber
        ? customers.find(c => c.id !== customerData.id && c.idNumber && normId(c.idNumber) === normId(customerData.idNumber))
        : null;
    if (dupId && !(await customConfirm(`លេខអត្តសញ្ញាណប័ណ្ណនេះមានរួចហើយសម្រាប់អតិថិជន "${dupId.name}"។ តើអ្នកពិតជាចង់រក្សាទុកដដែលឬ?`, 'ការព្រមាន: លេខអត្តសញ្ញាណប័ណ្ណជាន់គ្នា'))) return;
    const dupPhone = normPhone(customerData.phone).length >= 8
        ? customers.find(c => c.id !== customerData.id && normPhone(c.phone) === normPhone(customerData.phone))
        : null;
    if (dupPhone && !(await customConfirm(`លេខទូរសព្ទនេះមានរួចហើយសម្រាប់អតិថិជន "${dupPhone.name}"។ តើអ្នកចង់រក្សាទុកដដែលឬ?`, 'ការព្រមាន: លេខទូរសព្ទជាន់គ្នា'))) return;

    const prevCustomer = customerId ? { ...(customers.find(c => c.id === customerId) || {}) } : null;
    if (customerData.isBlacklisted && (!customerData.blacklistReason || !customerData.blacklistDate || !customerData.blacklistApprover)) {
        showToast('សូមបំពេញមូលហេតុ កាលបរិច្ឆេទ និងអ្នកអនុម័ត សម្រាប់បញ្ជីខ្មៅ', 'error');
        return;
    }
    let unblacklistReason = '';
    if (prevCustomer && prevCustomer.isBlacklisted && !customerData.isBlacklisted) {
        const why = await customPrompt('សូមបញ្ចូលមូលហេតុនៃការដកអតិថិជននេះចេញពីបញ្ជីខ្មៅ', '', 'ដកចេញពីបញ្ជីខ្មៅ');
        if (!why || !why.trim()) {
            showToast('ត្រូវការមូលហេតុ ដើម្បីដកចេញពីបញ្ជីខ្មៅ', 'error');
            return;
        }
        unblacklistReason = why.trim();
    }

    if (customerId) {
        const index = customers.findIndex(c => c.id === customerId);
        if (index > -1) {
            customers[index] = { ...customers[index], ...customerData };
        }
    } else {
        const existingCustomer = customers.find(c => c.name.toLowerCase() === customerData.name.toLowerCase());
        if (existingCustomer) {
            showToast('អតិថិជនដែលមានឈ្មោះនេះមានរួចហើយ។', 'error');
            return;
        }
        customers.push(customerData);
    }

    persistData(LS_KEYS.customers, customers);

    // ----- audit trail -----
    if (isNewCustomer) {
        logCustomerChange(customerData.id, 'Create Customer', { 'ឈ្មោះ': customerData.name, 'លេខទូរសព្ទ': customerData.phone, 'ខេត្ត': customerData.province });
    } else {
        const changes = diffCustomerFields(prevCustomer, customerData);
        if (Object.keys(changes).length) logCustomerChange(customerData.id, 'Update Customer', changes);
    }
    const wasBl = !!(prevCustomer && prevCustomer.isBlacklisted);
    const blInfo = () => ({
        'មូលហេតុ': customerData.blacklistReason,
        'កាលបរិច្ឆេទ': formatDateDMY(customerData.blacklistDate),
        'អ្នកអនុម័ត': getOfficerFullName(customerData.blacklistApprover)
    });
    if (customerData.isBlacklisted && !wasBl) {
        logCustomerChange(customerData.id, 'Blacklisted', blInfo());
    } else if (customerData.isBlacklisted && wasBl &&
        (prevCustomer.blacklistReason !== customerData.blacklistReason || prevCustomer.blacklistDate !== customerData.blacklistDate || prevCustomer.blacklistApprover !== customerData.blacklistApprover)) {
        logCustomerChange(customerData.id, 'Blacklist Updated', blInfo());
    } else if (!customerData.isBlacklisted && wasBl) {
        logCustomerChange(customerData.id, 'Removed from Blacklist', { 'មូលហេតុដកចេញ': unblacklistReason, 'មូលហេតុដាក់បញ្ជីខ្មៅដើម': prevCustomer.blacklistReason || '-' });
    }

    showToast('រក្សាទុកព័ត៌មានអតិថិជនបានជោគជ័យ!', 'success');

    notifyTelegram(`${isNewCustomer ? '👤 <b>អតិថិជនថ្មីត្រូវបានបង្កើត</b>' : '✏️ <b>ព័ត៌មានអតិថិជនត្រូវបានកែប្រែ</b>'}\nឈ្មោះ: ${customerData.name}\nទូរស័ព្ទ: ${customerData.phone || 'N/A'}${customerData.isBlacklisted ? '\n⚠️ ស្ថានភាព: បញ្ជីខ្មៅ (Blacklisted)' : ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);

    hideCustomerForm();
    renderCustomersListTable();
    populateCustomerDropdowns();

    if (isNewCustomer) {
        switchTab('loans');
        document.getElementById('customerSelect').value = customerData.id;
        displaySelectedCustomerInfo();
        showToast('អតិថិជនថ្មីត្រូវបានជ្រើសរើស។ សូមបន្តបំពេញព័ត៌មានកម្ចី។', 'info');
    }
}


function loadCustomerIntoForm(customerId) {
    const customer = customers.find(c => c.id === customerId);
    if (customer) {
        document.getElementById('customerFormCard').style.display = 'block';
        document.getElementById('customerId').value = customer.id;
        document.getElementById('custName').value = customer.name;
        document.getElementById('custGender').value = customer.gender;
        document.getElementById('custPhone').value = customer.phone;
        document.getElementById('custIdNumber').value = customer.idNumber || '';
        document.getElementById('custVillage').value = customer.village;
        document.getElementById('custCommune').value = customer.commune;
        document.getElementById('custDistrict').value = customer.district;
        document.getElementById('custProvince').value = customer.province;
        document.getElementById('custResidency').value = customer.residency || 'resident';
        document.getElementById('custBlacklisted').checked = customer.isBlacklisted || false;
        toggleBlacklistFields();
        document.getElementById('custBlacklistReason').value = customer.blacklistReason || '';
        if (customer.blacklistDate) document.getElementById('custBlacklistDate').value = customer.blacklistDate;
        if (customer.blacklistApprover) document.getElementById('custBlacklistApprover').value = customer.blacklistApprover;
        document.getElementById('customerFormTitle').innerHTML = '<i class="fas fa-user-edit"></i> កែប្រែព័ត៌មានអតិថិជន';
    }
}

async function deleteCustomer(customerId) {
    if (!hasPermission('canDeleteCustomer')) {
        showToast('Permission Denied.', 'error');
        return;
    }
    // No one — not even admin — can delete a customer who still has an unfinished loan.
    // (Force-deleting used to leave the loan pointing at a customerId that no longer exists,
    // which made that loan display as "អតិថិជនមិនស្គាល់" / Unknown Customer forever afterward.)
    // A loan counts as "finished" the same way deleteLoan() does: completed, refinanced,
    // written_off, rejected, or archived.
    const FINISHED_STATUSES = ['completed', 'refinanced', 'written_off', 'rejected'];
    const customerLoans = loans.filter(l => l.customerId === customerId);
    const unfinishedLoans = customerLoans.filter(l => !FINISHED_STATUSES.includes(l.status) && !l.isArchived);
    if (unfinishedLoans.length > 0) {
        showToast(`មិនអាចលុបអតិថិជននេះបានទេ ព្រោះកម្ចី ${unfinishedLoans.map(l => l.loanId).join(', ')} មិនទាន់បញ្ចប់។ សូមបញ្ចប់ ឬ Archive កម្ចីទាំងអស់ជាមុនសិន។`, 'error');
        return;
    }

    // All of this customer's loans (if any) are already finished/archived, so deleting them
    // along with the customer leaves no dangling references.
    const loanIdsToDelete = customerLoans.map(l => l.loanId);
    const confirmMsg = loanIdsToDelete.length > 0
        ? `អតិថិជននេះមានកម្ចី ${loanIdsToDelete.length} (${loanIdsToDelete.join(', ')}) ដែលបានបញ្ចប់/Archive រួច។ តើអ្នកពិតជាចង់លុបអតិថិជននេះ ព្រមទាំងកម្ចីទាំងអស់នេះជាអចិន្ត្រៃយ៍មែនទេ?`
        : 'តើអ្នកពិតជាចង់លុបអតិថិជននេះមែនទេ?';

    if (await customConfirm(confirmMsg)) {
        const deletedCust = customers.find(c => c.id === customerId);
        customers = customers.filter(c => c.id !== customerId);

        loanIdsToDelete.forEach(id => {
            loans = loans.filter(l => l.loanId !== id);
            Object.keys(payments).forEach(key => { if (key.startsWith(id + '-')) delete payments[key]; });
            collaterals = collaterals.filter(c => c.loanId !== id);
            guarantors = guarantors.filter(g => g.loanId !== id);
            delete loanHistory[id];
            clearScheduleCache(id);
        });

        persistData(LS_KEYS.customers, customers);
        logCustomerChange(customerId, 'Delete Customer', { 'ឈ្មោះ': deletedCust ? deletedCust.name : customerId, 'លេខទូរសព្ទ': deletedCust ? deletedCust.phone : '', 'កម្ចីដែលបានលុប': loanIdsToDelete.join(', ') || '-' });
        if (loanIdsToDelete.length > 0) {
            persistData(LS_KEYS.loans, loans);
            persistData(LS_KEYS.payments, payments);
            persistData(LS_KEYS.collaterals, collaterals);
            persistData(LS_KEYS.guarantors, guarantors);
            persistData(LS_KEYS.loanHistory, loanHistory);
            displayLoans();
        }

        renderCustomersListTable();
        populateCustomerDropdowns();
        showToast('អតិថិជន និងកម្ចីពាក់ព័ន្ធត្រូវបានលុបចោលដោយជោគជ័យ។', 'success');
        notifyTelegram(`🗑️ <b>អតិថិជនត្រូវបានលុប</b>\nឈ្មោះ: ${deletedCust ? deletedCust.name : customerId}${loanIdsToDelete.length > 0 ? `\nកម្ចីដែលបានលុបជាមួយ: ${loanIdsToDelete.join(', ')}` : ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    }
}

// Customer status shown in the customers list, derived from the customer's loans.
// Priority: blacklist > written-off loan > overdue loan > active loan > all loans completed > no loans.
// Loans that are pending/rejected (never disbursed) or refinanced (replaced by a newer loan) are ignored.
function getCustomerLoanStatus(customer) {
    if (customer.isBlacklisted) return { key: 'blacklisted', text: 'បញ្ជីខ្មៅ', cls: 'status-unpaid' };
    const keys = loans
        .filter(l => l.customerId === customer.id)
        .map(l => getLoanComputedStatus(l).key)
        .filter(k => k !== 'pending' && k !== 'rejected' && k !== 'refinanced' && k !== 'unknown');
    if (keys.length === 0) return { key: 'none', text: 'គ្មានកម្ចី', cls: 'status-pending' };
    if (keys.includes('written_off')) return { key: 'written_off', text: 'កម្ចីបំណុលមិនអាចសងបាន', cls: 'status-written_off' };
    if (keys.includes('overdue')) return { key: 'overdue', text: 'មានការយឺត', cls: 'status-overdue' };
    if (keys.includes('active')) return { key: 'active', text: 'កំពុងមានកម្ចី', cls: 'status-active' };
    return { key: 'completed', text: 'បានបញ្ចប់កម្ចី', cls: 'status-completed' };
}

// Risk classification by the customer's longest days-past-due. Edit the buckets to match your
// institution's / regulator's policy (these are generic aging buckets, not a legal standard).
const CUSTOMER_RISK_BUCKETS = [
    { key: 'normal',      max: 0,        label: 'ធម្មតា',       range: '0 ថ្ងៃ',     color: 'var(--success)' },
    { key: 'watch',       max: 30,       label: 'តាមដាន',       range: '1-30 ថ្ងៃ',  color: 'var(--warning, #e0a800)' },
    { key: 'substandard', max: 60,       label: 'ក្រោមស្តង់ដា', range: '31-60 ថ្ងៃ', color: '#fd7e14' },
    { key: 'doubtful',    max: 90,       label: 'សង្ស័យ',       range: '61-90 ថ្ងៃ', color: 'var(--danger)' },
    { key: 'loss',        max: Infinity, label: 'បាត់បង់',      range: '>90 ថ្ងៃ',   color: '#7b1113' }
];

function getCustomerRisk(sum) {
    if (!sum.activeCount) return { key: 'none', label: '-', range: '', color: null };
    return CUSTOMER_RISK_BUCKETS.find(b => sum.maxDaysLate <= b.max);
}

// KYC completeness: which required items are still missing for this customer.
function getCustomerKycMissing(c) {
    const missing = [];
    if (!c.phone) missing.push('លេខទូរសព្ទ');
    if (!c.idNumber) missing.push('លេខអត្តសញ្ញាណប័ណ្ណ');
    if (!c.idCardFront) missing.push('រូបអត្តសញ្ញាណប័ណ្ណមុខ');
    if (!c.idCardBack) missing.push('រូបអត្តសញ្ញាណប័ណ្ណក្រោយ');
    if (!c.province) missing.push('ខេត្ត');
    return missing;
}

// Loan exposure of one customer, from their currently open loans (active or overdue):
// count, outstanding amount per currency, earliest unpaid due date, and the longest days-past-due.
function getCustomerLoanSummary(customer) {
    const openLoans = loans.filter(l => l.customerId === customer.id).filter(l => {
        const k = getLoanComputedStatus(l).key;
        return k === 'active' || k === 'overdue';
    });
    const outstanding = {};
    let nextDue = null;
    let maxDaysLate = 0;
    openLoans.forEach(l => {
        const schedule = buildSchedule(l);
        const remaining = schedule.reduce((sum, p) => sum + (p.remainingAmount || 0), 0);
        outstanding[l.currency] = (outstanding[l.currency] || 0) + remaining;
        schedule.forEach(p => {
            if (p.status === 'paid') return;
            if (!nextDue || p.date < nextDue) nextDue = p.date;
            if ((p.daysLate || 0) > maxDaysLate) maxDaysLate = p.daysLate;
        });
    });
    return { activeCount: openLoans.length, outstanding, nextDue, maxDaysLate };
}

// Rows for the customers list after applying the search box, status/province filters and sort order.
function getFilteredCustomerRows() {
    const q = ((document.getElementById('custSearch') || {}).value || '').trim().toLowerCase();
    const statusFilter = (document.getElementById('custFilterStatus') || {}).value || 'all';
    const provinceFilter = (document.getElementById('custFilterProvince') || {}).value || 'all';
    const sortBy = (document.getElementById('custSort') || {}).value || 'name';
    const kycFilter = (document.getElementById('custFilterKyc') || {}).value || 'all';
    const riskFilter = (document.getElementById('custFilterRisk') || {}).value || 'all';

    const rows = customers
        .map(cust => {
            const sum = getCustomerLoanSummary(cust);
            return { cust, status: getCustomerLoanStatus(cust), sum, risk: getCustomerRisk(sum), kycMissing: getCustomerKycMissing(cust) };
        })
        .filter(r => {
            if (q && !`${r.cust.name} ${r.cust.phone || ''} ${r.cust.province || ''} ${r.cust.idNumber || ''}`.toLowerCase().includes(q)) return false;
            if (kycFilter === 'complete' && r.kycMissing.length > 0) return false;
            if (kycFilter === 'incomplete' && r.kycMissing.length === 0) return false;
            if (riskFilter !== 'all' && r.risk.key !== riskFilter) return false;
            if (statusFilter !== 'all' && r.status.key !== statusFilter) return false;
            if (provinceFilter !== 'all' && (r.cust.province || '') !== provinceFilter) return false;
            return true;
        });

    const byName = (a, b) => a.cust.name.localeCompare(b.cust.name);
    rows.sort((a, b) => {
        if (sortBy === 'daysLate') return (b.sum.maxDaysLate - a.sum.maxDaysLate) || byName(a, b);
        if (sortBy === 'activeCount') return (b.sum.activeCount - a.sum.activeCount) || byName(a, b);
        if (sortBy === 'nextDue') {
            const x = a.sum.nextDue || '9999-12-31', y = b.sum.nextDue || '9999-12-31';
            return x.localeCompare(y) || byName(a, b);
        }
        return byName(a, b);
    });
    return rows;
}

function populateCustomerProvinceFilter() {
    const sel = document.getElementById('custFilterProvince');
    if (!sel) return;
    const current = sel.value || 'all';
    const provinces = [...new Set(customers.map(c => c.province).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = '<option value="all">ខេត្តទាំងអស់</option>' + provinces.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    sel.value = provinces.includes(current) ? current : 'all';
}

function renderCustomersListTable() {
    const tbody = document.getElementById('customersListTableBody');
    tbody.innerHTML = '';
    populateCustomerProvinceFilter();
    const canEdit = currentUser.role === 'admin' || currentUser.role === 'manager';
    const rows = getFilteredCustomerRows();
    const countEl = document.getElementById('custListCount');
    if (countEl) countEl.textContent = `${rows.length} / ${customers.length}`;
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#888">មិនមានអតិថិជន</td></tr>';
        return;
    }
    const todayISO = formatDateISO(new Date());
    const fragment = document.createDocumentFragment();
    rows.forEach(({ cust, status, sum, risk, kycMissing }, index) => {
        const tr = document.createElement('tr');
        const outstandingHtml = Object.keys(sum.outstanding).map(cur => fmtMoney(sum.outstanding[cur], cur)).join('<br>') || '-';
        const nextDueHtml = sum.nextDue
            ? `<span style="${sum.nextDue < todayISO ? 'color:var(--danger);font-weight:bold' : ''}">${formatDateDMY(sum.nextDue)}</span>`
            : '-';
        const daysLateHtml = sum.maxDaysLate > 0
            ? `<span style="color:var(--danger);font-weight:bold">${sum.maxDaysLate} ថ្ងៃ</span>`
            : '-';

        const kycHtml = kycMissing.length
            ? `<br><small style="color:var(--warning, #e0a800)" title="ព័ត៌មាន KYC ខ្វះ"><i class="fas fa-exclamation-circle"></i> ខ្វះ ${kycMissing.length}: ${esc(kycMissing.join(', '))}</small>`
            : '';
        const riskHtml = risk.color
            ? `<span class="status-badge" title="${esc(risk.range)}" style="background:${risk.color};color:#fff;padding:2px 10px;border-radius:12px;">${risk.label}</span>`
            : '-';

        const actionButtons = canEdit ? `
            <td class="actions">
                <button class="btn btn-muted btn-sm" title="ប្រវត្តិ" onclick="openCustomerHistory('${esc(cust.id)}')"><i class="fas fa-history"></i></button>
                <button class="btn btn-info btn-sm" onclick="showCustomerForm('${esc(cust.id)}')"><i class="fas fa-edit"></i> កែប្រែ</button>
                <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${esc(cust.id)}')"><i class="fas fa-trash-alt"></i> លុប</button>
            </td>` : '<td>No Actions</td>';

        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>${esc(cust.name)}${kycHtml}</td>
            <td>${esc(cust.gender)}</td>
            <td>${esc(cust.phone)}</td>
            <td>${esc(cust.province)}</td>
            <td class="status-cell"><span class="status-badge ${status.cls}">${status.text}</span></td>
            <td class="center">${sum.activeCount || '-'}</td>
            <td class="right">${outstandingHtml}</td>
            <td>${nextDueHtml}</td>
            <td class="right">${daysLateHtml}</td>
            <td class="center">${riskHtml}</td>
            ${actionButtons}
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

// Exports exactly what the list currently shows (respecting search / filters / sort).
function exportCustomersToExcel() {
    if (typeof XLSX === 'undefined') { showToast('មិនអាចផ្ទុក library Excel (XLSX) បានទេ', 'error'); return; }
    const rows = getFilteredCustomerRows();
    if (rows.length === 0) { showToast('គ្មានទិន្នន័យសម្រាប់នាំចេញ', 'error'); return; }
    const data = rows.map((r, i) => ({
        'ល.រ': i + 1,
        'ឈ្មោះអតិថិជន': r.cust.name,
        'ភេទ': r.cust.gender,
        'លេខទូរសព្ទ': r.cust.phone || '',
        'លេខអត្តសញ្ញាណប័ណ្ណ': r.cust.idNumber || '',
        'ខេត្ត': r.cust.province || '',
        'ស្ថានភាព': r.status.text,
        'កម្ចីសកម្ម': r.sum.activeCount,
        'សរុបនៅសល់ (USD)': Number((r.sum.outstanding.USD || 0).toFixed(2)),
        'សរុបនៅសល់ (KHR)': Math.round(r.sum.outstanding.KHR || 0),
        'ថ្ងៃបង់បន្ទាប់': r.sum.nextDue ? formatDateDMY(r.sum.nextDue) : '',
        'ថ្ងៃយឺត': r.sum.maxDaysLate,
        'ចំណាត់ថ្នាក់': r.risk.key === 'none' ? '' : r.risk.label,
        'KYC ខ្វះ': r.kycMissing.join(', ')
    }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Customers');
    XLSX.writeFile(workbook, `Customers_${formatDateISO(new Date())}.xlsx`);
}

function populateCustomerDropdowns() {
    const loanSelect = document.getElementById('customerSelect');
    const clientAccountSelect = document.getElementById('clientAccountSelect');
    const profileSelect = document.getElementById('customerProfileSelect');

    const sortedCustomers = [...customers].sort((a, b) => a.name.localeCompare(b.name));
    
    [loanSelect, clientAccountSelect, profileSelect].forEach(select => {
        if (select) {
            const selectedValue = select.value;
            select.innerHTML = `<option value="">-- សូមជ្រើសរើស --</option>`;
            sortedCustomers.forEach(cust => {
                let suffix = cust.isBlacklisted ? ' (បញ្ជីខ្មៅ)' : '';
                select.innerHTML += `<option value="${esc(cust.id)}">${esc(cust.name)}${esc(suffix)}</option>`;
            });
            select.value = selectedValue;
        }
    });
}

function populateLoanProductDropdown() {
    const select = document.getElementById('loanProductSelect');
    if (!select) return;
    const firstOption = select.options[0];
    select.innerHTML = '';
    select.appendChild(firstOption);

    loanProducts.sort((a, b) => a.name.localeCompare(b.name)).forEach(product => {
        const option = document.createElement('option');
        option.value = product.id;
        option.textContent = product.name;
        select.appendChild(option);
    });
}

function populateExpenseCategoryDropdown() {
    const select = document.getElementById('expenseCategory');
    if (!select) return;

    select.innerHTML = ''; // Clear existing options

    // Add a default/placeholder option
    const defaultOption = document.createElement('option');
    defaultOption.value = "";
    defaultOption.textContent = "-- សូមជ្រើសរើសប្រភេទ --";
    select.appendChild(defaultOption);

    // Populate from settings
    if (appSettings.expenseCategories && appSettings.expenseCategories.length > 0) {
        appSettings.expenseCategories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            select.appendChild(option);
        });
    }
}

function displaySelectedCustomerInfo() {
    const customerId = document.getElementById('customerSelect').value;
    const infoDiv = document.getElementById('selectedCustomerInfo');
    const customer = getCustomer(customerId);

    if (customer && customer.id) {
        if (customer.isBlacklisted) {
            showToast('ការព្រមាន៖ អតិថិជននេះស្ថិតនៅក្នុងបញ្ជីខ្មៅ។' + (customer.blacklistReason ? ` មូលហេតុ៖ ${customer.blacklistReason}` : ''), 'error');
        }
        infoDiv.innerHTML = `
            <strong><i class="fas fa-venus-mars"></i> ភេទ:</strong> ${esc(customer.gender)} | 
            <strong><i class="fas fa-phone"></i> ទូរស័ព្ទ:</strong> ${esc(customer.phone || 'N/A')} | 
            <strong><i class="fas fa-map-marked-alt"></i> អាសយដ្ឋាន:</strong> ${esc(customer.village || '')}, ${esc(customer.commune || '')}, ${esc(customer.province || '')}
        `;
    } else {
        infoDiv.innerHTML = '';
    }
}

// ===================== CUSTOMER PROFILE TAB (FIX) =====================
async function renderCustomerProfile() {
    const customerId = document.getElementById('customerProfileSelect').value;
    const contentDiv = document.getElementById('customerProfileContent');
    
    if (!customerId) {
        contentDiv.style.display = 'none';
        return;
    }

    const customer = getCustomer(customerId);
    if (!customer || !customer.id) {
        contentDiv.style.display = 'none';
        return;
    }
    
    contentDiv.style.display = 'grid';

    // Populate details
    document.getElementById('profileAvatarPreview').src = DEFAULT_AVATAR_SRC;
    document.getElementById('idCardFrontPreview').src = '';
    document.getElementById('idCardBackPreview').src = '';
    resolveCustomerImageUrl(customer.avatar).then(src => { document.getElementById('profileAvatarPreview').src = src || DEFAULT_AVATAR_SRC; });
    resolveCustomerImageUrl(customer.idCardFront).then(src => { document.getElementById('idCardFrontPreview').src = src; });
    resolveCustomerImageUrl(customer.idCardBack).then(src => { document.getElementById('idCardBackPreview').src = src; });
    document.getElementById('profileDetailName').textContent = customer.name;
    document.getElementById('profileDetailGender').textContent = customer.gender;
    document.getElementById('profileDetailPhone').textContent = customer.phone || 'N/A';
    document.getElementById('profileDetailAddress').textContent = `${customer.village}, ${customer.commune}, ${customer.district}, ${customer.province}`;
    document.getElementById('profileDetailCreated').textContent = formatDateDMY(customer.createdAt);
    // Profile shows BOTH: the blacklist flag (if set) and the loan-based status, so a blacklisted
    // customer's loan situation is not hidden.
    const loanStatus = getCustomerLoanStatus({ ...customer, isBlacklisted: false });
    const blacklistBadge = customer.isBlacklisted ? '<span class="status-badge status-unpaid">បញ្ជីខ្មៅ</span> ' : '';
    const blDetails = customer.isBlacklisted
        ? `<div style="font-size:12px;margin-top:4px;opacity:.85">មូលហេតុ: ${esc(customer.blacklistReason || '-')} | កាលបរិច្ឆេទ: ${customer.blacklistDate ? formatDateDMY(customer.blacklistDate) : '-'} | អ្នកអនុម័ត: ${esc(customer.blacklistApprover ? getOfficerFullName(customer.blacklistApprover) : '-')}</div>`
        : '';
    document.getElementById('profileDetailStatus').innerHTML = `${blacklistBadge}<span class="status-badge ${loanStatus.cls}">${loanStatus.text}</span>${blDetails}`;

    // Populate loans table
    const loansBody = document.getElementById('profileLoansTableBody');
    loansBody.innerHTML = '';
    const customerLoans = loans.filter(l => l.customerId === customerId);
    if (customerLoans.length > 0) {
        customerLoans.forEach(loan => {
            const statusInfo = getLoanComputedStatus(loan);
            const schedule = buildSchedule(loan);
            const remaining = schedule.reduce((sum, inst) => sum + (inst.remainingAmount || 0), 0);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${esc(loan.loanId)}</td>
                <td class="right">${fmtMoney(loan.loanAmount, loan.currency)}</td>
                <td>${formatDateDMY(loan.loanDate)}</td>
                <td class="right">${fmtMoney(remaining, loan.currency)}</td>
                <td class="status-cell"><span class="status-badge status-${statusInfo.key}">${statusInfo.text}</span></td>
            `;
            loansBody.appendChild(tr);
        });
    } else {
        loansBody.innerHTML = `<tr><td colspan="5" class="center">No loans found.</td></tr>`;
    }

    renderCustomerDocuments(customerId);
}

async function handleProfileAvatarUpload(event) {
    const customerId = document.getElementById('customerProfileSelect').value;
    if (!customerId) {
        showToast('Please select a customer first.', 'error');
        return;
    }
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    try {
        const storagePath = await cloudUploadCustomerImage(customerId, file, 'avatar');
        const customerIndex = customers.findIndex(c => c.id === customerId);
        if (customerIndex > -1) {
            customers[customerIndex].avatar = storagePath;
            persistData(LS_KEYS.customers, customers);
            document.getElementById('profileAvatarPreview').src = await resolveCustomerImageUrl(storagePath) || DEFAULT_AVATAR_SRC;
            showToast('Avatar updated.', 'success');
        }
    } catch (e) {
        console.error('Error uploading avatar:', e);
        showToast(`ផ្ទុករូបភាពបរាជ័យ: ${String(e.message || e)}`, 'error');
    }
}

async function handleIdCardUpload(side, event) {
    const customerId = document.getElementById('customerProfileSelect').value;
    if (!customerId) { showToast('សូមជ្រើសរើសអតិថិជនជាមុនសិន', 'error'); return; }
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    const previewId = side === 'front' ? 'idCardFrontPreview' : 'idCardBackPreview';
    const fieldKey = side === 'front' ? 'idCardFront' : 'idCardBack';
    try {
        const storagePath = await cloudUploadCustomerImage(customerId, file, side === 'front' ? 'id_front' : 'id_back');
        const customerIndex = customers.findIndex(c => c.id === customerId);
        if (customerIndex > -1) {
            customers[customerIndex][fieldKey] = storagePath;
            persistData(LS_KEYS.customers, customers);
            document.getElementById(previewId).src = await resolveCustomerImageUrl(storagePath);
            showToast(side === 'front' ? 'រូបថតអត្តសញ្ញាណប័ណ្ណ (មុខ) ត្រូវបានរក្សាទុក។' : 'រូបថតអត្តសញ្ញាណប័ណ្ណ (ក្រោយ) ត្រូវបានរក្សាទុក។', 'success');
        }
    } catch (e) {
        console.error('Error uploading ID card image:', e);
        showToast(`ផ្ទុករូបភាពបរាជ័យ: ${String(e.message || e)}`, 'error');
    }
}

// Customer documents now live in the Supabase Storage bucket "customer-documents" (the file
// bytes) plus the customer_documents table (the metadata row pointing at it) — see schema.sql
// and db.js's cloudUploadCustomerDocument/cloudListCustomerDocuments/
// cloudGetCustomerDocumentUrl/cloudDeleteCustomerDocument. Nothing is written to IndexedDB or
// localStorage anymore.
async function handleCustomerDocumentUpload(event) {
    const customerId = document.getElementById('customerProfileSelect').value;
    if (!customerId) { showToast("Please select a customer before uploading.", "error"); return; }

    const files = Array.from(event.target.files);
    const category = document.getElementById('customerDocumentCategory').value;
    document.getElementById('customerDocumentInput').value = "";

    for (const file of files) {
        try {
            await cloudUploadCustomerDocument(customerId, file, category);
        } catch (e) {
            console.error('Error uploading document:', e);
            showToast(`ផ្ទុកឯកសារ "${file.name}" បរាជ័យ: ${String(e.message || e)}`, 'error');
        }
    }
    await renderCustomerDocuments(customerId);
}

async function renderCustomerDocuments(customerId) {
    const listDiv = document.getElementById('customerDocumentList');
    listDiv.innerHTML = '';
    if (!customerId) return;

    const CATEGORY_LABELS = { loan_contract: 'ច្បាប់កម្ចី', savings: 'សៀវភៅ/ឯកសារសន្សំ', other: 'ផ្សេងៗ' };
    try {
        const files = await cloudListCustomerDocuments(customerId);
        if (files.length === 0) {
            listDiv.innerHTML = '<p style="font-size:12px;color:#777;text-align:center;">No documents attached.</p>';
            return;
        }
        const groups = {};
        files.forEach(f => {
            const cat = f.category || 'other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(f);
        });
        Object.keys(groups).forEach(cat => {
            const header = document.createElement('div');
            header.style.cssText = 'font-size:12px; font-weight:600; margin:8px 0 4px; color:var(--primary);';
            header.textContent = CATEGORY_LABELS[cat] || cat;
            listDiv.appendChild(header);
            groups[cat].forEach(file => {
                const item = document.createElement('div');
                item.className = 'attachment-item';
                item.innerHTML = `<span><i class="fas fa-file"></i> ${esc(file.file_name)}</span><div>
                    <button class="btn btn-info btn-sm" onclick="viewCustomerDocument('${escJsAttr(file.storage_path)}')"><i class="fas fa-eye"></i></button>
                    <button class="btn btn-danger btn-sm" style="margin-left:4px;" onclick="deleteCustomerDocument('${escJsAttr(file.id)}', '${escJsAttr(file.storage_path)}', '${escJsAttr(customerId)}')"><i class="fas fa-trash-alt"></i></button>
                </div>`;
                listDiv.appendChild(item);
            });
        });
    } catch (e) {
        console.error('Could not render customer documents:', e);
        listDiv.innerHTML = '<p style="font-size:12px;color:#c0392b;text-align:center;">មិនអាចទាញយកឯកសារបានទេ</p>';
    }
}

async function viewCustomerDocument(storagePath) {
    try {
        const url = await cloudGetCustomerDocumentUrl(storagePath);
        window.open(url, '_blank');
    } catch (e) {
        console.error('Could not open document:', e);
        showToast('មិនអាចបើកឯកសារបានទេ', 'error');
    }
}

async function deleteCustomerDocument(fileId, storagePath, customerId) {
    if (await customConfirm("Are you sure you want to delete this document?")) {
        try {
            await cloudDeleteCustomerDocument(fileId, storagePath);
            await renderCustomerDocuments(customerId);
        } catch (e) {
            console.error('Could not delete document:', e);
            showToast('លុបឯកសារបរាជ័យ', 'error');
        }
    }
}

async function printCustomerProfile() {
    const customerId = document.getElementById('customerProfileSelect').value;
    if (!customerId) { showToast('សូមជ្រើសរើសអតិថិជនជាមុនសិន', 'error'); return; }
    const customer = getCustomer(customerId);
    const avatarSrc = await resolveCustomerImageUrl(customer.avatar) || DEFAULT_AVATAR_SRC;
    const customerLoans = loans.filter(l => l.customerId === customerId);
    const loanRows = customerLoans.map(loan => {
        const statusInfo = getLoanComputedStatus(loan);
        const schedule = buildSchedule(loan);
        const remaining = schedule.reduce((sum, inst) => sum + (inst.remainingAmount || 0), 0);
        return `<tr>
            <td>${esc(loan.loanId)}</td>
            <td>${fmtMoney(loan.loanAmount, loan.currency)}</td>
            <td>${formatDateDMY(loan.loanDate)}</td>
            <td>${fmtMoney(remaining, loan.currency)}</td>
            <td>${esc(statusInfo.text)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;">គ្មានកម្ចី</td></tr>';

    const win = window.open('', '_blank');
    if (!win) { showToast('សូមអនុញ្ញាត Pop-up ដើម្បី Print', 'error'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>ប្រវត្តិរូបអតិថិជន - ${esc(customer.name)}</title>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Khmer OS', Arial, sans-serif; padding: 24px; color:#222; }
        h2 { text-align:center; margin-bottom: 4px; }
        .avatar { display:block; margin:0 auto 12px; width:110px; height:110px; object-fit:cover; border-radius:50%; border:2px solid #ccc; }
        table { width:100%; border-collapse:collapse; margin-top:8px; }
        th, td { border:1px solid #999; padding:6px 8px; font-size:13px; text-align:left; }
        th { background:#eee; }
        .info-grid { display:grid; grid-template-columns: 140px 1fr; row-gap:6px; max-width:500px; margin:12px auto; font-size:14px; }
        .info-grid div:nth-child(odd) { font-weight:600; }
    </style>
    </head><body>
        <img class="avatar" src="${esc(avatarSrc)}">
        <h2>${esc(customer.name)}</h2>
        <div class="info-grid">
            <div>ភេទ</div><div>${esc(customer.gender || '')}</div>
            <div>លេខទូរសព្ទ</div><div>${esc(customer.phone || '')}</div>
            <div>អាសយដ្ឋាន</div><div>${esc(customer.village)}, ${esc(customer.commune)}, ${esc(customer.district)}, ${esc(customer.province)}</div>
            <div>បានបង្កើតនៅ</div><div>${esc(formatDateDMY(customer.createdAt))}</div>
        </div>
        <h4 style="margin-top:20px;">ប្រវត្តិរូបកម្ចី</h4>
        <table>
            <thead><tr><th>ID</th><th>ចំនួន</th><th>កាលបរិច្ឆេទ</th><th>នៅសល់</th><th>ស្ថានភាព</th></tr></thead>
            <tbody>${loanRows}</tbody>
        </table>
        <script>window.onload = () => { window.print(); };<\/script>
    </body></html>`);
    win.document.close();
}

async function printCustomerIdCard() {
    const customerId = document.getElementById('customerProfileSelect').value;
    if (!customerId) { showToast('សូមជ្រើសរើសអតិថិជនជាមុនសិន', 'error'); return; }
    const customer = getCustomer(customerId);
    const [avatarSrc, idFrontSrc, idBackSrc] = await Promise.all([
        resolveCustomerImageUrl(customer.avatar).then(s => s || DEFAULT_AVATAR_SRC),
        resolveCustomerImageUrl(customer.idCardFront),
        resolveCustomerImageUrl(customer.idCardBack)
    ]);

    const win = window.open('', '_blank');
    if (!win) { showToast('សូមអនុញ្ញាត Pop-up ដើម្បី Print', 'error'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>Customer Card - ${esc(customer.name)}</title>
    <meta charset="UTF-8">
    <style>
        @page { size: 85.6mm 53.98mm; margin: 0; }
        body { margin:0; font-family: 'Khmer OS', Arial, sans-serif; }
        .card { width:85.6mm; height:53.98mm; box-sizing:border-box; border:1px solid #999; padding:4mm; display:flex; gap:3mm; page-break-after: always; }
        .card:last-child { page-break-after: auto; }
        .card .avatar { width:20mm; height:24mm; object-fit:cover; border:1px solid #ccc; flex-shrink:0; }
        .card .details { font-size:9px; line-height:1.5; overflow:hidden; }
        .card .details .name { font-size:12px; font-weight:bold; margin-bottom:2px; }
        .header { font-size:8px; font-weight:bold; text-align:center; margin-bottom:2mm; }
        .idphoto { height:100%; object-fit:cover; }
    </style>
    </head><body>
        <div class="card">
            <img class="avatar" src="${esc(avatarSrc)}">
            <div class="details">
                <div class="header">កាតអតិថិជន / CUSTOMER CARD</div>
                <div class="name">${esc(customer.name)}</div>
                <div>ភេទ: ${esc(customer.gender || '')}</div>
                <div>ទូរស័ព្ទ: ${esc(customer.phone || '')}</div>
                <div>អាសយដ្ឋាន: ${esc(customer.village)}, ${esc(customer.commune)}</div>
                <div>${esc(customer.district)}, ${esc(customer.province)}</div>
                <div>ID: ${esc(customer.id)}</div>
            </div>
        </div>
        ${(idFrontSrc || idBackSrc) ? `<div class="card">
            ${idFrontSrc ? `<img class="idphoto" style="width:50%;" src="${esc(idFrontSrc)}">` : ''}
            ${idBackSrc ? `<img class="idphoto" style="width:50%;" src="${esc(idBackSrc)}">` : ''}
        </div>` : ''}
        <script>window.onload = () => { window.print(); };<\/script>
    </body></html>`);
    win.document.close();
}


// =====================================================================
// Blacklist details (reason / date / approver) + customer audit trail
// =====================================================================
function toggleBlacklistFields() {
    const checkbox = document.getElementById('custBlacklisted');
    const box = document.getElementById('custBlacklistDetails');
    if (!checkbox || !box) return;
    box.style.display = checkbox.checked ? '' : 'none';
    if (!checkbox.checked) return;

    const sel = document.getElementById('custBlacklistApprover');
    if (sel.options.length === 0) {
        const approvers = getUsers().filter(u => u.role === 'admin' || u.role === 'manager');
        sel.innerHTML = '<option value="">-- ជ្រើសរើសអ្នកអនុម័ត --</option>' +
            approvers.map(u => `<option value="${esc(u.username)}">${esc(u.fullName || u.username)}</option>`).join('');
    }
    const dateEl = document.getElementById('custBlacklistDate');
    if (!dateEl.value) dateEl.value = formatDateISO(new Date());
    if (!sel.value && currentUser && (currentUser.role === 'admin' || currentUser.role === 'manager')) sel.value = currentUser.username;
}

const CUSTOMER_AUDIT_FIELDS = [
    ['name', 'ឈ្មោះ'], ['gender', 'ភេទ'], ['phone', 'លេខទូរសព្ទ'], ['idNumber', 'លេខអត្តសញ្ញាណប័ណ្ណ'], ['village', 'ភូមិ'],
    ['commune', 'ឃុំ'], ['district', 'ស្រុក'], ['province', 'ខេត្ត'], ['residency', 'និវាសនជន']
];

function diffCustomerFields(before, after) {
    const changes = {};
    CUSTOMER_AUDIT_FIELDS.forEach(([field, label]) => {
        const a = (before && before[field]) || '';
        const b = (after && after[field]) || '';
        if (a !== b) changes[label] = `${a || '-'} → ${b || '-'}`;
    });
    return changes;
}

function logCustomerChange(customerId, action, details = {}) {
    if (!customerId) return;
    if (!customerHistory[customerId]) customerHistory[customerId] = [];
    customerHistory[customerId].unshift({
        id: genId(),
        ts: new Date().toISOString(),
        user: currentUser ? currentUser.username : 'System',
        action,
        details
    });
    persistData(LS_KEYS.customerHistory, customerHistory);
}

const CUSTOMER_ACTION_LABELS = {
    'Create Customer': 'បង្កើតអតិថិជន',
    'Update Customer': 'កែប្រែព័ត៌មាន',
    'Blacklisted': 'ដាក់ក្នុងបញ្ជីខ្មៅ',
    'Blacklist Updated': 'កែព័ត៌មានបញ្ជីខ្មៅ',
    'Removed from Blacklist': 'ដកចេញពីបញ្ជីខ្មៅ',
    'Delete Customer': 'លុបអតិថិជន'
};

function openCustomerHistory(customerId) {
    const cust = customers.find(c => c.id === customerId);
    document.getElementById('customerHistoryName').textContent = cust ? cust.name : customerId;
    const tbody = document.getElementById('customerHistoryTableBody');
    const list = [...(customerHistory[customerId] || [])].sort((a, b) => new Date(b.ts) - new Date(a.ts));
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="center">មិនទាន់មានប្រវត្តិកត់ត្រា (ប្រវត្តិចាប់ផ្តើមកត់ពីពេលមុខងារនេះដំណើរការ)</td></tr>';
    } else {
        tbody.innerHTML = list.map(log => `
            <tr>
                <td>${new Date(log.ts).toLocaleString('en-GB')}</td>
                <td>${esc(getOfficerFullName(log.user))}</td>
                <td>${esc(CUSTOMER_ACTION_LABELS[log.action] || log.action)}</td>
                <td class="history-detail-cell">${renderHistoryDetailsTable(log.details)}</td>
            </tr>`).join('');
    }
    document.getElementById('customerHistoryModal').style.display = 'flex';
}

function closeCustomerHistory() {
    document.getElementById('customerHistoryModal').style.display = 'none';
}
