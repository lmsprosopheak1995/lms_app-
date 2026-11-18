// =====================================================================
// installments.js — Store installment (រំលស់ជាមួយហាង) module.
// Independent of Loans/Savings. Data: installmentContracts (array) and
// installmentPayments (keyed `${contractId}-${installmentIndex}` -> records),
// both persisted through persistData() -> db.js -> Supabase.
// Interest: unit (day/week/month/year) x rate type (percent / fixed amount),
// computed on the declining balance (like loans) or flat on the financed amount.
// =====================================================================

// Day-length used to convert an interest unit into a payment period (month = 30 days, year = 360 days,
// so 12% per year = exactly 1% per month).
const INS_UNIT_DAYS = { day: 1, week: 7, month: 30, year: 360 };
const INS_UNIT_LABEL = { day: 'ថ្ងៃ', week: 'សប្តាហ៍', month: 'ខែ', year: 'ឆ្នាំ' };

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function insRound(value, currency) {
    if (currency === 'KHR') return Math.round(value);
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function insLocalISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function insAddPeriod(startISO, unit, k) {
    const [y, m, d] = startISO.split('-').map(Number);
    if (unit === 'month') {
        const t = new Date(y, m - 1 + k, 1);
        const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
        t.setDate(Math.min(d, lastDay));
        return insLocalISO(t);
    }
    return insLocalISO(new Date(y, m - 1, d + k * INS_UNIT_DAYS[unit]));
}

function insBadge(label, color) {
    return `<span class="status-badge" style="background:${color};color:#fff;padding:2px 10px;border-radius:12px;">${label}</span>`;
}

async function generateNewInstallmentId() {
    const year = new Date().getFullYear();
    let nextNum = installmentContracts.filter(c => c.id && c.id.startsWith(`INS-${year}-`)).length + 1;
    let newId = `INS-${year}-${String(nextNum).padStart(4, '0')}`;
    while (installmentContracts.some(c => c.id === newId)) {
        nextNum++;
        newId = `INS-${year}-${String(nextNum).padStart(4, '0')}`;
    }
    return newId;
}

function clearInstallmentScheduleCache(contractId) {
    if (contractId) delete installmentScheduleCache[contractId];
    else installmentScheduleCache = {};
}

// ---------------------------------------------------------------------
// Schedule calculation
// ---------------------------------------------------------------------
// Pure calculation (no payments) — also used for the live preview while typing the form.
function computeInstallmentRows(contract) {
    const cur = contract.currency;
    const price = Number(contract.price) || 0;
    const down = Number(contract.downPayment) || 0;
    const principal = Math.max(0, price - down);
    const n = Math.max(1, parseInt(contract.termCount, 10) || 1);
    const periodUnit = contract.periodUnit || 'month';
    const interestUnit = contract.interestUnit || 'month';
    const rate = Number(contract.interestRate) || 0;
    const isPercent = (contract.interestRateType || 'percent') === 'percent';
    const method = contract.interestMethod || 'declining';
    const factor = INS_UNIT_DAYS[periodUnit] / INS_UNIT_DAYS[interestUnit];
    // Service fee (អត្រាសេវាប្រចាំខែ %) is always quoted per month; scaled to the payment period.
    const serviceRate = Number(contract.serviceFeeRate) || 0;
    const feeFactor = INS_UNIT_DAYS[periodUnit] / INS_UNIT_DAYS.month;
    const waiveFirst = contract.waiveFirstInterest === true || contract.waiveFirstInterest === 'yes';

    const principalPer = insRound(principal / n, cur);
    let balance = principal;
    const rows = [];
    for (let i = 1; i <= n; i++) {
        const p = (i === n) ? insRound(balance, cur) : principalPer;
        let interest;
        if (!isPercent) interest = rate * factor;
        else interest = (method === 'flat' ? principal : balance) * (rate / 100) * factor;
        if (waiveFirst && i === 1) interest = 0; // លើកលែងការប្រាក់ខែដំបូង
        interest = insRound(interest, cur);
        // Service fee uses the same base as the interest method (remaining balance, or flat financed amount)
        const serviceFee = insRound((method === 'flat' ? principal : balance) * (serviceRate / 100) * feeFactor, cur);
        balance = Math.max(0, insRound(balance - p, cur));
        rows.push({
            index: i,
            date: contract.startDate ? insAddPeriod(contract.startDate, periodUnit, i) : '',
            principal: p,
            interest,
            serviceFee,
            amount: insRound(p + interest + serviceFee, cur),
            balanceAfter: balance
        });
    }
    return rows;
}

function buildInstallmentSchedule(contract, forceRecalculate = false) {
    if (!forceRecalculate && installmentScheduleCache[contract.id]) return installmentScheduleCache[contract.id];
    const cur = contract.currency;
    const rows = computeInstallmentRows(contract).map(r => {
        const paid = (installmentPayments[`${contract.id}-${r.index}`] || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
        const remaining = Math.max(0, insRound(r.amount - paid, cur));
        const status = remaining < 0.01 ? 'paid' : (paid > 0.005 ? 'partial' : 'unpaid');
        return { ...r, paidAmount: paid, remainingAmount: remaining, status };
    });
    installmentScheduleCache[contract.id] = rows;
    return rows;
}

function getInstallmentTotals(contract) {
    const rows = buildInstallmentSchedule(contract);
    const price = Number(contract.price) || 0;
    const down = Number(contract.downPayment) || 0;
    const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
    const totalServiceFee = rows.reduce((s, r) => s + (r.serviceFee || 0), 0);
    const totalPayable = rows.reduce((s, r) => s + r.amount, 0);
    const paid = rows.reduce((s, r) => s + r.paidAmount, 0);
    return {
        price, down, financed: Math.max(0, price - down),
        totalInterest, totalServiceFee, totalPayable, paid,
        remaining: Math.max(0, totalPayable - paid)
    };
}

function getInstallmentStatus(contract) {
    const rows = buildInstallmentSchedule(contract);
    if (rows.every(r => r.status === 'paid')) return { key: 'completed', label: 'បង់ផ្តាច់', color: 'var(--success)' };
    const today = getTodayISO();
    if (rows.some(r => r.status !== 'paid' && r.date < today)) return { key: 'overdue', label: 'យឺត', color: 'var(--danger)' };
    return { key: 'active', label: 'កំពុងរំលស់', color: 'var(--info, #17a2b8)' };
}

function getInstallmentOverdueInfo(contract) {
    const today = getTodayISO();
    const overdue = buildInstallmentSchedule(contract).filter(r => r.status !== 'paid' && r.date < today);
    if (overdue.length === 0) return null;
    const oldest = parseDate(overdue[0].date);
    return {
        count: overdue.length,
        amount: overdue.reduce((s, r) => s + r.remainingAmount, 0),
        oldestDate: overdue[0].date,
        daysLate: Math.floor((parseDate(today) - oldest) / 86400000)
    };
}

// ---------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------
function createInstallmentDataFromForm() {
    const v = id => document.getElementById(id).value;
    return {
        customerName: v('insCustomerName').trim(),
        customerPhone: v('insCustomerPhone').trim(),
        guarantorName: v('insGuarantorName').trim(),
        guarantorPhone: v('insGuarantorPhone').trim(),
        itemName: v('insItemName').trim(),
        itemSerial: v('insItemSerial').trim(),
        currency: v('insCurrency'),
        startDate: v('insStartDate'),
        price: parseFloat(v('insPrice')) || 0,
        downPayment: parseFloat(v('insDownPayment')) || 0,
        termCount: parseInt(v('insTermCount'), 10) || 0,
        periodUnit: v('insPeriodUnit'),
        interestUnit: v('insInterestUnit'),
        interestRateType: v('insInterestRateType'),
        interestRate: parseFloat(v('insInterestRate')) || 0,
        interestMethod: v('insInterestMethod'),
        serviceFeeRate: parseFloat(v('insServiceFeeRate')) || 0,
        waiveFirstInterest: v('insWaiveFirstInterest') === 'yes',
        note: v('insNote').trim()
    };
}

function validateInstallmentForm(d) {
    const errors = [];
    if (!d.customerName) errors.push('ឈ្មោះអតិថិជន');
    if (!d.itemName) errors.push('ឈ្មោះទំនិញ');
    if (!d.startDate) errors.push('ថ្ងៃចាប់ផ្តើម');
    if (!(d.price > 0)) errors.push('តម្លៃទំនិញ (>0)');
    if (d.downPayment < 0 || d.downPayment >= d.price) errors.push('ប្រាក់កក់ត្រូវតិចជាងតម្លៃទំនិញ');
    if (!(d.termCount >= 1)) errors.push('ចំនួនដំណាក់កាលបង់ (≥1)');
    if (d.interestRate < 0) errors.push('អត្រាការប្រាក់មិនអាចអវិជ្ជមាន');
    if (d.serviceFeeRate < 0) errors.push('អត្រាសេវាមិនអាចអវិជ្ជមាន');
    if (errors.length) {
        showToast('សូមពិនិត្យមើលកំហុស:\n - ' + errors.join('\n - '), 'error');
        return false;
    }
    return true;
}

function updateInstallmentPreview() {
    const box = document.getElementById('installmentPreview');
    if (!box) return;
    const d = createInstallmentDataFromForm();
    if (!(d.price > 0) || d.downPayment < 0 || d.downPayment >= d.price || !(d.termCount >= 1) || !d.startDate) {
        box.innerHTML = '';
        return;
    }
    const rows = computeInstallmentRows(d);
    const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
    const totalServiceFee = rows.reduce((s, r) => s + r.serviceFee, 0);
    const totalPayable = rows.reduce((s, r) => s + r.amount, 0);
    const first = rows[0];
    const last = rows[rows.length - 1];
    box.innerHTML = `
        <div>ទឹកប្រាក់រំលស់ (តម្លៃ − កក់)</div><div>${fmtMoney(d.price - d.downPayment, d.currency)}</div>
        <div>ដំណាក់កាលទី 1 ត្រូវបង់</div><div>${fmtMoney(first.amount, d.currency)}</div>
        <div>ការប្រាក់សរុប</div><div>${fmtMoney(totalInterest, d.currency)}</div>
        <div>សេវាសរុប</div><div>${fmtMoney(totalServiceFee, d.currency)}</div>
        <div>ត្រូវបង់សរុប (ក្រៅពីកក់)</div><div style="font-weight:bold">${fmtMoney(totalPayable, d.currency)}</div>
        <div>ថ្ងៃបង់ចុងក្រោយ</div><div>${formatDateDMY(last.date)}</div>`;
}

function clearInstallmentForm() {
    document.getElementById('installmentForm').reset();
    document.getElementById('insContractId').value = '';
    document.getElementById('insStartDate').value = formatDateISO(new Date());
    document.getElementById('installmentFormTitle').innerHTML = '<i class="fas fa-store"></i> កិច្ចសន្យារំលស់ថ្មី';
    currentInstallmentContract = null;
    const detail = document.getElementById('installmentDetail');
    if (detail) detail.style.display = 'none';
    updateInstallmentPreview();
}

async function saveInstallmentContract(e) {
    e.preventDefault();
    const idFromForm = document.getElementById('insContractId').value;
    if (idFromForm) {
        if (!hasPermission('canEditLoan')) { showToast('Permission Denied.', 'error'); return; }
    } else if (!hasPermission('canManagePayments')) {
        showToast('Permission Denied.', 'error'); return;
    }

    const data = createInstallmentDataFromForm();
    if (!validateInstallmentForm(data)) return;

    const username = currentUser ? currentUser.username : 'N/A';
    let savedId = idFromForm;
    if (idFromForm) {
        const idx = installmentContracts.findIndex(c => c.id === idFromForm);
        if (idx === -1) { showToast('រកមិនឃើញកិច្ចសន្យា', 'error'); return; }
        installmentContracts[idx] = { ...installmentContracts[idx], ...data, updatedBy: username, updatedAt: new Date().toISOString() };
        showToast('រក្សាទុកបានជោគជ័យ!', 'success');
    } else {
        savedId = await generateNewInstallmentId();
        installmentContracts.push({ id: savedId, ...data, createdBy: username, createdAt: new Date().toISOString() });
        showToast('កិច្ចសន្យារំលស់ថ្មីត្រូវបានបង្កើត!', 'success');
        notifyTelegram(`🛒 <b>កិច្ចសន្យារំលស់ថ្មី</b>\nលេខ: ${savedId}\nអតិថិជន: ${data.customerName}\nទំនិញ: ${data.itemName}\nតម្លៃ: ${data.price} ${data.currency}\nកក់: ${data.downPayment} ${data.currency}\nដោយ: ${username}`);
    }
    persistData(LS_KEYS.installmentContracts, installmentContracts);
    clearInstallmentScheduleCache(savedId);
    displayInstallmentContracts();
    loadInstallmentContract(savedId);
}

function loadInstallmentContract(contractId) {
    const c = installmentContracts.find(x => x.id === contractId);
    if (!c) return;
    currentInstallmentContract = c;
    const set = (id, val) => { document.getElementById(id).value = val == null ? '' : val; };
    set('insContractId', c.id);
    set('insCustomerName', c.customerName); set('insCustomerPhone', c.customerPhone);
    set('insGuarantorName', c.guarantorName); set('insGuarantorPhone', c.guarantorPhone);
    set('insItemName', c.itemName); set('insItemSerial', c.itemSerial);
    set('insCurrency', c.currency); set('insStartDate', c.startDate);
    set('insPrice', c.price); set('insDownPayment', c.downPayment); set('insTermCount', c.termCount);
    set('insPeriodUnit', c.periodUnit); set('insInterestUnit', c.interestUnit);
    set('insInterestRateType', c.interestRateType); set('insInterestRate', c.interestRate);
    set('insInterestMethod', c.interestMethod); set('insNote', c.note);
    set('insServiceFeeRate', c.serviceFeeRate || 0);
    set('insWaiveFirstInterest', (c.waiveFirstInterest === true || c.waiveFirstInterest === 'yes') ? 'yes' : 'no');
    document.getElementById('installmentFormTitle').innerHTML = `<i class="fas fa-store"></i> កិច្ចសន្យារំលស់: ${esc(c.id)}`;
    updateInstallmentPreview();
    renderInstallmentSchedule(c, true);
    updateInstallmentSummary(c);
    document.getElementById('installmentDetail').style.display = 'block';
    document.getElementById('installmentForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteInstallmentContract(contractId) {
    if (!hasPermission('canDeleteInstallments')) { showToast('Permission Denied.', 'error'); return; }
    const c = installmentContracts.find(x => x.id === contractId);
    if (!c) return;
    if (!(await customConfirm(`តើអ្នកពិតជាចង់លុបកិច្ចសន្យា ${contractId} ឬ? ការបង់ប្រាក់ទាំងអស់ក៏នឹងត្រូវលុបដែរ។`))) return;
    installmentContracts = installmentContracts.filter(x => x.id !== contractId);
    Object.keys(installmentPayments).forEach(k => { if (k.startsWith(`${contractId}-`)) delete installmentPayments[k]; });
    persistData(LS_KEYS.installmentContracts, installmentContracts);
    persistData(LS_KEYS.installmentPayments, installmentPayments);
    clearInstallmentScheduleCache(contractId);
    if (currentInstallmentContract && currentInstallmentContract.id === contractId) clearInstallmentForm();
    displayInstallmentContracts();
    showToast('កិច្ចសន្យាត្រូវបានលុប', 'info');
    notifyTelegram(`🗑️ <b>កិច្ចសន្យារំលស់ត្រូវបានលុប</b>\nលេខ: ${contractId}\nអតិថិជន: ${c.customerName}\nដោយ: ${currentUser ? currentUser.username : 'N/A'}`);
}

// ---------------------------------------------------------------------
// List, filter, overdue panel
// ---------------------------------------------------------------------
function displayInstallmentContracts() {
    const tbody = document.getElementById('installmentContractsTableBody');
    if (!tbody) return;
    const q = ((document.getElementById('insSearch') || {}).value || '').trim().toLowerCase();
    const statusFilter = (document.getElementById('insFilterStatus') || {}).value || 'all';
    const canDelete = hasPermission('canDeleteInstallments');

    renderInstallmentOverduePanel();

    const rows = installmentContracts.filter(c => {
        if (q && !`${c.id} ${c.customerName} ${c.customerPhone || ''} ${c.itemName} ${c.itemSerial || ''}`.toLowerCase().includes(q)) return false;
        if (statusFilter !== 'all' && getInstallmentStatus(c).key !== statusFilter) return false;
        return true;
    });

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#888">មិនមានកិច្ចសន្យារំលស់</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map((c, i) => {
        const t = getInstallmentTotals(c);
        const st = getInstallmentStatus(c);
        return `<tr>
            <td>${i + 1}</td>
            <td>${esc(c.id)}</td>
            <td>${esc(c.customerName)}<br><small>${esc(c.customerPhone || '')}</small></td>
            <td>${esc(c.itemName)}</td>
            <td class="right">${fmtMoney(t.financed, c.currency)}</td>
            <td class="right">${fmtMoney(t.totalPayable, c.currency)}</td>
            <td class="right">${fmtMoney(t.paid, c.currency)}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${fmtMoney(t.remaining, c.currency)}</td>
            <td>${insBadge(st.label, st.color)}</td>
            <td class="center actions">
                <button class="btn btn-sm btn-success" onclick="loadInstallmentContract('${esc(c.id)}')"><i class="fas fa-edit"></i> Manage</button>
                ${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteInstallmentContract('${esc(c.id)}')"><i class="fas fa-trash"></i></button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

function renderInstallmentOverduePanel() {
    const panel = document.getElementById('installmentOverduePanel');
    if (!panel) return;
    const list = [];
    installmentContracts.forEach(c => {
        const info = getInstallmentOverdueInfo(c);
        if (info) list.push({ c, info });
    });
    if (list.length === 0) { panel.innerHTML = ''; return; }
    list.sort((a, b) => b.info.daysLate - a.info.daysLate);
    const body = list.map((r, i) => `
        <tr class="clickable-row" onclick="loadInstallmentContract('${esc(r.c.id)}')">
            <td>${i + 1}</td><td>${esc(r.c.id)}</td><td>${esc(r.c.customerName)}</td><td>${esc(r.c.customerPhone || '')}</td>
            <td>${esc(r.c.itemName)}</td>
            <td class="right">${r.info.count}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${fmtMoney(r.info.amount, r.c.currency)}</td>
            <td>${formatDateDMY(r.info.oldestDate)}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${r.info.daysLate} ថ្ងៃ</td>
        </tr>`).join('');
    panel.innerHTML = `
        <h3 style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> រំលស់យឺតយ៉ាវ (${list.length})</h3>
        <div class="table-container"><table>
            <thead><tr><th>ល.រ</th><th>លេខកិច្ចសន្យា</th><th>អតិថិជន</th><th>ទូរសព្ទ</th><th>ទំនិញ</th><th>ចំនួនដំណាក់កាលយឺត</th><th>ប្រាក់ជំពាក់</th><th>កាលកំណត់ចាស់បំផុត</th><th>យឺតជាង</th></tr></thead>
            <tbody>${body}</tbody>
        </table></div>`;
}

// ---------------------------------------------------------------------
// Schedule table + summary for the selected contract
// ---------------------------------------------------------------------
function renderInstallmentSchedule(contract, forceRecalculate = false) {
    const tbody = document.getElementById('installmentScheduleTableBody');
    if (!tbody) return;
    const rows = buildInstallmentSchedule(contract, forceRecalculate);
    const cur = contract.currency;
    const today = getTodayISO();
    tbody.innerHTML = rows.map(r => {
        let badge;
        if (r.status === 'paid') badge = insBadge('បានបង់', 'var(--success)');
        else if (r.date < today) badge = insBadge('យឺត', 'var(--danger)');
        else if (r.status === 'partial') badge = insBadge('បង់ខ្លះ', 'var(--warning, #e0a800)');
        else badge = insBadge('មិនទាន់បង់', 'var(--muted, #6c757d)');
        return `<tr>
            <td>${r.index}</td>
            <td>${formatDateDMY(r.date)}</td>
            <td class="right">${fmtMoney(r.principal, cur)}</td>
            <td class="right">${fmtMoney(r.interest, cur)}</td>
            <td class="right">${fmtMoney(r.serviceFee, cur)}</td>
            <td class="right">${fmtMoney(r.amount, cur)}</td>
            <td class="right">${fmtMoney(r.paidAmount, cur)}</td>
            <td class="right" style="font-weight:bold;color:${r.remainingAmount > 0 ? 'var(--danger)' : 'var(--success)'}">${fmtMoney(r.remainingAmount, cur)}</td>
            <td class="right">${fmtMoney(r.balanceAfter, cur)}</td>
            <td>${badge}</td>
            <td class="center actions"><button class="btn btn-sm btn-success" onclick="openInstallmentPaymentModal('${esc(contract.id)}', ${r.index})"><i class="fas fa-edit"></i> Manage</button></td>
        </tr>`;
    }).join('');
}

function updateInstallmentSummary(contract) {
    const box = document.getElementById('installmentSummary');
    if (!box) return;
    const t = getInstallmentTotals(contract);
    const st = getInstallmentStatus(contract);
    const cur = contract.currency;
    box.innerHTML = `
        <div>តម្លៃទំនិញ</div><div>${fmtMoney(t.price, cur)}</div>
        <div>ប្រាក់កក់</div><div>${fmtMoney(t.down, cur)}</div>
        <div>ទឹកប្រាក់រំលស់</div><div>${fmtMoney(t.financed, cur)}</div>
        <div>ការប្រាក់សរុប</div><div>${fmtMoney(t.totalInterest, cur)}</div>
        <div>សេវាសរុប</div><div>${fmtMoney(t.totalServiceFee, cur)}</div>
        <div>ត្រូវបង់សរុប</div><div>${fmtMoney(t.totalPayable, cur)}</div>
        <div>បានបង់</div><div style="color:var(--success);font-weight:bold">${fmtMoney(t.paid, cur)}</div>
        <div>នៅសល់</div><div style="color:var(--danger);font-weight:bold">${fmtMoney(t.remaining, cur)}</div>
        <div>ស្ថានភាព</div><div>${insBadge(st.label, st.color)}</div>`;
}

function refreshInstallmentViews(contractId) {
    clearInstallmentScheduleCache(contractId);
    const c = installmentContracts.find(x => x.id === contractId);
    if (currentInstallmentContract && c && currentInstallmentContract.id === contractId) {
        renderInstallmentSchedule(c, true);
        updateInstallmentSummary(c);
    }
    displayInstallmentContracts();
}

// ---------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------
function openInstallmentPaymentModal(contractId, installmentIndex) {
    const c = installmentContracts.find(x => x.id === contractId);
    if (!c) return;
    const row = buildInstallmentSchedule(c, true)[installmentIndex - 1];
    if (!row) return;
    currentInstallmentPayment = { contractId, installmentIndex };

    const setText = (id, val) => { document.getElementById(id).textContent = val; };
    setText('insPayModalContractId', contractId);
    setText('insPayModalInstallment', `${installmentIndex}/${c.termCount}`);
    setText('insPayModalDue', formatDateDMY(row.date));
    setText('insPayModalAmount', fmtMoney(row.amount, c.currency));
    setText('insPayModalPaid', fmtMoney(row.paidAmount, c.currency));
    setText('insPayModalRemaining', fmtMoney(row.remainingAmount, c.currency));

    document.getElementById('insPayDate').value = formatDateISO(new Date());
    document.getElementById('insPayAmount').value = row.remainingAmount > 0 ? row.remainingAmount : '';
    document.getElementById('insPayNote').value = '';
    renderInstallmentPaymentsTable();
    document.querySelector('#insPayForm button[type="submit"]').disabled = !hasPermission('canManagePayments') || row.remainingAmount < 0.01;
    document.getElementById('installmentPaymentModal').style.display = 'flex';
}

function closeInstallmentPaymentModal() {
    document.getElementById('installmentPaymentModal').style.display = 'none';
    currentInstallmentPayment = { contractId: null, installmentIndex: null };
}

function renderInstallmentPaymentsTable() {
    const tbody = document.getElementById('insPayTableBody');
    const { contractId, installmentIndex } = currentInstallmentPayment;
    const c = installmentContracts.find(x => x.id === contractId);
    const list = installmentPayments[`${contractId}-${installmentIndex}`] || [];
    const canDelete = hasPermission('canDeleteInstallments');
    if (!c || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">មិនទាន់មានការបង់ប្រាក់</td></tr>';
        return;
    }
    tbody.innerHTML = list.map(p => `<tr>
        <td>${formatDateDMY(p.date)}</td>
        <td class="right">${fmtMoney(p.amount, c.currency)}</td>
        <td>${esc(p.note || '')}</td>
        <td>${esc(p.by || '')}</td>
        <td class="center">${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteInstallmentPayment('${esc(p.id)}')"><i class="fas fa-trash"></i></button>` : ''}</td>
    </tr>`).join('');
}

function saveInstallmentPayment(e) {
    e.preventDefault();
    if (!hasPermission('canManagePayments')) { showToast('Permission Denied.', 'error'); return; }
    const { contractId, installmentIndex } = currentInstallmentPayment;
    const c = installmentContracts.find(x => x.id === contractId);
    if (!c || !installmentIndex) return;

    const amount = parseFloat(document.getElementById('insPayAmount').value);
    const date = document.getElementById('insPayDate').value;
    const note = document.getElementById('insPayNote').value.trim();
    if (!amount || amount <= 0 || !date) { showToast('សូមបញ្ចូលចំនួនទឹកប្រាក់ និងកាលបរិច្ឆេទឱ្យបានត្រឹមត្រូវ', 'error'); return; }

    const row = buildInstallmentSchedule(c, true)[installmentIndex - 1];
    if (amount > row.remainingAmount + 0.005) { showToast('ចំនួនទឹកប្រាក់លើសចំនួននៅសល់នៃដំណាក់កាលនេះ', 'error'); return; }

    const key = `${contractId}-${installmentIndex}`;
    if (!installmentPayments[key]) installmentPayments[key] = [];
    installmentPayments[key].push({
        id: genId(), amount, date, note,
        by: currentUser ? currentUser.username : 'N/A',
        ts: new Date().toISOString()
    });
    persistData(LS_KEYS.installmentPayments, installmentPayments);
    refreshInstallmentViews(contractId);
    openInstallmentPaymentModal(contractId, installmentIndex);
    notifyTelegram(`💵 <b>ការបង់រំលស់ហាង</b>\nលេខ: ${contractId}\nអតិថិជន: ${c.customerName}\nទំនិញ: ${c.itemName}\nដំណាក់កាលទី: ${installmentIndex}\nចំនួន: ${amount} ${c.currency}\nកាលបរិច្ឆេទ: ${date}\nដោយ: ${currentUser ? currentUser.username : 'N/A'}`);
}

async function deleteInstallmentPayment(paymentId) {
    if (!hasPermission('canDeleteInstallments')) { showToast('Permission Denied.', 'error'); return; }
    const { contractId, installmentIndex } = currentInstallmentPayment;
    const key = `${contractId}-${installmentIndex}`;
    if (!installmentPayments[key]) return;
    if (!(await customConfirm('តើអ្នកពិតជាចង់លុបការបង់ប្រាក់នេះឬ? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ។'))) return;
    installmentPayments[key] = installmentPayments[key].filter(p => p.id !== paymentId);
    persistData(LS_KEYS.installmentPayments, installmentPayments);
    refreshInstallmentViews(contractId);
    openInstallmentPaymentModal(contractId, installmentIndex);
}

// ---------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------
function printInstallmentSchedule() {
    const c = currentInstallmentContract;
    if (!c) { showToast('សូមជ្រើសរើសកិច្ចសន្យាជាមុនសិន', 'error'); return; }
    const cur = c.currency;
    const rows = buildInstallmentSchedule(c, true);
    const t = getInstallmentTotals(c);

    const rowsHtml = rows.map(r => `<tr>
        <td class="center">${r.index}</td><td class="center">${formatDateDMY(r.date)}</td>
        <td class="right">${fmtMoney(r.principal, cur)}</td><td class="right">${fmtMoney(r.interest, cur)}</td><td class="right">${fmtMoney(r.serviceFee, cur)}</td>
        <td class="right">${fmtMoney(r.amount, cur)}</td><td class="right">${fmtMoney(r.paidAmount, cur)}</td>
        <td class="right">${fmtMoney(r.remainingAmount, cur)}</td><td class="right">${fmtMoney(r.balanceAfter, cur)}</td>
    </tr>`).join('');

    const interestText = (c.interestRateType === 'fixed')
        ? `${fmtMoney(c.interestRate, cur)} / ${INS_UNIT_LABEL[c.interestUnit]}`
        : `${c.interestRate}% / ${INS_UNIT_LABEL[c.interestUnit]}`;

    const feeText = (Number(c.serviceFeeRate) > 0 ? `, សេវា ${c.serviceFeeRate}% / ខែ` : '') + (c.waiveFirstInterest ? ', លើកលែងការប្រាក់ដំបូង' : '');
    const bodyHtml = `
        <div class="receipt-header"><h2>កិច្ចសន្យារំលស់ជាមួយហាង - INSTALLMENT SCHEDULE</h2></div>
        <table class="print-info-table">
            <tr><td>លេខកិច្ចសន្យា</td><td><strong>${esc(c.id)}</strong></td><td>ថ្ងៃចាប់ផ្តើម</td><td><strong>${formatDateDMY(c.startDate)}</strong></td></tr>
            <tr><td>អតិថិជន</td><td><strong>${esc(c.customerName)}</strong> ${esc(c.customerPhone || '')}</td><td>អ្នកធានា</td><td>${esc(c.guarantorName || '-')} ${esc(c.guarantorPhone || '')}</td></tr>
            <tr><td>ទំនិញ</td><td><strong>${esc(c.itemName)}</strong> ${esc(c.itemSerial || '')}</td><td>ការប្រាក់</td><td>${interestText} (${c.interestMethod === 'flat' ? 'លើដើមថេរ' : 'លើសមតុល្យនៅសល់'})${feeText}</td></tr>
            <tr><td>តម្លៃទំនិញ</td><td>${fmtMoney(t.price, cur)}</td><td>ប្រាក់កក់</td><td>${fmtMoney(t.down, cur)}</td></tr>
            <tr><td>ទឹកប្រាក់រំលស់</td><td>${fmtMoney(t.financed, cur)}</td><td>ត្រូវបង់សរុប</td><td><strong>${fmtMoney(t.totalPayable, cur)}</strong></td></tr>
        </table>
        <table class="print-schedule-table">
            <thead><tr><th>ល.រ</th><th>ថ្ងៃ-ខែ-ឆ្នាំ</th><th>ដើម</th><th>ការប្រាក់</th><th>សេវា</th><th>ត្រូវបង់</th><th>បានបង់</th><th>នៅសល់</th><th>សមតុល្យដើម</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot><tr><td colspan="5" class="right"><strong>សរុប</strong></td><td class="right"><strong>${fmtMoney(t.totalPayable, cur)}</strong></td><td class="right"><strong>${fmtMoney(t.paid, cur)}</strong></td><td class="right"><strong>${fmtMoney(t.remaining, cur)}</strong></td><td></td></tr></tfoot>
        </table>
        <table class="sign-table"><tr><td>ហត្ថលេខាអតិថិជន</td><td>ហត្ថលេខាអ្នកធានា</td><td>ហត្ថលេខាហាង</td></tr></table>`;

    const pageStyle = `
        @page { size: A4; margin: 15mm; }
        body { font-family: 'Khmer OS', Arial, sans-serif; font-size: 13px; color:#000; }
        .receipt-header { text-align:center; margin-bottom:16px; }
        .receipt-header h2 { margin:0; }
        table.print-info-table, table.print-schedule-table { width:100%; border-collapse:collapse; margin-bottom:14px; }
        table.print-info-table td, table.print-schedule-table th, table.print-schedule-table td { border:1px solid #333; padding:6px 8px; }
        table.print-schedule-table thead th { background:#f0f0f0; }
        table.sign-table { width:100%; margin-top:40px; text-align:center; }
        table.sign-table td { padding-top:60px; width:33%; }
        .right { text-align:right; } .center { text-align:center; }
    `;

    const printWindow = window.open('', '_blank');
    if (!printWindow) { showToast('សូមអនុញ្ញាត Pop-up (Allow Pop-ups) សម្រាប់គេហទំព័រនេះ ដើម្បីអាច Print បាន', 'error'); return; }
    printWindow.document.write(`<html><head><title>Installment - ${esc(c.id)}</title><style>${pageStyle}</style></head><body>${bodyHtml}</body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.focus(); printWindow.print(); printWindow.close(); }, 250);
}
