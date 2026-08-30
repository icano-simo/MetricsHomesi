import { createClient } from '@supabase/supabase-js';
import { SB_URL, SB_KEY } from './config.js';

export const supabaseAuth = createClient(SB_URL, SB_KEY, {
  auth: {
    persistSession: true,
    storageKey: 'homesi-metrics-auth',
    storage: window.localStorage,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

export async function signIn(email, password) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabaseAuth.auth.signOut();
  window.location.reload();
}

export async function getSession() {
  const { data } = await supabaseAuth.auth.getSession();
  return data.session;
}

export async function getCurrentUser() {
  const { data } = await supabaseAuth.auth.getUser();
  return data.user;
}

// CAMBIO 1: token de la sesión del usuario, para que las lecturas viajen con
// el JWT (y RLS pueda filtrar con auth.jwt()). Cae a null si no hay sesión.
export async function getAccessToken() {
  const { data } = await supabaseAuth.auth.getSession();
  return data?.session?.access_token || null;
}

// Fuerza un refresh contra el servidor para traer el app_metadata actualizado.
// getSession() devuelve el token cacheado en localStorage; si el permiso se
// otorgó DESPUÉS del último login, ese token viejo no lo trae. Devuelve el user
// fresco, o null si el refresh falla (p. ej. refresh token expirado).
export async function refreshSession() {
  const { data, error } = await supabaseAuth.auth.refreshSession();
  if (error) return null;
  return data?.user || data?.session?.user || null;
}

// CAMBIO 2: acceso por app. app_metadata solo lo escribe service_role, así que
// el usuario no puede auto-otorgarse acceso.
export function hasAppAccess(user) {
  const apps = user && user.app_metadata && user.app_metadata.allowed_apps;
  return Array.isArray(apps) && apps.includes('b2b_metrics');
}

// CAMBIO 3: el flag vive en app_metadata (no user_metadata), no manipulable
// por el usuario desde la consola.
export async function mustChangePassword() {
  const { data } = await supabaseAuth.auth.getUser();
  return data?.user?.app_metadata?.must_change_password === true;
}

export async function updatePassword(newPassword) {
  // 1. Cambiar la contraseña (esto sí lo puede hacer el propio usuario).
  const { error } = await supabaseAuth.auth.updateUser({ password: newPassword });
  if (error) throw error;
  // 2. Limpiar must_change_password en app_metadata vía endpoint de servidor
  //    (service_role). El cliente no puede tocar app_metadata directamente.
  const token = await getAccessToken();
  const res = await fetch('/api/complete-password-change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') }
  });
  if (!res.ok) {
    let msg = 'No se pudo completar el cambio de contraseña.';
    try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  // 3. Refrescar la sesión para traer el app_metadata actualizado (flag en false).
  await supabaseAuth.auth.refreshSession();
}
