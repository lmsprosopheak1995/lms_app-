// =====================================================================
// ai.js — AI features for the Loan Management System:
//   1) Credit risk scoring — deterministic, rule-based (no external API)
//      score (0-100) for every active loan, from its own payment history
//      plus the customer's history with other loans.
//   2) Predictive collection watch-list — flags loans that are NOT yet
//      overdue but show early warning signs (installment due very soon +
//      a track record of partial/late payments on this loan), so staff
//      can reach out before a payment is actually missed.
//   3) AI credit decisioning — optionally auto-approves/rejects PENDING
//      public loan requests (loanRequests) for small amounts, using the
//      requesting customer's existing history. New/unknown customers and
//      anything over the configured threshold are always left for a human
//      to decide. This intentionally stops short of auto-creating the
//      actual loan+repayment schedule — an officer still opens "បង្កើតកម្ចី"
//      and confirms/enters the interest terms before any money terms are
//      set, so a bad AI default can never silently become a live contract.
//   4) Advance payment reminders — once a day (best-effort, shared across
//      whoever opens the app first that day via app_settings), scans for
//      installments due soon and (a) raises in-app notifications and
//      (b) sends one digest message to the internal Telegram group
//      (notifyTelegram — this is a staff-facing heads-up, not a message
//      sent directly to the customer; there is no SMS/customer-Telegram
//      gateway in this app).
//   5) Data chatbot — natural-language Q&A over a condensed, permission-
//      scoped snapshot of the portfolio, via the Anthropic Messages API.
//
// SECURITY NOTE: the chatbot (and nothing else here) calls the Anthropic
// API directly from the browser using an API key entered in the "AI
// Settings" tab (stored in the shared app_settings row, same mechanism as
// the exchange rate / message templates). That means the key is present
// in this browser's network requests and, once loaded via
// loadAllCloudData(), in this app's shared settings cache. That's an
// acceptable trade-off for a small internal admin tool but is NOT the
// recommended pattern for a public product — for stronger security later,
// move that fetch() call into a Supabase Edge Function that holds the key
// server-side and proxies the request, and call that function instead.
// =====================================================================

// ===================== RISK SCORING (rule-based, offline) =====================

// Loans in these computed/stored statuses aren't "at risk" in an actionable
// sense (already resolved one way or another), so they're skipped.
const AI_RISK_EXCLUDED_STATUSES = ['completed', 'rejected'];

function getAIVisibleLoans() {
    let list = loans.filter(l => !l.isArchived);
    if (!hasPermission('canViewAllLoans')) {
        list = list.filter(l => l.creditOfficer === currentUser.username);
    }
    return list;
}

function aiRiskBandLabel(band) {
    return {
        low: 'ហានិភ័យទាប',
        medium: 'ហានិភ័យមធ្យម',
        high: 'ហានិភ័យខ្ពស់',
        critical: 'ហានិភ័យធ្ងន់ធ្ងរ'
    }[band] || band;
}

function aiSafeSchedule(loan) {
    try { return buildSchedule(loan) || []; } catch (e) { return []; }
}

// Returns { score, band, reasons, loan } or null when the loan isn't in a
// risk-relevant status (e.g. already fully paid).
function computeLoanRiskScore(loan) {
    const statusInfo = getLoanComputedStatus(loan);
    if (AI_RISK_EXCLUDED_STATUSES.includes(statusInfo.key)) return null;

    if (statusInfo.key === 'written_off') {
        return { score: 100, band: 'critical', reasons: ['កម្ចីនេះត្រូវបានកត់ត្រាថាជាបំណុលមិនអាចសងបាន (Written off)'], loan };
    }

    const schedule = aiSafeSchedule(loan);
    if (schedule.length === 0) return { score: 0, band: 'low', reasons: ['មិនទាន់មានតារាងបង់ប្រាក់'], loan };

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dueSoFar = schedule.filter(i => { try { return parseDate(i.date) <= today; } catch (e) { return false; } });
    const overdueItems = schedule.filter(i => i.status === 'overdue');
    const partialItems = schedule.filter(i => i.status === 'partial');
    const totalDue = dueSoFar.length || 1;
    const overdueRatio = overdueItems.length / totalDue;
    const maxDaysLate = overdueItems.reduce((max, i) => {
        try { return Math.max(max, Math.floor((today - parseDate(i.date)) / 86400000)); } catch (e) { return max; }
    }, 0);

    let score = 0;
    const reasons = [];

    if (overdueItems.length > 0) {
        score += Math.min(50, overdueRatio * 60);
        reasons.push(`បង់ប្រាក់យឺត ${overdueItems.length} លើក (${Math.round(overdueRatio * 100)}% នៃការបង់ដែលដល់កាលកំណត់)`);
    }
    if (maxDaysLate > 0) {
        score += Math.min(35, maxDaysLate / 3);
        reasons.push(`ការបង់ដែលយឺតបំផុតកន្លងផុតកាលកំណត់ ${maxDaysLate} ថ្ងៃ`);
    }
    if (partialItems.length > 0) {
        score += Math.min(10, partialItems.length * 3);
        reasons.push(`បង់មិនគ្រប់ចំនួន ${partialItems.length} លើក`);
    }
    if (loan.refinancedFrom) {
        score += 8;
        reasons.push('កម្ចីនេះកកើតចេញពីការកែលម្អកម្ចីចាស់ (refinance)');
    }

    // Customer-level history: other loans this same customer has had.
    const priorLoans = loans.filter(l => l.customerId === loan.customerId && l.loanId !== loan.loanId);
    const priorWriteOffs = priorLoans.filter(l => l.status === 'written_off').length;
    if (priorWriteOffs > 0) {
        score += priorWriteOffs * 15;
        reasons.push(`អតិថិជននេះធ្លាប់មានកម្ចីចំនួន ${priorWriteOffs} ដែលក្លាយជាបំណុលមិនអាចសងបាន`);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    let band = 'low';
    if (score >= 70) band = 'critical';
    else if (score >= 45) band = 'high';
    else if (score >= 20) band = 'medium';

    if (reasons.length === 0) reasons.push('គ្មានសញ្ញាហានិភ័យគួរឱ្យកត់សម្គាល់នៅពេលនេះទេ');

    return { score, band, reasons, loan };
}

function computeCustomerRiskScore(customerId) {
    const custLoans = loans.filter(l => l.customerId === customerId && !l.isArchived);
    const scored = custLoans.map(computeLoanRiskScore).filter(Boolean);
    if (scored.length === 0) return { score: 0, band: 'low', reasons: ['គ្មានកម្ចីសកម្មទេ'] };
    const maxEntry = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
    return { score: maxEntry.score, band: maxEntry.band, reasons: maxEntry.reasons };
}

function renderAIRiskOverview() {
    const container = document.getElementById('aiRiskList');
    if (container) {
        const scored = getAIVisibleLoans().map(computeLoanRiskScore).filter(Boolean);
        scored.sort((a, b) => b.score - a.score);
        const top = scored.filter(r => r.score > 0).slice(0, 25);

        container.innerHTML = top.length === 0
            ? '<p class="ai-empty">មិនមានកម្ចីដែលមានហានិភ័យគួរឱ្យកត់សម្គាល់ទេ</p>'
            : top.map(aiRenderRiskCard).join('');
    }
    renderAICollectionWatchlist();
}

function aiRenderRiskCard(r) {
    const cust = getCustomer(r.loan.customerId);
    return `<div class="ai-risk-card ai-risk-${r.band}">
        <div class="ai-risk-head">
            <span class="ai-risk-score">${r.score}</span>
            <div class="ai-risk-head-text">
                <div class="ai-risk-loanid">${esc(r.loan.loanId)} — ${esc(cust.name)}</div>
                <div class="ai-risk-band ai-risk-band-${r.band}">${aiRiskBandLabel(r.band)}</div>
            </div>
        </div>
        <ul class="ai-risk-reasons">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>`;
}

// ===================== PREDICTIVE COLLECTION WATCH-LIST =====================
// Leading indicator (not lagging): loans that are NOT currently overdue, but
// have an installment due within the next few days AND a track record on
// THIS loan of partial or previously-late payments — i.e. likely to become
// the "overdue" case above if nobody follows up first.
const AI_WATCHLIST_DAYS_AHEAD = 3;

function computeUpcomingCollectionRisk(loan) {
    const statusInfo = getLoanComputedStatus(loan);
    if (statusInfo.key !== 'active') return null; // already overdue/resolved — covered elsewhere

    const schedule = aiSafeSchedule(loan);
    if (schedule.length === 0) return null;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = addDays(today, AI_WATCHLIST_DAYS_AHEAD);

    const nextDue = schedule.find(i => i.status !== 'paid');
    if (!nextDue) return null;
    let dueDate;
    try { dueDate = parseDate(nextDue.date); } catch (e) { return null; }
    if (dueDate < today || dueDate > horizon) return null; // not due soon enough to warn about

    // Track record on THIS loan so far (paid installments only, i.e. ones we
    // already know the outcome of): how many were ever partial, versus how
    // many were paid cleanly. No history at all (first installment) = no signal.
    const settledSoFar = schedule.filter(i => i.status === 'paid' || i.status === 'partial');
    const partialSoFar = settledSoFar.filter(i => i.status === 'partial').length;
    if (settledSoFar.length === 0 || partialSoFar === 0) return null;

    const partialRatio = partialSoFar / settledSoFar.length;
    const daysUntilDue = Math.round((dueDate - today) / 86400000);
    const reasons = [`ថ្ងៃបង់បន្ទាប់ (${formatDateDMY(nextDue.date)}) នៅសល់ ${daysUntilDue} ថ្ងៃទៀត`, `ធ្លាប់បង់មិនគ្រប់ចំនួន ${partialSoFar}/${settledSoFar.length} លើកចុងក្រោយ`];
    const likelihood = Math.round(Math.min(90, partialRatio * 100));

    return { loan, likelihood, daysUntilDue, reasons };
}

function renderAICollectionWatchlist() {
    const container = document.getElementById('aiWatchlist');
    if (!container) return;
    const flagged = getAIVisibleLoans().map(computeUpcomingCollectionRisk).filter(Boolean);
    flagged.sort((a, b) => b.likelihood - a.likelihood);

    if (flagged.length === 0) {
        container.innerHTML = '<p class="ai-empty">មិនមានកម្ចីណាត្រូវប្រុងប្រយ័ត្នពិសេសនៅពេលនេះទេ</p>';
        return;
    }
    container.innerHTML = flagged.map(f => {
        const cust = getCustomer(f.loan.customerId);
        return `<div class="ai-risk-card ai-risk-medium">
            <div class="ai-risk-head">
                <span class="ai-risk-score">${f.likelihood}%</span>
                <div class="ai-risk-head-text">
                    <div class="ai-risk-loanid">${esc(f.loan.loanId)} — ${esc(cust.name)}</div>
                    <div class="ai-risk-band ai-risk-band-medium">ទំនងជានឹងបង់យឺត</div>
                </div>
            </div>
            <ul class="ai-risk-reasons">${f.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>`;
    }).join('');
}

// ===================== AI CREDIT DECISIONING (loan requests) =====================
// Only ever acts on PENDING public loan requests (loanRequests). A request is
// auto-decided only when ALL of these hold:
//   - the phone number matches an EXISTING customer (first-time applicants
//     always need a human — there's no history to judge them on)
//   - that customer isn't blacklisted and has no other currently active/
//     pending/overdue loan (avoids silently stacking a 2nd loan on someone)
//   - the customer's worst existing-loan risk score is low/medium (see
//     computeCustomerRiskScore) — high/critical risk auto-rejects instead
//   - the requested amount is within the configured auto-approve ceiling
// Anything else (new customer, over ceiling, ambiguous) is left "pending"
// for a person to review, same as today.
function aiDecisionEligibleCustomer(request) {
    if (!request.phone) return null;
    return customers.find(c => c.phone && c.phone === request.phone) || null;
}

function runAICreditDecisioning() {
    const cfg = getAIConfig();
    if (!cfg.autoDecision.enabled) return;
    if (!hasPermission('canApproveLoan')) return; // same gate as manual approve/reject

    const pending = loanRequests.filter(r => r.status === 'pending' && !r.aiDecision);
    if (pending.length === 0) return;

    let changed = false;
    const decided = [];

    pending.forEach(request => {
        const customer = aiDecisionEligibleCustomer(request);
        if (!customer) return; // no history to judge — leave for a human

        const hasOpenLoan = loans.some(l => l.customerId === customer.id && !l.isArchived && ['active', 'pending', 'overdue'].includes(getLoanComputedStatus(l).key));
        const risk = computeCustomerRiskScore(customer.id);
        const requestedInBase = convertCurrency(Number(request.amount) || 0, request.currency || 'USD', cfg.autoDecision.currency);
        const ceilingOk = requestedInBase <= cfg.autoDecision.maxAmount;

        let outcome = null; // 'approved' | 'rejected' | null (still pending)
        let reasonText = '';

        if (customer.isBlacklisted) {
            outcome = 'rejected'; reasonText = 'អតិថិជននេះស្ថិតក្នុងបញ្ជីខ្មៅ (Blacklisted)';
        } else if (risk.band === 'critical' || risk.band === 'high') {
            outcome = 'rejected'; reasonText = `ប្រវត្តិកម្ចីមុនមានហានិភ័យខ្ពស់ (${aiRiskBandLabel(risk.band)}, ពិន្ទុ ${risk.score})`;
        } else if (hasOpenLoan) {
            reasonText = 'អតិថិជននេះមានកម្ចីសកម្មរួចហើយ — ទុកឱ្យមន្ត្រីពិនិត្យដោយផ្ទាល់';
        } else if (!ceilingOk) {
            reasonText = `ចំនួនស្នើសុំលើសកម្រិតអនុម័តស្វ័យប្រវត្តិ (${fmtMoney(cfg.autoDecision.maxAmount, cfg.autoDecision.currency)})`;
        } else {
            outcome = 'approved'; reasonText = `ប្រវត្តិបង់ប្រាក់ល្អ (${aiRiskBandLabel(risk.band)}, ពិន្ទុ ${risk.score}) និងស្ថិតក្នុងកម្រិតកម្ចីតូច`;
        }

        request.aiDecision = { outcome: outcome || 'left_pending', score: risk.score, band: risk.band, reason: reasonText, decidedAt: new Date().toISOString() };
        if (outcome) {
            request.status = outcome;
            changed = true;
            decided.push({ request, outcome, reasonText });
        }
    });

    if (changed) {
        persistData(LS_KEYS.loanRequests, loanRequests);
        if (typeof renderLoanRequestsTable === 'function') renderLoanRequestsTable();
        decided.forEach(d => {
            const icon = d.outcome === 'approved' ? '🤖✅' : '🤖❌';
            const label = d.outcome === 'approved' ? 'អនុម័តដោយ AI' : 'បដិសេធដោយ AI';
            notifyTelegram(`${icon} <b>សំណើសុំកម្ចីត្រូវបាន${label}ស្វ័យប្រវត្តិ</b>\nឈ្មោះ: ${esc(d.request.name)}\nទូរស័ព្ទ: ${esc(d.request.phone)}\nមូលហេតុ: ${esc(d.reasonText)}`);
            createNotification(`ai-decision-${d.request.id}`, 'fa-robot', `AI បាន${label}សំណើរបស់ ${d.request.name}`, `javascript:goToLoanRequest('${d.request.id}')`);
        });
        renderNotifications();
    }
}

// ===================== ADVANCE PAYMENT REMINDERS =====================
function getUpcomingDueInstallments(daysAhead) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = addDays(today, daysAhead);
    const results = [];
    getAIVisibleLoans().forEach(loan => {
        const statusInfo = getLoanComputedStatus(loan);
        if (statusInfo.key !== 'active') return;
        aiSafeSchedule(loan).forEach(inst => {
            if (inst.status === 'paid') return;
            let dueDate;
            try { dueDate = parseDate(inst.date); } catch (e) { return; }
            if (dueDate >= today && dueDate <= horizon) {
                results.push({ loan, installment: inst });
            }
        });
    });
    return results;
}

// Fills the app's existing message-template placeholders so the digest reads
// the same way a per-customer reminder generated from the Loans tab would.
function aiFillReminderTemplate(loan, inst) {
    const cust = getCustomer(loan.customerId);
    const tpl = (appSettings.messageTemplates || []).find(t => t.id === 'tpl-reminder-1');
    const raw = tpl ? tpl.content : 'សូមជម្រាបជូនលោក/លោកស្រី [CustomerName], កម្ចី [LoanID] របស់អ្នកត្រូវបង់លើកទី [InstallmentNumber] នៅថ្ងៃទី [DueDate] ជាចំនួនទឹកប្រាក់ [RemainingAmount]។';
    return raw
        .replace('[CustomerName]', cust.name)
        .replace('[LoanID]', loan.loanId)
        .replace('[InstallmentNumber]', inst.index)
        .replace('[DueDate]', formatDateDMY(inst.date))
        .replace('[RemainingAmount]', fmtMoney(inst.remainingAmount, loan.currency));
}

function runAIPaymentReminders(force) {
    const cfg = getAIConfig();
    if (!cfg.reminders.enabled) return;
    if (!hasPermission('canManagePayments')) return;

    const todayStr = formatDateISO(new Date());
    if (!force && appSettings.aiLastReminderRunDate === todayStr) return; // already run today by someone

    const upcoming = getUpcomingDueInstallments(cfg.reminders.daysAhead);
    upcoming.forEach(({ loan, installment }) => {
        createNotification(
            `remind-${loan.loanId}-${installment.index}-${todayStr}`,
            'fa-bell',
            `កម្ចី ${loan.loanId} (${esc(getCustomer(loan.customerId).name)}) ត្រូវបង់លើកទី ${installment.index} នៅថ្ងៃទី ${formatDateDMY(installment.date)}`,
            `javascript:goToLoan('${loan.loanId}')`,
            loan.loanId
        );
    });
    if (typeof renderNotifications === 'function') renderNotifications();

    if (upcoming.length > 0) {
        const lines = upcoming.slice(0, 20).map(({ loan, installment }) => `• ${aiFillReminderTemplate(loan, installment)}`);
        const more = upcoming.length > 20 ? `\n... និងកម្ចីមួយចំនួនទៀត (${upcoming.length - 20})` : '';
        notifyTelegram(`🔔 <b>ការរំលឹកបង់ប្រាក់ជាមុន (${cfg.reminders.daysAhead} ថ្ងៃខាងមុខ)</b>\n\n${lines.join('\n')}${more}`);
    }

    appSettings.aiLastReminderRunDate = todayStr;
    persistData(LS_KEYS.appSettings, appSettings);
}

// ===================== CHATBOT =====================

function getAIConfig() {
    const s = appSettings || {};
    return {
        apiKey: s.aiApiKey || '',
        model: s.aiModel || 'claude-sonnet-4-6',
        enabled: !!s.aiChatEnabled,
        autoDecision: {
            enabled: !!s.aiAutoDecisionEnabled,
            maxAmount: Number(s.aiAutoApproveMaxAmount) || 0,
            currency: s.aiAutoApproveCurrency || 'USD'
        },
        reminders: {
            enabled: !!s.aiReminderEnabled,
            daysAhead: Number(s.aiReminderDaysAhead) || 2
        }
    };
}

function saveAISettings(values) {
    Object.assign(appSettings, {
        aiApiKey: values.apiKey,
        aiModel: values.model,
        aiChatEnabled: values.chatEnabled,
        aiAutoDecisionEnabled: values.autoDecisionEnabled,
        aiAutoApproveMaxAmount: values.autoApproveMaxAmount,
        aiAutoApproveCurrency: values.autoApproveCurrency,
        aiReminderEnabled: values.reminderEnabled,
        aiReminderDaysAhead: values.reminderDaysAhead
    });
    persistData(LS_KEYS.appSettings, appSettings);
    showToast('ការកំណត់ AI ត្រូវបានរក្សាទុក', 'success');
}

// Condensed, permission-scoped snapshot of the portfolio for the model to
// reason over. Kept intentionally small (top risk loans + totals) rather
// than the full dataset, to keep requests fast/cheap and avoid sending more
// customer data than a question needs.
function buildAIContextSummary() {
    const visibleLoans = getAIVisibleLoans();
    const scored = visibleLoans.map(l => ({ loan: l, risk: computeLoanRiskScore(l) })).filter(x => x.risk);
    scored.sort((a, b) => b.risk.score - a.risk.score);

    const outstandingByCurrency = {};
    visibleLoans.forEach(l => {
        const remaining = aiSafeSchedule(l).reduce((s, i) => s + (i.remainingAmount || 0), 0);
        outstandingByCurrency[l.currency] = (outstandingByCurrency[l.currency] || 0) + remaining;
    });

    const overdueCount = visibleLoans.filter(l => getLoanComputedStatus(l).key === 'overdue').length;
    const watchlist = visibleLoans.map(computeUpcomingCollectionRisk).filter(Boolean);

    return {
        generatedAt: new Date().toISOString(),
        viewerRole: currentUser.role,
        totals: {
            totalVisibleLoans: visibleLoans.length,
            overdueLoans: overdueCount,
            totalCustomers: customers.length,
            outstandingByCurrency
        },
        topRiskLoans: scored.slice(0, 15).map(x => ({
            loanId: x.loan.loanId,
            customer: getCustomer(x.loan.customerId).name,
            officer: getOfficerFullName(x.loan.creditOfficer),
            amount: x.loan.loanAmount,
            currency: x.loan.currency,
            status: getLoanComputedStatus(x.loan).text,
            riskScore: x.risk.score,
            riskBand: x.risk.band,
            reasons: x.risk.reasons
        })),
        predictedLateSoon: watchlist.slice(0, 10).map(w => ({
            loanId: w.loan.loanId,
            customer: getCustomer(w.loan.customerId).name,
            daysUntilDue: w.daysUntilDue,
            likelihoodPercent: w.likelihood
        }))
    };
}

let __aiChatBubbleCounter = 0;
function aiAppendChatBubble(role, text, isPlaceholder) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return null;
    const id = 'aiBubble' + (++__aiChatBubbleCounter);
    const div = document.createElement('div');
    div.className = `ai-chat-bubble ai-chat-${role}`;
    div.id = id;
    div.innerHTML = isPlaceholder ? '<i class="fas fa-spinner fa-spin"></i>' : esc(text).replace(/\n/g, '<br>');
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return id;
}
function aiUpdateChatBubble(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = esc(text).replace(/\n/g, '<br>');
    const container = document.getElementById('aiChatMessages');
    if (container) container.scrollTop = container.scrollHeight;
}

async function sendAIChatMessage(question) {
    const cfg = getAIConfig();
    aiAppendChatBubble('user', question);

    if (!cfg.apiKey) {
        aiAppendChatBubble('system', hasPermission('canManageSystem')
            ? 'សូមកំណត់ Anthropic API Key ជាមុនសិន (ចុចរូប ⚙️ ខាងលើ)'
            : 'Chatbot មិនទាន់ត្រូវបានកំណត់រចនាសម្ព័ន្ធដោយអ្នកគ្រប់គ្រងទេ។');
        return;
    }

    const thinkingId = aiAppendChatBubble('assistant', '', true);
    const context = buildAIContextSummary();
    const systemPrompt = `អ្នកគឺជាជំនួយការវិភាគទិន្នន័យសម្រាប់ប្រព័ន្ធគ្រប់គ្រងកម្ចីមួយ។ ឆ្លើយសំណួរដោយផ្អែកលើទិន្នន័យ JSON ដែលបានផ្តល់ឱ្យខាងក្រោមតែប៉ុណ្ណោះ។ ប្រសិនបើទិន្នន័យមិនគ្រប់គ្រាន់ដើម្បីឆ្លើយសំណួរ សូមប្រាប់ត្រង់ៗ ជាជាងសន្មត។ ឆ្លើយខ្លី ច្បាស់លាស់ ជាភាសាខ្មែរ (លើកលែងតែអ្នកសួរជាភាសាផ្សេង)។\n\nទិន្នន័យ:\n${JSON.stringify(context)}`;

    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': cfg.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: cfg.model,
                max_tokens: 1024,
                system: systemPrompt,
                messages: [{ role: 'user', content: question }]
            })
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${errText}`.trim());
        }
        const data = await res.json();
        const textBlock = (data.content || []).find(b => b.type === 'text');
        aiUpdateChatBubble(thinkingId, textBlock ? textBlock.text : 'មិនអាចទទួលបានចម្លើយបានទេ។');
    } catch (e) {
        console.error('AI chat error:', e);
        aiUpdateChatBubble(thinkingId, `មានបញ្ហាក្នុងការទាក់ទង AI៖ ${e.message}`);
    }
}

// ===================== PANEL / UI WIRING =====================

function toggleAIPanel() {
    const panel = document.getElementById('aiPanel');
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    if (!isOpen) switchAIView('chat');
}

function switchAIView(view) {
    ['chat', 'risk', 'settings'].forEach(v => {
        const el = document.getElementById('ai' + v.charAt(0).toUpperCase() + v.slice(1) + 'View');
        if (el) el.style.display = v === view ? 'flex' : 'none';
        const btn = document.getElementById('aiTabBtn' + v.charAt(0).toUpperCase() + v.slice(1));
        if (btn) btn.classList.toggle('active', v === view);
    });
    if (view === 'risk') renderAIRiskOverview();
    if (view === 'settings') loadAISettingsForm();
}

function loadAISettingsForm() {
    const cfg = getAIConfig();
    const ids = {
        aiApiKeyInput: cfg.apiKey,
        aiModelSelect: cfg.model,
        aiAutoApproveMaxAmountInput: cfg.autoDecision.maxAmount || '',
        aiAutoApproveCurrencySelect: cfg.autoDecision.currency,
        aiReminderDaysAheadInput: cfg.reminders.daysAhead
    };
    Object.entries(ids).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
    const checks = {
        aiChatEnabledInput: cfg.enabled,
        aiAutoDecisionEnabledInput: cfg.autoDecision.enabled,
        aiReminderEnabledInput: cfg.reminders.enabled
    };
    Object.entries(checks).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.checked = val; });
}

function submitAISettings(e) {
    e.preventDefault();
    saveAISettings({
        apiKey: document.getElementById('aiApiKeyInput').value.trim(),
        model: document.getElementById('aiModelSelect').value,
        chatEnabled: document.getElementById('aiChatEnabledInput').checked,
        autoDecisionEnabled: document.getElementById('aiAutoDecisionEnabledInput').checked,
        autoApproveMaxAmount: Number(document.getElementById('aiAutoApproveMaxAmountInput').value) || 0,
        autoApproveCurrency: document.getElementById('aiAutoApproveCurrencySelect').value,
        reminderEnabled: document.getElementById('aiReminderEnabledInput').checked,
        reminderDaysAhead: Number(document.getElementById('aiReminderDaysAheadInput').value) || 2
    });
    // Re-run immediately so a newly-enabled feature doesn't wait for next reload.
    runAICreditDecisioning();
    runAIPaymentReminders(true);
}

function handleAIChatSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('aiChatInput');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    sendAIChatMessage(q);
}

// Called once from main.js's initApp(), after currentUser/appSettings are ready.
function initAIWidget() {
    const chatForm = document.getElementById('aiChatForm');
    if (chatForm) chatForm.addEventListener('submit', handleAIChatSubmit);
    const settingsForm = document.getElementById('aiSettingsForm');
    if (settingsForm) settingsForm.addEventListener('submit', submitAISettings);

    // Only admins/managers (canManageSystem) can see & edit the API key / auto-decision rules.
    const settingsTabBtn = document.getElementById('aiTabBtnSettings');
    if (settingsTabBtn) settingsTabBtn.style.display = hasPermission('canManageSystem') ? '' : 'none';

    // Best-effort automatic runs — safe no-ops if their toggles are off.
    try { runAICreditDecisioning(); } catch (e) { console.error('AI credit decisioning failed:', e); }
    try { runAIPaymentReminders(false); } catch (e) { console.error('AI reminder run failed:', e); }
}
