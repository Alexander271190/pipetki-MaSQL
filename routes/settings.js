const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// ОТДЕЛЫ
// ============================================================
router.get('/departments', authenticate, async (req, res) => {
  const [rows] = await db.query('SELECT name FROM departments WHERE enabled = 1 ORDER BY name');
  res.json(rows.map(r => r.name));
});

router.put('/departments', authenticate, requireRole(['admin']), async (req, res) => {
  const departments = req.body;
  if (!Array.isArray(departments)) {
    return res.status(400).json({ error: 'Ожидается массив' });
  }

  // Проверка: собираем имена, ищем дубли (без учёта регистра)
  const seen = new Set();
  const duplicates = [];

  for (const d of departments) {
    const name = typeof d === 'string' ? d : (d && d.name ? d.name : '');
    const trimmed = String(name).trim();
    if (!trimmed) continue;

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(trimmed);
    } else {
      seen.add(key);
    }
  }

  // Если дубли есть — отклоняем с понятной ошибкой
  if (duplicates.length > 0) {
    return res.status(400).json({
      error: 'Дубли отделов: ' + [...new Set(duplicates)].join(', ')
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM departments');

    for (const d of departments) {
      const name = typeof d === 'string' ? d : (d && d.name ? d.name : '');
      const enabled = (typeof d === 'object' && d.enabled === false) ? 0 : 1;
      const trimmed = String(name).trim();
      if (!trimmed) continue;

      await conn.query(
        'INSERT INTO departments (name, enabled) VALUES (?, ?)',
        [trimmed, enabled]
      );
    }

    await conn.commit();
    res.json({ message: 'Отделы обновлены' });
  } catch (e) {
    await conn.rollback();
    console.error('Ошибка обновления отделов:', e.message, '| code:', e.code);
    res.status(500).json({
      error: 'Ошибка обновления отделов',
      details: e.message
    });
  } finally {
    conn.release();
  }
});

router.get('/departments-full', authenticate, requireRole(['admin']), async (req, res) => {
  const [rows] = await db.query('SELECT name, enabled FROM departments ORDER BY name');
  res.json(rows.map(r => ({ name: r.name, enabled: !!r.enabled })));
});

// ============================================================
// ПОЛЯ ФОРМЫ
// ============================================================
router.get('/fields', authenticate, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM field_config ORDER BY field_order');
  res.json(rows.map(f => ({
    id: f.id,
    label: f.label,
    type: f.type,
    required: !!f.required,
    enabled: !!f.enabled,
    options: JSON.parse(f.options || '[]'),
    default: f.default_value || '',
    order: f.field_order
  })));
});

router.put('/fields', authenticate, requireRole(['admin']), async (req, res) => {
  const fields = req.body;
  if (!Array.isArray(fields)) return res.status(400).json({ error: 'Ожидается массив' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM field_config');
    for (const f of fields) {
      await conn.query(
        `INSERT INTO field_config (id, label, type, required, enabled, options, default_value, field_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.id, f.label, f.type, f.required ? 1 : 0, f.enabled !== false ? 1 : 0,
         JSON.stringify(f.options || []), f.default || '', f.order || 0]
      );
    }
    await conn.commit();
    res.json({ message: 'Поля обновлены' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Ошибка обновления полей' });
  } finally {
    conn.release();
  }
});

// ============================================================
// НАСТРОЙКИ ЭКСПОРТА
// ============================================================
router.get('/export', authenticate, async (req, res) => {
  const [rows] = await db.query('SELECT fields FROM export_settings WHERE id = 1');
  if (!rows.length) return res.json([]);
  res.json(JSON.parse(rows[0].fields));
});

router.put('/export', authenticate, requireRole(['admin']), async (req, res) => {
  const fields = req.body;
  if (!Array.isArray(fields)) return res.status(400).json({ error: 'Ожидается массив' });
  await db.query(
    `INSERT INTO export_settings (id, fields) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE fields = VALUES(fields), updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(fields)]
  );
  res.json({ message: 'Настройки экспорта обновлены' });
});

// ============================================================
// СИСТЕМНЫЕ НАСТРОЙКИ
// ============================================================
router.get('/system', authenticate, async (req, res) => {
  const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings');
  const result = {};
  for (const s of rows) result[s.setting_key] = s.setting_value;
  res.json(result);
});

router.put('/system', authenticate, requireRole(['admin']), async (req, res) => {
  const settings = req.body;
  try {
    for (const [k, v] of Object.entries(settings)) {
      await db.query(
        `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`,
        [k, String(v)]
      );
    }
    res.json({ message: 'Настройки обновлены' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка обновления настроек' });
  }
});

// ============================================================
// ПОДРАЗДЕЛЕНИЯ
// ============================================================
router.get('/subdivisions', authenticate, async (req, res) => {
  const [rows] = await db.query('SELECT name FROM subdivisions WHERE enabled = 1 ORDER BY name');
  res.json(rows.map(r => r.name));
});

router.get('/subdivisions/all', authenticate, requireRole(['admin']), async (req, res) => {
  const [rows] = await db.query('SELECT name, enabled FROM subdivisions ORDER BY name');
  res.json(rows.map(r => ({ name: r.name, enabled: !!r.enabled })));
});

router.put('/subdivisions', authenticate, requireRole(['admin']), async (req, res) => {
  const subdivisions = req.body;
  if (!Array.isArray(subdivisions)) return res.status(400).json({ error: 'Ожидается массив' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM subdivisions');
    for (const s of subdivisions) {
      await conn.query(
        'INSERT INTO subdivisions (name, enabled) VALUES (?, ?)',
        [s.name || s, s.enabled !== false ? 1 : 0]
      );
    }
    await conn.commit();
    res.json({ message: 'Подразделения обновлены' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Ошибка обновления подразделений' });
  } finally {
    conn.release();
  }
});

// ============================================================
// ФИЛЬТРЫ
// ============================================================
router.get('/filters', authenticate, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM filter_config ORDER BY filter_order');
  res.json(rows.map(f => ({
    id: f.id,
    label: f.label,
    type: f.type,
    fieldId: f.field_id,
    enabled: !!f.enabled,
    optionsSource: f.options_source,
    order: f.filter_order
  })));
});

router.put('/filters', authenticate, requireRole(['admin']), async (req, res) => {
  const filters = req.body;
  if (!Array.isArray(filters)) return res.status(400).json({ error: 'Ожидается массив' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM filter_config');
    for (const f of filters) {
      await conn.query(
        `INSERT INTO filter_config
         (id, label, type, field_id, enabled, options_source, filter_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [f.id, f.label, f.type, f.fieldId || '',
         f.enabled ? 1 : 0, f.optionsSource || '', f.order || 0]
      );
    }
    await conn.commit();
    res.json({ message: 'Фильтры обновлены' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Ошибка обновления фильтров' });
  } finally {
    conn.release();
  }
});

module.exports = router;
