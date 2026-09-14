const express = require('express');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Список пипеток
router.get('/', authenticate, async (req, res) => {
  try {
    let sql = 'SELECT * FROM pipettes';
    const params = [];

    if (req.user.role !== 'admin' && req.user.only_own_department && req.user.department) {
      sql += ' WHERE department = ?';
      params.push(req.user.department);
    }

    const [pipettes] = await db.query(sql, params);
    for (const p of pipettes) {
      p.active = !!p.active;
      const [h] = await db.query(
        'SELECT * FROM calibration_history WHERE pipette_id = ? ORDER BY `date` DESC', [p.id]);
      p.history = h;
    }
    res.json(pipettes);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка загрузки данных' });
  }
});

// Одна пипетка
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM pipettes WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Пипетка не найдена' });

    const [h] = await db.query(
      'SELECT * FROM calibration_history WHERE pipette_id = ? ORDER BY `date` DESC', [req.params.id]);

    const p = rows[0];
    p.active = !!p.active;
    p.history = h;
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка загрузки данных' });
  }
});

// Создание
router.post('/', authenticate, requirePermission('manage_pipettes'), async (req, res) => {
  const {
    id, serial, manufacturer, model, volume, department, subdivision, interval,
    lastCalibration, cert, result, active, responsible, location, notes
  } = req.body;

  if (!id || !model) return res.status(400).json({ error: 'ID и модель обязательны' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [exist] = await conn.query('SELECT id FROM pipettes WHERE id = ?', [id]);
    if (exist.length) { await conn.rollback(); return res.status(409).json({ error: 'ID уже существует' }); }

    await conn.query(
      `INSERT INTO pipettes
        (id, serial, manufacturer, model, volume, department, subdivision, \`interval\`,
         last_calibration, cert, last_result, active, responsible, location, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, serial, manufacturer, model, volume, department, subdivision || null, interval || 12,
       lastCalibration, cert, result || 'pass', active !== false ? 1 : 0,
       responsible, location, notes]
    );

    if (lastCalibration) {
      await conn.query(
        `INSERT INTO calibration_history (pipette_id, \`date\`, cert, result, note)
         VALUES (?, ?, ?, ?, ?)`,
        [id, lastCalibration, cert, result || 'pass', 'Первичная поверка']
      );
    }

    await conn.query(
      'INSERT INTO audit_log (user_id, user_full_name, action, details) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.full_name, 'Добавление пипетки', `${id} (${model})`]
    );

    await conn.commit();
    res.status(201).json({ message: 'Пипетка создана', id });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Ошибка создания пипетки' });
  } finally {
    conn.release();
  }
});

// Обновление
router.put('/:id', authenticate, requirePermission('manage_pipettes'), async (req, res) => {
  const updates = req.body;
  const map = {
    serial: 'serial', manufacturer: 'manufacturer', model: 'model', volume: 'volume',
    department: 'department', subdivision: 'subdivision',
    interval: '`interval`', lastCalibration: 'last_calibration',
    cert: 'cert', lastResult: 'last_result', active: 'active',
    responsible: 'responsible', location: 'location', notes: 'notes'
  };

  const fields = [];
  const values = [];
  for (const [k, col] of Object.entries(map)) {
    if (updates[k] !== undefined) {
      fields.push(`${col} = ?`);
      values.push(k === 'active' ? (updates[k] ? 1 : 0) : updates[k]);
    }
  }

  if (!fields.length) return res.status(400).json({ error: 'Нет полей для обновления' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`UPDATE pipettes SET ${fields.join(', ')} WHERE id = ?`, values);
    await conn.query(
      'INSERT INTO audit_log (user_id, user_full_name, action, details) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.full_name, 'Редактирование пипетки', req.params.id]
    );
    await conn.commit();
    res.json({ message: 'Пипетка обновлена' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Ошибка обновления' });
  } finally {
    conn.release();
  }
});

// Удаление
router.delete('/:id', authenticate, requirePermission('manage_pipettes'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [exist] = await conn.query('SELECT model FROM pipettes WHERE id = ?', [req.params.id]);
    if (!exist.length) { await conn.rollback(); return res.status(404).json({ error: 'Не найдена' }); }

    await conn.query('DELETE FROM pipettes WHERE id = ?', [req.params.id]);
    await conn.query(
      'INSERT INTO audit_log (user_id, user_full_name, action, details) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.full_name, 'Удаление пипетки', `${req.params.id} (${exist[0].model})`]
    );
    await conn.commit();
    res.json({ message: 'Пипетка удалена' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Ошибка удаления' });
  } finally {
    conn.release();
  }
});

// Добавление поверки
router.post('/:id/calibration', authenticate, requirePermission('manage_pipettes'), async (req, res) => {
  const { date, cert, result, org, note } = req.body;
  if (!date) return res.status(400).json({ error: 'Дата обязательна' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [exist] = await conn.query('SELECT id FROM pipettes WHERE id = ?', [req.params.id]);
    if (!exist.length) { await conn.rollback(); return res.status(404).json({ error: 'Не найдена' }); }

    await conn.query(
      `INSERT INTO calibration_history (pipette_id, \`date\`, cert, result, org, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, date, cert, result || 'pass', org, note]
    );

    await conn.query(
      `UPDATE pipettes SET last_calibration = ?, cert = ?, last_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [date, cert, result || 'pass', req.params.id]
    );

    await conn.query(
      'INSERT INTO audit_log (user_id, user_full_name, action, details) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.full_name, 'Добавление поверки', `${req.params.id} — ${date}`]
    );

    await conn.commit();
    res.status(201).json({ message: 'Поверка добавлена' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Ошибка добавления поверки' });
  } finally {
    conn.release();
  }
});

// История
router.get('/:id/calibration', authenticate, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM calibration_history WHERE pipette_id = ? ORDER BY `date` DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});

module.exports = router;