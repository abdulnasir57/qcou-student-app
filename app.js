/* QCOU-B02 Student Manager
 * One codebase, two modes:
 *   - DEMO  : no config.js → reads students.json, saves edits to this device (localStorage)
 *   - LIVE  : config.js sets SUPABASE_URL + SUPABASE_ANON_KEY → cloud database + login, syncs everywhere
 */
'use strict';

const LIVE = !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let sb = null;          // supabase client (live mode)
let META = {};          // weeks, topics, sections
let STUDENTS = [];       // array of records
let BYID = {};           // id -> record
let view = 'roster';
let currentId = null;

/* ============================ DATA LAYER ============================ */
const Data = {
  async init() {
    if (LIVE) sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  },
  async requireAuth() {
    if (!LIVE) return true;
    const { data } = await sb.auth.getSession();
    return !!data.session;
  },
  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async signOut() { if (LIVE) await sb.auth.signOut(); },

  async loadMeta() {
    // meta.json holds only non-sensitive structure (weeks, topics, sections) — safe to ship publicly
    const r = await fetch('meta.json');
    META = await r.json();
  },

  async loadStudents() {
    await this.loadMeta();
    if (LIVE) {
      const { data, error } = await sb.from('students').select('id,data').order('id');
      if (error) throw error;
      return (data || []).map(r => r.data);
    }
    // demo mode: load the full data file (kept at project root, not deployed) + local edits
    let seed = [];
    try { seed = (await (await fetch('../students.json')).json()).students; } catch (e) { seed = []; }
    const edits = JSON.parse(localStorage.getItem('qcou_edits') || '{}');
    return seed.map(s => edits[s.id] ? { ...s, ...edits[s.id] } : s);
  },

  async save(rec) {
    rec.updated_at = new Date().toISOString();
    if (LIVE) {
      const { error } = await sb.from('students').upsert({ id: rec.id, data: rec });
      if (error) throw error;
    } else {
      const edits = JSON.parse(localStorage.getItem('qcou_edits') || '{}');
      edits[rec.id] = rec;
      localStorage.setItem('qcou_edits', JSON.stringify(edits));
    }
  },
};

/* ============================ HELPERS ============================ */
const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = v => (v == null || v === '' ? null : Math.round(v * 100));
const attClass = p => p == null ? '' : p >= 75 ? 'att-good' : p >= 50 ? 'att-mid' : 'att-low';
const fmtDate = d => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); };

function recomputeAttendance(rec) {
  let P = 0, A = 0, L = 0;
  for (const m of Object.values(rec.attendance || {})) {
    if (m === 'P') P++; else if (m === 'A') A++; else if (m === 'L') L++;
  }
  const total = P + A + L;
  rec.att_present = P; rec.att_absent = A; rec.att_leave = L; rec.att_total = total;
  rec.att_pct = total ? P / total : null;
}
function recomputeSeerat(rec) {
  if (!rec.seerat) return;
  const topics = META.seerat_topics || [];
  const done = topics.filter(t => rec.seerat.topics[t] === 'Completed').length;
  rec.seerat.pct_overall = topics.length ? done / topics.length : null;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ============================ ROSTER ============================ */
function renderRoster() {
  const q = $('#search').value.trim().toLowerCase();
  const sf = $('#statusFilter').value;
  const sort = $('#sortBy').value;
  let list = STUDENTS.filter(s => {
    if (sf && s.status !== sf) return false;
    if (!q) return true;
    return [s.name, s.id, s.ht_city, s.cr_city, s.profession, s.mobile, s.naqeeb]
      .some(v => v && String(v).toLowerCase().includes(q));
  });
  list.sort((a, b) => {
    if (sort === 'att') return (b.att_pct || 0) - (a.att_pct || 0);
    if (sort === 'nabawi') return ((b.nabawi && b.nabawi.cumulative) || 0) - ((a.nabawi && a.nabawi.cumulative) || 0);
    return (a.name || '').localeCompare(b.name || '');
  });
  $('#rosterCount').textContent = `${list.length} of ${STUDENTS.length} students`;
  $('#roster').innerHTML = list.map(s => {
    const p = pct(s.att_pct);
    const drop = s.status === 'Drop-Out';
    return `<div class="scard" data-id="${esc(s.id)}">
      <div class="avatar">${esc(initials(s.name))}</div>
      <div class="sc-main">
        <div class="sc-name">${esc(s.name)}</div>
        <div class="sc-sub">${esc(s.cr_city || s.ht_city || '')}${s.profession ? ' · ' + esc(s.profession) : ''}</div>
        <span class="pill ${drop ? 'drop' : 'active'}">${esc(s.status || '—')}</span>
      </div>
      <div class="sc-att">
        <b class="att-num ${attClass(p)}">${p == null ? '–' : p + '%'}</b>
        <div class="muted" style="font-size:11px">attend.</div>
      </div>
    </div>`;
  }).join('') || `<p class="empty-note">No students match.</p>`;
  $$('#roster .scard').forEach(c => c.onclick = () => openDetail(c.dataset.id));
}

/* ============================ DETAIL ============================ */
function openDetail(id) {
  currentId = id; view = 'detail';
  $('#app').classList.add('detail-open');
  $('#backBtn').classList.add('show');
  showView('detail');
  renderDetail();
  window.scrollTo(0, 0);
}

function field(label, value, opts = {}) {
  const v = value == null || value === '' ? '<span class="val empty">—</span>'
    : `<span class="val">${opts.link ? `<a href="${opts.link}">${esc(value)}</a>` : esc(value)}</span>`;
  return `<div class="field"><label>${esc(label)}</label>${v}</div>`;
}

function renderDetail() {
  const s = BYID[currentId];
  if (!s) return;
  const p = pct(s.att_pct);
  const el = $('#detailView');
  el.innerHTML = `
    <div class="detail-head">
      <div class="dh-top">
        <div class="avatar">${esc(initials(s.name))}</div>
        <div>
          <h2>${esc(s.name)}</h2>
          <div class="dh-id">${esc(s.id)}</div>
          <span class="pill ${s.status === 'Drop-Out' ? 'drop' : 'active'}">${esc(s.status || '—')}</span>
        </div>
      </div>
      <div class="dh-stats">
        <div class="dh-stat"><b class="${attClass(p)}">${p == null ? '–' : p + '%'}</b><span>Attendance</span></div>
        <div class="dh-stat"><b>${s.att_present || 0}/${s.att_total || 0}</b><span>Present</span></div>
        <div class="dh-stat"><b>${s.nabawi && s.nabawi.cumulative != null ? Math.round(s.nabawi.cumulative * 10) / 10 : '–'}</b><span>Nabawi</span></div>
        <div class="dh-stat"><b>${pct(s.seerat && s.seerat.pct_overall) ?? '–'}${s.seerat && s.seerat.pct_overall != null ? '%' : ''}</b><span>Seerat</span></div>
      </div>
    </div>
    ${profileSection(s)}
    ${attendanceSection(s)}
    ${seeratSection(s)}
    ${nabawiSection(s)}
    ${weeklySection(s, 'audio', 'Audio Listening', ['Yes'])}
    ${weeklySection(s, 'followup', 'Next-Class Follow-up', ['Confirmed', 'Tentative', 'Leave', 'Pending'])}
    ${mulaqatSection(s)}
    ${namazSection(s)}
  `;
  wireDetail(s);
}

/* ---- Profile (editable) ---- */
const PROFILE_FIELDS = [
  ['mobile', 'Mobile'], ['whatsapp', 'WhatsApp'], ['email', 'Email'],
  ['age', 'Age'], ['dob', 'Date of Birth'], ['qualification', 'Qualification'], ['profession', 'Profession'],
  ['ht_area', 'Hometown Area'], ['ht_city', 'Hometown City'], ['ht_district', 'District'], ['ht_state', 'State'], ['ht_country', 'Country'],
  ['cr_area', 'Residence Area'], ['cr_city', 'Residence City'], ['cr_province', 'Province'], ['cr_country', 'Residence Country'],
  ['ref_name', 'Reference Name'], ['ref_mobile', 'Reference Mobile'], ['ref_id', 'Reference ID'], ['ref_batch', 'Reference Batch'],
  ['called_by', 'Called By'], ['naqeeb', 'Naqeeb'], ['wa_group', 'WhatsApp Group'], ['remarks', 'Remarks'],
];
function profileSection(s) {
  const view = PROFILE_FIELDS.map(([k, l]) => {
    let link = null;
    if (k === 'mobile' || k === 'whatsapp' || k === 'ref_mobile') link = s[k] ? 'tel:' + s[k] : null;
    if (k === 'email') link = s[k] ? 'mailto:' + s[k] : null;
    return field(l, s[k], { link });
  }).join('');
  const statusOpts = ['Active', 'Drop-Out'].map(o => `<option ${s.status === o ? 'selected' : ''}>${o}</option>`).join('');
  const edit = `<div class="field"><label>Status</label><select data-pf="status">${statusOpts}</select></div>` +
    PROFILE_FIELDS.map(([k, l]) => `<div class="field"><label>${esc(l)}</label><input data-pf="${k}" value="${esc(s[k] ?? '')}" /></div>`).join('');
  return section('profile', '👤 Profile & Contact',
    `<div class="field-grid view-mode">${view}</div><div class="field-grid edit-mode hidden">${edit}</div>`,
    true);
}

/* ---- Attendance (tap cells to cycle) ---- */
function visibleWeeks(s, extraMap) {
  // show weeks up to ~2 weeks ahead of today, plus any week that already has data
  const horizon = new Date(); horizon.setDate(horizon.getDate() + 14);
  const cutoff = horizon.toISOString().slice(0, 10);
  const marked = new Set([...Object.keys(s.attendance || {}), ...Object.keys(extraMap || {})]);
  return (META.weeks || []).filter(w => w <= cutoff || marked.has(w));
}
function attendanceSection(s) {
  const weeks = visibleWeeks(s);
  const cells = weeks.map(w => {
    const m = (s.attendance || {})[w] || '';
    return `<div class="att-cell ${m || 'empty'}" data-week="${esc(w)}" data-mark="${esc(m)}">${m || '·'}<small>${fmtDate(w).slice(0, 6)}</small></div>`;
  }).join('');
  const legend = `<div class="att-legend">
    <span class="lg-P">Present</span><span class="lg-A">Absent</span>
    <span class="lg-L">Leave</span><span class="lg-D">Drop</span>
    <span class="muted">· tap a week to change</span></div>`;
  return section('attendance', `🗓️ Attendance · ${pct(s.att_pct) ?? '–'}%`,
    legend + `<div class="att-grid" id="attGrid">${cells}</div>`, false, true);
}

/* ---- Seerat ---- */
function seeratSection(s) {
  if (!s.seerat) return '';
  const topics = META.seerat_topics || [];
  const rows = topics.map(t => {
    const st = s.seerat.topics[t] || '';
    const tag = st === 'Completed' ? '<span class="tag completed">Completed</span>'
      : st === 'In-Progress' ? '<span class="tag progress">In-Progress</span>' : '<span class="muted" style="font-size:11px">—</span>';
    const sel = `<select data-seerat="${esc(t)}"><option value="">—</option>
      <option ${st === 'In-Progress' ? 'selected' : ''}>In-Progress</option>
      <option ${st === 'Completed' ? 'selected' : ''}>Completed</option></select>`;
    return `<div class="prog-row"><span class="pr-label">${esc(t)}</span><span class="view-mode">${tag}</span><span class="edit-mode hidden" style="flex:1">${sel}</span></div>`;
  }).join('');
  const bars = `<div style="margin-bottom:12px">
    ${progBar('Makki', pct(s.seerat.pct_makki))}${progBar('Madani', pct(s.seerat.pct_madani))}${progBar('Overall', pct(s.seerat.pct_overall))}</div>`;
  return section('seerat', '📖 Seerat Progress', bars + rows, true);
}
function progBar(label, p) {
  p = p ?? 0;
  return `<div class="prog-row"><span class="pr-label">${label}</span><div class="prog-bar"><i style="width:${p}%"></i></div><b style="min-width:38px;text-align:right">${p}%</b></div>`;
}

/* ---- Nabawi ---- */
function nabawiSection(s) {
  if (!s.nabawi) return '';
  const secs = META.nabawi_sections || [];
  const cells = secs.map((name, i) => {
    const v = s.nabawi.scores[i];
    return `<div class="score-cell">
      <b class="view-mode">${v == null ? '–' : Math.round(v * 10) / 10}</b>
      <input class="edit-mode hidden" data-nabawi="${i}" type="number" step="0.1" min="0" max="10" value="${v ?? ''}" style="text-align:center;font-size:18px;font-weight:700" />
      <span>${esc((name || ('Score ' + (i + 1))).replace(/^Score \d+: /, '').slice(0, 38))}</span></div>`;
  }).join('');
  const head = `<div class="dh-stats" style="margin:0 0 12px">
    <div class="dh-stat"><b>${s.nabawi.cumulative != null ? Math.round(s.nabawi.cumulative * 10) / 10 : '–'}</b><span>Cumulative</span></div>
    <div class="dh-stat"><b>${pct(s.nabawi.percentile) ?? '–'}%</b><span>Percentile</span></div>
    <div class="dh-stat" style="flex:2"><b style="font-size:13px">${esc(s.nabawi.rating || '–')}</b><span>Rating</span></div></div>`;
  return section('nabawi', '۞ Nabawi Self-Assessment', head + `<div class="score-grid">${cells}</div>`, true);
}

/* ---- Weekly trackers (audio / followup) ---- */
function weeklySection(s, key, title, marks) {
  const map = s[key] || {};
  const entries = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  const recent = entries.slice(-16).reverse();
  const count = entries.length;
  const body = count
    ? `<div class="muted" style="font-size:12px;margin-bottom:8px">${count} week(s) logged · most recent first</div>
       <div class="att-grid">${recent.map(([w, v]) =>
        `<div class="att-cell ${marks[0] === 'Yes' ? 'P' : 'L'}">${esc(String(v).slice(0, 4))}<small>${fmtDate(w).slice(0, 6)}</small></div>`).join('')}</div>`
    : `<p class="empty-note">No ${title.toLowerCase()} logged yet.</p>`;
  return section(key, `${key === 'audio' ? '🎧' : '📞'} ${title}`, body);
}

/* ---- Mulaqat ---- */
function mulaqatSection(s) {
  const items = (s.mulaqat || []).filter(m => m.date || m.details);
  const list = items.length ? items.map((m, i) =>
    `<div class="mulaqat-item"><span class="mu-date">${esc(fmtDate(m.date) || '—')}</span><span style="flex:1">${esc(m.details || '')}</span></div>`).join('')
    : `<p class="empty-note">No meetings logged yet.</p>`;
  const adder = `<div class="edit-mode hidden" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
    <input type="date" id="muDate" style="flex:1;min-width:130px;padding:9px;border:1px solid var(--line);border-radius:8px" />
    <input type="text" id="muDetails" placeholder="Details" style="flex:2;min-width:160px;padding:9px;border:1px solid var(--line);border-radius:8px" />
    <button class="btn btn-ghost" id="muAdd">+ Add meeting</button></div>`;
  return section('mulaqat', '🤝 Physical Mulaqat', list + adder, true, false, true);
}

/* ---- Namaz ---- */
function namazSection(s) {
  const n = s.namaz || { booklet: null, translation: null };
  const toggle = (k, label) => {
    const yes = n[k] === 'Yes';
    return `<div class="field"><label>${label}</label>
      <button class="btn ${yes ? 'toggle-yes' : 'toggle-no'}" data-namaz="${k}">${yes ? '✓ Yes' : 'Not yet'}</button></div>`;
  };
  return section('namaz', '🕌 Namaz Translation',
    `<div class="field-grid">${toggle('booklet', 'Booklet Handover')}${toggle('translation', 'Namaz Translation')}</div>`,
    false, false, false, true);
}

/* generic section wrapper. flags: editable(profile-style toggle), attEdit, muEdit, namazLive */
function section(key, title, body, editable, attEdit, muEdit, namazLive) {
  const act = editable || muEdit ? `<span class="sec-act" data-edit="${key}">Edit</span>` : '';
  const saveBar = (editable || attEdit || muEdit)
    ? `<div class="save-bar hidden" data-savebar="${key}">
        <button class="btn btn-primary" data-save="${key}">Save</button>
        <button class="btn btn-ghost" data-cancel="${key}">Cancel</button></div>` : '';
  return `<div class="section" data-section="${key}">
    <h3>${title}${act}</h3><div class="sec-body">${body}</div>${saveBar}</div>`;
}

/* ============================ DETAIL WIRING ============================ */
function wireDetail(s) {
  const root = $('#detailView');

  // edit toggles (profile, seerat, nabawi, mulaqat)
  $$('[data-edit]', root).forEach(b => b.onclick = () => toggleEdit(b.dataset.edit, true));
  $$('[data-cancel]', root).forEach(b => b.onclick = () => renderDetail());

  // attendance cells cycle: empty→P→A→L→D→empty
  const order = ['', 'P', 'A', 'L', 'D'];
  $$('#attGrid .att-cell', root).forEach(c => c.onclick = () => {
    const cur = c.dataset.mark || '';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    c.dataset.mark = next;
    c.className = 'att-cell ' + (next || 'empty');
    c.firstChild.textContent = next || '·';
    showSaveBar('attendance');
  });

  // saves
  $$('[data-save]', root).forEach(b => b.onclick = () => saveSection(b.dataset.save, s));

  // mulaqat add
  const muAdd = $('#muAdd', root);
  if (muAdd) muAdd.onclick = () => {
    const d = $('#muDate').value, det = $('#muDetails').value.trim();
    if (!d && !det) return;
    s.mulaqat = s.mulaqat || []; s.mulaqat.push({ date: d || null, details: det || null });
    persist(s, 'Meeting added');
  };

  // namaz toggles save immediately
  $$('[data-namaz]', root).forEach(b => b.onclick = () => {
    s.namaz = s.namaz || {}; s.namaz[b.dataset.namaz] = s.namaz[b.dataset.namaz] === 'Yes' ? null : 'Yes';
    persist(s, 'Saved');
  });
}

function toggleEdit(key, on) {
  const sec = $(`[data-section="${key}"]`);
  $$('.view-mode', sec).forEach(e => e.classList.toggle('hidden', on));
  $$('.edit-mode', sec).forEach(e => e.classList.toggle('hidden', !on));
  const act = $('.sec-act', sec); if (act) act.classList.toggle('hidden', on);
  showSaveBar(key, on);
}
function showSaveBar(key, on = true) {
  const bar = $(`[data-savebar="${key}"]`); if (bar) bar.classList.toggle('hidden', !on);
}

async function saveSection(key, s) {
  const root = $('#detailView');
  if (key === 'profile') {
    $$('[data-pf]', root).forEach(inp => {
      const k = inp.dataset.pf; let v = inp.value.trim();
      s[k] = v === '' ? null : (k === 'age' ? Number(v) || v : v);
    });
  } else if (key === 'attendance') {
    const att = {};
    $$('#attGrid .att-cell', root).forEach(c => { if (c.dataset.mark) att[c.dataset.week] = c.dataset.mark; });
    s.attendance = att; recomputeAttendance(s);
  } else if (key === 'seerat') {
    $$('[data-seerat]', root).forEach(sel => { s.seerat.topics[sel.dataset.seerat] = sel.value || undefined; });
    recomputeSeerat(s);
  } else if (key === 'nabawi') {
    $$('[data-nabawi]', root).forEach(inp => { const i = +inp.dataset.nabawi; s.nabawi.scores[i] = inp.value === '' ? null : Number(inp.value); });
    const valid = s.nabawi.scores.filter(v => v != null);
    s.nabawi.cumulative = valid.length ? valid.reduce((a, b) => a + b, 0) : null;
  }
  await persist(s, 'Saved');
}

async function persist(s, msg) {
  try {
    await Data.save(s);
    BYID[s.id] = s;
    toast(msg || 'Saved ✓');
    renderDetail();
    renderRoster();
  } catch (e) {
    toast('Save failed: ' + (e.message || e));
  }
}

/* ============================ DASHBOARD ============================ */
function renderDashboard() {
  const active = STUDENTS.filter(s => s.status === 'Active');
  const drop = STUDENTS.filter(s => s.status === 'Drop-Out');
  const withAtt = STUDENTS.filter(s => s.att_pct != null);
  const avg = withAtt.length ? Math.round(withAtt.reduce((a, s) => a + s.att_pct, 0) / withAtt.length * 100) : 0;
  const low = [...withAtt].filter(s => s.att_pct < 0.5).sort((a, b) => a.att_pct - b.att_pct);
  const namazDone = STUDENTS.filter(s => s.namaz && s.namaz.translation === 'Yes').length;
  const lead = [...withAtt].sort((a, b) => b.att_pct - a.att_pct);

  const stat = (big, lbl) => `<div class="stat-card"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`;
  const leadRow = (s, i) => {
    const p = pct(s.att_pct);
    const color = p >= 75 ? 'var(--present)' : p >= 50 ? 'var(--leave)' : 'var(--absent)';
    return `<div class="lead-row" data-id="${esc(s.id)}"><span class="rank">${i + 1}</span>
      <span class="ln">${esc(s.name)}</span>
      <div class="lead-bar"><i style="width:${p}%;background:${color}"></i></div>
      <b style="min-width:40px;text-align:right;color:${color}">${p}%</b></div>`;
  };

  $('#dashboardView').innerHTML = `
    <div class="stat-grid">
      ${stat(STUDENTS.length, 'Total Students')}
      ${stat(active.length, 'Active')}
      ${stat(drop.length, 'Drop-Out')}
      ${stat(avg + '%', 'Avg Attendance')}
      ${stat(namazDone, 'Namaz Translation Done')}
      ${stat(low.length, 'Below 50% Attendance')}
    </div>
    <div class="dash-section">
      <h3>⚠️ Needs Attention · lowest attendance</h3>
      ${low.length ? low.slice(0, 10).map(leadRow).join('') : '<p class="empty-note">Everyone above 50% 🎉</p>'}
    </div>
    <div class="dash-section">
      <h3>🏆 Attendance Leaderboard</h3>
      ${lead.slice(0, 12).map(leadRow).join('')}
    </div>`;
  $$('#dashboardView .lead-row').forEach(r => r.onclick = () => openDetail(r.dataset.id));
}

/* ============================ NAV / BOOT ============================ */
function showView(v) {
  $('#rosterView').classList.toggle('hidden', v !== 'roster');
  $('#dashboardView').classList.toggle('hidden', v !== 'dashboard');
  $('#detailView').classList.toggle('hidden', v !== 'detail');
}
function goTab(v) {
  view = v; currentId = null;
  $('#app').classList.remove('detail-open');
  $('#backBtn').classList.remove('show');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  showView(v);
  if (v === 'roster') renderRoster(); else renderDashboard();
}

function wireShell() {
  $$('.tab').forEach(t => t.onclick = () => goTab(t.dataset.view));
  $('#backBtn').onclick = () => goTab('roster');
  $('#search').oninput = renderRoster;
  $('#statusFilter').onchange = renderRoster;
  $('#sortBy').onchange = renderRoster;
  $('#signOutBtn').onclick = async () => { await Data.signOut(); location.reload(); };
}

function populateData(students) {
  STUDENTS = students;
  BYID = {}; STUDENTS.forEach(s => BYID[s.id] = s);
  // status filter options
  const statuses = [...new Set(STUDENTS.map(s => s.status).filter(Boolean))];
  $('#statusFilter').innerHTML = '<option value="">All statuses</option>' +
    statuses.map(s => `<option>${esc(s)}</option>`).join('');
  $('#brandTitle').textContent = "Halqa Hub";
  $('#brandSub').textContent = (META.batch || '') + ' · ' + STUDENTS.length + ' students';
}

async function startApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#modeBadge').textContent = LIVE ? 'live' : 'demo';
  $('#modeBadge').classList.toggle('live', LIVE);
  $('#signOutBtn').classList.toggle('hidden', !LIVE);
  wireShell();
  const students = await Data.loadStudents();
  populateData(students);
  goTab('roster');
}

async function boot() {
  await Data.init();
  if (LIVE && !(await Data.requireAuth())) {
    $('#login').classList.remove('hidden');
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      $('#loginError').textContent = '';
      try {
        await Data.signIn($('#email').value, $('#password').value);
        await startApp();
      } catch (err) { $('#loginError').textContent = err.message || 'Sign-in failed'; }
    };
    return;
  }
  await startApp();
}

boot();
