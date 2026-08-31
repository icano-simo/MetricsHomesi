// ─────────────────────────────────────────────────────────────────────────────
// Selector de estrategia (NPPM vs B2B) — SOLO afecta lo que se MUESTRA, nunca el
// cálculo. Mismo patrón que visibility.js: calc.js agrupa/clasifica con TODOS los
// datos y etiqueta cada resultado con su strategy (leída de realtor_owner_map_v2,
// fuente b2b_marts.dim_realtor_strategy). Cada vista filtra sus filas con
// matchesStrategy, igual que ya filtra por isOwnerVisible. Los dos filtros se
// combinan (visibilidad decide qué BDs; estrategia, qué parte del negocio).
//
// Regla de negocio: un realtor NPPM (contratado O referido por un contratado)
// sale del B2B de su BD. Un realtor sin strategy conocida cuenta como B2B (caso
// general — mismo criterio que el COALESCE del sync).
// ─────────────────────────────────────────────────────────────────────────────
import { state } from './state.js';

// ¿La fila (resultado de calc con .strategy) entra con el filtro activo?
export function matchesStrategy(row) {
  const f = state.strategyFilter || 'all';
  if (f === 'all') return true;
  const isNppm = !!row && row.strategy === 'NPPM';
  return f === 'nppm' ? isNppm : !isNppm;
}
