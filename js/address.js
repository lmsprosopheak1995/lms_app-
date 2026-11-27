// =====================================================================
// address.js — Cascading Cambodian address dropdowns (ខេត្ត → ស្រុក/ខណ្ឌ → ឃុំ/សង្កាត់ → ភូមិ)
// Data: cambodia_addresses.json (NCDD gazetteer). Saved values are plain Khmer names (text),
// so the existing customer fields (province/district/commune/village) keep working everywhere.
// =====================================================================
const ADDR_IDS = { p: 'custProvince', d: 'custDistrict', c: 'custCommune', v: 'custVillage' };
const ADDR_PH = '-- ជ្រើសរើស --';
let ADDR_DATA = null;
let ADDR_PROMISE = null;

function loadAddressData() {
    if (!ADDR_PROMISE) {
        ADDR_PROMISE = fetch('cambodia_addresses.json')
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(d => { ADDR_DATA = d; return d; })
            .catch(e => { console.error('Address data failed to load:', e); ADDR_PROMISE = null; return null; });
    }
    return ADDR_PROMISE;
}

// Compare names ignoring leading type words (ខេត្ត, ស្រុក, ឃុំ ...) and spaces.
function addrNorm(s) {
    return String(s || '').replace(/^\s*(ខេត្ត|រាជធានី|ស្រុក|ខណ្ឌ|ក្រុង|ឃុំ|សង្កាត់|ភូមិ)\s*/, '').replace(/\s+/g, '');
}
function addrProvName(p) { return p.k.replace(/^(ខេត្ត|រាជធានី)\s*/, ''); }

function addrFill(id, items, selectedText) {
    const sel = document.getElementById(id);
    if (!sel || sel.tagName !== 'SELECT') return;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = ADDR_PH;
    sel.appendChild(ph);
    let matched = false;
    items.forEach((it, i) => {
        const o = document.createElement('option');
        o.value = it.value; o.textContent = it.label; o.dataset.i = i;
        sel.appendChild(o);
        if (selectedText && !matched && addrNorm(it.value) === addrNorm(selectedText)) { sel.value = it.value; matched = true; }
    });
    // Old customer whose typed text is not in the official list: keep it so nothing is lost.
    if (selectedText && !matched) {
        const o = document.createElement('option');
        o.value = selectedText; o.textContent = selectedText + ' (ចាស់)'; o.dataset.legacy = '1';
        sel.appendChild(o);
        sel.value = selectedText;
    }
    sel.disabled = items.length === 0 && !selectedText;
}

function addrIdx(id) {
    const sel = document.getElementById(id);
    const o = sel && sel.selectedOptions && sel.selectedOptions[0];
    return o && o.dataset.i !== undefined ? parseInt(o.dataset.i, 10) : -1;
}

function addrLists(level, pi, di, ci) {
    if (!ADDR_DATA) return [];
    const p = ADDR_DATA[pi];
    if (level === 'p') return ADDR_DATA.map(x => ({ value: addrProvName(x), label: addrProvName(x) }));
    if (!p) return [];
    if (level === 'd') return p.d.map(x => ({ value: x.k, label: x.k }));
    const d = p.d[di];
    if (!d) return [];
    if (level === 'c') return d.m.map(x => ({ value: x.k, label: x.k }));
    const c = d.m[ci];
    if (!c) return [];
    return c.v.map(x => ({ value: x[1], label: x[1] }));
}

function resetAddressSelects() {
    if (!ADDR_DATA) return;
    addrFill(ADDR_IDS.p, addrLists('p'), '');
    addrFill(ADDR_IDS.d, [], ''); addrFill(ADDR_IDS.c, [], ''); addrFill(ADDR_IDS.v, [], '');
}

function onAddrChange(level) {
    const pi = addrIdx(ADDR_IDS.p), di = addrIdx(ADDR_IDS.d), ci = addrIdx(ADDR_IDS.c);
    if (level === 'p') { addrFill(ADDR_IDS.d, addrLists('d', pi), ''); addrFill(ADDR_IDS.c, [], ''); addrFill(ADDR_IDS.v, [], ''); }
    if (level === 'd') { addrFill(ADDR_IDS.c, addrLists('c', pi, di), ''); addrFill(ADDR_IDS.v, [], ''); }
    if (level === 'c') { addrFill(ADDR_IDS.v, addrLists('v', pi, di, ci), ''); }
}

// Used when editing a customer: select saved values, keeping unmatched old text as "(ចាស់)".
async function setCustomerAddress(cust) {
    await loadAddressData();
    if (!ADDR_DATA) { addrDegradeToInputs(); }
    const vals = { p: cust.province || '', d: cust.district || '', c: cust.commune || '', v: cust.village || '' };
    if (!ADDR_DATA) { for (const k in vals) { const el = document.getElementById(ADDR_IDS[k]); if (el) el.value = vals[k]; } return; }
    addrFill(ADDR_IDS.p, addrLists('p'), vals.p);
    addrFill(ADDR_IDS.d, addrLists('d', addrIdx(ADDR_IDS.p)), vals.d);
    addrFill(ADDR_IDS.c, addrLists('c', addrIdx(ADDR_IDS.p), addrIdx(ADDR_IDS.d)), vals.c);
    addrFill(ADDR_IDS.v, addrLists('v', addrIdx(ADDR_IDS.p), addrIdx(ADDR_IDS.d), addrIdx(ADDR_IDS.c)), vals.v);
}

// If the JSON can't be loaded, fall back to the old free-text boxes so the form still works.
function addrDegradeToInputs() {
    Object.values(ADDR_IDS).forEach(id => {
        const el = document.getElementById(id);
        if (el && el.tagName === 'SELECT') {
            const inp = document.createElement('input');
            inp.id = id; el.replaceWith(inp);
        }
    });
}

async function initAddressSelects() {
    await loadAddressData();
    if (!ADDR_DATA) { addrDegradeToInputs(); return; }
    resetAddressSelects();
    ['p', 'd', 'c'].forEach(l => {
        const el = document.getElementById(ADDR_IDS[l]);
        if (el) el.addEventListener('change', () => onAddrChange(l));
    });
}

document.addEventListener('DOMContentLoaded', initAddressSelects);

