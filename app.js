import { firebaseConfig, ALLOWED_EMAILS } from './firebase-config.js';
import { DEFAULT_SETTINGS, parseNum, calc, remoteWins } from './calc.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, writeBatch, onSnapshot
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';

const SQLJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.17.0/';
const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const fmt = (n) => (n === null || n === undefined || isNaN(n)) ? '–' : eur.format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const allowed = (email) => ALLOWED_EMAILS.map((e) => e.toLowerCase().trim()).includes(String(email || '').toLowerCase());
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

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
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, nome TEXT, pezzi REAL, grammi REAL, ore REAL, prezzo REAL,
  updated_at INTEGER DEFAULT 0, updated_by TEXT, deleted INTEGER DEFAULT 0, dirty INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`;

async function openLocalDb() {
  const SQL = await window.initSqlJs({ locateFile: (f) => SQLJS_BASE + f });
  const saved = await idbGet('sqlite');
  db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
  db.exec(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.run('INSERT OR IGNORE INTO settings (key, value, updated_at, dirty) VALUES (?, ?, 0, 0)', [k, v]);
  }
  await persist();
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
function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) s[r.key] = Number(r.value);
  return s;
}
function pendingCount() {
  return one(`SELECT (SELECT COUNT(*) FROM products WHERE dirty = 1) +
                     (SELECT COUNT(*) FROM settings WHERE dirty = 1) AS n`).n;
}

// ---------------------------------------------------------------------------
// Firebase + sincronizzazione
// ---------------------------------------------------------------------------
const configured = !Object.values(firebaseConfig).some((v) => String(v).includes('INCOLLA_QUI'));
let auth, fs, currentUser = null;
let syncing = false, syncAgain = false, lastError = null;
let unsubs = [];

function applyRemoteProducts(docs) {
  let changed = false;
  for (const d of docs) {
    const r = d.data();
    const local = one('SELECT updated_at, dirty FROM products WHERE id = ?', [d.id]);
    if (!remoteWins(local, r.updatedAt)) continue;
    db.run(`INSERT OR REPLACE INTO products
      (id, nome, pezzi, grammi, ore, prezzo, updated_at, updated_by, deleted, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [d.id, r.nome ?? '', r.pezzi ?? 0, r.grammi ?? 0, r.ore ?? 0,
       (r.prezzo === undefined ? null : r.prezzo), Number(r.updatedAt) || 0, r.updatedBy ?? '', r.deleted ? 1 : 0]);
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
  const ps = all('SELECT * FROM products WHERE dirty = 1');
  const ss = all('SELECT * FROM settings WHERE dirty = 1');
  if (!ps.length && !ss.length) return;
  const b = writeBatch(fs);
  for (const p of ps) {
    b.set(doc(fs, 'products', p.id), {
      nome: p.nome ?? '', pezzi: p.pezzi ?? 0, grammi: p.grammi ?? 0, ore: p.ore ?? 0,
      prezzo: p.prezzo ?? null, updatedAt: p.updated_at, updatedBy: p.updated_by ?? '', deleted: !!p.deleted
    });
  }
  for (const s of ss) b.set(doc(fs, 'settings', s.key), { value: s.value, updatedAt: s.updated_at });
  await b.commit();
  // Segno come inviati solo i record non modificati di nuovo nel frattempo
  for (const p of ps) db.run('UPDATE products SET dirty = 0 WHERE id = ? AND updated_at = ?', [p.id, p.updated_at]);
  for (const s of ss) db.run('UPDATE settings SET dirty = 0 WHERE key = ? AND updated_at = ?', [s.key, s.updated_at]);
}

async function sync() {
  if (!currentUser || !fs) return;
  if (!navigator.onLine) { updateStatus(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; updateStatus();
  try {
    // 1) scarico dal cloud (le modifiche più recenti vincono)
    const [ps, ss] = await Promise.all([getDocs(collection(fs, 'products')), getDocs(collection(fs, 'settings'))]);
    applyRemoteProducts(ps.docs);
    applyRemoteSettings(ss.docs, true);
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
  unsubs.push(onSnapshot(collection(fs, 'products'), (snap) => {
    if (applyRemoteProducts(snap.docs)) { persist(); refreshAll(); updateStatus(); }
  }, onErr));
  unsubs.push(onSnapshot(collection(fs, 'settings'), (snap) => {
    if (applyRemoteSettings(snap.docs, false)) { persist(); refreshAll(); updateStatus(); }
  }, onErr));
}
function stopListeners() { unsubs.forEach((u) => u()); unsubs = []; }

// ---------------------------------------------------------------------------
// Interfaccia
// ---------------------------------------------------------------------------
const VIEWS = ['loading', 'login', 'list', 'edit', 'settings'];
let currentView = 'loading';
let editingId = null;

function show(view) {
  currentView = view;
  for (const v of VIEWS) $('v-' + v).classList.toggle('hidden', v !== view);
  const inApp = !['loading', 'login'].includes(view);
  $('nav').classList.toggle('hidden', !inApp);
  $('fab').classList.toggle('hidden', view !== 'list');
  document.querySelectorAll('nav button').forEach((b) => {
    const active = (b.dataset.view === view) || (b.dataset.view === 'calc' && view === 'edit' && !editingId);
    b.classList.toggle('active', active);
  });
  $('title').textContent = view === 'settings' ? 'Impostazioni' : view === 'edit' ? (editingId ? 'Modifica' : 'Calcola') : 'Listino 3D';
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

function updateStatus() {
  if (!db) return;
  const dot = $('syncDot'), txt = $('syncText');
  const n = pendingCount();
  let cls = 'ok', label = 'Sincronizzato';
  if (!currentUser) { cls = ''; label = 'Non connesso'; }
  else if (!navigator.onLine) { cls = 'bad'; label = n ? `Offline · ${n} da inviare` : 'Offline'; }
  else if (syncing) { cls = 'warn'; label = 'Sincronizzo…'; }
  else if (lastError) { cls = 'bad'; label = 'Errore sync'; }
  else if (n) { cls = 'warn'; label = `${n} da inviare`; }
  dot.className = 'dot ' + cls; txt.textContent = label;
  const last = one("SELECT value FROM meta WHERE key = 'lastSync'");
  $('lastSyncInfo').textContent = last ? 'Ultima sincronizzazione: ' + new Date(Number(last.value)).toLocaleString('it-IT') : 'Mai sincronizzato';
  if (lastError && currentView === 'settings') $('lastSyncInfo').textContent += ' — errore: ' + (lastError.code || lastError.message);
}

function renderList() {
  const s = getSettings();
  const q = $('search').value.trim().toLowerCase();
  const rows = all('SELECT * FROM products WHERE deleted = 0 ORDER BY nome COLLATE NOCASE')
    .filter((p) => !q || String(p.nome).toLowerCase().includes(q));
  if (!rows.length) {
    $('list').innerHTML = `<div class="empty">${q ? 'Nessun prodotto trovato.' : 'Il listino è vuoto.<br>Tocca <b>+</b> per aggiungere il primo prodotto.'}</div>`;
    return;
  }
  $('list').innerHTML = rows.map((p) => {
    const r = calc(p, s);
    let mine = '';
    if (r && p.prezzo !== null && p.prezzo !== undefined) {
      const g = p.prezzo - r.costo;
      mine = `<div class="mine">Vendi a <b>${fmt(p.prezzo)}</b> · guadagno <b class="${g >= 0 ? 'pos' : 'neg'}">${fmt(g)}</b> a pezzo</div>`;
    }
    const who = p.updated_by ? `<div class="mine" style="font-size:12px">Modificato da ${esc(String(p.updated_by).split('@')[0])}</div>` : '';
    return `<div class="card prod" data-id="${esc(p.id)}">
      <div class="prod-top"><div class="prod-name">${esc(p.nome)}</div><div class="prod-cost">costo ${r ? fmt(r.costo) : '–'}</div></div>
      <div class="prices">
        <div class="price"><small>Lancio</small><b>${r ? fmt(r.lancio) : '–'}</b></div>
        <div class="price"><small>Standard</small><b>${r ? fmt(r.standard) : '–'}</b></div>
        <div class="price"><small>Personal.</small><b>${r ? fmt(r.personalizzato) : '–'}</b></div>
      </div>${mine}${who}</div>`;
  }).join('');
}

const SETTING_FIELDS = {
  energia: 'sEnergia', consumo: 'sConsumo', bobina: 'sBobina', fallite: 'sFallite', stampante: 'sStampante',
  oreAmm: 'sOreAmm', ricLancio: 'sRicLancio', ricStd: 'sRicStd', ricPers: 'sRicPers'
};
const numIt = (n) => String(Math.round(n * 10000) / 10000).replace('.', ',');

function fillSettings(force) {
  const active = document.activeElement;
  if (!force && currentView === 'settings' && active && active.tagName === 'INPUT') return; // non disturbo chi sta scrivendo
  const s = getSettings();
  for (const [k, id] of Object.entries(SETTING_FIELDS)) $(id).value = numIt(s[k]);
}

function readForm() {
  const ore = parseNum($('fOre').value) || 0;
  const min = parseNum($('fMin').value) || 0;
  const prezzoRaw = $('fPrezzo').value.trim();
  return {
    nome: $('fNome').value.trim(),
    pezzi: parseNum($('fPezzi').value),
    grammi: parseNum($('fGrammi').value),
    ore: ore + min / 60,
    prezzo: prezzoRaw === '' ? null : parseNum(prezzoRaw)
  };
}

function recalcPreview() {
  const p = readForm();
  const r = (p.ore > 0) ? calc(p, getSettings()) : null;
  $('rCosto').textContent = r ? fmt(r.costo) : '–';
  $('rLancio').textContent = r ? fmt(r.lancio) : '–';
  $('rStd').textContent = r ? fmt(r.standard) : '–';
  $('rPers').textContent = r ? fmt(r.personalizzato) : '–';
  if (!r) { $('rBreak').innerHTML = 'Inserisci pezzi, grammi e tempo di stampa.'; return; }
  let html = `Filamento ${fmt(r.filamento)} · Energia ${fmt(r.energia)} · Ammortamento ${fmt(r.ammortamento)}`;
  if (p.prezzo !== null && !isNaN(p.prezzo)) {
    const g = p.prezzo - r.costo;
    html += `<br>Al tuo prezzo guadagni <b class="${g >= 0 ? 'pos' : 'neg'}">${fmt(g)}</b> a pezzo`;
  }
  $('rBreak').innerHTML = html;
}

function openEdit(id) {
  editingId = id || null;
  const p = id ? one('SELECT * FROM products WHERE id = ?', [id]) : null;
  $('editTitle').textContent = p ? 'Modifica prodotto' : 'Nuovo calcolo';
  $('fNome').value = p ? p.nome : '';
  $('fPezzi').value = p ? numIt(p.pezzi) : '';
  $('fGrammi').value = p ? numIt(p.grammi) : '';
  if (p) {
    let h = Math.floor(p.ore + 1e-9), m = Math.round((p.ore - h) * 60);
    if (m === 60) { h += 1; m = 0; }
    $('fOre').value = h; $('fMin').value = m;
  } else { $('fOre').value = ''; $('fMin').value = ''; }
  $('fPrezzo').value = p && p.prezzo !== null ? numIt(p.prezzo) : '';
  $('deleteBtn').classList.toggle('hidden', !p);
  show('edit');
  recalcPreview();
}

async function saveProduct() {
  const p = readForm();
  if (!p.nome) return toast('Scrivi il nome del prodotto');
  if (!(p.pezzi > 0) || !(p.grammi >= 0) || !(p.ore > 0)) return toast('Controlla pezzi, grammi e tempo');
  if (p.prezzo !== null && isNaN(p.prezzo)) return toast('Prezzo non valido');
  const id = editingId || uuid();
  db.run(`INSERT OR REPLACE INTO products
    (id, nome, pezzi, grammi, ore, prezzo, updated_at, updated_by, deleted, dirty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
    [id, p.nome, p.pezzi, p.grammi, p.ore, p.prezzo, Date.now(), currentUser?.email || '']);
  await persist();
  toast('Salvato');
  editingId = null;
  renderList(); show('list'); updateStatus();
  sync();
}

async function deleteProduct() {
  if (!editingId || !confirm('Eliminare questo prodotto dal listino di entrambi?')) return;
  db.run('UPDATE products SET deleted = 1, dirty = 1, updated_at = ?, updated_by = ? WHERE id = ?',
    [Date.now(), currentUser?.email || '', editingId]);
  await persist();
  toast('Eliminato');
  editingId = null;
  renderList(); show('list'); updateStatus();
  sync();
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
  await persist();
  toast('Impostazioni salvate');
  fillSettings(true); renderList(); updateStatus();
  sync();
}

function refreshAll() {
  renderList();
  fillSettings(false);
  if (currentView === 'edit') recalcPreview();
}

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------
function bindEvents() {
  $('list').addEventListener('click', (e) => {
    const c = e.target.closest('.prod'); if (c) openEdit(c.dataset.id);
  });
  $('search').addEventListener('input', renderList);
  $('fab').addEventListener('click', () => openEdit(null));
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.view;
    if (v === 'calc') openEdit(null);
    else if (v === 'settings') { fillSettings(true); show('settings'); updateStatus(); }
    else { renderList(); show('list'); }
  }));
  ['fNome', 'fPezzi', 'fGrammi', 'fOre', 'fMin', 'fPrezzo'].forEach((id) => $(id).addEventListener('input', recalcPreview));
  $('saveBtn').addEventListener('click', saveProduct);
  $('cancelBtn').addEventListener('click', () => { editingId = null; renderList(); show('list'); });
  $('deleteBtn').addEventListener('click', deleteProduct);
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
  if (!allowed(email)) { $('loginErr').textContent = 'Questa email non è tra quelle autorizzate in firebase-config.js.'; return; }
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

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function start() {
  bindEvents();
  try {
    await openLocalDb();
  } catch (e) {
    $('v-loading').innerHTML = '<div class="empty">Impossibile avviare il database locale. Apri l\'app una volta con internet attivo.</div>';
    console.error(e);
    return;
  }
  renderList(); fillSettings(true); updateStatus();

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
      show('list'); renderList(); updateStatus();
      startListeners();
      sync();
    } else {
      stopListeners();
      show('login'); updateStatus();
    }
  });
}

start();
