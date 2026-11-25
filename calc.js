// Logica pura: calcolo costi/prezzi e regola di unione per la sincronizzazione.

export const DEFAULT_SETTINGS = {
  energia: 0.25,     // €/kWh
  consumo: 0.15,     // kWh per ora di stampa
  bobina: 40,        // € per bobina da 1 kg
  stampante: 900,    // € costo stampante
  oreAmm: 3000,      // ore di ammortamento
  fallite: 10,       // % stampe fallite
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

const round10c = (x) => Math.round(x * 10 + 1e-9) / 10;

// p = { pezzi, grammi, ore } (ore in decimali), s = impostazioni
export function calc(p, s) {
  const pezzi = Number(p.pezzi), grammi = Number(p.grammi), ore = Number(p.ore);
  if (!(pezzi > 0) || !(grammi >= 0) || !(ore >= 0)) return null;
  const f = 1 + (Number(s.fallite) || 0) / 100;
  const filamento = grammi / 1000 * s.bobina * f / pezzi;
  const energia = ore * s.consumo * s.energia * f / pezzi;
  const ammortamento = s.oreAmm > 0 ? ore * s.stampante / s.oreAmm * f / pezzi : 0;
  const costo = filamento + energia + ammortamento;
  return {
    filamento, energia, ammortamento, costo,
    lancio: round10c(costo * s.ricLancio),
    standard: round10c(costo * s.ricStd),
    personalizzato: round10c(costo * s.ricPers)
  };
}

// Decide se un record remoto deve sovrascrivere quello locale.
// Vince sempre la modifica più recente (anche su una modifica locale non ancora inviata).
// A parità di orario è la stessa versione: niente da fare.
export function remoteWins(local, remoteUpdatedAt) {
  if (!local) return true;
  return (Number(remoteUpdatedAt) || 0) > (Number(local.updated_at) || 0);
}
