// Logica pura (senza interfaccia): costi, prezzi, bobine, regali, scarti e guadagni.

export const DEFAULT_SETTINGS = {
  energia: 0.25,     // €/kWh
  consumo: 0.15,     // kWh per ora di stampa
  bobina: 40,        // € per kg (usato quando un progetto non ha bobine del magazzino assegnate)
  stampante: 900,    // € costo stampante
  oreAmm: 3000,      // ore di ammortamento
  fallite: 10,       // % stampe fallite (stima)
  ricLancio: 2.5,    // ricarico prezzo di lancio
  ricStd: 3.5,       // ricarico prezzo standard
  ricPers: 5         // ricarico prezzo personalizzato
};

export function parseNum(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim().replace(/\s/g, '').replace('€', '').replace(',', '.');
  if (s === '') return NaN;
  return Number(s);
}

export const round10c = (x) => Math.round(x * 10 + 1e-9) / 10;
const num = (v) => Number(v) || 0;
const failFactor = (s) => 1 + num(s.fallite) / 100;

// € al grammo di una bobina del magazzino
export function spoolEurPerGram(sp) {
  return sp && num(sp.peso) > 0 ? num(sp.prezzo) / num(sp.peso) : null;
}

// Costo del filamento (senza % fallite). Usa il prezzo reale delle bobine assegnate;
// i grammi non assegnati a una bobina si calcolano col prezzo €/kg delle impostazioni.
export function filamentBaseCost(p, s, spoolsById = {}) {
  const tot = num(p.grammi);
  let cost = 0, alloc = 0;
  for (const a of p.filamenti || []) {
    const g = num(a.grammi);
    if (g <= 0) continue;
    const e = spoolEurPerGram(spoolsById[a.spoolId]);
    cost += g * (e ?? s.bobina / 1000);
    alloc += g;
  }
  if (tot > alloc) cost += (tot - alloc) * s.bobina / 1000;
  return cost;
}

// Costo unitario di un accessorio comprato all'ingrosso (es. 20 tag NFC a 10 € = 0,50 €)
export function accessoryUnitCost(acc) {
  return acc && num(acc.quantita) > 0 ? num(acc.prezzo) / num(acc.quantita) : 0;
}

// Costo degli accessori usati in tutto il progetto
export function accessoriesCost(p, accById = {}) {
  let c = 0;
  for (const a of p.accessori || []) c += num(a.qta) * accessoryUnitCost(accById[a.accId]);
  return c;
}

// Costi totali del piatto/progetto (filamento, energia, ammortamento con % fallite; accessori).
export function projectCosts(p, s, spoolsById = {}, accById = {}) {
  const pezzi = Number(p.pezzi), ore = Number(p.ore), grammi = Number(p.grammi);
  if (!(pezzi > 0) || !(ore >= 0) || !(grammi >= 0)) return null;
  const f = failFactor(s);
  const filamento = filamentBaseCost(p, s, spoolsById) * f;
  const energia = ore * s.consumo * s.energia * f;
  const ammortamento = s.oreAmm > 0 ? ore * s.stampante / s.oreAmm * f : 0;
  const accessori = accessoriesCost(p, accById);
  return { filamento, energia, ammortamento, accessori, totale: filamento + energia + ammortamento + accessori };
}

// Costi del progetto: congelati se già in produzione, altrimenti calcolati ora.
export function effectiveCosts(p, s, spoolsById = {}, accById = {}) {
  if (p.stato && p.stato !== 'bozza' && p.costi) return p.costi;
  return projectCosts(p, s, spoolsById, accById);
}

// Prezzi per pezzo: costo × ricarico + eventuale quota di recupero regali (arrotondati a 10 cent).
export function priceInfo(costi, pezzi, recuperoEuro, s) {
  if (!costi || !(pezzi > 0)) return null;
  const costoPezzo = costi.totale / pezzi;
  const recuperoPezzo = num(recuperoEuro) / pezzi;
  return {
    costoPezzo, recuperoPezzo,
    filamento: costi.filamento / pezzi, energia: costi.energia / pezzi, ammortamento: costi.ammortamento / pezzi,
    accessori: num(costi.accessori) / pezzi,
    lancio: round10c(costoPezzo * s.ricLancio + recuperoPezzo),
    standard: round10c(costoPezzo * s.ricStd + recuperoPezzo),
    personalizzato: round10c(costoPezzo * s.ricPers + recuperoPezzo)
  };
}

// Compatibilità con la prima versione: costo e prezzi per pezzo.
export function calc(p, s, spoolsById = {}) {
  const c = projectCosts(p, s, spoolsById);
  if (!c) return null;
  const pi = priceInfo(c, Number(p.pezzi), 0, s);
  return { ...pi, costo: pi.costoPezzo };
}

const prodotto = (p) => p.stato === 'produzione' || p.stato === 'completato';

// Grammi consumati per ogni bobina (solo progetti messi in produzione).
export function spoolUsage(projects) {
  const u = {};
  for (const p of projects) {
    if (!prodotto(p)) continue;
    for (const a of p.filamenti || []) u[a.spoolId] = (u[a.spoolId] || 0) + num(a.grammi);
  }
  return u;
}

// Rimanente = peso acquistato - grammi usati prima dell'app - grammi usati nei progetti
export function spoolRemaining(sp, usage) {
  return num(sp.peso) - num(sp.usatoPrima) - (usage[sp.id] || 0);
}

// Accessori consumati (solo progetti messi in produzione)
export function accessoryUsage(projects) {
  const u = {};
  for (const p of projects) {
    if (!prodotto(p)) continue;
    for (const a of p.accessori || []) u[a.accId] = (u[a.accId] || 0) + num(a.qta);
  }
  return u;
}

export function accessoryRemaining(acc, usage) {
  return num(acc.quantita) - num(acc.usatiPrima) - (usage[acc.id] || 0);
}

// Quota del prezzo d'acquisto che riguarda ciò che è stato usato DOPO l'inizio dell'app
// (quello consumato prima, con le relative vendite, resta fuori dai conti).
export const spoolTrackedCost = (sp) => num(sp.peso) > 0 ? num(sp.prezzo) * Math.max(0, num(sp.peso) - num(sp.usatoPrima)) / num(sp.peso) : 0;
export const accessoryTrackedCost = (a) => num(a.quantita) > 0 ? num(a.prezzo) * Math.max(0, num(a.quantita) - num(a.usatiPrima)) / num(a.quantita) : 0;

// Regali da recuperare: costo, quota per pezzo, pezzi già usati per il recupero e rimanenti.
export function giftStatus(projects) {
  const absorbed = {};
  for (const p of projects) {
    if (!prodotto(p) || p.regalo) continue;
    for (const r of p.recupero || []) absorbed[r.giftId] = (absorbed[r.giftId] || 0) + num(r.pezzi);
  }
  return projects
    .filter((g) => g.regalo && prodotto(g) && g.costi && num(g.recuperoPezzi) > 0)
    .sort((a, b) => num(a.prodottoAt) - num(b.prodottoAt))
    .map((g) => {
      const n = num(g.recuperoPezzi);
      const usati = Math.min(n, absorbed[g.id] || 0);
      return { id: g.id, nome: g.nome, costo: g.costi.totale, n, perPezzo: g.costi.totale / n, usati, rimanenti: n - usati };
    });
}

// Distribuisce il recupero dei regali (dal più vecchio) sui pezzi di un nuovo progetto.
export function allocateRecovery(pezzi, gifts) {
  let k = num(pezzi);
  const out = [];
  for (const g of gifts) {
    if (k <= 0) break;
    const t = Math.min(k, g.rimanenti);
    if (t > 0) { out.push({ giftId: g.id, pezzi: t, euro: t * g.perPezzo }); k -= t; }
  }
  return out;
}

// Pezzi venduti per progetto
export function soldByProject(sales) {
  const m = {};
  for (const v of sales) m[v.projectId] = (m[v.projectId] || 0) + num(v.pezzi);
  return m;
}

// Situazione di un singolo progetto con scarti e vendite.
export function projectResult(p, sales, s, spoolsById = {}, accById = {}) {
  const costi = effectiveCosts(p, s, spoolsById, accById);
  if (!costi) return null;
  const pezzi = num(p.pezzi);
  const scarti = Math.min(pezzi, num(p.scarti));
  const buoni = pezzi - scarti;
  const mySales = sales.filter((v) => v.projectId === p.id);
  const venduti = mySales.reduce((a, v) => a + num(v.pezzi), 0);
  const incasso = mySales.reduce((a, v) => a + num(v.pezzi) * num(v.prezzo), 0);
  const costoPezzoBuono = buoni > 0 ? costi.totale / buoni : null;
  const daVendere = p.regalo ? 0 : Math.max(0, buoni - venduti);
  // Risultato economico reale del progetto: incassi - costi di tutto il piatto (scarti compresi)
  const risultato = incasso - costi.totale;
  return {
    costi, pezzi, scarti, buoni, venduti, incasso, costoPezzoBuono, daVendere, risultato,
    scartoPerc: pezzi > 0 ? scarti / pezzi * 100 : 0,
    costoScarti: pezzi > 0 ? costi.totale / pezzi * scarti : 0
  };
}

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Riepilogo economico complessivo.
export function economics({ projects, sales, spools, accessories = [], s, now = new Date(), months = 6 }) {
  const produced = projects.filter((p) => prodotto(p) && p.costi);
  const sold = soldByProject(sales);
  let vendite = 0;
  for (const v of sales) vendite += num(v.pezzi) * num(v.prezzo);

  let filamento = 0, energia = 0, ammortamento = 0, accessori = 0, regali = 0, recuperato = 0;
  let scartiPezzi = 0, scartiCosto = 0, pezziProdotti = 0, invendutiPezzi = 0, invendutiCosto = 0;
  for (const p of produced) {
    const c = p.costi, pezzi = num(p.pezzi);
    filamento += c.filamento; energia += c.energia; ammortamento += c.ammortamento; accessori += num(c.accessori);
    pezziProdotti += pezzi;
    const scarti = Math.min(pezzi, num(p.scarti));
    scartiPezzi += scarti;
    scartiCosto += pezzi > 0 ? c.totale / pezzi * scarti : 0;
    if (p.regalo) { regali += c.totale; continue; }
    const buoni = pezzi - scarti;
    const v = Math.min(buoni, sold[p.id] || 0);
    recuperato += pezzi > 0 ? v * num(p.recuperoEuro) / pezzi : 0;
    const left = buoni - v;
    if (left > 0) { invendutiPezzi += left; invendutiCosto += left * c.totale / pezzi; }
  }

  const usage = spoolUsage(projects);
  let speseBobine = 0, valoreMagazzino = 0, grammiMagazzino = 0;
  for (const sp of spools) {
    speseBobine += spoolTrackedCost(sp);
    const rem = Math.max(0, spoolRemaining(sp, usage));
    grammiMagazzino += rem;
    valoreMagazzino += rem * (spoolEurPerGram(sp) || 0);
  }

  const accUsage = accessoryUsage(projects);
  let speseAccessori = 0, valoreAccessori = 0;
  for (const a of accessories) {
    speseAccessori += accessoryTrackedCost(a);
    valoreAccessori += Math.max(0, accessoryRemaining(a, accUsage)) * accessoryUnitCost(a);
  }

  // Margine di produzione: vendite meno filamento, energia e accessori consumati (regali e scarti compresi)
  const margine = vendite - filamento - energia - accessori;
  // Soldi reali: vendite meno quanto hai speso (bobine e accessori comprati, energia, stampante)
  const saldo = vendite - speseBobine - speseAccessori - energia - num(s.stampante);
  const ripagata = num(s.stampante) > 0 ? Math.max(0, Math.min(1, margine / num(s.stampante))) : 1;

  // Andamento mensile
  const keys = [];
  for (let i = months - 1; i >= 0; i--) keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  const mesi = Object.fromEntries(keys.map((k) => [k, { ricavi: 0, costi: 0 }]));
  for (const v of sales) {
    const k = String(v.data || '').slice(0, 7);
    if (mesi[k]) mesi[k].ricavi += num(v.pezzi) * num(v.prezzo);
  }
  for (const p of produced) {
    if (!p.prodottoAt) continue;
    const k = monthKey(new Date(num(p.prodottoAt)));
    if (mesi[k]) mesi[k].costi += p.costi.filamento + p.costi.energia + num(p.costi.accessori);
  }

  return {
    vendite, filamento, energia, ammortamento, accessori, regali, recuperato,
    speseAccessori, valoreAccessori,
    scartiPezzi, scartiCosto, pezziProdotti,
    scartoRealePerc: pezziProdotti > 0 ? scartiPezzi / pezziProdotti * 100 : 0,
    invendutiPezzi, invendutiCosto,
    speseBobine, valoreMagazzino, grammiMagazzino,
    margine, saldo, ripagata, stampante: num(s.stampante),
    mesi: keys.map((k) => ({ mese: k, ...mesi[k] }))
  };
}

// Decide se un record remoto deve sovrascrivere quello locale: vince la modifica più recente.
export function remoteWins(local, remoteUpdatedAt) {
  if (!local) return true;
  return (Number(remoteUpdatedAt) || 0) > (Number(local.updated_at) || 0);
}
