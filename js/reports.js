// =====================================================================
// reports.js — Dashboard, analysis charts, officer performance, PAR report, customer/financial/annual reports, P&L, map.
// =====================================================================

// ===================== P&L Report =====================
function generatePlReport() {
    const startDate = document.getElementById('plStartDate').value;
    const endDate = document.getElementById('plEndDate').value;
    if (!startDate || !endDate) {
        showToast('Please select a start and end date.', 'error');
        return;
    }

    const start = parseDate(startDate);
    const end = parseDate(endDate);

    let income = { interest: 0, late: 0, penalty: 0, service: 0 };
    let totalExpenses = 0;

    // Calculate Income from all payments within the date range
    for (const key in payments) {
        payments[key].forEach(p => {
            const paymentDate = parseDate(p.date);
            if (paymentDate >= start && paymentDate <= end) {
                const [loanId, installmentIndex] = key.split('-');
                const loan = loans.find(l => l.loanId === loanId);
                const inst = buildSchedule(loan).find(i => i.index == installmentIndex);

                if (loan && inst) {
                    let remainingPayment = p.amount;
                    const allocate = (amountDue) => {
                        const paid = Math.min(remainingPayment, amountDue);
                        remainingPayment -= paid;
                        return convertCurrency(paid, loan.currency, 'USD');
                    };
                    
                    income.penalty += allocate(inst.penalty);
                    income.late += allocate(inst.lateInterest);
                    income.service += allocate(inst.serviceFee + inst.adminFee + inst.insuranceFee);
                    income.interest += allocate(inst.interest);
                }
            }
        });
    }

    // Calculate Expenses
    expenses.forEach(ex => {
        const expenseDate = parseDate(ex.date);
        if (expenseDate >= start && expenseDate <= end) {
            totalExpenses += convertCurrency(ex.amount, ex.currency, 'USD');
        }
    });

    const totalIncome = income.interest + income.late + income.penalty + income.service;
    const netResult = totalIncome - totalExpenses;

    document.getElementById('plIncomeInterest').textContent = fmtMoney(income.interest, 'USD');
    document.getElementById('plIncomeLate').textContent = fmtMoney(income.late, 'USD');
    document.getElementById('plIncomePenalty').textContent = fmtMoney(income.penalty, 'USD');
    document.getElementById('plIncomeService').textContent = fmtMoney(income.service, 'USD');
    document.getElementById('plTotalIncome').textContent = fmtMoney(totalIncome, 'USD');
    document.getElementById('plTotalExpenses').textContent = fmtMoney(totalExpenses, 'USD');
    
    const resultEl = document.getElementById('plNetResult');
    resultEl.textContent = fmtMoney(netResult, 'USD');
    resultEl.style.color = netResult >= 0 ? 'var(--success)' : 'var(--danger)';

    document.getElementById('plReportResult').style.display = 'block';
}

// ===================== MAP FUNCTIONS =====================
function initMap() {
    if (mapInstance) {
        setTimeout(() => mapInstance.invalidateSize(), 10);
        return;
    }
    mapInstance = L.map('map').setView([11.5564, 104.9282], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(mapInstance);

    const loansWithCoords = loans.filter(l => l.latitude && l.longitude && !isNaN(parseFloat(l.latitude)) && !isNaN(parseFloat(l.longitude)));
    if (loansWithCoords.length === 0) return;

    const markers = L.markerClusterGroup();
    loansWithCoords.forEach(loan => {
        const customer = getCustomer(loan.customerId);
        const lat = parseFloat(loan.latitude);
        const lon = parseFloat(loan.longitude);
        const marker = L.marker([lat, lon]);
        const popupContent = `<b>Loan ID:</b> ${loan.loanId}<br><b>Customer:</b> ${customer.name}<br><b>Amount:</b> ${fmtMoney(loan.loanAmount, loan.currency)}<br><a href="#" onclick="viewLoanFromMap('${loan.loanId}')" style="margin-top:5px;display:inline-block;">View Details</a>`;
        marker.bindPopup(popupContent);
        markers.addLayer(marker);
    });
    mapInstance.addLayer(markers);
}

function viewLoanFromMap(loanId) {
    switchTab('loans');
    loadLoan(loanId);
}

// ===================== DASHBOARD, ANALYSIS & REPORTS =====================

function getDateRange(filterValue) {
    const now = new Date();
    let start = new Date(now.getFullYear(), now.getMonth(), 1);
    let end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    switch (filterValue) {
        case 'this_month':
            break;
        case 'last_month':
            start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            end = new Date(now.getFullYear(), now.getMonth(), 0);
            break;
        case 'this_quarter':
            const quarter = Math.floor(now.getMonth() / 3);
            start = new Date(now.getFullYear(), quarter * 3, 1);
            end = new Date(now.getFullYear(), quarter * 3 + 3, 0);
            break;
        case 'this_year':
            start = new Date(now.getFullYear(), 0, 1);
            end = new Date(now.getFullYear(), 11, 31);
            break;
        default: // 'all'
            return { start: null, end: null };
    }
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}


function renderDashboard() {
    // === Main Metrics (Active Loans) ===
    const activeLoans = loans.filter(l => ['active', 'overdue'].includes(getLoanComputedStatus(l).key));
    let totalActiveAmountUSD = 0;
    let totalExpectedInterestUSD = 0;
    let totalLateInterestUSD = 0;

    activeLoans.forEach(loan => {
        totalActiveAmountUSD += convertCurrency(loan.loanAmount, loan.currency, 'USD');
        const schedule = buildSchedule(loan);
        schedule.forEach(inst => {
            totalExpectedInterestUSD += convertCurrency(inst.interest, loan.currency, 'USD');
            totalLateInterestUSD += convertCurrency(inst.lateInterest, loan.currency, 'USD');
        });
    });

    document.getElementById('totalLoans').textContent = activeLoans.length;
    document.getElementById('totalLoanAmount').textContent = fmtMoney(totalActiveAmountUSD, 'USD');
    document.getElementById('totalExpectedInterest').textContent = fmtMoney(totalExpectedInterestUSD, 'USD');
    document.getElementById('totalLateInterest').textContent = fmtMoney(totalLateInterestUSD, 'USD');

    // === Date-Filtered Metrics ===
    const range = getDateRange(document.getElementById('dashboardDateRange').value);
    let newLoansCount = 0;
    let disbursedAmountUSD = 0;
    let collectedAmountUSD = 0;

    const dateFilteredLoans = range.start ? loans.filter(l => parseDate(l.loanDate) >= range.start && parseDate(l.loanDate) <= range.end) : loans;
    // Exclude loans that never actually had money disbursed (still awaiting approval, or denied).
    const filteredLoans = dateFilteredLoans.filter(l => l.status !== 'pending' && l.status !== 'rejected');
    newLoansCount = filteredLoans.length;
    disbursedAmountUSD = filteredLoans.reduce((sum, l) => sum + convertCurrency(l.loanAmount, l.currency, 'USD'), 0);

    for (const key in payments) {
        payments[key].forEach(p => {
            const paymentDate = parseDate(p.date);
            if (!range.start || (paymentDate >= range.start && paymentDate <= range.end)) {
                const loan = loans.find(l => l.loanId === key.split('-')[0]);
                if (loan) {
                    collectedAmountUSD += convertCurrency(p.amount, loan.currency, 'USD');
                }
            }
        });
    }

    document.getElementById('db_new_loans').textContent = newLoansCount;
    document.getElementById('db_disbursed').textContent = fmtMoney(disbursedAmountUSD, 'USD');
    document.getElementById('db_collected').textContent = fmtMoney(collectedAmountUSD, 'USD');

    // === Savings Statistics ===
    let savingsActiveCount = 0;
    let savingsCompletedCount = 0;
    let savingsTotalSavedUSD = 0;
    let savingsTotalInterestUSD = 0;

    savingsAccounts.forEach(account => {
        const statusKey = getSavingsComputedStatus(account).key;
        if (statusKey === 'active') savingsActiveCount++;
        if (statusKey === 'completed') savingsCompletedCount++;
        if (statusKey !== 'written_off') {
            savingsTotalSavedUSD += convertCurrency(getSavingsSavedAmount(account), account.currency, 'USD');
            const schedule = buildSavingsSchedule(account);
            const accountInterest = schedule.reduce((sum, s) => sum + s.netInterest, 0);
            savingsTotalInterestUSD += convertCurrency(accountInterest, account.currency, 'USD');
        }
    });

    document.getElementById('db_savings_active_count').textContent = savingsActiveCount;
    document.getElementById('db_savings_completed_count').textContent = savingsCompletedCount;
    document.getElementById('db_savings_total_saved').textContent = fmtMoney(savingsTotalSavedUSD, 'USD');
    document.getElementById('db_savings_total_interest').textContent = fmtMoney(savingsTotalInterestUSD, 'USD');

    // === Late Loans Table ===
    const lateLoans = loans.filter(l => getLoanComputedStatus(l).key === 'overdue').slice(0, 10);
    const lateLoansBody = document.getElementById('lateLoansTableBody');
    lateLoansBody.innerHTML = '';
    lateLoans.forEach((loan, index) => {
        const schedule = buildSchedule(loan);
        const lateInstallments = schedule.filter(i => i.status === 'overdue');
        const lateInterest = lateInstallments.reduce((sum, i) => sum + i.lateInterest, 0);
        const customer = getCustomer(loan.customerId);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>${esc(loan.loanId)}</td>
            <td>${esc(customer.name)}</td>
            <td>${lateInstallments.length}</td>
            <td class="right">${fmtMoney(lateInterest, loan.currency)}</td>
            <td>${formatDateDMY(loan.loanDate)}</td>
        `;
        lateLoansBody.appendChild(tr);
    });

    // === Ending Loans Table ===
    const endingLoansBody = document.getElementById('endingLoansTableBody');
    endingLoansBody.innerHTML = '';
    const thirtyDaysFromNow = addDays(new Date(), 30);
    const today = new Date();
    activeLoans.forEach((loan) => {
        const schedule = buildSchedule(loan);
        if (schedule.length > 0) {
            const lastDate = parseDate(schedule[schedule.length - 1].date);
            if (lastDate <= thirtyDaysFromNow && lastDate >= today) {
                const remainingPrincipal = schedule.reduce((sum, i) => (i.status !== 'paid') ? sum + i.principal : sum, 0);
                const daysRemaining = Math.ceil((lastDate - today) / (1000 * 60 * 60 * 24));
                const customer = getCustomer(loan.customerId);
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${endingLoansBody.children.length + 1}</td>
                    <td>${esc(loan.loanId)}</td>
                    <td>${esc(customer.name)}</td>
                    <td class="right">${fmtMoney(remainingPrincipal, loan.currency)}</td>
                    <td>${formatDateDMY(lastDate)}</td>
                    <td>${daysRemaining}</td>
                `;
                endingLoansBody.appendChild(tr);
            }
        }
    });
}

function renderAnalysisCharts() {
    Object.values(charts).forEach(chart => chart.destroy());

    const activeLoans = loans.filter(l => ['active', 'overdue'].includes(getLoanComputedStatus(l).key));
    
    // --- Average Metrics ---
    const totalAmount = activeLoans.reduce((sum, l) => sum + convertCurrency(l.loanAmount, l.currency, 'USD'), 0);
    const percentRateLoans = activeLoans.filter(l => l.interestRateType !== 'fixed');
    const totalInterestRate = percentRateLoans.reduce((sum, l) => sum + Number(l.interestRate), 0);
    const totalTerm = activeLoans.reduce((sum, l) => sum + Number(l.loanTerm), 0);
    document.getElementById('avgLoanAmount').textContent = fmtMoney(activeLoans.length > 0 ? totalAmount / activeLoans.length : 0, 'USD');
    document.getElementById('avgInterestRate').textContent = (percentRateLoans.length > 0 ? totalInterestRate / percentRateLoans.length : 0).toFixed(2) + '%';
    document.getElementById('avgLoanTerm').textContent = (activeLoans.length > 0 ? totalTerm / activeLoans.length : 0).toFixed(1) + ' ខែ';
    
    // --- Loan Status Chart ---
    const statusCounts = loans.reduce((acc, loan) => {
        const status = getLoanComputedStatus(loan).key;
        acc[status] = (acc[status] || 0) + 1;
        return acc;
    }, {});
    charts.loanStatusChart = new Chart(document.getElementById('loanStatusChart'), {
        type: 'doughnut',
        data: {
            labels: Object.keys(statusCounts),
            datasets: [{ data: Object.values(statusCounts), backgroundColor: ['#28a745', '#ffc107', '#007bff', '#dc3545', '#6c757d', '#17a2b8', '#343a40'] }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });

    // --- Loans by Province Chart ---
    const provinceData = activeLoans.reduce((acc, loan) => {
        const customer = getCustomer(loan.customerId);
        const province = customer.province || 'Unknown';
        acc[province] = (acc[province] || 0) + convertCurrency(loan.loanAmount, loan.currency, 'USD');
        return acc;
    }, {});
    charts.loansByProvinceChart = new Chart(document.getElementById('loansByProvinceChart'), {
        type: 'bar',
        data: {
            labels: Object.keys(provinceData),
            datasets: [{ label: 'Total Loan Amount (USD)', data: Object.values(provinceData), backgroundColor: '#17a2b8' }]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });

    // --- Monthly Trends Chart ---
    const monthlyData = Array(12).fill(0);
    const now = new Date();
    loans.forEach(loan => {
        const loanDate = parseDate(loan.loanDate);
        const monthsAgo = (now.getFullYear() - loanDate.getFullYear()) * 12 + (now.getMonth() - loanDate.getMonth());
        if (monthsAgo >= 0 && monthsAgo < 12) {
            monthlyData[11 - monthsAgo] += convertCurrency(loan.loanAmount, loan.currency, 'USD');
        }
    });
    const monthLabels = Array.from({length: 12}, (_, i) => {
        const d = new Date();
        d.setMonth(now.getMonth() - (11 - i));
        return d.toLocaleString('default', { month: 'short' });
    });
    charts.monthlyTrendsChart = new Chart(document.getElementById('monthlyTrendsChart'), {
        type: 'line',
        data: {
            labels: monthLabels,
            datasets: [{ label: 'Disbursed Amount (USD)', data: monthlyData, borderColor: '#6f42c1', tension: 0.1 }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
    
    // --- Officer Performance Table ---
    renderOfficerPerformance();
    // --- PAR Report ---
    renderParReport();
    
    // Push current theme colors onto the freshly-created charts.
    // (Previously called initTheme() here, which re-attached a 'change' listener
    // on darkModeToggle every time this tab rendered, so toggling dark mode later
    // would fire toggleTheme() multiple times per click.)
    const currentTheme = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
    updateChartTheme(currentTheme);
}

function renderOfficerPerformance() {
    const tbody = document.getElementById('officerPerformanceBody');
    const tfoot = document.getElementById('officerPerformanceFoot');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';

    const users = getUsers().filter(u => u.role === 'officer' || u.role === 'manager' || u.role === 'admin');
    let grandTotalLoans = 0;
    let grandTotalAmount = 0;
    let grandTotalOverdue = 0;

    users.forEach(user => {
        const officerLoans = loans.filter(l => l.creditOfficer === user.username && ['active', 'overdue'].includes(getLoanComputedStatus(l).key));
        if (officerLoans.length === 0) return;

        const totalLoans = officerLoans.length;
        const totalAmount = officerLoans.reduce((sum, l) => sum + convertCurrency(l.loanAmount, l.currency, 'USD'), 0);
        const overdueLoans = officerLoans.filter(l => getLoanComputedStatus(l).key === 'overdue').length;
        const overdueRate = totalLoans > 0 ? (overdueLoans / totalLoans * 100).toFixed(2) : 0;

        grandTotalLoans += totalLoans;
        grandTotalAmount += totalAmount;
        grandTotalOverdue += overdueLoans;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${esc(user.fullName)}</td>
            <td class="right">${totalLoans}</td>
            <td class="right">${fmtMoney(totalAmount, 'USD')}</td>
            <td class="right">${overdueRate}%</td>
        `;
        tbody.appendChild(tr);
    });

    const grandOverdueRate = grandTotalLoans > 0 ? (grandTotalOverdue / grandTotalLoans * 100).toFixed(2) : 0;
    tfoot.innerHTML = `
        <tr class="summary-row">
            <td><i class="fas fa-calculator"></i> Total</td>
            <td class="right">${grandTotalLoans}</td>
            <td class="right">${fmtMoney(grandTotalAmount, 'USD')}</td>
            <td class="right">${grandOverdueRate}%</td>
        </tr>
    `;
}

function renderParReport() {
    const container = document.getElementById('par-content');
    container.innerHTML = '';

    const today = new Date();
    let totalPortfolio = 0;
    const par = { '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };

    loans.filter(l => ['active', 'overdue'].includes(getLoanComputedStatus(l).key)).forEach(loan => {
        const schedule = buildSchedule(loan);
        let loanPrincipalRemaining = 0;
        let maxDaysLate = 0;

        schedule.forEach(inst => {
            if (inst.status !== 'paid') {
                const paidTowardsPrincipal = Math.max(0, inst.paidAmount - (inst.interest + inst.lateInterest + inst.penalty + inst.serviceFee + inst.adminFee + inst.insuranceFee));
                loanPrincipalRemaining += (inst.principal - paidTowardsPrincipal);
            }
            if (inst.daysLate > maxDaysLate) {
                maxDaysLate = inst.daysLate;
            }
        });

        const principalRemainingUSD = convertCurrency(loanPrincipalRemaining, loan.currency, 'USD');
        totalPortfolio += principalRemainingUSD;
        
        if (maxDaysLate > 0) {
            if (maxDaysLate <= 30) par['1-30'] += principalRemainingUSD;
            else if (maxDaysLate <= 60) par['31-60'] += principalRemainingUSD;
            else if (maxDaysLate <= 90) par['61-90'] += principalRemainingUSD;
            else par['90+'] += principalRemainingUSD;
        }
    });
    
    let parHtml = `<div class="par-item"><strong><i class="fas fa-wallet"></i> Total Active Portfolio:</strong> <span>${fmtMoney(totalPortfolio, 'USD')}</span></div>`;
    for (const range in par) {
        const amount = par[range];
        const percentage = totalPortfolio > 0 ? (amount / totalPortfolio * 100).toFixed(2) : 0;
        parHtml += `<div class="par-item"><span><i class="fas fa-calendar-alt"></i> PAR > ${range} days:</span> <span>${fmtMoney(amount, 'USD')} (${percentage}%)</span></div>`;
    }
    container.innerHTML = parHtml;
}

function renderCustomerReport() {
    const officer = document.getElementById('reportOfficerFilter').value;
    const province = document.getElementById('reportProvinceFilter').value;
    const district = document.getElementById('reportDistrictFilter').value;
    const status = document.getElementById('reportStatusFilter').value;
    
    let filteredLoans = [...loans];

    if (officer !== 'all') { filteredLoans = filteredLoans.filter(l => l.creditOfficer === officer); }
    if (province !== 'all') { filteredLoans = filteredLoans.filter(l => getCustomer(l.customerId).province === province); }
    if (district !== 'all') { filteredLoans = filteredLoans.filter(l => getCustomer(l.customerId).district === district); }
    if (status !== 'all') { filteredLoans = filteredLoans.filter(l => getLoanComputedStatus(l).key === status); }

    const tbody = document.getElementById('customerReportTableBody');
    tbody.innerHTML = '';
    let totalAmountUSD = 0;

    filteredLoans.forEach((loan, index) => {
        const customer = getCustomer(loan.customerId);
        const tr = document.createElement('tr');
        const statusInfo = getLoanComputedStatus(loan);
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>${esc(loan.loanId)}</td>
            <td>${esc(customer.name)}</td>
            <td>${esc(customer.gender)}</td>
            <td>${esc(customer.phone)}</td>
            <td>${esc(getOfficerFullName(loan.creditOfficer))}</td>
            <td>${esc(customer.province)}</td>
            <td>${esc(customer.district)}</td>
            <td class="right">${fmtMoney(loan.loanAmount, loan.currency)}</td>
            <td>${formatDateDMY(loan.loanDate)}</td>
            <td class="status-cell"><span class="status-badge status-${statusInfo.key}">${statusInfo.text}</span></td>
        `;
        tbody.appendChild(tr);
        totalAmountUSD += convertCurrency(loan.loanAmount, loan.currency, 'USD');
    });
    
    document.getElementById('customerReportTotalAmount').textContent = fmtMoney(totalAmountUSD, 'USD');
}

function resetCustomerFilters() {
    document.getElementById('reportOfficerFilter').value = 'all';
    document.getElementById('reportProvinceFilter').value = 'all';
    document.getElementById('reportDistrictFilter').value = 'all';
    document.getElementById('reportStatusFilter').value = 'all';
    renderCustomerReport();
}

function exportCustomerReportToExcel() {
    const table = document.getElementById('customerReportTable');
    const wb = XLSX.utils.table_to_book(table, {sheet: "Customer Report"});
    XLSX.writeFile(wb, 'Customer_Report.xlsx');
}

function generateFinancialReport() {
    const startDate = document.getElementById('reportStartDate').value;
    const endDate = document.getElementById('reportEndDate').value;
    const officer = document.getElementById('reportOfficer').value;

    if (!startDate || !endDate) {
        showToast('Please select a start and end date.', 'error');
        return;
    }

    const start = parseDate(startDate);
    const end = parseDate(endDate);
    end.setHours(23, 59, 59, 999);

    const reportData = [];
    const totals = { principal: 0, interest: 0, late: 0, penalty: 0, service: 0, total: 0 };

    const allPayments = [];
    for (const key in payments) {
        const [loanId, installmentIndex] = key.split('-');
        payments[key].forEach(p => allPayments.push({ ...p, loanId, installmentIndex }));
    }
    allPayments.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    for (const p of allPayments) {
        const paymentDate = parseDate(p.date);
        if (paymentDate < start || paymentDate > end) continue;

        const loan = loans.find(l => l.loanId === p.loanId);
        if (!loan) continue;
        if (officer !== 'all' && loan.creditOfficer !== officer) continue;

        const inst = buildSchedule(loan).find(i => i.index == p.installmentIndex);
        if (!inst) continue;

        const paymentsForThisInstallment = payments[`${p.loanId}-${p.installmentIndex}`] || [];
        const amountPaidBeforeThisTx = paymentsForThisInstallment
            .filter(prevP => new Date(prevP.ts) < new Date(p.ts))
            .reduce((sum, prevP) => sum + prevP.amount, 0);

        let remainingAllocation = p.amount;
        
        const allocate = (totalDue, paidBefore) => {
            const outstanding = Math.max(0, totalDue - paidBefore);
            const paidNow = Math.min(remainingAllocation, outstanding);
            remainingAllocation -= paidNow;
            return paidNow;
        };
        
        const paidPenalty = allocate(inst.penalty, amountPaidBeforeThisTx);
        const paidLate = allocate(inst.lateInterest, Math.max(0, amountPaidBeforeThisTx - inst.penalty));
        const totalServiceFees = inst.serviceFee + inst.adminFee + inst.insuranceFee;
        const paidService = allocate(totalServiceFees, Math.max(0, amountPaidBeforeThisTx - inst.penalty - inst.lateInterest));
        const paidInterest = allocate(inst.interest, Math.max(0, amountPaidBeforeThisTx - inst.penalty - inst.lateInterest - totalServiceFees));
        const paidPrincipal = allocate(inst.principal, Math.max(0, amountPaidBeforeThisTx - inst.penalty - inst.lateInterest - totalServiceFees - inst.interest));
        
        const customer = getCustomer(loan.customerId);
        reportData.push({
            date: formatDateDMY(p.date), loanId: loan.loanId, customerName: customer.name,
            principal: paidPrincipal, interest: paidInterest, late: paidLate, penalty: paidPenalty, service: paidService,
            total: p.amount, officer: getOfficerFullName(loan.creditOfficer), currency: loan.currency
        });
    }

    const tbody = document.getElementById('financialReportTableBody');
    tbody.innerHTML = '';
    
    if (reportData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="center">No data for the selected criteria.</td></tr>`;
    } else {
        reportData.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${index + 1}</td> <td>${row.date}</td> <td>${esc(row.loanId)}</td> <td>${esc(row.customerName)}</td>
                <td class="right">${fmtMoney(row.principal, row.currency)}</td> <td class="right">${fmtMoney(row.interest, row.currency)}</td>
                <td class="right">${fmtMoney(row.late, row.currency)}</td> <td class="right">${fmtMoney(row.penalty, row.currency)}</td>
                <td class="right">${fmtMoney(row.service, row.currency)}</td> <td class="right">${fmtMoney(row.total, row.currency)}</td>
                <td>${esc(row.officer)}</td>
            `;
            tbody.appendChild(tr);

            totals.principal += convertCurrency(row.principal, row.currency, 'USD');
            totals.interest += convertCurrency(row.interest, row.currency, 'USD');
            totals.late += convertCurrency(row.late, row.currency, 'USD');
            totals.penalty += convertCurrency(row.penalty, row.currency, 'USD');
            totals.service += convertCurrency(row.service, row.currency, 'USD');
            totals.total += convertCurrency(row.total, row.currency, 'USD');
        });
    }

    document.getElementById('reportPrincipal').textContent = fmtMoney(totals.principal, 'USD');
    document.getElementById('reportInterest').textContent = fmtMoney(totals.interest, 'USD');
    document.getElementById('reportLate').textContent = fmtMoney(totals.late, 'USD');
    document.getElementById('reportPenalty').textContent = fmtMoney(totals.penalty, 'USD');
    document.getElementById('reportService').textContent = fmtMoney(totals.service, 'USD');
    document.getElementById('reportTotal').textContent = fmtMoney(totals.total, 'USD');
    
    showToast('Financial report generated.', 'success');
}

function exportFinancialReport() {
    const table = document.getElementById('financialReportTable');
    if (!table || table.querySelector('tbody').children.length === 1 && table.querySelector('tbody').textContent.includes('No data')) {
        showToast('Please generate a report before exporting.', 'error');
        return;
    }
    const wb = XLSX.utils.table_to_book(table, { sheet: "Financial Report" });
    const startDate = document.getElementById('reportStartDate').value || 'start';
    const endDate = document.getElementById('reportEndDate').value || 'end';
    XLSX.writeFile(wb, `Financial_Report_${startDate}_to_${endDate}.xlsx`);
}

function printFinancialReport() {
    const table = document.getElementById('financialReportTable');
     if (!table || table.querySelector('tbody').children.length === 1 && table.querySelector('tbody').textContent.includes('No data')) {
        showToast('Please generate a report before printing.', 'error');
        return;
    }
    
    const startDate = document.getElementById('reportStartDate').value;
    const endDate = document.getElementById('reportEndDate').value;
    const officer = document.getElementById('reportOfficer').options[document.getElementById('reportOfficer').selectedIndex].text;

    const reportHeader = `
        <div style="text-align:center; margin-bottom: 20px;">
            <h2>Financial Report</h2>
            <p><strong>Date Range:</strong> ${formatDateDMY(startDate)} to ${formatDateDMY(endDate)}</p>
            <p><strong>Credit Officer:</strong> ${officer}</p>
        </div>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write('<html><head><title>Financial Report</title>');
    printWindow.document.write('<link rel="stylesheet" href="styles.css">');
    printWindow.document.write('<style>body { margin: 20px; font-family: "Noto Sans Khmer", Arial, sans-serif; } table { width: 100%; font-size: 10px; } .summary-row td { font-weight: bold; } .right { text-align: right; } </style>');
    printWindow.document.write('</head><body>');
    printWindow.document.write(reportHeader);
    printWindow.document.write(table.outerHTML);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    
    setTimeout(() => {
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    }, 250);
}

function generateAnnualReport() {
    const year = document.getElementById('annualReportYear').value;
    if (!year) {
        showToast('Please select a year.', 'error');
        return;
    }

    const monthlyData = Array.from({ length: 12 }, () => ({
        loanCount: 0,
        loanAmount: 0,
        interest: 0,
        late: 0,
        service: 0,
        totalRevenue: 0
    }));

    // Process new loans for the year
    loans.forEach(loan => {
        const loanDate = parseDate(loan.loanDate);
        if (loanDate.getFullYear() == year) {
            const month = loanDate.getMonth();
            monthlyData[month].loanCount++;
            monthlyData[month].loanAmount += convertCurrency(loan.loanAmount, loan.currency, 'USD');
        }
    });

    // Process payments for the year
    for (const key in payments) {
        payments[key].forEach(p => {
            const paymentDate = parseDate(p.date);
            if (paymentDate.getFullYear() == year) {
                const month = paymentDate.getMonth();
                const [loanId, installmentIndex] = key.split('-');
                const loan = loans.find(l => l.loanId === loanId);
                const inst = buildSchedule(loan).find(i => i.index == installmentIndex);

                if (loan && inst) {
                    const revenue = inst.interest + inst.lateInterest + inst.penalty + inst.serviceFee + inst.adminFee + inst.insuranceFee;
                    const revenueUSD = convertCurrency(revenue, loan.currency, 'USD');
                    monthlyData[month].totalRevenue += revenueUSD;
                    monthlyData[month].interest += convertCurrency(inst.interest, loan.currency, 'USD');
                    monthlyData[month].late += convertCurrency(inst.lateInterest, loan.currency, 'USD');
                    monthlyData[month].service += convertCurrency(inst.serviceFee + inst.adminFee + inst.insuranceFee + inst.penalty, loan.currency, 'USD');
                }
            }
        });
    }

    const tbody = document.getElementById('annualReportTableBody');
    tbody.innerHTML = '';
    const monthLabels = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    const totals = { loanCount: 0, loanAmount: 0, interest: 0, late: 0, service: 0, totalRevenue: 0 };

    monthlyData.forEach((data, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${monthLabels[index]}</td>
            <td class="right">${data.loanCount}</td>
            <td class="right">${fmtMoney(data.loanAmount, 'USD')}</td>
            <td class="right">${fmtMoney(data.interest, 'USD')}</td>
            <td class="right">${fmtMoney(data.late, 'USD')}</td>
            <td class="right">${fmtMoney(data.service, 'USD')}</td>
            <td class="right">${fmtMoney(data.totalRevenue, 'USD')}</td>
        `;
        tbody.appendChild(tr);
        Object.keys(totals).forEach(key => totals[key] += data[key]);
    });

    document.getElementById('annualLoanCount').textContent = totals.loanCount;
    document.getElementById('annualLoanAmount').textContent = fmtMoney(totals.loanAmount, 'USD');
    document.getElementById('annualInterest').textContent = fmtMoney(totals.interest, 'USD');
    document.getElementById('annualLate').textContent = fmtMoney(totals.late, 'USD');
    document.getElementById('annualService').textContent = fmtMoney(totals.service, 'USD');
    document.getElementById('annualTotal').textContent = fmtMoney(totals.totalRevenue, 'USD');
    
    if (charts.annualReportChart) charts.annualReportChart.destroy();
    charts.annualReportChart = new Chart(document.getElementById('annualReportChart'), {
        type: 'bar',
        data: {
            labels: monthLabels,
            datasets: [
                { label: 'Amount Disbursed (USD)', data: monthlyData.map(d => d.loanAmount), backgroundColor: '#007bff' },
                { label: 'Revenue Collected (USD)', data: monthlyData.map(d => d.totalRevenue), backgroundColor: '#28a745' }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });
}


