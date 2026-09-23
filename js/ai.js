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
//      scoped snapshot of the portfolio, via the Google Gemini API
//      (generateContent).
//
// SECURITY NOTE: the chatbot calls a Supabase Edge Function
// (`ai-chat`, see supabase/functions/ai-chat/index.ts) rather than the
// Gemini API directly. The Gemini key lives only in that function's
// server-side secrets (set via `supabase secrets set GEMINI_API_KEY=...`)
// and is never sent to or stored in the browser. The Edge Function checks
// the caller's Supabase auth session before it will spend that key, so only
// logged-in users of this app can use the chatbot.
//
// IMPORTANT — SERVER-SIDE CHANGE STILL NEEDED: this file only controls what
// the browser sends/expects. `supabase/functions/ai-chat/index.ts` isn't
// part of this file set, so it still needs to be updated by hand to (a)
// forward requests to Google's endpoint instead of Anthropic's, e.g.
// `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=GEMINI_API_KEY`,
// (b) send the body through mostly as-is (it's now already in Gemini's
// `{ contents, systemInstruction, tools, generationConfig }` shape — see
// sendAIChatMessage below), and (c) return Gemini's raw JSON response
// (`{ candidates: [...] }`) back to the browser unmodified. Until that
// function is updated, the chatbot will keep failing/erroring even though
// the client code below is already speaking Gemini's format.
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
// Conversation memory: kept in-memory only (not persisted/synced — resets on page
// reload or when the user explicitly starts a new conversation via resetAIChat()).
// Each entry is { role: 'user'|'model', content: string } — Gemini calls the
// assistant turn "model" rather than "assistant" — sent back to the Gemini
// generateContent API on every turn so the model has the prior turns of THIS
// conversation to work from. Capped to the most recent N messages so a very long
// back-and-forth doesn't grow the request without bound.
let __aiChatHistory = [];
const AI_CHAT_HISTORY_MAX_MESSAGES = 20;

// ===================== AI ACCOUNT LOCK/UNLOCK TOOL =====================
// Lets the chatbot itself freeze (lock/suspend) or unfreeze (unlock/reactivate) a specific
// staff account when an admin or manager explicitly asks in plain language, e.g. "ផ្អាកគណនី
// dara" / "unlock sophea's account". This is only ever offered to the model (see the `tools`
// array built in sendAIChatMessage) when hasPermission('canManageAccountStatus') is true, and
// permission is checked again inside aiHandleSetAccountStatus before anything is written — the
// model choosing to call the tool is never itself authorization.
//
// DEPENDS ON THE EDGE FUNCTION: this assumes the `ai-chat` Supabase Edge Function forwards any
// extra fields in the request body (here: `tools`) straight through to the Gemini generateContent
// API call, the same way it already forwards contents/systemInstruction — the same server-side
// change needs `functionCall` parts in the Gemini response to survive the round trip back to
// the browser unmodified. That function's source isn't part of this file set, so double-check
// it against supabase/functions/ai-chat/index.ts before relying on this in production.
// Gemini's `tools` shape is `[{ functionDeclarations: [ {name, description, parameters} ] }]`
// (Anthropic's flat `{name, description, input_schema}` list doesn't apply here anymore).
const AI_TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'set_account_status',
                description: "Freeze (lock/suspend) or unfreeze (unlock/reactivate) a staff user's login account. Only call this when the admin/manager explicitly asks to lock, suspend, freeze, unlock, unfreeze, or reactivate a SPECIFIC named account — never as a guess or side effect of answering something else. If it's unclear which account they mean, ask them to clarify instead of calling this tool.",
                parameters: {
                    type: 'object',
                    properties: {
                        user_query: { type: 'string', description: 'The username or full name of the account, exactly as the person referred to it (Khmer or Latin script).' },
                        action: { type: 'string', enum: ['freeze', 'unfreeze'], description: "'freeze' to lock/suspend the account so it can no longer log in; 'unfreeze' to unlock/reactivate it." }
                    },
                    required: ['user_query', 'action']
                }
            }
        ]
    }
];

// Best-effort match of a free-text name/username against the user roster: exact match first
// (username or full name, case-insensitive), falling back to a substring match. Returns an
// array so the caller can tell "not found" (empty) apart from "ambiguous" (2+) and ask for
// clarification instead of silently acting on the wrong account.
function aiResolveUserByQuery(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const users = getUsers();
    const exact = users.filter(u => u.username.toLowerCase() === q || (u.fullName || '').toLowerCase() === q);
    if (exact.length) return exact;
    return users.filter(u => u.username.toLowerCase().includes(q) || (u.fullName || '').toLowerCase().includes(q));
}

// Executes (after human confirmation) the set_account_status tool call and returns a plain-text
// result the model reads on its next turn to phrase a reply. Never throws — every failure path
// (permission, not found, ambiguous, cancelled, or a Supabase error) returns a describing string
// instead, so a single bad tool call can't break the chat turn.
async function aiHandleSetAccountStatus(input) {
    if (!hasPermission('canManageAccountStatus')) {
        return 'បដិសេធ៖ អ្នកប្រើប្រាស់នេះគ្មានសិទ្ធិផ្អាក/ដោះសោគណនីទេ។';
    }
    const action = input && input.action === 'freeze' ? 'freeze' : (input && input.action === 'unfreeze' ? 'unfreeze' : null);
    if (!action) return 'សកម្មភាពមិនត្រឹមត្រូវ (ត្រូវតែជា freeze ឬ unfreeze)។';

    const matches = aiResolveUserByQuery(input && input.user_query);
    if (matches.length === 0) return `រកមិនឃើញអ្នកប្រើប្រាស់ដែលត្រូវនឹង "${input && input.user_query}" ទេ។ សូមផ្តល់ឈ្មោះអ្នកប្រើ (username) ត្រឹមត្រូវ។`;
    if (matches.length > 1) {
        const names = matches.map(u => `${u.fullName} (${u.username})`).join(', ');
        return `មានអ្នកប្រើប្រាស់ច្រើននាក់ត្រូវនឹង "${input.user_query}": ${names}។ សូមបញ្ជាក់ជា username ច្បាស់លាស់។`;
    }

    const user = matches[0];
    if (currentUser && user.username === currentUser.username) {
        return 'មិនអាចប្រើ AI ដើម្បីផ្អាក/ដោះសោគណនីផ្ទាល់ខ្លួនបានទេ។ សូមស្នើសុំអ្នកគ្រប់គ្រងផ្សេងទៀត។';
    }
    if (!user.uid) {
        return `រកមិនឃើញ Supabase UID សម្រាប់ ${user.username}។ សូមបើក Users tab ម្តងដើម្បី Refresh រួចសាកល្បងម្តងទៀត។`;
    }

    const wantFreeze = action === 'freeze';
    if (!!user.isFrozen === wantFreeze) {
        return `គណនី ${user.fullName} (${user.username}) ${wantFreeze ? 'ត្រូវបានផ្អាករួចហើយ' : 'ជាគណនីសកម្មរួចហើយ'}។ គ្មានអ្វីត្រូវប្តូរទេ។`;
    }

    const confirmMsg = wantFreeze
        ? `តើអ្នកប្រាកដថាចង់ផ្អាក (Freeze) គណនី "${user.fullName}" (${user.username}) មែនទេ? អ្នកប្រើនេះនឹងមិនអាច login ចូលប្រព័ន្ធបានទៀតទេ រហូតដល់មានការដោះសោ។`
        : `តើអ្នកប្រាកដថាចង់ដោះសោ (Unfreeze) គណនី "${user.fullName}" (${user.username}) មែនទេ?`;
    const confirmed = await customConfirm(confirmMsg, 'បញ្ជាក់សកម្មភាព AI');
    if (!confirmed) {
        return `សកម្មភាពត្រូវបានលុបចោលដោយអ្នកប្រើប្រាស់។ គណនី ${user.username} មិនត្រូវបានប៉ះពាល់ទេ។`;
    }

    try {
        // Mirrors saveUser()'s un-freeze behavior in auth.js: clearing failed_attempts on
        // unfreeze prevents a single further mistyped password from re-freezing the account
        // immediately via the 3-strikes counter (see record_failed_login() in schema.sql).
        await upsertUserRoleProfile({
            uid: user.uid,
            is_frozen: wantFreeze,
            failed_attempts: wantFreeze ? undefined : 0
        });
        user.isFrozen = wantFreeze;
        setUsersCache(getUsers());
        if (document.getElementById('usersTableBody')) {
            try { await renderUsersTable(); } catch (e) { /* Users tab just isn't open/visible right now */ }
        }
        logChange(null, 'System Event', { event: wantFreeze ? 'Account Frozen (AI)' : 'Account Unfrozen (AI)', username: user.username, requestedBy: currentUser ? currentUser.username : null });
        notifyTelegram(`${wantFreeze ? '🔒' : '🔓'} <b>គណនីត្រូវបាន${wantFreeze ? 'ផ្អាក' : 'ដោះសោ'}ដោយ AI Assistant</b>\nគណនី: ${user.fullName} (${user.username})\nស្នើសុំដោយ: ${(currentUser && currentUser.fullName) || 'N/A'}`);
        showToast(`គណនី ${user.username} ត្រូវបាន${wantFreeze ? 'ផ្អាក' : 'ដោះសោ'}!`, 'success');
        return `ជោគជ័យ៖ គណនី ${user.fullName} (${user.username}) ត្រូវបាន${wantFreeze ? 'ផ្អាក' : 'ដោះសោ'}។`;
    } catch (e) {
        console.error('AI account status action failed:', e);
        return `បរាជ័យក្នុងការ${wantFreeze ? 'ផ្អាក' : 'ដោះសោ'}គណនី ${user.username}: ${String(e.message || e)}`;
    }
}

function getAIConfig() {
    const s = appSettings || {};
    return {
        model: s.aiModel || 'gemini-3.6-flash',
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

    if (!cfg.enabled) {
        aiAppendChatBubble('system', hasPermission('canManageSystem')
            ? 'សូមបើកដំណើរការ Chatbot ជាមុនសិន (ចុចរូប ⚙️ ខាងលើ)'
            : 'Chatbot មិនទាន់ត្រូវបានកំណត់រចនាសម្ព័ន្ធដោយអ្នកគ្រប់គ្រងទេ។');
        return;
    }

    const thinkingId = aiAppendChatBubble('assistant', '', true);
    const context = buildAIContextSummary();
    // Only admins/managers (canManageAccountStatus) are told about the account tool at all —
    // and only they get it included in the `tools` array below — so the model can't even
    // attempt this for an officer/viewer session.
    const canManageAccounts = hasPermission('canManageAccountStatus');
    const accountToolNote = canManageAccounts
        ? '\n\nអ្នកក៏អាចប្រើឧបករណ៍ set_account_status ដើម្បីផ្អាក (freeze/lock) ឬដោះសោ (unfreeze/unlock) គណនីអ្នកប្រើប្រាស់ជាក់លាក់មួយ តែនៅពេលអ្នកប្រើប្រាស់ស្នើសុំយ៉ាងច្បាស់ប៉ុណ្ណោះ (ឧ. "ផ្អាកគណនី dara", "unlock sophea\'s account")។ កុំទាយឈ្មោះគណនី បើមិនច្បាស់ថាមានន័យអ្នកណា សូមសួរឲ្យច្បាស់សិន។'
        : '';
    const systemPrompt = `អ្នកគឺជាជំនួយការវិភាគទិន្នន័យសម្រាប់ប្រព័ន្ធគ្រប់គ្រងកម្ចីមួយ។ ឆ្លើយសំណួរដោយផ្អែកលើទិន្នន័យ JSON ដែលបានផ្តល់ឱ្យខាងក្រោមតែប៉ុណ្ណោះ, ព្រមទាំងប្រវត្តិសន្ទនាខាងលើនេះ។ ប្រសិនបើទិន្នន័យមិនគ្រប់គ្រាន់ដើម្បីឆ្លើយសំណួរ សូមប្រាប់ត្រង់ៗ ជាជាងសន្មត។ ឆ្លើយខ្លី ច្បាស់លាស់ ជាភាសាខ្មែរ (លើកលែងតែអ្នកសួរជាភាសាផ្សេង)។${accountToolNote}\n\nទិន្នន័យ:\n${JSON.stringify(context)}`;

    // Add this question to the running conversation, then send the model the
    // recent history (trimmed) + this turn — not just the bare question — so
    // it can resolve follow-ups like "តើអ្នកនោះដែរឬទេ?" against earlier turns.
    // Each entry is already stored in Gemini's `contents` shape: { role, parts }.
    // Gemini also wants strictly alternating user/model turns: if the last turn
    // failed (see catch below), its unanswered 'user' entry is still the most
    // recent one — drop it first so we never send two 'user' turns in a row.
    if (__aiChatHistory.length && __aiChatHistory[__aiChatHistory.length - 1].role === 'user') {
        __aiChatHistory.pop();
    }
    __aiChatHistory.push({ role: 'user', parts: [{ text: question }] });
    if (__aiChatHistory.length > AI_CHAT_HISTORY_MAX_MESSAGES) {
        __aiChatHistory = __aiChatHistory.slice(__aiChatHistory.length - AI_CHAT_HISTORY_MAX_MESSAGES);
    }
    // Gemini also requires the conversation to START on a 'user' turn — the trim above can
    // land on a 'model'/'function' entry first (its matching 'user' got cut), so drop it too.
    if (__aiChatHistory.length && __aiChatHistory[0].role !== 'user') {
        __aiChatHistory.shift();
    }

    try {
        // Auth: reuse the same Supabase session used for all other cloud reads/writes
        // (see cloud-sync.js / db.js) — the Edge Function checks this token belongs to
        // a real logged-in user before it will spend the (server-side) Gemini key.
        const cloud = getCloudSettings();
        const session = await ensureSupabaseSession();
        if (!session || !session.access_token) {
            throw new Error('គ្មាន session សកម្មទេ សូម Login ម្តងទៀត');
        }

        const tools = canManageAccounts ? AI_TOOLS : undefined;
        let workingContents = __aiChatHistory.slice();
        let finalReplyText = null;
        // A tool call needs at least one more model turn to turn its result into a
        // human-readable reply (and could in principle chain into another tool call), so
        // this loops rather than assuming one request is enough — capped hard so a
        // misbehaving model can never turn one chat turn into unbounded API calls.
        for (let round = 0; round < 4; round++) {
            const res = await fetch(`${cloud.supabaseUrl}/functions/v1/ai-chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'apikey': cloud.supabaseKey
                },
                body: JSON.stringify({
                    model: cfg.model,
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: workingContents,
                    generationConfig: { maxOutputTokens: 1024 },
                    ...(tools ? { tools } : {})
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error((data && (data.error?.message || data.error)) || `HTTP ${res.status}`);
            }

            // Gemini's reply lives at candidates[0].content.parts — a mix of {text}
            // and/or {functionCall:{name,args}} parts (Anthropic's flat
            // content:[{type:'text'|'tool_use'}] array doesn't apply here anymore).
            const candidate = (data.candidates && data.candidates[0]) || null;
            const parts = (candidate && candidate.content && candidate.content.parts) || [];
            const functionCalls = parts.filter(p => p.functionCall);

            if (functionCalls.length === 0) {
                const textPart = parts.find(p => typeof p.text === 'string');
                finalReplyText = textPart ? textPart.text : 'មិនអាចទទួលបានចម្លើយបានទេ។';
                workingContents = [...workingContents, { role: 'model', parts: [{ text: finalReplyText }] }];
                break;
            }

            // Record the model's functionCall turn verbatim, run each requested tool locally
            // (permission-checked + human-confirmed inside aiHandleSetAccountStatus), then
            // feed the results back so the model can phrase a reply. Gemini's current API
            // rejects role 'function' for this turn (400 "Role 'function' is not
            // supported") — the function's result is sent back as a 'user' turn instead,
            // carrying a functionResponse part rather than a text part.
            workingContents = [...workingContents, { role: 'model', parts }];
            const responseParts = [];
            for (const p of functionCalls) {
                const fc = p.functionCall;
                const resultText = fc.name === 'set_account_status'
                    ? await aiHandleSetAccountStatus(fc.args || {})
                    : `Unknown tool: ${fc.name}`;
                responseParts.push({ functionResponse: { name: fc.name, response: { content: resultText } } });
            }
            workingContents = [...workingContents, { role: 'user', parts: responseParts }];
        }

        if (finalReplyText === null) finalReplyText = 'សុំទោស សំណើនេះស្មុគស្មាញពេក សូមសាកល្បងម្តងទៀត។';
        aiUpdateChatBubble(thinkingId, finalReplyText);
        // Only committed once we actually have a real final reply — a failed turn (below)
        // leaves the user's question in __aiChatHistory but adds no model half to it.
        __aiChatHistory = workingContents;
        if (__aiChatHistory.length > AI_CHAT_HISTORY_MAX_MESSAGES) {
            __aiChatHistory = __aiChatHistory.slice(__aiChatHistory.length - AI_CHAT_HISTORY_MAX_MESSAGES);
        }
    } catch (e) {
        console.error('AI chat error:', e);
        aiUpdateChatBubble(thinkingId, `មានបញ្ហាក្នុងការទាក់ទង AI៖ ${e.message}`);
    }
}

// Starts a fresh conversation: clears both the sent-to-model history and the
// visible bubbles, back to the same greeting shown on first load.
function resetAIChat() {
    __aiChatHistory = [];
    const container = document.getElementById('aiChatMessages');
    if (container) {
        container.innerHTML = '<div class="ai-chat-bubble ai-chat-system">សួស្តី! សួរខ្ញុំអំពីទិន្នន័យកម្ចី ការហួសកាលកំណត់ ឬហានិភ័យអតិថិជនរបស់អ្នកបាន។</div>';
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
