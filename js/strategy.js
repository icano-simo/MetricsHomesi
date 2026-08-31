// ─────────────────────────────────────────────────────────────────────────────
// Strategy selector (NPPM vs B2B) — DISPLAY-only, never affects the calculation.
// Same pattern as visibility.js: calc.js groups/classifies with ALL the data and
// tags each result with its strategy (read from realtor_owner_map_v2, sourced
// from b2b_marts.dim_realtor_strategy). Each view filters its rows with
// matchesStrategy, just like it already filters by isOwnerVisible. The two
// filters combine (visibility decides which BDs; strategy, which part of the
// business).
//
// Business rule: an NPPM realtor (contracted OR referred by a contracted one)
// leaves their BD's B2B. A realtor with no known strategy counts as B2B (the
// general case — same criterion as the sync's COALESCE).
// UI copy in this feature is in English (selector labels, badges).
// ─────────────────────────────────────────────────────────────────────────────
import { state } from './state.js';
import { norm, getField } from './utils.js';

// ¿La fila (resultado de calc con .strategy) entra con el filtro activo?
export function matchesStrategy(row) {
  const f = state.strategyFilter || 'all';
  if (f === 'all') return true;
  const isNppm = !!row && row.strategy === 'NPPM';
  return f === 'nppm' ? isNppm : !isNppm;
}

// ¿La estrategia de una clave (realtor_key) entra con el filtro activo?
// Para vistas que agrupan por realtor_key sin un resultado ya etiquetado.
export function keyMatchesStrategy(key) {
  const f = state.strategyFilter || 'all';
  if (f === 'all') return true;
  const m = key ? state.realtorOwnerMap.get(key) : null;
  const isNppm = !!(m && m.strategy === 'NPPM');
  return f === 'nppm' ? isNppm : !isNppm;
}

// ¿La oportunidad/lead (fila cruda con Referred By) entra con el filtro activo?
// La estrategia es del realtor: se resuelve por realtor_key = norm(referred_by).
export function oppMatchesStrategy(row) {
  const f = state.strategyFilter || 'all';
  if (f === 'all') return true;
  const ref = getField(row, 'Referred By', 'referred by');
  const key = ref ? norm(String(ref)) : '';
  return keyMatchesStrategy(key);
}
