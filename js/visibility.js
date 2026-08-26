// ─────────────────────────────────────────────────────────────────────────────
// Visibilidad por BD — SOLO afecta lo que se MUESTRA, nunca el cálculo.
//
// calc.js sigue agrupando y asignando dueños con TODOS los datos (la data no
// puede cambiar por BD). Acá solo obtenemos qué BDs puede ver la persona y
// filtramos las listas de owners que alimentan los selectores/tablas de cada
// pantalla de DISPLAY.
//
// Fuente: la vista que resuelve el comodín '*' server-side con el JWT del
// usuario. Devuelve bd_id (IDs de Salesforce); dim_bd traduce id -> nombre.
//
// El esquema `access` NO está expuesto a PostgREST. La lista resuelta se obtiene
// por RPC de la función b2b_metrics.my_visible_bds() (SECURITY DEFINER, execute
// solo a authenticated): corre con permisos del owner (lee access.*) pero filtra
// por el auth.jwt() del que llama, y expone SOLO bd_id (nunca profile_visibility).
// ─────────────────────────────────────────────────────────────────────────────
import { state } from './state.js';
import { norm } from './utils.js';
import { sbFetch } from './supabase.js';

export async function loadVisibility() {
  state.visibilityLoaded = false;
  state.fullAccess = false;
  state.visibleBdSet = new Set();
  state.visibleBdNames = [];
  try {
    // bd_id visibles para la sesión (RPC; resuelve '*' → todos los de dim_bd).
    const vis = await sbFetch('rpc/my_visible_bds', { method: 'POST', body: JSON.stringify({}) });
    const visibleIds = new Set((vis || []).map(r => r.bd_id).filter(Boolean));
    // Universo de BDs + traducción id → nombre.
    const dim = await sbFetch('dim_bd?select=bd_id,bd_name');
    const idToName = new Map((dim || []).map(r => [r.bd_id, r.bd_name]));
    const allIds = (dim || []).map(r => r.bd_id).filter(Boolean);
    const visibleNames = [...visibleIds].map(id => idToName.get(id)).filter(Boolean);

    state.visibleBdNames = visibleNames;
    state.visibleBdSet = new Set(visibleNames.map(n => norm(n)));
    // Acceso total = ve todos los BDs del universo (dim_bd).
    state.fullAccess = allIds.length > 0 && allIds.every(id => visibleIds.has(id));
    state.visibilityLoaded = true;
  } catch (e) {
    // Fail-closed: sin visibilidad, no mostrar datos ni dar acceso total.
    console.warn('[visibility] no se pudo cargar my_visible_bds:', e.message);
    state.visibilityLoaded = false;
    state.fullAccess = false;
    state.visibleBdSet = new Set();
    state.visibleBdNames = [];
  }
}

// Filtra una lista de nombres de owner (BD) a solo los visibles.
// Acceso total → sin cambios. Fail-closed si no cargó la visibilidad.
export function visibleOwners(owners) {
  if (state.fullAccess) return owners || [];
  if (!state.visibilityLoaded) return [];
  const vis = state.visibleBdSet || new Set();
  return (owners || []).filter(o => vis.has(norm(o)));
}

// ¿El owner es visible para la persona? (para gatear filas/tarjetas por dueño)
export function isOwnerVisible(owner) {
  if (state.fullAccess) return true;
  if (!state.visibilityLoaded) return false;
  return (state.visibleBdSet || new Set()).has(norm(owner || ''));
}
