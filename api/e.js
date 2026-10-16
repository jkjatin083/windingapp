import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';

// Admin only: list, edit (quantity / date) and delete (soft) entries of all apps. No add.
const START = '2026-10-01';
const APP1 = ['stamp_in', 'wound', 'sent', 'transfer'];
const APP2 = ['made', 'mdispatch', 'dispatch'];
const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const CONTRACTORS = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil'];
const nz = s => String(s == null ? '' : s).trim().toLowerCase();
const fmt = n => Number(n).toLocaleString('en-IN');

function label(r) {
  switch (r.kind) {
    case 'wound': return 'Made (wound)';
    case 'sent': return 'Given to ' + (r.party || '-');
    case 'transfer': return 'Stamping given to ' + (r.party || '-');
    case 'stamp_in': return 'Stamping received';
    case 'made': return 'Motors made from ' + (r.party || '-');
    case 'mdispatch': return 'Motors dispatched (' + (r.party || '-') + ')';
    case 'dispatch': return 'Dispatch (old)';
    default: return r.kind;
  }
}

// Balances that must never go below zero, computed from a list of live entries.
function balances(rows) {
  const out = {};
  const add = (k, v, text) => { const o = out[k] || (out[k] = { v: 0, text }); o.v += v; };
  rows.forEach(r => {
    const q = Number(r.qty), t = r.stype || '-';
    if (r.kind === 'wound') add('held|' + nz(r.contractor) + '|' + nz(t), q, r.contractor + ' would hold less than 0 of ' + t);
    if (r.kind === 'sent') {
      add('held|' + nz(r.contractor) + '|' + nz(t), -q, r.contractor + ' would hold less than 0 of ' + t);
      if (r.party) add('wind|' + nz(r.party) + '|' + nz(r.contractor) + '|' + nz(t), q, r.party + ' would have less than 0 winding from ' + r.contractor + ' - ' + t + ' (already used for motors)');
    }
    if ((r.kind === 'made' || r.kind === 'dispatch') && r.party) {
      add('wind|' + nz(r.contractor) + '|' + nz(r.party) + '|' + nz(t), -q, r.contractor + ' would have less than 0 winding from ' + r.party + ' - ' + t + ' (already used for motors)');
      if (r.kind === 'made') add('hand|' + nz(r.contractor) + '|' + nz(r.party) + '|' + nz(t), q, r.contractor + ' would have motors dispatched that are more than made (' + r.party + ' - ' + t + ')');
    }
    if (r.kind === 'mdispatch' && r.party) add('hand|' + nz(r.contractor) + '|' + nz(r.party) + '|' + nz(t), -q, r.contractor + ' would have motors dispatched that are more than made (' + r.party + ' - ' + t + ')');
  });
  return out;
}
// Block only if the change makes a balance negative AND worse than it was before (old data issues do not trap you).
function violation(before, after) {
  const B = balances(before), A = balances(after);
  for (const k of Object.keys(A)) {
    const b = B[k] ? B[k].v : 0;
    if (A[k].v < -1e-9 && A[k].v < b - 1e-9) return A[k].text + ' (' + fmt(A[k].v) + ')';
  }
  return null;
}

async function liveRows(sql) {
  return await sql`SELECT id, kind, contractor, party, stype, qty::float AS qty, to_char(d, 'YYYY-MM-DD') AS d, note
    FROM wa_entries WHERE deleted = false AND d >= ${START}::date ORDER BY d, id`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (verify(req) !== 'ADMIN') return res.status(401).json({ error: 'Admin login needed' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const q = req.query || {};
      const showDeleted = q.app === 'deleted';
      const rows = await sql`SELECT e.id, e.kind, e.contractor, e.party, e.stype, e.qty::float AS qty, to_char(e.d, 'YYYY-MM-DD') AS d, e.note, e.deleted
        FROM wa_entries e WHERE e.d >= ${START}::date AND e.deleted = ${showDeleted} ORDER BY e.d DESC, e.id DESC LIMIT 600`;
      let kup = {};
      try { (await sql`SELECT entry_id, kuppa_qty::float AS k FROM wa_dispatch_kuppa`).forEach(x => { kup[x.entry_id] = x.k; }); } catch (e) { /* table missing */ }
      let out = rows.map(r => ({ ...r, text: label(r), kuppa: kup[r.id] || 0 }));
      const people = Array.from(new Set(out.map(r => r.contractor).filter(Boolean))).sort();
      const types = Array.from(new Set(out.map(r => r.stype).filter(Boolean))).sort();
      if (q.app === 'contractors') out = out.filter(r => APP1.includes(r.kind));
      if (q.app === 'motors') out = out.filter(r => APP2.includes(r.kind));
      if (q.who) out = out.filter(r => r.contractor === q.who);
      if (q.type) out = out.filter(r => r.stype === q.type);
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) out = out.filter(r => r.d >= q.from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) out = out.filter(r => r.d <= q.to);
      let mt = [];
      try { mt = (await sql`SELECT DISTINCT name FROM inventory_items WHERE category IN ('STAMPING', 'AIRY STAMPING') ORDER BY name`).map(x => x.name); } catch (er) { /* Midland not readable */ }
      const pickTypes = Array.from(new Set(mt.concat(types))).sort();
      return res.status(200).json({ rows: out.slice(0, 200), people, types, total: out.length, pick: { contractors: CONTRACTORS, types: pickTypes } });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.action === 'add') {
      // Admin add: only Made (wound) and Given to Pandey ji (sent). No motors, no stamping entries.
      const kind = b.entry === 'made' ? 'wound' : (b.entry === 'given' ? 'sent' : null);
      const who = String(b.contractor || '').trim(), stype = String(b.stype || '').trim().slice(0, 60);
      const qty = Number(b.qty), d = String(b.d || '');
      if (!kind) return res.status(400).json({ error: 'Choose entry type' });
      if (!CONTRACTORS.includes(who)) return res.status(400).json({ error: 'Choose the contractor' });
      if (!stype) return res.status(400).json({ error: 'Choose the winding type' });
      if (!(qty > 0) || qty > 10000000 || qty !== Math.floor(qty)) return res.status(400).json({ error: 'Enter a whole number above 0' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < START) return res.status(400).json({ error: 'Date must be 1 Oct 2026 or later' });
      if (d > todayIST()) return res.status(400).json({ error: 'Date cannot be in the future' });
      try { await sql`SELECT 1 FROM wa_audit LIMIT 1`; } catch (er) { return res.status(500).json({ error: 'Audit table is missing. Run the audit SQL in Neon first. Nothing was changed.' }); }
      const party = kind === 'sent' ? (who === 'Sunil' ? 'Sunil' : 'Pandey ji') : null;
      const rows0 = await liveRows(sql);
      const dup0 = rows0.find(r => r.kind === kind && nz(r.contractor) === nz(who) && nz(r.party) === nz(party) && nz(r.stype) === nz(stype) && r.qty === qty && r.d === d);
      if (dup0) return res.status(409).json({ error: 'Same entry already exists on that date (#' + dup0.id + '). That would be a double entry.' });
      const bad0 = violation(rows0, rows0.concat([{ id: -1, kind, contractor: who, party, stype, qty, d }]));
      if (bad0) return res.status(409).json({ error: 'Not allowed: ' + bad0 });
      const ins = await sql`INSERT INTO wa_entries (kind, contractor, party, stype, qty, d, note) VALUES (${kind}, ${who}, ${party}, ${stype}, ${qty}, ${d}::date, ${'added by admin'}) RETURNING id`;
      try {
        await sql`INSERT INTO wa_audit (entry_id, action, old_value, new_value, by_who) VALUES (${ins[0].id}, 'add', ${null}, ${JSON.stringify({ kind, contractor: who, party, stype, qty, d })}, 'Jatin (admin)')`;
      } catch (er) {
        await sql`UPDATE wa_entries SET deleted = true WHERE id = ${ins[0].id}`;
        return res.status(500).json({ error: 'Could not write the audit log. Nothing was added.' });
      }
      return res.status(200).json({ ok: true, id: ins[0].id });
    }
    const id = parseInt(b.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    if (b.action !== 'edit' && b.action !== 'delete') return res.status(400).json({ error: 'Invalid action' });

    // the audit table must exist before anything is changed
    try { await sql`SELECT 1 FROM wa_audit LIMIT 1`; } catch (e) { return res.status(500).json({ error: 'Audit table is missing. Run the audit SQL in Neon first. Nothing was changed.' }); }

    const all = await liveRows(sql);
    const cur = all.find(r => r.id === id);
    if (!cur) return res.status(404).json({ error: 'Entry not found (already deleted?)' });
    let after, newQty = cur.qty, newD = cur.d;

    if (b.action === 'edit') {
      newQty = Number(b.qty); newD = String(b.d || cur.d);
      if (!(newQty > 0) || newQty > 10000000 || newQty !== Math.floor(newQty)) return res.status(400).json({ error: 'Enter a whole number above 0' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newD) || newD < START) return res.status(400).json({ error: 'Date must be 1 Oct 2026 or later' });
      if (newD > todayIST()) return res.status(400).json({ error: 'Date cannot be in the future' });
      if (newQty === cur.qty && newD === cur.d) return res.status(400).json({ error: 'Nothing changed' });
      if ((cur.kind === 'made' || cur.kind === 'dispatch') && newQty > cur.qty) return res.status(409).json({ error: 'Motors made cannot be increased here, because bush, capacitor and cover stock is not rechecked. Delete this entry and ask the contractor to enter it again.' });
      if (cur.kind === 'made') {
        try {
          const k = await sql`SELECT kuppa_qty::float AS k FROM wa_dispatch_kuppa WHERE entry_id = ${id}`;
          if (k.length && k[0].k > newQty) return res.status(409).json({ error: 'Motors with kuppa (' + fmt(k[0].k) + ') cannot be more than motors made' });
        } catch (e) { /* no kuppa table */ }
      }
      const dup = all.find(r => r.id !== id && r.kind === cur.kind && nz(r.contractor) === nz(cur.contractor) && nz(r.party) === nz(cur.party) && nz(r.stype) === nz(cur.stype) && r.qty === newQty && r.d === newD);
      if (dup) return res.status(409).json({ error: 'Same entry already exists on that date (#' + dup.id + '). That would be a double entry.' });
      if (cur.kind === 'wound') {
        try {
          const iss = await sql`SELECT i.id, i.qty::float AS qty FROM ca_meta m JOIN ca_issues i ON i.id = m.issue_id WHERE m.entry_id = ${id}`;
          if (iss.length) {
            const o = await sql`SELECT COALESCE(SUM(e.qty),0)::float AS v FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = ${iss[0].id} AND e.deleted = false AND e.kind = 'wound' AND e.id <> ${id}`;
            if (o[0].v + newQty > iss[0].qty) return res.status(409).json({ error: 'This is more than the order quantity issued to this contractor (' + fmt(iss[0].qty) + ')' });
          }
        } catch (e) { /* order tables missing */ }
      }
      after = all.map(r => r.id === id ? { ...r, qty: newQty, d: newD } : r);
    } else {
      after = all.filter(r => r.id !== id);
    }
    const bad = violation(all, after);
    if (bad) return res.status(409).json({ error: 'Not allowed: ' + bad });

    const oldV = { qty: cur.qty, d: cur.d, kind: cur.kind, contractor: cur.contractor, party: cur.party, stype: cur.stype };
    const newV = b.action === 'edit' ? { qty: newQty, d: newD } : { deleted: true };
    await sql`INSERT INTO wa_audit (entry_id, action, old_value, new_value, by_who) VALUES (${id}, ${b.action}, ${JSON.stringify(oldV)}, ${JSON.stringify(newV)}, 'Jatin (admin)')`;
    if (b.action === 'edit') {
      await sql`UPDATE wa_entries SET qty = ${newQty}, d = ${newD}::date WHERE id = ${id} AND deleted = false`;
    } else {
      await sql`UPDATE wa_entries SET deleted = true WHERE id = ${id} AND deleted = false`;
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
