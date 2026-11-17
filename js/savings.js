// =====================================================================
// savings.js — Standalone savings accounts module: schedules, deposits, withdrawals, printing/export.
// =====================================================================

// ===================== SAVINGS MODULE (Standalone - independent of Loans) =====================
// A savings account is a fixed, equal-installment deposit plan. It does NOT link to the Loans
// customer database; the customer's name/phone are entered freely on the account. An account may
// optionally earn interest (monthly or annual rate) on the actual balance paid in so far, which
// may in turn have a withholding tax rate deducted from it, and/or charge a one-time upfront
// membership fee recorded separately from the deposit schedule.

// The "ប្រាក់ចូលរួមមុន" field (stored as membershipFeeAmount) is the customer's INITIAL DEPOSIT.
// It counts toward the savings goal, so the remaining months are computed from (goal - initial).
function getSavingsInitialDeposit(account) {
    if (!account || !account.hasMembershipFee) return 0;
    return Math.max(0, Number(account.membershipFeeAmount) || 0);
}

function calcSavingsTerm(goal, monthly, initial = 0) {
    const remaining = Math.max(0, Number(goal) - Number(initial || 0));
    return Math.max(1, Math.ceil(remaining / Number(monthly)));
}

function getSavingsMonthlyRate(account) {
    const rate = Number(account.interestRate) || 0;
    if (account.interestType === 'monthly') return rate / 100;
    if (account.interestType === 'annual') return rate / 100 / 12;
    return 0;
}

async function generateNewSavingsId() {
    // ID is based on the number of savings accounts that currently exist for this year
    // (rather than an ever-increasing counter). This means the numbering shrinks/restarts
    // as accounts are deleted, at the cost of a deleted account's number possibly being
    // reused later — accepted trade-off per user request.
    const year = new Date().getFullYear();
    let nextNum = savingsAccounts.filter(a => a.id && a.id.startsWith(`SAV-${year}-`)).length + 1;
    let newId = `SAV-${year}-${String(nextNum).padStart(4, '0')}`;
    // Safety net: if that number is somehow already taken (e.g. an in-between account
    // wasn't deleted), keep incrementing until we find a free ID so we never collide.
    while (savingsAccounts.some(a => a.id === newId)) {
        nextNum++;
        newId = `SAV-${year}-${String(nextNum).padStart(4, '0')}`;
    }
    return newId;
}

function clearSavingsScheduleCache(accountId) {
    if (accountId) delete savingsScheduleCache[accountId];
    else savingsScheduleCache = {};
}

function buildSavingsSchedule(account, forceRecalculate = false) {
    if (!account || !account.goalAmount || !account.monthlyAmount) return [];
    const cacheKey = account.id;
    if (savingsScheduleCache[cacheKey] && !forceRecalculate) return savingsScheduleCache[cacheKey];

    const schedule = [];
    const goal = Number(account.goalAmount);
    const monthly = Number(account.monthlyAmount);
    const initial = Math.min(getSavingsInitialDeposit(account), goal);
    const term = calcSavingsTerm(goal, monthly, initial);
    let cumulative = initial;      // running total starts from the initial deposit
    let cumulativePaid = initial;  // interest-bearing balance also starts from the initial deposit
    const originalDay = parseDate(account.startDate).getDate();
    const monthlyRate = getSavingsMonthlyRate(account);
    const taxRate = Number(account.taxRate) || 0;
    const withdrawals = (savingsWithdrawals[account.id] || []).slice().sort((a, b) => parseDate(a.date) - parseDate(b.date));
    let wIdx = 0;

    for (let i = 1; i <= term; i++) {
        const pmtDate = addMonthsClamped(account.startDate, i, originalDay);

        // Apply any withdrawals dated before this period's due date to the interest-bearing balance.
        while (wIdx < withdrawals.length && parseDate(withdrawals[wIdx].date) < pmtDate) {
            cumulativePaid = Math.max(0, cumulativePaid - withdrawals[wIdx].amount);
            wIdx++;
        }

        let amount = monthly;
        if (i === term || (cumulative + amount) > goal) {
            amount = goal - cumulative;
        }
        cumulative += amount;

        const paymentKey = `${account.id}-${i}`;
        const partials = savingsPayments[paymentKey] || [];
        const paidAmount = partials.reduce((sum, p) => sum + p.amount, 0);
        const remainingAmount = amount - paidAmount;

        let status = 'unpaid';
        if (paidAmount > 0) status = remainingAmount <= 0.01 ? 'paid' : 'partial';

        // Interest accrues on the balance actually paid in prior periods (not the scheduled target).
        const interest = cumulativePaid * monthlyRate;
        const tax = interest * taxRate / 100;
        const netInterest = interest - tax;
        cumulativePaid += paidAmount;

        schedule.push({
            index: i,
            date: pmtDate.toISOString().split('T')[0],
            amount,
            paidAmount,
            remainingAmount,
            cumulative,
            interest,
            tax,
            netInterest,
            status
        });
    }

    savingsScheduleCache[cacheKey] = schedule;
    return schedule;
}

function createSavingsDataFromForm() {
    const interestType = document.getElementById('savingsInterestType').value;
    const hasMembershipFee = document.getElementById('savingsHasMembershipFee').value === 'yes';
    return {
        customerName: document.getElementById('savingsCustomerName').value.trim(),
        customerPhone: document.getElementById('savingsCustomerPhone').value.trim(),
        currency: document.getElementById('savingsCurrency').value,
        startDate: document.getElementById('savingsStartDate').value,
        goalAmount: Number(document.getElementById('savingsGoalAmount').value),
        monthlyAmount: Number(document.getElementById('savingsMonthlyAmount').value),
        interestType,
        interestRate: interestType === 'none' ? 0 : Number(document.getElementById('savingsInterestRate').value) || 0,
        taxRate: interestType === 'none' ? 0 : Number(document.getElementById('savingsTaxRate').value) || 0,
        hasMembershipFee,
        membershipFeeAmount: hasMembershipFee ? (Number(document.getElementById('savingsMembershipFeeAmount').value) || 0) : 0,
        notes: document.getElementById('savingsNotes').value.trim(),
    };
}

function validateSavingsForm() {
    const errors = [];
    if (!document.getElementById('savingsCustomerName').value.trim()) errors.push('សូមបញ្ចូលឈ្មោះអតិថិជន');
    if (!document.getElementById('savingsStartDate').value) errors.push('សូមជ្រើសរើសថ្ងៃចាប់ផ្តើម');
    if (Number(document.getElementById('savingsGoalAmount').value) <= 0) errors.push('គោលដៅសន្សំ (>0)');
    if (Number(document.getElementById('savingsMonthlyAmount').value) <= 0) errors.push('សន្សំប្រចាំខែ (>0)');

    const interestType = document.getElementById('savingsInterestType').value;
    if (interestType !== 'none') {
        if (Number(document.getElementById('savingsInterestRate').value) < 0) errors.push('អត្រាការប្រាក់ (>=0)');
        const taxRate = Number(document.getElementById('savingsTaxRate').value);
        if (taxRate < 0 || taxRate > 100) errors.push('អត្រាកាត់ពន្ធត្រូវនៅចន្លោះ 0-100%');
    }
    if (document.getElementById('savingsHasMembershipFee').value === 'yes' && Number(document.getElementById('savingsMembershipFeeAmount').value) <= 0) {
        errors.push('ចំនួនប្រាក់សន្សំដំបូង (>0)');
    }
    if (document.getElementById('savingsHasMembershipFee').value === 'yes' &&
        Number(document.getElementById('savingsMembershipFeeAmount').value) >= Number(document.getElementById('savingsGoalAmount').value)) {
        errors.push('ប្រាក់សន្សំដំបូងត្រូវតិចជាងគោលដៅសន្សំ');
    }

    if (errors.length) {
        showToast('សូមពិនិត្យមើលកំហុស:\n - ' + errors.join('\n - '), 'error');
        return false;
    }
    return true;
}

async function saveSavingsAccount(e) {
    e.preventDefault();
    if (!validateSavingsForm()) return;

    const idFromForm = document.getElementById('savingsAccountId').value.trim();
    const formData = createSavingsDataFromForm();

    if (idFromForm && savingsAccounts.some(a => a.id === idFromForm)) {
        const index = savingsAccounts.findIndex(a => a.id === idFromForm);
        const existingStatus = savingsAccounts[index].status;
        savingsAccounts[index] = { ...savingsAccounts[index], ...formData, status: existingStatus };
        showToast('រក្សាទុកបានជោគជ័យ!', 'success');
        notifyTelegram(`✏️ <b>គណនីសន្សំត្រូវបានកែប្រែ</b>\nលេខគណនី: ${idFromForm}\nអតិថិជន: ${formData.customerName || 'N/A'}\nគោលដៅសន្សំ: ${formData.goalAmount || 0} ${formData.currency || ''}\nសន្សំប្រចាំខែ: ${formData.monthlyAmount || 0} ${formData.currency || ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    } else {
        const newId = await generateNewSavingsId();
        savingsAccounts.push({
            id: newId,
            ...formData,
            status: 'active',
            createdBy: currentUser ? currentUser.username : 'N/A',
            createdAt: new Date().toISOString()
        });
        showToast('គណនីសន្សំថ្មីត្រូវបានបង្កើត!', 'success');
        notifyTelegram(`🏦 <b>គណនីសន្សំថ្មីត្រូវបានបង្កើត</b>\nលេខគណនី: ${newId}\nអតិថិជន: ${formData.customerName || 'N/A'}\nគោលដៅសន្សំ: ${formData.goalAmount || 0} ${formData.currency || ''}\nសន្សំប្រចាំខែ: ${formData.monthlyAmount || 0} ${formData.currency || ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    }

    persistData(LS_KEYS.savingsAccounts, savingsAccounts);
    const savedId = idFromForm || savingsAccounts[savingsAccounts.length - 1].id;
    clearSavingsScheduleCache(savedId);
    clearSavingsForm();
    displaySavingsAccounts();
    loadSavingsAccount(savedId);
}

function updateSavingsInterestTypeUI() {
    const isInterestBearing = document.getElementById('savingsInterestType').value !== 'none';
    document.getElementById('savingsInterestRateWrap').style.display = isInterestBearing ? 'block' : 'none';
    document.getElementById('savingsTaxRateWrap').style.display = isInterestBearing ? 'block' : 'none';
    if (!isInterestBearing) {
        document.getElementById('savingsInterestRate').value = 0;
        document.getElementById('savingsTaxRate').value = 0;
    }
}

function updateSavingsMembershipFeeUI() {
    const hasFee = document.getElementById('savingsHasMembershipFee').value === 'yes';
    document.getElementById('savingsMembershipFeeAmountWrap').style.display = hasFee ? 'block' : 'none';
    if (!hasFee) document.getElementById('savingsMembershipFeeAmount').value = 0;
}

function clearSavingsForm() {
    document.getElementById('savingsAccountForm').reset();
    document.getElementById('savingsAccountId').value = '';
    document.getElementById('savingsFormTitle').innerHTML = '<i class="fas fa-piggy-bank"></i> គណនីសន្សំថ្មី';
    document.getElementById('savingsStartDate').value = formatDateISO(new Date());
    document.getElementById('savingsEstimatedTerm').value = '';
    document.getElementById('savingsInterestType').value = 'none';
    document.getElementById('savingsHasMembershipFee').value = 'no';
    updateSavingsInterestTypeUI();
    updateSavingsMembershipFeeUI();
    document.getElementById('closeSavingsBtn').style.display = 'none';
    document.getElementById('withdrawSavingsBtn').style.display = 'none';
    currentSavingsAccount = null;
    document.querySelectorAll('#savingsAccountsTableBody tr').forEach(row => row.classList.remove('selected-row'));
    clearSavingsScheduleAndSummary();
}

function clearSavingsScheduleAndSummary() {
    document.getElementById('savingsScheduleTableBody').innerHTML = `<tr><td colspan="11" class="center" style="color:#999">សូមជ្រើសរើសគណនីសន្សំ</td></tr>`;
    document.getElementById('savingsSummaryGoal').textContent = '';
    document.getElementById('savingsSummarySaved').textContent = '';
    document.getElementById('savingsSummaryWithdrawn').textContent = '';
    document.getElementById('savingsSummaryRemaining').textContent = '';
    document.getElementById('savingsSummaryPaidCount').textContent = '0';
    document.getElementById('savingsSummaryUnpaidCount').textContent = '0';
    document.getElementById('savingsSummaryInterest').textContent = '';
    document.getElementById('savingsSummaryTax').textContent = '';
    document.getElementById('savingsSummaryNetInterest').textContent = '';
    document.getElementById('savingsSummaryMembershipFee').textContent = '-';
}

function updateSavingsTermPreview() {
    const goal = Number(document.getElementById('savingsGoalAmount').value) || 0;
    const monthly = Number(document.getElementById('savingsMonthlyAmount').value) || 0;
    const termEl = document.getElementById('savingsEstimatedTerm');
    const hasInitial = document.getElementById('savingsHasMembershipFee').value === 'yes';
    const initial = hasInitial ? (Number(document.getElementById('savingsMembershipFeeAmount').value) || 0) : 0;
    if (goal > 0 && monthly > 0) {
        termEl.value = calcSavingsTerm(goal, monthly, Math.min(initial, goal));
    } else {
        termEl.value = '';
    }
}

function getSavingsWithdrawnAmount(account) {
    const list = savingsWithdrawals[account.id] || [];
    return list.reduce((sum, w) => sum + w.amount, 0);
}

function getSavingsSavedAmount(account) {
    const schedule = buildSavingsSchedule(account);
    const deposited = getSavingsInitialDeposit(account) + schedule.reduce((sum, s) => sum + s.paidAmount, 0);
    return Math.max(0, deposited - getSavingsWithdrawnAmount(account));
}

function getSavingsComputedStatus(account) {
    if (account.status === 'closed') return { key: 'written_off', text: 'បានបិទគណនី' };
    const saved = getSavingsSavedAmount(account);
    if (saved >= Number(account.goalAmount) - 0.01) return { key: 'completed', text: 'សម្រេចគោលដៅ' };
    return { key: 'active', text: 'កំពុងសន្សំ' };
}

function displaySavingsAccounts() {
    const tbody = document.getElementById('savingsAccountsTableBody');
    tbody.innerHTML = '';
    renderSavingsOverduePanel();
    if (savingsAccounts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="center" style="color:#999">មិនមានគណនីសន្សំទេ</td></tr>`;
        return;
    }
    const fragment = document.createDocumentFragment();
    savingsAccounts.forEach((account, idx) => {
        const term = calcSavingsTerm(Number(account.goalAmount), Number(account.monthlyAmount), Math.min(getSavingsInitialDeposit(account), Number(account.goalAmount)));
        const saved = getSavingsSavedAmount(account);
        const statusInfo = getSavingsComputedStatus(account);
        const interestLabel = getSavingsInterestLabel(account);
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        if (currentSavingsAccount && currentSavingsAccount.id === account.id) tr.classList.add('selected-row');
        tr.setAttribute('onclick', `loadSavingsAccount('${account.id}')`);
        const canDeleteSavings = hasPermission('canDeleteSavings');
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td>${esc(account.id)}</td>
            <td>${esc(account.customerName)}</td>
            <td>${esc(account.customerPhone || '')}</td>
            <td class="right">${fmtMoney(account.goalAmount, account.currency)}</td>
            <td class="right">${fmtMoney(account.monthlyAmount, account.currency)}</td>
            <td class="right">${term}</td>
            <td class="right">${fmtMoney(saved, account.currency)}</td>
            <td>${esc(interestLabel)}</td>
            <td class="status-cell"><span class="status-badge status-${statusInfo.key}">${statusInfo.text}</span></td>
            <td class="actions" onclick="event.stopPropagation();">
                <button class="btn btn-info btn-sm" onclick="loadSavingsAccount('${account.id}')"><i class="fas fa-eye"></i> View</button>
                ${canDeleteSavings ? `<button class="btn btn-danger btn-sm" onclick="deleteSavingsAccount('${account.id}')"><i class="fas fa-trash-alt"></i> Delete</button>` : ""}
            </td>`;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

function getSavingsInterestLabel(account) {
    const type = account.interestType || 'none';
    if (type === 'none') return 'គ្មានការប្រាក់';
    const rate = Number(account.interestRate) || 0;
    const typeLabel = type === 'monthly' ? 'ប្រចាំខែ' : 'ប្រចាំឆ្នាំ';
    const taxRate = Number(account.taxRate) || 0;
    return taxRate > 0 ? `${typeLabel} ${rate}% (កាត់ពន្ធ ${taxRate}%)` : `${typeLabel} ${rate}%`;
}

function loadSavingsAccount(accountId) {
    const account = savingsAccounts.find(a => a.id === accountId);
    if (!account) return;

    document.getElementById('savingsAccountId').value = account.id;
    document.getElementById('savingsCustomerName').value = account.customerName;
    document.getElementById('savingsCustomerPhone').value = account.customerPhone || '';
    document.getElementById('savingsCurrency').value = account.currency;
    document.getElementById('savingsStartDate').value = account.startDate;
    document.getElementById('savingsGoalAmount').value = Number(account.goalAmount).toFixed(2);
    document.getElementById('savingsMonthlyAmount').value = Number(account.monthlyAmount).toFixed(2);
    document.getElementById('savingsInterestType').value = account.interestType || 'none';
    document.getElementById('savingsInterestRate').value = Number(account.interestRate || 0).toFixed(2);
    document.getElementById('savingsTaxRate').value = Number(account.taxRate || 0).toFixed(2);
    document.getElementById('savingsHasMembershipFee').value = account.hasMembershipFee ? 'yes' : 'no';
    document.getElementById('savingsMembershipFeeAmount').value = Number(account.membershipFeeAmount || 0).toFixed(2);
    updateSavingsInterestTypeUI();
    updateSavingsMembershipFeeUI();
    document.getElementById('savingsNotes').value = account.notes || '';
    updateSavingsTermPreview();
    document.getElementById('savingsFormTitle').innerHTML = `<i class="fas fa-piggy-bank"></i> គណនីសន្សំ: ${esc(account.id)}`;
    document.getElementById('closeSavingsBtn').style.display = account.status === 'closed' ? 'none' : 'inline-block';
    document.getElementById('withdrawSavingsBtn').style.display = account.status === 'closed' ? 'none' : 'inline-block';

    currentSavingsAccount = account;
    displaySavingsAccounts();
    renderSavingsSchedule(account, true);
    updateSavingsSummary(account);
}

async function deleteSavingsAccount(accountId) {
    if (!hasPermission('canDeleteSavings')) { showToast('Permission Denied.', 'error'); return; }
    if (!await customConfirm(`តើអ្នកប្រាកដទេថាចង់លុបគណនីសន្សំ ${accountId}? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ។`)) return;
    const deletedAcct = savingsAccounts.find(a => a.id === accountId);
    savingsAccounts = savingsAccounts.filter(a => a.id !== accountId);
    Object.keys(savingsPayments).forEach(key => { if (key.startsWith(accountId + '-')) delete savingsPayments[key]; });
    delete savingsWithdrawals[accountId];
    persistData(LS_KEYS.savingsAccounts, savingsAccounts);
    persistData(LS_KEYS.savingsPayments, savingsPayments);
    persistData(LS_KEYS.savingsWithdrawals, savingsWithdrawals);
    clearSavingsScheduleCache(accountId);
    if (currentSavingsAccount && currentSavingsAccount.id === accountId) clearSavingsForm();
    displaySavingsAccounts();
    showToast('គណនីសន្សំត្រូវបានលុប', 'info');
    notifyTelegram(`🗑️ <b>គណនីសន្សំត្រូវបានលុប</b>\nលេខគណនី: ${accountId}\nអតិថិជន: ${deletedAcct ? deletedAcct.customerName : 'N/A'}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
}

async function closeSavingsAccount() {
    if (!currentSavingsAccount) return;
    if (!await customConfirm(`តើអ្នកប្រាកដទេថាចង់បិទគណនីសន្សំ ${currentSavingsAccount.id}?`)) return;
    const index = savingsAccounts.findIndex(a => a.id === currentSavingsAccount.id);
    if (index > -1) {
        savingsAccounts[index].status = 'closed';
        persistData(LS_KEYS.savingsAccounts, savingsAccounts);
        showToast('គណនីត្រូវបានបិទ', 'info');
        notifyTelegram(`🔒 <b>គណនីសន្សំត្រូវបានបិទ</b>\nលេខគណនី: ${currentSavingsAccount.id}\nអតិថិជន: ${currentSavingsAccount.customerName || 'N/A'}\nសរុបបានសន្សំ: ${getSavingsSavedAmount(currentSavingsAccount)} ${currentSavingsAccount.currency || ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
        loadSavingsAccount(currentSavingsAccount.id);
    }
}

function renderSavingsSchedule(account, forceRecalculate = false) {
    const schedule = buildSavingsSchedule(account, forceRecalculate);
    const tbody = document.getElementById('savingsScheduleTableBody');
    tbody.innerHTML = '';
    if (!schedule || schedule.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="center" style="color:#999">មិនមានតារាងសន្សំ</td></tr>`;
        return;
    }
    const statusLabels = { unpaid: 'មិនទាន់បង់', partial: 'បង់បានមួយផ្នែក', paid: 'បានបង់' };
    const fragment = document.createDocumentFragment();
    const initialDeposit = getSavingsInitialDeposit(account);
    if (initialDeposit > 0) {
        const tr0 = document.createElement('tr');
        tr0.innerHTML = `
            <td>0</td>
            <td>${formatDateDMY(account.startDate)}</td>
            <td class="right">${fmtMoney(initialDeposit, account.currency)}</td>
            <td class="right">${fmtMoney(initialDeposit, account.currency)}</td>
            <td class="right" style="font-weight:bold; color: var(--success)">${fmtMoney(0, account.currency)}</td>
            <td class="right">${fmtMoney(initialDeposit, account.currency)}</td>
            <td class="right">${fmtMoney(0, account.currency)}</td>
            <td class="right">${fmtMoney(0, account.currency)}</td>
            <td class="right">${fmtMoney(0, account.currency)}</td>
            <td class="status-cell"><span class="status-badge status-paid">ប្រាក់សន្សំដំបូង</span></td>
            <td class="center actions">-</td>`;
        fragment.appendChild(tr0);
    }
    schedule.forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${s.index}</td>
            <td>${formatDateDMY(s.date)}</td>
            <td class="right">${fmtMoney(s.amount, account.currency)}</td>
            <td class="right">${fmtMoney(s.paidAmount, account.currency)}</td>
            <td class="right" style="font-weight:bold; color: ${s.remainingAmount > 0.01 ? 'var(--danger)' : 'var(--success)'}">${fmtMoney(s.remainingAmount, account.currency)}</td>
            <td class="right">${fmtMoney(s.cumulative, account.currency)}</td>
            <td class="right">${fmtMoney(s.interest, account.currency)}</td>
            <td class="right">${fmtMoney(s.tax, account.currency)}</td>
            <td class="right">${fmtMoney(s.netInterest, account.currency)}</td>
            <td class="status-cell"><span class="status-badge status-${s.status}">${statusLabels[s.status]}</span></td>
            <td class="center actions">
                <button class="btn btn-sm btn-success" onclick="openSavingsDepositModal('${account.id}', ${s.index})"><i class="fas fa-edit"></i> Manage</button>
            </td>`;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

function updateSavingsSummary(account) {
    const schedule = buildSavingsSchedule(account);
    const withdrawn = getSavingsWithdrawnAmount(account);
    const saved = getSavingsSavedAmount(account);
    const remaining = Math.max(0, Number(account.goalAmount) - saved);
    const totalInterest = schedule.reduce((sum, s) => sum + s.interest, 0);
    const totalTax = schedule.reduce((sum, s) => sum + s.tax, 0);
    const totalNetInterest = schedule.reduce((sum, s) => sum + s.netInterest, 0);
    document.getElementById('savingsSummaryGoal').textContent = fmtMoney(account.goalAmount, account.currency);
    document.getElementById('savingsSummarySaved').textContent = fmtMoney(saved, account.currency);
    document.getElementById('savingsSummaryWithdrawn').textContent = fmtMoney(withdrawn, account.currency);
    document.getElementById('savingsSummaryRemaining').textContent = fmtMoney(remaining, account.currency);
    document.getElementById('savingsSummaryPaidCount').textContent = schedule.filter(s => s.status === 'paid').length;
    document.getElementById('savingsSummaryUnpaidCount').textContent = schedule.filter(s => s.status !== 'paid').length;
    document.getElementById('savingsSummaryInterest').textContent = fmtMoney(totalInterest, account.currency);
    document.getElementById('savingsSummaryTax').textContent = fmtMoney(totalTax, account.currency);
    document.getElementById('savingsSummaryNetInterest').textContent = fmtMoney(totalNetInterest, account.currency);
    document.getElementById('savingsSummaryMembershipFee').textContent = account.hasMembershipFee
        ? fmtMoney(account.membershipFeeAmount, account.currency)
        : 'មិនមាន';
}

function openSavingsDepositModal(accountId, installmentIndex) {
    const account = savingsAccounts.find(a => a.id === accountId);
    if (!account) return;
    if (account.status === 'closed') { showToast('គណនីនេះត្រូវបានបិទរួចហើយ', 'error'); return; }

    currentSavingsAccount = account;
    const installment = buildSavingsSchedule(account, true)[installmentIndex - 1];
    currentSavingsPayment = { accountId, installmentIndex };

    document.getElementById('savingsModalAccountId').textContent = accountId;
    document.getElementById('savingsModalInstallment').textContent = `${installmentIndex}/${Math.max(1, Math.ceil(Number(account.goalAmount) / Number(account.monthlyAmount)))}`;
    document.getElementById('savingsModalDueDate').textContent = formatDateDMY(installment.date);
    document.getElementById('savingsModalAmount').textContent = fmtMoney(installment.amount, account.currency);
    document.getElementById('savingsModalPaidAmount').textContent = fmtMoney(installment.paidAmount, account.currency);
    document.getElementById('savingsModalRemainingAmount').textContent = fmtMoney(installment.remainingAmount, account.currency);

    document.getElementById('savingsDepositDate').value = formatDateISO(new Date());
    document.getElementById('savingsDepositAmount').value = installment.remainingAmount > 0 ? installment.remainingAmount.toFixed(2) : '';
    document.getElementById('savingsDepositNote').value = '';

    renderSavingsDepositsTable();
    document.querySelector('#addSavingsDepositForm button').disabled = !hasPermission('canManagePayments') || installment.remainingAmount < 0.01;
    document.getElementById('savingsDepositModal').style.display = 'flex';
}

function closeSavingsDepositModal() {
    document.getElementById('savingsDepositModal').style.display = 'none';
    currentSavingsPayment = { accountId: null, installmentIndex: null };
}

function renderSavingsDepositsTable() {
    const { accountId, installmentIndex } = currentSavingsPayment;
    const paymentKey = `${accountId}-${installmentIndex}`;
    const partials = savingsPayments[paymentKey] || [];
    const tbody = document.getElementById('savingsDepositsTableBody');
    tbody.innerHTML = '';

    if (partials.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="center" style="color:#999">No deposits recorded for this installment.</td></tr>`;
        return;
    }
    const canDelete = hasPermission('canDeleteSavings');
    const fragment = document.createDocumentFragment();
    partials.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDMY(p.date)}</td>
            <td class="right">${fmtMoney(p.amount, currentSavingsAccount.currency)}</td>
            <td>${esc(p.note || '')}</td>
            <td>${esc(getOfficerFullName(p.by))}</td>
            <td>${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteSavingsDeposit('${esc(p.id)}')"><i class="fas fa-trash-alt"></i></button>` : ''}</td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

function saveSavingsDeposit(e) {
    e.preventDefault();
    if (!hasPermission('canManagePayments')) { showToast('Permission Denied.', 'error'); return; }
    const { accountId, installmentIndex } = currentSavingsPayment;
    if (!accountId || !installmentIndex) return;

    const account = savingsAccounts.find(a => a.id === accountId);
    if (!account) { showToast('Error: Could not find the savings account.', 'error'); return; }

    const amount = parseFloat(document.getElementById('savingsDepositAmount').value);
    const date = document.getElementById('savingsDepositDate').value;
    const note = document.getElementById('savingsDepositNote').value.trim();

    if (!amount || !date || amount <= 0) {
        showToast('Please enter a valid amount and date.', 'error');
        return;
    }

    const paymentKey = `${accountId}-${installmentIndex}`;
    if (!savingsPayments[paymentKey]) savingsPayments[paymentKey] = [];

    savingsPayments[paymentKey].push({
        id: genId(),
        amount,
        date,
        note,
        by: currentUser ? currentUser.username : 'N/A',
        ts: new Date().toISOString()
    });

    persistData(LS_KEYS.savingsPayments, savingsPayments);
    clearSavingsScheduleCache(accountId);
    openSavingsDepositModal(accountId, installmentIndex);

    if (currentSavingsAccount && currentSavingsAccount.id === accountId) {
        renderSavingsSchedule(account);
        updateSavingsSummary(account);
    }
    displaySavingsAccounts();
    notifyTelegram(`💰 <b>ប្រាក់សន្សំត្រូវបានដាក់</b>\nលេខគណនី: ${accountId}\nអតិថិជន: ${account.customerName || 'N/A'}\nរំលោះទី: ${installmentIndex}\nចំនួន: ${amount} ${account.currency || ''}\nកាលបរិច្ឆេទ: ${date}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
}

async function deleteSavingsDeposit(depositId) {
    if (!hasPermission('canDeleteSavings')) { showToast('Permission Denied.', 'error'); return; }
    const { accountId, installmentIndex } = currentSavingsPayment;
    const paymentKey = `${accountId}-${installmentIndex}`;
    if (!savingsPayments[paymentKey]) return;

    if (await customConfirm('Are you sure you want to delete this deposit? This cannot be undone.')) {
        savingsPayments[paymentKey] = savingsPayments[paymentKey].filter(p => p.id !== depositId);
        persistData(LS_KEYS.savingsPayments, savingsPayments);
        clearSavingsScheduleCache(accountId);
        openSavingsDepositModal(accountId, installmentIndex);
        const account = savingsAccounts.find(a => a.id === accountId);
        if (currentSavingsAccount && currentSavingsAccount.id === accountId && account) {
            renderSavingsSchedule(account);
            updateSavingsSummary(account);
        }
        displaySavingsAccounts();
    }
}

function openSavingsWithdrawModal() {
    if (!currentSavingsAccount) { showToast('សូមជ្រើសរើសគណនីសន្សំជាមុនសិន', 'error'); return; }
    if (currentSavingsAccount.status === 'closed') { showToast('គណនីនេះត្រូវបានបិទរួចហើយ', 'error'); return; }

    const account = currentSavingsAccount;
    document.getElementById('savingsWithdrawModalAccountId').textContent = account.id;
    document.getElementById('savingsWithdrawModalBalance').textContent = fmtMoney(getSavingsSavedAmount(account), account.currency);
    document.getElementById('savingsWithdrawDate').value = formatDateISO(new Date());
    document.getElementById('savingsWithdrawAmount').value = '';
    document.getElementById('savingsWithdrawNote').value = '';

    renderSavingsWithdrawalsTable();
    const available = getSavingsSavedAmount(account);
    document.querySelector('#addSavingsWithdrawForm button').disabled = !hasPermission('canManagePayments') || available < 0.01;
    document.getElementById('savingsWithdrawModal').style.display = 'flex';
}

function closeSavingsWithdrawModal() {
    document.getElementById('savingsWithdrawModal').style.display = 'none';
}

function renderSavingsWithdrawalsTable() {
    if (!currentSavingsAccount) return;
    const list = savingsWithdrawals[currentSavingsAccount.id] || [];
    const tbody = document.getElementById('savingsWithdrawalsTableBody');
    tbody.innerHTML = '';

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="center" style="color:#999">មិនទាន់មានការដកប្រាក់ទេ</td></tr>`;
        return;
    }
    const canDelete = hasPermission('canDeleteSavings');
    const fragment = document.createDocumentFragment();
    list.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(w => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDMY(w.date)}</td>
            <td class="right">${fmtMoney(w.amount, currentSavingsAccount.currency)}</td>
            <td>${esc(w.note || '')}</td>
            <td>${esc(getOfficerFullName(w.by))}</td>
            <td>${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteSavingsWithdrawal('${esc(w.id)}')"><i class="fas fa-trash-alt"></i></button>` : ''}</td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

function saveSavingsWithdrawal(e) {
    e.preventDefault();
    if (!hasPermission('canManagePayments')) { showToast('Permission Denied.', 'error'); return; }
    if (!currentSavingsAccount) return;
    const account = currentSavingsAccount;

    const amount = parseFloat(document.getElementById('savingsWithdrawAmount').value);
    const date = document.getElementById('savingsWithdrawDate').value;
    const note = document.getElementById('savingsWithdrawNote').value.trim();

    if (!amount || !date || amount <= 0) {
        showToast('សូមបញ្ចូលចំនួនទឹកប្រាក់ និងកាលបរិច្ឆេទឱ្យបានត្រឹមត្រូវ', 'error');
        return;
    }
    const available = getSavingsSavedAmount(account);
    if (amount > available + 0.01) {
        showToast('ចំនួនទឹកប្រាក់ដកលើសសមតុល្យបច្ចុប្បន្ន', 'error');
        return;
    }

    if (!savingsWithdrawals[account.id]) savingsWithdrawals[account.id] = [];
    savingsWithdrawals[account.id].push({
        id: genId(),
        amount,
        date,
        note,
        by: currentUser ? currentUser.username : 'N/A',
        ts: new Date().toISOString()
    });

    persistData(LS_KEYS.savingsWithdrawals, savingsWithdrawals);
    clearSavingsScheduleCache(account.id);
    openSavingsWithdrawModal();
    renderSavingsSchedule(account);
    updateSavingsSummary(account);
    displaySavingsAccounts();
    showToast('ការដកប្រាក់ត្រូវបានរក្សាទុក', 'success');
    notifyTelegram(`🏧 <b>ការដកប្រាក់សន្សំត្រូវបានកត់ត្រា</b>\nលេខគណនី: ${account.id}\nអតិថិជន: ${account.customerName || 'N/A'}\nចំនួន: ${amount} ${account.currency || ''}\nកាលបរិច្ឆេទ: ${date}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
}

async function deleteSavingsWithdrawal(withdrawalId) {
    if (!hasPermission('canDeleteSavings')) { showToast('Permission Denied.', 'error'); return; }
    if (!currentSavingsAccount) return;
    const accountId = currentSavingsAccount.id;
    if (!savingsWithdrawals[accountId]) return;

    if (await customConfirm('តើអ្នកប្រាកដទេថាចង់លុបការដកប្រាក់នេះ? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ។')) {
        savingsWithdrawals[accountId] = savingsWithdrawals[accountId].filter(w => w.id !== withdrawalId);
        persistData(LS_KEYS.savingsWithdrawals, savingsWithdrawals);
        clearSavingsScheduleCache(accountId);
        openSavingsWithdrawModal();
        const account = savingsAccounts.find(a => a.id === accountId);
        if (account) {
            renderSavingsSchedule(account);
            updateSavingsSummary(account);
        }
        displaySavingsAccounts();
    }
}

function printSavingsSchedule() {
    if (!currentSavingsAccount) { showToast('សូមជ្រើសរើសគណនីសន្សំជាមុនសិន', 'error'); return; }
    const account = currentSavingsAccount;
    const schedule = buildSavingsSchedule(account);

    let rowsHtml = '';
    const initialDeposit = getSavingsInitialDeposit(account);
    if (initialDeposit > 0) {
        rowsHtml += `<tr><td class="center">0</td><td class="center">${formatDateDMY(account.startDate)}</td><td class="right">${fmtMoney(initialDeposit, account.currency)}</td><td class="right">${fmtMoney(0, account.currency)}</td><td class="right">${fmtMoney(0, account.currency)}</td><td class="right">${fmtMoney(0, account.currency)}</td><td class="right">${fmtMoney(initialDeposit, account.currency)}</td></tr>`;
    }
    schedule.forEach(s => {
        rowsHtml += `<tr><td class="center">${s.index}</td><td class="center">${formatDateDMY(s.date)}</td><td class="right">${fmtMoney(s.amount, account.currency)}</td><td class="right">${fmtMoney(s.interest, account.currency)}</td><td class="right">${fmtMoney(s.tax, account.currency)}</td><td class="right">${fmtMoney(s.netInterest, account.currency)}</td><td class="right">${fmtMoney(s.cumulative, account.currency)}</td></tr>`;
    });

    const bodyHtml = `
        <div class="receipt-header"><h2>សៀវភៅសន្សំ - SAVINGS PASSBOOK</h2></div>
        <table class="print-info-table">
            <tr><td>លេខគណនី</td><td><strong>${esc(account.id)}</strong></td><td>ការប្រាក់</td><td><strong>${esc(getSavingsInterestLabel(account))}</strong></td></tr>
            <tr><td>ឈ្មោះគណនី</td><td><strong>${esc(account.customerName)}</strong></td><td>គោលដៅសន្សំ</td><td><strong>${fmtMoney(account.goalAmount, account.currency)}</strong></td></tr>
            <tr><td>ថ្ងៃ-ខែ-ឆ្នាំ</td><td><strong>${formatDateDMY(account.startDate)}</strong></td><td>សន្សំប្រចាំខែ</td><td><strong>${fmtMoney(account.monthlyAmount, account.currency)}</strong></td></tr>
            <tr><td>ប្រាក់សន្សំដំបូង</td><td><strong>${account.hasMembershipFee ? fmtMoney(account.membershipFeeAmount, account.currency) : 'មិនមាន'}</strong></td><td>ដកប្រាក់សរុប</td><td><strong>${fmtMoney(getSavingsWithdrawnAmount(account), account.currency)}</strong></td></tr>
        </table>
        <table class="print-schedule-table">
            <thead><tr><th>លេខរៀង</th><th>ថ្ងៃ-ខែ-ឆ្នាំ</th><th>ប្រាក់សន្សំ</th><th>ការប្រាក់</th><th>ពន្ធ</th><th>ការប្រាក់សុទ្ធ</th><th>សរុប</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>`;

    const pageStyle = `
        @page { size: A4; margin: 15mm; }
        body { font-family: 'Khmer OS', Arial, sans-serif; font-size: 13px; color:#000; }
        .receipt-header { text-align:center; margin-bottom:16px; }
        .receipt-header h2 { margin:0; }
        table.print-info-table, table.print-schedule-table { width:100%; border-collapse:collapse; margin-bottom:14px; }
        table.print-info-table th, table.print-info-table td, table.print-schedule-table th, table.print-schedule-table td { border:1px solid #333; padding:6px 8px; }
        table.print-schedule-table thead th { background:#f0f0f0; }
        .right { text-align:right; }
        .center { text-align:center; }
    `;

    const printWindow = window.open('', '_blank');
    if (!printWindow) { showToast('សូមអនុញ្ញាត Pop-up (Allow Pop-ups) សម្រាប់គេហទំព័រនេះ ដើម្បីអាច Print បាន', 'error'); return; }
    printWindow.document.write(`<html><head><title>Savings Passbook - ${esc(account.id)}</title><style>${pageStyle}</style></head><body>${bodyHtml}</body></html>`);
    printWindow.document.close();
    setTimeout(() => {
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    }, 250);
}

function exportSavingsScheduleToExcel() {
    if (!currentSavingsAccount) { showToast('សូមជ្រើសរើសគណនីសន្សំជាមុនសិន', 'error'); return; }
    const schedule = buildSavingsSchedule(currentSavingsAccount);
    const data = schedule.map(s => ({
        'លេខរៀង': s.index, 'ថ្ងៃ-ខែ-ឆ្នាំ': formatDateDMY(s.date), 'ប្រាក់សន្សំ': s.amount.toFixed(2),
        'បានបង់': s.paidAmount.toFixed(2), 'នៅសល់': s.remainingAmount.toFixed(2), 'សរុប': s.cumulative.toFixed(2),
        'ការប្រាក់': s.interest.toFixed(2), 'ពន្ធ': s.tax.toFixed(2), 'ការប្រាក់សុទ្ធ': s.netInterest.toFixed(2), 'ស្ថានភាព': s.status
    }));
    const initialDeposit = getSavingsInitialDeposit(currentSavingsAccount);
    if (initialDeposit > 0) {
        data.unshift({
            'លេខរៀង': 0, 'ថ្ងៃ-ខែ-ឆ្នាំ': formatDateDMY(currentSavingsAccount.startDate), 'ប្រាក់សន្សំ': initialDeposit.toFixed(2),
            'បានបង់': initialDeposit.toFixed(2), 'នៅសល់': '0.00', 'សរុប': initialDeposit.toFixed(2),
            'ការប្រាក់': '0.00', 'ពន្ធ': '0.00', 'ការប្រាក់សុទ្ធ': '0.00', 'ស្ថានភាព': 'initial'
        });
    }
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'SavingsSchedule');
    XLSX.writeFile(workbook, `${currentSavingsAccount.id}_savings_schedule.xlsx`);
}


// =====================================================================
// Overdue savings accounts (installments whose due date has passed and are not fully paid)
// =====================================================================
function getTodayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getSavingsOverdueInfo(account) {
    if (!account || account.status === 'closed') return null;
    if (getSavingsComputedStatus(account).key === 'completed') return null;
    const schedule = buildSavingsSchedule(account);
    const today = parseDate(getTodayISO());
    const overdue = schedule.filter(s => s.status !== 'paid' && s.remainingAmount > 0.01 && parseDate(s.date) < today);
    if (overdue.length === 0) return null;
    const oldest = parseDate(overdue[0].date);
    return {
        count: overdue.length,
        amount: overdue.reduce((sum, s) => sum + s.remainingAmount, 0),
        daysLate: Math.floor((today - oldest) / 86400000),
        oldestDate: overdue[0].date
    };
}

function renderSavingsOverduePanel() {
    const panel = document.getElementById('savingsOverduePanel');
    if (!panel) return;
    const rows = [];
    savingsAccounts.forEach(account => {
        const info = getSavingsOverdueInfo(account);
        if (info) rows.push({ account, info });
    });
    if (rows.length === 0) { panel.innerHTML = ''; return; }
    rows.sort((a, b) => b.info.daysLate - a.info.daysLate);
    const body = rows.map((r, i) => `
        <tr class="clickable-row" onclick="loadSavingsAccount('${esc(r.account.id)}')">
            <td>${i + 1}</td>
            <td>${esc(r.account.id)}</td>
            <td>${esc(r.account.customerName)}</td>
            <td>${esc(r.account.customerPhone || '')}</td>
            <td class="right">${r.info.count}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${fmtMoney(r.info.amount, r.account.currency)}</td>
            <td>${formatDateDMY(r.info.oldestDate)}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${r.info.daysLate} ថ្ងៃ</td>
        </tr>`).join('');
    panel.innerHTML = `
        <h3 style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> គណនីយឺតយ៉ាវ (${rows.length})</h3>
        <div class="table-container"><table>
            <thead><tr><th>ល.រ</th><th>លេខគណនី</th><th>ឈ្មោះអតិថិជន</th><th>លេខទូរសព្ទ</th><th>ចំនួនខែយឺត</th><th>ប្រាក់ជំពាក់</th><th>កាលកំណត់ចាស់បំផុត</th><th>យឺតជាង</th></tr></thead>
            <tbody>${body}</tbody>
        </table></div>`;
}

// =====================================================================
// Real-transaction statement (actual deposits/withdrawals with running balance)
// =====================================================================
function getSavingsTransactions(account) {
    const tx = [];
    const initial = getSavingsInitialDeposit(account);
    if (initial > 0) {
        tx.push({ date: account.startDate, label: 'ប្រាក់សន្សំដំបូង', ref: '0', note: '', deposit: initial, withdraw: 0, order: 0, ts: '' });
    }
    const schedule = buildSavingsSchedule(account);
    schedule.forEach(sc => {
        (savingsPayments[`${account.id}-${sc.index}`] || []).forEach(p => {
            tx.push({ date: p.date, label: 'ដាក់ប្រាក់', ref: String(sc.index), note: p.note || '', deposit: Number(p.amount) || 0, withdraw: 0, order: 1, ts: p.ts || '' });
        });
    });
    (savingsWithdrawals[account.id] || []).forEach(w => {
        tx.push({ date: w.date, label: 'ដកប្រាក់', ref: '', note: w.note || '', deposit: 0, withdraw: Number(w.amount) || 0, order: 2, ts: w.ts || '' });
    });
    tx.sort((a, b) => (parseDate(a.date) - parseDate(b.date)) || (a.order - b.order) || a.ts.localeCompare(b.ts));
    let balance = 0;
    tx.forEach(t => { balance += t.deposit - t.withdraw; t.balance = balance; });
    return tx;
}

function printSavingsStatement() {
    if (!currentSavingsAccount) { showToast('សូមជ្រើសរើសគណនីសន្សំជាមុនសិន', 'error'); return; }
    const account = currentSavingsAccount;
    const tx = getSavingsTransactions(account);
    if (tx.length === 0) { showToast('មិនទាន់មានប្រតិបត្តិការទេ', 'error'); return; }

    const totalDeposit = tx.reduce((sum, t) => sum + t.deposit, 0);
    const totalWithdraw = tx.reduce((sum, t) => sum + t.withdraw, 0);
    const rowsHtml = tx.map((t, i) => `<tr>
        <td class="center">${i + 1}</td>
        <td class="center">${formatDateDMY(t.date)}</td>
        <td>${esc(t.label)}</td>
        <td class="center">${esc(t.ref)}</td>
        <td class="right">${t.deposit > 0 ? fmtMoney(t.deposit, account.currency) : ''}</td>
        <td class="right">${t.withdraw > 0 ? fmtMoney(t.withdraw, account.currency) : ''}</td>
        <td class="right">${fmtMoney(t.balance, account.currency)}</td>
        <td>${esc(t.note)}</td>
    </tr>`).join('');

    const bodyHtml = `
        <div class="receipt-header"><h2>សៀវភៅសន្សំ (ប្រតិបត្តិការពិត) - SAVINGS STATEMENT</h2></div>
        <table class="print-info-table">
            <tr><td>លេខគណនី</td><td><strong>${esc(account.id)}</strong></td><td>គោលដៅសន្សំ</td><td><strong>${fmtMoney(account.goalAmount, account.currency)}</strong></td></tr>
            <tr><td>ឈ្មោះគណនី</td><td><strong>${esc(account.customerName)}</strong></td><td>សន្សំប្រចាំខែ</td><td><strong>${fmtMoney(account.monthlyAmount, account.currency)}</strong></td></tr>
            <tr><td>ថ្ងៃចាប់ផ្តើម</td><td><strong>${formatDateDMY(account.startDate)}</strong></td><td>សមតុល្យបច្ចុប្បន្ន</td><td><strong>${fmtMoney(getSavingsSavedAmount(account), account.currency)}</strong></td></tr>
        </table>
        <table class="print-schedule-table">
            <thead><tr><th>ល.រ</th><th>ថ្ងៃ-ខែ-ឆ្នាំ</th><th>ប្រភេទ</th><th>ខែទី</th><th>ដាក់ចូល</th><th>ដកចេញ</th><th>សមតុល្យ</th><th>កំណត់ចំណាំ</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot><tr><td colspan="4" class="right"><strong>សរុប</strong></td><td class="right"><strong>${fmtMoney(totalDeposit, account.currency)}</strong></td><td class="right"><strong>${fmtMoney(totalWithdraw, account.currency)}</strong></td><td class="right"><strong>${fmtMoney(tx[tx.length - 1].balance, account.currency)}</strong></td><td></td></tr></tfoot>
        </table>`;

    const pageStyle = `
        @page { size: A4; margin: 15mm; }
        body { font-family: 'Khmer OS', Arial, sans-serif; font-size: 13px; color:#000; }
        .receipt-header { text-align:center; margin-bottom:16px; }
        .receipt-header h2 { margin:0; }
        table.print-info-table, table.print-schedule-table { width:100%; border-collapse:collapse; margin-bottom:14px; }
        table.print-info-table th, table.print-info-table td, table.print-schedule-table th, table.print-schedule-table td { border:1px solid #333; padding:6px 8px; }
        table.print-schedule-table thead th { background:#f0f0f0; }
        .right { text-align:right; }
        .center { text-align:center; }
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Savings Statement - ${esc(account.id)}</title><style>${pageStyle}</style></head><body>${bodyHtml}</body></html>`);
    printWindow.document.close();
    setTimeout(() => {
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    }, 250);
}
