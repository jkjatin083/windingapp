import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';

const START = '2026-10-01';
// Contractors who use this page (App 1). Pandey ji uses App 2.
const WHO = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil'];

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function normParty(p) {
  const k = String(p || '').toLowerCase().replace(/[^a-z]/g, '');
  return WHO.find(c => c.toLowerCase() === k) || null;
}

// Per stamping type: made (wound) and given (sent) by this contractor
async function holds(sql, me) {
  const r = await sql`SELECT stype,
      COALESCE(SUM(CASE WHEN kind = 'wound' THEN qty END),0)::float AS made,
      COALESCE(SUM(CASE WHEN kind = 'sent' THEN qty END),0)::float AS given
    FROM wa_entries WHERE deleted = false AND contractor = ${me} AND d >= ${START}::date AND kind IN ('wound','sent')
    GROUP BY stype`;
  const o = {};
  r.forEach(x => { o[x.stype] = { made: x.made, given: x.given, held: x.made - x.given }; });
  return o;
}

// Stamping with this contractor, per type: received (Midland OUTWARD to this contractor + manual receipts + transfers) minus stators made
async function stampStock(sql, me) {
  const o = {};
  const g = t => o[t] || (o[t] = { recv: 0, made: 0, bal: 0 });
  try {
    const m = await sql`SELECT t.party_name, t.quantity::float AS q, i.name AS item FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
      WHERE upper(t.transaction_type) = 'OUTWARD' AND i.category IN ('STAMPING', 'AIRY STAMPING') AND t.transaction_date >= ${START}::date`;
    m.forEach(x => { if (normParty(x.party_name) === me) g(x.item).recv += x.q; });
  } catch (e) { /* Midland not readable */ }
  const w = await sql`SELECT kind, contractor, party, stype, qty::float AS q FROM wa_entries
    WHERE deleted = false AND d >= ${START}::date AND stype IS NOT NULL
      AND ((contractor = ${me} AND kind IN ('stamp_in','wound','transfer')) OR (party = ${me} AND kind = 'transfer'))`;
  w.forEach(x => {
    if (x.kind === 'stamp_in') g(x.stype).recv += x.q;
    else if (x.kind === 'wound') g(x.stype).made += x.q;
    else if (x.kind === 'transfer') { if (x.party === me) g(x.stype).recv += x.q; else g(x.stype).recv -= x.q; }
  });
  Object.values(o).forEach(x => { x.bal = x.recv - x.made; });
  return o;
}

async function openIssues(sql, me) {
  let rows = [];
  try {
    rows = await sql`SELECT i.id, i.qty::float AS qty, o.order_no, o.winding_type, o.motor_type, o.stator_type,
        to_char(o.due, 'YYYY-MM-DD') AS due,
        COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id
                  WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'wound'),0)::float AS wound,
        COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id
                  WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'sent'),0)::float AS given
      FROM ca_issues i JOIN ca_orders o ON o.id = i.order_id
      WHERE i.contractor = ${me} AND i.closed = false ORDER BY i.id`;
  } catch (e) { return { rows: [], err: String(e.message || e) }; }
  return { rows: rows.map(r => ({ ...r, left: Math.max(0, r.qty - r.wound) })).filter(r => r.left > 0 || r.given < r.wound) };
}

async function stampTypes(sql, me) {
  const set = new Set();
  const a = await sql`SELECT DISTINCT stype FROM wa_entries WHERE deleted = false AND contractor = ${me} AND stype IS NOT NULL AND kind IN ('wound','stamp_in','transfer','sent')`;
  a.forEach(x => x.stype && set.add(x.stype));
  try {
    const m = await sql`SELECT t.party_name, i.name AS item FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
      WHERE upper(t.transaction_type) = 'OUTWARD' AND i.category IN ('STAMPING', 'AIRY STAMPING') AND t.transaction_date >= ${START}::date`;
    m.forEach(x => { if (normParty(x.party_name) === me) set.add(x.item); });
  } catch (e) { /* Midland not readable: use own entries only */ }
  return [...set].sort();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = verify(req);
  if (!me || !WHO.includes(me)) return res.status(401).json({ error: 'Please log in' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    const today = todayIST();
    if (req.method === 'GET') {
      const view = String(req.query.view || 'home');
      if (view === 'home') {
        const iss = await openIssues(sql, me);
        const t = await sql`SELECT COALESCE(SUM(qty),0)::float AS v FROM wa_entries WHERE deleted = false AND contractor = ${me} AND kind = 'wound' AND d = ${today}::date`;
        return res.status(200).json({ me, today, types: await stampTypes(sql, me), holds: await holds(sql, me), stamp: await stampStock(sql, me).catch(() => ({})), issues: iss.rows, issueErr: iss.err || null, madeToday: t[0].v });
      }
      if (view === 'report') {
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : START;
        const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
        let rows;
        try {
          rows = await sql`SELECT to_char(e.d,'YYYY-MM-DD') AS d, e.stype, COALESCE(m.winding_type,'-') AS wt, o.order_no,
              COALESCE(SUM(CASE WHEN e.kind='wound' THEN e.qty END),0)::float AS made,
              COALESCE(SUM(CASE WHEN e.kind='sent' THEN e.qty END),0)::float AS given
            FROM wa_entries e LEFT JOIN ca_meta m ON m.entry_id = e.id
              LEFT JOIN ca_issues i ON i.id = m.issue_id LEFT JOIN ca_orders o ON o.id = i.order_id
            WHERE e.deleted = false AND e.contractor = ${me} AND e.kind IN ('wound','sent') AND e.d >= ${START}::date
            GROUP BY e.d, e.stype, m.winding_type, o.order_no ORDER BY e.d, e.stype`;
        } catch (e) {
          rows = await sql`SELECT to_char(e.d,'YYYY-MM-DD') AS d, e.stype, '-' AS wt, NULL AS order_no,
              COALESCE(SUM(CASE WHEN e.kind='wound' THEN e.qty END),0)::float AS made,
              COALESCE(SUM(CASE WHEN e.kind='sent' THEN e.qty END),0)::float AS given
            FROM wa_entries e WHERE e.deleted = false AND e.contractor = ${me} AND e.kind IN ('wound','sent') AND e.d >= ${START}::date
            GROUP BY e.d, e.stype ORDER BY e.d, e.stype`;
        }
        // running held per stamping type, counted from START, then cut to the date range
        const run = {};
        const out = [];
        for (const r of rows) {
          run[r.stype] = (run[r.stype] || 0) + r.made - r.given;
          if (r.d >= from && r.d <= to) out.push({ ...r, held: run[r.stype] });
        }
        const iss = await openIssues(sql, me);
        let orders = [];
        try {
          orders = await sql`SELECT o.order_no, o.winding_type, o.stator_type, i.qty::float AS qty, to_char(o.due,'YYYY-MM-DD') AS due,
              COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind='wound'),0)::float AS wound,
              COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind='sent'),0)::float AS given
            FROM ca_issues i JOIN ca_orders o ON o.id = i.order_id WHERE i.contractor = ${me} ORDER BY i.id DESC`;
        } catch (e) { /* tables not created yet */ }
        return res.status(200).json({ from, to, rows: out, orders, holds: await holds(sql, me), stamp: await stampStock(sql, me).catch(() => ({})), open: iss.rows.length });
      }
      return res.status(400).json({ error: 'Invalid view' });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const kind = b.action === 'give' ? 'sent' : (b.action === 'made' ? 'wound' : null);
      if (!kind) return res.status(400).json({ error: 'Invalid action' });
      const qty = Number(b.qty);
      const stype = String(b.stype || '').trim().slice(0, 60);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 1000000) return res.status(400).json({ error: 'Enter a whole number above 0' });
      if (!stype) return res.status(400).json({ error: 'Choose the stamping type' });
      // winding type from the order issued by Sandeep
      const iss = await openIssues(sql, me);
      let issue = null;
      if (iss.rows.length) {
        const id = parseInt(b.issue_id, 10);
        issue = iss.rows.find(x => x.id === id) || (iss.rows.length === 1 ? iss.rows[0] : null);
        if (!issue) return res.status(400).json({ error: 'Choose the order' });
        if (kind === 'wound' && qty > issue.left) return res.status(409).json({ error: 'Only ' + issue.left + ' left in order ' + issue.order_no });
      }
      if (kind === 'sent') {
        const h = (await holds(sql, me))[stype] || { held: 0 };
        if (qty > h.held) return res.status(409).json({ error: 'You hold only ' + h.held + ' of ' + stype + '. Cannot give ' + qty });
      }
      const dup = await sql`SELECT id FROM wa_entries WHERE deleted = false AND kind = ${kind} AND contractor = ${me}
        AND d = ${today}::date AND stype = ${stype} AND qty = ${qty} LIMIT 1`;
      if (dup.length) return res.status(409).json({ error: 'Same entry is already saved today. Ask Jatin to edit it, or enter a different number.' });
      const party = kind === 'sent' ? (me === 'Sunil' ? 'Sunil' : 'Pandey ji') : null;
      const r = await sql`INSERT INTO wa_entries (kind, contractor, party, stype, qty, d, note)
        VALUES (${kind}, ${me}, ${party}, ${stype}, ${qty}, ${today}::date, ${'via contractor app'}) RETURNING id`;
      if (issue) {
        try {
          await sql`INSERT INTO ca_meta (entry_id, issue_id, winding_type) VALUES (${r[0].id}, ${issue.id}, ${issue.winding_type})`;
        } catch (e) {
          await sql`UPDATE wa_entries SET deleted = true WHERE id = ${r[0].id}`;
          return res.status(500).json({ error: 'Could not save the order link: ' + String(e.message || e) });
        }
      }
      return res.status(200).json({ ok: true, id: r[0].id });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
