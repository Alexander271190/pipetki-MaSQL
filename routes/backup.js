const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ============================================================
function dbArgs() {
  return {
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT || '3306',
    user:     process.env.DB_USER || 'pipette',
    password: process.env.DB_PASSWORD || 'pipette_secret',
    database: process.env.DB_NAME || 'pipette',
  };
}

function runMysqldump(destFile) {
  return new Promise((resolve, reject) => {
    const cfg = dbArgs();
    const args = [
      '-h', cfg.host,
      '-P', cfg.port,
      '-u', cfg.user,
      `-p${cfg.password}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--default-character-set=utf8mb4',
      cfg.database
    ];
    const proc = spawn('mysqldump', args);
    const out = fs.createWriteStream(destFile);
    let err = '';
    proc.stdout.pipe(out);
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(err || ('mysqldump exit code ' + code)));
    });
  });
}

function runMysqlRestore(srcFile) {
  return new Promise((resolve, reject) => {
    const cfg = dbArgs();
    const args = [
      '-h', cfg.host,
      '-P', cfg.port,
      '-u', cfg.user,
      `-p${cfg.password}`,
      '--default-character-set=utf8mb4',
      cfg.database
    ];
    const proc = spawn('mysql', args);
    const inp = fs.createReadStream(srcFile);
    let err = '';
    inp.pipe(proc.stdin);
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(err || ('mysql exit code ' + code))));
  });
}

// ============================================================
// Список бэкапов
// ============================================================
router.get('/', authenticate, requireRole(['admin']), (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pipette_') && f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, created: stat.mtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// ============================================================
// Создать бэкап
// ============================================================
router.post('/', authenticate, requireRole(['admin']), async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `pipette_${timestamp}.sql`;
    const dest = path.join(BACKUP_DIR, filename);

    await runMysqldump(dest);

    // Оставляем последние 10
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pipette_') && f.endsWith('.sql'))
      .sort()
      .reverse();
    if (files.length > 10) {
      files.slice(10).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      });
    }

    res.json({ message: 'Бэкап создан', filename });
  } catch (e) {
    console.error('Backup error:', e);
    res.status(500).json({ error: 'Ошибка создания бэкапа: ' + e.message });
  }
});

// ============================================================
// Восстановить из бэкапа
// ============================================================
router.post('/restore/:filename', authenticate, requireRole(['admin']), async (req, res) => {
  const src = path.join(BACKUP_DIR, req.params.filename);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Бэкап не найден' });

  try {
    // Разрываем все соединения приложения кроме текущего
    const [threads] = await db.query(
      `SELECT id FROM information_schema.processlist 
       WHERE db = ? AND id <> CONNECTION_ID()`,
      [process.env.DB_NAME || 'pipette']
    );
    for (const t of threads) {
      try { await db.query(`KILL ${t.id}`); } catch (e) {}
    }

    await runMysqlRestore(src);

    res.json({ message: 'Бэкап восстановлен. Перезапустите приложение.' });
  } catch (e) {
    console.error('Restore error:', e);
    res.status(500).json({ error: 'Ошибка восстановления: ' + e.message });
  }
});

// ============================================================
// Удалить бэкап
// ============================================================
router.delete('/:filename', authenticate, requireRole(['admin']), (req, res) => {
  const file = path.join(BACKUP_DIR, req.params.filename);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    res.json({ message: 'Бэкап удалён' });
  } else {
    res.status(404).json({ error: 'Бэкап не найден' });
  }
});

// ============================================================
// Скачать бэкап
// ============================================================
router.get('/download/:filename', authenticate, requireRole(['admin']), (req, res) => {
  const file = path.join(BACKUP_DIR, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Не найден' });
  res.download(file);
});

// ============================================================
// Сбросить все данные (пипетки, история, лог)
// ============================================================
router.post('/reset', authenticate, requireRole(['admin']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM calibration_history');
    await conn.query('DELETE FROM pipettes');
    await conn.query('DELETE FROM audit_log');
    await conn.commit();
    res.json({ message: 'Все данные удалены' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Ошибка сброса' });
  } finally {
    conn.release();
  }
});

module.exports = router;