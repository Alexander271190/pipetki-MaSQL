const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireRole(['admin']), async (req, res) => {
  const [users] = await db.query(
    'SELECT id, login, full_name, position, department, role, only_own_department, extra_permissions FROM users');
  res.json(users.map(u => ({
    ...u,
    onlyOwnDepartment: !!u.only_own_department,
    extraPermissions: JSON.parse(u.extra_permissions || '[]')
  })));
});

router.post('/', authenticate, requireRole(['admin']), async (req, res) => {
  const { login, password, fullName, position, department, role,
          onlyOwnDepartment, extraPermissions } = req.body;

  if (!login || !password || !fullName || !position)
    return res.status(400).json({ error: 'Заполните обязательные поля' });

  const [ex] = await db.query('SELECT id FROM users WHERE login = ?', [login]);
  if (ex.length) return res.status(409).json({ error: 'Логин уже занят' });

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  await db.query(
    `INSERT INTO users (id, login, password, full_name, position, department, role, only_own_department, extra_permissions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, login, password, fullName, position, department || '', role || 'user',
     onlyOwnDepartment ? 1 : 0, JSON.stringify(extraPermissions || [])]
  );
  res.status(201).json({ message: 'Пользователь создан', id });
});

router.put('/:id', authenticate, requireRole(['admin']), async (req, res) => {
  const { login, password, fullName, position, department, role,
          onlyOwnDepartment, extraPermissions } = req.body;
  const id = req.params.id;

  const [ex] = await db.query('SELECT id FROM users WHERE id = ?', [id]);
  if (!ex.length) return res.status(404).json({ error: 'Не найден' });

  const onlyOwn = onlyOwnDepartment ? 1 : 0;

  if (password) {
    await db.query(
      `UPDATE users SET login=?, full_name=?, position=?, department=?, role=?,
         only_own_department=?, extra_permissions=?, password=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [login, fullName, position, department || '', role || 'user',
       onlyOwn, JSON.stringify(extraPermissions || []), password, id]
    );
  } else {
    await db.query(
      `UPDATE users SET login=?, full_name=?, position=?, department=?, role=?,
         only_own_department=?, extra_permissions=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [login, fullName, position, department || '', role || 'user',
       onlyOwn, JSON.stringify(extraPermissions || []), id]
    );
  }
  res.json({ message: 'Пользователь обновлён' });
});

router.delete('/:id', authenticate, requireRole(['admin']), async (req, res) => {
  const [users] = await db.query('SELECT role FROM users WHERE id = ?', [req.params.id]);
  if (!users.length) return res.status(404).json({ error: 'Не найден' });

  if (users[0].role === 'admin') {
    const [admins] = await db.query(`SELECT id FROM users WHERE role = 'admin'`);
    if (admins.length <= 1) return res.status(400).json({ error: 'Нельзя удалить последнего админа' });
  }

  await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'Пользователь удалён' });
});

module.exports = router;