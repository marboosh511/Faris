import jwt from 'jsonwebtoken';
import { pool } from './db.js';
export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'mamlakat-alkhayl' });
}
export async function requireAuth(req, res, next) {
  try {
    const value = req.headers.authorization || '';
    const token = value.startsWith('Bearer ') ? value.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'mamlakat-alkhayl' });
    const result = await pool.query('SELECT id, username, email FROM users WHERE id=$1', [payload.sub]);
    if (!result.rowCount) return res.status(401).json({ error: 'الحساب غير موجود.' });
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'جلسة الدخول غير صالحة أو انتهت.' });
  }
}
