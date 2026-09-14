const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_key';

// ============================================================
// ВХОД
// ============================================================
router.post('/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE login = ?', [login]);
    if (!rows.length || rows[0].password !== password)
      return res.status(401).json({ error: 'Неверный логин или пароль' });

    const u = rows[0];
    const token = jwt.sign({ id: u.id, login: u.login, role: u.role }, JWT_SECRET, { expiresIn: '24h' });

    await db.query(
      'INSERT INTO audit_log (user_id, user_full_name, action) VALUES (?, ?, ?)',
      [u.id, u.full_name, 'Вход в систему']
    );

    res.json({
      token,
      user: {
        id: u.id,
        login: u.login,
        fullName: u.full_name,
        position: u.position,
        department: u.department,
        role: u.role,
        onlyOwnDepartment: !!u.only_own_department,
        extraPermissions: JSON.parse(u.extra_permissions || '[]')
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// ПРОВЕРКА СЕССИИ
// ============================================================
router.get('/verify', authenticate, (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u.id,
      login: u.login,
      fullName: u.full_name,
      position: u.position,
      department: u.department,
      role: u.role,
      onlyOwnDepartment: !!u.only_own_department,
      extraPermissions: JSON.parse(u.extra_permissions || '[]')
    }
  });
});

// ============================================================
// ВХОД ПОД ДРУГИМ ПОЛЬЗОВАТЕЛЕМ (impersonate)
// ============================================================
router.post('/impersonate/:userId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Только администратор может входить под другими' });
    }

    const [targets] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);
    if (!targets.length) return res.status(404).json({ error: 'Пользователь не найден' });

    const target = targets[0];
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'Вы уже вошли под этой учётной записью' });
    }

    const token = jwt.sign(
      { id: target.id, login: target.login, role: target.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    await db.query(
      'INSERT INTO audit_log (user_id, user_full_name, action, details) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.full_name, 'Вход под пользователем', target.full_name]
    );

    res.json({
      token,
      user: {
        id: target.id,
        login: target.login,
        fullName: target.full_name,
        position: target.position,
        department: target.department,
        role: target.role,
        onlyOwnDepartment: !!target.only_own_department,
        extraPermissions: JSON.parse(target.extra_permissions || '[]')
      }
    });
  } catch (e) {
    console.error('Impersonate error:', e);
    res.status(500).json({ error: 'Ошибка входа под пользователем' });
  }
});

module.exports = router;