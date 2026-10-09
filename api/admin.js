import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { NAMES, verify, sign, hashPin } from './auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (verify(req) !== 'ADMIN') return res.status(401).json({ error: 'Admin login needed' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const rows = await sql`SELECT name, (hash IS NOT NULL) AS has_pin FROM wa_users`;
      const m = {}; rows.forEach(r => { m[r.name] = r.has_pin; });
      return res.status(200).json({ users: NAMES.map(n => ({ name: n, hasPin: !!m[n] })) });
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!NAMES.includes(b.name)) return res.status(400).json({ error: 'Invalid name' });
    if (b.action === 'setpin') {
      const pin = String(b.pin || '');
      if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPin(pin, salt);
      await sql`INSERT INTO wa_users (name, salt, hash, fails, locked_until, updated_at) VALUES (${b.name}, ${salt}, ${hash}, 0, NULL, now())
                ON CONFLICT (name) DO UPDATE SET salt = ${salt}, hash = ${hash}, fails = 0, locked_until = NULL, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'open') {
      return res.status(200).json({ token: sign(b.name, 12), name: b.name });
    }
    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
