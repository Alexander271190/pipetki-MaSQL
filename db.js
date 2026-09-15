const mysql = require('mysql2/promise');

// ============================================================
// ПУЛ СОЕДИНЕНИЙ
// ============================================================
const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME || 'pipette',
  user:     process.env.DB_USER || 'pipette',
  password: process.env.DB_PASSWORD || 'pipette_secret',
  charset:  'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true,
});

// Универсальный query → [rowsOrResult, fields]
async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function getConnection() {
  const conn = await pool.getConnection();
  return {
    query: (sql, params = []) => conn.query(sql, params),
    beginTransaction: () => conn.beginTransaction(),
    commit:           () => conn.commit(),
    rollback:         async () => { try { await conn.rollback(); } catch (e) {} },
    release:          () => conn.release(),
  };
}

// ============================================================
// СХЕМА
// ============================================================
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        login VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        position VARCHAR(255) NOT NULL,
        department VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        extra_permissions TEXT,
        only_own_department TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS pipettes (
        id VARCHAR(255) PRIMARY KEY,
        serial VARCHAR(255),
        manufacturer VARCHAR(255),
        model VARCHAR(255) NOT NULL,
        volume VARCHAR(50),
        department VARCHAR(255),
        \`interval\` INT DEFAULT 12,
        last_calibration VARCHAR(20),
        cert VARCHAR(255),
        last_result VARCHAR(20) DEFAULT 'pass',
        active TINYINT DEFAULT 1,
        responsible VARCHAR(255),
        location VARCHAR(255),
       notes TEXT,
      sent_for_calibration VARCHAR(20),
      sent_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS calibration_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pipette_id VARCHAR(255) NOT NULL,
        \`date\` VARCHAR(20) NOT NULL,
        cert VARCHAR(255),
        result VARCHAR(20) DEFAULT 'pass',
        org VARCHAR(255),
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (pipette_id) REFERENCES pipettes(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_full_name VARCHAR(255) NOT NULL,
        action VARCHAR(255) NOT NULL,
        details TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS departments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        enabled TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      
      CREATE TABLE IF NOT EXISTS filter_config (
        id VARCHAR(100) PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        field_id VARCHAR(100),
        enabled TINYINT DEFAULT 1,
        options_source VARCHAR(100),
        filter_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS field_config (
        id VARCHAR(100) PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        required TINYINT DEFAULT 0,
        enabled TINYINT DEFAULT 1,
        options TEXT,
        default_value TEXT,
        field_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS export_settings (
        id INT PRIMARY KEY,
        fields TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  } finally {
    conn.release();
  }

  await seedInitialData();
}

// ============================================================
// НАЧАЛЬНЫЕ ДАННЫЕ
// ============================================================
async function seedInitialData() {
  // --- Пользователи ---
  const [uc] = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (uc[0].c === 0) {
    const sql = `INSERT INTO users (id, login, password, full_name, position, department, role, extra_permissions)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await pool.query(sql, ['admin1',  'admin',  'admin',  'Администратор', 'Главный метролог',    null,                     'admin',      '[]']);
    await pool.query(sql, ['senior1', 'senior', 'senior', 'Петров Петр',   'Старший лаборант',    'Гематологический отдел', 'senior_lab', '[]']);
    await pool.query(sql, ['user1',   'user',   'user',   'Иванов Иван',   'Лаборант',            'Биохимический отдел',    'user',       '[]']);
  }

  // --- Отделы ---
  const [dc] = await pool.query('SELECT COUNT(*) AS c FROM departments');
  if (dc[0].c === 0) {
    const deps = [
      'Гематологический отдел',
      'Биохимический отдел',
      'Коагулогический отдел',
      'Экспресс отдел',
      'Изосерологический отдел',
      'Серологический отдел',
      'ГИМИ',
      'Бактериологический отдел'
    ];
    for (const d of deps) {
      await pool.query('INSERT INTO departments (name) VALUES (?)', [d]);
    }
  }

  // --- Системные настройки ---
  const [ssc] = await pool.query('SELECT COUNT(*) AS c FROM system_settings');
  if (ssc[0].c === 0) {
    await pool.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('warn_days', '30')`);
  }

  // --- Поля формы ---
  const [fc] = await pool.query('SELECT COUNT(*) AS c FROM field_config');
  if (fc[0].c === 0) {
    const ins = `INSERT INTO field_config (id, label, type, required, enabled, options, default_value, field_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const fields = [
      ['id',              'Внутренний номер',              'text',     1, 1, '[]',                    '',     1],
      ['serial',          'Серийный номер',                'text',     0, 1, '[]',                    '',     2],
      ['manufacturer',    'Производитель',                 'text',     0, 1, '[]',                    '',     3],
      ['model',           'Модель',                        'text',     1, 1, '[]',                    '',     4],
      ['volume',          'Объём (мкл)',                   'text',     0, 1, '[]',                    '',     5],
      ['department',      'Отдел',                         'select',   0, 1, '[]',                    '',     6],
      ['interval',        'Межповерочный интервал (мес.)', 'number',   1, 1, '[]',                    '12',   8],
      ['lastCalibration', 'Дата последней поверки',        'date',     1, 1, '[]',                    '',     9],
      ['cert',            'Номер свидетельства',           'text',     0, 1, '[]',                    '',     10],
      ['result',          'Результат поверки',             'select',   0, 1, '["pass","fail","wip"]','pass', 11],
      ['active',          'Статус эксплуатации',           'select',   0, 1, '["true","false"]',      'true', 12],
      ['responsible',     'Ответственный сотрудник',       'text',     0, 1, '[]',                    '',     13],
      ['location',        'Место хранения',                'text',     0, 1, '[]',                    '',     14],
      ['notes',           'Примечание',                    'textarea', 0, 1, '[]',                    '',     15]
    ];
    for (const f of fields) await pool.query(ins, f);
  }

  // --- Настройки экспорта ---
  const [ec] = await pool.query('SELECT COUNT(*) AS c FROM export_settings');
  if (ec[0].c === 0) {
    const defaultExport = [
      'id', 'serial', 'manufacturer', 'model', 'volume', 'department',
      'lastCalibration', 'nextCalibration', 'interval', 'daysLeft',
      'responsible', 'location', 'status', 'cert', 'notes'
    ];
    await pool.query('INSERT INTO export_settings (id, fields) VALUES (1, ?)', [JSON.stringify(defaultExport)]);
  }

  // --- Демо-пипетки ---
  const [pc] = await pool.query('SELECT COUNT(*) AS c FROM pipettes');
  if (pc[0].c === 0) {
    const today = new Date();
    const ago = (m) => {
      const d = new Date(today);
      d.setMonth(d.getMonth() - m);
      return d.toISOString().slice(0, 10);
    };

    const insPip = `INSERT INTO pipettes
      (id, serial, manufacturer, model, volume, department, \`interval\`,
       last_calibration, cert, last_result, active, responsible, location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await pool.query(insPip, ['P-001', 'EP2024001', 'Eppendorf', 'Research Plus', '1000', 'Гематологический отдел',
       12, ago(11), 'С-АБ-1234567/2025', 'pass', 1,
      'Иванова М.С.', 'Лаб. 201, шкаф 3', '']);

    await pool.query(insPip, ['P-002', 'EP2024002', 'Eppendorf', 'Research Plus', '100', 'Биохимический отдел',
       12, ago(10), 'С-АБ-1234568/2025', 'pass', 1,
      'Петров А.В.', 'Лаб. 201, шкаф 3', '']);

    await pool.query(insPip, ['P-003', 'GT2023005', 'Gilson', 'Pipetman L', '5000', 'Коагулогический отдел',
      6, ago(7), 'С-АБ-1234569/2025', 'pass', 1,
      'Иванова М.С.', 'Лаб. 105', 'Требует внеочередной проверки']);

    await pool.query(insPip, ['P-004', 'BT2022003', 'Biohit', 'mLINE', '200', 'Экспресс отдел',
       12, ago(14), 'С-АБ-9876546/2024', 'pass', 1,
      'Сидорова Е.К.', 'Лаб. 302', '']);

    await pool.query(insPip, ['P-005', 'TR2024008', 'Thermo', 'Finnpipette F2', '20', 'Серологический отдел',
      12, ago(2), 'С-АБ-1234570/2025', 'pass', 0,
      'Петров А.В.', 'Склад', 'В резерве']);

    // История поверок
    const insHist = `INSERT INTO calibration_history (pipette_id, \`date\`, cert, result, org, note)
                     VALUES (?, ?, ?, ?, ?, ?)`;
    await pool.query(insHist, ['P-001', ago(23), 'С-АБ-9876543/2024', 'pass', 'ФБУ Красноярский ЦСМ', 'Годна']);
    await pool.query(insHist, ['P-001', ago(11), 'С-АБ-1234567/2025', 'pass', 'ФБУ Красноярский ЦСМ', 'Годна']);
    await pool.query(insHist, ['P-003', ago(13), 'С-АБ-9876545/2024', 'fail', 'ФБУ Красноярский ЦСМ', 'Брак']);
    await pool.query(insHist, ['P-003', ago(7),  'С-АБ-1234569/2025', 'pass', 'ФБУ Красноярский ЦСМ', 'После ремонта']);
  }

  // --- Фильтры по умолчанию ---
  const [filc] = await pool.query('SELECT COUNT(*) AS c FROM filter_config');
  if (filc[0].c === 0) {
    const insF = `INSERT INTO filter_config
      (id, label, type, field_id, enabled, options_source, filter_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;

    await pool.query(insF, ['status',       'Статус',         'select',      'status',           1, 'status_list', 1]);
    await pool.query(insF, ['department',   'Отдел',          'select',      'department',       1, 'departments', 3]);
    await pool.query(insF, ['responsible',  'Ответственный',  'text',        'responsible',      1, '',            4]);
    await pool.query(insF, ['model',        'Модель',         'text',        'model',            1, '',            5]);
    await pool.query(insF, ['manufacturer', 'Производитель',  'text',        'manufacturer',     1, '',            6]);
    await pool.query(insF, ['active',       'Активность',     'select',      'active',           1, 'active_list', 7]);
    await pool.query(insF, ['calPeriod',    'Дата поверки',   'date-period', 'last_calibration', 1, '',            8]);
  }
}

module.exports = { query, getConnection, pool, initSchema };
