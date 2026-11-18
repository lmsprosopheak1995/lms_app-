// =====================================================================
// pawn.js — Pawn (បញ្ចាំ) module: pawn tickets, interest payments, renewals, partial
// principal payments, redemption (ថ្កោលដោះ), forfeiture (រឹបអូស), printable ticket + receipts,
// and an overdue list.
// Data: pawnContracts (array) and pawnTransactions (pawnId -> array of records),
// persisted through persistData() -> db.js -> Supabase (tables pawn_contracts / pawn_transactions).
//
// Interest model: simple interest on the OUTSTANDING principal, accrued from the "paid through"
// date (last interest payment, else the pawn date) up to a chosen date. Rate unit: day / week /
// month / year (month = 30 days, year = 12 months), rate type: percent or fixed amount per unit.
// Whole calendar months count as exactly 1 unit, leftover days are pro-rated (days / 30).
// =====================================================================

const PWN_UNIT_LABEL = { day: 'ថ្ងៃ', week: 'សប្តាហ៍', month: 'ខែ', year: 'ឆ្នាំ' };
const PWN_ITEM_TYPES = {
    gold: 'មាស / គ្រឿងអលង្ការ', phone: 'ទូរសព្ទ / អេឡិចត្រូនិក', motorbike: 'ម៉ូតូ',
    car: 'ឡាន', land: 'ប័ណ្ណកម្មសិទ្ធិដី / ផ្ទះ', other: 'ផ្សេងៗ'
};
const PWN_TX_LABEL = {
    interest: 'បង់ការប្រាក់', renew: 'បន្តកាលកំណត់', principal: 'បង់ដើមខ្លះ',
    redeem: 'ថ្កោលដោះ', forfeit: 'រឹបអូស'
};

// ---------------------------------------------------------------------
// Date / money helpers (kept local so this module does not depend on other modules)
// ---------------------------------------------------------------------
function pwnRound(value, currency) {
    if (currency === 'KHR') return Math.round(value);
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
function pwnLocalISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function pwnToday() { return pwnLocalISO(new Date()); }
function pwnParse(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function pwnDays(aISO, bISO) { return Math.round((pwnParse(bISO) - pwnParse(aISO)) / 86400000); }
function pwnAddMonths(startISO, k) {
    const [y, m, d] = startISO.split('-').map(Number);
    const t = new Date(y, m - 1 + k, 1);
    const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(d, lastDay));
    return pwnLocalISO(t);
}
function pwnAddPeriod(startISO, unit, k) {
    if (unit === 'month') return pwnAddMonths(startISO, k);
    if (unit === 'year') return pwnAddMonths(startISO, 12 * k);
    const [y, m, d] = startISO.split('-').map(Number);
    return pwnLocalISO(new Date(y, m - 1, d + k * (unit === 'week' ? 7 : 1)));
}
function pwnBadge(label, color) {
    return `<span class="status-badge" style="background:${color};color:#fff;padding:2px 10px;border-radius:12px;">${label}</span>`;
}

// Interest "units" elapsed between two dates (whole months = 1.0, leftover days / 30).
function pwnUnits(fromISO, toISO, unit) {
    if (!fromISO || !toISO || toISO <= fromISO) return 0;
    if (unit === 'day') return pwnDays(fromISO, toISO);
    if (unit === 'week') return pwnDays(fromISO, toISO) / 7;
    let months = 0;
    while (months < 1200 && pwnAddMonths(fromISO, months + 1) <= toISO) months++;
    const rem = pwnDays(pwnAddMonths(fromISO, months), toISO);
    const totalMonths = months + rem / 30;
    return unit === 'year' ? totalMonths / 12 : totalMonths;
}

async function generateNewPawnId() {
    const year = new Date().getFullYear();
    let nextNum = pawnContracts.filter(c => c.id && c.id.startsWith(`PWN-${year}-`)).length + 1;
    let newId = `PWN-${year}-${String(nextNum).padStart(4, '0')}`;
    while (pawnContracts.some(c => c.id === newId)) {
        nextNum++;
        newId = `PWN-${year}-${String(nextNum).padStart(4, '0')}`;
    }
    return newId;
}

// ---------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------
function getPawnTx(c) { return pawnTransactions[c.id] || []; }

function getPawnOutstandingPrincipal(c, asOfISO) {
    const paid = getPawnTx(c)
        .filter(t => t.type === 'principal' && (!asOfISO || t.date <= asOfISO))
        .reduce((s, t) => s + (Number(t.principalAmount) || 0), 0);
    return Math.max(0, pwnRound((Number(c.principal) || 0) - paid, c.currency));
}

function getPawnPaidThrough(c) {
    let through = c.startDate;
    getPawnTx(c).forEach(t => {
        if ((t.type === 'interest' || t.type === 'renew') && t.paidThrough && t.paidThrough > through) through = t.paidThrough;
    });
    return through;
}

function getPawnDueDate(c) {
    let due = pwnAddPeriod(c.startDate, c.termUnit || 'month', parseInt(c.termCount, 10) || 1);
    const renewals = getPawnTx(c).filter(t => t.type === 'renew' && t.newDueDate).sort((a, b) => a.ts.localeCompare(b.ts));
    if (renewals.length) due = renewals[renewals.length - 1].newDueDate;
    return due;
}

// Interest accrued on the outstanding principal between two dates.
function calcPawnInterest(c, fromISO, toISO) {
    if (!fromISO || !toISO || toISO <= fromISO) return 0;
    const unit = c.interestUnit || 'month';
    const rate = Number(c.interestRate) || 0;
    const isPercent = (c.interestRateType || 'percent') === 'percent';

    const breakpoints = [...new Set(getPawnTx(c)
        .filter(t => t.type === 'principal' && t.date > fromISO && t.date < toISO)
        .map(t => t.date))].sort();
    breakpoints.push(toISO);

    let total = 0, prevUnits = 0, segStart = fromISO;
    breakpoints.forEach(bp => {
        const units = pwnUnits(fromISO, bp, unit);
        const segUnits = units - prevUnits;
        const principal = getPawnOutstandingPrincipal(c, segStart);
        total += isPercent ? principal * (rate / 100) * segUnits : rate * segUnits;
        prevUnits = units;
        segStart = bp;
    });
    return pwnRound(total, c.currency);
}

function getPawnStatus(c) {
    const tx = getPawnTx(c);
    if (tx.some(t => t.type === 'redeem')) return { key: 'redeemed', label: 'បានថ្កោលដោះ', color: 'var(--success)' };
    if (tx.some(t => t.type === 'forfeit')) return { key: 'forfeited', label: 'បានរឹបអូស', color: '#6c3483' };
    const today = pwnToday();
    const due = getPawnDueDate(c);
    if (today > due) {
        const late = pwnDays(due, today);
        if (late > (Number(c.graceDays) || 0)) return { key: 'seizable', label: 'អាចរឹបអូស', color: 'var(--danger)' };
        return { key: 'overdue', label: 'ហួសកាលកំណត់', color: 'var(--warning, #e0a800)' };
    }
    return { key: 'active', label: 'កំពុងបញ្ចាំ', color: 'var(--info, #17a2b8)' };
}

function isPawnOpen(c) {
    const k = getPawnStatus(c).key;
    return k !== 'redeemed' && k !== 'forfeited';
}

function getPawnSnapshot(c) {
    const open = isPawnOpen(c);
    const today = pwnToday();
    const due = getPawnDueDate(c);
    const outstanding = open ? getPawnOutstandingPrincipal(c) : 0;
    const interestDue = open ? calcPawnInterest(c, getPawnPaidThrough(c), today) : 0;
    return {
        open, due, today, outstanding, interestDue,
        totalToRedeem: outstanding + interestDue,
        daysLate: open && today > due ? pwnDays(due, today) : 0
    };
}

function pawnInterestText(c) {
    const unit = PWN_UNIT_LABEL[c.interestUnit || 'month'];
    return (c.interestRateType === 'fixed')
        ? `${fmtMoney(c.interestRate, c.currency)} / ${unit}`
        : `${c.interestRate}% / ${unit}`;
}

// ---------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------
function createPawnDataFromForm() {
    const v = id => document.getElementById(id).value;
    return {
        customerName: v('pwnCustomerName').trim(),
        customerPhone: v('pwnCustomerPhone').trim(),
        customerIdNo: v('pwnCustomerIdNo').trim(),
        itemType: v('pwnItemType'),
        itemName: v('pwnItemName').trim(),
        itemSerial: v('pwnItemSerial').trim(),
        estimatedValue: parseFloat(v('pwnItemValue')) || 0,
        storageLocation: v('pwnStorage').trim(),
        currency: v('pwnCurrency'),
        startDate: v('pwnStartDate'),
        principal: parseFloat(v('pwnPrincipal')) || 0,
        termCount: parseInt(v('pwnTermCount'), 10) || 0,
        termUnit: v('pwnTermUnit'),
        interestRateType: v('pwnInterestRateType'),
        interestRate: parseFloat(v('pwnInterestRate')) || 0,
        interestUnit: v('pwnInterestUnit'),
        graceDays: parseInt(v('pwnGraceDays'), 10) || 0,
        note: v('pwnNote').trim()
    };
}

function validatePawnForm(d) {
    const errors = [];
    if (!d.customerName) errors.push('ឈ្មោះអតិថិជន');
    if (!d.itemName) errors.push('ទ្រព្យបញ្ចាំ');
    if (!d.startDate) errors.push('ថ្ងៃបញ្ចាំ');
    if (!(d.principal > 0)) errors.push('ទឹកប្រាក់កម្ចី (>0)');
    if (!(d.termCount >= 1)) errors.push('រយៈពេលបញ្ចាំ (≥1)');
    if (d.interestRate < 0) errors.push('អត្រាការប្រាក់មិនអាចអវិជ្ជមាន');
    if (d.graceDays < 0) errors.push('ថ្ងៃអនុគ្រោះមិនអាចអវិជ្ជមាន');
    if (errors.length) {
        showToast('សូមពិនិត្យមើលកំហុស:\n - ' + errors.join('\n - '), 'error');
        return false;
    }
    return true;
}

function updatePawnPreview() {
    const box = document.getElementById('pawnPreview');
    if (!box) return;
    const d = createPawnDataFromForm();
    if (!(d.principal > 0) || !(d.termCount >= 1) || !d.startDate) { box.innerHTML = ''; return; }
    const perUnit = d.interestRateType === 'fixed' ? d.interestRate : d.principal * d.interestRate / 100;
    const ltv = d.estimatedValue > 0 ? `${(d.principal / d.estimatedValue * 100).toFixed(1)}%` : '-';
    box.innerHTML = `
        <div>ថ្ងៃផុតកំណត់</div><div>${formatDateDMY(pwnAddPeriod(d.startDate, d.termUnit, d.termCount))}</div>
        <div>ការប្រាក់ក្នុងមួយ${PWN_UNIT_LABEL[d.interestUnit]}</div><div>${fmtMoney(pwnRound(perUnit, d.currency), d.currency)}</div>
        <div>កម្ចី ÷ តម្លៃប៉ាន់ស្មាន</div><div>${ltv}</div>`;
}

function clearPawnForm() {
    document.getElementById('pawnForm').reset();
    document.getElementById('pwnContractId').value = '';
    document.getElementById('pwnStartDate').value = formatDateISO(new Date());
    document.getElementById('pawnFormTitle').innerHTML = '<i class="fas fa-gem"></i> សំបុត្របញ្ចាំថ្មី';
    currentPawnContract = null;
    const detail = document.getElementById('pawnDetail');
    if (detail) detail.style.display = 'none';
    updatePawnPreview();
}

async function savePawnContract(e) {
    e.preventDefault();
    const idFromForm = document.getElementById('pwnContractId').value;
    if (idFromForm) {
        if (!hasPermission('canEditLoan')) { showToast('Permission Denied.', 'error'); return; }
    } else if (!hasPermission('canManagePayments')) {
        showToast('Permission Denied.', 'error'); return;
    }
    const data = createPawnDataFromForm();
    if (!validatePawnForm(data)) return;

    const username = currentUser ? currentUser.username : 'N/A';
    let savedId = idFromForm;
    if (idFromForm) {
        const idx = pawnContracts.findIndex(c => c.id === idFromForm);
        if (idx === -1) { showToast('រកមិនឃើញសំបុត្របញ្ចាំ', 'error'); return; }
        pawnContracts[idx] = { ...pawnContracts[idx], ...data, updatedBy: username, updatedAt: new Date().toISOString() };
        showToast('រក្សាទុកបានជោគជ័យ!', 'success');
    } else {
        savedId = await generateNewPawnId();
        pawnContracts.push({ id: savedId, ...data, createdBy: username, createdAt: new Date().toISOString() });
        showToast('សំបុត្របញ្ចាំថ្មីត្រូវបានបង្កើត!', 'success');
        notifyTelegram(`💎 <b>សំបុត្របញ្ចាំថ្មី</b>\nលេខ: ${savedId}\nអតិថិជន: ${data.customerName}\nទ្រព្យ: ${data.itemName}\nទឹកប្រាក់: ${data.principal} ${data.currency}\nដោយ: ${username}`);
    }
    persistData(LS_KEYS.pawnContracts, pawnContracts);
    displayPawnContracts();
    loadPawnContract(savedId);
}

function loadPawnContract(contractId) {
    const c = pawnContracts.find(x => x.id === contractId);
    if (!c) return;
    currentPawnContract = c;
    const set = (id, val) => { document.getElementById(id).value = val == null ? '' : val; };
    set('pwnContractId', c.id);
    set('pwnCustomerName', c.customerName); set('pwnCustomerPhone', c.customerPhone); set('pwnCustomerIdNo', c.customerIdNo);
    set('pwnItemType', c.itemType); set('pwnItemName', c.itemName); set('pwnItemSerial', c.itemSerial);
    set('pwnItemValue', c.estimatedValue); set('pwnStorage', c.storageLocation);
    set('pwnCurrency', c.currency); set('pwnStartDate', c.startDate);
    set('pwnPrincipal', c.principal); set('pwnTermCount', c.termCount); set('pwnTermUnit', c.termUnit);
    set('pwnInterestRateType', c.interestRateType); set('pwnInterestRate', c.interestRate); set('pwnInterestUnit', c.interestUnit);
    set('pwnGraceDays', c.graceDays); set('pwnNote', c.note);
    document.getElementById('pawnFormTitle').innerHTML = `<i class="fas fa-gem"></i> សំបុត្របញ្ចាំ: ${esc(c.id)}`;
    updatePawnPreview();
    renderPawnDetail(c);
    document.getElementById('pawnDetail').style.display = 'block';
    document.getElementById('pawnForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deletePawnContract(contractId) {
    if (!hasPermission('canDeletePawn')) { showToast('Permission Denied.', 'error'); return; }
    const c = pawnContracts.find(x => x.id === contractId);
    if (!c) return;
    if (!(await customConfirm(`តើអ្នកពិតជាចង់លុបសំបុត្របញ្ចាំ ${contractId} ឬ? ប្រតិបត្តិការទាំងអស់ក៏នឹងត្រូវលុបដែរ។`))) return;
    pawnContracts = pawnContracts.filter(x => x.id !== contractId);
    delete pawnTransactions[contractId];
    persistData(LS_KEYS.pawnContracts, pawnContracts);
    persistData(LS_KEYS.pawnTransactions, pawnTransactions);
    if (currentPawnContract && currentPawnContract.id === contractId) clearPawnForm();
    displayPawnContracts();
    showToast('សំបុត្របញ្ចាំត្រូវបានលុប', 'info');
    notifyTelegram(`🗑️ <b>សំបុត្របញ្ចាំត្រូវបានលុប</b>\nលេខ: ${contractId}\nអតិថិជន: ${c.customerName}\nដោយ: ${currentUser ? currentUser.username : 'N/A'}`);
}

// ---------------------------------------------------------------------
// List, filters, overdue panel
// ---------------------------------------------------------------------
function displayPawnContracts() {
    const tbody = document.getElementById('pawnContractsTableBody');
    if (!tbody) return;
    const q = ((document.getElementById('pwnSearch') || {}).value || '').trim().toLowerCase();
    const statusFilter = (document.getElementById('pwnFilterStatus') || {}).value || 'all';
    const canDelete = hasPermission('canDeletePawn');

    renderPawnOverduePanel();

    const rows = pawnContracts.filter(c => {
        if (q && !`${c.id} ${c.customerName} ${c.customerPhone || ''} ${c.itemName} ${c.itemSerial || ''}`.toLowerCase().includes(q)) return false;
        if (statusFilter !== 'all' && getPawnStatus(c).key !== statusFilter) return false;
        return true;
    });
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888">មិនមានសំបុត្របញ្ចាំ</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map((c, i) => {
        const s = getPawnSnapshot(c);
        const st = getPawnStatus(c);
        return `<tr>
            <td>${i + 1}</td>
            <td>${esc(c.id)}</td>
            <td>${esc(c.customerName)}<br><small>${esc(c.customerPhone || '')}</small></td>
            <td>${esc(PWN_ITEM_TYPES[c.itemType] || '')}<br><small>${esc(c.itemName)}</small></td>
            <td class="right">${fmtMoney(s.outstanding, c.currency)}</td>
            <td class="right">${fmtMoney(s.interestDue, c.currency)}</td>
            <td>${formatDateDMY(s.due)}</td>
            <td>${pwnBadge(st.label, st.color)}</td>
            <td class="center actions">
                <button class="btn btn-sm btn-success" onclick="loadPawnContract('${esc(c.id)}')"><i class="fas fa-edit"></i> Manage</button>
                ${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deletePawnContract('${esc(c.id)}')"><i class="fas fa-trash"></i></button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

function renderPawnOverduePanel() {
    const panel = document.getElementById('pawnOverduePanel');
    if (!panel) return;
    const list = [];
    pawnContracts.forEach(c => {
        const st = getPawnStatus(c);
        if (st.key === 'overdue' || st.key === 'seizable') list.push({ c, st, s: getPawnSnapshot(c) });
    });
    if (list.length === 0) { panel.innerHTML = ''; return; }
    list.sort((a, b) => b.s.daysLate - a.s.daysLate);
    const body = list.map((r, i) => `
        <tr class="clickable-row" onclick="loadPawnContract('${esc(r.c.id)}')">
            <td>${i + 1}</td><td>${esc(r.c.id)}</td><td>${esc(r.c.customerName)}</td><td>${esc(r.c.customerPhone || '')}</td>
            <td>${esc(r.c.itemName)}</td>
            <td class="right">${fmtMoney(r.s.outstanding, r.c.currency)}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${fmtMoney(r.s.interestDue, r.c.currency)}</td>
            <td>${formatDateDMY(r.s.due)}</td>
            <td class="right" style="color:var(--danger);font-weight:bold">${r.s.daysLate} ថ្ងៃ</td>
            <td>${pwnBadge(r.st.label, r.st.color)}</td>
        </tr>`).join('');
    panel.innerHTML = `
        <h3 style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> បញ្ចាំហួសកាលកំណត់ (${list.length})</h3>
        <div class="table-container"><table>
            <thead><tr><th>ល.រ</th><th>លេខសំបុត្រ</th><th>អតិថិជន</th><th>ទូរសព្ទ</th><th>ទ្រព្យបញ្ចាំ</th><th>ដើមនៅសល់</th><th>ការប្រាក់ជំពាក់</th><th>ថ្ងៃផុតកំណត់</th><th>យឺតជាង</th><th>ស្ថានភាព</th></tr></thead>
            <tbody>${body}</tbody>
        </table></div>`;
}

// ---------------------------------------------------------------------
// Detail: summary, action buttons, history
// ---------------------------------------------------------------------
function renderPawnDetail(c) {
    const s = getPawnSnapshot(c);
    const st = getPawnStatus(c);
    const cur = c.currency;

    document.getElementById('pawnSummary').innerHTML = `
        <div>ទ្រព្យបញ្ចាំ</div><div>${esc(PWN_ITEM_TYPES[c.itemType] || '')} - ${esc(c.itemName)}</div>
        <div>ទឹកប្រាក់កម្ចីដើម</div><div>${fmtMoney(c.principal, cur)}</div>
        <div>ដើមនៅសល់</div><div style="font-weight:bold">${fmtMoney(s.outstanding, cur)}</div>
        <div>ការប្រាក់ (${esc(pawnInterestText(c))})</div><div>${fmtMoney(s.interestDue, cur)} <small>(ចាប់ពី ${formatDateDMY(getPawnPaidThrough(c))})</small></div>
        <div>ត្រូវបង់ដើម្បីថ្កោលដោះថ្ងៃនេះ</div><div style="font-weight:bold;color:var(--danger)">${fmtMoney(s.totalToRedeem, cur)}</div>
        <div>ថ្ងៃផុតកំណត់</div><div>${formatDateDMY(s.due)}${s.daysLate ? ` <span style="color:var(--danger)">(យឺត ${s.daysLate} ថ្ងៃ)</span>` : ''}</div>
        <div>ស្ថានភាព</div><div>${pwnBadge(st.label, st.color)}</div>`;

    const canPay = hasPermission('canManagePayments') && s.open;
    const canForfeit = hasPermission('canWriteOff') && s.open;
    const btn = (label, icon, cls, action) =>
        `<button type="button" class="btn ${cls}" onclick="openPawnAction('${action}')"><i class="fas ${icon}"></i> ${label}</button>`;
    document.getElementById('pawnActions').innerHTML =
        (canPay ? btn('បង់ការប្រាក់', 'fa-coins', 'btn-success', 'interest') +
                  btn('បន្តកាលកំណត់', 'fa-redo', 'btn-info', 'renew') +
                  btn('បង់ដើមខ្លះ', 'fa-hand-holding-usd', 'btn-muted', 'principal') +
                  btn('ថ្កោលដោះ', 'fa-unlock', 'btn-success', 'redeem') : '') +
        (canForfeit ? btn('រឹបអូស', 'fa-gavel', 'btn-danger', 'forfeit') : '') +
        `<button type="button" class="btn btn-info" onclick="printPawnTicket()"><i class="fas fa-print"></i> បោះពុម្ពសំបុត្របញ្ចាំ</button>`;

    renderPawnHistory(c);
}

function describePawnTx(t, cur) {
    if (t.type === 'interest') return `ប្រាក់ការប្រាក់ដល់ ${formatDateDMY(t.paidThrough)}`;
    if (t.type === 'renew') return `បន្តដល់ ${formatDateDMY(t.newDueDate)} (ការប្រាក់ដល់ ${formatDateDMY(t.paidThrough)})`;
    if (t.type === 'principal') return `ដើមនៅសល់ ${fmtMoney(t.principalAfter, cur)}`;
    if (t.type === 'redeem') return 'ថ្កោលដោះទ្រព្យបញ្ចាំ';
    if (t.type === 'forfeit') return `លក់បាន ${fmtMoney(t.saleAmount || 0, cur)}`;
    return '';
}

function renderPawnHistory(c) {
    const tbody = document.getElementById('pawnHistoryTableBody');
    const list = [...getPawnTx(c)].sort((a, b) => (a.date + a.ts).localeCompare(b.date + b.ts));
    const canDelete = hasPermission('canDeletePawn');
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#888">មិនទាន់មានប្រតិបត្តិការ</td></tr>';
        return;
    }
    tbody.innerHTML = list.map((t, i) => `<tr>
        <td>${i + 1}</td>
        <td>${formatDateDMY(t.date)}</td>
        <td>${esc(PWN_TX_LABEL[t.type] || t.type)}</td>
        <td class="right">${t.principalAmount ? fmtMoney(t.principalAmount, c.currency) : ''}</td>
        <td class="right">${t.interestAmount ? fmtMoney(t.interestAmount, c.currency) : ''}</td>
        <td>${esc(describePawnTx(t, c.currency))}${t.note ? `<br><small>${esc(t.note)}</small>` : ''}</td>
        <td>${esc(t.by || '')}</td>
        <td class="center actions">
            ${t.type !== 'forfeit' ? `<button class="btn btn-sm btn-info" title="បោះពុម្ពបង្កាន់ដៃ" onclick="printPawnReceipt('${esc(t.id)}')"><i class="fas fa-receipt"></i></button>` : ''}
            ${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deletePawnTransaction('${esc(t.id)}')"><i class="fas fa-trash"></i></button>` : ''}
        </td>
    </tr>`).join('');
}

// ---------------------------------------------------------------------
// Transactions (interest / renew / principal / redeem / forfeit)
// ---------------------------------------------------------------------
let pawnActionType = null;

function openPawnAction(type) {
    const c = currentPawnContract;
    if (!c) return;
    if (!isPawnOpen(c)) { showToast('សំបុត្រនេះបានបិទរួចហើយ', 'error'); return; }
    pawnActionType = type;
    const s = getPawnSnapshot(c);
    const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };

    document.getElementById('pwnTxTitle').innerHTML = `<i class="fas fa-gem"></i> ${PWN_TX_LABEL[type]} - ${esc(c.id)}`;
    document.getElementById('pwnTxInfo').innerHTML = `
        <div>អតិថិជន</div><div>${esc(c.customerName)}</div>
        <div>ដើមនៅសល់</div><div>${fmtMoney(s.outstanding, c.currency)}</div>
        <div>ការប្រាក់ដល់ថ្ងៃនេះ</div><div>${fmtMoney(s.interestDue, c.currency)}</div>
        <div>ថ្ងៃផុតកំណត់បច្ចុប្បន្ន</div><div>${formatDateDMY(s.due)}</div>`;

    show('pwnWrapPrincipal', type === 'principal' || type === 'redeem');
    show('pwnWrapInterest', type === 'interest' || type === 'renew' || type === 'redeem');
    show('pwnWrapPaidThrough', type === 'interest' || type === 'renew');
    show('pwnWrapNewDue', type === 'renew');
    show('pwnWrapSale', type === 'forfeit');

    document.getElementById('pwnTxDate').value = s.today;
    document.getElementById('pwnTxNote').value = '';
    document.getElementById('pwnTxPrincipal').value = type === 'redeem' ? s.outstanding : '';
    document.getElementById('pwnTxSale').value = '';

    if (type === 'renew') {
        const through = s.today > s.due ? s.today : s.due;
        document.getElementById('pwnTxPaidThrough').value = through;
        document.getElementById('pwnTxNewDue').value = pwnAddPeriod(s.due, c.termUnit || 'month', parseInt(c.termCount, 10) || 1);
    } else if (type === 'interest') {
        document.getElementById('pwnTxPaidThrough').value = s.today;
    }
    pawnRecalcInterestDefault();
    document.getElementById('pwnTxSubmit').disabled = false;
    document.getElementById('pawnActionModal').style.display = 'flex';
}

function closePawnActionModal() {
    document.getElementById('pawnActionModal').style.display = 'none';
    pawnActionType = null;
}

// Re-suggest the interest amount whenever the date / "paid through" date changes (still editable).
function pawnRecalcInterestDefault() {
    const c = currentPawnContract;
    if (!c || !pawnActionType) return;
    const date = document.getElementById('pwnTxDate').value;
    let target = null;
    if (pawnActionType === 'interest' || pawnActionType === 'renew') {
        target = document.getElementById('pwnTxPaidThrough').value;
    } else if (pawnActionType === 'redeem') {
        target = date;
    }
    if (target) {
        document.getElementById('pwnTxInterest').value = calcPawnInterest(c, getPawnPaidThrough(c), target);
    } else {
        document.getElementById('pwnTxInterest').value = '';
    }
}

function pawnOnTxDateChange() {
    const type = pawnActionType;
    if (type === 'interest') document.getElementById('pwnTxPaidThrough').value = document.getElementById('pwnTxDate').value;
    pawnRecalcInterestDefault();
}

function savePawnTransaction(e) {
    e.preventDefault();
    const c = currentPawnContract;
    const type = pawnActionType;
    if (!c || !type) return;
    if (!isPawnOpen(c)) { showToast('សំបុត្រនេះបានបិទរួចហើយ', 'error'); return; }
    if (type === 'forfeit' ? !hasPermission('canWriteOff') : !hasPermission('canManagePayments')) {
        showToast('Permission Denied.', 'error'); return;
    }

    const val = id => document.getElementById(id).value;
    const date = val('pwnTxDate');
    const note = val('pwnTxNote').trim();
    const principalAmount = parseFloat(val('pwnTxPrincipal')) || 0;
    const interestAmount = parseFloat(val('pwnTxInterest')) || 0;
    const paidThrough = val('pwnTxPaidThrough');
    const newDueDate = val('pwnTxNewDue');
    const saleAmount = parseFloat(val('pwnTxSale')) || 0;
    const outstanding = getPawnOutstandingPrincipal(c);

    if (!date) { showToast('សូមបញ្ចូលកាលបរិច្ឆេទ', 'error'); return; }
    if (date < c.startDate) { showToast('កាលបរិច្ឆេទមិនអាចមុនថ្ងៃបញ្ចាំ', 'error'); return; }
    if ((type === 'interest' || type === 'renew') && (!(interestAmount >= 0) || !paidThrough || paidThrough <= getPawnPaidThrough(c))) {
        showToast('ការប្រាក់ត្រូវបង់ដល់ថ្ងៃក្រោយពីថ្ងៃដែលបានបង់ចុងក្រោយ (' + formatDateDMY(getPawnPaidThrough(c)) + ')', 'error'); return;
    }
    if (type === 'interest' && !(interestAmount > 0)) { showToast('សូមបញ្ចូលចំនួនការប្រាក់', 'error'); return; }
    if (type === 'renew' && (!newDueDate || newDueDate <= getPawnDueDate(c))) { showToast('ថ្ងៃផុតកំណត់ថ្មីត្រូវក្រោយថ្ងៃផុតកំណត់បច្ចុប្បន្ន', 'error'); return; }
    if (type === 'principal') {
        if (!(principalAmount > 0)) { showToast('សូមបញ្ចូលចំនួនដើមដែលបង់', 'error'); return; }
        if (principalAmount >= outstanding) { showToast('ដើមដែលបង់ត្រូវតិចជាងដើមនៅសល់ (បើបង់អស់ សូមប្រើ "ថ្កោលដោះ")', 'error'); return; }
    }
    if (type === 'redeem' && principalAmount < outstanding - 0.005) {
        showToast('ត្រូវបង់ដើមឱ្យអស់ដើម្បីថ្កោលដោះ (' + fmtMoney(outstanding, c.currency) + ')', 'error'); return;
    }

    const record = {
        id: genId(), type, date, note,
        by: currentUser ? currentUser.username : 'N/A',
        ts: new Date().toISOString()
    };
    if (type === 'interest' || type === 'renew') {
        record.interestAmount = interestAmount;
        record.paidThrough = paidThrough;
        if (type === 'renew') record.newDueDate = newDueDate;
        record.principalAfter = outstanding;
    } else if (type === 'principal') {
        record.principalAmount = principalAmount;
        record.principalAfter = pwnRound(outstanding - principalAmount, c.currency);
    } else if (type === 'redeem') {
        record.principalAmount = principalAmount;
        record.interestAmount = interestAmount;
        record.interestFrom = getPawnPaidThrough(c);
        record.paidThrough = date;
        record.principalAfter = 0;
    } else if (type === 'forfeit') {
        record.saleAmount = saleAmount;
        record.principalAfter = outstanding;
    }

    if (!pawnTransactions[c.id]) pawnTransactions[c.id] = [];
    pawnTransactions[c.id].push(record);
    persistData(LS_KEYS.pawnTransactions, pawnTransactions);

    closePawnActionModal();
    renderPawnDetail(c);
    displayPawnContracts();
    showToast(`${PWN_TX_LABEL[type]} ត្រូវបានរក្សាទុក`, 'success');
    const amt = (record.principalAmount || 0) + (record.interestAmount || 0);
    notifyTelegram(`💎 <b>${PWN_TX_LABEL[type]}</b>\nលេខ: ${c.id}\nអតិថិជន: ${c.customerName}\nទ្រព្យ: ${c.itemName}\nចំនួន: ${amt} ${c.currency}\nកាលបរិច្ឆេទ: ${date}\nដោយ: ${record.by}`);
}

async function deletePawnTransaction(txId) {
    if (!hasPermission('canDeletePawn')) { showToast('Permission Denied.', 'error'); return; }
    const c = currentPawnContract;
    if (!c || !pawnTransactions[c.id]) return;
    if (!(await customConfirm('តើអ្នកពិតជាចង់លុបប្រតិបត្តិការនេះឬ? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ។'))) return;
    pawnTransactions[c.id] = pawnTransactions[c.id].filter(t => t.id !== txId);
    persistData(LS_KEYS.pawnTransactions, pawnTransactions);
    renderPawnDetail(c);
    displayPawnContracts();
}

// ---------------------------------------------------------------------
// Printing: pawn ticket + receipts
// ---------------------------------------------------------------------
function pwnOpenPrint(title, bodyHtml) {
    const pageStyle = `
        @page { size: A4; margin: 12mm; }
        body { font-family: 'Khmer OS', Arial, sans-serif; font-size: 13px; color:#000; }
        .copy { border-bottom: 2px dashed #777; padding-bottom: 14px; margin-bottom: 14px; }
        .copy:last-child { border-bottom: none; }
        .tag { text-align:right; font-size:11px; color:#555; }
        .receipt-header { text-align:center; margin-bottom:10px; }
        .receipt-header h2 { margin:0; }
        table.info { width:100%; border-collapse:collapse; margin-bottom:10px; }
        table.info td { border:1px solid #333; padding:5px 8px; }
        table.info td.k { background:#f3f3f3; width:22%; }
        .terms { font-size:12px; margin:8px 0; }
        table.sign { width:100%; text-align:center; margin-top:8px; }
        table.sign td { padding-top:44px; width:50%; }
        .right { text-align:right; }
    `;
    const w = window.open('', '_blank');
    if (!w) { showToast('សូមអនុញ្ញាត Pop-up (Allow Pop-ups) សម្រាប់គេហទំព័រនេះ ដើម្បីអាច Print បាន', 'error'); return; }
    w.document.write(`<html><head><title>${esc(title)}</title><style>${pageStyle}</style></head><body>${bodyHtml}</body></html>`);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); w.close(); }, 250);
}

function printPawnTicket() {
    const c = currentPawnContract;
    if (!c) { showToast('សូមជ្រើសរើសសំបុត្របញ្ចាំជាមុនសិន', 'error'); return; }
    const cur = c.currency;
    const due = pwnAddPeriod(c.startDate, c.termUnit || 'month', parseInt(c.termCount, 10) || 1);
    const copy = label => `
        <div class="copy">
            <div class="tag">${label}</div>
            <div class="receipt-header"><h2>សំបុត្របញ្ចាំ - PAWN TICKET</h2></div>
            <table class="info">
                <tr><td class="k">លេខសំបុត្រ</td><td><strong>${esc(c.id)}</strong></td><td class="k">ថ្ងៃបញ្ចាំ</td><td><strong>${formatDateDMY(c.startDate)}</strong></td></tr>
                <tr><td class="k">អតិថិជន</td><td><strong>${esc(c.customerName)}</strong></td><td class="k">ទូរសព្ទ</td><td>${esc(c.customerPhone || '')}</td></tr>
                <tr><td class="k">អត្តសញ្ញាណប័ណ្ណ</td><td colspan="3">${esc(c.customerIdNo || '')}</td></tr>
                <tr><td class="k">ទ្រព្យបញ្ចាំ</td><td colspan="3"><strong>${esc(PWN_ITEM_TYPES[c.itemType] || '')}</strong> - ${esc(c.itemName)} ${c.itemSerial ? `(លេខស៊េរី/ស៊ីសង់: ${esc(c.itemSerial)})` : ''}</td></tr>
                <tr><td class="k">តម្លៃប៉ាន់ស្មាន</td><td>${c.estimatedValue ? fmtMoney(c.estimatedValue, cur) : '-'}</td><td class="k">ទីតាំងរក្សាទុក</td><td>${esc(c.storageLocation || '')}</td></tr>
                <tr><td class="k">ទឹកប្រាក់កម្ចី</td><td><strong>${fmtMoney(c.principal, cur)}</strong></td><td class="k">ការប្រាក់</td><td>${esc(pawnInterestText(c))}</td></tr>
                <tr><td class="k">រយៈពេល</td><td>${c.termCount} ${PWN_UNIT_LABEL[c.termUnit || 'month']}</td><td class="k">ថ្ងៃផុតកំណត់</td><td><strong>${formatDateDMY(due)}</strong></td></tr>
            </table>
            <div class="terms">
                លក្ខខណ្ឌ៖ អតិថិជនត្រូវបង់ការប្រាក់ និងថ្កោលដោះមុនថ្ងៃផុតកំណត់ ឬបន្តកាលកំណត់។
                បើហួសកាលកំណត់ ${Number(c.graceDays) || 0} ថ្ងៃ ហាងមានសិទ្ធិរឹបអូស និងលក់ទ្រព្យបញ្ចាំ។
                ${c.note ? `<br>កំណត់ចំណាំ៖ ${esc(c.note)}` : ''}
            </div>
            <table class="sign"><tr><td>ហត្ថលេខាអតិថិជន</td><td>ហត្ថលេខាអ្នកទទួល (ហាង)</td></tr></table>
        </div>`;
    pwnOpenPrint(`Pawn Ticket - ${c.id}`, copy('ច្បាប់ចម្លងអតិថិជន') + copy('ច្បាប់ចម្លងហាង'));
}

function printPawnReceipt(txId) {
    const c = currentPawnContract;
    if (!c) return;
    const list = [...getPawnTx(c)].sort((a, b) => (a.date + a.ts).localeCompare(b.date + b.ts));
    const idx = list.findIndex(t => t.id === txId);
    if (idx === -1) return;
    const t = list[idx];
    const cur = c.currency;
    const total = (t.principalAmount || 0) + (t.interestAmount || 0);
    const titles = {
        interest: 'បង្កាន់ដៃបង់ការប្រាក់ - INTEREST RECEIPT',
        renew: 'បង្កាន់ដៃបន្តកាលកំណត់ - RENEWAL RECEIPT',
        principal: 'បង្កាន់ដៃបង់ដើមខ្លះ - PRINCIPAL PAYMENT RECEIPT',
        redeem: 'បង្កាន់ដៃថ្កោលដោះ - REDEMPTION RECEIPT'
    };
    let detailRows = '';
    if (t.type === 'interest' || t.type === 'renew') {
        detailRows += `<tr><td class="k">ការប្រាក់ដែលបានបង់</td><td class="right"><strong>${fmtMoney(t.interestAmount, cur)}</strong></td></tr>
                       <tr><td class="k">ការប្រាក់បានបង់ដល់ថ្ងៃ</td><td class="right">${formatDateDMY(t.paidThrough)}</td></tr>`;
        if (t.type === 'renew') detailRows += `<tr><td class="k">ថ្ងៃផុតកំណត់ថ្មី</td><td class="right"><strong>${formatDateDMY(t.newDueDate)}</strong></td></tr>`;
        detailRows += `<tr><td class="k">ដើមនៅសល់</td><td class="right">${fmtMoney(t.principalAfter, cur)}</td></tr>`;
    } else if (t.type === 'principal') {
        detailRows += `<tr><td class="k">ដើមដែលបានបង់</td><td class="right"><strong>${fmtMoney(t.principalAmount, cur)}</strong></td></tr>
                       <tr><td class="k">ដើមនៅសល់</td><td class="right">${fmtMoney(t.principalAfter, cur)}</td></tr>`;
    } else if (t.type === 'redeem') {
        detailRows += `<tr><td class="k">ដើមដែលបានបង់</td><td class="right">${fmtMoney(t.principalAmount, cur)}</td></tr>
                       <tr><td class="k">ការប្រាក់ (ពី ${formatDateDMY(t.interestFrom || c.startDate)} ដល់ ${formatDateDMY(t.date)})</td><td class="right">${fmtMoney(t.interestAmount || 0, cur)}</td></tr>
                       <tr><td class="k">ទ្រព្យបញ្ចាំដែលបានប្រគល់វិញ</td><td class="right">${esc(c.itemName)} ${esc(c.itemSerial || '')}</td></tr>`;
    }
    const copy = label => `
        <div class="copy">
            <div class="tag">${label}</div>
            <div class="receipt-header"><h2>${titles[t.type] || 'RECEIPT'}</h2></div>
            <table class="info">
                <tr><td class="k">លេខបង្កាន់ដៃ</td><td>${esc(c.id)}-R${idx + 1}</td><td class="k">កាលបរិច្ឆេទ</td><td>${formatDateDMY(t.date)}</td></tr>
                <tr><td class="k">លេខសំបុត្របញ្ចាំ</td><td>${esc(c.id)}</td><td class="k">អតិថិជន</td><td>${esc(c.customerName)}</td></tr>
                <tr><td class="k">ទ្រព្យបញ្ចាំ</td><td colspan="3">${esc(PWN_ITEM_TYPES[c.itemType] || '')} - ${esc(c.itemName)}</td></tr>
            </table>
            <table class="info">${detailRows}
                <tr><td class="k"><strong>ទឹកប្រាក់សរុបបានទទួល</strong></td><td class="right"><strong>${fmtMoney(total, cur)}</strong></td></tr>
            </table>
            ${t.note ? `<div class="terms">កំណត់ចំណាំ៖ ${esc(t.note)}</div>` : ''}
            <table class="sign"><tr><td>ហត្ថលេខាអតិថិជន</td><td>អ្នកទទួល៖ ${esc(t.by || '')}</td></tr></table>
        </div>`;
    pwnOpenPrint(`Receipt - ${c.id}-R${idx + 1}`, copy('ច្បាប់ចម្លងអតិថិជន') + copy('ច្បាប់ចម្លងហាង'));
}
