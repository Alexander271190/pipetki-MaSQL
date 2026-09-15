const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// КАРТА ЗАГОЛОВКОВ
// ============================================================
const HEADER_MAP = {
  'id': 'id', 'внутренний номер': 'id', 'инвентарный номер': 'id',
  'инв. номер': 'id', 'инв номер': 'id', 'номер': 'id', '№': 'id',

  'serial': 'serial', 'серийный номер': 'serial', 'серийный': 'serial',
  's/n': 'serial', 'sn': 'serial', 'заводской номер': 'serial',

  'manufacturer': 'manufacturer', 'производитель': 'manufacturer', 'фирма': 'manufacturer',
  'марка': 'manufacturer', 'бренд': 'manufacturer',

  'model': 'model', 'модель': 'model', 'наименование': 'model',
  'название': 'model', 'тип': 'model', 'оборудование': 'model',

  'volume': 'volume', 'объём': 'volume', 'объем': 'volume', 'объём (мкл)': 'volume',
  'объем (мкл)': 'volume', 'номинал': 'volume', 'диапазон': 'volume',

  'department': 'department', 'отдел': 'department', 'подразделение': 'department',
  'лаборатория': 'department',

  'interval': 'interval', 'мпи': 'interval', 'межповерочный интервал': 'interval',
  'интервал': 'interval', 'периодичность': 'interval',

  'lastcalibration': 'lastCalibration', 'дата поверки': 'lastCalibration',
  'дата последней поверки': 'lastCalibration', 'дата последней проверки': 'lastCalibration',
  'поверка': 'lastCalibration',

  'cert': 'cert', 'свидетельство': 'cert', 'номер свидетельства': 'cert',
  'сертификат': 'cert',

  'result': 'result', 'результат': 'result', 'результат поверки': 'result',
  'итог': 'result',

  'active': 'active', 'статус': 'active', 'активность': 'active',
  'состояние': 'active', 'эксплуатация': 'active',

  'responsible': 'responsible', 'ответственный': 'responsible',
  'ответственный сотрудник': 'responsible', 'мол': 'responsible',
  'пользователь': 'responsible',

  'location': 'location', 'место': 'location', 'место хранения': 'location',
  'расположение': 'location', 'кабинет': 'location',

  'notes': 'notes', 'примечание': 'notes', 'примечания': 'notes',
  'комментарий': 'notes', 'комментарии': 'notes'
};

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[«»"'`]/g, '');
}

function mapHeader(h) {
  const n = normalizeHeader(h);
  if (HEADER_MAP[n]) return HEADER_MAP[n];
  const n2 = n.replace(/\(.*?\)/g, '').trim();
  return HEADER_MAP[n2] || null;
}

// ============================================================
// ПАРСЕРЫ ЗНАЧЕНИЙ
// ============================================================
function parseDate(val) {
  if (val === undefined || val === null || val === '') return '';
  if (val instanceof Date) {
    const d = val;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (typeof val === 'number') {
    try {
      const d = XLSX.SSF.parse_date_code(val);
      if (d && d.y) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    } catch (e) {}
  }
  const s = String(val).trim();

  let m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  return '';
}

function normalizeResult(val) {
  if (!val) return 'pass';
  const s = String(val).trim().toLowerCase();
  if (/годен|годна|pass|ок|ok|год|✅/.test(s)) return 'pass';
  if (/брак|fail|не\s*год|негод|❌|дефект/.test(s)) return 'fail';
  if (/процесс|wip|ожидан|⏳/.test(s)) return 'wip';
  return 'pass';
}

function normalizeActive(val) {
  if (val === undefined || val === null || val === '') return 1;
  if (val === true || val === 1) return 1;
  if (val === false || val === 0) return 0;
  const s = String(val).trim().toLowerCase();
  if (/^(да|yes|true|1|активно|в работе|эксплуатация|используется|✅)/.test(s)) return 1;
  if (/^(нет|no|false|0|неактивно|списан|не используется|в резерве|⛔)/.test(s)) return 0;
  return 1;
}

function parseInterval(val) {
  if (!val) return 12;
  const s = String(val).replace(/[^\d]/g, '');
  const n = parseInt(s, 10);
  return n > 0 ? n : 12;
}

// ============================================================
// ИМПОРТ
// ============================================================
router.post('/', authenticate, requirePermission('manage_pipettes'), async (req, res) => {
  try {
    const { file, filename } = req.body;
    if (!file) return res.status(400).json({ error: 'Файл не передан' });

    const buffer = Buffer.from(file, 'base64');
    const ext = (filename || '').toLowerCase().split('.').pop();

    let headers = [];
    let objects = [];

    if (ext === 'json') {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!Array.isArray(parsed)) {
        return res.status(400).json({ error: 'JSON должен содержать массив объектов' });
      }
      objects = parsed;
      headers = parsed.length ? Object.keys(parsed[0]) : [];
    } else if (ext === 'csv' || ext === 'txt') {
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'Пустой файл' });

      const firstLine = lines[0];
      const counts = { ';': 0, ',': 0, '\t': 0 };
      for (const ch of firstLine) if (counts[ch] !== undefined) counts[ch]++;
      const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

      const splitCsvLine = (line) => {
        const result = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
            else inQ = !inQ;
          } else if (c === sep && !inQ) {
            result.push(cur); cur = '';
          } else {
            cur += c;
          }
        }
        result.push(cur);
        return result.map(s => s.trim().replace(/^"|"$/g, ''));
      };

      headers = splitCsvLine(lines[0]);
      for (let i = 1; i < lines.length; i++) {
        const vals = splitCsvLine(lines[i]);
        if (vals.every(v => !v)) continue;
        const obj = {};
        headers.forEach((h, j) => obj[h] = vals[j] || '');
        objects.push(obj);
      }
    } else {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, dateNF: 'yyyy-mm-dd' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ error: 'Файл не содержит листов' });
      const sheet = workbook.Sheets[sheetName];

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: true,
        defval: '',
        blankrows: false
      });
      if (rows.length < 2) return res.status(400).json({ error: 'Пустой файл' });

      headers = rows[0].map(h => String(h || ''));
      for (let i = 1; i < rows.length; i++) {
        const vals = rows[i];
        if (!vals || vals.every(v => v === '' || v === null || v === undefined)) continue;
        const obj = {};
        headers.forEach((h, j) => obj[h] = vals[j] !== undefined ? vals[j] : '');
        objects.push(obj);
      }
    }

    if (!objects.length) return res.status(400).json({ error: 'Не найдено ни одной строки данных' });

    const colMap = headers.map(h => mapHeader(h));
    const mappedCount = colMap.filter(Boolean).length;

    if (mappedCount === 0) {
      return res.status(400).json({
        error: 'Не удалось распознать ни одного столбца. Проверьте заголовки.',
        headers: headers
      });
    }

    const added = [], skipped = [], errors = [];

    for (let i = 0; i < objects.length; i++) {
      const raw = objects[i];
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        const key = colMap[j];
        if (key) {
          const v = raw[headers[j]];
          if (v !== undefined && v !== null && v !== '') obj[key] = v;
        }
      }

      const id = String(obj.id || '').trim();
      const model = String(obj.model || '').trim();

      if (!id && !model) continue;

      if (!id || !model) {
        skipped.push(`Строка ${i + 2}: нет ${!id ? 'ID' : 'модели'}`);
        continue;
      }

      try {
        const [ex] = await db.query('SELECT id FROM pipettes WHERE id = ?', [id]);
        if (ex.length) { skipped.push(`${id}: уже существует`); continue; }

        const lastCal = parseDate(obj.lastCalibration);
        const result = normalizeResult(obj.result);

        await db.query(
          `INSERT INTO pipettes
            (id, serial, manufacturer, model, volume, department, \`interval\`,
             last_calibration, cert, last_result, active, responsible, location, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            String(obj.serial || '').trim(),
            String(obj.manufacturer || '').trim(),
            model,
            String(obj.volume || '').trim(),
            String(obj.department || '').trim(),
            parseInterval(obj.interval),
            lastCal,
            String(obj.cert || '').trim(),
            result,
            normalizeActive(obj.active),
            String(obj.responsible || '').trim(),
            String(obj.location || '').trim(),
            String(obj.notes || '').trim()
          ]
        );

        if (lastCal) {
          await db.query(
            `INSERT INTO calibration_history (pipette_id, \`date\`, cert, result, note)
             VALUES (?, ?, ?, ?, ?)`,
            [id, lastCal, String(obj.cert || '').trim(), result, 'Импорт из файла']
          );
        }

        added.push(id);
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }

    await db.query(
      'INSERT INTO audit_log (user_id, user_full_name, action, details) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.full_name, 'Импорт из файла',
       `${filename || 'файл'}: добавлено ${added.length}, пропущено ${skipped.length}, ошибок ${errors.length}`]
    );

    res.json({
      message: `Импортировано: ${added.length}`,
      added: added.length,
      skipped: skipped.length,
      errors: errors.length,
      skippedDetails: skipped.slice(0, 30),
      errorDetails: errors.slice(0, 30),
      recognizedFields: colMap.filter(Boolean).length,
      totalColumns: headers.length
    });
  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({ error: 'Ошибка импорта: ' + e.message });
  }
});

module.exports = router;
