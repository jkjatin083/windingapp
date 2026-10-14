import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';
import { midlandTypes } from './_mid.js';


const START = '2026-10-01';

// Day when the running total of entries reaches qty (or null)
function doneDate(list, qty) {
  let cum = 0;
  for (const e of list) { cum += e.q; if (cum >= qty) return e.d; }
  return null;
}

async function pipeline(sql, orders) {
  const iss = await sql`SELECT id, order_id, contractor, qty::int AS qty, to_char(issued_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS d FROM ca_issues ORDER BY id`;
  const ent = await sql`SELECT e.kind, e.contractor, e.party, e.qty::float AS q, to_char(e.d,'YYYY-MM-DD') AS d, m.issue_id
    FROM wa_entries e LEFT JOIN ca_meta m ON m.entry_id = e.id
    WHERE e.deleted = false AND e.d >= ${START}::date AND e.kind IN ('wound','made','mdispatch') ORDER BY e.d, e.id`;
  const res = {};
  // Every stage now comes from entries tagged to the issue (order): winding by the contractor page, motors and dispatch by the App 2 page.
  iss.forEach(i => {
    const one = (kind) => {
      const list = ent.filter(e => e.kind === kind && e.issue_id === i.id);
      const n = list.reduce((x, e) => x + e.q, 0);
      return { done: Math.min(n, i.qty), date: doneDate(list, i.qty) };
    };
    res[i.id] = { wound: one('wound'), made: one('made'), disp: one('mdispatch') };
  });
  return orders.map(o => {
    const mine = iss.filter(i => i.order_id === o.id);
    const full = mine.reduce((a, i) => a + i.qty, 0) >= o.qty;
    const agg = k => {
      const n = mine.reduce((a, i) => a + res[i.id][k].done, 0);
      const done = full && n >= o.qty;
      const dates = mine.map(i => res[i.id][k].date).filter(Boolean).sort();
      return { n, done, date: done ? dates[dates.length - 1] : null };
    };
    const w = agg('wound'), m = agg('made'), d = agg('disp');
    return { id: o.id, stages: [
      { k: 'Order', done: true, n: o.qty, date: o.created },
      { k: 'Winding', done: w.done, n: w.n, date: w.date },
      { k: 'Motor', done: m.done, n: m.n, date: m.date },
      { k: 'Ready to dispatch', done: m.done, n: m.n, date: m.date },
      { k: 'Dispatched', done: d.done, n: d.n, date: d.date },
      { k: 'Order completed', done: d.done, n: d.n, date: d.date }
    ] };
  });
}

// Sale orders. Used by Sandeep (create) and Admin (view).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = verify(req);
  if (me !== 'Sandeep' && me !== 'ADMIN') return res.status(401).json({ error: 'Please log in' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'GET') {
      const orders = await sql`SELECT o.id, o.order_no, o.customer, o.stator_type, o.winding_type, o.motor_type, o.rotor_item, o.qty,
          to_char(o.due,'YYYY-MM-DD') AS due, to_char(o.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS created, o.cancelled,
          COALESCE((SELECT SUM(i.qty) FROM ca_issues i WHERE i.order_id = o.id),0)::int AS issued
        FROM ca_orders o ORDER BY o.id DESC LIMIT 100`;
      const opt = await sql`SELECT kind, val FROM ca_options ORDER BY val`;
      const mid = await midlandTypes(sql);
      const stamps = mid.stamps, rotors = mid.rotors;
      let pipe = []; try { pipe = await pipeline(sql, orders.filter(o => !o.cancelled)); } catch (e) { /* tables or entries not ready */ }
      return res.status(200).json({ orders, pipe, winding: opt.filter(x => x.kind === 'winding').map(x => x.val), motor: Array.from(new Set(mid.motors.concat(opt.filter(x => x.kind === 'motor').map(x => x.val)))), stamps, rotors });
    }
    if (req.method === 'POST') {
      if (me !== 'Sandeep') return res.status(403).json({ error: 'Only Sandeep adds orders' });
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const t = (v, n) => String(v || '').trim().slice(0, n || 80);
      if (b.action === 'option') {
        const kind = b.kind === 'motor' ? 'motor' : 'winding', val = t(b.val, 40);
        if (!val) return res.status(400).json({ error: 'Enter a value' });
        await sql`INSERT INTO ca_options (kind, val) VALUES (${kind}, ${val}) ON CONFLICT DO NOTHING`;
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'cancel') {
        const id = parseInt(b.id, 10);
        const x = await sql`SELECT COUNT(*)::int AS n FROM ca_issues WHERE order_id = ${id}`;
        if (x[0].n > 0) return res.status(409).json({ error: 'Already issued to a contractor. Ask Jatin.' });
        await sql`UPDATE ca_orders SET cancelled = true WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }
      if (b.action !== 'add') return res.status(400).json({ error: 'Invalid action' });
      const qty = Number(b.qty);
      const f = { customer: t(b.customer), stator: t(b.stator_type), winding: t(b.winding_type, 40), motor: t(b.motor_type, 40), rotor: t(b.rotor_item) || null };
      if (!f.customer) return res.status(400).json({ error: 'Enter the customer' });
      if (!f.stator) return res.status(400).json({ error: 'Choose the stator type' });
      if (!f.winding) return res.status(400).json({ error: 'Choose the winding type' });
      if (!f.motor) return res.status(400).json({ error: 'Choose the motor type' });
      if (!Number.isInteger(qty) || qty <= 0 || qty > 10000000) return res.status(400).json({ error: 'Enter a whole quantity above 0' });
      const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : null;
      const dup = await sql`SELECT order_no FROM ca_orders WHERE cancelled = false AND customer = ${f.customer} AND stator_type = ${f.stator}
        AND winding_type = ${f.winding} AND motor_type = ${f.motor} AND qty = ${qty} AND created_at > now() - interval '10 minutes' LIMIT 1`;
      if (dup.length) return res.status(409).json({ error: 'Same order was just saved (#' + dup[0].order_no + ')' });
      const r = await sql`INSERT INTO ca_orders (order_no, customer, stator_type, winding_type, motor_type, rotor_item, qty, due, created_by)
        VALUES ((SELECT (COALESCE(MAX(id),0)+1)::text FROM ca_orders), ${f.customer}, ${f.stator}, ${f.winding}, ${f.motor}, ${f.rotor}, ${qty}, ${due}::date, 'Sandeep')
        RETURNING id, order_no`;
      return res.status(200).json({ ok: true, order_no: r[0].order_no });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
