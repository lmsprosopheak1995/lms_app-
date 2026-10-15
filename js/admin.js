// =====================================================================
// admin.js — Admin settings: holidays, loan products, expenses, expense categories, message templates.
// =====================================================================

// ===================== ADMIN FUNCTIONS (Holidays, Products, etc.) =====================
function saveHoliday(e) {
    e.preventDefault();
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const id = document.getElementById('holidayId').value;
    const date = document.getElementById('holidayDate').value;
    const name = document.getElementById('holidayName').value.trim();

    if (!date || !name) {
        showToast('Please provide both date and name.', 'error');
        return;
    }

    if (id) { // Editing
        const index = holidays.findIndex(h => h.id === id);
        if (index > -1) {
            holidays[index] = { id, date, name };
        }
    } else { // Adding new
        if (holidays.some(h => h.date === date)) {
            showToast('A holiday for this date already exists.', 'error');
            return;
        }
        holidays.push({ id: 'HOL-' + Date.now(), date, name });
    }

    persistData(LS_KEYS.holidays, holidays);
    renderHolidaysTable();
    clearHolidayForm();
}

function renderHolidaysTable() {
    const tbody = document.getElementById('holidaysTableBody');
    tbody.innerHTML = '';
    holidays.sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(h => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDMY(h.date)}</td>
            <td>${esc(h.name)}</td>
            <td class="actions">
                <button class="btn btn-sm btn-info" onclick="editHoliday('${esc(h.id)}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-danger" onclick="deleteHoliday('${esc(h.id)}')"><i class="fas fa-trash-alt"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function editHoliday(id) {
    const holiday = holidays.find(h => h.id === id);
    if (holiday) {
        document.getElementById('holidayId').value = holiday.id;
        document.getElementById('holidayDate').value = holiday.date;
        document.getElementById('holidayName').value = holiday.name;
    }
}

async function deleteHoliday(id) {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    if (await customConfirm('Are you sure you want to delete this holiday?')) {
        holidays = holidays.filter(h => h.id !== id);
        persistData(LS_KEYS.holidays, holidays);
        renderHolidaysTable();
    }
}

function clearHolidayForm() {
    document.getElementById('holidayForm').reset();
    document.getElementById('holidayId').value = '';
}

function saveLoanProduct(e) {
    e.preventDefault();
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const name = document.getElementById('productName').value.trim();
    const interestRate = parseFloat(document.getElementById('productInterestRate').value);
    const loanTerm = parseInt(document.getElementById('productLoanTerm').value);
    const paymentMethod = document.getElementById('productPaymentMethod').value;
    
    if (name && interestRate >= 0 && loanTerm > 0) {
        loanProducts.push({ id: 'PROD-' + Date.now(), name, interestRate, loanTerm, paymentMethod });
        persistData(LS_KEYS.loanProducts, loanProducts);
        renderLoanProductsTable();
        populateLoanProductDropdown();
        e.target.reset();
    } else {
        showToast('Please fill all fields correctly.', 'error');
    }
}

function renderLoanProductsTable() {
    const tbody = document.getElementById('loanProductsTableBody');
    tbody.innerHTML = '';
    loanProducts.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${esc(p.name)}</td>
            <td>${p.interestRate}%</td>
            <td>${p.loanTerm} months</td>
            <td>${esc(p.paymentMethod)}</td>
            <td class="actions"><button class="btn btn-sm btn-danger" onclick="deleteLoanProduct('${esc(p.id)}')"><i class="fas fa-trash-alt"></i></button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteLoanProduct(id) {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    if (await customConfirm('Are you sure? This will not affect existing loans.')) {
        loanProducts = loanProducts.filter(p => p.id !== id);
        persistData(LS_KEYS.loanProducts, loanProducts);
        renderLoanProductsTable();
        populateLoanProductDropdown();
    }
}

// ===================== LOAN REQUESTS (submitted publicly from the login page) =====================
const LOAN_REQUEST_STATUS = {
    pending:   { label: 'រង់ចាំ',       badgeClass: 'status-pending' },
    contacted: { label: 'បានទាក់ទង',   badgeClass: 'status-partial' },
    approved:  { label: 'អនុម័ត',       badgeClass: 'status-active' },
    rejected:  { label: 'បដិសេធ',      badgeClass: 'status-rejected' }
};

const LR_COLLATERAL_LABELS = { none: 'គ្មានវត្ថុបញ្ចាំ', property: 'ប័ណ្ណដី/ផ្ទះ', vehicle: 'ប័ណ្ណរថយន្ត/ម៉ូតូ', guarantor: 'អ្នកធានា', other: 'ផ្សេងៗ' };

function renderLoanRequestsTable() {
    const tbody = document.getElementById('loanRequestsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    [...loanRequests].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)).forEach(r => {
        const st = LOAN_REQUEST_STATUS[r.status] || LOAN_REQUEST_STATUS.pending;
        const canManage = hasPermission('canApproveLoan');
        // Older requests (submitted before this form was expanded) only ever had a single
        // free-text `address` line and no `village`/`commune`/`district`/`province` parts —
        // fall back to that so old rows still display correctly.
        const addressDisplay = [r.village, r.commune, r.district, r.province].filter(Boolean).join(', ') || r.address || '-';
        const nameDisplay = (r.onBehalf && r.requesterName ? `${esc(r.name)}<br><span style="font-size:11px; color:var(--text-color-subtle,#888);">ស្នើសុំដោយ: ${esc(r.requesterName)}</span>` : esc(r.name))
            + (r.nameLatin ? `<br><span style="font-size:11px; color:var(--text-color-subtle,#888);">${esc(r.nameLatin)}</span>` : '');
        const purposeDisplay = esc(r.purpose || '-')
            + (r.occupationType || r.monthlyIncomeUSD ? `<br><span style="font-size:11px; color:var(--text-color-subtle,#888);">${[r.occupationType, r.monthlyIncomeUSD ? 'ចំណូល $' + r.monthlyIncomeUSD + '/ខែ' : ''].filter(Boolean).map(esc).join(' · ')}</span>` : '');
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDMY(r.submittedAt)}</td>
            <td>${nameDisplay}</td>
            <td>${esc(r.phone)}</td>
            <td>${purposeDisplay}</td>
            <td>${r.termValueRaw ? `${r.termValueRaw} ${r.termUnit === 'month' ? 'ខែ' : 'ថ្ងៃ'}` : (r.termDays ? `${r.termDays} ថ្ងៃ` : '-')}</td>
            <td class="right">${r.amount ? fmtMoney(r.amount, r.currency || 'USD') : '-'}</td>
            <td>${r.collateral ? esc(LR_COLLATERAL_LABELS[r.collateral] || r.collateral) : '-'}</td>
            <td>${esc(addressDisplay)}</td>
            <td>
                ${canManage
                    ? `<select onchange="updateLoanRequestStatus('${esc(r.id)}', this.value)">
                        ${Object.entries(LOAN_REQUEST_STATUS).map(([val, cfg]) => `<option value="${val}" ${r.status === val ? 'selected' : ''}>${cfg.label}</option>`).join('')}
                       </select>`
                    : `<span class="status-badge ${st.badgeClass}">${st.label}</span>`
                }
            </td>
            <td class="actions">
                <button class="btn btn-sm btn-primary" onclick="viewLoanRequest('${esc(r.id)}')" title="មើលព័ត៌មានលម្អិត"><i class="fas fa-eye"></i></button>
                ${canManage && (r.status === 'pending' || r.status === 'contacted') ? `<button class="btn btn-sm btn-info" onclick="createLoanFromRequest('${esc(r.id)}')" title="បង្កើតកម្ចី"><i class="fas fa-file-invoice-dollar"></i></button>` : ''}
                <a href="tel:${esc(r.phone)}" class="btn btn-sm btn-success" title="ទូរស័ព្ទ"><i class="fas fa-phone"></i></a>
                ${canManage ? `<button class="btn btn-sm btn-danger" onclick="deleteLoanRequest('${esc(r.id)}')"><i class="fas fa-trash-alt"></i></button>` : ''}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function updateLoanRequestStatus(id, status) {
    if (!hasPermission('canApproveLoan')) { showToast('Permission Denied.', 'error'); return; }
    const request = loanRequests.find(r => r.id === id);
    if (request) {
        request.status = status;
        persistData(LS_KEYS.loanRequests, loanRequests);
        renderLoanRequestsTable();

        if (status === 'approved' || status === 'rejected') {
            const icon = status === 'approved' ? '✅' : '❌';
            const label = LOAN_REQUEST_STATUS[status] ? LOAN_REQUEST_STATUS[status].label : status;
            notifyTelegram(`${icon} <b>សំណើសុំកម្ចីត្រូវបាន${label}</b>\nឈ្មោះ: ${request.name}\nទូរស័ព្ទ: ${request.phone}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
        }
    }
}

// Bridges a public "loan request" (login-page submission) into the real loan-creation flow,
// instead of the officer having to re-type everything by hand on the Loans tab. Reuses an
// existing customer if one already shares this phone number; otherwise creates a customer
// record. Newer requests (submitted through the expanded wizard) carry separate
// village/commune/district/province fields, which get copied straight onto the new customer;
// older requests only had a single free-text `address` line, which is surfaced in the toast
// below instead so the officer can fill those parts in on the Customers tab if needed.
// Does NOT itself create the loan — the officer still sets interest rate, payment method, etc.
// and clicks "រក្សាទុក" on the pre-filled Loans form, same approval gate (pending/active based
// on canApproveLoan) as any other loan. The requested term (in days) is copied over too, but
// the officer should double check it against the product's actual unit (ខែ/ថ្ងៃ/...).
async function createLoanFromRequest(id) {
    if (!hasPermission('canApproveLoan')) { showToast('Permission Denied.', 'error'); return; }
    const request = loanRequests.find(r => r.id === id);
    if (!request) return;

    if (!await customConfirm(`តើអ្នកចង់ចាប់ផ្តើមបង្កើតកម្ចីសម្រាប់ "${request.name}" ដែរឬទេ? អ្នកនឹងត្រូវបំពេញលក្ខខណ្ឌកម្ចី (អត្រាការប្រាក់, រយៈពេល...) បន្ថែមទៀត។`)) return;

    const hasStructuredAddress = !!(request.village || request.commune || request.district || request.province);

    let customer = customers.find(c => c.phone && request.phone && c.phone === request.phone);
    if (!customer) {
        customer = {
            id: 'CUST-' + Date.now() + Math.random().toString(36).substr(2, 5),
            name: request.name,
            gender: request.gender || 'ប្រុស',
            phone: request.phone,
            village: request.village || '', commune: request.commune || '', district: request.district || '', province: request.province || '',
            residency: 'resident',
            isBlacklisted: false,
            createdAt: new Date().toISOString()
        };
        // Extra details the applicant filled in on apply.html — stored on the customer record
        // (customers are saved as JSON rows, so additional keys are kept). Only non-empty values.
        const extra = {
            nameLatin: request.nameLatin, dob: request.dob, maritalStatus: request.maritalStatus,
            idNumber: request.idNumber, phone2: request.phone2, social: request.social,
            occupationType: request.occupationType, employer: request.employer, jobTitle: request.jobTitle,
            tenure: request.tenure, monthlyIncomeUSD: request.monthlyIncomeUSD, workAddress: request.workAddress
        };
        Object.keys(extra).forEach(k => {
            const v = extra[k];
            if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && isNaN(v))) customer[k] = v;
        });
        customers.push(customer);
        persistData(LS_KEYS.customers, customers);
        populateCustomerDropdowns();
        notifyTelegram(`👤 <b>អតិថិជនត្រូវបានបង្កើតពីសំណើសុំកម្ចី</b>\nឈ្មោះ: ${customer.name}\nទូរស័ព្ទ: ${customer.phone || 'N/A'}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    }

    request.status = 'approved';
    persistData(LS_KEYS.loanRequests, loanRequests);
    renderLoanRequestsTable();
    notifyTelegram(`✅ <b>សំណើសុំកម្ចីត្រូវបានអនុម័ត</b>\nឈ្មោះ: ${request.name}\nទូរស័ព្ទ: ${request.phone}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);

    switchTab('loans');
    clearForm();
    clearScheduleAndSummary();
    document.getElementById('customerSelect').value = customer.id;
    displaySelectedCustomerInfo();
    if (request.amount) document.getElementById('loanAmount').value = request.amount;
    if (request.currency) document.getElementById('currency').value = request.currency;

    const extraBits = [
        request.collateral ? `ការធានា: ${LR_COLLATERAL_LABELS[request.collateral] || request.collateral}` : '',
        !hasStructuredAddress && request.address ? `អាសយដ្ឋាន: ${request.address}` : '',
        request.purpose ? `គោលបំណង/ចំណូល: ${request.purpose}` : ''
    ].filter(Boolean).join(' — ');
    showToast(
        extraBits
            ? `សូមបំពេញលក្ខខណ្ឌកម្ចី (អត្រាការប្រាក់, រយៈពេល...) រួច "រក្សាទុក"។ ពីសំណើ៖ ${extraBits}`
            : 'សូមបំពេញលក្ខខណ្ឌកម្ចី (អត្រាការប្រាក់, រយៈពេល...) រួច "រក្សាទុក"។',
        'info'
    );
}

// ===================== LOAN REQUEST — FULL DETAILS MODAL =====================
// Shows every field the customer filled in on apply.html, grouped, plus the 3 uploaded documents.
// Documents live in the PRIVATE storage bucket "loan-request-docs", so they are opened through
// short-lived signed URLs (needs a logged-in staff session with read access on that bucket).
const LR_DOCS_BUCKET = 'loan-request-docs';
const LR_ATT_LABELS = { 'id-card': 'អត្តសញ្ញាណប័ណ្ណ', 'work-proof': 'ភស្តុតាងការងារ', 'bank-statement': 'Statement ធនាគារ' };

function ensureLrDetailModal() {
    if (document.getElementById('loanRequestDetailModal')) return;
    const st = document.createElement('style');
    st.textContent = `
      #loanRequestDetailModal .modal-content { max-width: 820px; max-height: 92vh; overflow-y: auto; }
      .lr-group { margin: 0 0 14px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
      .lr-group > h5 { margin: 0; padding: 8px 12px; background: var(--thead); color: #fff; font-size: 14px; }
      .lr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
      .lr-item { padding: 8px 12px; border-bottom: 1px solid var(--border); }
      .lr-item small { display: block; color: var(--text-color-subtle, #888); font-size: 11px; }
      .lr-item span { font-weight: 600; word-break: break-word; }
      .lr-docs { padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 8px; }
    `;
    document.head.appendChild(st);
    const m = document.createElement('div');
    m.id = 'loanRequestDetailModal';
    m.className = 'modal';
    m.innerHTML = '<div class="modal-content"><div id="loanRequestDetailBody"></div><div class="modal-actions"><button type="button" class="btn btn-muted" onclick="closeLoanRequestDetail()"><i class="fas fa-times"></i> បិទ</button></div></div>';
    m.addEventListener('click', e => { if (e.target === m) closeLoanRequestDetail(); });
    document.body.appendChild(m);
}

function closeLoanRequestDetail() {
    const m = document.getElementById('loanRequestDetailModal');
    if (m) m.style.display = 'none';
}

function viewLoanRequest(id) {
    const r = loanRequests.find(x => x.id === id);
    if (!r) return;
    ensureLrDetailModal();

    const addr = a => a ? [a.house && ('ផ្ទះ ' + a.house), a.village && ('ភូមិ ' + a.village), a.commune && ('ឃុំ/សង្កាត់ ' + a.commune), a.district && ('ស្រុក/ខណ្ឌ ' + a.district), a.province].filter(Boolean).join(' · ') : '';
    const homeAddr = [r.village && ('ភូមិ ' + r.village), r.commune && ('ឃុំ/សង្កាត់ ' + r.commune), r.district && ('ស្រុក/ខណ្ឌ ' + r.district), r.province].filter(Boolean).join(' · ') || r.address || '';
    const term = r.termValueRaw ? `${r.termValueRaw} ${r.termUnit === 'month' ? 'ខែ' : 'ថ្ងៃ'}` : (r.termDays ? `${r.termDays} ថ្ងៃ` : '');
    const dob = r.dob ? String(r.dob).split('-').reverse().join('/') : '';
    const st = LOAN_REQUEST_STATUS[r.status] || LOAN_REQUEST_STATUS.pending;

    const group = (title, icon, rows) => {
        const items = rows.filter(([, v]) => v !== '' && v != null && v !== false)
            .map(([k, v]) => `<div class="lr-item"><small>${esc(k)}</small><span>${esc(String(v))}</span></div>`).join('');
        return `<div class="lr-group"><h5><i class="${icon}"></i> ${title}</h5><div class="lr-grid">${items || '<div class="lr-item"><small>-</small></div>'}</div></div>`;
    };

    const atts = Array.isArray(r.attachments) ? r.attachments : [];
    const docsHtml = atts.length
        ? atts.map((a, i) => `<button type="button" class="btn btn-sm btn-info" onclick="openLoanRequestAttachment('${esc(r.id)}', ${i})"><i class="fas fa-paperclip"></i> ${esc(LR_ATT_LABELS[a.field] || a.field)} <small>(${esc(a.fileName || '')})</small></button>`).join('')
        : '<span style="color:var(--text-color-subtle,#888);">គ្មានឯកសារភ្ជាប់</span>';

    document.getElementById('loanRequestDetailBody').innerHTML = `
        <h4><i class="fas fa-id-card"></i> ព័ត៌មានលម្អិតនៃសំណើ — ${esc(r.name || '')}</h4>
        ${group('ព័ត៌មានសំណើ', 'fas fa-file-alt', [
            ['លេខសំណើ', r.id], ['កាលបរិច្ឆេទដាក់ពាក្យ', r.submittedAt ? formatDateDMY(r.submittedAt) : ''], ['ស្ថានភាព', st.label],
            ['ផលិតផល', r.product], ['ចំនួនស្នើសុំ', r.amount ? fmtMoney(r.amount, r.currency || 'USD') : ''], ['រយៈពេល', term],
            ['គោលបំណង', r.purpose], ['សាខា', r.branch], ['ស្គាល់យើងតាម', r.heardFrom],
            ['ស្នើសុំដោយ (តំណាង)', r.onBehalf ? r.requesterName : ''], ['ការធានា', r.collateral ? (LR_COLLATERAL_LABELS[r.collateral] || r.collateral) : '']
        ])}
        ${group('ព័ត៌មានផ្ទាល់ខ្លួន', 'fas fa-user', [
            ['ឈ្មោះ (ខ្មែរ)', r.name], ['ឈ្មោះ (ឡាតាំង)', r.nameLatin], ['ថ្ងៃខែឆ្នាំកំណើត', dob],
            ['ភេទ', r.gender], ['ស្ថានភាពគ្រួសារ', r.maritalStatus], ['សញ្ជាតិ', r.nationality],
            ['លេខអត្តសញ្ញាណ', r.idNumber], ['លេខទូរស័ព្ទ (1)', r.phone], ['លេខទូរស័ព្ទ (2)', r.phone2],
            ['ហ្វេសប៊ុក/អ៊ីមែល', r.social], ['អាសយដ្ឋានផ្ទះ', homeAddr]
        ])}
        ${group('ព័ត៌មានការងារ/មុខរបរ', 'fas fa-briefcase', [
            ['ប្រភេទមុខរបរ', r.occupationType], ['កន្លែងការងារ/ក្រុមហ៊ុន', r.employer], ['តួនាទី', r.jobTitle],
            ['អាយុការងារ', r.tenure], ['ប្រាក់ចំណូលប្រចាំខែ', r.monthlyIncomeUSD ? '$' + r.monthlyIncomeUSD : ''],
            ['អាសយដ្ឋានកន្លែងការងារ', addr(r.workAddress)]
        ])}
        <div class="lr-group"><h5><i class="fas fa-paperclip"></i> ឯកសារភ្ជាប់</h5><div class="lr-docs">${docsHtml}</div></div>
        ${r.consent ? `<div style="font-size:12px; color:var(--text-color-subtle,#888);">ការយល់ព្រម: ${r.consent.infoTrue ? 'បញ្ជាក់ថាព័ត៌មានពិត' : ''}${r.consent.contactOk ? ' · អនុញ្ញាតឱ្យទាក់ទង' : ''}${r.consent.at ? ' · ' + esc(formatDateDMY(r.consent.at)) : ''}</div>` : ''}
    `;
    document.getElementById('loanRequestDetailModal').style.display = 'flex';
}

async function openLoanRequestAttachment(id, index) {
    const r = loanRequests.find(x => x.id === id);
    const att = r && Array.isArray(r.attachments) ? r.attachments[index] : null;
    if (!att || !att.path) { showToast('រកមិនឃើញឯកសារ', 'error'); return; }
    // Open the tab synchronously (popup blockers), then point it at the signed URL.
    const win = window.open('', '_blank');
    try {
        const { url, headers } = await dbContext();   // same auth context db.js uses for other signed URLs
        const encPath = att.path.split('/').map(encodeURIComponent).join('/');
        const res = await fetch(`${url}/storage/v1/object/sign/${LR_DOCS_BUCKET}/${encPath}`, {
            method: 'POST', headers, body: JSON.stringify({ expiresIn: 300 })
        });
        if (!res.ok) throw new Error('Could not sign file URL: HTTP ' + res.status);
        const body = await res.json();
        const signed = `${url}/storage/v1${body.signedURL}`;
        if (win) win.location.href = signed; else window.location.href = signed;
    } catch (e) {
        if (win) win.close();
        console.error('attachment error:', e);
        showToast('បើកឯកសារមិនបាន (ពិនិត្យសិទ្ធិអានលើ bucket loan-request-docs)', 'error');
    }
}

async function deleteLoanRequest(id) {
    if (!hasPermission('canApproveLoan')) { showToast('Permission Denied.', 'error'); return; }
    if (await customConfirm('Are you sure you want to delete this loan request?')) {
        loanRequests = loanRequests.filter(r => r.id !== id);
        persistData(LS_KEYS.loanRequests, loanRequests);
        renderLoanRequestsTable();
    }
}

// ===================== EXPENSES FUNCTIONS =====================
function saveExpense(e) {
    e.preventDefault();
    const expenseId = document.getElementById('expenseId').value;
    const expenseData = {
        id: expenseId || 'EXP-' + Date.now(),
        date: document.getElementById('expenseDate').value,
        category: document.getElementById('expenseCategory').value,
        description: document.getElementById('expenseDescription').value.trim(),
        amount: parseFloat(document.getElementById('expenseAmount').value),
        currency: document.getElementById('expenseCurrency').value,
        user: currentUser.username
    };

    if (!expenseData.date || !expenseData.category || !expenseData.amount) {
        showToast('Please fill in date, category, and amount.', 'error');
        return;
    }

    if (expenseId) {
        const index = expenses.findIndex(ex => ex.id === expenseId);
        if (index > -1) expenses[index] = expenseData;
    } else {
        expenses.push(expenseData);
    }
    
    persistData(LS_KEYS.expenses, expenses);
    logChange(null, 'Expense Action', { action: expenseId ? 'Update' : 'Create', expenseId: expenseData.id });
    renderExpensesTable();
    clearExpenseForm();
}

function renderExpensesTable() {
    const tbody = document.getElementById('expensesTableBody');
    const totalEl = document.getElementById('totalExpenses');
    tbody.innerHTML = '';
    let totalUSD = 0;

    expenses.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(ex => {
        const tr = document.createElement('tr');
        const amountInUSD = convertCurrency(ex.amount, ex.currency, 'USD');
        totalUSD += amountInUSD;
        tr.innerHTML = `
            <td>${formatDateDMY(ex.date)}</td>
            <td>${esc(ex.category)}</td>
            <td>${esc(ex.description)}</td>
            <td class="right">${fmtMoney(ex.amount, ex.currency)}</td>
            <td>${esc(getOfficerFullName(ex.user))}</td>
            <td class="actions">
                <button class="btn btn-sm btn-info" onclick="editExpense('${esc(ex.id)}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-danger" onclick="deleteExpense('${esc(ex.id)}')"><i class="fas fa-trash-alt"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    totalEl.textContent = fmtMoney(totalUSD, 'USD');
}

function editExpense(id) {
    const expense = expenses.find(ex => ex.id === id);
    if (expense) {
        document.getElementById('expenseId').value = expense.id;
        document.getElementById('expenseDate').value = expense.date;
        document.getElementById('expenseCategory').value = expense.category;
        document.getElementById('expenseDescription').value = expense.description;
        document.getElementById('expenseAmount').value = expense.amount;
        document.getElementById('expenseCurrency').value = expense.currency;
        document.getElementById('expenseFormTitle').innerHTML = '<i class="fas fa-edit"></i> កែប្រែចំណាយ';
    }
}

async function deleteExpense(id) {
    if (await customConfirm('Are you sure you want to delete this expense?')) {
        expenses = expenses.filter(ex => ex.id !== id);
        persistData(LS_KEYS.expenses, expenses);
        logChange(null, 'Expense Action', { action: 'Delete', expenseId: id });
        renderExpensesTable();
    }
}

function clearExpenseForm() {
    document.getElementById('expenseForm').reset();
    document.getElementById('expenseId').value = '';
    document.getElementById('expenseFormTitle').innerHTML = '<i class="fas fa-plus-circle"></i> បន្ថែមចំណាយថ្មី';
}

// ===================== ADMIN SETTINGS FUNCTIONS =====================
function renderExpenseCategories() {
    const container = document.getElementById('expenseCategoryList');
    container.innerHTML = '';
    appSettings.expenseCategories.forEach(cat => {
        container.innerHTML += `<div class="attachment-item">${esc(cat)} <button class="btn btn-danger btn-sm" onclick="deleteExpenseCategory('${escJsAttr(cat)}')"><i class="fas fa-trash-alt"></i></button></div>`;
    });
}

function saveExpenseCategory(e) {
    e.preventDefault();
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const newCat = document.getElementById('expenseCategoryName').value.trim();
    if (newCat && !appSettings.expenseCategories.includes(newCat)) {
        appSettings.expenseCategories.push(newCat);
        persistData(LS_KEYS.appSettings, appSettings);
        renderExpenseCategories();
        populateExpenseCategoryDropdown();
        document.getElementById('expenseCategoryName').value = '';
    }
}

async function deleteExpenseCategory(categoryName) {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    if (await customConfirm(`Are you sure you want to delete category "${categoryName}"?`)) {
        appSettings.expenseCategories = appSettings.expenseCategories.filter(c => c !== categoryName);
        persistData(LS_KEYS.appSettings, appSettings);
        renderExpenseCategories();
        populateExpenseCategoryDropdown();
    }
}

function renderMessageTemplates() {
    const container = document.getElementById('messageTemplateList');
    container.innerHTML = '';
    appSettings.messageTemplates.forEach(tpl => {
        container.innerHTML += `<div class="attachment-item"><strong>${esc(tpl.name)}</strong> <div><button class="btn btn-sm btn-info" onclick="editMessageTemplate('${esc(tpl.id)}')"><i class="fas fa-edit"></i></button> <button class="btn btn-sm btn-danger" onclick="deleteMessageTemplate('${esc(tpl.id)}')"><i class="fas fa-trash-alt"></i></button></div></div>`;
    });
}

function saveMessageTemplate(e) {
    e.preventDefault();
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    const id = document.getElementById('templateId').value;
    const name = document.getElementById('templateName').value.trim();
    const content = document.getElementById('templateContent').value.trim();

    if (!name || !content) {
        showToast('Please provide a name and content for the template.', 'error');
        return;
    }

    if (id) {
        const index = appSettings.messageTemplates.findIndex(t => t.id === id);
        if (index > -1) {
            appSettings.messageTemplates[index] = { id, name, content };
        }
    } else {
        appSettings.messageTemplates.push({ id: 'tpl-' + Date.now(), name, content });
    }

    persistData(LS_KEYS.appSettings, appSettings);
    renderMessageTemplates();
    clearTemplateForm();
}

function editMessageTemplate(id) {
    const tpl = appSettings.messageTemplates.find(t => t.id === id);
    if (tpl) {
        document.getElementById('templateId').value = tpl.id;
        document.getElementById('templateName').value = tpl.name;
        document.getElementById('templateContent').value = tpl.content;
    }
}

async function deleteMessageTemplate(id) {
    if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
    if(await customConfirm('Are you sure you want to delete this message template?')) {
        appSettings.messageTemplates = appSettings.messageTemplates.filter(t => t.id !== id);
        persistData(LS_KEYS.appSettings, appSettings);
        renderMessageTemplates();
    }
}

function clearTemplateForm() {
    document.getElementById('messageTemplateForm').reset();
    document.getElementById('templateId').value = '';
}

function generateMessage() {
    if (!currentLoan) return;

    const templateId = document.getElementById('messageTemplateSelect').value;
    const template = appSettings.messageTemplates.find(t => t.id === templateId);
    if (!template) {
        document.getElementById('generatedMessage').value = '';
        return;
    }

    const customer = getCustomer(currentLoan.customerId);
    const schedule = buildSchedule(currentLoan);
    const nextUnpaid = schedule.find(inst => inst.status !== 'paid');

    let message = template.content;
    message = message.replace(/\[CustomerName\]/g, customer.name);
    message = message.replace(/\[LoanID\]/g, currentLoan.loanId);
    if (nextUnpaid) {
        message = message.replace(/\[DueDate\]/g, formatDateDMY(nextUnpaid.date));
        message = message.replace(/\[RemainingAmount\]/g, fmtMoney(nextUnpaid.remainingAmount, currentLoan.currency));
        message = message.replace(/\[InstallmentNumber\]/g, nextUnpaid.index);
    }

    document.getElementById('generatedMessage').value = message;
}

function openMessageModal() {
    const select = document.getElementById('messageTemplateSelect');
    select.innerHTML = '<option value="">-- Select Template --</option>';
    appSettings.messageTemplates.forEach(tpl => {
        select.innerHTML += `<option value="${esc(tpl.id)}">${esc(tpl.name)}</option>`;
    });
    document.getElementById('generatedMessage').value = '';
    document.getElementById('messageModal').style.display = 'flex';
}

function closeMessageModal() {
    document.getElementById('messageModal').style.display = 'none';
}

function copyMessage() {
    const message = document.getElementById('generatedMessage').value;
    navigator.clipboard.writeText(message).then(() => {
        showToast('Message copied to clipboard!', 'success');
    }, () => {
        showToast('Failed to copy message.', 'error');
    });
}

