import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';
// Admin Order Book: orders (from sale app), progress (contractor entries), Midland stamping + rotor.
const START = '2026-10-01';

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
const CONTRACTORS = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil'];
function norm(p) {
  const k = String(p || '').toLowerCase().replace(/[^a-z]/g, '');
  return CONTRACTORS.find(c => c.toLowerCase() === k) || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (verify(req) !== 'ADMIN') return res.status(401).json({ error: 'Admin login needed' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'issue') {
        const oid = parseInt(b.order_id, 10), qty = Number(b.qty), c = String(b.contractor || '');
        if (!CONTRACTORS.includes(c)) return res.status(400).json({ error: 'Choose a contractor' });
        if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Enter a whole quantity above 0' });
        const o = await sql`SELECT qty, cancelled, COALESCE((SELECT SUM(qty) FROM ca_issues WHERE order_id = ca_orders.id),0)::int AS issued FROM ca_orders WHERE id = ${oid}`;
        if (!o.length || o[0].cancelled) return res.status(404).json({ error: 'Order not found' });
        const left = o[0].qty - o[0].issued;
        if (qty > left) return res.status(409).json({ error: 'Only ' + left + ' left to issue in this order' });
        await sql`INSERT INTO ca_issues (order_id, contractor, qty) VALUES (${oid}, ${c}, ${qty})`;
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Invalid action' });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

    const orders = await sql`SELECT o.id, o.order_no, o.customer, o.stator_type, o.winding_type, o.motor_type, o.rotor_item, o.qty::int AS qty,
        to_char(o.due,'YYYY-MM-DD') AS due, to_char(o.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS created,
        COALESCE((SELECT SUM(i.qty) FROM ca_issues i WHERE i.order_id = o.id),0)::int AS issued
      FROM ca_orders o WHERE o.cancelled = false ORDER BY o.id DESC LIMIT 200`;
    const issues = await sql`SELECT i.id, i.order_id, i.contractor, i.qty::int AS qty, o.order_no, o.winding_type, o.stator_type, o.rotor_item, to_char(o.due,'YYYY-MM-DD') AS due,
        COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'wound'),0)::int AS wound,
        COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'sent'),0)::int AS given,
        COALESCE((SELECT string_agg(DISTINCT e.stype, ', ') FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'wound' AND e.stype IS DISTINCT FROM o.stator_type),'') AS used
      FROM ca_issues i JOIN ca_orders o ON o.id = i.order_id WHERE o.cancelled = false ORDER BY i.id DESC`;

    // Stamping each contractor holds = Midland stamping outward + manual receipts + transfers in - transfers out - wound
    const held = {}; CONTRACTORS.forEach(c => { held[c] = { recv: 0, wound: 0, types: {} }; });
    const add = (c, t, v) => { if (!held[c]) return; held[c].types[t] = (held[c].types[t] || 0) + v; };
    const w = await sql`SELECT kind, contractor, party, stype, SUM(qty)::float AS q FROM wa_entries
      WHERE deleted = false AND d >= ${START}::date AND kind IN ('stamp_in','wound','transfer') GROUP BY kind, contractor, party, stype`;
    w.forEach(r => {
      if (r.kind === 'stamp_in') { held[r.contractor] && (held[r.contractor].recv += r.q); add(r.contractor, r.stype, r.q); }
      if (r.kind === 'wound') { held[r.contractor] && (held[r.contractor].wound += r.q); add(r.contractor, r.stype, -r.q); }
      if (r.kind === 'transfer') { add(r.contractor, r.stype, -r.q); if (held[r.party]) { held[r.party].recv += r.q; add(r.party, r.stype, r.q); } if (held[r.contractor]) held[r.contractor].recv -= r.q; }
    });
    let midlandError = null, rotorRows = [];
    try {
      const m = await sql`SELECT t.party_name, t.quantity::float AS q, i.name AS item FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
        WHERE upper(t.transaction_type) = 'OUTWARD' AND i.category IN ('STAMPING','AIRY STAMPING') AND t.transaction_date >= ${START}::date`;
      m.forEach(x => { const c = norm(x.party_name); if (c) { held[c].recv += x.q; add(c, x.item, x.q); } });
      rotorRows = await sql`SELECT i.name, COALESCE(i.opening_balance,0)::float
          + COALESCE(SUM(CASE WHEN upper(t.transaction_type) = 'INWARD' THEN t.quantity WHEN upper(t.transaction_type) = 'OUTWARD' THEN -t.quantity ELSE 0 END),0)::float AS stock
        FROM inventory_items i LEFT JOIN inventory_transactions t ON t.item_id = i.id WHERE i.category = 'ROTOR' GROUP BY i.id, i.name, i.opening_balance ORDER BY i.name`;
    } catch (e) { midlandError = String(e.message || e); }

    // Rotor need per item = open order qty (not cancelled) that is not fully dispatched is unknown here, so use order qty not yet wound
    const need = {};
    orders.forEach(o => { if (!o.rotor_item) return; const wnd = issues.filter(i => i.order_id === o.id).reduce((a, i) => a + i.wound, 0); need[o.rotor_item] = (need[o.rotor_item] || 0) + Math.max(0, o.qty - wnd); });
    const rotor = rotorRows.map(r => ({ name: r.name, stock: r.stock, need: need[r.name] || 0 })).filter(r => r.stock !== 0 || r.need > 0);

    // Demand per contractor AND per stamping type: need = (issued - wound) of orders using that stamping; holds = stamping of that exact type with the contractor.
    const K = t => String(t || '').trim().toUpperCase();
    const demand = CONTRACTORS.map(c => {
      const mine = issues.filter(i => i.contractor === c);
      const qty = mine.reduce((a, i) => a + i.qty, 0), wound = mine.reduce((a, i) => a + i.wound, 0);
      const rows = {};
      mine.forEach(i => { const k = K(i.stator_type); const r = rows[k] || (rows[k] = { type: i.stator_type || '(no stamping)', need: 0, holds: 0 }); r.need += Math.max(0, i.qty - i.wound); });
      Object.entries(held[c].types).forEach(([t, v]) => { const k = K(t); if (v <= 0) return; const r = rows[k] || (rows[k] = { type: t, need: 0, holds: 0 }); r.holds += v; });
      const list = Object.values(rows).map(r => ({ ...r, send: Math.max(0, r.need - r.holds) })).sort((a, b) => b.need - a.need || a.type.localeCompare(b.type));
      const left = Math.max(0, qty - wound);
      // Bars against issued winding: stamping covered = already used + still held (right type); rotor = shared Midland stock of the order's rotor type
      const byT = {};
      mine.forEach(i => { const k = K(i.stator_type); const x = byT[k] || (byT[k] = { iss: 0, wnd: 0 }); x.iss += i.qty; x.wnd += i.wound; });
      let stampHave = 0;
      Object.entries(byT).forEach(([k, x]) => { const r = rows[k]; stampHave += Math.min(x.iss, x.wnd + (r ? r.holds : 0)); });
      const rq = {}; mine.forEach(i => { if (i.rotor_item) rq[i.rotor_item] = (rq[i.rotor_item] || 0) + i.qty; });
      const rotorItems = Object.entries(rq).map(([name, need]) => { const st = (rotorRows.find(r => r.name === name) || { stock: 0 }).stock; return { name, need, stock: Math.max(0, st), have: Math.min(need, Math.max(0, st)) }; });
      return { contractor: c, qty, wound, left, send: list.reduce((a, r) => a + r.send, 0), rows: list, stampHave: Math.min(qty, stampHave),
        rotorNeed: rotorItems.reduce((a, r) => a + r.need, 0), rotorHave: rotorItems.reduce((a, r) => a + r.have, 0), rotorItems };
    }).filter(d => d.qty > 0);
    // Overview: ready stators per contractor (wound - given) and ready motors per Pandey ji / Sunil (made - dispatched)
    let overview = null;
    try {
      const ev = await sql`SELECT kind, contractor, party, stype, qty::float AS q, to_char(d,'YYYY-MM-DD') AS d FROM wa_entries
        WHERE deleted = false AND d >= ${START}::date AND kind IN ('wound','sent','made','mdispatch','dispatch') ORDER BY d, id`;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const days = d => Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 86400000));
      const stat = {};
      CONTRACTORS.forEach(c => { stat[c] = { name: c, wound: 0, given: 0, types: {}, list: [], sentTotal: 0 }; });
      const mot = {};
      ['Pandey ji', 'Sunil'].forEach(p => { mot[p] = { name: p, made: 0, sent: 0, from: {} }; });
      const bump = (m, k, f, v) => { m[k] = m[k] || { name: k, made: 0, sent: 0, wound: 0, given: 0 }; m[k][f] += v; };
      ev.forEach(e => {
        if (stat[e.contractor] && (e.kind === 'wound' || e.kind === 'sent')) {
          const s = stat[e.contractor];
          if (e.kind === 'wound') { s.wound += e.q; s.list.push({ d: e.d, q: e.q }); bump(s.types, e.stype || '-', 'wound', e.q); }
          else { s.given += e.q; bump(s.types, e.stype || '-', 'given', e.q); }
        }
        if (mot[e.contractor] && (e.kind === 'made' || e.kind === 'mdispatch' || e.kind === 'dispatch')) {
          const m = mot[e.contractor], src = e.party ? e.party + ' - ' + (e.stype || '') : null;
          // older dispatch entries with a winding count as made and dispatched
          if (e.kind === 'made' || (e.kind === 'dispatch' && e.party)) { m.made += e.q; if (src) bump(m.from, src, 'made', e.q); }
          if (e.kind === 'mdispatch' || e.kind === 'dispatch') { m.sent += e.q; if (src) bump(m.from, src, 'sent', e.q); }
        }
      });
      const stators = Object.values(stat).map(s => {
        // oldest ready = first wound entry left after the given quantity is taken from the oldest ones
        let skip = s.given, oldest = null;
        for (const w of s.list) { if (skip >= w.q) { skip -= w.q; continue; } oldest = w.d; break; }
        const ready = s.wound - s.given;
        return { name: s.name, wound: s.wound, given: s.given, ready, oldest_days: ready > 0 && oldest ? days(oldest) : null,
          types: Object.values(s.types).map(t => ({ name: t.name, wound: t.wound, given: t.given, ready: t.wound - t.given })).filter(t => t.wound || t.given).sort((a, b) => b.ready - a.ready) };
      }).filter(s => s.wound || s.given);
      const motors = Object.values(mot).map(m => ({ name: m.name, made: m.made, sent: m.sent, ready: m.made - m.sent,
        from: Object.values(m.from).map(t => ({ name: t.name, made: t.made, sent: t.sent, ready: t.made - t.sent })).sort((a, b) => b.ready - a.ready) }));
      const inhand = inHand(ev);
      overview = { stators, motors, inhand, ready_stators: stators.reduce((a, s) => a + s.ready, 0) + inhand.reduce((a, m) => a + m.total, 0), ready_motors: motors.reduce((a, m) => a + m.ready, 0) };
    } catch (e) { overview = { error: String(e.message || e) }; }
    return res.status(200).json({ orders, issues, overview, demand, rotor, midlandError, contractors: CONTRACTORS });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
