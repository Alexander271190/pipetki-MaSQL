const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_key';

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
};

const requireRole = (roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
  next();
};

const requirePermission = (perm) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
  if (req.user.role === 'admin') return next();
  const extra = JSON.parse(req.user.extra_permissions || '[]');
  const base = { senior_lab: ['manage_pipettes', 'import_data', 'export_data'] };
  const all = [...(base[req.user.role] || []), ...extra];
  if (!all.includes(perm)) return res.status(403).json({ error: 'Недостаточно прав' });
  next();
};

module.exports = { authenticate, requireRole, requirePermission };