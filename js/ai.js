// =====================================================================
// ai.js — AI features for the Loan Management System:
//   1) Credit risk scoring: a deterministic, rule-based engine that scores
//      every active loan (0-100) from its own payment history plus the
//      customer's history with other loans. No external API needed.
//   2) Data chatbot: lets a user ask natural-language questions about the
//      portfolio (their own visible loans, respecting existing role
//      permissions) and answers them using the Anthropic Messages API.
//
// SECURITY NOTE: the chatbot calls the Anthropic API directly from the
// browser using an API key entered in the "AI Settings" tab (stored in the
// shared app_settings row, same mechanism as the exchange rate / message
// templates). That means the key is present in this browser's network
// requests and, once loaded via loadAllCloudData(), in this app's shared
// settings cache. That's an acceptable trade-off for a small internal
// admin tool but is NOT the recommended pattern for a public product —
// for stronger security later, move the fetch() call below into a
// Supabase Edge Function that holds the key server-side and proxies the
// request, and call that function from here instead.
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

// Returns { score, band, reasons, loan } or null when the loan isn't in a
// risk-relevant status (e.g. already fully paid).
function computeLoanRiskScore(loan) {
    const statusInfo = getLoanComputedStatus(loan);
    if (AI_RISK_EXCLUDED_STATUSES.includes(statusInfo.key)) return null;

    if (statusInfo.key === 'written_off') {
        return { score: 100, band: 'critical', reasons: ['កម្ចីនេះត្រូវបានកត់ត្រាថាជាបំណុលមិនអាចសងបាន (Written off)'], loan };
    }

    let schedule = [];
    try { schedule = buildSchedule(loan) || []; } catch (e) { schedule = []; }
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
    if (!container) return;
    const scored = getAIVisibleLoans().map(computeLoanRiskScore).filter(Boolean);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter(r => r.score > 0).slice(0, 25);

    if (top.length === 0) {
        container.innerHTML = '<p class="ai-empty">មិនមានកម្ចីដែលមានហានិភ័យគួរឱ្យកត់សម្គាល់ទេ</p>';
        return;
    }

    container.innerHTML = top.map(r => {
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
    }).join('');
}

// ===================== CHATBOT =====================

function getAIConfig() {
    return {
        apiKey: (appSettings && appSettings.aiApiKey) || '',
        model: (appSettings && appSettings.aiModel) || 'claude-sonnet-4-6',
        enabled: !!(appSettings && appSettings.aiChatEnabled)
    };
}

function saveAISettings(apiKey, model, enabled) {
    appSettings.aiApiKey = apiKey;
    appSettings.aiModel = model;
    appSettings.aiChatEnabled = enabled;
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
        let sched = [];
        try { sched = buildSchedule(l) || []; } catch (e) {}
        const remaining = sched.reduce((s, i) => s + (i.remainingAmount || 0), 0);
        outstandingByCurrency[l.currency] = (outstandingByCurrency[l.currency] || 0) + remaining;
    });

    const overdueCount = visibleLoans.filter(l => getLoanComputedStatus(l).key === 'overdue').length;

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
    if (!isOpen) {
        switchAIView('chat');
    }
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
    const keyInput = document.getElementById('aiApiKeyInput');
    const modelSelect = document.getElementById('aiModelSelect');
    const enabledInput = document.getElementById('aiChatEnabledInput');
    if (keyInput) keyInput.value = cfg.apiKey;
    if (modelSelect) modelSelect.value = cfg.model;
    if (enabledInput) enabledInput.checked = cfg.enabled;
}

function submitAISettings(e) {
    e.preventDefault();
    const apiKey = document.getElementById('aiApiKeyInput').value.trim();
    const model = document.getElementById('aiModelSelect').value;
    const enabled = document.getElementById('aiChatEnabledInput').checked;
    saveAISettings(apiKey, model, enabled);
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

    // Only admins/managers (canManageSystem) can see & edit the API key.
    const settingsTabBtn = document.getElementById('aiTabBtnSettings');
    if (settingsTabBtn) settingsTabBtn.style.display = hasPermission('canManageSystem') ? '' : 'none';
}
