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

export async function mustChangePassword() {
  const { data } = await supabaseAuth.auth.getUser();
  return data?.user?.user_metadata?.must_change_password === true;
}

export async function updatePassword(newPassword) {
  const { error } = await supabaseAuth.auth.updateUser({
    password: newPassword,
    data: { must_change_password: false }
  });
  if (error) throw error;
}
