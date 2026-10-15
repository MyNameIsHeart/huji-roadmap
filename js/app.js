import { Planner, MAX_SLOTS, slotYear, slotSem, nextOffered, offeredAt, treeLeaves } from './model.js';
import { t, name, setLang, getLang } from './i18n.js';
import { hebrewYear } from './hebrew.js';

const DATA_BASE = './data/';
const STORAGE_KEY = 'huji-roadmap:v1';
const SHNATON = 'https://shnaton.huji.ac.il/course/';

const data = { index: null, courses: null, roadmaps: {} };
let state = defaultState();
let planner = null;
let result = null;
let sens = null;
let hovered = null;

function defaultState() {
  return {
    lang: 'he',
    roadmaps: [],
    startYear: null,
    maxPoints: 25,
    targetPoints: 134,
    done: [],
    pinned: {},
    chosen: [],
    collapsed: {},
    search: '',
  };
}

// ---------- persistence ----------

function encodeState() {
  const s = { ...state };
  delete s.collapsed; delete s.search;
  const json = JSON.stringify(s);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
}

function load() {
  const hash = location.hash.match(/^#s=(.+)$/);
  if (hash) {
    const s = decodeState(hash[1]);
    if (s) return { ...defaultState(), ...s };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return defaultState();
}

// ---------- data ----------

async function fetchJSON(path) {
  const r = await fetch(DATA_BASE + path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(path + ': ' + r.status);
  return r.json();
}

async function ensureRoadmaps(codes) {
  await Promise.all(codes.map(async (code) => {
    if (!data.roadmaps[code]) data.roadmaps[code] = await fetchJSON(`roadmaps/${code}.json`);
  }));
}

function availableRoadmaps() { return data.index.roadmaps; }

// ---------- planning ----------

function inputs() {
  return {
    done: new Set(state.done),
    pinned: new Map(Object.entries(state.pinned).map(([c, s]) => [c, Math.min(MAX_SLOTS - 1, Math.max(0, s | 0))])),
    chosen: new Set(state.chosen),
  };
}

function recompute() {
  const rms = state.roadmaps.filter(c => data.roadmaps[c]).map(c => data.roadmaps[c]);
  if (!rms.length) { planner = null; result = null; sens = null; return; }
  planner = new Planner(data.courses, rms, { maxPoints: state.maxPoints });
  const inp = inputs();
  result = planner.schedule(inp);
  sens = planner.sensitivity(inp, result);
}

function course(code) {
  return data.courses[code] || { code, name: { he: code, en: code }, points: 0, period: null, stub: true };
}

function donePoints() {
  return state.done.reduce((a, c) => a + (course(c).points || 0), 0);
}

// ---------- state mutations ----------

function update(fn) {
  fn();
  recompute();
  save();
  render();
}

function setDone(code, on) {
  update(() => {
    const set = new Set(state.done);
    if (on) { set.add(code); delete state.pinned[code]; state.chosen = state.chosen.filter(c => c !== code); }
    else set.delete(code);
    state.done = [...set];
  });
}

function pin(code, slot) {
  update(() => {
    state.done = state.done.filter(c => c !== code);
    state.pinned[code] = slot;
    if (!planner.required.has(code) && !state.chosen.includes(code)) state.chosen.push(code);
  });
}

function unpin(code) {
  update(() => { delete state.pinned[code]; });
}

function removeFromPlan(code) {
  update(() => {
    delete state.pinned[code];
    state.chosen = state.chosen.filter(c => c !== code);
    state.done = state.done.filter(c => c !== code);
  });
}

function addToPlan(code) {
  update(() => { if (!state.chosen.includes(code)) state.chosen.push(code); });
}

// ---------- labels ----------

function slotLabel(slot, short = false) {
  const y = slotYear(slot);
  const greg = (state.startYear || data.index.year) + y;
  const sem = slotSem(slot) === 0 ? t('semA') : t('semB');
  const yl = t('yearLabel')(y);
  const hy = getLang() === 'he' ? hebrewYear(greg) : String(greg);
  return short ? `${yl} · ${sem}` : `${yl} · ${sem} · ${hy}`;
}

function periodLabel(c) {
  const p = c.period;
  if (p == null) return '';
  return t('period')[p] || name(c.periodName);
}

function statusOf(code) {
  if (state.done.includes(code)) return 'done';
  if (!result || !result.plan.has(code)) return 'none';
  if (state.pinned[code] !== undefined) return 'pinned';
  const src = result.source.get(code);
  if (src === 'suggested') return 'suggested';
  if (src === 'implied') return 'implied';
  return 'auto';
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const ch of children.flat()) {
    if (ch === null || ch === undefined || ch === false) continue;
    e.append(ch.nodeType ? ch : document.createTextNode(String(ch)));
  }
  return e;
}

// ---------- rendering ----------

function render() {
  document.documentElement.lang = getLang();
  document.documentElement.dir = getLang() === 'he' ? 'rtl' : 'ltr';
  renderHeader();
  renderStats();
  renderCatalog();
  renderBoard();
  renderSensitivity();
  renderAbout();
  requestAnimationFrame(drawArrows);
}

function renderHeader() {
  document.getElementById('title').textContent = t('title');
  document.getElementById('subtitle').textContent = t('subtitle');
  const ctl = document.getElementById('controls');
  ctl.replaceChildren();

  const mkSelect = (idx, label) => {
    const sel = el('select', { 'aria-label': label });
    sel.append(el('option', { value: '', text: idx === 0 ? `— ${label} —` : t('none') }));
    const current = state.roadmaps[idx] || '';
    const other = state.roadmaps[1 - idx];
    const combos = other && data.roadmaps[other] ? new Set(data.roadmaps[other].combinations.map(c => c.code)) : new Set();
    for (const rm of availableRoadmaps()) {
      if (rm.code === other) continue;
      const opt = el('option', { value: rm.code, text: name(rm.name) + (combos.has(rm.code) ? ' ★' : '') });
      if (rm.code === current) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', async () => {
      const codes = state.roadmaps.slice();
      codes[idx] = sel.value;
      const clean = codes.filter(Boolean);
      await ensureRoadmaps(clean);
      update(() => { state.roadmaps = clean; });
    });
    return el('label', { class: 'ctl' }, el('span', { text: label }), sel);
  };
  ctl.append(mkSelect(0, t('track')));
  ctl.append(mkSelect(1, t('secondTrack')));

  const num = (key, label, min, max) => {
    const inp = el('input', { type: 'number', min, max, value: state[key] ?? '' });
    inp.addEventListener('change', () => update(() => { state[key] = Number(inp.value) || defaultState()[key] || data.index.year; }));
    return el('label', { class: 'ctl' }, el('span', { text: label }), inp);
  };
  if (state.startYear == null) state.startYear = data.index.year;
  ctl.append(num('startYear', t('startYear'), 2000, 2100));
  ctl.append(num('maxPoints', t('maxPoints'), 5, 60));
  ctl.append(num('targetPoints', t('targetPoints'), 10, 400));

  ctl.append(el('button', { class: 'btn', title: t('autoplanHint'), onclick: () => update(() => { state.pinned = {}; }) }, t('autoplan')));
  ctl.append(el('button', { class: 'btn', onclick: () => {
    if (confirm(t('clearConfirm'))) update(() => { state.done = []; state.pinned = {}; state.chosen = []; });
  } }, t('clearAll')));
  ctl.append(el('button', { class: 'btn', onclick: async () => {
    const url = location.origin + location.pathname + '#s=' + encodeState();
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); toast(t('copied')); } catch (e) { prompt(t('share'), url); }
  } }, t('share')));
  ctl.append(el('button', { class: 'btn ghost', onclick: () => update(() => {
    state.lang = getLang() === 'he' ? 'en' : 'he'; setLang(state.lang);
  }) }, t('lang')));
}

function toast(msg) {
  const tt = el('div', { class: 'toast', text: msg });
  document.body.append(tt);
  setTimeout(() => tt.remove(), 1800);
}

function renderStats() {
  const box = document.getElementById('stats');
  box.replaceChildren();
  if (!result) { box.append(el('div', { class: 'muted', text: t('noPlan') })); return; }
  const dp = donePoints();
  const planned = result.slots.reduce((a, s) => a + s.points, 0);
  const grad = planner.estimateGraduation(result, state.targetPoints, dp);
  const stat = (label, value, sub) => el('div', { class: 'stat' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null);
  box.append(stat(t('requiredEnd'), result.end >= 0 ? slotLabel(result.end) : '—', `${result.end + 1} ${t('semesters')}`));
  box.append(stat(t('estEnd'), grad >= 0 ? slotLabel(grad) : '—', `${state.targetPoints} ${t('pts')} · ${grad + 1} ${t('semesters')}`));
  box.append(stat(t('totalPlanned'), `${planned + dp} / ${state.targetPoints}`, `${dp} ${t('doneSoFar')}`));
  const hint = el('div', { class: 'hint', text: t('hoverHint') });
  box.append(hint);
  const legend = el('div', { class: 'legend' },
    el('span', { class: 'lg lg-pinned', text: t('legendPinned') }),
    el('span', { class: 'lg lg-auto', text: t('legendAuto') }),
    el('span', { class: 'lg lg-suggested', text: t('legendSuggested') }),
    el('span', { class: 'lg lg-critical', text: t('legendCritical') }),
    el('span', { class: 'lg lg-alt', text: t('legendAlt') }));
  box.append(legend);
}

function matchesSearch(c) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return c.code.includes(q) || (c.name.he || '').toLowerCase().includes(q) || (c.name.en || '').toLowerCase().includes(q);
}

function renderCatalog() {
  const box = document.getElementById('catalog');
  box.replaceChildren();
  box.append(el('h2', { text: t('catalog') }));
  const search = el('input', { type: 'search', placeholder: t('search'), value: state.search });
  search.addEventListener('input', () => { state.search = search.value; renderCatalog(); });
  box.append(search);
  if (!planner) return;

  for (const [gi, gp] of result.groupProgress.entries()) {
    const g = gp.group;
    const key = g.id;
    const rmTag = planner.roadmaps.length > 1 ? ` · ${name(g.roadmapName)}` : '';
    const years = g.years.map(y => t('yearLabel')(y - 1)).join(', ');
    const head = el('div', { class: `group-head kind-${g.kind}` },
      el('button', { class: 'collapse', text: state.collapsed[key] ? '▸' : '▾', onclick: () => { state.collapsed[key] = !state.collapsed[key]; save(); renderCatalog(); } }),
      el('span', { class: 'group-title', text: `${years} · ${t(g.kind)}${rmTag}` }),
      el('span', { class: 'group-meta', text: g.minPoints ? `${gp.donePts + gp.plannedPts} / ${g.minPoints} ${t('pts')}` : (g.maxPoints ? `${t('max')} ${g.maxPoints} ${t('pts')}` : '') }));
    if (g.minPoints) {
      const pct = Math.min(100, Math.round(100 * (gp.donePts + gp.plannedPts) / g.minPoints));
      head.append(el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${pct}%` })));
    }
    box.append(head);
    if (state.collapsed[key]) continue;
    if (name(g.note)) box.append(el('div', { class: 'group-note', text: name(g.note) }));
    const list = el('div', { class: 'group-list' });
    for (const code of g.courses) {
      const c = course(code);
      if (!matchesSearch(c)) continue;
      list.append(catalogRow(c, g));
    }
    box.append(list);
  }
}

function catalogRow(c, g) {
  const code = c.code;
  const st = statusOf(code);
  const row = el('div', { class: `row st-${st} ${c.offered === false ? 'not-taught' : ''}`, draggable: 'true', 'data-code': code });
  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', code); e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('mouseenter', () => setHover(code));
  row.addEventListener('mouseleave', () => setHover(null));
  const main = el('div', { class: 'row-main', onclick: () => openPopover(code) },
    el('span', { class: 'code', text: code }),
    el('span', { class: 'name', text: name(c.name) }),
    el('span', { class: 'chips' },
      el('span', { class: 'chip', text: `${c.points} ${t('pts')}` }),
      periodLabel(c) ? el('span', { class: 'chip', text: periodLabel(c) }) : null,
      g.mandatory ? el('span', { class: 'chip chip-req', text: t('mandatory') }) : null,
      st === 'done' ? el('span', { class: 'chip chip-done', text: '✓ ' + t('done') }) : null,
      (st !== 'done' && st !== 'none') ? el('span', { class: `chip chip-${st}`, text: slotLabel(result.plan.get(code), true) }) : null,
      c.offered === false ? el('span', { class: 'chip chip-warn', text: t('warn').not_taught }) : null));
  const actions = el('div', { class: 'row-actions' });
  actions.append(el('button', { class: 'icon', title: st === 'done' ? t('unmarkDone') : t('markDone'), onclick: () => setDone(code, st !== 'done') }, st === 'done' ? '↺' : '✓'));
  if (!g.mandatory && st !== 'done') {
    const inPlan = state.chosen.includes(code) || state.pinned[code] !== undefined;
    actions.append(el('button', { class: 'icon', title: inPlan ? t('removeFromPlan') : t('addToPlan'), onclick: () => inPlan ? removeFromPlan(code) : addToPlan(code) }, inPlan ? '−' : '+'));
  }
  row.append(main, actions);
  return row;
}

function renderBoard() {
  const cols = document.getElementById('columns');
  cols.replaceChildren();
  if (!result) return;

  // Completed column
  const doneCol = el('div', { class: 'column done-col', 'data-slot': 'done' },
    el('div', { class: 'col-head' }, el('div', { class: 'col-title', text: t('done') }), el('div', { class: 'col-sub', text: `${donePoints()} ${t('pts')}` })));
  const doneBody = el('div', { class: 'col-body' });
  if (!state.done.length) doneBody.append(el('div', { class: 'drop-hint', text: t('doneColumnHint') }));
  for (const code of state.done) doneBody.append(card(code, 'done'));
  doneCol.append(doneBody);
  dropTarget(doneCol, (code) => setDone(code, true));
  cols.append(doneCol);

  const last = Math.min(MAX_SLOTS - 1, Math.max(result.end + 1, 5));
  for (let s = 0; s <= last; s++) {
    const info = result.slots[s] || { slot: s, points: 0, codes: [], over: false };
    const col = el('div', { class: `column ${info.over ? 'over' : ''} ${slotSem(s) === 0 ? 'sem-a' : 'sem-b'}`, 'data-slot': s });
    col.append(el('div', { class: 'col-head' },
      el('div', { class: 'col-title', text: slotLabel(s, true) }),
      el('div', { class: 'col-sub', text: `${getLang() === 'he' ? hebrewYear((state.startYear || data.index.year) + slotYear(s)) : (state.startYear || data.index.year) + slotYear(s)} · ${info.points} / ${state.maxPoints} ${t('pts')}` })));
    const body = el('div', { class: 'col-body' });
    const codes = info.codes.slice().sort((a, b) => (planner.tail(b) - planner.tail(a)) || (course(b).points - course(a).points) || a.localeCompare(b));
    for (const code of codes) body.append(card(code, statusOf(code)));
    if (!codes.length) body.append(el('div', { class: 'drop-hint', text: t('dropHere') }));
    col.append(body);
    dropTarget(col, (code) => pin(code, s));
    cols.append(col);
  }
}

function dropTarget(node, onDrop) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drag-over'); });
  node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drag-over');
    const code = e.dataTransfer.getData('text/plain');
    if (code) onDrop(code);
  });
}

function card(code, st) {
  const c = course(code);
  const warns = result.warnings.get(code) || [];
  const sv = sens && sens.get(code);
  const critical = sv && sv.delay > 0;
  const node = el('div', { class: `card st-${st} ${critical ? 'critical' : ''} ${warns.length ? 'has-warn' : ''}`, draggable: 'true', 'data-code': code, tabindex: '0' });
  node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', code); e.dataTransfer.effectAllowed = 'move'; });
  node.addEventListener('mouseenter', () => setHover(code));
  node.addEventListener('mouseleave', () => setHover(null));
  node.addEventListener('click', () => openPopover(code));
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPopover(code); } });
  node.append(el('div', { class: 'card-name', text: name(c.name) }));
  const meta = el('div', { class: 'card-meta' },
    el('span', { class: 'code', text: code }),
    el('span', { text: `${c.points} ${t('pts')}` }),
    periodLabel(c) ? el('span', { class: 'period', text: periodLabel(c) }) : null);
  if (st !== 'done' && st !== 'pinned' && result.source.get(code)) {
    meta.append(el('span', { class: `src src-${result.source.get(code)}`, text: t('sources')[result.source.get(code)] }));
  }
  node.append(meta);
  if (critical) node.append(el('div', { class: 'badge-delay', title: t('impactDelay')(sv.delay), text: `+${sv.delay}` }));
  if (warns.length) node.append(el('div', { class: 'badge-warn', title: warns.map(w => t('warn')[w.type]).join('\n'), text: '!' }));
  return node;
}

// ---------- hover highlighting + arrows ----------

function setHover(code) {
  hovered = code;
  const board = document.getElementById('board');
  const catalog = document.getElementById('catalog');
  for (const n of document.querySelectorAll('.card, .row')) n.classList.remove('hl', 'hl-up', 'hl-down', 'dim');
  if (!code || !planner) { board.classList.remove('hovering'); drawArrows(); return; }
  board.classList.add('hovering');
  const up = planner.ancestors(code);
  const down = planner.descendants(code);
  for (const n of document.querySelectorAll('.card, .row')) {
    const c = n.dataset.code;
    if (c === code) n.classList.add('hl');
    else if (up.has(c)) n.classList.add('hl-up');
    else if (down.has(c)) n.classList.add('hl-down');
    else if (n.classList.contains('card')) n.classList.add('dim');
  }
  void catalog;
  drawArrows();
}

function arrowDefs() {
  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  for (const id of ['arrow', 'arrow-hot', 'arrow-bad']) {
    const m = document.createElementNS(ns, 'marker');
    m.setAttribute('id', id); m.setAttribute('viewBox', '0 0 10 10'); m.setAttribute('refX', '9'); m.setAttribute('refY', '5');
    m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7'); m.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    m.append(path); defs.append(m);
  }
  return defs;
}

function drawArrows() {
  const svg = document.getElementById('arrows');
  const cols = document.getElementById('columns');
  const board = document.getElementById('board');
  if (!result) { svg.replaceChildren(); return; }
  const W = cols.scrollWidth, H = cols.scrollHeight;
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren(arrowDefs());
  const base = cols.getBoundingClientRect();
  const rect = (code) => {
    const n = cols.querySelector(`.card[data-code="${code}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  };
  const done = new Set(state.done);
  const edges = planner.edges(done, result.plan);
  const up = hovered ? planner.ancestors(hovered) : null;
  const down = hovered ? planner.descendants(hovered) : null;
  const frag = document.createDocumentFragment();
  for (const e of edges) {
    const a = rect(e.from), b = rect(e.to);
    if (!a || !b) continue;
    const ltr = b.x > a.x;
    const x1 = ltr ? a.x + a.w : a.x, y1 = a.y + a.h / 2;
    const x2 = ltr ? b.x : b.x + b.w, y2 = b.y + b.h / 2;
    const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (ltr ? 1 : -1);
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    let cls = 'edge';
    if (e.alt) cls += ' alt';
    const sFrom = done.has(e.from) ? -1 : result.plan.get(e.from);
    const sTo = result.plan.get(e.to);
    if (sFrom !== undefined && sTo !== undefined && sFrom >= sTo) cls += ' bad';
    if (hovered) {
      const related = (e.from === hovered || e.to === hovered)
        || (up.has(e.from) && (up.has(e.to) || e.to === hovered))
        || (down.has(e.to) && (down.has(e.from) || e.from === hovered));
      cls += related ? ' hot' : ' faint';
    }
    path.setAttribute('class', cls);
    frag.append(path);
  }
  svg.append(frag);
  void board;
}

// ---------- popover ----------

function renderTree(tree, slot) {
  if (!tree) return el('div', { class: 'muted', text: t('noPrereqs') });
  const done = new Set(state.done);
  const walk = (n) => {
    if (n.type === 'COURSE') {
      const c = course(n.code);
      const ok = done.has(n.code) || (result.plan.has(n.code) && (slot === undefined || result.plan.get(n.code) < slot));
      const li = el('li', { class: ok ? 'ok' : 'missing' },
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); openPopover(n.code); } }, `${n.code} ${name(c.name || n.name)}`),
        n.minGrade ? el('span', { class: 'muted', text: ` (${t('minGrade')} ${n.minGrade})` }) : null,
        result.plan.has(n.code) ? el('span', { class: 'muted', text: ` · ${slotLabel(result.plan.get(n.code), true)}` }) : (done.has(n.code) ? el('span', { class: 'muted', text: ` · ${t('done')}` }) : null));
      return li;
    }
    const ul = el('ul', { class: `tree ${n.type.toLowerCase()}` });
    ul.append(el('li', { class: 'op', text: n.type === 'AND' ? (getLang() === 'he' ? 'כל אלה:' : 'all of:') : (getLang() === 'he' ? 'אחד מאלה:' : 'one of:') }));
    for (const ch of n.children) ul.append(walk(ch).tagName === 'LI' ? walk(ch) : el('li', {}, walk(ch)));
    return ul;
  };
  const root = walk(tree);
  return root.tagName === 'LI' ? el('ul', { class: 'tree' }, root) : root;
}

function openPopover(code) {
  const c = course(code);
  const pop = document.getElementById('popover');
  pop.replaceChildren();
  const st = statusOf(code);
  const slot = result && result.plan.get(code);
  const inUniverse = planner && planner.universe.has(code);
  const required = planner && planner.required.has(code);

  pop.append(el('button', { class: 'close', 'aria-label': 'close', onclick: closePopover }, '×'));
  pop.append(el('h3', { text: name(c.name) }));
  const other = getLang() === 'he' ? c.name.en : c.name.he;
  if (other) pop.append(el('div', { class: 'muted', text: other }));
  pop.append(el('div', { class: 'meta' },
    el('span', { text: code }), el('span', { text: `${c.points} ${t('pts')}` }),
    periodLabel(c) ? el('span', { text: periodLabel(c) }) : null,
    c.department ? el('span', { text: name(c.department) }) : null,
    el('a', { href: SHNATON + code, target: '_blank', rel: 'noopener', text: t('openShnaton') })));

  const stKey = { done: 'statusDone', pinned: 'statusPinned', auto: 'statusAuto', suggested: 'statusSuggested', implied: 'statusImplied', none: 'statusNone' }[st];
  pop.append(el('div', { class: 'section' }, el('b', { text: t('status') + ': ' }), t(stKey), slot !== undefined && st !== 'done' ? ` · ${slotLabel(slot)}` : ''));

  if (result) {
    const warns = result.warnings.get(code) || [];
    if (warns.length) {
      pop.append(el('div', { class: 'section warn' }, el('b', { text: t('warnings') }),
        el('ul', {}, warns.map(w => el('li', { text: t('warn')[w.type] + (w.missing ? ': ' + w.missing.map(m => `${m} ${name(course(m).name)}`).join(', ') : '') + (w.by ? ': ' + w.by.join(', ') : '') })))));
    }
    const sv = sens && sens.get(code);
    if (sv) {
      const sec = el('div', { class: `section impact ${sv.delay > 0 ? 'bad' : 'good'}` }, el('b', { text: t('impact') }), el('div', { text: sv.delay > 0 ? t('impactDelay')(sv.delay) : t('impactNone') }));
      if (sv.pushed.length) sec.append(el('div', { class: 'muted', text: `${t('pushes')}: ${sv.pushed.map(p => name(course(p).name)).join(', ')}` }));
      pop.append(sec);
    }
  }

  // actions
  const act = el('div', { class: 'actions' });
  act.append(el('button', { class: 'btn', onclick: () => { setDone(code, st !== 'done'); openPopover(code); } }, st === 'done' ? t('unmarkDone') : t('markDone')));
  if (st !== 'done') {
    if (st === 'none' && inUniverse) act.append(el('button', { class: 'btn', onclick: () => { addToPlan(code); openPopover(code); } }, t('addToPlan')));
    if (st !== 'none' && !required) act.append(el('button', { class: 'btn', onclick: () => { removeFromPlan(code); openPopover(code); } }, t('removeFromPlan')));
    if (st === 'pinned') act.append(el('button', { class: 'btn', onclick: () => { unpin(code); openPopover(code); } }, t('unpin')));
    if (result) {
      const sel = el('select');
      sel.append(el('option', { value: '', text: t('moveTo') + '…' }));
      const last = Math.min(MAX_SLOTS - 1, Math.max(result.end + 3, 7));
      for (let s = 0; s <= last; s++) sel.append(el('option', { value: s, text: slotLabel(s) + (offeredAt(c, s) ? '' : ' ✗') }));
      sel.addEventListener('change', () => { if (sel.value !== '') { pin(code, Number(sel.value)); openPopover(code); } });
      act.append(sel);
    }
  }
  pop.append(act);

  pop.append(el('div', { class: 'section' }, el('b', { text: t('prereqs') }), renderTree(c.prereq, slot)));
  if (c.blockedBy) pop.append(el('div', { class: 'section' }, el('b', { text: t('warn').blocked }), renderTree(c.blockedBy)));
  const deps = planner ? [...(planner.dependents.get(code) || [])] : [];
  if (deps.length) {
    pop.append(el('div', { class: 'section' }, el('b', { text: t('unlocks') }),
      el('ul', { class: 'tree' }, deps.map(d => el('li', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openPopover(d); } }, `${d} ${name(course(d).name)}`),
        result && result.plan.has(d) ? el('span', { class: 'muted', text: ` · ${slotLabel(result.plan.get(d), true)}` }) : null)))));
  }
  if (c.replacements && c.replacements.length) {
    pop.append(el('div', { class: 'section' }, el('b', { text: t('replacements') }),
      el('ul', { class: 'tree' }, c.replacements.map(r => el('li', { text: `${r.courses.map(x => `${x} ${name(course(x).name)}`).join(' / ')} (${name(r.roadmap)})` })))));
  }
  pop.hidden = false;
  document.getElementById('backdrop').hidden = false;
}

function closePopover() {
  document.getElementById('popover').hidden = true;
  document.getElementById('backdrop').hidden = true;
}

// ---------- sensitivity table ----------

function renderSensitivity() {
  const box = document.getElementById('sensitivity');
  box.replaceChildren();
  if (!result || !sens) return;
  const det = el('details', {});
  det.append(el('summary', { text: t('sensitivity') }));
  det.append(el('div', { class: 'muted', text: t('sensitivityHint') }));
  const rows = [...sens.entries()].filter(([, v]) => v.delay > 0).sort((a, b) => b[1].delay - a[1].delay || result.plan.get(a[0]) - result.plan.get(b[0]));
  if (!rows.length) { det.append(el('div', { class: 'muted', text: t('impactNone') })); box.append(det); return; }
  const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: t('course') }), el('th', { text: t('semester') }), el('th', { text: t('delay') }), el('th', { text: t('pushes') }))));
  const tb = el('tbody');
  for (const [code, v] of rows) {
    tb.append(el('tr', {},
      el('td', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openPopover(code); } }, `${code} ${name(course(code).name)}`)),
      el('td', { text: slotLabel(result.plan.get(code), true) }),
      el('td', { class: 'delay', text: `+${v.delay}` }),
      el('td', { class: 'muted', text: v.pushed.map(p => name(course(p).name)).join(', ') })));
  }
  table.append(tb);
  det.append(table);
  box.append(det);
}

function renderAbout() {
  const box = document.getElementById('about');
  box.replaceChildren(
    el('h2', { text: t('about') }),
    el('p', {},
      el('span', { text: t('aboutSite') + ': ' }),
      el('a', { href: 'https://heartproofs.com', target: '_blank', rel: 'noopener', text: 'heartproofs.com' }),
      el('span', { text: ' · ' }),
      el('a', { href: 'https://www.linkedin.com/in/noamlcv/', target: '_blank', rel: 'noopener', text: 'LinkedIn' })));
}

// ---------- boot ----------

async function main() {
  state = load();
  setLang(state.lang);
  const app = document.getElementById('app');
  try {
    const [index, courses] = await Promise.all([fetchJSON('index.json'), fetchJSON('courses.json')]);
    data.index = index;
    data.courses = courses.courses;
  } catch (e) {
    app.replaceChildren(el('div', { class: 'error', text: t('loadError') + ': ' + e.message }));
    return;
  }
  state.roadmaps = state.roadmaps.filter(c => data.index.roadmaps.some(r => r.code === c));
  if (!state.roadmaps.length) {
    const first = data.index.roadmaps.find(r => r.code === '530-1010') || data.index.roadmaps[0];
    if (first) state.roadmaps = [first.code];
  }
  if (state.startYear == null) state.startYear = data.index.year;
  await ensureRoadmaps(state.roadmaps);
  document.getElementById('footer').textContent = `${t('dataFrom')} ${data.index.hebrewYear} (${data.index.year}) · ${t('updated')} ${data.index.fetchedAt.slice(0, 10)}`;
  document.getElementById('backdrop').addEventListener('click', closePopover);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  window.addEventListener('resize', () => requestAnimationFrame(drawArrows));
  document.getElementById('board').addEventListener('scroll', () => requestAnimationFrame(drawArrows));
  const catalog = document.getElementById('catalog');
  dropTarget(catalog, (code) => removeFromPlan(code));
  recompute();
  render();
}

main();
