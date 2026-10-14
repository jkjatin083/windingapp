import { neon } from '@neondatabase/serverless';
import { verify } from './_auth.js';

// Orders issued to winding contractors, for the App 2 page (Pandey ji / Sunil) so motor entries can be tagged to an order.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = verify(req);
  if (me !== 'Pandey ji' && me !== 'Sunil' && me !== 'ADMIN') return res.status(401).json({ error: 'Please log in' });
  try {
    const sql = neon(process.env.DATABASE_URL);
    const issues = await sql`SELECT i.id, i.contractor, i.qty::int AS qty, o.order_no, o.customer, o.stator_type, o.winding_type, o.motor_type,
        COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'made'),0)::int AS made,
        COALESCE((SELECT SUM(e.qty) FROM ca_meta m JOIN wa_entries e ON e.id = m.entry_id WHERE m.issue_id = i.id AND e.deleted = false AND e.kind = 'mdispatch'),0)::int AS sent
      FROM ca_issues i JOIN ca_orders o ON o.id = i.order_id
      WHERE o.cancelled = false AND i.closed = false ORDER BY i.id`;
    return res.status(200).json({ issues });
  } catch (e) {
    return res.status(200).json({ issues: [] });
  }
}
