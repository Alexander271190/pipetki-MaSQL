const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireRole(['admin']), async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const [rows] = await db.query('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?', [limit]);
  res.json(rows);
});

router.delete('/', authenticate, requireRole(['admin']), async (req, res) => {
  await db.query('DELETE FROM audit_log');
  res.json({ message: 'Лог очищен' });
});

module.exports = router;