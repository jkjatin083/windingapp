import { neon } from '@neondatabase/serverless';
import { NAMES, sign, hashPin, safeEq } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = String(b.name || '').trim(), pin = String(b.pin || '').trim();
    if (!name || !pin || (name !== 'ADMIN' && !NAMES.includes(name))) {
      return res.status(401).json({ error: 'Wrong name or PIN' });
    }
    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'Login database is not configured' });
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`SELECT * FROM wa_users WHERE name = ${name}`;
    const row = rows[0];
    if (row && row.locked_until && new Date(row.locked_until) > new Date()) {
      return res.status(429).json({ error: 'Too many wrong PINs. Try again in 10 minutes.' });
    }
    let ok = false;
    if (name === 'ADMIN') {
      if (!process.env.ADMIN_PIN) return res.status(500).json({ error: 'ADMIN_PIN is not set in Vercel' });
      ok = safeEq(pin, process.env.ADMIN_PIN);
    } else {
      if (!row || !row.hash) return res.status(401).json({ error: 'PIN is not set yet. Ask Jatin to set it.' });
      ok = safeEq(hashPin(pin, row.salt), row.hash);
    }
    if (!ok) {
      const f = (row ? row.fails : 0) + 1;
      if (f >= 5) {
        await sql`INSERT INTO wa_users (name, fails, locked_until) VALUES (${name}, 0, now() + interval '10 minutes')
                  ON CONFLICT (name) DO UPDATE SET fails = 0, locked_until = now() + interval '10 minutes'`;
      } else {
        await sql`INSERT INTO wa_users (name, fails) VALUES (${name}, ${f})
                  ON CONFLICT (name) DO UPDATE SET fails = ${f}`;
      }
      return res.status(401).json({ error: 'Wrong name or PIN' });
    }
    await sql`INSERT INTO wa_users (name, fails) VALUES (${name}, 0)
              ON CONFLICT (name) DO UPDATE SET fails = 0, locked_until = NULL`;
    return res.status(200).json({ token: sign(name, name === 'ADMIN' ? 12 : 24 * 30), name });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
