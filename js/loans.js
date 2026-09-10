// =====================================================================
// loans.js — Core loan lifecycle: schedule building, save/approve/reject/delete, payments, payoff/write-off, collateral/guarantor, attachments, CSV import/export, receipts/printing, collections tab.
// =====================================================================

// ===================== COMPUTED STATUS & DASHBOARD =====================
// Pure: only computes the status to *display* for a loan — it must never mutate `loans` or call
// persistData(). It used to auto-flip a fully-paid loan's status to 'completed' (and persist it)
// as a side effect of being called here, which meant every render of the loans table or
// dashboard (this function is called once per row, possibly dozens of times per render) could
// silently trigger a cloud write. The actual state transition now happens in exactly one place —
// reconcileLoanStatuses(), run once after data loads/changes (see main.js) — plus
// checkAndUpdateLoanStatus(), run once right after a payment is recorded (see savePartialPayment
// above). This function just reads whichever status is current at the time and reports it.
function getLoanComputedStatus(loan) {
  if (!loan) return { key: 'unknown', text: 'Unknown' };
  if (loan.isArchived) return { key: 'archived', text: 'បានទុកក្នុងបណ្ណសារ' };
  if (loan.status === 'written_off') return { key: 'written_off', text: 'កម្ចីបំណុលមិនអាចសងបាន' };
  if (loan.status === 'refinanced') return { key: 'refinanced', text: 'បានកែលម្អ' };
  if (loan.status === 'completed') return { key: 'completed', text: 'បានបញ្ចប់' };
  if (loan.status === 'pending') return { key: 'pending', text: 'រង់ចាំការអនុម័ត' };
  if (loan.status === 'rejected') return { key: 'rejected', text: 'បានបដិសេធ' };

  const schedule = buildSchedule(loan);
  if (!schedule || schedule.length === 0) return { key: 'active', text: 'កំពុងដំណើរការ' };

  const allPaid = schedule.every(p => p.status === 'paid');
  if (allPaid) {
      // Loan.status hasn't caught up yet (reconciliation runs elsewhere) — still show it as
      // completed to the user, but don't write anything here.
      return { key: 'completed', text: 'បានបញ្ចប់' };
  }

  const isOverdue = schedule.some(p => p.status === 'overdue');
  if (isOverdue) return { key: 'overdue', text: 'មានការយឺត' };

  return { key: 'active', text: 'កំពុងដំណើរការ' };
}

// Batched counterpart to checkAndUpdateLoanStatus(): scans every loan ONCE, and for any
// non-terminal loan whose schedule is fully paid but whose stored status hasn't caught up yet,
// flips it to 'completed'. Collects all the changes and issues a single persistData() call at
// the end instead of one per loan, and is meant to be called once (e.g. right after loans and
// payments finish loading in main.js's initApp()) rather than from inside a render loop.
function reconcileLoanStatuses() {
  const terminal = ['completed', 'refinanced', 'written_off', 'rejected', 'pending'];
  let changed = false;

  loans.forEach(loan => {
      if (loan.isArchived || terminal.includes(loan.status)) return;
      const schedule = buildSchedule(loan);
      if (!schedule || schedule.length === 0) return;
      if (schedule.every(p => p.status === 'paid')) {
          loan.status = 'completed';
          logChange(loan.loanId, 'Status Auto-Update', { newStatus: 'completed' });
          changed = true;
      }
  });

  if (changed) {
      persistData(LS_KEYS.loans, loans);
  }
}

function getPeriodDays(loan) {
    if (loan.paymentDateType === 'every-x-days') return Number(loan.everyXDays) || 14;
    switch (loan.interestUnit) {
        case 'day':  return 1;
        case 'week': return 7;
        case 'year': return 365.25;
        default:     return 365.25 / 12; // month
    }
}

function getDailyRate(loan) {
    if (loan.interestRateType === 'fixed') {
        // Fixed interest amount per installment: convert to an equivalent daily rate
        // relative to the principal due each period, so late/payoff interest still scales sensibly.
        const term = Number(loan.loanTerm) || 1;
        const periodPrincipal = Number(loan.loanAmount) / term;
        const fixedInterestAmount = Number(loan.interestRate) || 0;
        const periodDays = getPeriodDays(loan);
        if (periodPrincipal <= 0 || periodDays <= 0) return 0;
        return (fixedInterestAmount / periodPrincipal) / periodDays;
    }
    const rate = Number(loan.interestRate) / 100;
    switch (loan.interestUnit) {
        case "day":   return rate;
        case "week":  return rate / 7;
        case "month": return rate / (365.25 / 12);
        case "year":  return rate / 365.25;
        default:      return rate / (365.25 / 12);
    }
}

function getLateInterest(loan, dueDate, overduePrincipal, daysLate) {
    if (daysLate <= 0) return 0;
    const dailyRate = getDailyRate(loan);
    // Corrected: Late interest should be on the overdue principal amount.
    return overduePrincipal * dailyRate * daysLate;
}


// ===================== PAYMENT STATUS FUNCTIONS =====================
function openPaymentModal(loanId, installmentIndex) {
    const loan = loans.find(l => l.loanId === loanId);
    if (!loan) return;
    
    const terminalStatus = ['completed', 'refinanced', 'written_off', 'rejected', 'pending'];
    if (terminalStatus.includes(loan.status)) {
        showToast('មិនអាចគ្រប់គ្រងការបង់ប្រាក់សម្រាប់កម្ចីនេះបានទេ។', 'error');
        return;
    }

    currentLoan = loan;
    const installment = buildSchedule(loan, true)[installmentIndex - 1];
    currentPayment = { loanId, installmentIndex };

    document.getElementById('modalLoanId').textContent = loanId;
    document.getElementById('modalInstallment').textContent = `${installmentIndex}/${loan.loanTerm}`;
    document.getElementById('modalDueDate').textContent = formatDateDMY(installment.date);
    document.getElementById('modalAmount').textContent = fmtMoney(installment.total, loan.currency);
    document.getElementById('modalPaidAmount').textContent = fmtMoney(installment.paidAmount, loan.currency);
    document.getElementById('modalRemainingAmount').textContent = fmtMoney(installment.remainingAmount, loan.currency);

    document.getElementById('partialPaymentDate').value = formatDateISO(new Date());
    document.getElementById('partialPaymentAmount').value = installment.remainingAmount > 0 ? installment.remainingAmount.toFixed(2) : '';
    document.getElementById('partialPaymentNote').value = '';
    document.getElementById('partialPaymentIsPenalty').checked = false;

    renderPartialPaymentsTable();

    const canManage = hasPermission('canManagePayments') && (hasPermission('canViewAllLoans') || loan.creditOfficer === currentUser.username);
    document.querySelector('#addPartialPaymentForm button').disabled = !canManage || installment.remainingAmount < 0.01;

    document.getElementById('paymentModal').style.display = "flex";
}

function renderPartialPaymentsTable() {
    const { loanId, installmentIndex } = currentPayment;
    const paymentKey = `${loanId}-${installmentIndex}`;
    const partials = payments[paymentKey] || [];
    const tbody = document.getElementById('partialPaymentsTableBody');
    tbody.innerHTML = '';
    const canDelete = currentUser.role === 'admin' || currentUser.role === 'manager';

    if(partials.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="center" style="color:#999">No payments recorded for this installment.</td></tr>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    partials.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDMY(p.date)}</td>
            <td class="right">${fmtMoney(p.amount, currentLoan.currency)}</td>
            <td>${p.isPenaltyPayment ? '<span class="status-badge status-unpaid" style="margin-right:4px;">ពិន័យ</span>' : ''}${esc(p.note || '')}</td>
            <td>${esc(getOfficerFullName(p.by))}</td>
            <td>${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deletePartialPayment('${esc(p.id)}')"><i class="fas fa-trash-alt"></i></button>` : ''}</td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

function closePaymentModal(){document.getElementById('paymentModal').style.display="none"; currentPayment={loanId:null,installmentIndex:null}}

async function deletePartialPayment(paymentId) {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
        showToast('Permission Denied.', 'error');
        return;
    }

    const { loanId, installmentIndex } = currentPayment;
    const paymentKey = `${loanId}-${installmentIndex}`;

    if (!payments[paymentKey]) return;

    if (await customConfirm('Are you sure you want to delete this partial payment? This cannot be undone.')) {
        const originalLength = payments[paymentKey].length;
        payments[paymentKey] = payments[paymentKey].filter(p => p.id !== paymentId);

        if (originalLength > payments[paymentKey].length) {
            persistData(LS_KEYS.payments, payments);
            clearScheduleCache(loanId);
            logChange(loanId, 'Delete Payment', { installment: installmentIndex, paymentId: paymentId });
            openPaymentModal(loanId, installmentIndex);
            if (currentLoan && currentLoan.loanId === loanId) {
              renderSchedule(currentLoan);
              updateSummary(currentLoan);
            }
            displayLoans();
        }
    }
}

// ===================== CORE LOAN FUNCTIONS =====================
function savePartialPayment(e) {
    e.preventDefault();
    const { loanId, installmentIndex } = currentPayment;
    if (!loanId || !installmentIndex) return;

    const loan = loans.find(l => l.loanId === loanId);
    if (!loan) {
        showToast('Error: Could not find the loan data to save payment.', 'error');
        return;
    }

    if (!hasPermission('canManagePayments') || (!hasPermission('canViewAllLoans') && loan.creditOfficer !== currentUser.username)) {
      showToast('Permission Denied.', 'error');
      return;
    }

    const amount = parseFloat(document.getElementById('partialPaymentAmount').value);
    const date = document.getElementById('partialPaymentDate').value;
    const note = document.getElementById('partialPaymentNote').value.trim();
    // Structured flag instead of guessing from free-text `note` — see buildFixedSchedule/
    // buildDynamicSchedule, which used to look for the substring "penalty" inside `note`. That
    // was unreliable: a note like "no penalty this time" or "customer complained about penalty"
    // would wrongly suppress the penalty forever, while a genuine penalty payment recorded
    // without that exact word would never be recognized. This checkbox is the single source of
    // truth now.
    const isPenaltyPayment = document.getElementById('partialPaymentIsPenalty').checked;

    if(!amount || !date || amount <= 0) {
        showToast('Please enter a valid amount and date.', 'error');
        return;
    }

    const paymentKey = `${loanId}-${installmentIndex}`;
    if(!payments[paymentKey]) {
        payments[paymentKey] = [];
    }

    const newPayment = {
        id: genId(),
        amount,
        date,
        note,
        isPenaltyPayment,
        by: currentUser.username,
        ts: new Date().toISOString()
    };

    payments[paymentKey].push(newPayment);
    persistData(LS_KEYS.payments, payments);
    logChange(loanId, 'Add Payment', { installment: installmentIndex, paymentId: newPayment.id, amount: newPayment.amount, date: newPayment.date });

    const payCust = getCustomer(loan.customerId);
    notifyTelegram(`💰 <b>ទូទាត់ប្រាក់ត្រូវបានកត់ត្រា</b>\nលេខកម្ចី: ${loanId}\nអតិថិជន: ${payCust ? payCust.name : 'N/A'}\nចំនួន: ${newPayment.amount} ${loan.currency || ''}\nកាលបរិច្ឆេទ: ${newPayment.date}\nដោយ: ${(currentUser && currentUser.fullName) || newPayment.by}`);

    checkAndUpdateLoanStatus(loanId);

    clearScheduleCache(loanId);
    openPaymentModal(loanId, installmentIndex);

    if (currentLoan && currentLoan.loanId === loanId) {
      renderSchedule(loan);
      updateSummary(loan);
    }
    displayLoans();
}

function checkAndUpdateLoanStatus(loanId) {
  const loanIndex = loans.findIndex(l => l.loanId === loanId);
  if (loanIndex === -1) return;

  const loan = loans[loanIndex];
  if (loan.status === 'completed' || loan.status === 'refinanced' || loan.isArchived) {
      return;
  }

  const schedule = buildSchedule(loan);
  if (!schedule || schedule.length === 0) return;

  const allPaid = schedule.every(p => p.status === 'paid');

  if (allPaid) {
      loans[loanIndex].status = 'completed';
      logChange(loanId, 'Status Update', { newStatus: 'completed', reason: 'All installments paid' });
      persistData(LS_KEYS.loans, loans);
      showToast(`Loan ${loanId} is now complete.`, 'info');
  }
}

function clearScheduleCache(loanId) {
  if(loanId) {
      delete scheduleCache[loanId];
  }
  else { 
      scheduleCache = {}; 
  }
}

// Schedule entries embed date-sensitive fields (status/overdue/daysLate/lateInterest) computed
// against "today". scheduleCache is otherwise only invalidated by explicit data changes
// (payments, edits, ...), so a tab left open across midnight would keep serving yesterday's
// overdue/late-interest numbers until something else happened to clear it. Wiping the whole
// cache the first time buildSchedule() runs on a new calendar day fixes that with a single,
// cheap check, without having to pass forceRecalculate through every call site.
let __scheduleCacheDate = null;
function buildSchedule(loan, forceRecalculate = false) {
  if (!loan || !loan.loanAmount || loan.status === 'pending' || loan.status === 'rejected') return [];

  const todayStr = formatDateISO(new Date());
  if (__scheduleCacheDate !== todayStr) {
      scheduleCache = {};
      __scheduleCacheDate = todayStr;
  }

  const cacheKey = loan.loanId;
  if (scheduleCache[cacheKey] && !forceRecalculate) {
      return scheduleCache[cacheKey];
  }

  let schedule;
  if (loan.calculationType === 'dynamic') {
      schedule = buildDynamicSchedule(loan);
  } else {
      schedule = buildFixedSchedule(loan);
  }

  scheduleCache[cacheKey] = schedule;
  return schedule;
}

function buildFixedSchedule(loan) {
  const schedule = [];
  let balance = Number(loan.loanAmount);
  const term = Number(loan.loanTerm);
  const rate = Number(loan.interestRate) / 100;
  let pmtDate = parseDate(loan.loanDate);
  const originalDay = pmtDate.getDate();
  // Optional officer-chosen date for installment #1 (see saveLoan form field
  // `firstPaymentDate`). When set, every installment date is anchored off this date instead of
  // the loan date — otherwise behavior is unchanged (first installment = loanDate + 1 period).
  const anchorDate = loan.firstPaymentDate ? parseDate(loan.firstPaymentDate) : null;

  let monthlyRate;
  switch (loan.interestUnit) {
      case 'day': monthlyRate = rate * (365.25 / 12); break;
      case 'week': monthlyRate = rate * (52.1775 / 12); break;
      case 'year': monthlyRate = rate / 12; break;
      default: monthlyRate = rate;
  }

  let annuityPayment = 0;
  if (loan.interestRateType !== 'fixed' && loan.paymentMethod === 'annuity' && monthlyRate > 0) {
      annuityPayment = balance * (monthlyRate * Math.pow(1 + monthlyRate, term)) / (Math.pow(1 + monthlyRate, term) - 1);
  }

  for (let i = 1; i <= term; i++) {
      let isAdjusted = false;
      switch (loan.paymentDateType) {
          case 'monthly':
              pmtDate = anchorDate ? addMonthsClamped(anchorDate, i - 1, anchorDate.getDate()) : addMonthsClamped(loan.loanDate, i, originalDay);
              break;
          case 'fixed-day':
              let baseDate = addMonthsClamped(anchorDate || parseDate(loan.loanDate), i - 1);
              baseDate.setDate(loan.fixedDayOfMonth || 15);
              if (i === 1 && baseDate < (anchorDate || parseDate(loan.loanDate))) {
                  baseDate = addMonthsClamped(baseDate, 1);
              }
              pmtDate = baseDate;
              break;
          case 'every-x-days':
              pmtDate = anchorDate ? addDays(anchorDate, (i - 1) * (loan.everyXDays || 14)) : addDays(loan.loanDate, i * (loan.everyXDays || 14));
              break;
      }

      while(holidays.some(h => h.date === formatDateISO(pmtDate))) {
          pmtDate = addDays(pmtDate, 1);
          isAdjusted = true;
      }

      let interest = loan.interestRateType === 'fixed' ? (Number(loan.interestRate) || 0) : balance * monthlyRate;
      // Optional: waive interest on installment #1 only (see "waiveFirstInterest" loan form
      // checkbox). For an annuity loan this means installment #1's fixed payment amount goes
      // almost entirely to principal instead of interest, same as any other interest reduction.
      if (i === 1 && loan.waiveFirstInterest) interest = 0;
      let principal = (loan.paymentMethod === 'annuity' && annuityPayment > 0) ? (annuityPayment - interest) : (Number(loan.loanAmount) / term);

      if (i === term || (balance - principal) < 1) { principal = balance; }

      const serviceFee = (Number(loan.loanAmount) * (Number(loan.serviceRate) || 0) / 100);
      const adminFee = Number(loan.adminFee) || 0;
      const insuranceFee = Number(loan.insuranceFee) || 0;

      const paymentKey = `${loan.loanId}-${i}`;
      const partials = payments[paymentKey] || [];
      const paidAmount = partials.reduce((sum, p) => sum + p.amount, 0);
      const isPayoffSettled = partials.some(p => p.isPayoff);

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const dueDate = new Date(pmtDate); dueDate.setHours(0,0,0,0);
      const daysLate = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

      let lateInterest = 0;
      let penalty = 0;

      const totalDueBeforeLate = principal + interest + serviceFee + adminFee + insuranceFee;
      const remainingAmountBeforeLate = totalDueBeforeLate - paidAmount;

      let status = 'unpaid';
      if(paidAmount > 0) {
          status = remainingAmountBeforeLate <= 0.01 ? 'paid' : 'partial';
      }

      if (isPayoffSettled) {
          // Closed out by an early payoff: future scheduled interest on this installment was
          // waived, so it will never naturally reach `total` — treat it as settled and skip
          // any overdue/late-fee calculation.
          status = 'paid';
      } else if (status !== 'paid' && dueDate < today) {
          status = 'overdue';
          // *** BUG FIX: Calculate late interest on overdue PRINCIPAL only ***
          lateInterest = getLateInterest(loan, dueDate, principal, daysLate);
          
          // Tracked via the explicit `isPenaltyPayment` flag set in savePartialPayment() —
          // NOT by searching `note` text, which was unreliable (a note that merely mentions the
          // word "penalty" without actually being one would wrongly suppress it, and a genuine
          // penalty payment recorded without that exact word would never be recognized).
          const penaltyAlreadyPaid = partials.some(p => p.isPenaltyPayment === true);
          if(!penaltyAlreadyPaid && loan.penaltyFee > 0) {
              penalty = (loan.penaltyType === 'percent')
                  ? (principal) * (loan.penaltyFee / 100)
                  : loan.penaltyFee;
          }
      }

      const total = totalDueBeforeLate + lateInterest + penalty;
      const remainingAmount = isPayoffSettled ? 0 : total - paidAmount;
      balance -= principal;

      schedule.push({ index: i, date: pmtDate.toISOString().split('T')[0], principal, interest, lateInterest, penalty, serviceFee, adminFee, insuranceFee, total, balance: isPayoffSettled ? 0 : (balance < 0.005 ? 0 : balance), status, isAdjusted, paidAmount, remainingAmount, daysLate: daysLate > 0 ? daysLate : 0 });
  }
  return schedule;
}

function buildDynamicSchedule(loan) {
  const schedule = [];
  let runningPrincipal = Number(loan.loanAmount);
  const term = Number(loan.loanTerm);
  const rate = Number(loan.interestRate) / 100;
  let pmtDate = parseDate(loan.loanDate);
  const originalDay = pmtDate.getDate();
  // See buildFixedSchedule() for what this does.
  const anchorDate = loan.firstPaymentDate ? parseDate(loan.firstPaymentDate) : null;

  let monthlyRate;
  switch (loan.interestUnit) {
      case 'day': monthlyRate = rate * (365.25 / 12); break;
      case 'week': monthlyRate = rate * (52.1775 / 12); break;
      case 'year': monthlyRate = rate / 12; break;
      default: monthlyRate = rate;
  }

  for (let i = 1; i <= term; i++) {
      if (i > 1) {
          const prevInstallment = schedule[i-2];
          runningPrincipal = prevInstallment.balance;
      }

      let isAdjusted = false;
       switch (loan.paymentDateType) {
          case 'monthly':
              pmtDate = anchorDate ? addMonthsClamped(anchorDate, i - 1, anchorDate.getDate()) : addMonthsClamped(loan.loanDate, i, originalDay);
              break;
          case 'fixed-day':
              let baseDate = addMonthsClamped(anchorDate || parseDate(loan.loanDate), i - 1);
              baseDate.setDate(loan.fixedDayOfMonth || 15);
              if (i === 1 && baseDate < (anchorDate || parseDate(loan.loanDate))) {
                  baseDate = addMonthsClamped(baseDate, 1);
              }
              pmtDate = baseDate;
              break;
          case 'every-x-days':
              pmtDate = anchorDate ? addDays(anchorDate, (i - 1) * (loan.everyXDays || 14)) : addDays(loan.loanDate, i * (loan.everyXDays || 14));
              break;
      }
      while(holidays.some(h => h.date === formatDateISO(pmtDate))) {
          pmtDate = addDays(pmtDate, 1);
          isAdjusted = true;
      }

      let interest = loan.interestRateType === 'fixed' ? (Number(loan.interestRate) || 0) : runningPrincipal * monthlyRate;
      // See buildFixedSchedule() for what this does.
      if (i === 1 && loan.waiveFirstInterest) interest = 0;
      let principal = (Number(loan.loanAmount) / term);
      if (runningPrincipal < principal) {
          principal = runningPrincipal;
      }

      const serviceFee = (Number(loan.loanAmount) * (Number(loan.serviceRate) || 0) / 100);
      const adminFee = Number(loan.adminFee) || 0;
      const insuranceFee = Number(loan.insuranceFee) || 0;
      const totalFixedFees = serviceFee + adminFee + insuranceFee;

      const paymentKey = `${loan.loanId}-${i}`;
      const partials = payments[paymentKey] || [];
      const paidAmount = partials.reduce((sum, p) => sum + p.amount, 0);
      const isPayoffSettled = partials.some(p => p.isPayoff);

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const dueDate = new Date(pmtDate); dueDate.setHours(0,0,0,0);
      const daysLate = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

      let lateInterest = 0, penalty = 0;
      const totalDueBeforeLate = principal + interest + totalFixedFees;
      const remainingAmountBeforeLate = totalDueBeforeLate - paidAmount;
      let status = 'unpaid';
      if(paidAmount > 0) {
        status = remainingAmountBeforeLate <= 0.01 ? 'paid' : 'partial';
      }
      if (isPayoffSettled) {
          // Closed out by an early payoff — see buildFixedSchedule() for the rationale.
          status = 'paid';
      } else if (status !== 'paid' && dueDate < today) {
          status = 'overdue';
          // *** BUG FIX: Calculate late interest on overdue PRINCIPAL only ***
          lateInterest = getLateInterest(loan, dueDate, principal, daysLate);
          // *** BUG FIX: Don't re-charge penalty if it was already paid (mirrors buildFixedSchedule) ***
          // Tracked via the explicit `isPenaltyPayment` flag (see buildFixedSchedule for why
          // note-text matching was replaced).
          const penaltyAlreadyPaid = partials.some(p => p.isPenaltyPayment === true);
          if (!penaltyAlreadyPaid && loan.penaltyFee > 0) { penalty = (loan.penaltyType === 'percent') ? (principal) * (loan.penaltyFee / 100) : loan.penaltyFee; }
      }
      const total = totalDueBeforeLate + lateInterest + penalty;
      const remainingAmount = isPayoffSettled ? 0 : total - paidAmount;

      const paidTowardsPrincipal = Math.max(0, paidAmount - (interest + totalFixedFees + lateInterest + penalty));
      const balance = isPayoffSettled ? 0 : (runningPrincipal - paidTowardsPrincipal);

      schedule.push({ index: i, date: pmtDate.toISOString().split('T')[0], principal, interest, lateInterest, penalty, serviceFee, adminFee, insuranceFee, total, balance: balance < 0.005 ? 0 : balance, status, isAdjusted, paidAmount, remainingAmount, daysLate: daysLate > 0 ? daysLate : 0 });
  }
  return schedule;
}


function createLoanDataFromForm() {
    return {
        loanDate: document.getElementById('loanDate').value, currency: document.getElementById('currency').value, loanAmount: Number(document.getElementById('loanAmount').value),
        interestRate: Number(document.getElementById('interestRate').value), interestRateType: document.getElementById('interestRateType').value, serviceRate: Number(document.getElementById('serviceRate').value), adminFee: Number(document.getElementById('adminFee').value),
        insuranceFee: Number(document.getElementById('insuranceFee').value), loanTerm: Number(document.getElementById('loanTerm').value), interestUnit: document.getElementById('interestUnit').value,
        paymentMethod: document.getElementById('paymentMethod').value, paymentDateType: document.getElementById('paymentDateType').value, creditOfficer: document.getElementById('creditOfficer').value,
        calculationType: document.getElementById('calculationType').value,
        fixedDayOfMonth: Number(document.getElementById('fixedDayOfMonth').value) || 15, everyXDays: Number(document.getElementById('everyXDays').value) || 14,
        penaltyFee: Number(document.getElementById('penaltyFee').value) || 0, penaltyType: document.getElementById('penaltyType').value,
        latitude: document.getElementById('latitude').value.trim(),
        longitude: document.getElementById('longitude').value.trim(),
        // Optional: officer-chosen date for installment #1 (blank = auto, same as before — see
        // buildFixedSchedule/buildDynamicSchedule). Stored as null rather than '' so it reads the
        // same as an old loan that predates this field.
        firstPaymentDate: document.getElementById('firstPaymentDate').value || null,
        // Optional: waive interest on installment #1 only.
        waiveFirstInterest: document.getElementById('waiveFirstInterest').checked,
    };
}

function applyLoanProductTemplate(productId) {
    if (!productId) {
        document.getElementById('interestRate').value = '';
        document.getElementById('loanTerm').value = '';
        document.getElementById('paymentMethod').value = 'annuity';
        return;
    }
    const product = loanProducts.find(p => p.id === productId);
    if (product) {
        document.getElementById('interestRate').value = product.interestRate;
        document.getElementById('loanTerm').value = product.loanTerm;
        document.getElementById('paymentMethod').value = product.paymentMethod;
        showToast(`Applied template: ${product.name}`, 'info');
    }
}


async function saveLoan() {
    const idFromForm = document.getElementById('loanId').value.trim();
    if (idFromForm && !hasPermission('canEditLoan')) {
        showToast('Permission Denied: You cannot update an existing loan.', 'error');
        return;
    }

    if (!validate()) return;

    const customerId = document.getElementById('customerSelect').value;
    if (!customerId) {
        showToast('សូមជ្រើសរើសអតិថិជនជាមុនសិន', 'error');
        return;
    }

    const isRefinancing = document.getElementById('refinanceSection').style.display === 'block' && document.getElementById('refinanceLoanId').value;
    const formData = createLoanDataFromForm();

    let newLoanData;
    let isNewLoan = false;
    let action = 'Update Loan';
    
    const canApprove = hasPermission('canApproveLoan');
    const initialStatus = canApprove ? 'active' : 'pending';

    if (isRefinancing) {
        const newId = await generateNewLoanId();
        newLoanData = {
            ...formData,
            customerId: customerId,
            loanId: newId,
            processedBy: currentUser.username,
            processedAt: new Date().toISOString(),
            status: initialStatus,
            isArchived: false
        };
        action = 'Refinance Loan';

        const originalLoanId = document.getElementById('refinanceLoanId').value;
        const originalLoanIndex = loans.findIndex(l => l.loanId === originalLoanId);
        if (originalLoanIndex !== -1) {
            loans[originalLoanIndex].status = 'refinanced';
            loans[originalLoanIndex].refinancedTo = newId;
        } else {
            showToast(`Error: Could not find original loan ${originalLoanId}`, 'error'); return;
        }
        newLoanData.refinancedFrom = originalLoanId;
        loans.push(newLoanData);

    } else if (idFromForm && loans.some(l => l.loanId === idFromForm)) {
        if (!await customConfirm('តើអ្នកប្រាកដទេថាចង់រក្សាទុកការផ្លាស់ប្តូរសម្រាប់កម្ចីនេះ?')) {
            return;
        }
        const index = loans.findIndex(l => l.loanId === idFromForm);
        if (index > -1) {
            const existingStatus = loans[index].status;
            newLoanData = Object.assign(loans[index], formData, { customerId: customerId });
            loans[index] = newLoanData;
            loans[index].status = existingStatus; 
        }
    } else {
        const newId = await generateNewLoanId();
        newLoanData = {
            ...formData,
            customerId: customerId,
            loanId: newId,
            processedBy: currentUser.username,
            processedAt: new Date().toISOString(),
            status: initialStatus,
            isArchived: false,
        };
        loans.push(newLoanData);
        isNewLoan = true;
        action = 'Create Loan';
    }

    logChange(newLoanData.loanId, action, { isNew: isNewLoan, data: newLoanData });
    persistData(LS_KEYS.loans, loans);
    clearScheduleCache(newLoanData.loanId);

    const message = isNewLoan && !canApprove 
        ? 'សំណើកម្ចីត្រូវបានដាក់ស្នើដើម្បីរង់ចាំការអនុម័ត!' 
        : 'រក្សាទុកបានជោគជ័យ!';
    showToast(message, 'success');

    if (isNewLoan || isRefinancing) {
        const cust = getCustomer(newLoanData.customerId);
        notifyTelegram(`🆕 <b>${isRefinancing ? 'កម្ចីត្រូវបានផាត់ជាថ្មី (Refinance)' : 'កម្ចីថ្មីត្រូវបានបង្កើត'}</b>\nលេខកម្ចី: ${newLoanData.loanId}\nអតិថិជន: ${cust ? cust.name : 'N/A'}\nចំនួនទឹកប្រាក់: ${newLoanData.loanAmount || ''} ${newLoanData.currency || ''}\nស្ថានភាព: ${newLoanData.status}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    }

    if (isNewLoan && initialStatus === 'pending') {
        createNotification(`pending-${newLoanData.loanId}`, 'fa-gavel', `កម្ចី ${newLoanData.loanId} កំពុងរង់ចាំការអនុម័ត។`, `javascript:goToLoan('${newLoanData.loanId}')`, newLoanData.loanId);
        renderNotifications();
    }
    
    clearForm();
    displayLoans();

    if (isNewLoan || isRefinancing) {
      loadLoan(newLoanData.loanId);
    } else {
       renderSchedule(newLoanData);
       updateSummary(newLoanData);
    }
}

function validate() {
  const fields = [
      { id: 'customerSelect', name: "សូមជ្រើសរើសអតិថិជន", test: (val) => val !== '' },
      { id: 'loanDate', name: "សូមជ្រើសរើសកាលបរិច្ឆេទកម្ចី", test: (val) => !!val },
      { id: 'creditOfficer', name: "មន្ត្រីឥណទាន", test: (val) => val !== '' },
      { id: 'loanAmount', name: "ប្រាក់កម្ចី (>0)", test: (val) => Number(val) > 0 },
      { id: 'loanTerm', name: "រយៈពេលកម្ចី (>0)", test: (val) => Number(val) > 0 },
      { id: 'interestRate', name: "អត្រាការប្រាក់ (>=0)", test: (val) => Number(val) >= 0 }
  ];
  
  const errors = fields.filter(f => !f.test(document.getElementById(f.id).value)).map(f => f.name);
  
  const loanDateValue = document.getElementById('loanDate').value;
  if(loanDateValue){
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const loanDate = parseDate(loanDateValue); loanDate.setHours(0,0,0,0);
      if (loanDate > today) {
          errors.push("កាលបរិច្ឆេទកម្ចីមិនអាចជាកាលបរិច្ឆេទនាពេលអនាគតបានទេ");
      }
  }

  if (document.getElementById('paymentDateType').value === 'fixed-day' && (Number(document.getElementById('fixedDayOfMonth').value) < 1 || Number(document.getElementById('fixedDayOfMonth').value) > 28)) {
      errors.push("ថ្ងៃកំណត់ (1-28)");
  }
  if (document.getElementById('paymentDateType').value === 'every-x-days' && Number(document.getElementById('everyXDays').value) < 1) {
      errors.push("រាល់ X ថ្ងៃ (>=1)");
  }

  const firstPaymentDateValue = document.getElementById('firstPaymentDate').value;
  if (firstPaymentDateValue && loanDateValue) {
      const firstPaymentDate = parseDate(firstPaymentDateValue); firstPaymentDate.setHours(0, 0, 0, 0);
      const loanDate = parseDate(loanDateValue); loanDate.setHours(0, 0, 0, 0);
      if (firstPaymentDate < loanDate) {
          errors.push("ថ្ងៃបង់ប្រាក់លើកទី១ មិនអាចមុនកាលបរិច្ឆេទកម្ចីបានទេ");
      }
  }

  if (errors.length) {
      showToast("សូមពិនិត្យមើលកំហុស:\n - " + errors.join("\n - "), 'error');
      return false;
  }
  return true;
}

// Loan numbers now come from an atomic Postgres counter (next_loan_id() RPC, see schema.sql)
// instead of a per-browser localStorage counter. That old approach could hand out the same
// loan ID twice if two credit officers created a loan at the same moment on different
// computers — the database-side counter can't do that.
async function generateNewLoanId() {
  const year = new Date().getFullYear();
  const nextNum = await cloudNextLoanId(year);
  return `L-${year}-${String(nextNum).padStart(4, '0')}`;
}

function clearForm(){
  document.getElementById('loanForm').reset();
  document.getElementById('loanId').value = "";
  document.getElementById('fixedDayInput').style.display = 'none';
  document.getElementById('everyXDaysInput').style.display = 'none';
  updateInterestRateTypeUI();
  
  document.getElementById('customerSelect').value = "";
  document.getElementById('selectedCustomerInfo').innerHTML = "";
  document.getElementById('customerSelect').disabled = false;

  document.getElementById('refinanceLoanId').value = '';
  document.getElementById('refinanceDate').value = '';
  document.getElementById('refinanceReason').value = 'extend';
  document.getElementById('refinanceNotes').value = '';
  document.getElementById('refinanceSection').style.display = 'none';

  document.getElementById('refinanceBtn').style.display = 'none';
  document.getElementById('payoffBtn').style.display = 'none';
  document.getElementById('historyBtn').style.display = 'none';
  document.getElementById('writeOffBtn').style.display = 'none';
  document.getElementById('messageBtn').style.display = 'none';
  
  document.getElementById('approvalActions').style.display = 'none';

  currentLoan = null;
  document.getElementById("loanDate").value = formatDateISO(new Date);
  
  populateOfficerDropdown('creditOfficer', false, currentUser.username);

  renderAttachments(null);
  document.getElementById('collateralCount').textContent = 0;
  document.getElementById('guarantorCount').textContent = 0;
  toggleFormLock(false); 

  document.querySelectorAll('#loansTableBody tr').forEach(row => row.classList.remove('selected-row'));
}

function clearScheduleAndSummary(){document.getElementById('scheduleTableBody').innerHTML=`<tr><td colspan="14" class="center" style="color:#999">មិនមានតារាងបង់ប្រាក់</td></tr>`;document.getElementById('totalPrincipal').textContent="";document.getElementById('totalInterest').textContent="";document.getElementById('totalLateInterestSummary').textContent="";document.getElementById('totalServiceFeeSummary').textContent="";document.getElementById('totalAdminFeeSummary').textContent="";document.getElementById('totalInsuranceFeeSummary').textContent="";document.getElementById('totalPrincipalInterest').textContent="";document.getElementById("paidCount").textContent="0";document.getElementById("lateCount").textContent="0";document.getElementById("unpaidCount").textContent="0"}

function createLoanTableRow(loan, index) {
  const tr = document.createElement("tr");
  tr.className = 'clickable-row';
  if (currentLoan && currentLoan.loanId === loan.loanId) {
      tr.classList.add('selected-row');
  }
  tr.setAttribute('onclick', `loadLoan('${loan.loanId}')`);
  
  const customer = getCustomer(loan.customerId);
  const statusInfo = getLoanComputedStatus(loan);
  let statusText = statusInfo.text;
  if (loan.refinancedTo) { statusText = `បានកែលម្អ (ទៅ ${esc(loan.refinancedTo)})`; }
  else if (loan.refinancedFrom) { statusText += ` (ពី ${esc(loan.refinancedFrom)})`; }

  const avatarIcon = customer.gender === 'ស្រី' ? 'fas fa-female' : 'fas fa-male';
  const canArchive = hasPermission('canArchiveLoan');
  const canDelete = hasPermission('canDeleteLoan');
  const archiveButton = loan.isArchived
      ? `<button class="btn btn-success btn-sm" onclick="toggleArchiveLoan(event, '${loan.loanId}')"><i class="fas fa-undo"></i> Restore</button>`
      : `<button class="btn btn-danger btn-sm" onclick="toggleArchiveLoan(event, '${loan.loanId}')"><i class="fas fa-archive"></i> Archive</button>`;
  const deleteButton = `<button class="btn btn-danger btn-sm" onclick="deleteLoan(event, '${loan.loanId}')"><i class="fas fa-trash-alt"></i> លុប</button>`;

  tr.innerHTML = `
      <td><input type="checkbox" class="loan-checkbox" data-loan-id="${loan.loanId}" onclick="event.stopPropagation();"></td>
      <td>${index}</td>
      <td>${loan.loanId}</td>
      <td class="customer-name-cell"><i class="${avatarIcon}" style="color:var(--primary-blue);"></i> ${esc(customer.name)}</td>
      <td>${esc(customer.gender)}</td>
      <td>${esc(getOfficerFullName(loan.creditOfficer))}</td>
      <td>${esc(customer.village || "")}</td>
      <td>${esc(customer.commune || "")}</td>
      <td>${esc(customer.district || "")}</td>
      <td>${esc(customer.province || "")}</td>
      <td>${esc(customer.phone || "")}</td>
      <td class="right"><div>${fmtMoney(loan.loanAmount, loan.currency)}</div><div class="secondary-amount">${fmtMoney(convertCurrency(loan.loanAmount, loan.currency, "USD" === loan.currency ? "KHR" : "USD"), "USD" === loan.currency ? "KHR" : "USD")}</div></td>
      <td class="right">${loan.interestRateType === 'fixed' ? fmtMoney(loan.interestRate, loan.currency) : Number(loan.interestRate).toFixed(2) + '%'}</td>
      <td class="right">${fmtMoney(loan.adminFee || 0, loan.currency)}</td>
      <td class="right">${fmtMoney(loan.insuranceFee || 0, loan.currency)}</td>
      <td class="right">${loan.loanTerm}</td>
      <td class="status-cell"><span class="status-badge status-${statusInfo.key}">${statusText}</span></td>
      <td class="actions" onclick="event.stopPropagation();">
          <button class="btn btn-info btn-sm" onclick="loadLoan('${loan.loanId}')"><i class="fas fa-eye"></i> View</button>
          ${canArchive ? archiveButton : ""}
          ${canDelete ? deleteButton : ""}
      </td>`;
  return tr;
}

function displayLoans() {
  let loansToDisplay = [...loans];
  if (!hasPermission('canViewAllLoans')) {
    loansToDisplay = loansToDisplay.filter(l => l.creditOfficer === currentUser.username);
  }
  const statusFilter = document.getElementById('filterStatus').value;
  if (statusFilter === 'all') {
      loansToDisplay = loansToDisplay.filter(l => !l.isArchived);
  } else if (statusFilter === 'archived') {
      loansToDisplay = loansToDisplay.filter(l => l.isArchived);
  } else {
      loansToDisplay = loansToDisplay.filter(l => !l.isArchived && getLoanComputedStatus(l).key === statusFilter);
  }
  const currencyFilter = document.getElementById('filterCurrency').value;
  if (currencyFilter !== 'all') {
      loansToDisplay = loansToDisplay.filter(l => l.currency === currencyFilter);
  }
  const searchTerm = document.getElementById('mainSearchInput').value.toLowerCase().trim();
  if (searchTerm) {
    loansToDisplay = loansToDisplay.filter(l => {
        const customer = getCustomer(l.customerId);
        return l.loanId.toLowerCase().includes(searchTerm) || 
               customer.name.toLowerCase().includes(searchTerm) || 
               (customer.phone || '').includes(searchTerm) || 
               getOfficerFullName(l.creditOfficer).toLowerCase().includes(searchTerm) 
    });
  }

  renderPaginationControls(loansToDisplay.length);
  const paginatedLoans = loansToDisplay.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE);
  const loansTableBody = document.getElementById('loansTableBody');
  loansTableBody.innerHTML = "";

  if (paginatedLoans.length === 0) {
      loansTableBody.innerHTML = `<tr><td colspan="18" class="center" style="color:#999">មិនមានទិន្នន័យ</td></tr>`;
  } else {
    const fragment = document.createDocumentFragment();
    paginatedLoans.forEach((l, i) => {
        const index = (currentPage - 1) * ROWS_PER_PAGE + i + 1;
        fragment.appendChild(createLoanTableRow(l, index));
    });
    loansTableBody.appendChild(fragment);
  }
  updateTableSummary(loansToDisplay);
}

function updateTableSummary(filteredLoans) {
  const summaryLabel = document.getElementById('summaryLabel');
  const totalAmountsCell = document.getElementById('totalLoanAmounts');

  if (filteredLoans.length === 0) {
      summaryLabel.innerHTML = `<i class="fas fa-calculator"></i> សរុប / Total`;
      totalAmountsCell.innerHTML = '';
      return;
  }

  const exchangeRate = getExchangeRate();
  const totals = filteredLoans.reduce((acc, loan) => {
      const amount = Number(loan.loanAmount) || 0;
      if (loan.currency === 'USD') {
          acc.loanAmountUSD += amount;
          acc.loanAmountKHR += Math.round(amount * exchangeRate);
      } else {
          acc.loanAmountKHR += amount;
          acc.loanAmountUSD += parseFloat((amount / exchangeRate).toFixed(2));
      }
      return acc;
  }, { loanAmountUSD: 0, loanAmountKHR: 0 });

  summaryLabel.innerHTML = `<i class="fas fa-calculator"></i> សរុប (${filteredLoans.length} កម្ចី) / Total (${filteredLoans.length} Loans)`;

  totalAmountsCell.innerHTML = `
      <div>${fmtMoney(totals.loanAmountUSD, "USD")}</div>
      <div class="secondary-amount">${fmtMoney(totals.loanAmountKHR, "KHR")}</div>
  `;
}

function loadLoan(loanIdToLoad){
  const loan = loans.find(l=>l.loanId === loanIdToLoad);
  if(loan){
      clearForm();
      document.querySelectorAll('#loansTableBody tr').forEach(row => row.classList.remove('selected-row'));
      const rowToSelect = Array.from(document.querySelectorAll('#loansTableBody tr')).find(row => row.querySelector('td:nth-child(3)')?.textContent === loanIdToLoad);
      if(rowToSelect) {
        rowToSelect.classList.add('selected-row');
        document.getElementById('loanForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      document.getElementById('customerSelect').value = loan.customerId;
      displaySelectedCustomerInfo();
      
      const form = document.getElementById('loanForm');
      form.loanId.value=loan.loanId;
      form.loanDate.value=loan.loanDate; form.currency.value=loan.currency;
      form.loanAmount.value=Number(loan.loanAmount).toFixed(2); form.interestRate.value=Number(loan.interestRate).toFixed(2);
      form.interestRateType.value = loan.interestRateType || 'percent'; updateInterestRateTypeUI();
      form.serviceRate.value=Number(loan.serviceRate).toFixed(2); form.adminFee.value=Number(loan.adminFee||0).toFixed(2);
      form.insuranceFee.value=Number(loan.insuranceFee||0).toFixed(2); form.loanTerm.value=loan.loanTerm;
      form.interestUnit.value=loan.interestUnit||"month"; form.paymentMethod.value=loan.paymentMethod;
      form.calculationType.value=loan.calculationType||"fixed";
      form.paymentDateType.value=loan.paymentDateType; 
      populateOfficerDropdown('creditOfficer', false, loan.creditOfficer);
      form.penaltyFee.value = loan.penaltyFee || 0; form.penaltyType.value = loan.penaltyType || 'fixed';
      form.latitude.value = loan.latitude || "";
      form.longitude.value = loan.longitude || "";

      form.fixedDayOfMonth.value=loan.fixedDayOfMonth||15; form.everyXDays.value=loan.everyXDays||14;
      document.getElementById('fixedDayInput').style.display="fixed-day"===loan.paymentDateType?"block":"none";
      document.getElementById('everyXDaysInput').style.display="every-x-days"===loan.paymentDateType?"block":"none";
      form.firstPaymentDate.value = loan.firstPaymentDate || '';
      form.waiveFirstInterest.checked = !!loan.waiveFirstInterest;

      const statusInfo = getLoanComputedStatus(loan);
      const isActionable = ['active', 'overdue'].includes(statusInfo.key);
      document.getElementById('refinanceBtn').style.display = hasPermission('canRefinanceLoan') && isActionable ? 'inline-block' : 'none';
      document.getElementById('payoffBtn').style.display = isActionable ? 'inline-block' : 'none';
      document.getElementById('writeOffBtn').style.display = hasPermission('canWriteOff') && isActionable ? 'inline-block' : 'none';
      document.getElementById('historyBtn').style.display = 'inline-block';
      document.getElementById('messageBtn').style.display = 'inline-block';
      
      const saveBtn = document.getElementById('saveLoanBtn');
      saveBtn.innerHTML = '<i class="fas fa-save"></i> រក្សាទុក';
      saveBtn.style.display = hasPermission('canEditLoan') ? 'inline-block' : 'none';


      document.getElementById('approvalActions').style.display = (loan.status === 'pending' && hasPermission('canApproveLoan')) ? 'block' : 'none';
      
      currentLoan=loan;
      renderSchedule(loan, true);
      updateSummary(loan);
      renderAttachments(loanIdToLoad);
      document.getElementById('collateralCount').textContent = collaterals.filter(c => c.loanId === loanIdToLoad).length;
      document.getElementById('guarantorCount').textContent = guarantors.filter(g => g.loanId === loanIdToLoad).length;

      const isOwner = loan.creditOfficer === currentUser.username;
      const canEditThisLoan = hasPermission('canEditLoan') && (hasPermission('canViewAllLoans') || isOwner) && !['completed', 'written_off', 'refinanced', 'rejected'].includes(loan.status);
      toggleFormLock(!canEditThisLoan);
      
      // Normally the customer can't be changed once a loan is created — but if this loan's
      // customerId no longer matches any real customer (orphaned, e.g. the customer was
      // deleted), keep the dropdown enabled so someone with edit rights can pick the correct
      // customer and re-save to repair the link, instead of being stuck with "អតិថិជនមិនស្គាល់" forever.
      const isOrphanedCustomer = !customers.some(c => c.id === loan.customerId);
      document.getElementById('customerSelect').disabled = !isOrphanedCustomer;
      if (isOrphanedCustomer && canEditThisLoan) {
          showToast('អតិថិជនរបស់កម្ចីនេះលែងមានទៀតហើយ។ សូមជ្រើសរើសអតិថិជនត្រឹមត្រូវ រួច "រក្សាទុក" ដើម្បីជួសជុល។', 'error');
      }
      document.getElementById('creditOfficer').disabled = !hasPermission('canViewAllLoans');
  }
}

function approveLoan() {
    if (!currentLoan || !hasPermission('canApproveLoan') || currentLoan.status !== 'pending') return;

    const loanIndex = loans.findIndex(l => l.loanId === currentLoan.loanId);
    if (loanIndex > -1) {
        loans[loanIndex].status = 'active';
        loans[loanIndex].approvedBy = currentUser.username;
        loans[loanIndex].approvedAt = new Date().toISOString();

        persistData(LS_KEYS.loans, loans);
        logChange(currentLoan.loanId, "Loan Approved");
        showToast(`Loan ${currentLoan.loanId} has been approved.`, 'success');

        const cust = getCustomer(currentLoan.customerId);
        notifyTelegram(`✅ <b>កម្ចីត្រូវបានអនុម័ត (ព្រមផ្តល់)</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${cust ? cust.name : 'N/A'}\nចំនួនទឹកប្រាក់: ${currentLoan.loanAmount || ''} ${currentLoan.currency || ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);

        displayLoans();
        loadLoan(currentLoan.loanId);
    }
}

async function rejectLoan() {
    if (!currentLoan || !hasPermission('canApproveLoan') || currentLoan.status !== 'pending') return;

    if (await customConfirm(`តើអ្នកប្រាកដទេថាចង់បដិសេធកម្ចី ${currentLoan.loanId}?`)) {
        const loanIndex = loans.findIndex(l => l.loanId === currentLoan.loanId);
        if (loanIndex > -1) {
            loans[loanIndex].status = 'rejected';
            
            persistData(LS_KEYS.loans, loans);
            logChange(currentLoan.loanId, "Loan Rejected");
            showToast(`Loan ${currentLoan.loanId} has been rejected.`, 'info');

            const cust = getCustomer(currentLoan.customerId);
            notifyTelegram(`❌ <b>កម្ចីត្រូវបានបដិសេធ</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${cust ? cust.name : 'N/A'}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);

            displayLoans();
            loadLoan(currentLoan.loanId);
        }
    }
}

async function toggleArchiveLoan(event, loanIdToToggle) {
    event.stopPropagation();
    if (!hasPermission('canArchiveLoan')) { showToast('Permission Denied.', 'error'); return; }
    const loanIndex = loans.findIndex(l => l.loanId === loanIdToToggle);
    if (loanIndex > -1) {
        const loan = loans[loanIndex];
        const action = loan.isArchived ? 'Restore' : 'Archive';
        if (await customConfirm(`Are you sure you want to ${action} loan ${loan.loanId}?`)) {
            loan.isArchived = !loan.isArchived;
            logChange(loan.loanId, action + ' Loan');
            persistData(LS_KEYS.loans, loans);

            const cust = getCustomer(loan.customerId);
            notifyTelegram(`🗄️ <b>កម្ចីត្រូវបាន${loan.isArchived ? 'ទុកក្នុងសំណុំឯកសារ' : 'ស្តារឡើងវិញ'}</b>\nលេខកម្ចី: ${loan.loanId}\nអតិថិជន: ${cust ? cust.name : 'N/A'}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);

            if (currentLoan && currentLoan.loanId === loanIdToToggle) {
                loadLoan(loanIdToToggle);
            }
            displayLoans();
            showToast(`Loan ${action}d successfully.`, 'success');
        }
    }
}

async function deleteLoan(event, loanIdToDelete) {
    if (event) event.stopPropagation();
    if (!hasPermission('canDeleteLoan')) { showToast('Permission Denied.', 'error'); return; }
    const loan = loans.find(l => l.loanId === loanIdToDelete);
    if (!loan) return;

    // A loan linked by refinance (refinancedFrom/refinancedTo) can't be deleted alone — that
    // would leave the other end of the link pointing at a loanId that no longer exists. Instead,
    // walk the whole chain (in both directions) and delete every linked loan together in one
    // confirmed action, so nothing is left dangling.
    const chainIds = new Set([loanIdToDelete]);
    let added = true;
    while (added) {
        added = false;
        loans.forEach(l => {
            const linkedToChain = chainIds.has(l.loanId) || (l.refinancedFrom && chainIds.has(l.refinancedFrom)) || (l.refinancedTo && chainIds.has(l.refinancedTo));
            if (linkedToChain && !chainIds.has(l.loanId)) { chainIds.add(l.loanId); added = true; }
            if (chainIds.has(l.loanId)) {
                if (l.refinancedFrom && !chainIds.has(l.refinancedFrom)) { chainIds.add(l.refinancedFrom); added = true; }
                if (l.refinancedTo && !chainIds.has(l.refinancedTo)) { chainIds.add(l.refinancedTo); added = true; }
            }
        });
    }
    const idsToDelete = [...chainIds].filter(id => loans.some(l => l.loanId === id));
    const isChain = idsToDelete.length > 1;

    // A loan that hasn't finished yet (still active/pending/overdue) can't be deleted — same
    // rule as customer deletion: it must be completed, refinanced, written off, rejected, or
    // archived first. Check every loan in the chain, not just the one that was clicked.
    const FINISHED_STATUSES = ['completed', 'refinanced', 'written_off', 'rejected'];
    const unfinishedIds = idsToDelete.filter(id => {
        const l = loans.find(x => x.loanId === id);
        return !FINISHED_STATUSES.includes(l.status) && !l.isArchived;
    });
    if (unfinishedIds.length > 0) {
        showToast(`មិនអាចលុបកម្ចីនេះបានទេ ព្រោះកម្ចី ${unfinishedIds.join(', ')} មិនទាន់បញ្ចប់ (Completed/Written-off) ឬ Archive ទេ។ សូមបញ្ចប់ ឬ Archive កម្ចីជាមុនសិន។`, 'error');
        return;
    }

    const confirmMsg = isChain
        ? `កម្ចីនេះទាក់ទងជាមួយប្រតិបត្តិការ Refinance។ តើអ្នកពិតជាចង់លុបកម្ចីទាំង ${idsToDelete.length} (${idsToDelete.join(', ')}) ព្រមគ្នាជាអចិន្ត្រៃយ៍មែនទេ? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ ហើយទិន្នន័យបង់ប្រាក់ដែលទាក់ទងទាំងអស់នឹងត្រូវលុបផងដែរ។`
        : `តើអ្នកពិតជាចង់លុបកម្ចី ${loan.loanId} ជាអចិន្ត្រៃយ៍មែនទេ? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ ហើយទិន្នន័យបង់ប្រាក់ដែលទាក់ទងទាំងអស់នឹងត្រូវលុបផងដែរ។`;
    if (!await customConfirm(confirmMsg)) return;

    idsToDelete.forEach(id => {
        loans = loans.filter(l => l.loanId !== id);
        Object.keys(payments).forEach(key => { if (key.startsWith(id + '-')) delete payments[key]; });
        collaterals = collaterals.filter(c => c.loanId !== id);
        guarantors = guarantors.filter(g => g.loanId !== id);
        delete loanHistory[id];
        clearScheduleCache(id);
    });

    persistData(LS_KEYS.loans, loans);
    persistData(LS_KEYS.payments, payments);
    persistData(LS_KEYS.collaterals, collaterals);
    persistData(LS_KEYS.guarantors, guarantors);
    persistData(LS_KEYS.loanHistory, loanHistory);

    if (currentLoan && idsToDelete.includes(currentLoan.loanId)) { clearForm(); }
    displayLoans();
    if (document.getElementById('dashboardTab').classList.contains('active')) { renderDashboard(); }
    showToast(`កម្ចី ${idsToDelete.join(', ')} ត្រូវបានលុបចោលដោយជោគជ័យ។`, 'success');
    notifyTelegram(`🗑️ <b>កម្ចីត្រូវបានលុប</b>\nលេខកម្ចី: ${idsToDelete.join(', ')}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
}

function renderSchedule(t, forceRecalculate = false) {
  const e = buildSchedule(t, forceRecalculate);
  const s = document.getElementById("scheduleTableBody");
  s.innerHTML = "";
  if (!e || e.length === 0) {
      s.innerHTML = `<tr><td colspan="14" class="center" style="color:#999">មិនមានតារាងបង់ប្រាក់</td></tr>`;
      return;
  }
  const fragment = document.createDocumentFragment();
  e.forEach(i => {
      const l = document.createElement("tr");
      let n = "មិនទាន់បង់";
      switch (i.status) {
          case "paid": n = "បានបង់"; break;
          case "partial": n = "បង់បានមួយផ្នែក"; break;
          case "overdue": n = "យឺតយ៉ាវ"; break;
      }
      l.innerHTML = `<td>${i.index}</td>
          <td>${formatDateDMY(i.date)} ${i.isAdjusted ? '<i class="fas fa-calendar-day date-adjusted-icon" title="Pushed from holiday"></i>' : ""}</td>
          <td class="right">${fmtMoney(i.principal, t.currency)}</td>
          <td class="right">${fmtMoney(i.interest, t.currency)}</td>
          <td class="right">${fmtMoney(i.lateInterest, t.currency)}</td>
          <td class="right">${fmtMoney(i.penalty, t.currency)}</td>
          <td class="right">${fmtMoney(i.serviceFee, t.currency)}</td>
          <td class="right">${fmtMoney(i.adminFee, t.currency)}</td>
          <td class="right">${fmtMoney(i.insuranceFee, t.currency)}</td>
          <td class="right">${fmtMoney(i.total, t.currency)}</td>
          <td class="right">${fmtMoney(i.paidAmount, t.currency)}</td>
          <td class="right" style="font-weight:bold; color: ${i.remainingAmount > 0.01 ? 'var(--danger)' : 'var(--success)'}">${fmtMoney(i.remainingAmount, t.currency)}</td>
          <td class="status-cell"><span class="status-badge status-${i.status}">${n}</span></td>
          <td class="center actions">
              <button class="btn btn-sm btn-success" onclick="openPaymentModal('${t.loanId}', ${i.index})"><i class="fas fa-edit"></i> Manage</button>
              ${i.paidAmount > 0 ? `<button class="btn btn-info btn-sm" onclick="openReceiptForInstallment(${i.index})"><i class="fas fa-receipt"></i> Receipt</button>` : ""}
          </td>`;
      fragment.appendChild(l);
  });
  s.appendChild(fragment);

  const a = e.reduce((t, e) => ({
      principal: t.principal + e.principal, interest: t.interest + e.interest, lateInterest: t.lateInterest + e.lateInterest, penalty: t.penalty + e.penalty,
      serviceFee: t.serviceFee + e.serviceFee, adminFee: t.adminFee + e.adminFee, insuranceFee: t.insuranceFee + e.insuranceFee,
      total: t.total + e.total, paidAmount: t.paidAmount + e.paidAmount, remainingAmount: t.remainingAmount + e.remainingAmount
  }), { principal: 0, interest: 0, lateInterest: 0, penalty: 0, serviceFee: 0, adminFee: 0, insuranceFee: 0, total: 0, paidAmount: 0, remainingAmount: 0 });
  const o = document.createElement("tr");
  o.className = "summary-row", o.innerHTML = `<td colspan="2"><i class="fas fa-calculator"></i> សរុប / Total</td>
      <td class="right">${fmtMoney(a.principal, t.currency)}</td>
      <td class="right">${fmtMoney(a.interest, t.currency)}</td>
      <td class="right">${fmtMoney(a.lateInterest, t.currency)}</td>
      <td class="right">${fmtMoney(a.penalty, t.currency)}</td>
      <td class="right">${fmtMoney(a.serviceFee, t.currency)}</td>
      <td class="right">${fmtMoney(a.adminFee, t.currency)}</td>
      <td class="right">${fmtMoney(a.insuranceFee, t.currency)}</td>
      <td class="right">${fmtMoney(a.total, t.currency)}</td>
      <td class="right">${fmtMoney(a.paidAmount, t.currency)}</td>
      <td class="right">${fmtMoney(a.remainingAmount, t.currency)}</td>
      <td colspan="2"></td>`, s.appendChild(o);
}

function updateSummary(t) {
    const e = buildSchedule(t);
    const n = Number(t.loanAmount) || 0;
    const a = e.reduce((t, e) => t + e.interest, 0);
    const o = e.reduce((t, e) => t + e.lateInterest, 0);
    const r = e.reduce((t, e) => t + e.serviceFee, 0);
    const l = e.reduce((t, e) => t + e.adminFee, 0);
    const i = e.reduce((t, e) => t + e.insuranceFee, 0);
    const d = e.filter(t => "paid" === t.status).length;
    const c = e.filter(t => "overdue" === t.status || "partial" === t.status).length;
    const u = e.filter(t => t.status === 'unpaid').length;

    setDualCurrencyText('totalPrincipal', n, t.currency);
    setDualCurrencyText('totalInterest', a, t.currency);
    setDualCurrencyText('totalLateInterestSummary', o, t.currency);
    setDualCurrencyText('totalServiceFeeSummary', r, t.currency);
    setDualCurrencyText('totalAdminFeeSummary', l, t.currency);
    setDualCurrencyText('totalInsuranceFeeSummary', i, t.currency);
    setDualCurrencyText('totalPrincipalInterest', n + a + o + r + l + i, t.currency);

    document.getElementById("paidCount").textContent = d;
    document.getElementById("lateCount").textContent = c;
    document.getElementById("unpaidCount").textContent = u;
}

function initiateRefinance() {
    if (!currentLoan || !hasPermission('canRefinanceLoan')) { showToast('Permission Denied or no loan loaded.', 'error'); return; }
    const originalLoanStatus = getLoanComputedStatus(currentLoan).key;
    if (originalLoanStatus === 'completed' || originalLoanStatus === 'refinanced') { showToast('មិនអាចកែលម្អកម្ចីដែលបានបញ្ចប់ ឬបានកែលម្អរួចហើយទេ', 'error'); return; }

    const schedule = buildSchedule(currentLoan);
    const remainingPrincipal = schedule.reduce((sum, inst) => inst.status !== 'paid' ? sum + inst.principal : sum, 0);

    const originalLoanData = { ...currentLoan };
    clearForm();
    
    document.getElementById('customerSelect').value = originalLoanData.customerId;
    displaySelectedCustomerInfo();
    
    populateOfficerDropdown('creditOfficer', false, originalLoanData.creditOfficer);

    document.getElementById('loanAmount').value = remainingPrincipal.toFixed(2);
    document.getElementById('currency').value = originalLoanData.currency;

    document.getElementById('refinanceLoanId').value = originalLoanData.loanId; document.getElementById('refinanceDate').value = formatDateISO(new Date());
    document.getElementById('refinanceSection').style.display = 'block'; document.getElementById('refinanceBtn').style.display = 'none';
    document.getElementById('payoffBtn').style.display = 'none';
    document.getElementById('historyBtn').style.display = 'none';
    document.getElementById('loanAmount').focus();
    showToast('ទម្រង់បានត្រៀមរួចរាល់សម្រាប់ការកែលម្អកម្ចី\nសូមពិនិត្យ និងបំពេញព័ត៌មានកម្ចីថ្មី រួចចុចរក្សាទុក', 'info');
}

// ===================== EARLY PAYOFF & WRITE OFF =====================
function openPayoffModal() {
  if (!currentLoan) return;
  const schedule = buildSchedule(currentLoan);
  const remainingPrincipal = schedule.reduce((sum, inst) => (inst.status !== 'paid' && inst.status !== 'partial') ? sum + inst.principal : (inst.status === 'partial' ? sum + (inst.principal - Math.max(0, inst.paidAmount - (inst.total - inst.principal))) : sum), 0);
  
  const dailyRate = getDailyRate(currentLoan);
  const lastPaidInstallment = [...schedule].reverse().find(inst => inst.status === 'paid');
  let daysForInterest = 0;
  if(lastPaidInstallment) {
      const lastPaymentDate = parseDate(lastPaidInstallment.date);
      daysForInterest = Math.floor((new Date() - lastPaymentDate) / (1000 * 60 * 60 * 24));
  } else {
      const loanDate = parseDate(currentLoan.loanDate);
      daysForInterest = Math.floor((new Date() - loanDate) / (1000 * 60 * 60 * 24));
  }
  daysForInterest = Math.max(0, daysForInterest);
  const accruedInterest = remainingPrincipal * dailyRate * daysForInterest;

  document.getElementById('payoffLoanId').textContent = currentLoan.loanId;
  document.getElementById('payoffPrincipal').textContent = fmtMoney(remainingPrincipal, currentLoan.currency);
  document.getElementById('payoffInterest').textContent = fmtMoney(accruedInterest, currentLoan.currency);
  document.getElementById('payoffTotal').textContent = fmtMoney(remainingPrincipal + accruedInterest, currentLoan.currency);
  document.getElementById('payoffDate').value = formatDateISO(new Date());
  document.getElementById('payoffModal').style.display = 'flex';
}
function closePayoffModal() { document.getElementById('payoffModal').style.display = 'none'; }
function processPayoff() {
  const amountText = document.getElementById('payoffTotal').textContent;
  const payoffAmount = parseFloat(amountText.replace(/[^0-9.-]+/g, ""));
  const payoffDate = document.getElementById('payoffDate').value;
  const loan = currentLoan;

  const schedule = buildSchedule(loan, true); 
  const unpaidInstallments = schedule.filter(inst => inst.status !== 'paid');

  if (unpaidInstallments.length === 0) {
      showToast("This loan is already fully paid.", "info");
      return;
  }

  // Clear any existing (partial) payments on the unpaid installments — they're being
  // superseded by the payoff settlement recorded below.
  unpaidInstallments.forEach(inst => {
      const paymentKey = `${loan.loanId}-${inst.index}`;
      delete payments[paymentKey];
  });

  // Distribute the amount actually collected across EVERY remaining installment
  // (proportional to each installment's outstanding principal), instead of dumping it
  // all into the first unpaid one. Each installment is flagged `isPayoff: true`, which
  // buildFixedSchedule()/buildDynamicSchedule() treat as fully settled regardless of the
  // usual "paidAmount >= total" check (early payoff waives the not-yet-accrued portion of
  // future interest, so those installments would never individually reach their scheduled
  // total). This keeps the schedule, receipts, and reports consistent with the loan's
  // "completed" status, while the sum of recorded payments still equals the real payoffAmount.
  const totalOutstandingPrincipal = unpaidInstallments.reduce((sum, inst) => sum + inst.principal, 0);
  let allocated = 0;
  unpaidInstallments.forEach((inst, idx) => {
      const isLast = idx === unpaidInstallments.length - 1;
      const share = isLast
          ? Math.round((payoffAmount - allocated) * 100) / 100 // remainder avoids rounding drift
          : (totalOutstandingPrincipal > 0
              ? Math.round((inst.principal / totalOutstandingPrincipal) * payoffAmount * 100) / 100
              : 0);
      allocated += share;

      const paymentKey = `${loan.loanId}-${inst.index}`;
      if (!payments[paymentKey]) payments[paymentKey] = [];
      payments[paymentKey].push({
          id: genId(), amount: share, date: payoffDate, note: "ការទូទាត់មុនកាលកំណត់ (Early loan payoff)", by: currentUser.username, ts: new Date().toISOString(), isPayoff: true
      });
  });

  persistData(LS_KEYS.payments, payments);
  clearScheduleCache(loan.loanId);

  const loanIndex = loans.findIndex(l => l.loanId === loan.loanId);
  if (loanIndex > -1) {
      loans[loanIndex].status = 'completed';
      persistData(LS_KEYS.loans, loans);
  }

  logChange(loan.loanId, "Early Payoff", { amount: payoffAmount, date: payoffDate, installmentsClosed: unpaidInstallments.length });
  showToast(`Loan ${loan.loanId} paid off successfully.`, 'success');

  closePayoffModal();
  loadLoan(loan.loanId);
  displayLoans();
}
function openWriteOffModal() {
    if (!currentLoan) return;
    document.getElementById('writeOffLoanId').textContent = currentLoan.loanId;
    document.getElementById('writeOffModal').style.display = 'flex';
}
function closeWriteOffModal() { document.getElementById('writeOffModal').style.display = 'none'; }
function processWriteOff() {
    if (!currentLoan || !hasPermission('canWriteOff')) return;
    const reason = document.getElementById('writeOffReason').value;
    if (!reason) { showToast('Please provide a reason for writing off the loan.', 'error'); return; }
    const loanIndex = loans.findIndex(l => l.loanId === currentLoan.loanId);
    if (loanIndex > -1) {
        loans[loanIndex].status = 'written_off';
        persistData(LS_KEYS.loans, loans);
        logChange(currentLoan.loanId, 'Loan Written Off', { reason });
        showToast(`Loan ${currentLoan.loanId} has been written off.`, 'success');

        const cust = getCustomer(currentLoan.customerId);
        notifyTelegram(`⚠️ <b>កម្ចីត្រូវបានកាត់ចោល (Write-off)</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${cust ? cust.name : 'N/A'}\nមូលហេតុ: ${reason}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);

        displayLoans();
        loadLoan(currentLoan.loanId);
        closeWriteOffModal();
    }
}

// ===================== COLLATERAL & GUARANTOR MODALS =====================
function openCollateralModal() {
    if (!currentLoan) {
        showToast("Please select a loan first.", "error");
        return;
    }
    document.getElementById('collateralLoanId').textContent = currentLoan.loanId;
    renderCollateralTable();
    document.getElementById('collateralModal').style.display = 'flex';
}

function closeCollateralModal() {
    document.getElementById('collateralModal').style.display = 'none';
    clearCollateralForm();
}

function clearCollateralForm() {
    document.getElementById('collateralForm').reset();
    document.getElementById('collateralId').value = '';
}

// Shared gate for collateral/guarantor edits: same rule as the loan form itself
// (canEditThisLoan in loadLoanIntoForm) — must be able to edit loans in general, and
// either see all loans or own this particular one.
function canManageLoanExtras(loan) {
    return !!loan && hasPermission('canEditLoan') && (hasPermission('canViewAllLoans') || loan.creditOfficer === currentUser.username);
}

function saveCollateral(e) {
    e.preventDefault();
    if (!currentLoan) return;
    if (!canManageLoanExtras(currentLoan)) { showToast('Permission Denied.', 'error'); return; }

    const collateralId = document.getElementById('collateralId').value;
    const collateralData = {
        id: collateralId || 'COL-' + Date.now(),
        loanId: currentLoan.loanId,
        type: document.getElementById('collateralType').value.trim(),
        value: document.getElementById('collateralValue').value.trim(),
        description: document.getElementById('collateralDescription').value.trim()
    };

    if (!collateralData.type || !collateralData.value) {
        showToast("Please enter at least the type and value for the collateral.", "error");
        return;
    }

    const isNewCollateral = !collateralId;
    if (collateralId) {
        const index = collaterals.findIndex(c => c.id === collateralId);
        if (index > -1) collaterals[index] = collateralData;
    } else {
        collaterals.push(collateralData);
    }
    persistData(LS_KEYS.collaterals, collaterals);
    renderCollateralTable();
    clearCollateralForm();
    document.getElementById('collateralCount').textContent = collaterals.filter(c => c.loanId === currentLoan.loanId).length;

    const collCust = getCustomer(currentLoan.customerId);
    notifyTelegram(`🏠 <b>${isNewCollateral ? 'បានបន្ថែមទ្រព្យបញ្ចាំ' : 'ទ្រព្យបញ្ចាំត្រូវបានកែប្រែ'}</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${collCust ? collCust.name : 'N/A'}\nប្រភេទ: ${collateralData.type}\nតម្លៃ: ${collateralData.value}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
}

function renderCollateralTable() {
    const tbody = document.getElementById('collateralTableBody');
    tbody.innerHTML = '';
    const loanCollaterals = collaterals.filter(c => c.loanId === currentLoan.loanId);

    if (loanCollaterals.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="center">No collateral recorded for this loan.</td></tr>`;
        return;
    }
    const canManage = canManageLoanExtras(currentLoan);
    loanCollaterals.forEach(c => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${esc(c.type)}</td>
            <td>${esc(c.description)}</td>
            <td>${esc(c.value)}</td>
            <td class="actions">
                ${canManage ? `<button class="btn btn-info btn-sm" onclick="editCollateral('${esc(c.id)}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-danger btn-sm" onclick="deleteCollateral('${esc(c.id)}')"><i class="fas fa-trash-alt"></i></button>` : ''}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function editCollateral(collateralId) {
    const collateral = collaterals.find(c => c.id === collateralId);
    if (collateral) {
        document.getElementById('collateralId').value = collateral.id;
        document.getElementById('collateralType').value = collateral.type;
        document.getElementById('collateralValue').value = collateral.value;
        document.getElementById('collateralDescription').value = collateral.description;
    }
}

async function deleteCollateral(collateralId) {
    if (!canManageLoanExtras(currentLoan)) { showToast('Permission Denied.', 'error'); return; }
    if (await customConfirm('Are you sure you want to delete this collateral item?')) {
        const deletedColl = collaterals.find(c => c.id === collateralId);
        collaterals = collaterals.filter(c => c.id !== collateralId);
        persistData(LS_KEYS.collaterals, collaterals);
        renderCollateralTable();
        document.getElementById('collateralCount').textContent = collaterals.filter(c => c.loanId === currentLoan.loanId).length;

        const collCust = getCustomer(currentLoan.customerId);
        notifyTelegram(`🗑️ <b>ទ្រព្យបញ្ចាំត្រូវបានលុប</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${collCust ? collCust.name : 'N/A'}${deletedColl ? `\nប្រភេទ: ${deletedColl.type}` : ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    }
}


function openGuarantorModal() {
    if (!currentLoan) {
        showToast("Please select a loan first.", "error");
        return;
    }
    document.getElementById('guarantorLoanId').textContent = currentLoan.loanId;
    renderGuarantorTable();
    document.getElementById('guarantorModal').style.display = 'flex';
}

function closeGuarantorModal() {
    document.getElementById('guarantorModal').style.display = 'none';
    clearGuarantorForm();
}

function clearGuarantorForm() {
    document.getElementById('guarantorForm').reset();
    document.getElementById('guarantorId').value = '';
}

function saveGuarantor(e) {
    e.preventDefault();
    if (!currentLoan) return;
    if (!canManageLoanExtras(currentLoan)) { showToast('Permission Denied.', 'error'); return; }

    const guarantorId = document.getElementById('guarantorId').value;
    const guarantorData = {
        id: guarantorId || 'GUA-' + Date.now(),
        loanId: currentLoan.loanId,
        name: document.getElementById('guarantorName').value.trim(),
        relationship: document.getElementById('guarantorRelationship').value.trim(),
        phone: document.getElementById('guarantorPhone').value.trim(),
        address: document.getElementById('guarantorAddress').value.trim()
    };

    if (!guarantorData.name || !guarantorData.phone) {
        showToast("Please enter at least the name and phone for the guarantor.", "error");
        return;
    }

    const isNewGuarantor = !guarantorId;
    if (guarantorId) {
        const index = guarantors.findIndex(g => g.id === guarantorId);
        if (index > -1) guarantors[index] = guarantorData;
    } else {
        guarantors.push(guarantorData);
    }
    persistData(LS_KEYS.guarantors, guarantors);
    renderGuarantorTable();
    clearGuarantorForm();
    document.getElementById('guarantorCount').textContent = guarantors.filter(g => g.loanId === currentLoan.loanId).length;

    const guarCust = getCustomer(currentLoan.customerId);
    notifyTelegram(`🤝 <b>${isNewGuarantor ? 'បានបន្ថែមអ្នកធានា' : 'អ្នកធានាត្រូវបានកែប្រែ'}</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${guarCust ? guarCust.name : 'N/A'}\nអ្នកធានា: ${guarantorData.name}\nទូរស័ព្ទ: ${guarantorData.phone}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
}

function renderGuarantorTable() {
    const tbody = document.getElementById('guarantorTableBody');
    tbody.innerHTML = '';
    const loanGuarantors = guarantors.filter(g => g.loanId === currentLoan.loanId);

    if (loanGuarantors.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="center">No guarantors recorded for this loan.</td></tr>`;
        return;
    }
    const canManage = canManageLoanExtras(currentLoan);
    loanGuarantors.forEach(g => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${esc(g.name)}</td>
            <td>${esc(g.relationship)}</td>
            <td>${esc(g.phone)}</td>
            <td>${esc(g.address)}</td>
            <td class="actions">
                ${canManage ? `<button class="btn btn-info btn-sm" onclick="editGuarantor('${esc(g.id)}')"><i class="fas fa-edit"></i></button>
                <button class="btn btn-danger btn-sm" onclick="deleteGuarantor('${esc(g.id)}')"><i class="fas fa-trash-alt"></i></button>` : ''}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function editGuarantor(guarantorId) {
    const guarantor = guarantors.find(g => g.id === guarantorId);
    if (guarantor) {
        document.getElementById('guarantorId').value = guarantor.id;
        document.getElementById('guarantorName').value = guarantor.name;
        document.getElementById('guarantorRelationship').value = guarantor.relationship;
        document.getElementById('guarantorPhone').value = guarantor.phone;
        document.getElementById('guarantorAddress').value = guarantor.address;
    }
}

async function deleteGuarantor(guarantorId) {
    if (!canManageLoanExtras(currentLoan)) { showToast('Permission Denied.', 'error'); return; }
    if (await customConfirm('Are you sure you want to delete this guarantor?')) {
        const deletedGuar = guarantors.find(g => g.id === guarantorId);
        guarantors = guarantors.filter(g => g.id !== guarantorId);
        persistData(LS_KEYS.guarantors, guarantors);
        renderGuarantorTable();
        document.getElementById('guarantorCount').textContent = guarantors.filter(g => g.loanId === currentLoan.loanId).length;

        const guarCust = getCustomer(currentLoan.customerId);
        notifyTelegram(`🗑️ <b>អ្នកធានាត្រូវបានលុប</b>\nលេខកម្ចី: ${currentLoan.loanId}\nអតិថិជន: ${guarCust ? guarCust.name : 'N/A'}${deletedGuar ? `\nអ្នកធានា: ${deletedGuar.name}` : ''}\nដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
    }
}


// ===================== CLIENT ACCOUNT TAB FUNCTIONS =====================
function renderClientAccountView() {
    const customerId = document.getElementById('clientAccountSelect').value;
    const loansBody = document.getElementById('clientAccountLoansTableBody');

    // Reset fields
    document.getElementById('clientSummaryActiveLoans').textContent = '0';
    setDualCurrencyText('clientSummaryPrincipalRemaining', 0, 'USD');
    setDualCurrencyText('clientSummaryPaidBalance', 0, 'USD');
    setDualCurrencyText('clientSummaryInterestThisMonth', 0, 'USD');
    
    loansBody.innerHTML = `<tr><td colspan="6" class="center">សូមជ្រើសរើសអតិថិជន</td></tr>`;

    if (!customerId) {
        return;
    }

    // --- Process Loans ---
    const clientLoans = loans.filter(l => l.customerId === customerId);
    let activeLoanCount = 0;
    let totalPrincipalRemainingUSD = 0;
    let totalPaidUSD = 0;
    let interestPaidThisMonthUSD = 0;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    loansBody.innerHTML = '';
    if (clientLoans.length > 0) {
        clientLoans.forEach(loan => {
            const schedule = buildSchedule(loan);
            const statusInfo = getLoanComputedStatus(loan);
            let loanRemainingBalance = 0;
            let loanPrincipalRemaining = 0;
            let loanTotalPaid = 0;
            let endDate = 'N/A';

            if (schedule.length > 0) {
                schedule.forEach(inst => {
                    loanRemainingBalance += inst.remainingAmount || 0;
                    loanTotalPaid += inst.paidAmount || 0;
                    if (inst.status !== 'paid') {
                        const paidTowardsPrincipal = Math.max(0, inst.paidAmount - (inst.interest + inst.lateInterest + inst.penalty + inst.serviceFee + inst.adminFee + inst.insuranceFee));
                        loanPrincipalRemaining += (inst.principal - paidTowardsPrincipal);
                    }
                });
                endDate = formatDateDMY(schedule[schedule.length - 1].date);
            }
            
            totalPaidUSD += convertCurrency(loanTotalPaid, loan.currency, 'USD');
            
            if (['active', 'overdue'].includes(statusInfo.key)) {
                activeLoanCount++;
                totalPrincipalRemainingUSD += convertCurrency(loanPrincipalRemaining, loan.currency, 'USD');
            }

            // Calculate interest paid this month for this loan
            for (const key in payments) {
                if (key.startsWith(loan.loanId)) {
                    payments[key].forEach(p => {
                        const paymentDate = parseDate(p.date);
                        if (paymentDate >= startOfMonth) {
                            // loanId itself contains dashes (e.g. "L-2026-0001"), so split('-')
                            // would wrongly break it apart — use lastIndexOf to only split off
                            // the installment index at the end (mirrors db.js pushKeyedPairEntity).
                            const installmentIndexStr = key.slice(key.lastIndexOf('-') + 1);
                            const inst = schedule.find(i => i.index == installmentIndexStr);
                            if (inst) {
                                let remainingPayment = p.amount;
                                const allocate = (amountDue) => {
                                    const paid = Math.min(remainingPayment, amountDue);
                                    remainingPayment -= paid;
                                    return paid;
                                };
                                allocate(inst.penalty);
                                allocate(inst.lateInterest);
                                allocate(inst.serviceFee + inst.adminFee + inst.insuranceFee);
                                interestPaidThisMonthUSD += convertCurrency(allocate(inst.interest), loan.currency, 'USD');
                            }
                        }
                    });
                }
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${esc(loan.loanId)}</td>
                <td class="right">${fmtMoney(loan.loanAmount, loan.currency)}</td>
                <td>${formatDateDMY(loan.loanDate)}</td>
                <td>${endDate}</td>
                <td class="right">${fmtMoney(loanRemainingBalance, loan.currency)}</td>
                <td class="status-cell"><span class="status-badge status-${statusInfo.key}">${statusInfo.text}</span></td>
            `;
            loansBody.appendChild(tr);
        });
    } else {
        loansBody.innerHTML = `<tr><td colspan="6" class="center">អតិថិជននេះមិនមានកម្ចីទេ</td></tr>`;
    }

    // --- Update Summary Cards ---
    document.getElementById('clientSummaryActiveLoans').textContent = activeLoanCount;
    setDualCurrencyText('clientSummaryPrincipalRemaining', totalPrincipalRemainingUSD, 'USD');
    setDualCurrencyText('clientSummaryPaidBalance', totalPaidUSD, 'USD');
    setDualCurrencyText('clientSummaryInterestThisMonth', interestPaidThisMonthUSD, 'USD');
}


// ===================== ATTACHMENTS (INDEXEDDB) =====================
// Loan attachments now live in the Supabase Storage bucket "loan-attachments" (the file bytes)
// plus the loan_attachments table (the metadata row pointing at it) — see schema.sql and
// db.js's cloudUploadLoanAttachment/cloudListLoanAttachments/cloudGetLoanAttachmentUrl/
// cloudDeleteLoanAttachment. Nothing is written to IndexedDB or localStorage anymore.
async function handleFileUpload(event) {
    const idToSave = document.getElementById('loanId').value.trim();
    if (!idToSave) { showToast("សូមបញ្ចូលលេខកម្ចី ឬរក្សាទុកកម្ចីមុនពេលបន្ថែមឯកសារភ្ជាប់", "error"); document.getElementById('attachmentInput').value = ""; return; }
    const files = Array.from(event.target.files);
    document.getElementById('attachmentInput').value = "";
    for (const file of files) {
        try {
            await cloudUploadLoanAttachment(idToSave, file);
        } catch (e) {
            console.error('Error uploading attachment:', e);
            showToast(`ផ្ទុកឯកសារ "${file.name}" បរាជ័យ: ${String(e.message || e)}`, 'error');
        }
    }
    await renderAttachments(idToSave);
}

async function renderAttachments(loanId) {
    const attachmentList = document.getElementById('attachmentList'); attachmentList.innerHTML = '';
    if (!loanId) return;
    try {
        const files = await cloudListLoanAttachments(loanId);
        if (files.length === 0) {
            attachmentList.innerHTML = '<p style="font-size:12px;color:#777;text-align:center;">មិនមានឯកសារភ្ជាប់</p>';
        } else {
            files.forEach(file => {
                const item = document.createElement('div');
                item.className = 'attachment-item';
                item.innerHTML = `<span><i class="fas fa-file"></i> ${esc(file.file_name)}</span><div><button class="btn btn-info btn-sm" onclick="viewAttachment('${escJsAttr(file.id)}','${escJsAttr(file.storage_path)}')"><i class="fas fa-eye"></i></button><button class="btn btn-danger btn-sm" style="margin-left:4px;" onclick="deleteAttachment('${escJsAttr(file.id)}','${escJsAttr(file.storage_path)}','${escJsAttr(loanId)}')"><i class="fas fa-trash-alt"></i></button></div>`;
                attachmentList.appendChild(item);
            });
        }
    } catch (e) {
        console.error("Could not render attachments", e);
        attachmentList.innerHTML = '<p style="font-size:12px;color:#c0392b;text-align:center;">មិនអាចទាញយកឯកសារភ្ជាប់បានទេ</p>';
    }
}

async function viewAttachment(fileId, storagePath) {
    try {
        const url = await cloudGetLoanAttachmentUrl(storagePath);
        window.open(url, '_blank');
    } catch (e) {
        console.error('Could not open attachment:', e);
        showToast('មិនអាចបើកឯកសារបានទេ', 'error');
    }
}

async function deleteAttachment(fileId, storagePath, loanId) {
    if (await customConfirm("តើអ្នកប្រាកដទេថាចង់លុបឯកសារភ្ជាប់នេះ?")) {
        try {
            await cloudDeleteLoanAttachment(fileId, storagePath);
            await renderAttachments(loanId);
        } catch (e) {
            console.error('Could not delete attachment:', e);
            showToast('លុបឯកសារបរាជ័យ', 'error');
        }
    }
}

// ===================== CSV Import/Export =====================
// Proper RFC-4180-ish CSV line parser: handles fields wrapped in double quotes that contain
// commas, newlines, or escaped ("") double quotes — a plain `line.split(',')` breaks as soon as
// any free-text field (e.g. a village/commune name) contains a comma, shifting every column
// after it.
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuotes) {
            if (char === '"') {
                if (line[i + 1] === '"') { current += '"'; i++; } // escaped quote ("")
                else { inQuotes = false; }
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }
    }
    values.push(current);
    return values;
}

// Wraps a value in double quotes (escaping any existing double quotes) whenever it contains a
// comma, double quote, or newline — i.e. whenever leaving it bare would corrupt the CSV. Every
// exported column should go through this, not just customer name, otherwise any free-text
// field (village/commune/district/province, etc.) containing a comma silently breaks the file.
function csvField(value) {
    const str = (value === null || value === undefined) ? '' : String(value);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Splits a full CSV file's text into rows of already-parsed fields, respecting quoted fields
// that themselves contain a literal newline (a naive `text.split(/\r?\n/)` would otherwise cut
// such a record in half before it ever reaches parseCSVLine()).
function parseCSVRows(text) {
    const lines = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (inQuotes && text[i + 1] === '"') { current += '""'; i++; continue; } // escaped quote
            inQuotes = !inQuotes;
            current += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && text[i + 1] === '\n') i++; // treat \r\n as one line break
            lines.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim() !== '') lines.push(current);
    return lines.filter(l => l.trim() !== '').map(parseCSVLine);
}

function downloadCSVTemplate() {
  const headers = [
      "customerName", "gender", "phone", "village", "commune", "district", "province",
      "loanDate (YYYY-MM-DD)", "currency (USD/KHR)", "loanAmount", "interestRate (%)", "serviceRate (%)", "adminFee",
      "insuranceFee", "loanTerm (Months)", "interestUnit (month/day/week/year)", "paymentMethod (annuity/equal-principal)", "creditOfficer (username)"
  ];
  const csvContent = "data:text/csv;charset=utf-8," + headers.join(",");
  const encodedUri = encodeURI(csvContent);
   const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "loan_import_template.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function importLoansFromCSV(event) {
  if (!hasPermission('canManageSystem')) { showToast('Permission Denied.', 'error'); return; }
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
      const text = e.target.result;
      const rows = parseCSVRows(text).slice(1); // drop header row
      let importedCount = 0;
      let errorCount = 0;

      for (const values of rows) {
          try {
              const customerName = values[0]?.trim();
              if (!customerName) {
                  errorCount++;
                  continue;
              }
              
              let customer = customers.find(c => c.name.toLowerCase() === customerName.toLowerCase());
              if (!customer) {
                  customer = {
                      id: 'CUST-' + Date.now() + Math.random().toString(36).substr(2, 5),
                      name: customerName,
                      gender: values[1]?.trim() || 'ប្រុស',
                      phone: values[2]?.trim() || '',
                      village: values[3]?.trim() || '',
                      commune: values[4]?.trim() || '',
                      district: values[5]?.trim() || '',
                      province: values[6]?.trim() || '',
                      isBlacklisted: false,
                      createdAt: new Date().toISOString()
                  };
                  customers.push(customer);
              }

              const loanData = {
                  loanId: await generateNewLoanId(),
                  customerId: customer.id,
                  loanDate: values[7]?.trim() ? formatDateISO(parseDate(values[7].trim())) : formatDateISO(new Date()),
                  currency: values[8]?.trim().toUpperCase() === 'KHR' ? 'KHR' : 'USD',
                  loanAmount: parseFloat(values[9]) || 0,
                  interestRate: parseFloat(values[10]) || 0,
                  serviceRate: parseFloat(values[11]) || 0,
                  adminFee: parseFloat(values[12]) || 0,
                  insuranceFee: parseFloat(values[13]) || 0,
                  loanTerm: parseInt(values[14]) || 0,
                  interestUnit: values[15]?.trim() || 'month',
                  paymentMethod: values[16]?.trim() || 'annuity',
                  creditOfficer: values[17]?.trim() || currentUser.username,
                  status: 'active',
                  isArchived: false,
                  processedBy: currentUser.username,
                  processedAt: new Date().toISOString()
              };

              if (loanData.loanAmount > 0 && loanData.loanTerm > 0) {
                  loans.push(loanData);
                  logChange(loanData.loanId, 'Create Loan via CSV Import', { data: loanData });
                  importedCount++;
              } else {
                  errorCount++;
              }
          } catch (err) {
              errorCount++;
              console.error("Error parsing CSV row:", values, err);
          }
      }

      if (importedCount > 0) {
          persistData(LS_KEYS.customers, customers);
          persistData(LS_KEYS.loans, loans);
          displayLoans();
          populateCustomerDropdowns();
      }
      showToast(`Import complete. Successfully imported: ${importedCount}, Failed: ${errorCount}.`, 'info');
  };
  reader.readAsText(file);
  event.target.value = '';
}

function exportAllLoansToCSV() {
  if (!hasPermission('canManageSystem')) {
      showToast('Permission Denied.', 'error');
      return;
  }

  const headers = [
      "Loan ID", "Customer Name", "Gender", "Phone", "Village", "Commune", "District", "Province",
      "Loan Date", "Currency", "Loan Amount", "Interest Rate (%)", "Service Rate (%)", "Admin Fee",
      "Insurance Fee", "Loan Term (Months)", "Interest Unit", "Payment Method", "Credit Officer", "Status"
  ];

  const rows = loans.map(loan => {
      const customer = getCustomer(loan.customerId);
      return [
          loan.loanId,
          customer.name,
          customer.gender,
          customer.phone || '',
          customer.village || '',
          customer.commune || '',
          customer.district || '',
          customer.province || '',
          loan.loanDate,
          loan.currency,
          loan.loanAmount,
          loan.interestRate,
          loan.serviceRate || 0,
          loan.adminFee || 0,
          loan.insuranceFee || 0,
          loan.loanTerm,
          loan.interestUnit,
          loan.paymentMethod,
          getOfficerFullName(loan.creditOfficer),
          getLoanComputedStatus(loan).text
      ].map(csvField).join(",");
  });

  const csvContent = "data:text/csv;charset=utf-8,"
      + headers.join(",") + "\n"
      + rows.join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `all_loans_export_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ===================== RECEIPT, EXPORT, TAB, AUTH FUNCTIONS =====================
function batchPrintSchedules() {
    const selectedCheckboxes = document.querySelectorAll('.loan-checkbox:checked');
    if (selectedCheckboxes.length === 0) {
        showToast('Please select at least one loan to print.', 'info');
        return;
    }
    showToast(`Batch printing for ${selectedCheckboxes.length} loan(s) is not yet implemented.`, 'info');
    console.log('Batch print requested for loan IDs:');
    selectedCheckboxes.forEach(cb => console.log(cb.dataset.loanId));
}

function openReceiptForLoan() { if(currentLoan) fillReceipt(currentLoan); }
function openReceiptForInstallment(index) { if(currentLoan) fillReceipt(currentLoan, index); }
function closeReceipt() { document.getElementById('receiptModal').style.display = 'none'; }

function fillReceipt(loan, installmentIndex = null) {
    const customer = getCustomer(loan.customerId);
    document.getElementById('receiptNumber').textContent = 'REC' + Date.now();
    document.getElementById('receiptDate').textContent = new Date().toLocaleDateString('en-GB');
    document.getElementById('customerNameReceipt').textContent = customer.name;
    document.getElementById('loanIdReceipt').textContent = loan.loanId;
    document.getElementById('loanDateReceipt').textContent = formatDateDMY(loan.loanDate);

    const schedule = buildSchedule(loan);
    let principal = 0, interest = 0, lateInterest = 0, penalty = 0, service = 0, admin = 0, insurance = 0, totalPaid = 0;

    const processInstallmentPayments = (inst) => {
        const paymentKey = `${loan.loanId}-${inst.index}`;
        const partials = payments[paymentKey] || [];
        const paidForThisInstallment = partials.reduce((sum, p) => sum + p.amount, 0);

        let remainingPayment = paidForThisInstallment;
        const allocate = (amountDue) => {
            const paid = Math.min(remainingPayment, amountDue);
            remainingPayment -= paid;
            return paid;
        };

        const paidPenalty = allocate(inst.penalty);
        const paidLateInterest = allocate(inst.lateInterest);
        const paidService = allocate(inst.serviceFee);
        const paidAdmin = allocate(inst.adminFee);
        const paidInsurance = allocate(inst.insuranceFee);
        const paidInterest = allocate(inst.interest);
        const paidPrincipal = allocate(remainingPayment);

        return { paidPrincipal, paidInterest, paidLateInterest, paidPenalty, paidService, paidAdmin, paidInsurance, totalPaidForInst: paidForThisInstallment };
    };

    if (installmentIndex) {
        const inst = schedule[installmentIndex - 1];
        if (inst) {
            const breakdown = processInstallmentPayments(inst);
            principal = breakdown.paidPrincipal;
            interest = breakdown.paidInterest;
            lateInterest = breakdown.paidLateInterest;
            penalty = breakdown.paidPenalty;
            service = breakdown.paidService;
            admin = breakdown.paidAdmin;
            insurance = breakdown.paidInsurance;
            totalPaid = breakdown.totalPaidForInst;

            document.getElementById('installmentLine').style.display = 'grid';
            document.getElementById('installmentValue').style.display = 'grid';
            document.getElementById('installmentValue').textContent = installmentIndex;
        }
    } else {
        schedule.forEach(inst => {
            if (inst.paidAmount > 0) {
                const breakdown = processInstallmentPayments(inst);
                principal += breakdown.paidPrincipal;
                interest += breakdown.paidInterest;
                lateInterest += breakdown.paidLateInterest;
                penalty += breakdown.paidPenalty;
                service += breakdown.paidService;
                admin += breakdown.paidAdmin;
                insurance += breakdown.paidInsurance;
                totalPaid += breakdown.totalPaidForInst;
            }
        });
        document.getElementById('installmentLine').style.display = 'none';
        document.getElementById('installmentValue').style.display = 'none';
    }

    document.getElementById('principalAmount').textContent = fmtMoney(principal, loan.currency);
    document.getElementById('interestAmount').textContent = fmtMoney(interest, loan.currency);
    document.getElementById('lateInterestAmount').textContent = fmtMoney(lateInterest, loan.currency);
    document.getElementById('serviceFee').textContent = fmtMoney(service + penalty, loan.currency);
    document.getElementById('adminFeeReceipt').textContent = fmtMoney(admin, loan.currency);
    document.getElementById('insuranceFeeReceipt').textContent = fmtMoney(insurance, loan.currency);
    document.getElementById('totalPayment').textContent = fmtMoney(totalPaid, loan.currency);

    document.getElementById('receiptModal').style.display = 'flex';
}

function openPrintOptionsModal() {
    if (!currentLoan) { showToast("សូមជ្រើសរើសកម្ចីជាមុនសិន", "error"); return; }
    document.getElementById('printOptionsModal').style.display = 'flex';
}
function closePrintOptionsModal() { document.getElementById('printOptionsModal').style.display = 'none'; }

function printLoanSchedule(mode) {
    if (!currentLoan) { showToast("សូមជ្រើសរើសកម្ចីជាមុនសិន", "error"); return; }
    const loan = currentLoan;
    const customer = getCustomer(loan.customerId);
    const paperSize = document.getElementById('printPaperSize').value; // 'a4' or '80mm'

    let schedule = buildSchedule(loan);
    if (mode === 'unpaid') {
        schedule = schedule.filter(s => s.status !== 'paid');
    }

    const firstInstallment = schedule[0] || buildSchedule(loan)[0] || { principal: 0, interest: 0, total: 0 };
    const interestLabel = loan.interestRateType === 'fixed' ? 'ការប្រាក់ប្រចាំខែ' : 'អត្រាការប្រាក់';
    const interestValue = loan.interestRateType === 'fixed' ? fmtMoney(loan.interestRate, loan.currency) : `${Number(loan.interestRate).toFixed(2)}%`;

    const totals = schedule.reduce((acc, s) => {
        acc.principal += s.principal; acc.interest += s.interest; acc.total += s.total;
        return acc;
    }, { principal: 0, interest: 0, total: 0 });

    let rowsHtml = '';
    let startBalance = loan.loanAmount;
    schedule.forEach(s => {
        rowsHtml += paperSize === '80mm'
            ? `<tr><td>${s.index}</td><td>${formatDateDMY(s.date)}</td><td class="right">${fmtMoney(s.principal, loan.currency)}</td><td class="right">${fmtMoney(s.interest, loan.currency)}</td><td class="right">${fmtMoney(s.total, loan.currency)}</td><td class="right">${fmtMoney(s.balance, loan.currency)}</td></tr>`
            : `<tr><td>${s.index}</td><td>${formatDateDMY(s.date)}</td><td class="right">${fmtMoney(startBalance, loan.currency)}</td><td class="right">${fmtMoney(s.principal, loan.currency)}</td><td class="right">${fmtMoney(s.interest, loan.currency)}</td><td class="right">${fmtMoney(s.total, loan.currency)}</td><td class="right">${fmtMoney(s.balance, loan.currency)}</td></tr>`;
        startBalance = s.balance;
    });

    const titleText = mode === 'unpaid' ? 'តារាងបង់ប្រាក់ (មិនទាន់បង់) - LOAN SCHEDULE' : 'តារាងបង់ប្រាក់ប្រាក់កម្ចី - LOAN SCHEDULE';

    // Late-payment fee notice + contact info, shown under the schedule table on every printout.
    const footerNoteHtml = `
        <div class="print-footer-note">
            <p>ប្រសិនបើប្រាក់កម្ចីរបស់អ្នកមិនទាន់បានបង់ទាន់ពេលវេលា—សូមចងចាំថា ថ្លៃសេវាបន្ថែមលើការទូទាត់យឺតដែលមានអត្រា 2.25% ក្នុងមួយខែ នឹងត្រូវបានគណនាជារៀងរាល់ថ្ងៃ។ ដូច្នេះ សូមធ្វើការទូទាត់ឲ្យបានទាន់ពេលវេលា ដើម្បីជៀសវាងការគិតថ្លៃសេវាបន្ថែម និងរក្សាប្រវត្តិខ្ចីប្រាក់របស់អ្នក។</p>
            <p>សូមទាក់ទងមក តេលេក្រាម <a href="https://t.me/Samross_Ph_Care">https://t.me/Samross_Ph_Care</a> ឬ ខលទូរសព្ទ 0888876150 / 0966667292</p>
        </div>`;

    let bodyHtml;
    if (paperSize === '80mm') {
        bodyHtml = `
            <div class="receipt-header">
                <h4>${titleText}</h4>
            </div>
            <div class="receipt-info">
                <div>ឈ្មោះអតិថិជន: <strong>${esc(customer.name)}</strong></div>
                <div>លេខកូដកម្ចី: <strong>${esc(loan.loanId)}</strong></div>
                <div>ចំនួនប្រាក់កម្ចី: <strong>${fmtMoney(loan.loanAmount, loan.currency)}</strong></div>
                <div>${interestLabel}: <strong>${interestValue}</strong></div>
                <div>ប្រាក់ត្រូវសង/ខែ: <strong>${fmtMoney(firstInstallment.total, loan.currency)}</strong></div>
            </div>
            <table class="print-schedule-table">
                <thead><tr><th>ល.រ</th><th>ថ្ងៃ</th><th>ដើម</th><th>ការប្រាក់</th><th>សរុប</th><th>នៅសល់</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
                <tfoot><tr><td colspan="2">សរុប</td><td class="right">${fmtMoney(totals.principal, loan.currency)}</td><td class="right">${fmtMoney(totals.interest, loan.currency)}</td><td class="right">${fmtMoney(totals.total, loan.currency)}</td><td></td></tr></tfoot>
            </table>
            ${footerNoteHtml}`;
    } else {
        bodyHtml = `
            <div class="receipt-header"><h2>${titleText}</h2></div>
            <table class="print-info-table">
                <tr><th>ព័ត៌មានអតិថិជន</th><th>ព័ត៌មានប្រាក់កម្ចី</th><th>សរុបទិន្នន័យ</th></tr>
                <tr>
                    <td>ឈ្មោះអតិថិជន: ${esc(customer.name)}</td>
                    <td>ចំនួនប្រាក់កម្ចី: ${fmtMoney(loan.loanAmount, loan.currency)}</td>
                    <td>ប្រាក់ដើមត្រូវសង/ខែ: ${fmtMoney(firstInstallment.principal, loan.currency)}</td>
                </tr>
                <tr>
                    <td>លេខកូដកម្ចី: ${esc(loan.loanId)}</td>
                    <td>${interestLabel}: ${interestValue}</td>
                    <td>ប្រាក់ត្រូវសង់សរុប/ខែ: ${fmtMoney(firstInstallment.total, loan.currency)}</td>
                </tr>
            </table>
            <table class="print-schedule-table">
                <thead><tr><th>ស.រ</th><th>ថ្ងៃត្រូវបង់</th><th>ប្រាក់ដើមមុនបង់</th><th>ប្រាក់ដើមត្រូវសង</th><th>ការប្រាក់ត្រូវសង</th><th>ប្រាក់ត្រូវសង់សរុប</th><th>ប្រាក់ដើមនៅសល់</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
                <tfoot><tr><td colspan="2">សរុប (TOTAL)</td><td></td><td class="right">${fmtMoney(totals.principal, loan.currency)}</td><td class="right">${fmtMoney(totals.interest, loan.currency)}</td><td class="right">${fmtMoney(totals.total, loan.currency)}</td><td></td></tr></tfoot>
            </table>
            ${footerNoteHtml}`;
    }

    const pageStyle = paperSize === '80mm' ? `
        @page { size: 80mm auto; margin: 2mm; }
        body { width: 76mm; margin: 0 auto; font-family: 'Khmer OS', Arial, sans-serif; font-size: 10px; color:#000; }
        .receipt-header { text-align:center; margin-bottom:6px; }
        .receipt-header h4 { margin:0; font-size:12px; }
        .receipt-info { margin-bottom:6px; line-height:1.5; }
        table.print-schedule-table { width:100%; border-collapse:collapse; }
        table.print-schedule-table th, table.print-schedule-table td { border-bottom:1px dashed #000; padding:2px; font-size:9px; }
        .right { text-align:right; }
        .print-footer-note { margin-top:8px; padding-top:6px; border-top:1px dashed #000; font-size:8px; line-height:1.5; }
        .print-footer-note p { margin:0 0 4px; }
        .print-footer-note a { color:#000; }
    ` : `
        @page { size: A4; margin: 15mm; }
        body { font-family: 'Khmer OS', Arial, sans-serif; font-size: 13px; color:#000; }
        .receipt-header { text-align:center; margin-bottom:16px; }
        .receipt-header h2 { margin:0; }
        table.print-info-table, table.print-schedule-table { width:100%; border-collapse:collapse; margin-bottom:14px; }
        table.print-info-table th, table.print-info-table td, table.print-schedule-table th, table.print-schedule-table td { border:1px solid #333; padding:6px 8px; }
        table.print-info-table th { background:#f0f0f0; }
        table.print-schedule-table thead th { background:#f0f0f0; }
        tfoot td { font-weight:bold; }
        .right { text-align:right; }
        .print-footer-note { margin-top:10px; padding:10px 12px; border:1px solid #333; border-radius:4px; font-size:12px; line-height:1.6; background:#fafafa; }
        .print-footer-note p { margin:0 0 6px; }
        .print-footer-note p:last-child { margin-bottom:0; font-weight:bold; }
        .print-footer-note a { color:#000; }
    `;

    // NOTE: no 'noopener' here — passing it makes window.open() return null in modern Chrome/Edge
    // even when pop-ups ARE allowed, so we'd lose the reference needed to write content into the
    // window, call print(), and close() it. The blank tab stays open forever and print never runs.
    const printWindow = window.open('', '_blank');
    if (!printWindow) { showToast('សូមអនុញ្ញាត Pop-up (Allow Pop-ups) សម្រាប់គេហទំព័រនេះ ដើម្បីអាច Print បាន', 'error'); return; }
    printWindow.document.write(`<html><head><title>${titleText}</title><style>${pageStyle}</style></head><body>${bodyHtml}</body></html>`);
    printWindow.document.close();
    setTimeout(() => {
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    }, 250);

    closePrintOptionsModal();
}

function printReceipt() {
    const printArea = document.getElementById('receiptPrint');
    if (!printArea) return;

    // NOTE: no 'noopener' here — see the comment in printLoanSchedule() above for why.
    const printWindow = window.open('', '_blank');
    if (!printWindow) { showToast('សូមអនុញ្ញាត Pop-up (Allow Pop-ups) សម្រាប់គេហទំព័រនេះ ដើម្បីអាច Print បាន', 'error'); return; }
    printWindow.document.write('<html><head><title>Print Receipt</title>');
    printWindow.document.write('<link rel="stylesheet" href="styles.css">');
    printWindow.document.write('<style>body { margin: 20px; } .modal-content { border: none; box-shadow: none; } #receiptActions { display: none; } </style>');
    printWindow.document.write('</head><body>');
    printWindow.document.write(printArea.innerHTML);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    setTimeout(() => { 
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    }, 250);
}

function exportScheduleToExcel() {
    if (!currentLoan) { showToast("សូមជ្រើសរើសកម្ចីជាមុនសិន", "error"); return; }
    const schedule = buildSchedule(currentLoan);
    const data = schedule.map(s => ({ "ល.រ": s.index, "កាលបរិច្ឆេទបង់": formatDateDMY(s.date), "ប្រាក់ដើម": s.principal.toFixed(2), "ការប្រាក់": s.interest.toFixed(2), "ការប្រាក់យឺត": s.lateInterest.toFixed(2), "ពិន័យ": s.penalty.toFixed(2), "ថ្លៃសេវា": (s.serviceFee + s.adminFee + s.insuranceFee).toFixed(2), "សរុប": s.total.toFixed(2), "បានបង់": s.paidAmount.toFixed(2), "នៅសល់": s.remainingAmount.toFixed(2), "ស្ថានភាព": s.status }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Schedule");
    XLSX.writeFile(workbook, `${currentLoan.loanId}_schedule.xlsx`);
}

// ===================== COLLECTIONS TAB FUNCTION =====================
function renderCollectionsTable() {
    const selectedDate = document.getElementById('collectionsDate').value;
    const officerFilter = document.getElementById('collectionsOfficerFilter').value;
    const tbody = document.getElementById('collectionsTableBody');
    const principalTotalEl = document.getElementById('collectionsPrincipalTotal');
    const profitTotalEl = document.getElementById('collectionsProfitTotal');
    const grandTotalEl = document.getElementById('collectionsGrandTotal');

    tbody.innerHTML = '';
    principalTotalEl.textContent = fmtMoney(0, 'USD');
    profitTotalEl.textContent = fmtMoney(0, 'USD');
    grandTotalEl.textContent = fmtMoney(0, 'USD');

    if (!selectedDate) {
        tbody.innerHTML = `<tr><td colspan="7" class="center" style="color:#888;">សូមជ្រើសរើសកាលបរិច្ឆេទ</td></tr>`;
        return;
    }

    let collections = [];
    let totals = { principal: 0, profit: 0, grand: 0 };

    const activeLoans = loans.filter(l => ['active', 'overdue'].includes(getLoanComputedStatus(l).key));

    activeLoans.forEach(loan => {
        if (officerFilter !== 'all' && loan.creditOfficer !== officerFilter) {
            return;
        }

        const schedule = buildSchedule(loan);
        const dueInstallment = schedule.find(inst => inst.date === selectedDate && inst.status !== 'paid');
        
        if (dueInstallment) {
            const customer = getCustomer(loan.customerId);
            collections.push({
                loanId: loan.loanId,
                customerName: customer.name,
                phone: customer.phone,
                installmentIndex: dueInstallment.index,
                amountDue: dueInstallment.remainingAmount,
                principalDue: dueInstallment.status === 'partial' ? (dueInstallment.principal - Math.max(0, dueInstallment.paidAmount - (dueInstallment.total - dueInstallment.principal))) : dueInstallment.principal,
                profitDue: dueInstallment.total - dueInstallment.principal,
                creditOfficer: getOfficerFullName(loan.creditOfficer),
                currency: loan.currency
            });
        }
    });

    if (collections.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="center">មិនមានការប្រមូលប្រាក់សម្រាប់ថ្ងៃនេះទេ</td></tr>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    collections.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${esc(item.loanId)}</td>
            <td>${esc(item.customerName)}</td>
            <td>${esc(item.phone)}</td>
            <td>${item.installmentIndex} / ${loans.find(l => l.loanId === item.loanId).loanTerm}</td>
            <td class="right">${fmtMoney(item.amountDue, item.currency)}</td>
            <td>${esc(item.creditOfficer)}</td>
            <td class="actions">
                <button class="btn btn-sm btn-success" onclick="openPaymentModal('${item.loanId}', ${item.installmentIndex})"><i class="fas fa-hand-holding-usd"></i> Collect</button>
            </td>
        `;
        fragment.appendChild(tr);

        totals.principal += convertCurrency(item.principalDue, item.currency, 'USD');
        totals.profit += convertCurrency(item.profitDue, item.currency, 'USD');
        totals.grand += convertCurrency(item.amountDue, item.currency, 'USD');
    });

    tbody.appendChild(fragment);

    principalTotalEl.textContent = fmtMoney(totals.principal, 'USD');
    profitTotalEl.textContent = fmtMoney(totals.profit, 'USD');
    grandTotalEl.textContent = fmtMoney(totals.grand, 'USD');
}


