// Live type lists from Midland (stamping, rotor, motor). Nothing is hard-coded:
// new items added in Midland show up in the apps the next time they open.
const URL = 'https://midlandmetals.vercel.app/api/inventory';

function split(items) {
  const cat = x => String(x.category || '').trim().toUpperCase();
  const names = f => items.filter(f).map(x => String(x.name).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return {
    stamps: names(x => cat(x) === 'STAMPING' || cat(x) === 'AIRY STAMPING'),
    rotors: names(x => cat(x) === 'ROTOR'),
    motors: names(x => cat(x) === 'MOTOR' || cat(x) === 'MOTORS')
  };
}

export async function midlandTypes(sql) {
  let items = [];
  try { items = await sql`SELECT name, category FROM inventory_items`; } catch (e) { items = []; }
  if (!items.length) {
    try { const r = await fetch(URL); const j = await r.json(); items = j.items || []; } catch (e) { items = []; }
  }
  return split(items);
}
