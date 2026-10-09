import { neon } from '@neondatabase/serverless';
import { verify } from './auth.js';
// Midland ka OPEN read-only route padhta hai (Midland mein kuch nahi badalta).
const BASE = process.env.MIDLAND_URL || 'https://midlandmetals.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = verify(req);
  if (!me || me === 'ADMIN') return res.status(401).json({ error: 'Please log in' });
  try {
    const r = await fetch(`${BASE}/api/contractor-outward?from=2026-10-01`);
    if (!r.ok) return res.status(502).json({ error: 'Midland returned ' + r.status });
    const j = await r.json();
    const rows = (j.rows || [])
      .filter(x => (x.category === 'bush' || x.category === 'capacitor') &&
                   x.contractor === me &&
                   x.date >= '2026-10-01')
      .map(x => ({ date: x.date, contractor: x.contractor, category: x.category, item: x.item, qty: Number(x.qty) }));
    // Cover / kuppa: Midland DB se, sirf SELECT (route mein ye nahi aate)
    let extraError = null;
    try {
      const sql = neon(process.env.DATABASE_URL);
      const m = await sql`
        SELECT t.party_name, t.quantity::float AS qty, i.name AS item, i.category AS cat,
               to_char(t.transaction_date::date, 'YYYY-MM-DD') AS d
        FROM inventory_transactions t
        JOIN inventory_items i ON i.id = t.item_id
        WHERE upper(t.transaction_type) = 'OUTWARD'
          AND t.transaction_date >= '2026-10-01'::date
          AND (i.name ILIKE '%cover%' OR i.name ILIKE '%kuppa%' OR i.category ILIKE '%cover%' OR i.category ILIKE '%kuppa%')
          AND upper(i.category) NOT IN ('PAPER', 'HARDWARE')
          AND i.name NOT ILIKE '%rivit%'`;
      for (const x of m) {
        const k = String(x.party_name || '').toLowerCase().replace(/[^a-z]/g, '');
        const who = (k === 'pandayji' || k === 'pandeyji') ? 'Pandey ji' : (k === 'sunil' ? 'Sunil' : null);
        if (!who || who !== me) continue;
        const isK = /kuppa/i.test(x.item) || /kuppa/i.test(x.cat);
        rows.push({ date: x.d, contractor: who, category: isK ? 'kuppa' : 'cover', item: x.item, qty: Number(x.qty) });
      }
    } catch (e) {
      extraError = String(e.message || e);
    }
    return res.status(200).json({ rows, extraError });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
