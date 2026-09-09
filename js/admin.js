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

function renderLoanRequestsTable() {
    const tbody = document.getElementById('loanRequestsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    [...loanRequests].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)).forEach(r => {
        const st = LOAN_REQUEST_STATUS[r.status] || LOAN_REQUEST_STATUS.pending;
        const canManage = hasPermission('canApproveLoan');
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDMY(r.submittedAt)}</td>
            <td>${esc(r.name)}</td>
            <td>${esc(r.phone)}</td>
            <td class="right">${r.amount ? fmtMoney(r.amount, r.currency || 'USD') : '-'}</td>
            <td>${esc(r.address || '-')}</td>
            <td>${esc(r.purpose || '-')}</td>
            <td>
                ${canManage
                    ? `<select onchange="updateLoanRequestStatus('${esc(r.id)}', this.value)">
                        ${Object.entries(LOAN_REQUEST_STATUS).map(([val, cfg]) => `<option value="${val}" ${r.status === val ? 'selected' : ''}>${cfg.label}</option>`).join('')}
                       </select>`
                    : `<span class="status-badge ${st.badgeClass}">${st.label}</span>`
                }
            </td>
            <td class="actions">
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

// Bridges a public "loan request" (login-page submission — free-text name/phone/amount/address/
// purpose, no structured customer record yet) into the real loan-creation flow, instead of the
// officer having to re-type everything by hand on the Loans tab. Reuses an existing customer if
// one already shares this phone number; otherwise creates a bare customer record (name + phone
// only — the request's address is a single free-text line, so it can't be reliably split into
// the customer profile's separate village/commune/district/province fields, and is surfaced in
// the toast below instead so the officer can fill those in on the Customers tab if needed).
// Does NOT itself create the loan — the officer still sets interest rate, term, payment method,
// etc. and clicks "រក្សាទុក" on the pre-filled Loans form, same approval gate (pending/active
// based on canApproveLoan) as any other loan.
async function createLoanFromRequest(id) {
    if (!hasPermission('canApproveLoan')) { showToast('Permission Denied.', 'error'); return; }
    const request = loanRequests.find(r => r.id === id);
    if (!request) return;

    if (!await customConfirm(`តើអ្នកចង់ចាប់ផ្តើមបង្កើតកម្ចីសម្រាប់ "${request.name}" ដែរឬទេ? អ្នកនឹងត្រូវបំពេញលក្ខខណ្ឌកម្ចី (អត្រាការប្រាក់, រយៈពេល...) បន្ថែមទៀត។`)) return;

    let customer = customers.find(c => c.phone && request.phone && c.phone === request.phone);
    if (!customer) {
        customer = {
            id: 'CUST-' + Date.now() + Math.random().toString(36).substr(2, 5),
            name: request.name,
            gender: 'ប្រុស',
            phone: request.phone,
            village: '', commune: '', district: '', province: '',
            residency: 'resident',
            isBlacklisted: false,
            createdAt: new Date().toISOString()
        };
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

    const extraInfo = [request.address, request.purpose].filter(Boolean).join(' — ');
    showToast(
        extraInfo
            ? `សូមបំពេញលក្ខខណ្ឌកម្ចី រួច "រក្សាទុក"។ ពីសំណើ៖ ${extraInfo}`
            : 'សូមបំពេញលក្ខខណ្ឌកម្ចី (អត្រាការប្រាក់, រយៈពេល...) រួច "រក្សាទុក"។',
        'info'
    );
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

