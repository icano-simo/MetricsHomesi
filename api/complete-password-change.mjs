// Vercel Serverless Function — POST /api/complete-password-change
//
// PROPUESTA (CAMBIO 3). Port del app/api/auth/complete-password-change/route.ts
// de homesi-reporte-actividad. Corre en el servidor con la service_role key, que
// es la unica que puede escribir app_metadata (el cliente NO puede).
//
// Flujo: el cliente ya cambio su contraseña con supabaseAuth.updateUser({password}),
// y luego llama a este endpoint con su JWT en Authorization. Aqui se verifica el
// token y se limpia app_metadata.must_change_password = false.
//
// REQUISITOS antes de que funcione (env vars en Vercel, server-side, NO expuestas):
//   SUPABASE_URL             = https://eykplgdwlqpybzkzbpmu.supabase.co
//   SUPABASE_SERVICE_ROLE    = <service_role key del proyecto>  (SECRETO)
//   (mismo nombre que en simo-sync — un solo nombre para la llave, para no
//    romper la proxima rotacion)
//
// Nota: archivo .mjs (ESM) porque package.json no tiene "type":"module" y usamos import.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    res.status(500).json({ error: 'Server not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE)' });
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1. Verificar el token → identifica al usuario que hace la petición.
  const { data: { user }, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // 2. Defensa en profundidad: solo usuarios con acceso a b2b_metrics.
  const apps = user.app_metadata && user.app_metadata.allowed_apps;
  if (!Array.isArray(apps) || !apps.includes('b2b_metrics')) {
    res.status(403).json({ error: 'No access to b2b_metrics' });
    return;
  }

  // 3. Limpiar el flag en app_metadata, preservando el resto.
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: { ...user.app_metadata, must_change_password: false }
  });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
}
