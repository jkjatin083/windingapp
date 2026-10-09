import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';

const START = '2026-10-01';
const KINDS = ['stamp_in', 'wound', 'sent', 'transfer', 'dispatch'];
const CONTRACTORS = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil', 'Pandey ji'];

// Midland mein party ka naam alag alag likha ho sakta hai (Pandayji / Pandey ji ...)
function normParty(p) {
  const k = String(p || '').toLowerCase().replace(/[^a-z]/g, '');
  if (k === 'pandayji' || k === 'pandeyji') return 'Pandey ji';
  return CONTRACTORS.find(c => c.toLowerCase().replace(/[^a-z]/g, '') === k) || null;
}

function partOf(x) {
  const n = String(x.name || ''), c = String(x.category || '');
  if (/^bush 034$/i.test(n.trim())) return 'bush';
  if (/capacitor/i.test(n) || /capacitor/i.test(c)) return 'capacitor';
  if (/^(paper|hardware)$/i.test(c.trim()) || /rivit/i.test(n)) return null;
  if (/kuppa/i.test(n) || /kuppa/i.test(c)) return 'kuppa';
  return null;
}

async function windAvail(sql, me, src, stype, excludeSentAmount) {
  const a = await sql`SELECT COALESCE(SUM(qty),0)::float AS v FROM wa_entries
    WHERE deleted = false AND kind = 'sent' AND party = ${me} AND contractor = ${src} AND stype = ${stype}`;
  const b = await sql`SELECT COALESCE(SUM(qty),0)::float AS v FROM wa_entries
    WHERE deleted = false AND kind = 'dispatch' AND contractor = ${me} AND party = ${src} AND stype = ${stype}`;
  return a[0].v - (excludeSentAmount || 0) - b[0].v;
}

async function checkDispatch(sql, b, qty, kq, d, src, stype) {
  if (!['Pandey ji', 'Sunil'].includes(b.contractor)) return 'Only Pandey ji or Sunil can enter dispatch';
  if (!src || !stype) return 'Select the winding (contractor - type) first';
  // 1) double entry
  let dup;
  try {
    dup = await sql`SELECT e.id FROM wa_entries e LEFT JOIN wa_dispatch_kuppa k ON k.entry_id = e.id
      WHERE e.deleted = false AND e.kind = 'dispatch' AND e.contractor = ${b.contractor} AND e.d = ${d}::date
        AND e.party = ${src} AND e.stype = ${stype} AND e.qty = ${qty} AND COALESCE(k.kuppa_qty,0) = ${kq} LIMIT 1`;
  } catch (e) {
    dup = await sql`SELECT id FROM wa_entries WHERE deleted = false AND kind = 'dispatch' AND contractor = ${b.contractor}
      AND d = ${d}::date AND party = ${src} AND stype = ${stype} AND qty = ${qty} LIMIT 1`;
  }
  if (dup.length) return 'Duplicate: the same dispatch (date, winding, motors) is already saved';
  // 2) winding available
  const av = await windAvail(sql, b.contractor, src, stype, 0);
  if (qty > av) return 'Not enough winding: ' + av + ' available from ' + src + ' - ' + stype + ', you entered ' + qty;
  // 3) parts balances must not go negative
  const mo = await sql`SELECT COALESCE(SUM(qty),0)::float AS v FROM wa_entries WHERE deleted = false AND kind = 'dispatch' AND contractor = ${b.contractor}`;
  let ku = 0;
  try {
    const k = await sql`SELECT COALESCE(SUM(k.kuppa_qty),0)::float AS v FROM wa_dispatch_kuppa k
      JOIN wa_entries e ON e.id = k.entry_id WHERE e.deleted = false AND e.kind = 'dispatch' AND e.contractor = ${b.contractor}`;
    ku = k[0].v;
  } catch (e) { /* table not created yet */ }
  const recv = { bush: 0, capacitor: 0, kuppa: 0 };
  let m;
  try {
    m = await sql`SELECT t.party_name, t.quantity::float AS qty, i.name AS name, i.category AS category
      FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
      WHERE upper(t.transaction_type) = 'OUTWARD' AND t.transaction_date >= ${START}::date`;
  } catch (e) {
    return 'Could not check parts stock in Midland, so the dispatch was not saved: ' + String(e.message || e);
  }
  for (const x of m) {
    if (normParty(x.party_name) !== b.contractor) continue;
    const p = partOf(x);
    if (p) recv[p] += x.qty;
  }
  const M = mo[0].v + qty, K = ku + kq;
  const need = { bush: 2 * M, capacitor: M, kuppa: K };
  const short = [];
  for (const p of ['bush', 'capacitor', 'kuppa']) {
    if (recv[p] - need[p] < 0) short.push(p + ' (received ' + recv[p] + ', needed ' + need[p] + ')');
  }
  if (short.length) return 'Not enough parts for this dispatch: ' + short.join('; ') + '. Record the parts issue in Midland first.';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = verify(req);
  if (!me || me === 'ADMIN') return res.status(401).json({ error: 'Please log in' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, kind, contractor, party, stype, qty::float AS qty,
               to_char(d, 'YYYY-MM-DD') AS d, note
        FROM wa_entries
        WHERE deleted = false AND d >= ${START}::date
          AND (contractor = ${me} OR (party = ${me} AND kind IN ('transfer', 'sent')))
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
          if (c && c !== me) continue;
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
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const cur = await sql`SELECT kind, contractor, party, stype, qty::float AS qty FROM wa_entries WHERE id = ${id} AND deleted = false`;
        if (!cur.length || cur[0].contractor !== me) return res.status(403).json({ error: 'You can only delete your own entries' });
        if (cur.length && cur[0].kind === 'sent') {
          const av = await windAvail(sql, cur[0].party, cur[0].contractor, cur[0].stype, cur[0].qty);
          if (av < 0) return res.status(409).json({ error: 'Cannot delete: motors were already dispatched from this winding' });
        }
        await sql`UPDATE wa_entries SET deleted = true WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'add') {
        b.contractor = me;
        const qty = Number(b.qty);
        const d = String(b.d || '');
        if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'Invalid entry type' });
        if (!CONTRACTORS.includes(b.contractor)) return res.status(400).json({ error: 'Invalid name' });
        if (!(qty > 0) || qty > 10000000) return res.status(400).json({ error: 'Invalid quantity' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < START) return res.status(400).json({ error: 'Date must be 1 Oct 2026 or later' });
        const stype = b.kind === 'dispatch' ? null : String(b.stype || '').trim().slice(0, 60);
        if (b.kind !== 'dispatch' && !stype) return res.status(400).json({ error: 'Enter the stamping type' });
        let party = null;
        let dstype = null;
        if (b.kind === 'dispatch' && b.party) {
          party = String(b.party);
          if (!CONTRACTORS.includes(party)) return res.status(400).json({ error: 'Invalid winding contractor' });
          dstype = String(b.stype || '').trim().slice(0, 60) || null;
        }
        if (b.kind === 'sent' || b.kind === 'transfer') {
          party = String(b.party || '');
          if (!CONTRACTORS.includes(party)) return res.status(400).json({ error: 'Invalid receiver' });
          if (b.kind === 'transfer' && party === b.contractor) return res.status(400).json({ error: 'Cannot transfer to the same contractor' });
        }
        const kq0 = Number(b.kuppa || 0);
        if (b.kind === 'dispatch') {
          if (kq0 < 0 || kq0 > qty) return res.status(400).json({ error: 'Motors with kuppa cannot be more than motors dispatched' });
          const why = await checkDispatch(sql, b, qty, kq0, d, party, dstype);
          if (why) return res.status(409).json({ error: why });
        }
        const note = b.note ? String(b.note).trim().slice(0, 120) : null;
        const r = await sql`
          INSERT INTO wa_entries (kind, contractor, party, stype, qty, d, note)
          VALUES (${b.kind}, ${b.contractor}, ${party}, ${b.kind === 'dispatch' ? dstype : stype}, ${qty}, ${d}::date, ${note})
          RETURNING id`;
        const kq = Number(b.kuppa || 0);
        if (b.kind === 'dispatch' && kq > 0) {
          if (kq > qty) {
            await sql`UPDATE wa_entries SET deleted = true WHERE id = ${r[0].id}`;
            return res.status(400).json({ error: 'Motors with kuppa cannot be more than motors dispatched' });
          }
          try {
            await sql`INSERT INTO wa_dispatch_kuppa (entry_id, kuppa_qty) VALUES (${r[0].id}, ${kq})`;
          } catch (e) {
            await sql`UPDATE wa_entries SET deleted = true WHERE id = ${r[0].id}`;
            return res.status(500).json({ error: 'Kuppa could not be saved (was schema2.sql run in Neon?): ' + String(e.message || e) });
          }
        }
        return res.status(200).json({ ok: true, id: r[0].id });
      }
      return res.status(400).json({ error: 'Invalid action' });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
