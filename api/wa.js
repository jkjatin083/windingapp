import { neon } from '@neondatabase/serverless';

const START = '2026-10-01';
const KINDS = ['stamp_in', 'wound', 'sent', 'transfer', 'dispatch'];
const CONTRACTORS = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil', 'Pandey ji'];

// Midland mein party ka naam alag alag likha ho sakta hai (Pandayji / Pandey ji ...)
function normParty(p) {
  const k = String(p || '').toLowerCase().replace(/[^a-z]/g, '');
  if (k === 'pandayji' || k === 'pandeyji') return 'Pandey ji';
  return CONTRACTORS.find(c => c.toLowerCase().replace(/[^a-z]/g, '') === k) || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, kind, contractor, party, stype, qty::float AS qty,
               to_char(d, 'YYYY-MM-DD') AS d, note
        FROM wa_entries
        WHERE deleted = false AND d >= ${START}::date
        ORDER BY d, id`;
      try {
        const k = await sql`SELECT entry_id, kuppa_qty::float AS k FROM wa_dispatch_kuppa`;
        const km = {}; k.forEach(x => km[x.entry_id] = x.k);
        rows.forEach(r => { if (r.kind === 'dispatch' && km[r.id]) r.kuppa = km[r.id]; });
      } catch (e) { /* table abhi nahi bana: kuppa 0 maano */ }
      // Midland ka stamping OUTWARD (sirf padhta hai, kuch likhta nahi)
      let midlandError = null;
      const skipped = {};
      let mrows = [];
      try {
        const m = await sql`
          SELECT t.id, t.party_name, t.quantity::float AS qty,
                 to_char(t.transaction_date::date, 'YYYY-MM-DD') AS d, i.name AS item
          FROM inventory_transactions t
          JOIN inventory_items i ON i.id = t.item_id
          WHERE upper(t.transaction_type) = 'OUTWARD'
            AND i.category IN ('STAMPING', 'AIRY STAMPING')
            AND t.transaction_date >= ${START}::date
          ORDER BY t.transaction_date, t.id`;
        for (const x of m) {
          const c = normParty(x.party_name);
          if (!c) { skipped[x.party_name] = (skipped[x.party_name] || 0) + x.qty; continue; }
          mrows.push({ id: -x.id, kind: 'stamp_in', contractor: c, party: null, stype: x.item, qty: x.qty, d: x.d, note: null, src: 'midland' });
        }
      } catch (e) {
        midlandError = String(e.message || e);
      }
      return res.status(200).json({ start: START, rows: rows.concat(mrows), midlandError, skipped });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'del') {
        const id = parseInt(b.id, 10);
        if (!id) return res.status(400).json({ error: 'id galat' });
        await sql`UPDATE wa_entries SET deleted = true WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'add') {
        const qty = Number(b.qty);
        const d = String(b.d || '');
        if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'kind galat' });
        if (!CONTRACTORS.includes(b.contractor)) return res.status(400).json({ error: 'naam galat' });
        if (!(qty > 0) || qty > 10000000) return res.status(400).json({ error: 'qty galat' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < START) return res.status(400).json({ error: 'date 1 Oct 2026 ya baad ki chahiye' });
        const stype = b.kind === 'dispatch' ? null : String(b.stype || '').trim().slice(0, 60);
        if (b.kind !== 'dispatch' && !stype) return res.status(400).json({ error: 'stamping type likho' });
        let party = null;
        if (b.kind === 'sent' || b.kind === 'transfer') {
          party = String(b.party || '');
          if (!CONTRACTORS.includes(party)) return res.status(400).json({ error: 'lene wala galat' });
          if (b.kind === 'transfer' && party === b.contractor) return res.status(400).json({ error: 'khud ko transfer nahi' });
        }
        const note = b.note ? String(b.note).trim().slice(0, 120) : null;
        const r = await sql`
          INSERT INTO wa_entries (kind, contractor, party, stype, qty, d, note)
          VALUES (${b.kind}, ${b.contractor}, ${party}, ${stype}, ${qty}, ${d}::date, ${note})
          RETURNING id`;
        const kq = Number(b.kuppa || 0);
        if (b.kind === 'dispatch' && kq > 0) {
          if (kq > qty) {
            await sql`UPDATE wa_entries SET deleted = true WHERE id = ${r[0].id}`;
            return res.status(400).json({ error: 'kuppa wale motor, kul motor se zyada nahi' });
          }
          try {
            await sql`INSERT INTO wa_dispatch_kuppa (entry_id, kuppa_qty) VALUES (${r[0].id}, ${kq})`;
          } catch (e) {
            await sql`UPDATE wa_entries SET deleted = true WHERE id = ${r[0].id}`;
            return res.status(500).json({ error: 'kuppa save nahi hua (schema2.sql Neon mein run kiya?): ' + String(e.message || e) });
          }
        }
        return res.status(200).json({ ok: true, id: r[0].id });
      }
      return res.status(400).json({ error: 'action galat' });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
