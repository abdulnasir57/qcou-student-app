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

const TODAY = new Date().toISOString().slice(0, 10);
const MULAQAT_OPTIONS = ['Alhamdulillah Mulaqat Done', '2nd Mulaqat Done', 'Planning to Meet this Week',
  'Frequent Regular Mulaqat', 'Not yet Planned', 'Went to Meet but bhai cancelled'];
const MULAQAT_DONE_SET = ['Alhamdulillah Mulaqat Done', '2nd Mulaqat Done', 'Frequent Regular Mulaqat'];
const FOLLOWUP_OPTIONS = ['Confirmed', 'Tentative', 'Leave', 'Pending'];
const mulaqatDone = s => (s.mulaqat || []).filter(m => m.details && (MULAQAT_DONE_SET.includes(m.details) || /done/i.test(m.details))).length;
// next upcoming class first (ascending), then recent past (descending); cap far-future clutter
function orderedWeeks(weeksList) {
  const all = weeksList || [];
  const h = new Date(); h.setDate(h.getDate() + 120);
  const cutoff = h.toISOString().slice(0, 10);
  const future = all.filter(w => w >= TODAY && w <= cutoff).sort((a, b) => a.localeCompare(b));
  const past = all.filter(w => w < TODAY).sort((a, b) => b.localeCompare(a));
  return [...future, ...past];
}

/* ---------- Themes ---------- */
const THEMES = [
  { id: '', label: 'Emerald (Green)', swatch: '#0f6b4f' },
  { id: 'royal', label: 'Royal Blue & Gold', swatch: '#1f3a6b' },
  { id: 'sepia', label: 'Parchment / Sepia', swatch: '#7a5a30' },
  { id: 'maroon', label: 'Maroon & Gold', swatch: '#7a2533' },
  { id: 'midnight', label: 'Midnight (Dark)', swatch: '#16211d' },
];
function currentTheme() { try { return localStorage.getItem('hub_theme') || ''; } catch (e) { return ''; } }
function applyTheme(id) {
  if (id) document.documentElement.dataset.theme = id; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('hub_theme', id); } catch (e) { /* ignore */ }
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', t.swatch);
  renderThemeMenu();
}
function renderThemeMenu() {
  const m = $('#themeMenu'); if (!m) return;
  const cur = currentTheme();
  m.innerHTML = THEMES.map(t => `<div class="theme-opt" data-theme-id="${t.id}">
    <span class="theme-swatch" style="background:${t.swatch}"></span><span>${esc(t.label)}</span>
    ${t.id === cur ? '<span class="chk">✓</span>' : ''}</div>`).join('');
  $$('[data-theme-id]', m).forEach(o => o.onclick = () => { applyTheme(o.dataset.themeId); m.classList.add('hidden'); });
}
function toggleThemeMenu() {
  const m = $('#themeMenu'); if (!m) return;
  if (m.classList.contains('hidden')) { renderThemeMenu(); m.classList.remove('hidden'); } else m.classList.add('hidden');
}

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
    for (const p of ['students.json', '../students.json']) {
      try { seed = (await (await fetch(p)).json()).students; if (seed.length) break; } catch (e) { /* try next */ }
    }
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

  async triggerSync() {
    if (!LIVE) return { data: { skipped: 'demo' } };
    return await sb.functions.invoke('sync');
  },

  async lastSync() {
    if (!LIVE) return null;
    const { data } = await sb.from('app_config').select('value').eq('key', 'last_synced_at').maybeSingle();
    return data ? data.value : null;
  },
};

/* ---- OneDrive instant sync (calls the Supabase edge function) ---- */
let _syncing = false, _dirty = false, _syncTimer = null;
function setSyncBtn(state) {
  const b = $('#syncBtn'); if (!b) return;
  b.classList.remove('syncing', 'synced', 'error');
  if (state === 'syncing') { b.classList.add('syncing'); b.textContent = '⏳ Syncing…'; b.disabled = true; }
  else if (state === 'synced') { b.classList.add('synced'); b.textContent = '✓ Synced'; b.disabled = false; setTimeout(() => setSyncBtn('idle'), 4000); }
  else if (state === 'error') { b.classList.add('error'); b.textContent = '⚠ Retry sync'; b.disabled = false; }
  else { b.textContent = '⟳ Sync'; b.disabled = false; }
}
async function runOneDriveSync() {
  if (!LIVE) return;
  if (_syncing) { _dirty = true; return; }
  _syncing = true; setSyncBtn('syncing');
  try {
    const { data, error } = await Data.triggerSync();
    if (error) throw error;
    if (data && data.skipped === 'busy') _dirty = true;   // a sync was already running server-side
    setSyncBtn('synced');
    setTimeout(updateSyncInfo, 1000);
  } catch (e) {
    setSyncBtn('error'); toast('OneDrive sync failed — will retry');
    _dirty = true;
  } finally {
    _syncing = false;
    if (_dirty) { _dirty = false; setTimeout(runOneDriveSync, 2000); }
  }
}
function scheduleSync() {          // debounce bursts of edits into one sync
  if (!LIVE) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(runOneDriveSync, 2500);
}

/* ---- Live updates: refresh the open app when the cloud data changes (e.g. Excel → app) ---- */
let _rtTimer = null;
function detailEditing() {            // don't clobber a section the user is editing
  const root = $('#detailView'); if (!root) return false;
  return $$('[data-savebar]', root).some(b => !b.classList.contains('hidden'));
}
function onRealtime(payload) {
  const row = payload && (payload.new || payload.eventType === 'DELETE' ? payload.old : null);
  const data = row && row.data; if (!data || !data.id) return;
  if (payload.eventType === 'DELETE') return;   // deletions are not used in this app
  BYID[data.id] = data;
  const i = STUDENTS.findIndex(s => s.id === data.id);
  if (i >= 0) STUDENTS[i] = data; else STUDENTS.push(data);
  clearTimeout(_rtTimer);
  _rtTimer = setTimeout(() => {
    if (view === 'roster') renderRoster();
    else if (view === 'dashboard') renderDashboard();
    else if (view === 'detail' && currentId && !detailEditing()) renderDetail();
    updateSyncInfo();
  }, 600);
}
function setupRealtime() {
  if (!LIVE || !sb) return;
  try {
    sb.channel('students-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, onRealtime)
      .subscribe();
  } catch (e) { /* realtime optional */ }
}
function relTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + ' min ago';
  if (sec < 86400) return Math.floor(sec / 3600) + ' hr ago';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
async function updateSyncInfo() {
  const el = $('#syncInfo'); if (!el || !LIVE) return;
  el.classList.remove('hidden');
  try { const t = await Data.lastSync(); el.textContent = '🔄 OneDrive last synced: ' + relTime(t); }
  catch (e) { el.textContent = '🔄 OneDrive sync active'; }
}

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
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'att') return (b.att_pct || 0) - (a.att_pct || 0);
    if (sort === 'nabawi') return ((b.nabawi && b.nabawi.cumulative) || 0) - ((a.nabawi && a.nabawi.cumulative) || 0);
    return (a.id || '').localeCompare(b.id || '');   // default: ID# (Excel order)
  });
  $('#rosterCount').textContent = `${list.length} of ${STUDENTS.length} students`;
  $('#roster').innerHTML = list.map(s => {
    const p = pct(s.att_pct);
    const drop = s.status === 'Drop-Out';
    return `<div class="scard" data-id="${esc(s.id)}">
      <div class="avatar">${esc(initials(s.name))}</div>
      <div class="sc-main">
        <div class="sc-name${drop ? ' drop' : ''}">${esc(s.name)}</div>
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
        <div class="dh-stat clickable" data-goto="attendance"><b class="${attClass(p)}">${p == null ? '–' : p + '%'}</b><span>Attendance</span></div>
        <div class="dh-stat clickable" data-goto="attendance"><b>${s.att_present || 0}/${s.att_total || 0}</b><span>Present</span></div>
        <div class="dh-stat clickable" data-goto="mulaqat"><b>${mulaqatDone(s)}</b><span>Mulaqats</span></div>
        <div class="dh-stat clickable" data-goto="nabawi"><b>${s.nabawi && s.nabawi.cumulative != null ? Math.round(s.nabawi.cumulative * 10) / 10 : '–'}</b><span>Nabawi</span></div>
        <div class="dh-stat clickable" data-goto="seerat"><b>${pct(s.seerat && s.seerat.pct_overall) ?? '–'}${s.seerat && s.seerat.pct_overall != null ? '%' : ''}</b><span>Seerat</span></div>
      </div>
    </div>
    ${profileSection(s)}
    ${attendanceSection(s)}
    ${seeratSection(s)}
    ${nabawiSection(s)}
    ${followupSection(s)}
    ${weeklySection(s, 'audio', 'Audio Listening', ['Yes'])}
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
  const tel = v => (v ? 'tel:' + v : null);
  const hometown = [s.ht_city || s.ht_area, s.ht_state, s.ht_country].filter(Boolean).join(', ');
  const residence = [s.cr_city || s.cr_area, s.cr_province, s.cr_country].filter(Boolean).join(', ');
  const primary = [
    field('Mobile', s.mobile, { link: tel(s.mobile) }),
    field('Age', s.age),
    field('Profession', s.profession),
    field('Hometown', hometown),
    field('Residence', residence),
    field('Reference Name', s.ref_name),
    field('Reference Mobile', s.ref_mobile, { link: tel(s.ref_mobile) }),
  ].join('');
  const more = [
    field('WhatsApp', s.whatsapp, { link: tel(s.whatsapp) }),
    field('Email', s.email, { link: s.email ? 'mailto:' + s.email : null }),
    field('Date of Birth', s.dob), field('Qualification', s.qualification),
    field('Hometown Area', s.ht_area), field('District', s.ht_district),
    field('State', s.ht_state), field('Country', s.ht_country),
    field('Residence Area', s.cr_area), field('Province', s.cr_province), field('Residence Country', s.cr_country),
    field('Reference ID', s.ref_id), field('Reference Batch', s.ref_batch),
    field('Called By', s.called_by), field('Naqeeb', s.naqeeb),
    field('WhatsApp Group', s.wa_group), field('Remarks', s.remarks),
  ].join('');
  const statusOpts = ['Active', 'Drop-Out'].map(o => `<option ${s.status === o ? 'selected' : ''}>${o}</option>`).join('');
  const edit = `<div class="field"><label>Status</label><select data-pf="status">${statusOpts}</select></div>` +
    PROFILE_FIELDS.map(([k, l]) => `<div class="field"><label>${esc(l)}</label><input data-pf="${k}" value="${esc(s[k] ?? '')}" /></div>`).join('');
  const body = `
    <div class="view-mode">
      <div class="field-grid">${primary}</div>
      <button class="btn btn-ghost expand-btn" data-expand="profMore" style="margin-top:12px">More details ▾</button>
      <div id="profMore" class="hidden" style="margin-top:12px"><div class="field-grid">${more}</div></div>
    </div>
    <div class="field-grid edit-mode hidden">${edit}</div>`;
  return section('profile', '👤 Profile & Contact', body, true);
}

/* ---- Attendance (tap cells to cycle); newest first; last 5 + expand; past blanks = Holiday ---- */
function attCell(s, w) {
  const raw = (s.attendance || {})[w] || '';
  const past = w < TODAY;
  const shown = raw || (past ? 'H' : '');          // past blanks shown as Holiday
  const cls = raw || (past ? 'H hol' : 'empty');   // 'hol' = auto-holiday (not yet saved)
  return `<div class="att-cell ${cls}" data-week="${esc(w)}" data-mark="${esc(raw)}">${shown || '·'}<small>${fmtDate(w).slice(0, 6)}</small></div>`;
}
function attendanceSection(s) {
  const weeks = orderedWeeks(META.weeks, s.attendance);   // newest / upcoming first
  const first = weeks.slice(0, 5).map(w => attCell(s, w)).join('');
  const rest = weeks.slice(5).map(w => attCell(s, w)).join('');
  const legend = `<div class="att-legend">
    <span class="lg-P">Present</span><span class="lg-A">Absent</span>
    <span class="lg-L">Leave</span><span class="lg-H">Holiday</span><span class="lg-D">Drop</span>
    <span class="muted">· tap to change</span></div>`;
  const expand = rest
    ? `<button class="btn btn-ghost expand-btn" data-expand="attExtra" style="margin-top:10px">Show all ${weeks.length} weeks ▾</button>` : '';
  return section('attendance', `🗓️ Attendance · ${pct(s.att_pct) ?? '–'}%`,
    legend + `<div class="att-grid" id="attGrid">${first}<span class="extra-group hidden" id="attExtra">${rest}</span></div>${expand}`,
    false, true);
}

/* ---- Next-Class Follow-up (editable dropdowns; newest/upcoming first; last 6 + expand) ---- */
function followupSection(s) {
  const weeks = orderedWeeks(META.followup_weeks || [], s.followup);
  const row = w => {
    const v = (s.followup || {})[w] || '';
    const extra = v && !FOLLOWUP_OPTIONS.includes(v) ? `<option selected>${esc(v)}</option>` : '';
    const opts = `<option value="" ${v === '' ? 'selected' : ''}>—</option>${extra}` +
      FOLLOWUP_OPTIONS.map(o => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('');
    const upcoming = w >= TODAY;
    return `<div class="fu-row"><span class="fu-date${upcoming ? ' upcoming' : ''}">${esc(fmtDate(w))}</span>
      <select data-fu="${esc(w)}">${opts}</select></div>`;
  };
  const first = weeks.slice(0, 6).map(row).join('');
  const rest = weeks.slice(6).map(row).join('');
  const expand = rest
    ? `<button class="btn btn-ghost expand-btn" data-expand="fuExtra" style="margin-top:8px">Show all ${weeks.length} weeks ▾</button>` : '';
  const body = `<div class="muted" style="font-size:12px;margin-bottom:8px">Upcoming / latest first · set status &amp; Save</div>
    ${first || '<p class="empty-note">No follow-up weeks.</p>'}<div class="extra-group hidden" id="fuExtra">${rest}</div>${expand}`;
  return section('followup', '📞 Next-Class Follow-up', body, false, true);
}

/* ---- Seerat ---- */
function seeratSection(s) {
  if (!s.seerat) return '';
  const topics = META.seerat_topics || [];
  const row = t => {
    const st = s.seerat.topics[t] || '';
    const tag = st === 'Completed' ? '<span class="tag completed">Completed</span>'
      : st === 'In-Progress' ? '<span class="tag progress">In-Progress</span>' : '<span class="muted" style="font-size:11px">—</span>';
    const sel = `<select data-seerat="${esc(t)}"><option value="">—</option>
      <option ${st === 'In-Progress' ? 'selected' : ''}>In-Progress</option>
      <option ${st === 'Completed' ? 'selected' : ''}>Completed</option></select>`;
    return `<div class="prog-row"><span class="pr-label">${esc(t)}</span><span class="view-mode">${tag}</span><span class="edit-mode hidden" style="flex:1">${sel}</span></div>`;
  };
  let lastActive = -1;
  topics.forEach((t, i) => { if (s.seerat.topics[t]) lastActive = i; });
  const shown = topics.slice(0, lastActive + 1).map(row).join('');
  const rest = topics.slice(lastActive + 1).map(row).join('');
  const bars = `<div style="margin-bottom:12px">
    ${progBar('Makki', pct(s.seerat.pct_makki))}${progBar('Madani', pct(s.seerat.pct_madani))}${progBar('Overall', pct(s.seerat.pct_overall))}</div>`;
  const expand = rest
    ? `<button class="btn btn-ghost expand-btn" data-expand="seeratMore" style="margin-top:8px">View all ${topics.length} topics ▾</button>` : '';
  const body = bars + (shown || '') + `<div id="seeratMore" class="hidden">${rest}</div>` + expand;
  return section('seerat', '📖 Seerat Progress', body, true);
}
function progBar(label, p) {
  p = p ?? 0;
  return `<div class="prog-row"><span class="pr-label">${label}</span><div class="prog-bar"><i style="width:${p}%"></i></div><b style="min-width:38px;text-align:right">${p}%</b></div>`;
}

/* ---- Nabawi ---- */
const catAvg = arr => { const v = (arr || []).filter(x => x != null && x !== ''); return v.length ? v.reduce((a, b) => a + (+b), 0) / v.length : null; };
function nabawiSection(s) {
  if (!s.nabawi) return '';
  const crit = (META.nabawi_criteria && META.nabawi_criteria.length)
    ? META.nabawi_criteria
    : (META.nabawi_sections || []).map(n => ({ category: (n || '').replace(/^Score \d+: /, ''), questions: [] }));
  const q = s.nabawi.q || [];
  const cards = crit.map((c, i) => {
    const qvals = q[i] || [];
    const avg = catAvg(qvals.length ? qvals : [s.nabawi.scores ? s.nabawi.scores[i] : null]);
    const rows = (c.questions || []).map((qq, j) => {
      const val = qvals[j];
      return `<div class="nq-row">
        <span class="nq-text">${esc(qq)}</span>
        <span class="nq-score view-mode">${val == null || val === '' ? '–' : val}</span>
        <input class="nq-input edit-mode hidden" data-nq="${i}_${j}" type="number" min="0" max="10" step="1" value="${val ?? ''}" />
      </div>`;
    }).join('');
    return `<div class="nabawi-cat">
      <div class="nabawi-cat-head">
        <div class="nabawi-cat-title"><span class="nabawi-num">${i + 1}</span>${esc(c.category)}</div>
        <div class="nabawi-cat-score"><b>${avg == null ? '–' : Math.round(avg * 10) / 10}</b></div>
      </div>
      ${rows ? `<button class="btn btn-ghost expand-btn nabawi-qbtn" data-expand="nabq${i}">${c.questions.length} questions · score each ▾</button>
      <div id="nabq${i}" class="nabawi-q-wrap hidden">${rows}</div>` : ''}
    </div>`;
  }).join('');
  const head = `<div class="dh-stats" style="margin:0 0 14px">
    <div class="dh-stat"><b>${s.nabawi.cumulative != null ? Math.round(s.nabawi.cumulative * 10) / 10 : '–'}</b><span>Cumulative</span></div>
    <div class="dh-stat"><b>${pct(s.nabawi.percentile) ?? '–'}%</b><span>Percentile</span></div>
    <div class="dh-stat" style="flex:2"><b style="font-size:13px">${esc(s.nabawi.rating || '–')}</b><span>Rating</span></div></div>`;
  return section('nabawi', '۞ Nabawi Self-Assessment', head + cards, true);
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
  const items = (s.mulaqat || []).map((m, i) => ({ m, i })).filter(x => x.m.date || x.m.details);
  const list = items.length ? items.map(({ m, i }) =>
    `<div class="mulaqat-item">
       <span class="mu-date">${esc(fmtDate(m.date) || '—')}</span>
       <div style="flex:1">
         <div>${esc(m.details || '')}</div>
         ${m.note ? `<div class="mu-note view-mode">📝 ${esc(m.note)}</div>` : '<span class="view-mode"></span>'}
         <input class="mu-note-input edit-mode hidden" data-munote="${i}" placeholder="Private note (app only)" value="${esc(m.note || '')}" />
       </div>
     </div>`).join('')
    : `<p class="empty-note">No meetings logged yet.</p>`;
  const muOpts = MULAQAT_OPTIONS.map(o => `<option>${esc(o)}</option>`).join('');
  const adder = `<div class="edit-mode hidden" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
    <input type="date" id="muDate" style="flex:1;min-width:130px;padding:9px;border:1px solid var(--line);border-radius:8px" />
    <select id="muDetails" style="flex:2;min-width:180px;padding:9px;border:1px solid var(--line);border-radius:8px">
      <option value="">Select details…</option>${muOpts}</select>
    <button class="btn btn-ghost" id="muAdd">+ Add meeting</button></div>`;
  return section('mulaqat', `🤝 Physical Mulaqat · ${mulaqatDone(s)} done / ${items.length} logged`, list + adder, true, false, true);
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

  // clickable summary stats → jump to that section
  $$('[data-goto]', root).forEach(b => b.onclick = () => {
    const sec = $(`[data-section="${b.dataset.goto}"]`, root);
    if (sec) { const y = sec.getBoundingClientRect().top + window.scrollY - 56; window.scrollTo(0, y); }
  });

  // attendance cells cycle: empty→P→A→L→H→D→empty
  const order = ['', 'P', 'A', 'L', 'H', 'D'];
  $$('#attGrid .att-cell', root).forEach(c => c.onclick = () => {
    const cur = c.dataset.mark || '';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    c.dataset.mark = next;
    const past = c.dataset.week < TODAY;
    c.className = 'att-cell ' + (next || (past ? 'H hol' : 'empty'));
    c.firstChild.textContent = next || (past ? 'H' : '·');
    showSaveBar('attendance');
  });

  // follow-up dropdowns → reveal Save when changed
  $$('[data-fu]', root).forEach(sel => sel.onchange = () => showSaveBar('followup'));

  // expand/collapse "show all weeks" toggles
  $$('[data-expand]', root).forEach(b => {
    const collapsedLabel = b.textContent;
    b.onclick = () => {
      const grp = $('#' + b.dataset.expand, root);
      const nowHidden = grp.classList.toggle('hidden');
      b.textContent = nowHidden ? collapsedLabel : 'Show less';
    };
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
  // Nabawi: reveal all question rows when editing so each can be scored
  if (key === 'nabawi' && on) $$('.nabawi-q-wrap', sec).forEach(e => e.classList.remove('hidden'));
  // Seerat: reveal all topics when editing
  if (key === 'seerat' && on) { const m = $('#seeratMore', sec); if (m) m.classList.remove('hidden'); }
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
  } else if (key === 'mulaqat') {
    $$('[data-munote]', root).forEach(inp => {
      const i = +inp.dataset.munote;
      if (s.mulaqat && s.mulaqat[i]) s.mulaqat[i].note = inp.value.trim() || null;
    });
  } else if (key === 'followup') {
    s.followup = s.followup || {};
    $$('[data-fu]', root).forEach(sel => {
      const w = sel.dataset.fu;
      if (sel.value) s.followup[w] = sel.value; else delete s.followup[w];
    });
  } else if (key === 'seerat') {
    $$('[data-seerat]', root).forEach(sel => { s.seerat.topics[sel.dataset.seerat] = sel.value || undefined; });
    recomputeSeerat(s);
  } else if (key === 'nabawi') {
    const crit = META.nabawi_criteria || [];
    const q = crit.map((c, i) => (c.questions || []).map((_, j) => {
      const inp = $(`[data-nq="${i}_${j}"]`, root);
      return inp && inp.value !== '' ? Number(inp.value) : null;
    }));
    s.nabawi.q = q;
    s.nabawi.scores = q.map(arr => catAvg(arr));
    const valid = s.nabawi.scores.filter(v => v != null);
    s.nabawi.cumulative = valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    s.nabawi.percentile = s.nabawi.cumulative != null ? s.nabawi.cumulative / (crit.length * 10) : null;
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
    scheduleSync();   // push to OneDrive within seconds
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
  // needs attention: ACTIVE students only, 10 lowest attendance
  const low = active.filter(s => s.att_pct != null).sort((a, b) => a.att_pct - b.att_pct).slice(0, 10);
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
      <h3>⚠️ Needs Attention · 10 lowest attendance (active)</h3>
      ${low.length ? low.map(leadRow).join('') : '<p class="empty-note">No active students yet.</p>'}
    </div>
    <div class="dash-section">
      <h3>🏆 Attendance Leaderboard</h3>
      ${lead.slice(0, 12).map(leadRow).join('')}
    </div>`;
  $$('#dashboardView .lead-row').forEach(r => r.onclick = () => openDetail(r.dataset.id));
}

/* ============================ BULK NEXT-CLASS FOLLOW-UP ============================ */
let bulkWeek = null;
function upcomingFollowupWeeks() {
  return (META.followup_weeks || []).filter(w => w >= TODAY).sort((a, b) => a.localeCompare(b)).slice(0, 12);
}
function openBulkFollowup() {
  view = 'bulk';
  const ups = upcomingFollowupWeeks();
  bulkWeek = (bulkWeek && ups.includes(bulkWeek)) ? bulkWeek : (ups[0] || null);
  $('#app').classList.add('detail-open');
  $('#backBtn').classList.add('show');
  showView('bulk');
  renderBulk();
  window.scrollTo(0, 0);
}
function renderBulk() {
  const ups = upcomingFollowupWeeks();
  if (!bulkWeek) bulkWeek = ups[0];
  if (!bulkWeek) { $('#bulkView').innerHTML = '<p class="empty-note">No upcoming class dates.</p>'; return; }
  const weekOpts = ups.map(w => `<option value="${w}" ${w === bulkWeek ? 'selected' : ''}>${fmtDate(w)}</option>`).join('');
  const actives = STUDENTS.filter(s => s.status !== 'Drop-Out').sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const rows = actives.map(s => {
    const v = (s.followup || {})[bulkWeek] || '';
    const extra = v && !FOLLOWUP_OPTIONS.includes(v) ? `<option selected>${esc(v)}</option>` : '';
    const sel = `<select data-bfu="${esc(s.id)}"><option value="" ${v === '' ? 'selected' : ''}>—</option>${extra}` +
      FOLLOWUP_OPTIONS.map(o => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('') + `</select>`;
    return `<div class="bulk-row"><span class="bulk-name">${esc(s.name)}</span>${sel}</div>`;
  }).join('');
  $('#bulkView').innerHTML = `
    <div class="bulk-head">
      <h2>📞 Next-Class Follow-up</h2>
      <label class="muted" style="font-size:12px;display:block;margin-bottom:4px">Class date</label>
      <select id="bulkWeekSel">${weekOpts}</select>
      <div id="bulkCounts" class="bulk-counts"></div>
      <div class="muted" style="font-size:12px;margin-top:8px">Set each student's status, then Save all — it syncs to OneDrive.</div>
    </div>
    <div class="bulk-list">${rows}</div>
    <div class="save-bar" style="position:sticky;bottom:0;z-index:5">
      <button class="btn btn-primary" id="bulkSave">Save all</button>
      <button class="btn btn-ghost" id="bulkQuick">Set all Confirmed</button>
    </div>`;
  $('#bulkWeekSel').onchange = e => { bulkWeek = e.target.value; renderBulk(); };
  $('#bulkSave').onclick = saveBulk;
  $('#bulkQuick').onclick = () => { $$('#bulkView [data-bfu]').forEach(s => s.value = 'Confirmed'); updateBulkCounts(); };
  $$('#bulkView [data-bfu]').forEach(sel => sel.onchange = updateBulkCounts);
  updateBulkCounts();
}
// Completed = follow-up recorded (Confirmed/Tentative/Leave); Pending = "Pending" or not set
function updateBulkCounts() {
  const el = $('#bulkCounts'); if (!el) return;
  let done = 0, pending = 0, total = 0;
  $$('#bulkView [data-bfu]').forEach(sel => {
    total++;
    if (sel.value === 'Pending' || sel.value === '') pending++; else done++;
  });
  el.innerHTML = `<span class="bc-chip bc-done">✅ Completed: ${done}</span>
    <span class="bc-chip bc-pending">⏳ Pending: ${pending}</span>
    <span class="bc-chip bc-total">${total} active</span>`;
}
async function saveBulk() {
  const changed = [];
  $$('#bulkView [data-bfu]').forEach(sel => {
    const s = BYID[sel.dataset.bfu]; if (!s) return;
    const cur = (s.followup || {})[bulkWeek] || '';
    if (sel.value !== cur) {
      s.followup = s.followup || {};
      if (sel.value) s.followup[bulkWeek] = sel.value; else delete s.followup[bulkWeek];
      changed.push(s);
    }
  });
  if (!changed.length) { toast('No changes to save'); return; }
  toast('Saving ' + changed.length + '…');
  try {
    for (const s of changed) { await Data.save(s); BYID[s.id] = s; }
    toast(changed.length + ' student(s) updated ✓');
    scheduleSync();
    renderRoster();
  } catch (e) { toast('Save failed: ' + (e.message || e)); }
}

/* ============================ BULK CLASS ATTENDANCE ============================ */
const ATT_BULK_OPTIONS = [['P', 'Present'], ['A', 'Absent'], ['L', 'Leave'], ['H', 'Holiday']];
let attBulkWeek = null;
function attBulkWeeks() {
  const lo = new Date(); lo.setDate(lo.getDate() - 120);
  const hi = new Date(); hi.setDate(hi.getDate() + 7);
  const loS = lo.toISOString().slice(0, 10), hiS = hi.toISOString().slice(0, 10);
  return (META.weeks || []).filter(w => w >= loS && w <= hiS).sort((a, b) => b.localeCompare(a));
}
function openAttBulk() {
  view = 'attbulk';
  const ws = attBulkWeeks();
  if (!(attBulkWeek && ws.includes(attBulkWeek))) attBulkWeek = ws.find(w => w <= TODAY) || ws[0] || null;
  $('#app').classList.add('detail-open');
  $('#backBtn').classList.add('show');
  showView('attbulk');
  renderAttBulk();
  window.scrollTo(0, 0);
}
function renderAttBulk() {
  const ws = attBulkWeeks();
  if (!attBulkWeek) attBulkWeek = ws.find(w => w <= TODAY) || ws[0];
  if (!attBulkWeek) { $('#attBulkView').innerHTML = '<p class="empty-note">No class dates.</p>'; return; }
  const weekOpts = ws.map(w => `<option value="${w}" ${w === attBulkWeek ? 'selected' : ''}>${fmtDate(w)}${w === TODAY ? ' (today)' : ''}</option>`).join('');
  const actives = STUDENTS.filter(s => s.status !== 'Drop-Out').sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const rows = actives.map(s => {
    const v = (s.attendance || {})[attBulkWeek] || '';
    const extra = v && !ATT_BULK_OPTIONS.some(o => o[0] === v) ? `<option selected>${esc(v)}</option>` : '';
    const sel = `<select data-batt="${esc(s.id)}"><option value="" ${v === '' ? 'selected' : ''}>—</option>${extra}` +
      ATT_BULK_OPTIONS.map(([code, label]) => `<option value="${code}" ${v === code ? 'selected' : ''}>${label}</option>`).join('') + `</select>`;
    return `<div class="bulk-row"><span class="bulk-name">${esc(s.name)}</span>${sel}</div>`;
  }).join('');
  $('#attBulkView').innerHTML = `
    <div class="bulk-head">
      <h2>🗓️ Class Attendance</h2>
      <label class="muted" style="font-size:12px;display:block;margin-bottom:4px">Class date</label>
      <select id="attWeekSel">${weekOpts}</select>
      <div id="attCounts" class="bulk-counts"></div>
      <div class="muted" style="font-size:12px;margin-top:8px">Mark each student, then Save all — it syncs to OneDrive.</div>
    </div>
    <div class="bulk-list">${rows}</div>
    <div class="save-bar" style="position:sticky;bottom:0;z-index:5">
      <button class="btn btn-primary" id="attSave">Save all</button>
      <button class="btn btn-ghost" id="attQuick">Set all Present</button>
    </div>`;
  $('#attWeekSel').onchange = e => { attBulkWeek = e.target.value; renderAttBulk(); };
  $('#attSave').onclick = saveAttBulk;
  $('#attQuick').onclick = () => { $$('#attBulkView [data-batt]').forEach(s => s.value = 'P'); updateAttCounts(); };
  $$('#attBulkView [data-batt]').forEach(sel => sel.onchange = updateAttCounts);
  updateAttCounts();
}
function updateAttCounts() {
  const el = $('#attCounts'); if (!el) return;
  const c = { P: 0, A: 0, L: 0, H: 0, none: 0 };
  $$('#attBulkView [data-batt]').forEach(sel => {
    const v = sel.value;
    if (v === 'P') c.P++; else if (v === 'A') c.A++; else if (v === 'L') c.L++; else if (v === 'H') c.H++; else c.none++;
  });
  el.innerHTML = `<span class="bc-chip bc-present">Present: ${c.P}</span>
    <span class="bc-chip bc-absent">Absent: ${c.A}</span>
    <span class="bc-chip bc-leave">Leave: ${c.L}</span>
    ${c.H ? `<span class="bc-chip bc-holiday">Holiday: ${c.H}</span>` : ''}
    <span class="bc-chip bc-none">Not marked: ${c.none}</span>`;
}
async function saveAttBulk() {
  const changed = [];
  $$('#attBulkView [data-batt]').forEach(sel => {
    const s = BYID[sel.dataset.batt]; if (!s) return;
    const cur = (s.attendance || {})[attBulkWeek] || '';
    if (sel.value !== cur) {
      s.attendance = s.attendance || {};
      if (sel.value) s.attendance[attBulkWeek] = sel.value; else delete s.attendance[attBulkWeek];
      recomputeAttendance(s);
      changed.push(s);
    }
  });
  if (!changed.length) { toast('No changes to save'); return; }
  toast('Saving ' + changed.length + '…');
  try {
    for (const s of changed) { await Data.save(s); BYID[s.id] = s; }
    toast(changed.length + ' student(s) marked ✓');
    scheduleSync();
    renderRoster();
  } catch (e) { toast('Save failed: ' + (e.message || e)); }
}

/* ============================ NAV / BOOT ============================ */
function showView(v) {
  $('#rosterView').classList.toggle('hidden', v !== 'roster');
  $('#dashboardView').classList.toggle('hidden', v !== 'dashboard');
  $('#detailView').classList.toggle('hidden', v !== 'detail');
  $('#bulkView').classList.toggle('hidden', v !== 'bulk');
  $('#attBulkView').classList.toggle('hidden', v !== 'attbulk');
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
  const sBtn = $('#syncBtn'); if (sBtn) sBtn.onclick = () => runOneDriveSync();
  const bf = $('#bulkFuBtn'); if (bf) bf.onclick = () => openBulkFollowup();
  const ba = $('#bulkAttBtn'); if (ba) ba.onclick = () => openAttBulk();
  const tb = $('#themeBtn'); if (tb) tb.onclick = e => { e.stopPropagation(); toggleThemeMenu(); };
  document.addEventListener('click', e => { const m = $('#themeMenu'); if (m && !m.contains(e.target) && e.target.id !== 'themeBtn') m.classList.add('hidden'); });
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
  $('#syncBtn').classList.toggle('hidden', !LIVE);
  wireShell();
  const students = await Data.loadStudents();
  populateData(students);
  goTab('roster');
  updateSyncInfo();
  setupRealtime();
}

async function boot() {
  applyTheme(currentTheme());
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
