const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Раздача статики
app.use(express.static(path.join(__dirname, 'frontend')));

// API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/pipettes', require('./routes/pipettes'));
app.use('/api/users', require('./routes/users'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/log', require('./routes/log'));
app.use('/api/backup', require('./routes/backup'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// SPA-fallback — всё остальное отдаём как index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ============================================================
// Старт: ждём БД, инициализируем схему
// ============================================================
const db = require('./db');

(async () => {
  let retries = 30;
  while (retries > 0) {
    try {
      const conn = await db.pool.getConnection();
      await conn.query('SELECT 1');
      conn.release();
      console.log('✅ MySQL подключён');
      break;
    } catch (e) {
      retries--;
      console.log(`⏳ Ожидание MySQL... (${retries} попыток осталось)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (retries === 0) {
    console.error('❌ Не удалось подключиться к MySQL');
    process.exit(1);
  }

  try {
    await db.initSchema();
    console.log('✅ Схема БД готова');
  } catch (e) {
    console.error('❌ Ошибка инициализации схемы:', e);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server on http://0.0.0.0:${PORT}`);
    console.log(`👤 admin/admin, senior/senior, user/user`);
  });
})();