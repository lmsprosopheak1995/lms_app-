// =====================================================================
// customers.js — Customer (CRM) CRUD, dropdown population, customer profile tab (avatar, ID card, documents, printing).
// =====================================================================

// ===================== CUSTOMER (CRM) FUNCTIONS =====================
function clearCustomerForm() {
    document.getElementById('customerForm').reset();
    document.getElementById('customerId').value = '';
    document.getElementById('customerFormTitle').innerHTML = '<i class="fas fa-user-plus"></i> បន្ថែមអតិថិជនថ្មី';
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

function saveCustomer(e) {
    if (e) e.preventDefault();
    const customerId = document.getElementById('customerId').value;

    if (customerId && currentUser.role !== 'admin' && currentUser.role !== 'manager') {
        showToast('Permission Denied: You cannot update an existing customer.', 'error');
        return;
    }

    const isNewCustomer = !customerId;

    const customerData = {
        id: customerId || 'CUST-' + Date.now(),
        name: document.getElementById('custName').value.trim(),
        gender: document.getElementById('custGender').value,
        phone: document.getElementById('custPhone').value.trim(),
        village: document.getElementById('custVillage').value.trim(),
        commune: document.getElementById('custCommune').value.trim(),
        district: document.getElementById('custDistrict').value.trim(),
        province: document.getElementById('custProvince').value.trim(),
        residency: document.getElementById('custResidency').value,
        isBlacklisted: document.getElementById('custBlacklisted').checked,
    };

    if (isNewCustomer) {
        customerData.createdAt = new Date().toISOString();
    }


    if (!customerData.name) {
        showToast('សូមបញ្ចូលឈ្មោះអតិថិជន', 'error');
        return;
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
        document.getElementById('custVillage').value = customer.village;
        document.getElementById('custCommune').value = customer.commune;
        document.getElementById('custDistrict').value = customer.district;
        document.getElementById('custProvince').value = customer.province;
        document.getElementById('custResidency').value = customer.residency || 'resident';
        document.getElementById('custBlacklisted').checked = customer.isBlacklisted || false;
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

function renderCustomersListTable() {
    const tbody = document.getElementById('customersListTableBody');
    tbody.innerHTML = '';
    const canEdit = currentUser.role === 'admin' || currentUser.role === 'manager';
    const fragment = document.createDocumentFragment();
    customers.sort((a, b) => a.name.localeCompare(b.name)).forEach((cust, index) => {
        const tr = document.createElement('tr');
        const statusText = cust.isBlacklisted ? 'បញ្ជីខ្មៅ' : 'ធម្មតា';
        const statusClass = cust.isBlacklisted ? 'status-unpaid' : 'status-paid';
        
        const actionButtons = canEdit ? `
            <td class="actions">
                <button class="btn btn-info btn-sm" onclick="showCustomerForm('${esc(cust.id)}')"><i class="fas fa-edit"></i> កែប្រែ</button>
                <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${esc(cust.id)}')"><i class="fas fa-trash-alt"></i> លុប</button>
            </td>` : '<td>No Actions</td>';
            
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>${esc(cust.name)}</td>
            <td>${esc(cust.gender)}</td>
            <td>${esc(cust.phone)}</td>
            <td>${esc(cust.province)}</td>
            <td class="status-cell"><span class="status-badge ${statusClass}">${statusText}</span></td>
            ${actionButtons}
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
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
            showToast('ការព្រមាន៖ អតិថិជននេះស្ថិតនៅក្នុងបញ្ជីខ្មៅ។', 'error');
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
    const statusText = customer.isBlacklisted ? 'Blacklisted' : 'Active';
    const statusClass = customer.isBlacklisted ? 'unpaid' : 'paid';
    document.getElementById('profileDetailStatus').innerHTML = `<span class="status-badge status-${statusClass}">${statusText}</span>`;

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
                    <button class="btn btn-info btn-sm" onclick="viewCustomerDocument('${esc(file.storage_path)}')"><i class="fas fa-eye"></i></button>
                    <button class="btn btn-danger btn-sm" style="margin-left:4px;" onclick="deleteCustomerDocument('${esc(file.id)}', '${esc(file.storage_path)}', '${esc(customerId)}')"><i class="fas fa-trash-alt"></i></button>
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


