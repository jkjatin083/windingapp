import crypto from 'node:crypto';

export const NAMES = ['Suman', 'Dinesh', 'Ajeet', 'Siraj', 'Sunil', 'Pandey ji'];

function key() {
  return crypto.createHash('sha256').update('wa-auth:' + (process.env.DATABASE_URL || '')).digest();
}
function b64(s) { return Buffer.from(s).toString('base64url'); }

export function sign(name, hours) {
  const body = b64(JSON.stringify({ n: name, exp: Date.now() + hours * 3600 * 1000 }));
  const mac = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  return body + '.' + mac;
}

// Returns the logged-in name (or 'ADMIN'), or null.
export function verify(req) {
  try {
    const h = String(req.headers.authorization || '');
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const [body, mac] = t.split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', key()).update(body).digest('base64url');
    const a = Buffer.from(mac), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    if (p.n !== 'ADMIN' && !NAMES.includes(p.n)) return null;
    return p.n;
  } catch (e) { return null; }
}

export function isAdm(req) {
  return verify(req) === 'ADMIN';
}

export function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
