import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';
import { midlandTypes } from './_mid.js';


const START = '2026-10-01';
const CONTRACTORS = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil'];

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


// Stators in hand with the motor makers (Pandey ji / Sunil): given to them minus motors they made, per source contractor + stamping type
function inHand(ev) {
  const norm = s => String(s || '').trim().toLowerCase();
  const makers = { 'pandey ji': 'Pandey ji', 'sunil': 'Sunil' };
  const acc = {};
  const slot = (maker, src, ty) => {
    const k = [norm(maker), norm(src), norm(ty || '-')].join('|');
    return acc[k] || (acc[k] = { maker: makers[norm(maker)], name: String(src).trim() + ' - ' + (ty || '-'), sent: 0, made: 0 });
  };
  ev.forEach(e => {
    if (e.kind === 'sent' && makers[norm(e.party)] && e.contractor) slot(e.party, e.contractor, e.stype).sent += e.q;
    else if ((e.kind === 'made' || (e.kind === 'dispatch' && e.party)) && makers[norm(e.contractor)] && e.party) slot(e.contractor, e.party, e.stype).made += e.q;
  });
  return ['Pandey ji', 'Sunil'].map(m => {
    const rows = Object.values(acc).filter(x => x.maker === m).map(x => ({ name: x.name, sent: x.sent, made: x.made, ready: x.sent - x.made }))
      .filter(x => x.ready > 0).sort((a, b) => b.ready - a.ready);
    return { name: m, rows, total: rows.reduce((a, r) => a + r.ready, 0) };
  }).filter(m => m.rows.length);
}

// Ready stators per contractor (wound - given) and ready motors per Pandey ji / Sunil (made - dispatched)
async function overviewData(sql) {
  const ev = await sql`SELECT kind, contractor, party, stype, qty::float AS q, to_char(d,'YYYY-MM-DD') AS d FROM wa_entries
    WHERE deleted = false AND d >= ${START}::date AND kind IN ('wound','sent','made','mdispatch','dispatch') ORDER BY d, id`;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const days = d => Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 86400000));
  const stat = {};
  CONTRACTORS.forEach(c => { stat[c] = { name: c, wound: 0, given: 0, types: {}, list: [] }; });
  const mot = {};
  ['Pandey ji', 'Sunil'].forEach(p => { mot[p] = { name: p, made: 0, sent: 0, from: {} }; });
  const bump = (m, k, f, v) => { m[k] = m[k] || { name: k, made: 0, sent: 0, wound: 0, given: 0 }; m[k][f] += v; };
  ev.forEach(e => {
    if (stat[e.contractor] && (e.kind === 'wound' || e.kind === 'sent')) {
      const x = stat[e.contractor];
      if (e.kind === 'wound') { x.wound += e.q; x.list.push({ d: e.d, q: e.q }); bump(x.types, e.stype || '-', 'wound', e.q); }
      else { x.given += e.q; bump(x.types, e.stype || '-', 'given', e.q); }
    }
    if (mot[e.contractor] && (e.kind === 'made' || e.kind === 'mdispatch' || e.kind === 'dispatch')) {
      const m = mot[e.contractor], src = e.party ? e.party + ' - ' + (e.stype || '') : null;
      if (e.kind === 'made' || (e.kind === 'dispatch' && e.party)) { m.made += e.q; if (src) bump(m.from, src, 'made', e.q); }
      if (e.kind === 'mdispatch' || e.kind === 'dispatch') { m.sent += e.q; if (src) bump(m.from, src, 'sent', e.q); }
    }
  });
  const stators = Object.values(stat).map(x => {
    let skip = x.given, oldest = null;
    for (const w of x.list) { if (skip >= w.q) { skip -= w.q; continue; } oldest = w.d; break; }
    const ready = x.wound - x.given;
    return { name: x.name, wound: x.wound, given: x.given, ready, oldest_days: ready > 0 && oldest ? days(oldest) : null,
      types: Object.values(x.types).map(t => ({ name: t.name, wound: t.wound, given: t.given, ready: t.wound - t.given })).filter(t => t.wound || t.given).sort((a, b) => b.ready - a.ready) };
  }).filter(x => x.wound || x.given);
  const motors = Object.values(mot).map(m => ({ name: m.name, made: m.made, sent: m.sent, ready: m.made - m.sent,
    from: Object.values(m.from).map(t => ({ name: t.name, made: t.made, sent: t.sent, ready: t.made - t.sent })).sort((a, b) => b.ready - a.ready) }));
  const inhand = inHand(ev);
  return { stators, motors, inhand, ready_stators: stators.reduce((a, x) => a + x.ready, 0) + inhand.reduce((a, m) => a + m.total, 0), ready_motors: motors.reduce((a, m) => a + m.ready, 0) };
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
      const custRows = await sql`SELECT customer FROM ca_orders WHERE cancelled = false AND customer <> '' GROUP BY customer ORDER BY MAX(id) DESC LIMIT 500`;
      const mid = await midlandTypes(sql);
      const stamps = mid.stamps, rotors = mid.rotors;
      let pipe = []; try { pipe = await pipeline(sql, orders.filter(o => !o.cancelled)); } catch (e) { /* tables or entries not ready */ }
      // Closed = every stage done, incl. all motors dispatched for the full order qty
      orders.forEach(o => { const p = pipe.find(x => x.id === o.id); o.closed = !!(p && p.stages.every(st => st.done)); });
      let overview = null; try { overview = await overviewData(sql); } catch (e) { overview = { error: String(e.message || e) }; }
      return res.status(200).json({ orders, customers: custRows.map(r => r.customer), pipe, overview, winding: opt.filter(x => x.kind === 'winding').map(x => x.val), motor: Array.from(new Set(mid.motors.concat(opt.filter(x => x.kind === 'motor').map(x => x.val)))), stamps, rotors });
    }
    if (req.method === 'POST') {
      if (me !== 'Sandeep') return res.status(403).json({ error: 'Only Sandeep adds or edits orders' });
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
      if (b.action === 'edit') {
        const id = parseInt(b.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid order' });
        const cur = await sql`SELECT o.id, o.order_no, o.cancelled, COALESCE((SELECT SUM(i.qty) FROM ca_issues i WHERE i.order_id = o.id),0)::int AS issued FROM ca_orders o WHERE o.id = ${id}`;
        if (!cur.length) return res.status(404).json({ error: 'Order not found' });
        if (cur[0].cancelled) return res.status(409).json({ error: 'This order is cancelled' });
        const customer = t(b.customer), stator = t(b.stator_type), winding = t(b.winding_type, 40), motor = t(b.motor_type, 40), rotor = t(b.rotor_item) || null, qty = Number(b.qty);
        if (!customer) return res.status(400).json({ error: 'Enter the customer' });
        if (!stator) return res.status(400).json({ error: 'Choose the stamping type' });
        if (!winding) return res.status(400).json({ error: 'Choose the winding type' });
        if (!motor) return res.status(400).json({ error: 'Choose the motor type' });
        if (!Number.isInteger(qty) || qty <= 0 || qty > 10000000) return res.status(400).json({ error: 'Enter a whole quantity above 0' });
        if (qty < cur[0].issued) return res.status(409).json({ error: 'Already issued ' + cur[0].issued + ' to contractors. Quantity cannot be below ' + cur[0].issued });
        const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : null;
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
        const od = /^\d{4}-\d{2}-\d{2}$/.test(b.order_date || '') ? b.order_date : null;
        if (od && od > today) return res.status(400).json({ error: 'Order date cannot be in the future' });
        await sql`UPDATE ca_orders SET customer = ${customer}, stator_type = ${stator}, winding_type = ${winding}, motor_type = ${motor}, rotor_item = ${rotor}, qty = ${qty}, due = ${due}::date,
            created_at = CASE WHEN ${od}::date IS NULL THEN created_at ELSE (${od}::date + (created_at AT TIME ZONE 'Asia/Kolkata')::time) AT TIME ZONE 'Asia/Kolkata' END
          WHERE id = ${id}`;
        return res.status(200).json({ ok: true, order_no: cur[0].order_no });
      }
      if (b.action !== 'add') return res.status(400).json({ error: 'Invalid action' });
      const customer = t(b.customer);
      if (!customer) return res.status(400).json({ error: 'Enter the customer' });
      const raw = Array.isArray(b.lines) && b.lines.length ? b.lines : [b];
      if (raw.length > 20) return res.status(400).json({ error: 'Too many motor lines' });
      const lines = raw.map((x, n) => ({ n: n + 1, stator: t(x.stator_type), winding: t(x.winding_type, 40), motor: t(x.motor_type, 40), rotor: t(x.rotor_item) || null, qty: Number(x.qty) }));
      for (const f of lines) {
        const tag = lines.length > 1 ? 'Motor ' + f.n + ': ' : '';
        if (!f.stator) return res.status(400).json({ error: tag + 'Choose the stamping type' });
        if (!f.winding) return res.status(400).json({ error: tag + 'Choose the winding type' });
        if (!f.motor) return res.status(400).json({ error: tag + 'Choose the motor type' });
        if (!Number.isInteger(f.qty) || f.qty <= 0 || f.qty > 10000000) return res.status(400).json({ error: tag + 'Enter a whole quantity above 0' });
      }
      const keys = lines.map(f => [f.stator, f.winding, f.motor, f.rotor || '', f.qty].join('|'));
      if (new Set(keys).size !== keys.length) return res.status(400).json({ error: 'Two motor lines are exactly the same' });
      const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : null;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const od = /^\d{4}-\d{2}-\d{2}$/.test(b.order_date || '') ? b.order_date : today;
      if (od > today) return res.status(400).json({ error: 'Order date cannot be in the future' });
      for (const f of lines) {
        const dup = await sql`SELECT order_no FROM ca_orders WHERE cancelled = false AND customer = ${customer} AND stator_type = ${f.stator}
          AND winding_type = ${f.winding} AND motor_type = ${f.motor} AND qty = ${f.qty} AND created_at > now() - interval '10 minutes' LIMIT 1`;
        if (dup.length) return res.status(409).json({ error: 'Same order was just saved (#' + dup[0].order_no + ')' });
      }
      const nos = [];
      for (const f of lines) {
        const r = await sql`INSERT INTO ca_orders (order_no, customer, stator_type, winding_type, motor_type, rotor_item, qty, due, created_by, created_at)
          VALUES ((SELECT (COALESCE(MAX(id),0)+1)::text FROM ca_orders), ${customer}, ${f.stator}, ${f.winding}, ${f.motor}, ${f.rotor}, ${f.qty}, ${due}::date, 'Sandeep',
            (${od}::date + (now() AT TIME ZONE 'Asia/Kolkata')::time) AT TIME ZONE 'Asia/Kolkata')
          RETURNING id, order_no`;
        nos.push(r[0].order_no);
      }
      return res.status(200).json({ ok: true, order_no: nos[0], order_nos: nos });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
