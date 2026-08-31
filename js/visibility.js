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
import { refreshSession } from './auth.js';

// Trae la visibilidad del servidor (3 llamadas). Lanza si algo falla.
async function fetchVisibility() {
  // bd_id visibles para la sesión (RPC; resuelve '*' → todos los de dim_bd).
  const vis = await sbFetch('rpc/my_visible_bds', { method: 'POST', body: JSON.stringify({}) });
  const visibleIds = new Set((vis || []).map(r => r.bd_id).filter(Boolean));
  // Traducción id → nombre (dim_bd tiene ambas columnas).
  const dim = await sbFetch('dim_bd?select=bd_id,bd_name');
  const idToName = new Map((dim || []).map(r => [r.bd_id, r.bd_name]));
  const visibleNames = [...visibleIds].map(id => idToName.get(id)).filter(Boolean);
  // Acceso total = CONCEDIDO explícitamente (subject_key '*'), no inferido por
  // conteo: RPC a b2b_metrics.has_full_access() (true solo si hay fila '*').
  const fa = await sbFetch('rpc/has_full_access', { method: 'POST', body: JSON.stringify({}) });
  const fullAccess = fa === true
    || (Array.isArray(fa) && (fa[0] === true || fa[0]?.has_full_access === true))
    || (fa && typeof fa === 'object' && fa.has_full_access === true);
  return { visibleNames, fullAccess };
}

function applyVisibility({ visibleNames, fullAccess }) {
  state.visibleBdNames = visibleNames;
  state.visibleBdSet = new Set(visibleNames.map(n => norm(n)));
  state.fullAccess = fullAccess;
  state.visibilityLoaded = true;
}

export async function loadVisibility() {
  state.visibilityLoaded = false;
  state.fullAccess = false;
  state.visibleBdSet = new Set();
  state.visibleBdNames = [];
  hideVisibilityBanner();

  try {
    applyVisibility(await fetchVisibility());
    return;
  } catch (e) {
    console.warn('[visibility] primer intento falló:', e.message);
  }

  // Un fallo NO debe interpretarse como "sin acceso total" (esa es la opción que
  // esconde datos). Reintento tras refrescar la sesión (el token pudo estar viejo).
  try {
    await refreshSession();
    applyVisibility(await fetchVisibility());
    return;
  } catch (e2) {
    console.warn('[visibility] reintento tras refresh falló:', e2.message);
  }

  // Sigue fallando: no degradar en silencio. El usuario debe saber que puede
  // estar viendo una vista parcial.
  state.visibilityLoaded = false;
  state.fullAccess = false;
  state.visibleBdSet = new Set();
  state.visibleBdNames = [];
  showVisibilityBanner();
}

// Aviso visible y persistente (banner rojo fijo). Se crea por JS para no depender
// de HTML nuevo. Se quita si una carga posterior resuelve bien.
function showVisibilityBanner() {
  if (typeof document === 'undefined' || document.getElementById('visibility-error-banner')) return;
  const b = document.createElement('div');
  b.id = 'visibility-error-banner';
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#B83030;color:#fff;font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:600;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  b.textContent = "Couldn't confirm your access permissions — you may be seeing a partial view. Reload the page, or sign out and back in.";
  document.body.appendChild(b);
}
function hideVisibilityBanner() {
  if (typeof document === 'undefined') return;
  const b = document.getElementById('visibility-error-banner');
  if (b) b.remove();
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
