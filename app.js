import { firebaseConfig, ALLOWED_EMAILS } from './firebase-config.js';
import {
  DEFAULT_SETTINGS, parseNum, projectCosts, effectiveCosts, priceInfo, spoolUsage, spoolRemaining,
  spoolEurPerGram, giftStatus, allocateRecovery, projectResult, economics, remoteWins,
  accessoryUnitCost, accessoryUsage, accessoryRemaining
} from './calc.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, writeBatch, onSnapshot
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';

const SQLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.17.0/';
const COLLS = ['products', 'spools', 'sales', 'accessories'];   // progetti, bobine, vendite, accessori
const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const fmt = (n) => (n === null || n === undefined || isNaN(n)) ? '–' : eur.format(n);
const fmtSigned = (n) => (n > 0 ? '+' : '') + fmt(n);
const nf = (n, d = 0) => new Intl.NumberFormat('it-IT', { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const allowed = (email) => ALLOWED_EMAILS.map((e) => e.toLowerCase().trim()).includes(String(email || '').toLowerCase());
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const numIt = (n) => (n === null || n === undefined || n === '' || isNaN(n)) ? '' : String(Math.round(Number(n) * 10000) / 10000).replace('.', ',');
const dateIt = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('it-IT') : '';
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const STATI = { bozza: 'Bozza', produzione: 'In produzione', completato: 'Completato' };

// ---------------------------------------------------------------------------
// IndexedDB: conserva il file SQLite sul telefono
// ---------------------------------------------------------------------------
let idbHandle;
function idb() {
  if (idbHandle) return Promise.resolve(idbHandle);
  return new Promise((res, rej) => {
    const r = indexedDB.open('listino3d', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { idbHandle = r.result; res(idbHandle); };
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const d = await idb();
  return new Promise((res, rej) => {
    const q = d.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function idbSet(k, v) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

// ---------------------------------------------------------------------------
// SQLite locale (sql.js)
// ---------------------------------------------------------------------------
let db;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value REAL, updated_at INTEGER DEFAULT 0, dirty INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS records (
  coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at INTEGER DEFAULT 0, updated_by TEXT,
  deleted INTEGER DEFAULT 0, dirty INTEGER DEFAULT 0, PRIMARY KEY (coll, id));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`;

async function openLocalDb() {
  const SQL = await window.initSqlJs({ locateFile: (f) => SQLJS_BASE + f });
  const saved = await idbGet('sqlite');
  db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
  db.exec(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.run('INSERT OR IGNORE INTO settings (key, value, updated_at, dirty) VALUES (?, ?, 0, 0)', [k, v]);
  }
  migrateV1();
  await persist();
}

// Prima versione: i prodotti stavano in una tabella "products" a colonne fisse.
function migrateV1() {
  if (!one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'")) return;
  for (const r of all('SELECT * FROM products')) {
    const data = { nome: r.nome, pezzi: r.pezzi, grammi: r.grammi, ore: r.ore, prezzo: r.prezzo, stato: 'bozza', filamenti: [] };
    db.run(`INSERT OR IGNORE INTO records (coll, id, data, updated_at, updated_by, deleted, dirty)
            VALUES ('products', ?, ?, ?, ?, ?, ?)`,
      [r.id, JSON.stringify(data), r.updated_at || 0, r.updated_by || '', r.deleted || 0, r.dirty || 0]);
  }
  db.run('DROP TABLE products');
}

function all(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}
const one = (sql, params) => all(sql, params)[0];
let persistChain = Promise.resolve();
function persist() {
  persistChain = persistChain.then(() => idbSet('sqlite', db.export())).catch((e) => console.error('persist', e));
  return persistChain;
}

const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && !isFinite(v)) ? null : v));

function list(coll) {
  return all('SELECT id, data, updated_at, updated_by FROM records WHERE coll = ? AND deleted = 0', [coll])
    .map((r) => ({ ...JSON.parse(r.data || '{}'), id: r.id, _updatedAt: r.updated_at, _updatedBy: r.updated_by }));
}
function getRec(coll, id) {
  const r = one('SELECT id, data, deleted FROM records WHERE coll = ? AND id = ?', [coll, id]);
  return r && !r.deleted ? { ...JSON.parse(r.data || '{}'), id: r.id } : null;
}
function put(coll, id, data) {
  const d = clean(data);
  delete d.id; for (const k of Object.keys(d)) if (k.startsWith('_')) delete d[k];
  db.run(`INSERT OR REPLACE INTO records (coll, id, data, updated_at, updated_by, deleted, dirty)
          VALUES (?, ?, ?, ?, ?, 0, 1)`, [coll, id, JSON.stringify(d), Date.now(), currentUser?.email || '']);
}
function del(coll, id) {
  db.run('UPDATE records SET deleted = 1, dirty = 1, updated_at = ?, updated_by = ? WHERE coll = ? AND id = ?',
    [Date.now(), currentUser?.email || '', coll, id]);
}
function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) s[r.key] = Number(r.value);
  return s;
}
function pendingCount() {
  return one(`SELECT (SELECT COUNT(*) FROM records WHERE dirty = 1) +
                     (SELECT COUNT(*) FROM settings WHERE dirty = 1) AS n`).n;
}

const normProject = (p) => ({
  ...p,
  pezziPiatto: p.pezziPiatto ?? (Number(p.piatti) > 0 ? p.pezzi / p.piatti : p.pezzi),
  grammiPiatto: p.grammiPiatto ?? (Number(p.piatti) > 0 ? p.grammi / p.piatti : p.grammi),
  orePiatto: p.orePiatto ?? (Number(p.piatti) > 0 && p.ore != null ? p.ore / p.piatti : p.ore),
  stato: p.stato || 'bozza', filamenti: Array.isArray(p.filamenti) ? p.filamenti : [], accessori: Array.isArray(p.accessori) ? p.accessori : [] });

// Tutti i dati già pronti per i calcoli
function data() {
  const s = getSettings();
  const projects = list('products').map(normProject);
  const spools = list('spools');
  const projectIds = new Set(projects.map((p) => p.id));
  const sales = list('sales').filter((v) => projectIds.has(v.projectId));
  const spoolsById = Object.fromEntries(spools.map((x) => [x.id, x]));
  const usage = spoolUsage(projects);
  const accessories = list('accessories');
  const accById = Object.fromEntries(accessories.map((x) => [x.id, x]));
  const accUsage = accessoryUsage(projects);
  return { s, projects, spools, sales, spoolsById, usage, accessories, accById, accUsage };
}

// ---------------------------------------------------------------------------
// Firebase + sincronizzazione
// ---------------------------------------------------------------------------
const configured = !Object.values(firebaseConfig).some((v) => String(v).includes('INCOLLA_QUI'));
let auth, fs, currentUser = null;
let syncing = false, syncAgain = false, lastError = null;
let unsubs = [];

function applyRemote(coll, docs) {
  let changed = false;
  for (const d of docs) {
    const { updatedAt, updatedBy, deleted, ...rest } = d.data();
    const local = one('SELECT updated_at, dirty FROM records WHERE coll = ? AND id = ?', [coll, d.id]);
    if (!remoteWins(local, updatedAt)) continue;
    db.run(`INSERT OR REPLACE INTO records (coll, id, data, updated_at, updated_by, deleted, dirty)
            VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [coll, d.id, JSON.stringify(rest), Number(updatedAt) || 0, updatedBy ?? '', deleted ? 1 : 0]);
    changed = true;
  }
  return changed;
}

function applyRemoteSettings(docs, seedMissing) {
  let changed = false;
  const remoteKeys = new Set();
  for (const d of docs) {
    remoteKeys.add(d.id);
    if (!(d.id in DEFAULT_SETTINGS)) continue;
    const r = d.data();
    const local = one('SELECT updated_at, dirty FROM settings WHERE key = ?', [d.id]);
    if (!remoteWins(local, r.updatedAt)) continue;
    db.run('INSERT OR REPLACE INTO settings (key, value, updated_at, dirty) VALUES (?, ?, ?, 0)',
      [d.id, Number(r.value), Number(r.updatedAt) || 0]);
    changed = true;
  }
  // Primo avvio in assoluto: il cloud è vuoto, quindi ci carico i valori di questo telefono.
  if (seedMissing) {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!remoteKeys.has(k)) db.run('UPDATE settings SET dirty = 1 WHERE key = ?', [k]);
    }
  }
  return changed;
}

async function pushDirty() {
  const rs = all('SELECT * FROM records WHERE dirty = 1');
  const ss = all('SELECT * FROM settings WHERE dirty = 1');
  const ops = [
    ...rs.map((r) => [doc(fs, r.coll, r.id), { ...JSON.parse(r.data || '{}'), updatedAt: r.updated_at, updatedBy: r.updated_by ?? '', deleted: !!r.deleted }]),
    ...ss.map((s) => [doc(fs, 'settings', s.key), { value: s.value, updatedAt: s.updated_at }])
  ];
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(fs);
    for (const [ref, d] of ops.slice(i, i + 400)) b.set(ref, d);
    await b.commit();
  }
  // Segno come inviati solo i record non modificati di nuovo nel frattempo
  for (const r of rs) db.run('UPDATE records SET dirty = 0 WHERE coll = ? AND id = ? AND updated_at = ?', [r.coll, r.id, r.updated_at]);
  for (const s of ss) db.run('UPDATE settings SET dirty = 0 WHERE key = ? AND updated_at = ?', [s.key, s.updated_at]);
}

async function sync() {
  if (!currentUser || !fs) return;
  if (!navigator.onLine) { updateStatus(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; updateStatus();
  try {
    // 1) scarico dal cloud (le modifiche più recenti vincono)
    const snaps = await Promise.all([...COLLS, 'settings'].map((c) => getDocs(collection(fs, c))));
    COLLS.forEach((c, i) => applyRemote(c, snaps[i].docs));
    applyRemoteSettings(snaps[COLLS.length].docs, true);
    // 2) invio le modifiche locali rimaste
    await pushDirty();
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastSync', ?)", [String(Date.now())]);
    lastError = null;
    await persist();
    refreshAll();
  } catch (e) {
    console.error('sync', e);
    lastError = e;
  } finally {
    syncing = false;
    updateStatus();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

function startListeners() {
  stopListeners();
  const onErr = (e) => { console.error('listener', e); lastError = e; updateStatus(); };
  for (const c of COLLS) {
    unsubs.push(onSnapshot(collection(fs, c), (snap) => {
      if (applyRemote(c, snap.docs)) { persist(); refreshAll(); updateStatus(); }
    }, onErr));
  }
  unsubs.push(onSnapshot(collection(fs, 'settings'), (snap) => {
    if (applyRemoteSettings(snap.docs, false)) { persist(); refreshAll(); updateStatus(); }
  }, onErr));
}
function stopListeners() { unsubs.forEach((u) => u()); unsubs = []; }

// Dopo ogni modifica locale
async function committed(msg) {
  await persist();
  if (msg) toast(msg);
  updateStatus();
  sync();
}

// ---------------------------------------------------------------------------
// Navigazione
// ---------------------------------------------------------------------------
const VIEWS = ['loading', 'login', 'projects', 'history', 'project', 'spools', 'spool', 'acc', 'money', 'settings'];
const TITLES = { projects: 'Progetti', history: 'Storico', project: 'Progetto', spools: 'Magazzino bobine', spool: 'Bobina', acc: 'Accessorio', money: 'Guadagni', settings: 'Impostazioni' };
const NAV_OF = { project: 'projects', spool: 'spools', acc: 'spools' };
let currentView = 'loading';
let backView = 'projects';

function show(view) {
  currentView = view;
  for (const v of VIEWS) $('v-' + v).classList.toggle('hidden', v !== view);
  const inApp = !['loading', 'login'].includes(view);
  $('nav').classList.toggle('hidden', !inApp);
  $('fab').classList.toggle('hidden', !['projects', 'spools'].includes(view));
  const navView = NAV_OF[view] === 'projects' && backView === 'history' ? 'history' : (NAV_OF[view] || view);
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === navView));
  $('title').textContent = TITLES[view] || 'Listino 3D';
  window.scrollTo(0, 0);
}

function go(view) {
  if (view === 'projects') renderProjects();
  if (view === 'history') renderHistory();
  if (view === 'spools') renderSpools();
  if (view === 'money') renderMoney();
  if (view === 'settings') { fillSettings(true); updateStatus(); }
  show(view);
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function updateStatus() {
  if (!db) return;
  const dot = $('syncDot'), txt = $('syncText');
  const n = pendingCount();
  let cls = 'ok', label = 'Sincronizzato';
  if (!currentUser) { cls = ''; label = 'Non connesso'; }
  else if (!navigator.onLine) { cls = 'bad'; label = n ? `Offline · ${n}` : 'Offline'; }
  else if (syncing) { cls = 'warn'; label = 'Sincronizzo…'; }
  else if (lastError) { cls = 'bad'; label = 'Errore sync'; }
  else if (n) { cls = 'warn'; label = `${n} da inviare`; }
  dot.className = 'dot ' + cls; txt.textContent = label;
  const last = one("SELECT value FROM meta WHERE key = 'lastSync'");
  $('lastSyncInfo').textContent = last ? 'Ultima sincronizzazione: ' + new Date(Number(last.value)).toLocaleString('it-IT') : 'Mai sincronizzato';
  if (lastError) $('lastSyncInfo').textContent += ' — errore: ' + (lastError.code || lastError.message);
}

function refreshAll() {
  if (currentView === 'projects') renderProjects();
  else if (currentView === 'history') renderHistory();
  else if (currentView === 'spools') renderSpools();
  else if (currentView === 'money') renderMoney();
  fillSettings(false);
}

// ---------------------------------------------------------------------------
// Elenchi progetti (attivi e storico)
// ---------------------------------------------------------------------------
const statePill = (p) => `<span class="pill ${p.stato}">${STATI[p.stato]}</span>${p.regalo ? '<span class="pill regalo">🎁 Regalo</span>' : ''}`;

function projectCard(p, D) {
  const costi = effectiveCosts(p, D.s, D.spoolsById, D.accById);
  const res = projectResult(p, D.sales, D.s, D.spoolsById, D.accById);
  let recEuro = p.recuperoEuro;
  if (p.stato === 'bozza' && !p.regalo && costi) recEuro = allocateRecovery(p.pezzi, giftStatus(D.projects.filter((x) => x.id !== p.id))).reduce((a, r) => a + r.euro, 0);
  const pi = costi ? priceInfo(costi, Number(p.pezzi), recEuro, D.s) : null;
  let body = '';
  if (!pi) body = '<div class="line">Dati incompleti</div>';
  else if (p.regalo) {
    body = `<div class="line">Costo del regalo <b class="neg">${fmt(costi.totale)}</b> · ${nf(p.grammi)} g di filamento</div>`;
    if (Number(p.recuperoPezzi) > 0) body += `<div class="line">Da recuperare su ${nf(p.recuperoPezzi)} pezzi (+${fmt(costi.totale / p.recuperoPezzi)} a pezzo)</div>`;
  } else {
    body = `<div class="prices">
        <div class="price"><small>Lancio</small><b>${fmt(pi.lancio)}</b></div>
        <div class="price"><small>Standard</small><b>${fmt(pi.standard)}</b></div>
        <div class="price"><small>Personal.</small><b>${fmt(pi.personalizzato)}</b></div></div>`;
    if (p.prezzo !== null && p.prezzo !== undefined && p.prezzo !== '') {
      const g = p.prezzo - (res?.costoPezzoBuono ?? pi.costoPezzo);
      body += `<div class="line">Vendi a <b>${fmt(p.prezzo)}</b> · guadagno <b class="${g >= 0 ? 'pos' : 'neg'}">${fmt(g)}</b> a pezzo</div>`;
    }
    if (p.stato !== 'bozza' && res) {
      body += `<div class="line">Venduti <b>${nf(res.venduti)}/${nf(res.buoni)}</b> · incassati <b>${fmt(res.incasso)}</b>${res.scarti ? ` · scarti <b>${nf(res.scarti)}</b>` : ''}</div>`;
    }
  }
  const sub = p.stato === 'completato' ? `completato il ${dateIt(p.completatoAt)}` : `costo ${pi ? fmt(res?.costoPezzoBuono ?? pi.costoPezzo) : '–'} /pz`;
  return `<div class="card tap" data-project="${esc(p.id)}">
    <div class="pills">${statePill(p)}</div>
    <div class="row-top"><div class="name">${esc(p.nome)}</div><div class="muted">${sub}</div></div>
    <div class="muted">${nf(p.pezzi)} pezzi${p.note ? ' · ' + esc(p.note) : ''}</div>
    ${body}</div>`;
}

function renderProjects() {
  const D = data();
  const q = $('searchProjects').value.trim().toLowerCase();
  const match = (p) => !q || String(p.nome).toLowerCase().includes(q) || String(p.note || '').toLowerCase().includes(q);
  const prod = D.projects.filter((p) => p.stato === 'produzione' && match(p)).sort((a, b) => (b.prodottoAt || 0) - (a.prodottoAt || 0));
  const bozze = D.projects.filter((p) => p.stato === 'bozza' && match(p)).sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
  if (!prod.length && !bozze.length) {
    $('projectsList').innerHTML = `<div class="empty">${q ? 'Nessun progetto trovato.' : 'Nessun progetto attivo.<br>Tocca <b>+</b> per crearne uno: puoi usarlo anche solo per calcolare un prezzo.'}</div>`;
    return;
  }
  $('projectsList').innerHTML =
    (prod.length ? `<h3>In produzione</h3>${prod.map((p) => projectCard(p, D)).join('')}` : '') +
    (bozze.length ? `<h3>Bozze e preventivi</h3>${bozze.map((p) => projectCard(p, D)).join('')}` : '');
}

function renderHistory() {
  const D = data();
  const q = $('searchHistory').value.trim().toLowerCase();
  const rows = D.projects.filter((p) => p.stato === 'completato')
    .filter((p) => !q || String(p.nome).toLowerCase().includes(q) || String(p.note || '').toLowerCase().includes(q))
    .sort((a, b) => (b.completatoAt || 0) - (a.completatoAt || 0));
  $('historyList').innerHTML = rows.length ? rows.map((p) => projectCard(p, D)).join('')
    : `<div class="empty">${q ? 'Nessun progetto trovato.' : 'Lo storico è vuoto.<br>I progetti completati compaiono qui, con i loro prezzi.'}</div>`;
}

// ---------------------------------------------------------------------------
// Pagina progetto
// ---------------------------------------------------------------------------
let cur = null;   // copia del progetto in modifica

function openProject(id, fromView) {
  backView = fromView || (currentView === 'history' ? 'history' : 'projects');
  if (id) {
    const p = getRec('products', id);
    if (!p) return;
    cur = normProject(JSON.parse(JSON.stringify(p)));
    cur.isNew = false;
  } else {
    cur = { id: uuid(), isNew: true, nome: '', stato: 'bozza', filamenti: [], accessori: [], regalo: false, recuperoPezzi: 0, scarti: 0 };
  }
  renderProjectPage();
  show('project');
  $('title').textContent = cur.isNew ? 'Nuovo progetto' : 'Progetto';
}

function spoolLabel(sp, usage) {
  return `${sp.nome || 'Bobina'}${sp.materiale ? ' ' + sp.materiale : ''}${sp.marca ? ' ' + sp.marca : ''} · ${nf(Math.max(0, spoolRemaining(sp, usage)))} g`;
}

function renderProjectPage() {
  const p = cur;
  const locked = p.stato !== 'bozza';
  const dis = locked ? 'disabled' : '';
  const h = Math.floor((Number(p.orePiatto) || 0) + 1e-9);
  let m = Math.round(((Number(p.orePiatto) || 0) - h) * 60);
  const hh = m === 60 ? h + 1 : h; if (m === 60) m = 0;
  const hasOre = p.orePiatto !== undefined && p.orePiatto !== null && p.orePiatto !== '';

  let actions = '';
  if (p.stato === 'bozza') {
    actions = `<button class="btn warn" data-act="produce">▶️ Metti in produzione</button>
      <button class="btn ghost" data-act="save">Salva bozza</button>
      <button class="btn ghost" data-act="back">Annulla</button>
      ${p.isNew ? '' : '<button class="btn danger" data-act="delete">Elimina progetto</button>'}`;
  } else if (p.stato === 'produzione') {
    actions = `<button class="btn ok" data-act="complete">✅ Completato: sposta nello storico</button>
      <button class="btn ghost" data-act="save">Salva modifiche</button>
      <button class="btn ghost" data-act="toDraft">↩️ Riporta in bozza</button>
      <button class="btn danger" data-act="delete">Elimina progetto</button>`;
  } else {
    actions = `<button class="btn ghost" data-act="save">Salva modifiche</button>
      <button class="btn ghost" data-act="duplicate">📄 Duplica come nuovo progetto</button>
      <button class="btn ghost" data-act="reopen">↩️ Riapri (rimetti in produzione)</button>
      <button class="btn danger" data-act="delete">Elimina progetto</button>`;
  }

  $('projectPage').innerHTML = `
    <div class="card">
      <div class="pills">${statePill(p)}</div>
      <label for="pNome">Nome progetto</label>
      <input id="pNome" value="${esc(p.nome || '')}" placeholder="es. Medagliette">
      <label for="pTotPezzi">Pezzi da produrre (totale ordine)</label>
      <input id="pTotPezzi" inputmode="numeric" value="${numIt(p.pezzi)}" placeholder="es. 100" ${dis}>
      <p class="note" style="margin:12px 0 0">Dati dello slicer per <b>un piatto</b> di prova: servono a calcolare grammi e tempo per pezzo.</p>
      <div class="row2">
        <div><label for="pPezzi">Pezzi per piatto</label><input id="pPezzi" inputmode="numeric" value="${numIt(p.pezziPiatto)}" placeholder="15" ${dis}></div>
        <div><label for="pGrammi">Grammi per piatto</label><input id="pGrammi" inputmode="decimal" value="${numIt(p.grammiPiatto)}" placeholder="71,97" ${dis}></div>
      </div>
      <div class="row2">
        <div><label for="pOre">Ore per piatto</label><input id="pOre" inputmode="numeric" value="${hasOre ? hh : ''}" placeholder="8" ${dis}></div>
        <div><label for="pMin">Minuti</label><input id="pMin" inputmode="numeric" value="${hasOre ? m : ''}" placeholder="20" ${dis}></div>
      </div>
      <div class="line" id="pTot"></div>
      <label for="pNote">Note / cliente / destinatario</label>
      <input id="pNote" value="${esc(p.note || '')}" placeholder="facoltativo">
      ${locked ? '<p class="note">I dati di stampa sono bloccati perché il progetto è già in produzione. Per cambiarli riportalo in bozza.</p>' : ''}
    </div>

    <div class="card">
      <h2>🧵 Bobine usate</h2>
      <div id="pAllocs"></div>
      <div id="pAllocTools"></div>
    </div>

    <div class="card">
      <h2>🔩 Accessori</h2>
      <div id="pAccs"></div>
    </div>

    <div class="card">
      <label class="check"><input type="checkbox" id="pRegalo" ${p.regalo ? 'checked' : ''} ${dis}> 🎁 È un regalo</label>
      <div id="pGiftBox" class="${p.regalo ? '' : 'hidden'}">
        <label for="pRecPezzi">Recupera il costo sui prossimi … pezzi</label>
        <input id="pRecPezzi" inputmode="numeric" value="${numIt(p.recuperoPezzi ?? 0)}" ${dis}>
        <p class="note">0 = regalo e basta: il costo resta una perdita. Con un numero, il costo viene aggiunto un po' alla volta al prezzo suggerito dei prossimi pezzi che metti in produzione (di qualsiasi progetto).</p>
      </div>
      <div id="pPriceBox" class="${p.regalo ? 'hidden' : ''}">
        <label for="pPrezzo">Il tuo prezzo di vendita a pezzo</label>
        <input id="pPrezzo" inputmode="decimal" value="${numIt(p.prezzo)}" placeholder="facoltativo">
      </div>
    </div>

    <div class="card" id="pResult"></div>

    ${locked ? `<div class="card">
      <h2>🗑️ Pezzi scartati</h2>
      <label for="pScarti">Pezzi venuti male (stampa fallita)</label>
      <input id="pScarti" inputmode="numeric" value="${numIt(p.scarti || 0)}">
      <p class="note">Il costo dei pezzi scartati viene ripartito sui pezzi buoni e conteggiato nei Guadagni.</p>
    </div>` : ''}

    ${locked && !p.regalo ? '<div class="card" id="pSales"></div>' : ''}

    ${actions}`;
  renderAllocs();
  renderAccs();
  renderSales();
  updateProjectPreview();
}

function renderAccs() {
  const D = data();
  const locked = cur.stato !== 'bozza';
  const usageOthers = accessoryUsage(D.projects.filter((x) => x.id !== cur.id));
  const opts = (sel) => '<option value="">— scegli accessorio —</option>' + D.accessories
    .filter((a) => accessoryRemaining(a, usageOthers) > 0 || a.id === sel)
    .map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.nome)} · ${fmt(accessoryUnitCost(a))} cad. · ${nf(Math.max(0, accessoryRemaining(a, usageOthers)))} disp.</option>`).join('') +
    (sel && !D.accById[sel] ? '<option selected value="' + esc(sel) + '">(accessorio eliminato)</option>' : '');
  const rows = cur.accessori;
  $('pAccs').innerHTML = (rows.length ? rows.map((a, i) => `
    <div class="alloc">
      <select class="xAcc" data-i="${i}" ${locked ? 'disabled' : ''}>${opts(a.accId)}</select>
      <input class="xQta" data-i="${i}" inputmode="numeric" value="${numIt(a.qta)}" placeholder="q.tà" ${locked ? 'disabled' : ''}>
      ${locked ? '<span></span>' : `<button class="xDel" data-i="${i}" aria-label="Rimuovi">✕</button>`}
    </div>`).join('') + '<p class="note">Quantità totale per tutto il progetto (es. 45 portachiavi = 45 tag).</p>'
    : `<p class="note">${D.accessories.length ? 'Nessun accessorio in questo progetto.' : 'Nessun accessorio in archivio: aggiungili in 🧵 Magazzino → Accessori (es. tag NFC, anelli, catenelle).'}</p>`) +
    (!locked && D.accessories.length ? '<button class="btn ghost small" data-act="addAcc">+ Aggiungi accessorio</button>' : '');
}

function renderAllocs() {
  const D = data();
  const locked = cur.stato !== 'bozza';
  const usageOthers = spoolUsage(D.projects.filter((x) => x.id !== cur.id));
  const opts = (sel) => '<option value="">— scegli bobina —</option>' + D.spools
    .filter((sp) => !sp.esaurita || sp.id === sel)
    .map((sp) => `<option value="${esc(sp.id)}" ${sp.id === sel ? 'selected' : ''}>${esc(spoolLabel(sp, usageOthers))}</option>`).join('') +
    (sel && !D.spoolsById[sel] ? '<option selected value="' + esc(sel) + '">(bobina eliminata)</option>' : '');
  const rows = cur.filamenti;
  $('pAllocs').innerHTML = rows.length ? rows.map((a, i) => `
    <div class="alloc">
      <select class="aSpool" data-i="${i}" ${locked ? 'disabled' : ''}>${opts(a.spoolId)}</select>
      <input class="aGr" data-i="${i}" inputmode="decimal" value="${numIt(a.grammi)}" placeholder="g" ${locked ? 'disabled' : ''}>
      ${locked ? '<span></span>' : `<button class="aDel" data-i="${i}" aria-label="Rimuovi">✕</button>`}
    </div>`).join('')
    : `<p class="note">${D.spools.length ? 'Nessuna bobina scelta: il costo usa il prezzo €/kg delle impostazioni e il magazzino non viene aggiornato.' : 'Nel magazzino non ci sono bobine: aggiungile nella sezione 🧵 Magazzino per scalare il filamento in automatico.'}</p>`;
  $('pAllocTools').innerHTML = (!locked && D.spools.length ? '<button class="btn ghost small" data-act="addAlloc">+ Aggiungi bobina</button>' : '') +
    '<div class="note" id="pAllocInfo" style="margin-top:8px"></div>';
  updateAllocInfo();
}

function updateAllocInfo() {
  const el = $('pAllocInfo'); if (!el) return;
  const tot = Number(cur.grammi) || 0;
  const ass = cur.filamenti.reduce((a, x) => a + (Number(x.grammi) || 0), 0);
  if (!cur.filamenti.length) { el.textContent = ''; return; }
  const diff = Math.abs(tot - ass) > 0.5;
  el.innerHTML = `Assegnati <b>${nf(ass, 2)} g</b> su ${nf(tot, 2)} g totali${diff ? ' <span class="neg">— i conti non tornano</span>' : ' ✓'}`;
}

function renderSales() {
  const box = $('pSales'); if (!box) return;
  const D = data();
  const sales = D.sales.filter((v) => v.projectId === cur.id).sort((a, b) => String(a.data).localeCompare(String(b.data)));
  const res = projectResult(cur, D.sales, D.s, D.spoolsById, D.accById);
  const pi = res ? priceInfo(res.costi, Number(cur.pezzi), cur.recuperoEuro, D.s) : null;
  const defPrice = cur.prezzo ?? pi?.lancio ?? '';
  box.innerHTML = `<h2>💶 Vendite</h2>
    ${sales.length ? sales.map((v) => `<div class="sale"><span>${new Date(v.data).toLocaleDateString('it-IT')} · ${nf(v.pezzi)} pz × ${fmt(v.prezzo)}</span>
      <span><b>${fmt(v.pezzi * v.prezzo)}</b><button data-sale="${esc(v.id)}" aria-label="Elimina vendita">✕</button></span></div>`).join('')
      : '<p class="note">Nessuna vendita registrata.</p>'}
    <div class="row2">
      <div><label for="sPezzi">Pezzi venduti</label><input id="sPezzi" inputmode="numeric" value="${res && res.daVendere > 0 ? res.daVendere : ''}"></div>
      <div><label for="sPrezzo">Prezzo a pezzo (€)</label><input id="sPrezzo" inputmode="decimal" value="${numIt(defPrice)}"></div>
    </div>
    <label for="sData">Data</label><input id="sData" type="date" value="${today()}">
    <button class="btn ok small" data-act="addSale">+ Registra vendita</button>`;
}

function readProjectForm() {
  const v = (id) => $(id) ? $(id).value : undefined;
  cur.nome = v('pNome').trim();
  cur.note = v('pNote').trim();
  if (cur.stato === 'bozza') {
    delete cur.piatti;
    cur.pezziPiatto = parseNum(v('pPezzi'));
    cur.grammiPiatto = parseNum(v('pGrammi'));
    const o = parseNum(v('pOre')), mi = parseNum(v('pMin'));
    cur.orePiatto = (isNaN(o) && isNaN(mi)) ? null : (o || 0) + (mi || 0) / 60;
    // Totali del progetto (usati in tutti i calcoli): proporzionali ai pezzi da produrre
    const tot = Math.floor(parseNum(v('pTotPezzi')));
    cur.pezzi = tot > 0 ? tot : cur.pezziPiatto;
    const k = cur.pezziPiatto > 0 ? cur.pezzi / cur.pezziPiatto : NaN;
    cur.grammi = Math.round(cur.grammiPiatto * k * 100) / 100;
    cur.ore = cur.orePiatto === null ? null : cur.orePiatto * k;
    cur.regalo = $('pRegalo').checked;
    cur.recuperoPezzi = Math.max(0, Math.floor(parseNum(v('pRecPezzi')) || 0));
    document.querySelectorAll('.aSpool').forEach((el) => { cur.filamenti[el.dataset.i].spoolId = el.value; });
    document.querySelectorAll('.aGr').forEach((el) => { cur.filamenti[el.dataset.i].grammi = parseNum(el.value); });
    document.querySelectorAll('.xAcc').forEach((el) => { cur.accessori[el.dataset.i].accId = el.value; });
    document.querySelectorAll('.xQta').forEach((el) => { cur.accessori[el.dataset.i].qta = parseNum(el.value); });
  }
  const pr = v('pPrezzo');
  cur.prezzo = (pr === undefined || pr.trim() === '') ? null : parseNum(pr);
  if ($('pScarti')) cur.scarti = Math.max(0, Math.floor(parseNum(v('pScarti')) || 0));
}

function oreIt(ore) {
  const h = Math.floor(ore + 1e-9); const m = Math.round((ore - h) * 60);
  return m === 60 ? `${h + 1}h` : (m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`);
}

function updateTotals() {
  const el = $('pTot'); if (!el) return;
  const p = cur;
  if (!(p.pezzi > 0) || !(p.ore > 0)) { el.innerHTML = ''; return; }
  el.innerHTML = `Totale progetto: <b>${nf(p.pezzi)} pezzi</b> · <b>${nf(p.grammi, 1)} g</b> di filamento · <b>${oreIt(p.ore)}</b> di stampa`;
}

function updateProjectPreview() {
  updateTotals();
  const D = data();
  const p = cur;
  const box = $('pResult');
  const costi = p.stato === 'bozza' ? (p.ore > 0 ? projectCosts(p, D.s, D.spoolsById, D.accById) : null) : p.costi;
  if (!costi) { box.innerHTML = '<div class="note">Inserisci pezzi, grammi e tempo di stampa per vedere costi e prezzi.</div>'; return; }
  const others = D.projects.filter((x) => x.id !== p.id);
  let recupero = p.recupero || [];
  if (p.stato === 'bozza') recupero = p.regalo ? [] : allocateRecovery(p.pezzi, giftStatus(others));
  const recEuro = recupero.reduce((a, r) => a + r.euro, 0);
  const pi = priceInfo(costi, Number(p.pezzi), recEuro, D.s);
  const res = p.stato !== 'bozza' ? projectResult(p, D.sales, D.s, D.spoolsById, D.accById) : null;
  let html = '';

  if (p.regalo) {
    html += `<div class="note">Costo del regalo (${nf(p.pezzi)} pezzi in totale)</div><div class="big neg">${fmt(costi.totale)}</div>
      <div class="breakdown">Filamento ${fmt(costi.filamento)} (${nf(p.grammi, 1)} g) · Energia ${fmt(costi.energia)} · Ammortamento ${fmt(costi.ammortamento)}${costi.accessori ? ` · Accessori ${fmt(costi.accessori)}` : ''}</div>`;
    if (p.recuperoPezzi > 0) {
      const g = giftStatus(D.projects.map((x) => x.id === p.id ? { ...x, ...p } : x)).find((x) => x.id === p.id);
      html += `<div class="line">Recupero: <b>+${fmt(costi.totale / p.recuperoPezzi)}</b> a pezzo sui prossimi <b>${nf(p.recuperoPezzi)}</b> pezzi.</div>`;
      if (g) html += `<div class="line">Già recuperato su <b>${nf(g.usati)}/${nf(g.n)}</b> pezzi (${fmt(g.usati * g.perPezzo)}).</div>`;
      else html += '<div class="line">Il recupero parte quando metti il regalo in produzione.</div>';
    } else {
      html += '<div class="line">Regalo senza recupero: il costo resta una perdita nei Guadagni.</div>';
    }
  } else {
    html += `<div class="note">Costo netto per pezzo · progetto intero ${fmt(costi.totale)}</div><div class="big">${fmt(pi.costoPezzo)}</div>
      <div class="prices">
        <div class="price"><small>Lancio</small><b>${fmt(pi.lancio)}</b></div>
        <div class="price"><small>Standard</small><b>${fmt(pi.standard)}</b></div>
        <div class="price"><small>Personal.</small><b>${fmt(pi.personalizzato)}</b></div>
      </div>
      <div class="breakdown">Filamento ${fmt(pi.filamento)} · Energia ${fmt(pi.energia)} · Ammortamento ${fmt(pi.ammortamento)}${pi.accessori ? ` · Accessori ${fmt(pi.accessori)}` : ''} a pezzo</div>`;
    if (recEuro > 0) {
      const names = recupero.map((r) => getRec('products', r.giftId)?.nome || 'regalo').join(', ');
      html += `<div class="line">🎁 I prezzi includono <b>+${fmt(pi.recuperoPezzo)}</b> a pezzo per recuperare: ${esc(names)}${p.stato === 'bozza' ? ' (si blocca quando metti in produzione)' : ''}.</div>`;
    }
    if (p.prezzo !== null && p.prezzo !== undefined && !isNaN(p.prezzo)) {
      const g = p.prezzo - pi.costoPezzo;
      html += `<div class="line">Al tuo prezzo di ${fmt(p.prezzo)} guadagni <b class="${g >= 0 ? 'pos' : 'neg'}">${fmt(g)}</b> a pezzo${res && res.scarti ? ' (senza scarti)' : ''}.</div>`;
    }
  }

  if (res) {
    html += '<div class="breakdown" style="border-top:1px solid var(--border);margin-top:12px;padding-top:10px">';
    if (res.scarti > 0) {
      html += `🗑️ Scartati <b>${nf(res.scarti)}</b> pezzi su ${nf(res.pezzi)} (${nf(res.scartoPerc, 1)}%, stima ${nf(D.s.fallite, 1)}%): costo <b class="neg">${fmt(res.costoScarti)}</b>.<br>`;
      if (!p.regalo && res.costoPezzoBuono !== null) {
        html += `Costo reale per pezzo buono: <b>${fmt(res.costoPezzoBuono)}</b>`;
        if (p.prezzo) { const g = p.prezzo - res.costoPezzoBuono; html += ` · al tuo prezzo guadagni <b class="${g >= 0 ? 'pos' : 'neg'}">${fmt(g)}</b> a pezzo`; }
        html += '.<br>';
      }
    }
    if (!p.regalo) {
      html += `Venduti <b>${nf(res.venduti)}</b> su ${nf(res.buoni)} pezzi buoni · incassati <b>${fmt(res.incasso)}</b><br>`;
      const prezzoRif = p.prezzo || pi.lancio;
      if (res.risultato >= 0) html += `<b class="pos">Progetto in guadagno di ${fmt(res.risultato)}</b> (costi di tutto il piatto già coperti).`;
      else if (res.daVendere > 0) {
        const fin = res.risultato + res.daVendere * prezzoRif;
        html += `<b class="neg">Per ora ${fmt(res.risultato)}</b>: vendendo i ${nf(res.daVendere)} pezzi rimasti a ${fmt(prezzoRif)} arriveresti a <b class="${fin >= 0 ? 'pos' : 'neg'}">${fmtSigned(fin)}</b>.`;
      } else html += `<b class="neg">Progetto in perdita di ${fmt(-res.risultato)}</b>.`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

function validateProject(forProduction) {
  if (!cur.nome) { toast('Scrivi il nome del progetto'); return false; }
  if (!(cur.pezzi > 0) || !(cur.grammi >= 0) || !(cur.ore > 0)) { toast('Controlla pezzi da produrre e dati dello slicer'); return false; }
  if (cur.prezzo !== null && isNaN(cur.prezzo)) { toast('Prezzo non valido'); return false; }
  for (const a of cur.filamenti) {
    if (!a.spoolId) { toast('Scegli la bobina in ogni riga (o rimuovi la riga)'); return false; }
    if (!(a.grammi > 0)) { toast('Inserisci i grammi per ogni bobina'); return false; }
  }
  for (const a of cur.accessori) {
    if (!a.accId) { toast('Scegli l\'accessorio in ogni riga (o rimuovi la riga)'); return false; }
    if (!(a.qta > 0)) { toast('Inserisci la quantità di ogni accessorio'); return false; }
  }
  if (forProduction) {
    const D = data();
    const accOthers = accessoryUsage(D.projects.filter((x) => x.id !== cur.id));
    const needAcc = {};
    for (const a of cur.accessori) needAcc[a.accId] = (needAcc[a.accId] || 0) + a.qta;
    for (const [aid, q] of Object.entries(needAcc)) {
      const acc = D.accById[aid]; if (!acc) continue;
      const rem = accessoryRemaining(acc, accOthers);
      if (q > rem && !confirm(`Di "${acc.nome}" ne restano solo ${nf(rem)} (ne servono ${nf(q)}). Continuare comunque?`)) return false;
    }
    const ass = cur.filamenti.reduce((a, x) => a + x.grammi, 0);
    if (!cur.filamenti.length && D.spools.length && !confirm('Nessuna bobina scelta: il magazzino non verrà aggiornato. Continuare?')) return false;
    if (cur.filamenti.length && ass < cur.grammi - 0.5 && !confirm(`Hai assegnato ${nf(ass, 1)} g su ${nf(cur.grammi, 1)} g: il resto non verrà scalato dal magazzino. Continuare?`)) return false;
    if (ass > cur.grammi + 0.5) { toast('Hai assegnato alle bobine più grammi del totale'); return false; }
    const usageOthers = spoolUsage(D.projects.filter((x) => x.id !== cur.id));
    const need = {};
    for (const a of cur.filamenti) need[a.spoolId] = (need[a.spoolId] || 0) + a.grammi;
    for (const [sid, g] of Object.entries(need)) {
      const sp = D.spoolsById[sid]; if (!sp) continue;
      const rem = spoolRemaining(sp, usageOthers);
      if (g > rem + 0.5 && !confirm(`La bobina "${sp.nome}" ha solo ${nf(rem)} g rimasti (ne servono ${nf(g)}). Continuare comunque?`)) return false;
    }
  }
  return true;
}

function saveCur() {
  const { isNew, ...d } = cur;
  put('products', cur.id, d);
  cur.isNew = false;
}

const leaveProject = () => go(backView);

async function projectAction(act) {
  if (act === 'addAlloc') {
    readProjectForm();
    const ass = cur.filamenti.reduce((a, x) => a + (Number(x.grammi) || 0), 0);
    const rest = (Number(cur.grammi) || 0) - ass;
    cur.filamenti.push({ spoolId: '', grammi: rest > 0 ? Math.round(rest * 100) / 100 : null });
    renderAllocs(); updateProjectPreview();
    return;
  }
  if (act === 'addAcc') {
    readProjectForm();
    cur.accessori.push({ accId: '', qta: Number(cur.pezzi) > 0 ? cur.pezzi : null });
    renderAccs(); updateProjectPreview();
    return;
  }
  if (act === 'back') return leaveProject();
  readProjectForm();
  const D = data();

  if (act === 'save') {
    if (cur.stato === 'bozza' ? !validateProject(false) : !cur.nome) return cur.nome ? null : toast('Scrivi il nome del progetto');
    saveCur(); await committed('Salvato'); return leaveProject();
  }
  if (act === 'produce') {
    if (!validateProject(true)) return;
    const costi = projectCosts(cur, D.s, D.spoolsById, D.accById);
    cur.recupero = cur.regalo ? [] : allocateRecovery(cur.pezzi, giftStatus(D.projects.filter((x) => x.id !== cur.id)));
    cur.recuperoEuro = cur.recupero.reduce((a, r) => a + r.euro, 0);
    Object.assign(cur, { stato: 'produzione', prodottoAt: Date.now(), costi, scarti: cur.scarti || 0 });
    saveCur(); await committed('In produzione: magazzino aggiornato');
    renderProjectPage(); show('project'); return;
  }
  if (act === 'complete') {
    cur.stato = 'completato'; cur.completatoAt = Date.now();
    saveCur(); await committed('Spostato nello storico');
    return go('projects');
  }
  if (act === 'toDraft') {
    if (!confirm('Riportare in bozza? Il filamento torna nel magazzino e i costi verranno ricalcolati quando lo rimetti in produzione.')) return;
    cur.stato = 'bozza';
    for (const k of ['costi', 'prodottoAt', 'completatoAt', 'recupero', 'recuperoEuro']) delete cur[k];
    saveCur(); await committed('Riportato in bozza');
    renderProjectPage(); show('project'); return;
  }
  if (act === 'reopen') {
    cur.stato = 'produzione'; delete cur.completatoAt;
    saveCur(); await committed('Rimesso in produzione');
    backView = 'projects'; renderProjectPage(); show('project'); return;
  }
  if (act === 'duplicate') {
    saveCur();
    const src = cur;
    cur = {
      id: uuid(), isNew: true, stato: 'bozza', nome: src.nome, note: '', pezzi: src.pezzi, grammi: src.grammi, ore: src.ore,
      pezziPiatto: src.pezziPiatto, grammiPiatto: src.grammiPiatto, orePiatto: src.orePiatto,
      prezzo: src.prezzo, filamenti: src.filamenti.map((a) => ({ ...a })), accessori: src.accessori.map((a) => ({ ...a })), regalo: false, recuperoPezzi: 0, scarti: 0
    };
    await committed();
    backView = 'projects'; renderProjectPage(); show('project'); $('title').textContent = 'Nuovo progetto';
    toast('Copia creata: controlla le bobine e salva');
    return;
  }
  if (act === 'delete') {
    if (!confirm('Eliminare il progetto (e le sue vendite) per entrambi?')) return;
    if (!cur.isNew) {
      del('products', cur.id);
      for (const v of D.sales.filter((x) => x.projectId === cur.id)) del('sales', v.id);
    }
    await committed('Eliminato'); return leaveProject();
  }
  if (act === 'addSale') {
    const pezzi = parseNum($('sPezzi').value), prezzo = parseNum($('sPrezzo').value), dataV = $('sData').value || today();
    if (!(pezzi > 0)) return toast('Inserisci i pezzi venduti');
    if (!(prezzo >= 0)) return toast('Inserisci il prezzo');
    const res = projectResult(cur, D.sales, D.s, D.spoolsById, D.accById);
    if (res && pezzi > res.daVendere && !confirm(`Risultano solo ${nf(res.daVendere)} pezzi da vendere. Registrare comunque ${nf(pezzi)}?`)) return;
    saveCur();
    put('sales', uuid(), { projectId: cur.id, pezzi, prezzo, data: dataV });
    await committed('Vendita registrata');
    renderSales(); updateProjectPreview();
  }
}

function bindProjectPage() {
  const page = $('projectPage');
  page.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('aDel')) {
      readProjectForm(); cur.filamenti.splice(Number(b.dataset.i), 1);
      renderAllocs(); updateProjectPreview(); return;
    }
    if (b.classList.contains('xDel')) {
      readProjectForm(); cur.accessori.splice(Number(b.dataset.i), 1);
      renderAccs(); updateProjectPreview(); return;
    }
    if (b.dataset.sale) {
      if (!confirm('Eliminare questa vendita?')) return;
      del('sales', b.dataset.sale); await committed('Vendita eliminata');
      renderSales(); updateProjectPreview(); return;
    }
    if (b.dataset.act) projectAction(b.dataset.act);
  });
  const onEdit = (e) => {
    if (['sPezzi', 'sPrezzo', 'sData'].includes(e.target.id)) return;
    readProjectForm();
    if (e.target.id === 'pRegalo') {
      $('pGiftBox').classList.toggle('hidden', !cur.regalo);
      $('pPriceBox').classList.toggle('hidden', cur.regalo);
    }
    updateAllocInfo(); updateProjectPreview();
  };
  page.addEventListener('input', onEdit);
  page.addEventListener('change', onEdit);
}

// ---------------------------------------------------------------------------
// Magazzino bobine
// ---------------------------------------------------------------------------
function spoolCard(sp, usage) {
  const rem = Math.max(0, spoolRemaining(sp, usage));
  const pct = Number(sp.peso) > 0 ? Math.max(0, Math.min(100, rem / sp.peso * 100)) : 0;
  const low = rem < 150 && !sp.esaurita;
  return `<div class="card tap" data-spool="${esc(sp.id)}">
    <div class="row-top"><div class="name"><span class="swatch" style="background:${esc(sp.hex || '#999999')}"></span>${esc(sp.nome || 'Bobina')}</div>
      <div class="muted">${esc([sp.materiale, sp.marca].filter(Boolean).join(' · '))}</div></div>
    <div class="bar"><div style="width:${pct}%;background:${esc(sp.hex || 'var(--accent)')}"></div></div>
    <div class="line"><b>${nf(rem)} g</b> rimasti su ${nf(sp.peso)} g (${nf(pct)}%) · pagata ${fmt(sp.prezzo)}${low ? ' · <b class="neg">quasi finita</b>' : ''}</div>
  </div>`;
}

let magTab = 'spools';
function renderSpools() {
  const tabs = `<div class="seg"><button data-tab="spools" class="${magTab === 'spools' ? 'active' : ''}">🧵 Bobine</button><button data-tab="acc" class="${magTab === 'acc' ? 'active' : ''}">🔩 Accessori</button></div>`;
  $('spoolsPage').innerHTML = tabs + (magTab === 'acc' ? accListHtml() : spoolListHtml());
}

function accListHtml() {
  const D = data();
  if (!D.accessories.length) return '<div class="empty">Nessun accessorio.<br>Tocca <b>+</b> per inserire un acquisto all\'ingrosso, es. 20 tag NFC a 10 €: l\'app calcola il costo di ognuno e li scala quando li usi in un progetto.</div>';
  const rows = D.accessories.map((a) => ({ a, rem: accessoryRemaining(a, D.accUsage) }));
  const avail = rows.filter((r) => r.rem > 0).sort((x, y) => String(x.a.nome).localeCompare(String(y.a.nome)));
  const done = rows.filter((r) => r.rem <= 0);
  const value = avail.reduce((t, r) => t + r.rem * accessoryUnitCost(r.a), 0);
  const card = ({ a, rem }) => {
    const pct = Number(a.quantita) > 0 ? Math.max(0, Math.min(100, rem / a.quantita * 100)) : 0;
    return `<div class="card tap" data-acc="${esc(a.id)}">
      <div class="row-top"><div class="name">${esc(a.nome)}</div><div class="muted">${fmt(accessoryUnitCost(a))} cad.</div></div>
      <div class="bar"><div style="width:${pct}%;background:var(--accent)"></div></div>
      <div class="line"><b>${nf(Math.max(0, rem))}</b> disponibili su ${nf(a.quantita)} · pagati ${fmt(a.prezzo)}${rem > 0 && rem <= 3 ? ' · <b class="neg">quasi finiti</b>' : ''}</div>
    </div>`;
  };
  return `<div class="card"><div class="stats">
      <div class="stat"><small>Articoli disponibili</small><b>${avail.length}</b></div>
      <div class="stat"><small>Valore in magazzino</small><b>${fmt(value)}</b></div></div></div>
    ${avail.map(card).join('')}
    ${done.length ? `<details><summary>Finiti (${done.length})</summary>${done.map(card).join('')}</details>` : ''}`;
}

function spoolListHtml() {
  const D = data();
  const active = D.spools.filter((sp) => !sp.esaurita && spoolRemaining(sp, D.usage) > 0.5);
  const done = D.spools.filter((sp) => !active.includes(sp));
  const sort = (a, b) => String(a.nome).localeCompare(String(b.nome));
  const grams = active.reduce((a, sp) => a + Math.max(0, spoolRemaining(sp, D.usage)), 0);
  const value = active.reduce((a, sp) => a + Math.max(0, spoolRemaining(sp, D.usage)) * (spoolEurPerGram(sp) || 0), 0);
  // riepilogo per colore
  const byColor = {};
  for (const sp of active) {
    const k = `${sp.nome || 'Bobina'}|${sp.materiale || ''}|${sp.marca || ''}|${sp.hex || ''}`;
    byColor[k] = byColor[k] || { nome: sp.nome, materiale: sp.materiale, marca: sp.marca, hex: sp.hex, n: 0, g: 0 };
    byColor[k].n++; byColor[k].g += Math.max(0, spoolRemaining(sp, D.usage));
  }
  return D.spools.length ? `
    <div class="card">
      <div class="stats">
        <div class="stat"><small>Bobine in uso</small><b>${active.length}</b></div>
        <div class="stat"><small>Filamento rimasto</small><b>${nf(grams / 1000, 2)} kg</b></div>
        <div class="stat"><small>Valore in magazzino</small><b>${fmt(value)}</b></div>
        <div class="stat"><small>Colori</small><b>${Object.keys(byColor).length}</b></div>
      </div>
      ${Object.values(byColor).length ? `<table class="tbl" style="margin-top:10px">${Object.values(byColor).sort((a, b) => String(a.nome).localeCompare(String(b.nome))).map((c) =>
        `<tr><td><span class="swatch" style="background:${esc(c.hex || '#999')}"></span>${esc(c.nome || 'Bobina')} ${esc(c.materiale || '')}${c.marca ? ' ' + esc(c.marca) : ''} · ${c.n} bob.</td><td>${nf(c.g)} g</td></tr>`).join('')}</table>` : ''}
    </div>
    ${active.sort(sort).map((sp) => spoolCard(sp, D.usage)).join('')}
    ${done.length ? `<details><summary>Finite o archiviate (${done.length})</summary>${done.sort(sort).map((sp) => spoolCard(sp, D.usage)).join('')}</details>` : ''}`
    : '<div class="empty">Il magazzino è vuoto.<br>Tocca <b>+</b> per aggiungere le bobine che hai: il filamento verrà scalato ogni volta che metti un progetto in produzione.</div>';
}

let curSpool = null;
function openSpool(id) {
  const s = getSettings();
  curSpool = id ? { ...getRec('spools', id), isNew: false }
    : { id: uuid(), isNew: true, nome: '', materiale: 'PLA', hex: '#1f6feb', peso: 1000, prezzo: s.bobina, dataAcquisto: today(), esaurita: false };
  renderSpoolPage();
  show('spool');
  $('title').textContent = curSpool.isNew ? 'Nuova bobina' : 'Bobina';
}

function renderSpoolPage() {
  const sp = curSpool;
  const D = data();
  const used = D.projects.filter((p) => p.stato !== 'bozza' && p.filamenti.some((a) => a.spoolId === sp.id));
  const rem = spoolRemaining(sp, D.usage);
  $('spoolPage').innerHTML = `
    <div class="card">
      <label for="bNome">Colore / nome</label><input id="bNome" value="${esc(sp.nome)}" placeholder="es. Nero, Rosso fuoco">
      <div class="row2">
        <div><label for="bHex">Colore</label><input id="bHex" type="color" value="${esc(sp.hex || '#1f6feb')}"></div>
        <div><label for="bMat">Materiale</label><input id="bMat" value="${esc(sp.materiale || '')}" placeholder="PLA"></div>
      </div>
      <label for="bMarca">Marca</label><input id="bMarca" value="${esc(sp.marca || '')}" placeholder="es. Anycubic, Bambu Lab, eSun" list="marcheList">
      <datalist id="marcheList">${[...new Set(data().spools.map((x) => x.marca).filter(Boolean))].map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <div class="row2">
        <div><label for="bPeso">Peso iniziale (g)</label><input id="bPeso" inputmode="decimal" value="${numIt(sp.peso)}"></div>
        <div><label for="bPrezzo">Prezzo pagato (€)</label><input id="bPrezzo" inputmode="decimal" value="${numIt(sp.prezzo)}"></div>
      </div>
      <label for="bRim">Grammi rimasti adesso</label>
      <input id="bRim" inputmode="decimal" value="${numIt(Math.max(0, sp.isNew ? sp.peso : spoolRemaining(sp, data().usage)))}">
      <p class="note">Se la bobina è già stata usata prima dell'app, o pesandola il residuo è diverso, scrivi quanti grammi restano. Il costo al grammo resta quello d'acquisto (<span id="bUnit">${Number(sp.peso) > 0 ? fmt(sp.prezzo / sp.peso * 1000) + '/kg' : '–'}</span>).</p>
      <label for="bData">Data acquisto</label><input id="bData" type="date" value="${esc(sp.dataAcquisto || today())}">
      ${sp.isNew ? `<label for="bQty">Quante bobine uguali aggiungi?</label><input id="bQty" inputmode="numeric" value="1">` : `
        <label class="check" style="margin-top:14px"><input type="checkbox" id="bDone" ${sp.esaurita ? 'checked' : ''}> Bobina finita / archiviata</label>`}
    </div>
    ${sp.isNew ? '' : `<div class="card">
      <h2>Consumo</h2>
      <div class="line"><b>${nf(Math.max(0, rem))} g</b> rimasti su ${nf(sp.peso)} g${Number(sp.usatoPrima) > 0 ? ` · ${nf(sp.usatoPrima)} g usati prima dell'app o corretti a mano` : ''}</div>
      ${used.length ? `<table class="tbl" style="margin-top:8px">${used.map((p) => `<tr><td>${esc(p.nome)}</td><td>${nf(p.filamenti.filter((a) => a.spoolId === sp.id).reduce((a, x) => a + (Number(x.grammi) || 0), 0), 1)} g</td></tr>`).join('')}</table>` : '<p class="note">Ancora nessun progetto in produzione con questa bobina.</p>'}
    </div>`}
    <button class="btn" data-sact="save">Salva</button>
    <button class="btn ghost" data-sact="back">Annulla</button>
    ${sp.isNew ? '' : '<button class="btn danger" data-sact="delete">Elimina bobina</button>'}`;
}

async function spoolAction(act) {
  if (act === 'back') return go('spools');
  if (act === 'delete') {
    const D = data();
    const usedBy = D.projects.filter((p) => p.filamenti.some((a) => a.spoolId === curSpool.id)).length;
    if (!confirm(usedBy ? `Questa bobina è usata in ${usedBy} progetti: eliminarla? (I costi già calcolati non cambiano.) In alternativa puoi segnarla come finita.` : 'Eliminare questa bobina?')) return;
    del('spools', curSpool.id); await committed('Bobina eliminata'); return go('spools');
  }
  const nome = $('bNome').value.trim(), peso = parseNum($('bPeso').value), prezzo = parseNum($('bPrezzo').value);
  if (!nome) return toast('Scrivi il colore o un nome');
  if (!(peso > 0)) return toast('Peso non valido');
  if (!(prezzo >= 0)) return toast('Prezzo non valido');
  const rim = parseNum($('bRim').value);
  if (!isNaN(rim) && (rim < 0 || rim > peso)) return toast('I grammi rimasti devono stare tra 0 e il peso iniziale');
  const usedInApp = curSpool.isNew ? 0 : (data().usage[curSpool.id] || 0);
  const usatoPrima = isNaN(rim) ? (Number(curSpool.usatoPrima) || 0) : Math.max(0, peso - rim - usedInApp);
  const d = { nome, hex: $('bHex').value, materiale: $('bMat').value.trim(), marca: $('bMarca').value.trim(), peso, prezzo, usatoPrima,
    dataAcquisto: $('bData').value || today(), esaurita: $('bDone') ? $('bDone').checked : false };
  if (curSpool.isNew) {
    const qty = Math.max(1, Math.min(50, Math.floor(parseNum($('bQty').value) || 1)));
    for (let i = 0; i < qty; i++) put('spools', i === 0 ? curSpool.id : uuid(), d);
    await committed(qty > 1 ? `${qty} bobine aggiunte` : 'Bobina aggiunta');
  } else {
    put('spools', curSpool.id, d); await committed('Salvato');
  }
  go('spools');
}

let curAcc = null;
function openAcc(id) {
  curAcc = id ? { ...getRec('accessories', id), isNew: false } : { id: uuid(), isNew: true, nome: '', quantita: '', prezzo: '', dataAcquisto: today() };
  const D = data();
  const a = curAcc;
  const used = D.projects.filter((p) => p.stato !== 'bozza' && p.accessori.some((x) => x.accId === a.id));
  const rem = a.isNew ? null : accessoryRemaining(a, D.accUsage);
  $('accPage').innerHTML = `
    <div class="card">
      <label for="cNome">Nome accessorio</label><input id="cNome" value="${esc(a.nome)}" placeholder="es. Tag NFC, anelli portachiavi">
      <div class="row2">
        <div><label for="cQta">Quantità acquistata</label><input id="cQta" inputmode="numeric" value="${numIt(a.quantita)}" placeholder="20"></div>
        <div><label for="cPrezzo">Prezzo totale (€)</label><input id="cPrezzo" inputmode="decimal" value="${numIt(a.prezzo)}" placeholder="10"></div>
      </div>
      <div class="line" id="cUnit">${Number(a.quantita) > 0 ? `Costo unitario: ${fmt(accessoryUnitCost(a))}` : ''}</div>
      <label for="cRim">Pezzi disponibili adesso</label>
      <input id="cRim" inputmode="numeric" value="${a.isNew ? '' : numIt(Math.max(0, rem))}" placeholder="se vuoto: tutti quelli acquistati">
      <p class="note">Se alcuni li hai già usati prima dell'app, scrivi quanti te ne restano. Il costo di ognuno resta quello d'acquisto.</p>
      <label for="cData">Data acquisto</label><input id="cData" type="date" value="${esc(a.dataAcquisto || today())}">
    </div>
    ${a.isNew ? '' : `<div class="card"><h2>Utilizzo</h2>
      <div class="line"><b>${nf(Math.max(0, rem))}</b> disponibili su ${nf(a.quantita)}${Number(a.usatiPrima) > 0 ? ` · ${nf(a.usatiPrima)} usati prima dell'app o corretti a mano` : ''}</div>
      ${used.length ? `<table class="tbl" style="margin-top:8px">${used.map((p) => `<tr><td>${esc(p.nome)}</td><td>${nf(p.accessori.filter((x) => x.accId === a.id).reduce((t, x) => t + (Number(x.qta) || 0), 0))}</td></tr>`).join('')}</table>` : '<p class="note">Ancora non usato in nessun progetto in produzione.</p>'}
      <p class="note">Quando ne compri altri, aggiungi un nuovo acquisto: così il costo unitario resta quello reale di ogni lotto.</p></div>`}
    <button class="btn" data-aact="save">Salva</button>
    <button class="btn ghost" data-aact="back">Annulla</button>
    ${a.isNew ? '' : '<button class="btn danger" data-aact="delete">Elimina</button>'}`;
  show('acc');
  $('title').textContent = a.isNew ? 'Nuovo accessorio' : 'Accessorio';
}

async function accAction(act) {
  if (act === 'back') return go('spools');
  if (act === 'delete') {
    const used = data().projects.filter((p) => p.accessori.some((x) => x.accId === curAcc.id)).length;
    if (!confirm(used ? `È usato in ${used} progetti: eliminarlo? (I costi già calcolati non cambiano.)` : 'Eliminare questo accessorio?')) return;
    del('accessories', curAcc.id); await committed('Eliminato'); return go('spools');
  }
  const nome = $('cNome').value.trim(), quantita = parseNum($('cQta').value), prezzo = parseNum($('cPrezzo').value);
  if (!nome) return toast('Scrivi il nome');
  if (!(quantita > 0)) return toast('Quantità non valida');
  if (!(prezzo >= 0)) return toast('Prezzo non valido');
  const rim = parseNum($('cRim').value);
  if (!isNaN(rim) && (rim < 0 || rim > quantita)) return toast('I pezzi disponibili devono stare tra 0 e la quantità acquistata');
  const usedInApp = curAcc.isNew ? 0 : (data().accUsage[curAcc.id] || 0);
  const usatiPrima = isNaN(rim) ? (Number(curAcc.usatiPrima) || 0) : Math.max(0, quantita - rim - usedInApp);
  put('accessories', curAcc.id, { nome, quantita, prezzo, usatiPrima, dataAcquisto: $('cData').value || today() });
  await committed(curAcc.isNew ? 'Accessorio aggiunto' : 'Salvato');
  go('spools');
}

// ---------------------------------------------------------------------------
// Guadagni
// ---------------------------------------------------------------------------
function chartSvg(mesi) {
  const W = 340, H = 170, pad = 22, bw = 18;
  const max = Math.max(1, ...mesi.map((m) => Math.max(m.ricavi, m.costi)));
  const step = (W - pad * 2) / mesi.length;
  let bars = '';
  mesi.forEach((m, i) => {
    const x = pad + i * step + step / 2;
    const hr = (H - 40) * m.ricavi / max, hc = (H - 40) * m.costi / max;
    const [y, mo] = m.mese.split('-');
    bars += `<rect x="${x - bw - 1}" y="${H - 22 - hr}" width="${bw}" height="${hr}" rx="3" fill="var(--ok)"><title>Incassi ${fmt(m.ricavi)}</title></rect>
      <rect x="${x + 1}" y="${H - 22 - hc}" width="${bw}" height="${hc}" rx="3" fill="var(--bad)" opacity=".8"><title>Costi ${fmt(m.costi)}</title></rect>
      <text x="${x}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${MESI[Number(mo) - 1]}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Incassi e costi per mese">
    <line x1="${pad}" x2="${W - pad}" y1="${H - 22}" y2="${H - 22}" stroke="var(--border)"/>${bars}</svg>`;
}

function renderMoney() {
  const D = data();
  const E = economics({ projects: D.projects, sales: D.sales, spools: D.spools, accessories: D.accessories, s: D.s });
  const pezziVenduti = D.sales.reduce((a, v) => a + (Number(v.pezzi) || 0), 0);
  const bilancio = E.saldo + E.valoreMagazzino + E.valoreAccessori;   // soldi reali + magazzino che hai ancora
  let cls, titolo, frase;
  if (bilancio >= 0) {
    cls = 'good'; titolo = `Sei in guadagno di ${fmt(bilancio)}`;
    frase = 'Le vendite hanno ripagato stampante, energia e bobine. Da qui in avanti è guadagno.';
  } else if (E.margine > 0) {
    cls = 'mid'; titolo = `Devi ancora recuperare ${fmt(-bilancio)}`;
    frase = `I pezzi venduti rendono più di quanto costano (<b class="pos">${fmtSigned(E.margine)}</b>), ma non hanno ancora ripagato tutto l'investimento (stampante e bobine).`;
  } else if (E.vendite === 0 && E.pezziProdotti === 0) {
    cls = 'mid'; titolo = `Investimento iniziale: ${fmt(-bilancio)}`;
    frase = 'Non hai ancora prodotto né venduto nulla: qui vedrai come rientri delle spese.';
  } else {
    cls = 'bad'; titolo = `Per ora sei in perdita di ${fmt(-bilancio)}`;
    frase = `Le vendite (${fmt(E.vendite)}) non coprono ancora filamento, energia e accessori consumati (${fmt(E.filamento + E.energia + E.accessori)}).`;
  }
  const mediaPezzo = pezziVenduti > 0 ? E.margine / pezziVenduti : null;
  const mancaStampante = Math.max(0, E.stampante - E.margine);
  const pezziMancanti = mediaPezzo && mediaPezzo > 0 ? Math.ceil(mancaStampante / mediaPezzo) : null;
  const scartiMsg = E.pezziProdotti > 0
    ? `${nf(E.scartiPezzi)} pezzi su ${nf(E.pezziProdotti)} (${nf(E.scartoRealePerc, 1)}%, stima ${nf(D.s.fallite, 1)}%)`
    : 'nessun pezzo prodotto';

  $('moneyPage').innerHTML = `
    <div class="card hero ${cls}">
      <div class="big ${bilancio >= 0 ? 'pos' : 'neg'}">${fmtSigned(bilancio)}</div>
      <h2 style="margin-top:4px">${titolo}</h2>
      <div class="note" style="color:var(--text)">${frase}</div>
    </div>

    <div class="card">
      <h2>🖨️ Stampante ripagata: ${nf(E.ripagata * 100)}%</h2>
      <div class="bar"><div style="width:${E.ripagata * 100}%;background:var(--ok)"></div></div>
      <div class="line">${mancaStampante > 0
        ? `Mancano <b>${fmt(mancaStampante)}</b> di margine${pezziMancanti ? `: circa <b>${nf(pezziMancanti)} pezzi</b> al tuo guadagno medio di ${fmt(mediaPezzo)} a pezzo` : ''}.`
        : 'Stampante completamente ripagata! 🎉'}</div>
    </div>

    <div class="card">
      <h2>Incassi e costi per mese</h2>
      ${chartSvg(E.mesi)}
      <div class="chart-legend"><span><i style="background:var(--ok)"></i>Incassi</span><span><i style="background:var(--bad)"></i>Costi di produzione</span></div>
    </div>

    <div class="card">
      <h2>Entrate e uscite</h2>
      <table class="tbl">
        <tr><td>💶 Incassato (${nf(pezziVenduti)} pezzi venduti)</td><td class="pos">${fmtSigned(E.vendite)}</td></tr>
        <tr><td>🧵 Bobine acquistate</td><td class="neg">${fmtSigned(-E.speseBobine)}</td></tr>
        <tr><td>🔩 Accessori acquistati</td><td class="neg">${fmtSigned(-E.speseAccessori)}</td></tr>
        <tr><td>⚡ Energia consumata</td><td class="neg">${fmtSigned(-E.energia)}</td></tr>
        <tr><td>🖨️ Stampante</td><td class="neg">${fmtSigned(-E.stampante)}</td></tr>
        <tr><td>📦 Filamento ancora in magazzino (${nf(E.grammiMagazzino / 1000, 2)} kg)</td><td class="pos">${fmtSigned(E.valoreMagazzino)}</td></tr>
        <tr><td>📦 Accessori ancora in magazzino</td><td class="pos">${fmtSigned(E.valoreAccessori)}</td></tr>
        <tr><td><b>Bilancio</b></td><td class="${bilancio >= 0 ? 'pos' : 'neg'}">${fmtSigned(bilancio)}</td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Dettagli di produzione</h2>
      <div class="stats">
        <div class="stat"><small>Margine sui pezzi</small><b class="${E.margine >= 0 ? 'pos' : 'neg'}">${fmtSigned(E.margine)}</b></div>
        <div class="stat"><small>Filamento usato</small><b>${fmt(E.filamento)}</b></div>
        <div class="stat"><small>Accessori usati</small><b>${fmt(E.accessori)}</b></div>
        <div class="stat"><small>Energia</small><b>${fmt(E.energia)}</b></div>
        <div class="stat"><small>🎁 Regali</small><b class="neg">${fmt(E.regali)}</b></div>
        <div class="stat"><small>🎁 Recuperato</small><b class="pos">${fmt(E.recuperato)}</b></div>
        <div class="stat"><small>🗑️ Scarti</small><b class="neg">${fmt(E.scartiCosto)}</b></div>
        <div class="stat"><small>Pezzi da vendere</small><b>${nf(E.invendutiPezzi)}</b></div>
      </div>
      <div class="breakdown">
        Scarti: ${scartiMsg}${E.pezziProdotti > 0 && E.scartoRealePerc > Number(D.s.fallite) ? ' — <b class="neg">più della stima: valuta di alzare la % in Impostazioni</b>' : ''}.<br>
        Pezzi pronti ma non ancora venduti: ${nf(E.invendutiPezzi)} (costo ${fmt(E.invendutiCosto)}).<br>
        Ammortamento maturato: ${fmt(E.ammortamento)} (quota della stampante "consumata" dalle ore di stampa).
      </div>
    </div>
    <p class="note" style="padding:0 4px">Il <b>bilancio</b> confronta i soldi incassati con quelli spesi davvero (stampante, bobine, accessori, energia) e aggiunge il valore di ciò che hai ancora in magazzino. Di bobine e accessori già in parte usati prima dell'app si conta solo la parte usata da quando c'è l'app. Il <b>margine sui pezzi</b> è incassato meno filamento, energia e accessori usati, regali e scarti compresi.</p>`;
}

// ---------------------------------------------------------------------------
// Impostazioni
// ---------------------------------------------------------------------------
const SETTING_FIELDS = {
  energia: 'sEnergia', consumo: 'sConsumo', bobina: 'sBobina', fallite: 'sFallite', stampante: 'sStampante',
  oreAmm: 'sOreAmm', ricLancio: 'sRicLancio', ricStd: 'sRicStd', ricPers: 'sRicPers'
};
function fillSettings(force) {
  const active = document.activeElement;
  if (!force && currentView === 'settings' && active && active.tagName === 'INPUT') return;
  const s = getSettings();
  for (const [k, id] of Object.entries(SETTING_FIELDS)) $(id).value = numIt(s[k]);
}
async function saveSettings() {
  const now = Date.now();
  const s = getSettings();
  let changed = 0;
  for (const [k, id] of Object.entries(SETTING_FIELDS)) {
    const v = parseNum($(id).value);
    if (isNaN(v) || v < 0) return toast('Valore non valido: ' + $(id).previousElementSibling.textContent);
    if (k === 'oreAmm' && v === 0) return toast('Le ore di ammortamento non possono essere 0');
    if (Math.abs(v - s[k]) > 1e-12) {
      db.run('UPDATE settings SET value = ?, updated_at = ?, dirty = 1 WHERE key = ?', [v, now, k]);
      changed++;
    }
  }
  if (!changed) return toast('Nessuna modifica');
  fillSettings(true);
  await committed('Impostazioni salvate');
}

// ---------------------------------------------------------------------------
// Eventi, login, avvio
// ---------------------------------------------------------------------------
function bindEvents() {
  $('projectsList').addEventListener('click', (e) => { const c = e.target.closest('[data-project]'); if (c) openProject(c.dataset.project, 'projects'); });
  $('historyList').addEventListener('click', (e) => { const c = e.target.closest('[data-project]'); if (c) openProject(c.dataset.project, 'history'); });
  $('spoolsPage').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { magTab = t.dataset.tab; renderSpools(); return; }
    const c = e.target.closest('[data-spool]'); if (c) return openSpool(c.dataset.spool);
    const a = e.target.closest('[data-acc]'); if (a) openAcc(a.dataset.acc);
  });
  $('spoolPage').addEventListener('input', () => { const pe = parseNum($('bPeso')?.value), pr = parseNum($('bPrezzo')?.value); if ($('bUnit')) $('bUnit').textContent = pe > 0 && pr >= 0 ? `${fmt(pr / pe * 1000)}/kg` : '–'; });
  $('spoolPage').addEventListener('click', (e) => { const b = e.target.closest('[data-sact]'); if (b) spoolAction(b.dataset.sact); });
  $('searchProjects').addEventListener('input', renderProjects);
  $('searchHistory').addEventListener('input', renderHistory);
  $('fab').addEventListener('click', () => currentView === 'spools' ? (magTab === 'acc' ? openAcc(null) : openSpool(null)) : openProject(null, 'projects'));
  $('accPage').addEventListener('click', (e) => { const b = e.target.closest('[data-aact]'); if (b) accAction(b.dataset.aact); });
  $('accPage').addEventListener('input', () => { const q = parseNum($('cQta')?.value), pr = parseNum($('cPrezzo')?.value); if ($('cUnit')) $('cUnit').textContent = q > 0 && pr >= 0 ? `Costo unitario: ${fmt(pr / q)}` : ''; });
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  bindProjectPage();
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('syncBtn').addEventListener('click', sync);
  $('forceSyncBtn').addEventListener('click', sync);
  $('logoutBtn').addEventListener('click', async () => {
    if (!confirm('Vuoi uscire? Le modifiche non ancora inviate restano salvate su questo telefono.')) return;
    stopListeners(); await signOut(auth);
  });
  $('loginBtn').addEventListener('click', login);
  $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  window.addEventListener('online', () => { updateStatus(); sync(); });
  window.addEventListener('offline', updateStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
}

async function login() {
  const email = $('loginEmail').value.trim(), pass = $('loginPass').value;
  $('loginErr').textContent = '';
  if (!allowed(email)) { $('loginErr').textContent = 'Questa email non è tra quelle autorizzate.'; return; }
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    const map = {
      'auth/invalid-credential': 'Email o password errate.',
      'auth/wrong-password': 'Password errata.',
      'auth/user-not-found': 'Utente non trovato: crealo nella console Firebase.',
      'auth/network-request-failed': 'Serve la connessione internet per il primo accesso.',
      'auth/too-many-requests': 'Troppi tentativi, riprova tra qualche minuto.'
    };
    $('loginErr').textContent = map[e.code] || ('Errore: ' + (e.code || e.message));
  }
}

async function start() {
  bindEvents();
  try {
    await openLocalDb();
  } catch (e) {
    $('v-loading').innerHTML = '<div class="empty">Impossibile avviare il database locale. Apri l\'app una volta con internet attivo.</div>';
    console.error(e);
    return;
  }
  fillSettings(true); updateStatus();

  if (!configured) {
    show('login');
    $('loginErr').textContent = 'App non ancora configurata: compila firebase-config.js (vedi LEGGIMI).';
    $('loginBtn').disabled = true;
    return;
  }
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  fs = getFirestore(app);
  onAuthStateChanged(auth, async (user) => {
    if (user && !allowed(user.email)) {
      await signOut(auth);
      show('login'); $('loginErr').textContent = 'Account non autorizzato.';
      return;
    }
    currentUser = user;
    if (user) {
      $('accountInfo').textContent = 'Connesso come ' + user.email;
      go('projects'); updateStatus();
      startListeners();
      sync();
    } else {
      stopListeners();
      show('login'); updateStatus();
    }
  });
}

start();
