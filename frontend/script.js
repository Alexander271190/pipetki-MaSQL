// ============================================================
// КОНФИГУРАЦИЯ API
// ============================================================
const API_URL = '/api';
let authToken = null;
let currentUser = null;
let _cachedSubdivisions = [];
let _cachedDepartmentsFull = [];
let _cachedFilters = [];
let _activeFilters = [];

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatDate(d) { if (!d) return '—'; return new Date(d).toLocaleDateString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric'}); }
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.className = 'toast', 4000);
}

// ============================================================
// API КЛИЕНТ
// ============================================================
async function apiRequest(endpoint, method = 'GET', data = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const options = { method, headers };
  if (data) options.body = JSON.stringify(data);

  const response = await fetch(`${API_URL}${endpoint}`, options);

  if (response.status === 401) {
    clearSession();
    renderAuthUI();
    showToast('Сессия истекла, войдите заново', 'error');
    throw new Error('Неавторизован');
  }

  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ошибка запроса');
  return result;
}

// ============================================================
// АВТОРИЗАЦИЯ
// ============================================================

function getSession() {
  try {
    const data = JSON.parse(sessionStorage.getItem('pipette_session'));
    if (data && data.token) {
      authToken = data.token;
      currentUser = data.user;
      return data;
    }
  } catch {}
  return null;
}

// setSession(user, token, originalUser, originalToken)
function setSession(user, token, originalUser, originalToken) {
  const data = { user, token };
  if (originalUser && originalToken) {
    data.originalUser = originalUser;
    data.originalToken = originalToken;
  }
  sessionStorage.setItem('pipette_session', JSON.stringify(data));
  authToken = token;
  currentUser = user;
}

function clearSession() {
  sessionStorage.removeItem('pipette_session');
  authToken = null;
  currentUser = null;
}

function getOriginalUser() {
  try {
    const data = JSON.parse(sessionStorage.getItem('pipette_session'));
    return data && data.originalUser ? data.originalUser : null;
  } catch { return null; }
}

function getOriginalToken() {
  try {
    const data = JSON.parse(sessionStorage.getItem('pipette_session'));
    return data && data.originalToken ? data.originalToken : null;
  } catch { return null; }
}

function isImpersonating() {
  return !!getOriginalUser();
}
// ============================================================
// ПРАВА ПОЛЬЗОВАТЕЛЕЙ
// ============================================================
function getBasePermissions(role) {
  if (role === 'admin') return ['manage_pipettes', 'import_data', 'export_data'];
  return [];
}

const PERMISSION_LABELS = {
  'manage_pipettes': 'Управление пипетками',
  'import_data':     'Импорт данных',
  'export_data':     'Экспорт данных'
};

function hasPermission(permission) {
  const user = currentUser;
  if (!user) return false;
  if (user.role === 'admin') return true;
  const base = getBasePermissions(user.role) || [];
  const extra = user.extraPermissions || [];
  const allPerms = [...new Set([...base, ...extra])];
  return allPerms.includes(permission);
}

function canManagePipettes() { return hasPermission('manage_pipettes'); }
function canImport()         { return hasPermission('import_data'); }
function canExport()         { return hasPermission('export_data'); }

function isAuthenticated() { return !!currentUser; }
function isAdmin() { return currentUser && currentUser.role === 'admin'; }
function isSeniorLab() { return currentUser && currentUser.role === 'senior_lab'; }

// ============================================================
// ВХОД / ВЫХОД
// ============================================================
async function loginUser(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  if (!username || !password) {
    errorEl.textContent = 'Заполните все поля';
    return;
  }

  try {
    const result = await apiRequest('/auth/login', 'POST', { login: username, password });
    setSession(result.user, result.token);
    showToast(`Добро пожаловать, ${result.user.fullName}!`, 'success');
    renderAuthUI();
  } catch (error) {
    errorEl.textContent = error.message || 'Ошибка входа';
  }
}

function logoutUser() {
  clearSession();
  renderAuthUI();
  showToast('Вы вышли из системы', 'success');
}
// ============================================================
// IMPERSONATE
// ============================================================
async function impersonateUser(userId) {
  // Если уже в режиме impersonate — возвращаемся сначала
  const originalUser = getOriginalUser() || currentUser;
  const originalToken = getOriginalToken() || authToken;

  try {
    const result = await apiRequest('/auth/impersonate/' + userId, 'POST', {});
    setSession(result.user, result.token, originalUser, originalToken);
    showToast('Вы вошли как ' + result.user.fullName, 'success');
    renderAuthUI();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function stopImpersonate() {
  const originalUser = getOriginalUser();
  const originalToken = getOriginalToken();
  if (!originalUser || !originalToken) {
    showToast('Вы не в режиме переключения', 'error');
    return;
  }
  // Возвращаемся к оригиналу
  authToken = originalToken;
  currentUser = originalUser;
  sessionStorage.setItem('pipette_session', JSON.stringify({
    user: originalUser,
    token: originalToken
  }));
  showToast('Вернулись к своей учётной записи', 'success');
  renderAuthUI();
  loadPipetteData();
}

// ============================================================
// ЗАГРУЗКА ДАННЫХ
// ============================================================
let pipettes = [];
let settings = { warnDays: 30 };
let sortField = 'nextCalibration';
let sortDir = 1;
let currentHistoryId = null;
let departmentsList = [];
let subdivisionsList = [];

async function loadPipetteData() {
  if (!isAuthenticated()) return;
  try {
    const data = await apiRequest('/pipettes');
    pipettes = data;
    const settingsData = await apiRequest('/settings/system');
    settings = { warnDays: parseInt(settingsData.warn_days) || 30 };

    await loadDepartments();
    await loadSubdivisions();
    await loadFilterConfig();

    render();
    checkReminder();
  } catch (error) {
    console.error('Error loading data:', error);
    showToast('Ошибка загрузки данных', 'error');
  }
}

async function loadDepartments() {
  try {
    departmentsList = await apiRequest('/settings/departments');
  } catch (error) {
    console.error('Error loading departments:', error);
    departmentsList = [];
  }
}

async function loadSubdivisions() {
  try {
    subdivisionsList = await apiRequest('/settings/subdivisions');
  } catch (error) {
    console.error('Error loading subdivisions:', error);
    subdivisionsList = [];
  }
}

async function loadFilterConfig() {
  try {
    const raw = await apiRequest('/settings/filters');
    _activeFilters = raw.filter(f => f.enabled);
    for (const f of _activeFilters) {
      if (f.type === 'select') {
        if (f.optionsSource === 'departments') {
          f.options = departmentsList.map(d => ({ value: d, label: d }));
        } else if (f.optionsSource === 'subdivisions') {
          f.options = subdivisionsList.map(s => ({ value: s, label: s }));
        } else if (f.optionsSource === 'status_list') {
          f.options = [
            { value: 'ok', label: 'В норме' },
            { value: 'warn', label: 'Скоро поверка' },
            { value: 'danger', label: 'Просрочены' },
            { value: 'inactive', label: 'Неактивны' }
          ];
        } else if (f.optionsSource === 'active_list') {
          f.options = [
            { value: 'true', label: 'В работе' },
            { value: 'false', label: 'Неактивны' }
          ];
        } else {
          f.options = [];
        }
      }
    }
    _filterRendered = false;
  } catch (e) {
    console.error('Error loading filter config:', e);
    _activeFilters = [];
  }
}
// ============================================================
// СТАТУСЫ ПИПЕТОК
// ============================================================
function calcStatus(p) {
  if (!p.active) return 'inactive';
  if (!p.last_calibration || !p.interval) return 'danger';
  const last = new Date(p.last_calibration);
  const next = new Date(last);
  next.setMonth(next.getMonth() + p.interval);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((next - now) / 86400000);
  if (daysLeft < 0) return 'danger';
  if (daysLeft <= settings.warnDays) return 'warn';
  return 'ok';
}

function getNextDate(p) {
  if (!p.last_calibration || !p.interval) return null;
  const d = new Date(p.last_calibration);
  d.setMonth(d.getMonth() + p.interval);
  return d;
}

function daysLeft(p) {
  const next = getNextDate(p);
  if (!next) return -9999;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.ceil((next - now) / 86400000);
}


// ============================================================
// РЕНДЕР
// ============================================================
function render() {
  let filtered = getFilteredPipettes();

  filtered.sort((a, b) => {
    let va, vb;
    if (sortField === 'nextCalibration') {
      va = getNextDate(a) || new Date(8640000000000000);
      vb = getNextDate(b) || new Date(8640000000000000);
    } else if (sortField === 'volume') {
      va = parseFloat(a.volume) || 0;
      vb = parseFloat(b.volume) || 0;
    } else {
      va = (a[sortField] || '').toString().toLowerCase();
      vb = (b[sortField] || '').toString().toLowerCase();
    }
    if (va < vb) return -1 * sortDir;
    if (va > vb) return 1 * sortDir;
    return 0;
  });

  let ok = 0, warn = 0, danger = 0;
  pipettes.forEach(p => {
    const s = calcStatus(p);
    if (s === 'ok') ok++;
    else if (s === 'warn') warn++;
    else if (s === 'danger') danger++;
  });
  document.getElementById('stat-ok').textContent = ok;
  document.getElementById('stat-warn').textContent = warn;
  document.getElementById('stat-danger').textContent = danger;
  document.getElementById('stat-total').textContent = pipettes.length;

  const banner = document.getElementById('alert-banner');
  if (danger > 0) {
    document.getElementById('alert-text').textContent = `У ${danger} ${danger === 1 ? 'пипетки просрочена' : 'пипеток просрочена'} поверка! Требуется срочное действие.`;
    banner.classList.add('show');
  } else if (warn > 0) {
    document.getElementById('alert-text').textContent = `У ${warn} ${warn === 1 ? 'пипетки подходит' : 'пипеток подходят'} к сроку поверки в течение ${settings.warnDays} дн.`;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }

  const tbody = document.getElementById('pipettes-body');
  const empty = document.getElementById('empty-state');
  const table = document.getElementById('pipettes-table');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    table.style.display = 'none';
    empty.style.display = 'block';
    if (pipettes.length > 0) empty.querySelector('p').textContent = 'Ничего не найдено по фильтру.';
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';

  const canManage = canManagePipettes();
  const labels = { ok: 'В норме', warn: 'Скоро поверка', danger: 'Просрочена', inactive: 'Неактивна' };

  tbody.innerHTML = filtered.map(p => {
    const status = calcStatus(p);
    const next = getNextDate(p);
    const dl = daysLeft(p);
    const daysText = status === 'inactive' ? '' :
      status === 'danger' ? ` (просрочка ${Math.abs(dl)} дн.)` :
      ` (${dl} дн.)`;
    const histCount = (p.history || []).length;
    let actionsHtml = '';
    if (canManage) {
      actionsHtml = `<div class="action-btns">
        <button class="btn btn-secondary btn-sm" onclick="openModal('${p.id}')" title="Редактировать">✏️</button>
        <button class="btn btn-info btn-sm" onclick="openHistoryModal('${p.id}')" title="История поверок (${histCount})">📋</button>
        <button class="btn btn-success btn-sm" onclick="openQuickCalModal('${p.id}')" title="Быстрая поверка">✔️</button>
        <button class="btn btn-danger btn-sm" onclick="deletePipette('${p.id}')" title="Удалить">🗑️</button>
      </div>`;
    } else {
      actionsHtml = `<button class="btn btn-info btn-sm" onclick="openHistoryModal('${p.id}')" title="История поверок (${histCount})">📋</button>`;
    }
    return `<tr>
      <td><strong>${esc(p.id)}</strong>${p.serial ? `<br><small style="color:#94a3b8">S/N: ${esc(p.serial)}</small>` : ''}</td>
      <td>${esc(p.model)}${p.manufacturer ? `<br><small style="color:#94a3b8">${esc(p.manufacturer)}</small>` : ''}</td>
      <td>${p.volume ? esc(p.volume) + ' мкл' : '—'}</td>
      <td>${esc(p.department || '—')}</td>
      <td>${formatDate(p.last_calibration)}</td>
      <td>${formatDate(next)}${daysText ? `<br><small style="color:${status === 'danger' ? '#dc2626' : status === 'warn' ? '#eab308' : '#16a34a'}">${daysText}</small>` : ''}</td>
      <td>${esc(p.responsible || '—')}${p.location ? `<br><small style="color:#94a3b8">${esc(p.location)}</small>` : ''}</td>
      <td><span class="status-badge status-${status}"><span class="status-dot"></span>${labels[status]}</span></td>
      <td>${actionsHtml}</td>
    </tr>`;
  }).join('');

  updateSortArrows();
}

function updateSortArrows() {
  const fields = ['id', 'model', 'volume', 'department', 'lastCalibration', 'nextCalibration', 'responsible'];
  document.querySelectorAll('th .sort-arrow').forEach((el, i) => {
    if (fields[i] === sortField) el.textContent = sortDir > 0 ? '▲' : '▼';
    else el.textContent = '';
  });
}

function sortBy(field) {
  if (sortField === field) sortDir *= -1;
  else { sortField = field; sortDir = 1; }
  render();
}

// ============================================================
// ФИЛЬТРЫ (динамические из filter_config)
// ============================================================
let filterState = {};
let _filterRendered = false;

function renderFilterFields() {
  const container = document.getElementById('filter-fields-container');
  if (!container) return;
  if (_activeFilters.length === 0) {
    container.innerHTML = '<p style="color:#94a3b8;padding:8px;">Нет доступных фильтров</p>';
    return;
  }

  let html = '';
  _activeFilters.forEach(f => {
    const fid = `filter-${f.id}`;

    if (f.type === 'date-period') {
      html += `
        <div class="filter-row">
          <div class="form-group">
            <label>По какой дате</label>
            <select id="${fid}-type">
              <option value="last_calibration">📄 Дата поверки (из сертификата)</option>
              <option value="updated_at">📝 Дата внесения в систему</option>
            </select>
          </div>
          <div class="form-group">
            <label>Период</label>
            <select id="${fid}-period" onchange="toggleCustomPeriod('${fid}')">
              <option value="">Все</option>
              <option value="today">📅 Сегодня</option>
              <option value="yesterday">Вчера</option>
              <option value="week">За 7 дней</option>
              <option value="month">За 30 дней</option>
              <option value="custom">Произвольный период</option>
            </select>
          </div>
        </div>
        <div class="filter-row" id="${fid}-custom" style="display:none;">
          <div class="form-group"><label>С даты</label><input type="date" id="${fid}-from"></div>
          <div class="form-group"><label>По дату</label><input type="date" id="${fid}-to"></div>
        </div>`;
    } else if (f.type === 'select') {
      html += `<div class="filter-row"><div class="form-group">
        <label>${esc(f.label)}</label>
        <select id="${fid}">
          <option value="">Все</option>
          ${(f.options || []).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
        </select>
      </div></div>`;
    } else if (f.type === 'text') {
      html += `<div class="filter-row"><div class="form-group">
        <label>${esc(f.label)}</label>
        <input type="text" id="${fid}" placeholder="${esc(f.label)}">
      </div></div>`;
    }
  });

  container.innerHTML = html;
  _filterRendered = true;
}

function toggleCustomPeriod(fid) {
  const sel = document.getElementById(`${fid}-period`);
  const custom = document.getElementById(`${fid}-custom`);
  if (sel && custom) {
    custom.style.display = sel.value === 'custom' ? 'flex' : 'none';
  }
}

function toggleFilterPanel() {
  const panel = document.getElementById('filter-panel');
  if (!panel) return;
  if (!_filterRendered) renderFilterFields();
  panel.classList.toggle('show');
}

function applyFilters() {
  filterState = {};
  for (const f of _activeFilters) {                     // ← _activeFilters
    const fid = `filter-${f.id}`;
    if (f.type === 'date-period') {
      const typeEl = document.getElementById(`${fid}-type`);
      const periodEl = document.getElementById(`${fid}-period`);
      const fromEl = document.getElementById(`${fid}-from`);
      const toEl = document.getElementById(`${fid}-to`);
      filterState[f.id] = {
        type: typeEl ? typeEl.value : 'last_calibration',
        period: periodEl ? periodEl.value : '',
        from: fromEl ? fromEl.value : '',
        to: toEl ? toEl.value : ''
      };
    } else {
      const el = document.getElementById(fid);
      filterState[f.id] = el ? el.value.trim() : '';
    }
  }
  document.getElementById('filter-panel').classList.remove('show');
  render();
}

function resetFilters() {
  filterState = {};
  for (const f of _activeFilters) {                     // ← _activeFilters
    const fid = `filter-${f.id}`;
    if (f.type === 'date-period') {
      const typeEl = document.getElementById(`${fid}-type`);
      const periodEl = document.getElementById(`${fid}-period`);
      const fromEl = document.getElementById(`${fid}-from`);
      const toEl = document.getElementById(`${fid}-to`);
      const custom = document.getElementById(`${fid}-custom`);
      if (typeEl) typeEl.value = 'last_calibration';
      if (periodEl) periodEl.value = '';
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      if (custom) custom.style.display = 'none';
    } else {
      const el = document.getElementById(fid);
      if (el) el.value = '';
    }
  }
  document.getElementById('filter-panel').classList.remove('show');
  render();
}

function getFilteredPipettes() {
  const search = document.getElementById('search').value.toLowerCase();
  const userDept = currentUser && currentUser.onlyOwnDepartment ? currentUser.department : null;

  return pipettes.filter(p => {
    const s = `${p.id} ${p.serial || ''} ${p.model} ${p.manufacturer || ''} ${p.department || ''} ${p.subdivision || ''} ${p.responsible || ''}`.toLowerCase();
    if (search && !s.includes(search)) return false;

    if (userDept && p.department !== userDept) return false;

    for (const f of _activeFilters) {                   // ← _activeFilters
      const v = filterState[f.id];

      if (f.type === 'select') {
        if (v) {
          if (f.id === 'status') {
            if (calcStatus(p) !== v) return false;
          } else if (f.id === 'active') {
            if (String(p.active) !== v) return false;
          } else if (f.fieldId) {
            if (String(p[f.fieldId] || '') !== v) return false;
          }
        }
      } else if (f.type === 'text') {
        if (v && f.fieldId) {
          if (!(p[f.fieldId] || '').toLowerCase().includes(v.toLowerCase())) return false;
        }
      } else if (f.type === 'date-period') {
        if (v && v.period && !matchCalPeriodDynamic(p, v)) return false;
      }
    }

    return true;                                        
  });
 }

 function matchCalPeriodDynamic(p, cfg) {
  let dateStr;
  if (cfg.type === 'updated_at') {
    dateStr = p.updated_at || p.created_at;
  } else {
    dateStr = p.last_calibration;
  }
  if (!dateStr) return false;

  const pureDate = String(dateStr).split(' ')[0].split('T')[0];
  const targetDate = new Date(pureDate);
  targetDate.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - targetDate) / 86400000);

  switch (cfg.period) {
    case 'today':      return diffDays === 0;
    case 'yesterday':  return diffDays === 1;
    case 'week':       return diffDays >= 0 && diffDays <= 7;
    case 'month':      return diffDays >= 0 && diffDays <= 30;
    case 'custom':
      if (cfg.from) {
        const from = new Date(cfg.from); from.setHours(0, 0, 0, 0);
        if (targetDate < from) return false;
      }
      if (cfg.to) {
        const to = new Date(cfg.to); to.setHours(23, 59, 59, 999);
        if (targetDate > to) return false;
      }
      return true;
    default: return true;
  }
}

// ============================================================
// ДИНАМИЧЕСКАЯ ФОРМА (загружает поля с сервера)
// ============================================================
async function generateFormFields(data = null) {
  const container = document.getElementById('form-fields-container');
  container.innerHTML = '<p style="color:#94a3b8;padding:10px;">Загрузка полей…</p>';

  try {
    // Загружаем конфигурацию полей с сервера
    const allFields = await apiRequest('/settings/fields');
    const fields = allFields
      .filter(f => f.enabled)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    container.innerHTML = '';

    // Если полей нет — предупреждаем
    if (fields.length === 0) {
      container.innerHTML = '<p style="color:#dc2626;padding:10px;">Нет активных полей. Включите их в настройках.</p>';
      return;
    }

        // Загружаем справочники (для полей department и subdivision)
    let departmentsList = [];
    let subdivisionsList = [];
    try {
      departmentsList = await apiRequest('/settings/departments');
    } catch (e) { /* игнорируем */ }
    try {
      subdivisionsList = await apiRequest('/settings/subdivisions');
    } catch (e) { /* игнорируем */ }

    for (const f of fields) {
      const div = document.createElement('div');
      div.className = 'form-group';

      const label = document.createElement('label');
      label.textContent = f.label + (f.required ? ' *' : '');
      div.appendChild(label);

      // Значение поля: из data (при редактировании) или default
      let val;
      if (data && data[f.id] !== undefined && data[f.id] !== null) {
        val = data[f.id];
      } else {
        val = f.default || '';
      }

      let input;

      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 2;
        input.placeholder = f.label;
        input.value = val;

      } else if (f.type === 'select') {
        input = document.createElement('select');

        // Определяем опции для выпадающего списка
        let opts = [];

      if (f.id === 'department') {
          opts = departmentsList.length ? departmentsList : (f.options || []);
        } else if (f.id === 'subdivision') {              
          opts = subdivisionsList.length ? subdivisionsList : (f.options || []);
        } else if (f.id === 'result') {
          // Результат поверки — фиксированные значения с русскими метками
          opts = [
            { value: 'pass', label: '✅ Годен' },
            { value: 'fail', label: '❌ Брак' },
            { value: 'wip',  label: '⏳ В процессе' }
          ];
        } else if (f.id === 'active') {
          // Статус эксплуатации — понятные русские метки
          opts = [
            { value: 'true',  label: '✅ В работе' },
            { value: 'false', label: '⛔ Не используется' }
          ];
        } else {
          // Обычное поле — берём options из конфигурации
          opts = f.options || [];
        }

        // Если пусто — ставим пустую опцию
        if (opts.length === 0) opts = [{ value: '', label: '—' }];

        // Строим <option>
        opts.forEach(opt => {
          const optValue = (typeof opt === 'object') ? opt.value : opt;
          const optLabel = (typeof opt === 'object') ? opt.label : (opt || '—');
          const option = document.createElement('option');
          option.value = optValue;
          option.textContent = optLabel;
          if (String(val) === String(optValue)) option.selected = true;
          input.appendChild(option);
        });

      } else {
        // Обычный input (text, number, date)
        input = document.createElement('input');
        input.type = f.type === 'date' ? 'date'
                   : f.type === 'number' ? 'number'
                   : 'text';
        input.placeholder = f.label;
        input.value = val;
      }

      input.id = `p-${f.id}`;
      input.dataset.fieldId = f.id;
      if (f.required) input.required = true;

      div.appendChild(input);
      container.appendChild(div);
    }

    // Если поле «Отдел» включено — заполняем datalist (если он есть)
    if (document.getElementById('p-department')) {
      const datalist = document.getElementById('dept-list');
      if (datalist) {
        datalist.innerHTML = departmentsList.map(d => `<option value="${esc(d)}">`).join('');
      }
    }

  } catch (err) {
    console.error('Ошибка загрузки полей:', err);
    container.innerHTML = '<p style="color:#dc2626;padding:10px;">Ошибка загрузки полей: ' + esc(err.message) + '</p>';
  }
}

// ============================================================
// ОТКРЫТИЕ МОДАЛКИ (добавление / редактирование)
// ============================================================
async function openModal(id) {
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }

  const modal = document.getElementById('modal');
  const title = document.getElementById('modal-title');
  document.getElementById('edit-id').value = '';

  if (id) {
    // Режим редактирования
    const p = pipettes.find(x => x.id === id);
    if (!p) { showToast('Пипетка не найдена', 'error'); return; }

    title.textContent = '✏️ Редактировать пипетку';
    document.getElementById('edit-id').value = p.id;

    // Показываем модалку сразу (форма подгрузится асинхронно)
    modal.classList.add('active');

    // Заполняем форму данными
    await generateFormFields(p);

  } else {
    // Режим добавления
    title.textContent = '➕ Добавить пипетку';

    // Подготавливаем значения по умолчанию
    const defaultData = {
      lastCalibration: new Date().toISOString().slice(0, 10),
      interval: 12,
      result: 'pass',
      active: 'true'
    };

    modal.classList.add('active');
    await generateFormFields(defaultData);
  }
}

function closeModal() { document.getElementById('modal').classList.remove('active'); }

async function savePipette(e) {
  e.preventDefault();
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }

  const editId = document.getElementById('edit-id').value;
  const container = document.getElementById('form-fields-container');
  const data = {};
  let valid = true;

  const inputs = container.querySelectorAll('input, select, textarea');
  inputs.forEach(el => {
    const fieldId = el.dataset.fieldId;
    if (!fieldId) return;

    let value = el.value;
    data[fieldId] = value;

    if (el.required && !value) {
      valid = false;
      el.style.borderColor = '#dc2626';
    } else {
      el.style.borderColor = '';
    }
  });

  if (!valid) { showToast('Заполните обязательные поля', 'error'); return; }

  if (data.interval) data.interval = parseInt(data.interval) || 12;
  if (data.active !== undefined) {
    data.active = data.active === 'true' || data.active === true;
  }

  if (data.lastCalibration && new Date(data.lastCalibration) > new Date()) {
    showToast('Дата поверки не может быть в будущем', 'error');
    return;
  }

  if (data.result) data.lastResult = data.result;

  try {
    if (editId) {
      await apiRequest(`/pipettes/${editId}`, 'PUT', data);
      showToast('Пипетка обновлена', 'success');
    } else {
      await apiRequest('/pipettes', 'POST', data);
      showToast('Пипетка добавлена', 'success');
    }
    closeModal();
    await loadPipetteData();
  } catch (error) {
    showToast(error.message || 'Ошибка сохранения', 'error');
  }
}
async function deletePipette(id) {
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }
  if (!confirm(`Удалить пипетку ${id} со всей историей?`)) return;
  try {
    await apiRequest(`/pipettes/${id}`, 'DELETE');
    showToast('Пипетка удалена', 'success');
    await loadPipetteData();
  } catch (error) {
    showToast(error.message || 'Ошибка удаления', 'error');
  }
}

// ============================================================
// БЫСТРАЯ ПОВЕРКА
// ============================================================
function openQuickCalModal(id) {
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }
  const p = pipettes.find(x => x.id === id);
  if (!p) { showToast('Пипетка не найдена', 'error'); return; }
  document.getElementById('quick-cal-id').value = id;
  document.getElementById('quick-cal-pipette-info').innerHTML = `<strong>${esc(p.id)}</strong> — ${esc(p.model)} (${esc(p.department || 'без отдела')})`;
  document.getElementById('quick-cal-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('quick-cal-cert').value = '';
  document.getElementById('quick-cal-result').value = 'pass';
  document.getElementById('quick-cal-org').value = '';
  document.getElementById('quick-cal-note').value = '';
  document.getElementById('quick-cal-modal').classList.add('active');
}

function closeQuickCalModal() {
  document.getElementById('quick-cal-modal').classList.remove('active');
}

async function saveQuickCalibration() {
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }
  const id = document.getElementById('quick-cal-id').value;
  const date = document.getElementById('quick-cal-date').value;
  const cert = document.getElementById('quick-cal-cert').value.trim();
  const result = document.getElementById('quick-cal-result').value;
  const org = document.getElementById('quick-cal-org').value.trim();
  const note = document.getElementById('quick-cal-note').value.trim();

  if (!date) { showToast('Укажите дату поверки', 'error'); return; }
  if (date > new Date().toISOString().slice(0, 10)) { showToast('Дата не может быть в будущем', 'error'); return; }

  try {
    await apiRequest(`/pipettes/${id}/calibration`, 'POST', { date, cert, result, org, note });
    showToast('Поверка зарегистрирована', 'success');
    closeQuickCalModal();
    await loadPipetteData();
  } catch (error) {
    showToast(error.message || 'Ошибка сохранения', 'error');
  }
}

// ============================================================
// ИСТОРИЯ
// ============================================================
async function openHistoryModal(id) {
  const p = pipettes.find(x => x.id === id);
  if (!p) return;
  currentHistoryId = id;
  document.getElementById('history-title').textContent = `История поверок — ${p.id}`;
  await renderHistoryContent(p);
  closeCalibrationForm();
  document.getElementById('history-modal').classList.add('active');
}

function closeHistoryModal() {
  document.getElementById('history-modal').classList.remove('active');
  currentHistoryId = null;
  closeCalibrationForm();
}

async function renderHistoryContent(p) {
  const content = document.getElementById('history-content');
  const next = getNextDate(p);
  const status = calcStatus(p);
  const statusLabels = { ok: 'В норме', warn: 'Скоро поверка', danger: 'Просрочена', inactive: 'Неактивна' };

  let history = [];
  try {
    history = await apiRequest(`/pipettes/${p.id}/calibration`);
  } catch (error) {
    console.error('Error loading history:', error);
  }

  let infoHtml = `
    <div class="info-grid">
      <div><label>Модель</label><span>${esc(p.model)}${p.manufacturer ? ' (' + esc(p.manufacturer) + ')' : ''}</span></div>
      <div><label>Серийный номер</label><span>${esc(p.serial || '—')}</span></div>
      <div><label>Объём</label><span>${p.volume ? esc(p.volume) + ' мкл' : '—'}</span></div>
      <div><label>Отдел</label><span>${esc(p.department || '—')}</span></div>
      <div><label>МПИ</label><span>${p.interval} мес.</span></div>
      <div><label>Последняя поверка</label><span>${formatDate(p.last_calibration)}</span></div>
      <div><label>Следующая поверка</label><span>${formatDate(next)}</span></div>
      <div><label>Статус</label><span><span class="status-badge status-${status}"><span class="status-dot"></span>${statusLabels[status]}</span></span></div>
      <div><label>Ответственный</label><span>${esc(p.responsible || '—')}</span></div>
      <div><label>Место хранения</label><span>${esc(p.location || '—')}</span></div>
    </div>
  `;

  let histHtml = '';
  const resultLabels = { pass: 'Годен', fail: 'Брак', wip: 'В процессе' };

  if (history.length === 0) {
    histHtml = '<div class="history-empty">Записей о поверках пока нет.<br>Нажмите «Добавить поверку», чтобы создать первую.</div>';
  } else {
    histHtml = '<div class="history-header"><h3>Журнал поверок (' + history.length + ')</h3></div>';
    histHtml += '<div class="timeline" style="position:relative;padding-left:28px;margin-top:15px;">';
    history.forEach(h => {
      const itemClass = h.result === 'fail' ? 'danger' : (h.result === 'wip' ? 'warn' : '');
      histHtml += `<div class="timeline-item ${itemClass}" style="position:relative;padding-bottom:20px;border-left:2px solid #e2e8f0;padding-left:20px;">
        <div style="font-weight:600;font-size:.85rem;color:#475569;">${formatDate(h.date)}</div>
        ${h.cert ? `<div style="display:inline-block;background:#e0f2fe;color:#0369a1;padding:2px 10px;border-radius:6px;font-size:.78rem;margin-top:4px;">📄 Свидетельство № ${esc(h.cert)}</div>` : ''}
        <span style="display:inline-block;padding:2px 10px;border-radius:6px;font-size:.78rem;margin-top:4px;margin-left:6px;${h.result === 'pass' ? 'background:#dcfce7;color:#166534;' : h.result === 'fail' ? 'background:#fee2e2;color:#991b1b;' : 'background:#e0f2fe;color:#0369a1;'}">${resultLabels[h.result] || h.result}</span>
        ${h.org ? `<div style="font-size:.85rem;color:#64748b;margin-top:4px;">Организация: ${esc(h.org)}</div>` : ''}
        ${h.note ? `<div style="font-size:.85rem;color:#64748b;margin-top:4px;">${esc(h.note)}</div>` : ''}
      </div>`;
    });
    histHtml += '</div>';
  }

  content.innerHTML = infoHtml + histHtml;
}

function openCalibrationForm() {
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }
  document.getElementById('calibration-form-wrap').style.display = 'block';
  document.getElementById('cal-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('cal-cert').value = '';
  document.getElementById('cal-result').value = 'pass';
  document.getElementById('cal-org').value = '';
  document.getElementById('cal-note').value = '';
}

function closeCalibrationForm() {
  document.getElementById('calibration-form-wrap').style.display = 'none';
}

async function addCalibrationRecord() {
  if (!canManagePipettes()) { showToast('Доступ запрещён', 'error'); return; }
  const date = document.getElementById('cal-date').value;
  const cert = document.getElementById('cal-cert').value.trim();
  const result = document.getElementById('cal-result').value;
  const org = document.getElementById('cal-org').value.trim();
  const note = document.getElementById('cal-note').value.trim();

  if (!date) { showToast('Укажите дату поверки', 'error'); return; }
  if (date > new Date().toISOString().slice(0, 10)) { showToast('Дата не может быть в будущем', 'error'); return; }

  try {
    await apiRequest(`/pipettes/${currentHistoryId}/calibration`, 'POST', { date, cert, result, org, note });
    showToast('Запись о поверке добавлена', 'success');
    closeCalibrationForm();
    closeHistoryModal();
    await loadPipetteData();
  } catch (error) {
    showToast(error.message || 'Ошибка сохранения', 'error');
  }
}
// ============================================================
// ЭКСПОРТ
// ============================================================
async function exportToExcel() {
    if (!canExport()) { showToast('Нет прав на экспорт', 'error'); return; }
  const data = getFilteredPipettes();
  if (data.length === 0) { showToast('Нет данных для экспорта', 'error'); return; }

  const headers = ['ID', 'Серийный', 'Производитель', 'Модель', 'Объём', 'Отдел', 'Дата поверки', 'Следующая', 'МПИ', 'Дней', 'Ответственный', 'Место', 'Статус', 'Свидетельство', 'Примечание'];
  const labels = { ok: 'В норме', warn: 'Скоро поверка', danger: 'Просрочена', inactive: 'Неактивна' };

  const csvLines = [headers.join(';')];
  data.forEach(p => {
    const next = getNextDate(p);
    const status = calcStatus(p);
    const dl = daysLeft(p);
    const dlText = status === 'inactive' ? '—' : (dl < 0 ? 'просрочка ' + Math.abs(dl) + ' дн.' : dl + ' дн.');
    const row = [
      p.id, p.serial || '', p.manufacturer || '', p.model, p.volume || '',
      p.department || '', formatDate(p.last_calibration), formatDate(next),
      p.interval || '', dlText, p.responsible || '', p.location || '',
      labels[status] || status, p.cert || '', p.notes || ''
    ];
    const line = row.map(v => {
      const s = String(v).replace(/"/g, '""');
      return /[";]/.test(s) ? '"' + s + '"' : s;
    }).join(';');
    csvLines.push(line);
  });

  const bom = '\uFEFF';
  const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipettes_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Файл Excel (CSV) сохранён', 'success');
}

function exportToPDF() {
 if (!canExport()) { showToast('Нет прав на экспорт', 'error'); return; }
  const data = getFilteredPipettes();
  if (data.length === 0) { showToast('Нет данных для экспорта', 'error'); return; }

  const labels = { ok: 'В норме', warn: 'Скоро поверка', danger: 'Просрочена', inactive: 'Неактивна' };
  const today = new Date().toLocaleDateString('ru-RU');
  const user = currentUser ? currentUser.fullName : '';

  const rows = data.map(p => {
    const next = getNextDate(p);
    const status = calcStatus(p);
    const dl = daysLeft(p);
    const dlText = status === 'inactive' ? '—'
      : (dl < 0 ? 'просрочка ' + Math.abs(dl) + ' дн.' : dl + ' дн.');
    return `
      <tr>
        <td>${esc(p.id)}</td>
        <td>${esc(p.model)}${p.manufacturer ? '<br><small>' + esc(p.manufacturer) + '</small>' : ''}</td>
        <td>${esc(p.serial || '—')}</td>
        <td>${p.volume ? esc(p.volume) + ' мкл' : '—'}</td>
        <td>${esc(p.department || '—')}</td>
        <td>${formatDate(p.last_calibration)}</td>
        <td>${formatDate(next)}${dlText !== '—' ? '<br><small>' + dlText + '</small>' : ''}</td>
        <td>${esc(p.responsible || '—')}</td>
        <td><span class="status-${status}">${labels[status]}</span></td>
      </tr>`;
  }).join('');

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
    <title>Реестр пипеток — ${today}</title>
    <style>
      @page { size: A4 landscape; margin: 15mm 10mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 9pt; color: #1a1a2e; }
      h1 { font-size: 14pt; margin: 0 0 4px; color: #1e293b; }
      .meta { font-size: 9pt; color: #64748b; margin-bottom: 12px; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; }
      .meta b { color: #1e293b; }
      table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
      th { background: #1e293b; color: #fff; padding: 6px 5px; text-align: left; font-size: 8pt; text-transform: uppercase; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      td { padding: 5px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
      tr:nth-child(even) td { background: #f8fafc; }
      small { color: #94a3b8; font-size: 7.5pt; }
      .status-ok { color: #16a34a; font-weight: 600; }
      .status-warn { color: #ca8a04; font-weight: 600; }
      .status-danger { color: #dc2626; font-weight: 700; }
      .status-inactive { color: #94a3b8; }
      .footer {
  margin-top: 15px;
  font-size: 8pt;
  color: #000000;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid #e2e8f0;
  padding-top: 8px;
}
.footer .sign { margin-top: 0; }
    </style></head><body>
      <h1>🔬 Реестр пипеток — КГБУЗ Краевая клиническая больница КДЛ</h1>
      <div class="meta">Дата: <b>${today}</b> · Записей: <b>${data.length}</b> · Сформировал: <b>${esc(user)}</b></div>
      <table>
        <thead><tr>
          <th style="width:8%">ID</th><th style="width:16%">Модель / Производитель</th>
          <th style="width:10%">Серийный</th><th style="width:8%">Объём</th>
          <th style="width:14%">Отдел</th><th style="width:10%">Поверка</th>
          <th style="width:12%">Следующая</th><th style="width:12%">Ответственный</th>
          <th style="width:10%">Статус</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="footer">
        <div>Документ сформировал: <b>${esc(user)}</b></div>
        <div class="sign">Подпись: _______________</div>
      </div>
    </body></html>`);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 300);
  showToast('Окно печати открыто — выберите «Сохранить как PDF»', 'success');
}
// ============================================================
// ВЫПАДАЮЩЕЕ МЕНЮ ЭКСПОРТА
// ============================================================
function toggleExportMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('export-menu');
  menu.classList.toggle('show');
}

function closeExportMenu() {
  const menu = document.getElementById('export-menu');
  if (menu) menu.classList.remove('show');
}

// Закрываем меню при клике вне него
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('export-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    closeExportMenu();
  }
});
// ============================================================
// НАПОМИНАНИЕ
// ============================================================
function checkReminder() {
  const lastShown = localStorage.getItem('pipette_last_reminder');
  const today = new Date().toISOString().slice(0, 10);
  if (lastShown === today) return;

  const dangerList = pipettes.filter(p => calcStatus(p) === 'danger');
  const warnList = pipettes.filter(p => calcStatus(p) === 'warn');
  if (dangerList.length === 0 && warnList.length === 0) return;

  setTimeout(() => showReminder(dangerList, warnList), 600);
}

function showReminder(dangerList, warnList) {
  const icon = document.getElementById('reminder-icon');
  const title = document.getElementById('reminder-title');
  const subtitle = document.getElementById('reminder-subtitle');
  const body = document.getElementById('reminder-body');

  if (dangerList.length > 0) {
    icon.textContent = '🚨';
    title.textContent = 'Просрочены поверки!';
    title.style.color = '#dc2626';
    subtitle.textContent = `${dangerList.length} ${dangerList.length === 1 ? 'пипетка требует' : 'пипеток требуют'} срочной поверки`;
  } else {
    icon.textContent = '🔔';
    title.textContent = 'Приближаются сроки поверки';
    title.style.color = '#eab308';
    subtitle.textContent = `${warnList.length} ${warnList.length === 1 ? 'пипетка подходит' : 'пипеток подходят'} к сроку поверки в течение ${settings.warnDays} дн.`;
  }

  let html = '';
  if (dangerList.length > 0) {
    html += `<div class="reminder-section"><div class="reminder-section-title danger">🚨 Просрочены (${dangerList.length})</div><ul class="reminder-list">`;
    dangerList.sort((a, b) => daysLeft(a) - daysLeft(b)).forEach(p => {
      const dl = daysLeft(p);
      html += `<li class="danger">
        <div class="pip-info"><div class="pip-id">${esc(p.id)} — ${esc(p.model)}</div>
        <div class="pip-detail">${esc(p.department || 'без отдела')} · ${esc(p.responsible || '—')}</div></div>
        <div class="pip-days">просрочка ${Math.abs(dl)} дн.</div>
      </li>`;
    });
    html += '</ul></div>';
  }
  if (warnList.length > 0) {
    html += `<div class="reminder-section"><div class="reminder-section-title warn">⚠️ Скоро поверка (${warnList.length})</div><ul class="reminder-list">`;
    warnList.sort((a, b) => daysLeft(a) - daysLeft(b)).forEach(p => {
      const dl = daysLeft(p);
      html += `<li class="warn">
        <div class="pip-info"><div class="pip-id">${esc(p.id)} — ${esc(p.model)}</div>
        <div class="pip-detail">${esc(p.department || 'без отдела')} · ${esc(p.responsible || '—')}</div></div>
        <div class="pip-days">${dl} дн.</div>
      </li>`;
    });
    html += '</ul></div>';
  }
  body.innerHTML = html;
  document.getElementById('reminder-overlay').classList.add('active');
}

function closeReminder(confirmed) {
  document.getElementById('reminder-overlay').classList.remove('active');
  if (confirmed) {
    localStorage.setItem('pipette_last_reminder', new Date().toISOString().slice(0, 10));
  }
}

// ============================================================
// UI АВТОРИЗАЦИИ
// ============================================================
function renderAuthUI() {
  const authContainer = document.getElementById('auth-container');
  const mainContent = document.getElementById('main-content');

  if (isAuthenticated()) {
    authContainer.classList.add('hidden');
    mainContent.classList.add('visible');

    document.getElementById('user-fullname').textContent = currentUser.fullName;
    let posText = currentUser.position +
      (currentUser.role === 'admin' ? ' (админ)'
        : currentUser.role === 'senior_lab' ? ' (ст. лаборант)' : '');
    if (currentUser.department) posText += ' · ' + currentUser.department;
    document.getElementById('user-position').textContent = posText;

    // Кнопка «Вернуться» — показываем только в режиме impersonate
    const btnStop = document.getElementById('btn-impersonate-stop');
    if (btnStop) {
      btnStop.style.display = isImpersonating() ? 'inline-flex' : 'none';
    }

    // Проверяем права
    const canManage = hasPermission('manage_pipettes');
    const canImport = hasPermission('import_data');
    const canExport = hasPermission('export_data');
    const admin = isAdmin();

    // Показ/скрытие кнопок по правам
    document.querySelectorAll('.btn-add-pipette').forEach(el => el.style.display = canManage ? 'inline-flex' : 'none');
    document.querySelectorAll('.btn-import').forEach(el => el.style.display = canImport ? 'inline-flex' : 'none');
    document.querySelectorAll('.btn-export').forEach(el => el.style.display = canExport ? 'inline-flex' : 'none');
    document.querySelectorAll('.btn-settings').forEach(el => el.style.display = admin ? 'inline-flex' : 'none');

    const actionsHeader = document.getElementById('actions-header');
    if (actionsHeader) actionsHeader.style.display = canManage ? '' : 'none';

    document.body.classList.toggle('can-manage', canManage);
    document.body.classList.toggle('can-import', canImport);
    document.body.classList.toggle('can-export', canExport);
    document.body.classList.toggle('is-admin', admin);

    loadPipetteData();

  } else {
    authContainer.classList.remove('hidden');
    mainContent.classList.remove('visible');
    document.body.classList.remove('can-manage', 'can-import', 'can-export', 'is-admin');
    const btnStop = document.getElementById('btn-impersonate-stop');
    if (btnStop) btnStop.style.display = 'none';
  }
}


// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
document.getElementById('search').addEventListener('input', render);
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.getElementById('quick-cal-modal').addEventListener('click', e => { if (e.target.id === 'quick-cal-modal') closeQuickCalModal(); });
document.getElementById('history-modal').addEventListener('click', e => { if (e.target.id === 'history-modal') closeHistoryModal(); });


const session = getSession();
if (session) {
  authToken = session.token;
  currentUser = session.user;
  renderAuthUI();
  
}
// ============================================================
// ИМПОРТ ДАННЫХ
// ============================================================
function openImportModal() {
  if (!canImport()) { showToast('Нет прав на импорт', 'error'); return; }
  document.getElementById('import-modal').classList.add('active');
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('active');
  document.getElementById('import-file').value = '';
}

async function handleImport() {
  if (!canImport()) { showToast('Нет прав на импорт', 'error'); return; } 
  const format = document.getElementById('import-format').value;
  const fileInput = document.getElementById('import-file');
  const file = fileInput.files[0];
  if (!file) { showToast('Выберите файл', 'error'); return; }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      let imported = [];
      if (format === 'json') {
        imported = JSON.parse(e.target.result);
        if (!Array.isArray(imported)) throw new Error('JSON должен быть массивом');
      } else {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) throw new Error('Пустой файл');
        const sep = lines[0].includes(';') ? ';' : ',';
        const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
        imported = lines.slice(1).map(line => {
          const vals = line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
          const obj = {};
          headers.forEach((h, i) => obj[h] = vals[i] || '');
          return obj;
        });
      }

      let added = 0;
      for (const item of imported) {
        const id = item.id || item.ID || '';
        const model = item.model || item['Модель'] || '';
        if (!id || !model) continue;
        try {
          await apiRequest('/pipettes', 'POST', {
            id: String(id).trim(),
            model: String(model).trim(),
            serial: item.serial || item['Серийный'] || '',
            manufacturer: item.manufacturer || item['Производитель'] || '',
            volume: String(item.volume || item['Объём'] || '').replace(' мкл', ''),
            department: item.department || item['Отдел'] || '',
            interval: parseInt(item.interval || item['МПИ'] || 12) || 12,
            lastCalibration: item.lastCalibration || item.last_calibration || item['Дата поверки'] || '',
            cert: item.cert || item['Свидетельство'] || '',
            result: item.result || item.lastResult || 'pass',
            active: item.active !== false && item.active !== 0 && item.active !== 'false',
            responsible: item.responsible || item['Ответственный'] || '',
            location: item.location || item['Место'] || '',
            notes: item.notes || item['Примечание'] || ''
          });
          added++;
        } catch (err) {
          console.warn('Пропущено:', id, err.message);
        }
      }
      await loadPipetteData();
      closeImportModal();
      showToast(`Импортировано записей: ${added}`, 'success');
    } catch (err) {
      showToast('Ошибка импорта: ' + err.message, 'error');
    }
  };
  reader.readAsText(file, 'UTF-8');
}


// ============================================================
// НАСТРОЙКИ
// ============================================================
function openSettingsModal() {
  if (!isAdmin()) { showToast('Доступно только администратору', 'error'); return; }
  document.getElementById('settings-modal').classList.add('active');
  switchSettingsTab('fields');
}
function closeSettingsModal() {
  document.getElementById('settings-modal').classList.remove('active');
}
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target.id === 'settings-modal') closeSettingsModal();
});

let _cachedFields = [];

async function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tabs .tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const c = document.getElementById('settings-content');
  c.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:20px;">Загрузка…</p>';

  if (tab === 'fields') await renderFieldsSettings();
  else if (tab === 'subdivisions') await renderSubdivisionsSettings();
  else if (tab === 'departments') await renderDepartmentsSettings();
  else if (tab === 'filters') await renderFiltersSettings();
  else if (tab === 'export') await renderExportSettings();
  else if (tab === 'users') await renderUsersSettings();
  else if (tab === 'system') await renderSystemSettings();
  else if (tab === 'log') await renderLogSettings();
  else if (tab === 'backup') await renderBackupSettings();
}

// ============================================================
// ВКЛАДКА: ПОЛЯ ФОРМЫ
// ============================================================
async function renderFieldsSettings() {
  const c = document.getElementById('settings-content');
  try {
    _cachedFields = await apiRequest('/settings/fields');
    let html = `
      <h3>Управление полями формы</h3>
      <p style="color:#64748b;margin-bottom:12px;">Включите/отключите поля, измените порядок, сделайте обязательными.</p>
      <table class="field-settings-table">
        <thead><tr>
          <th style="width:60px;">Порядок</th>
          <th>Название</th>
          <th style="width:120px;">Тип</th>
          <th style="width:80px;">Обяз.</th>
          <th style="width:80px;">Активно</th>
          <th>Список значений</th>
          <th style="width:60px;"></th>
        </tr></thead><tbody>`;

    _cachedFields.forEach((f, i) => {
      html += `<tr>
        <td><div class="order-btns">
          <button class="btn btn-secondary btn-sm" onclick="moveFieldSetting(${i},-1)">▲</button>
          <button class="btn btn-secondary btn-sm" onclick="moveFieldSetting(${i},1)">▼</button>
        </div></td>
        <td><input type="text" value="${esc(f.label)}" onchange="_cachedFields[${i}].label=this.value"></td>
        <td><select onchange="_cachedFields[${i}].type=this.value">
          <option value="text" ${f.type==='text'?'selected':''}>Текст</option>
          <option value="number" ${f.type==='number'?'selected':''}>Число</option>
          <option value="date" ${f.type==='date'?'selected':''}>Дата</option>
          <option value="select" ${f.type==='select'?'selected':''}>Список</option>
          <option value="textarea" ${f.type==='textarea'?'selected':''}>Текст. область</option>
        </select></td>
        <td style="text-align:center;"><input type="checkbox" ${f.required?'checked':''} onchange="_cachedFields[${i}].required=this.checked"></td>
        <td style="text-align:center;"><input type="checkbox" ${f.enabled?'checked':''} onchange="_cachedFields[${i}].enabled=this.checked"></td>
        <td>${f.type === 'select' 
          ? `<textarea rows="2" onchange="_cachedFields[${i}].options=this.value.split('\\n').map(s=>s.trim()).filter(Boolean)">${esc((f.options||[]).join('\n'))}</textarea>`
          : '—'}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteFieldSetting(${i})">🗑️</button></td>
      </tr>`;
    });
    html += `</tbody></table>
      <button class="btn btn-primary" onclick="addFieldSetting()" style="margin-top:12px;">➕ Добавить поле</button>
      <button class="btn btn-success" onclick="saveFieldsSettings()" style="margin-top:12px;margin-left:10px;">💾 Сохранить изменения</button>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

function moveFieldSetting(idx, dir) {
  const to = idx + dir;
  if (to < 0 || to >= _cachedFields.length) return;
  [_cachedFields[idx], _cachedFields[to]] = [_cachedFields[to], _cachedFields[idx]];
  _cachedFields.forEach((f, i) => f.order = i + 1);
  renderFieldsSettings();
}

function addFieldSetting() {
  const id = prompt('ID нового поля (латиницей, без пробелов):');
  if (!id || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id)) { showToast('Некорректный ID', 'error'); return; }
  if (_cachedFields.some(f => f.id === id)) { showToast('Поле с таким ID уже существует', 'error'); return; }
  _cachedFields.push({ id, label: id, type: 'text', required: false, enabled: true, options: [], default: '', order: _cachedFields.length + 1 });
  renderFieldsSettings();
}

function deleteFieldSetting(idx) {
  if (!confirm(`Удалить поле «${_cachedFields[idx].label}»?`)) return;
  _cachedFields.splice(idx, 1);
  _cachedFields.forEach((f, i) => f.order = i + 1);
  renderFieldsSettings();
}

async function saveFieldsSettings() {
  try {
    await apiRequest('/settings/fields', 'PUT', _cachedFields);
    showToast('Поля сохранены', 'success');
    closeSettingsModal();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ============================================================
// ВКЛАДКА: ОТДЕЛЫ
// ============================================================
async function renderDepartmentsSettings() {
  const c = document.getElementById('settings-content');
  try {
    _cachedDepartmentsFull = await apiRequest('/settings/departments-full');
    let html = `
      <h3>Управление отделами</h3>
      <p style="color:#64748b;margin-bottom:12px;">
        Отделы <strong>не удаляются</strong> — их можно только <strong>отключать</strong>.
      </p>
      <table class="field-settings-table">
        <thead><tr>
          <th style="width:60px;">Активно</th>
          <th>Название</th>
          <th style="width:100px;">Действия</th>
        </tr></thead><tbody>`;

    _cachedDepartmentsFull.forEach((d, i) => {
      html += `<tr>
        <td style="text-align:center;">
          <input type="checkbox" ${d.enabled ? 'checked' : ''} 
                 onchange="_cachedDepartmentsFull[${i}].enabled=this.checked">
        </td>
        <td><input type="text" value="${esc(d.name)}" 
                   onchange="_cachedDepartmentsFull[${i}].name=this.value"></td>
        <td><button class="btn btn-danger btn-sm btn-icon-only" 
                    onclick="deleteDepartmentItem(${i})" title="Удалить">
          <i class="fa-solid fa-trash"></i>
        </button></td>
      </tr>`;
    });
    html += `</tbody></table>
      <div style="margin-top:16px;display:flex;gap:10px;">
        <input type="text" id="new-dept-name" 
               placeholder="Название нового отдела" 
               style="flex:1;padding:9px 12px;border:1px solid #d1d5db;border-radius:8px;">
        <button class="btn btn-success" onclick="addDepartmentItem()">
          <i class="fa-solid fa-plus"></i> Добавить
        </button>
        <button class="btn btn-primary" onclick="saveDepartmentsFull()">
          <i class="fa-solid fa-floppy-disk"></i> Сохранить
        </button>
      </div>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

function addDepartmentItem() {
  const name = document.getElementById('new-dept-name').value.trim();
  if (!name) { showToast('Введите название', 'error'); return; }
  if (_cachedDepartmentsFull.some(d => d.name === name)) { showToast('Уже есть', 'error'); return; }
  _cachedDepartmentsFull.push({ name, enabled: true });
  renderDepartmentsSettings();
}

function deleteDepartmentItem(idx) {
  if (!confirm(`Удалить «${_cachedDepartmentsFull[idx].name}»?`)) return;
  _cachedDepartmentsFull.splice(idx, 1);
  renderDepartmentsSettings();
}

async function saveDepartmentsFull() {
  try {
    await apiRequest('/settings/departments', 'PUT', _cachedDepartmentsFull);
    showToast('Отделы сохранены', 'success');
    await loadDepartments();
    _filterRendered = false;
    closeSettingsModal();
  } catch (e) { showToast(e.message, 'error'); }
}
// ============================================================
// ВКЛАДКА: ПОДРАЗДЕЛЕНИЯ
// ============================================================
async function renderSubdivisionsSettings() {
  const c = document.getElementById('settings-content');
  try {
    _cachedSubdivisions = await apiRequest('/settings/subdivisions/all');
    let html = `
      <h3>Управление подразделениями</h3>
      <p style="color:#64748b;margin-bottom:12px;">
        Отключённые подразделения не показываются в формах и фильтрах.
      </p>
      <table class="field-settings-table">
        <thead><tr>
          <th style="width:60px;">Активно</th>
          <th>Название</th>
          <th style="width:100px;">Действия</th>
        </tr></thead><tbody>`;

    _cachedSubdivisions.forEach((s, i) => {
      html += `<tr>
        <td style="text-align:center;">
          <input type="checkbox" ${s.enabled ? 'checked' : ''}
                 onchange="_cachedSubdivisions[${i}].enabled=this.checked">
        </td>
        <td><input type="text" value="${esc(s.name)}"
                   onchange="_cachedSubdivisions[${i}].name=this.value"></td>
        <td><button class="btn btn-danger btn-sm btn-icon-only"
                    onclick="deleteSubdivision(${i})" title="Удалить">
          <i class="fa-solid fa-trash"></i>
        </button></td>
      </tr>`;
    });
    html += `</tbody></table>
      <div style="margin-top:16px;display:flex;gap:10px;">
        <input type="text" id="new-subdivision-name"
               placeholder="Название нового подразделения"
               style="flex:1;padding:9px 12px;border:1px solid #d1d5db;border-radius:8px;">
        <button class="btn btn-success" onclick="addSubdivision()">
          <i class="fa-solid fa-plus"></i> Добавить
        </button>
        <button class="btn btn-primary" onclick="saveSubdivisions()">
          <i class="fa-solid fa-floppy-disk"></i> Сохранить
        </button>
      </div>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

function addSubdivision() {
  const name = document.getElementById('new-subdivision-name').value.trim();
  if (!name) { showToast('Введите название', 'error'); return; }
  if (_cachedSubdivisions.some(s => s.name === name)) { showToast('Уже есть', 'error'); return; }
  _cachedSubdivisions.push({ name, enabled: true });
  renderSubdivisionsSettings();
}

function deleteSubdivision(idx) {
  if (!confirm(`Удалить «${_cachedSubdivisions[idx].name}»?`)) return;
  _cachedSubdivisions.splice(idx, 1);
  renderSubdivisionsSettings();
}

async function saveSubdivisions() {
  try {
    await apiRequest('/settings/subdivisions', 'PUT', _cachedSubdivisions);
    showToast('Подразделения сохранены', 'success');
    await loadSubdivisions();
    _filterRendered = false;
    closeSettingsModal();
  } catch (e) { showToast(e.message, 'error'); }
}
async function renderFiltersSettings() {
  const c = document.getElementById('settings-content');
  try {
    _cachedFilters = await apiRequest('/settings/filters');
    let html = `
      <h3>Управление фильтрами</h3>
      <p style="color:#64748b;margin-bottom:12px;">
        Включайте / отключайте фильтры и добавляйте новые.
      </p>
      <table class="field-settings-table">
     <thead><tr>
        <th style="width:60px;">Порядок</th>
        <th style="width:60px;">Активно</th>
        <th>Название</th>
        <th style="width:130px;">Тип</th>
        <th style="width:140px;">Источник</th>
         <th style="width:60px;"></th>
     </tr></thead><tbody>`;

    _cachedFilters.forEach((f, i) => {
      html += `<tr>
        <td>
          <div class="order-btns">
            <button class="btn btn-secondary btn-sm" onclick="moveFilter(${i},-1)">▲</button>
            <button class="btn btn-secondary btn-sm" onclick="moveFilter(${i},1)">▼</button>
          </div>
        </td>
        <td style="text-align:center;">
          <input type="checkbox" ${f.enabled ? 'checked' : ''} 
                 onchange="_cachedFilters[${i}].enabled=this.checked">
        </td>
           <td><input type="text" value="${esc(f.label)}" 
           onchange="_cachedFilters[${i}].label=this.value"></td>
        <td>
          <select onchange="_cachedFilters[${i}].type=this.value">
            <option value="text" ${f.type==='text'?'selected':''}>Текст</option>
            <option value="select" ${f.type==='select'?'selected':''}>Список</option>
            <option value="date-period" ${f.type==='date-period'?'selected':''}>Период дат</option>
          </select>
        </td>
        <td>
          <select onchange="_cachedFilters[${i}].optionsSource=this.value">
            <option value="" ${!f.optionsSource?'selected':''}>—</option>
            <option value="subdivisions" ${f.optionsSource==='subdivisions'?'selected':''}>Подразделения</option>
            <option value="departments" ${f.optionsSource==='departments'?'selected':''}>Отделы</option>
            <option value="status_list" ${f.optionsSource==='status_list'?'selected':''}>Статусы</option>
            <option value="active_list" ${f.optionsSource==='active_list'?'selected':''}>Активность</option>
          </select>
        </td>
        <td><button class="btn btn-danger btn-sm btn-icon-only" 
                    onclick="deleteFilter(${i})" title="Удалить">
          <i class="fa-solid fa-trash"></i>
        </button></td>
      </tr>`;
    });
    html += `</tbody></table>
      <button class="btn btn-primary" onclick="addFilter()" style="margin-top:12px;">
        <i class="fa-solid fa-plus"></i> Добавить фильтр
      </button>
      <button class="btn btn-success" onclick="saveFilters()" style="margin-top:12px;margin-left:10px;">
        <i class="fa-solid fa-floppy-disk"></i> Сохранить
      </button>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

function moveFilter(idx, dir) {
  const to = idx + dir;
  if (to < 0 || to >= _cachedFilters.length) return;
  [_cachedFilters[idx], _cachedFilters[to]] = [_cachedFilters[to], _cachedFilters[idx]];
  _cachedFilters.forEach((f, i) => f.order = i + 1);
  renderFiltersSettings();
}
function addFilter() {
  const id = prompt('ID нового фильтра (латиницей):');
  if (!id || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id)) { showToast('Некорректный ID', 'error'); return; }
  if (_cachedFilters.some(f => f.id === id)) { showToast('Уже есть', 'error'); return; }
  _cachedFilters.push({
    id,
    label: id,
    type: 'text',
    fieldId: '',
    enabled: true,
    optionsSource: '',
    order: _cachedFilters.length + 1
  });
  renderFiltersSettings();
}

function deleteFilter(idx) {
  if (!confirm(`Удалить фильтр «${_cachedFilters[idx].label}»?`)) return;
  _cachedFilters.splice(idx, 1);
  _cachedFilters.forEach((f, i) => f.order = i + 1);
  renderFiltersSettings();
}

async function saveFilters() {
  try {
    await apiRequest('/settings/filters', 'PUT', _cachedFilters);
    showToast('Фильтры сохранены', 'success');
    await loadFilterConfig();
    _filterRendered = false;
    closeSettingsModal();
  } catch (e) { showToast(e.message, 'error'); }
}

// ============================================================
// ВКЛАДКА: ЭКСПОРТ
// ============================================================
const EXPORT_FIELDS = [
  { id: 'id', label: 'Внутренний номер' },
  { id: 'serial', label: 'Серийный номер' },
  { id: 'manufacturer', label: 'Производитель' },
  { id: 'model', label: 'Модель' },
  { id: 'volume', label: 'Объём (мкл)' },
  { id: 'department', label: 'Отдел' },
  { id: 'lastCalibration', label: 'Дата поверки' },
  { id: 'nextCalibration', label: 'Следующая поверка' },
  { id: 'interval', label: 'МПИ (мес.)' },
  { id: 'daysLeft', label: 'Дней до поверки' },
  { id: 'responsible', label: 'Ответственный' },
  { id: 'location', label: 'Место хранения' },
  { id: 'status', label: 'Статус' },
  { id: 'cert', label: 'Свидетельство' },
  { id: 'notes', label: 'Примечание' }
];


async function renderExportSettings() {
  const c = document.getElementById('settings-content');
  try {
    const selected = await apiRequest('/settings/export');
    let html = `<h3>Настройки экспорта</h3>
      <p style="color:#64748b;margin-bottom:12px;">Выберите поля для PDF/Excel</p>
      <div class="export-fields-grid">`;
    EXPORT_FIELDS.forEach(f => {
      html += `<label><input type="checkbox" value="${f.id}" ${selected.includes(f.id) ? 'checked' : ''} class="exp-field-cb"> ${f.label}</label>`;
    });
    html += `</div><button class="btn btn-success" onclick="saveExportSettings()">💾 Сохранить</button>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

async function saveExportSettings() {
  const selected = Array.from(document.querySelectorAll('.exp-field-cb:checked')).map(cb => cb.value);
  try {
    await apiRequest('/settings/export', 'PUT', selected);
    showToast('Настройки экспорта сохранены', 'success');
    closeSettingsModal();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ============================================================
// ВКЛАДКА: ПОЛЬЗОВАТЕЛИ
// ============================================================
async function renderUsersSettings() {
  const c = document.getElementById('settings-content');
  try {
    const users = await apiRequest('/users');
    const roleLabels = { user: 'Пользователь', senior_lab: 'Ст. лаборант', admin: 'Администратор' };
    const curId = currentUser.id;

    let html = '<h3>Управление пользователями</h3>';
    html += `<table class="field-settings-table" style="margin-bottom:20px;"><thead><tr>
      <th>Логин</th><th>ФИО</th><th>Должность</th><th>Отдел</th><th>Роль</th><th>Действия</th>
    </tr></thead><tbody>`;

    users.forEach(u => {
      html += `<tr>
        <td>${esc(u.login)}</td>
        <td>${esc(u.fullName || u.full_name)}</td>
        <td>${esc(u.position)}</td>
        <td>${esc(u.department || '—')}</td>
        <td>${roleLabels[u.role] || u.role}</td>
        <td class="actions">
          <button class="btn btn-secondary btn-sm" onclick="editUserSetting('${u.id}')">✏️</button>
          ${u.id !== curId ? `<button class="btn btn-info btn-sm" onclick="impersonateUser('${u.id}')" title="Войти под этим пользователем">🔍 Войти как</button>` : ''}
          ${u.id !== curId ? `<button class="btn btn-danger btn-sm" onclick="deleteUserSetting('${u.id}')">🗑️</button>` : ''}
        </td>
      </tr>`;
    });
    html += `</tbody></table>
      <div class="settings-form">
        <h4 id="user-form-title">➕ Добавить пользователя</h4>
        <input type="hidden" id="usr-edit-id">
        <div class="form-row">
          <div class="form-group"><label>Логин *</label><input id="usr-login"></div>
          <div class="form-group"><label>Пароль</label><input id="usr-password" placeholder="оставьте пустым при редактировании"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>ФИО *</label><input id="usr-fullname"></div>
          <div class="form-group"><label>Должность *</label><input id="usr-position"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Отдел</label><input id="usr-department"></div>
          <div class="form-group"><label>Роль</label>
            <select id="usr-role" onchange="onUserRoleChange(this.value)">
              <option value="user">Пользователь</option>
              <option value="senior_lab">Старший лаборант</option>
              <option value="admin">Администратор</option>
            </select>
          </div>
        </div>
            <!-- Блок прав доступа -->
    <div class="form-group">
      <label>Права доступа (влияют на видимость кнопок)</label>
      <div class="permissions-group" id="usr-permissions">
        <label>
          <input type="checkbox" value="manage_pipettes">
          ➕ Управление пипетками
        </label>
        <label>
          <input type="checkbox" value="import_data">
          📥 Импорт данных
        </label>
        <label>
          <input type="checkbox" value="export_data">
          📤 Экспорт данных
        </label>
      </div>
      <small style="color:#64748b;display:block;margin-top:8px;">
        Для администратора все права включены автоматически.
      </small>
    </div>
    <!-- Ограничение по отделу -->
    <div class="form-group" style="background:#fef9c3;padding:12px;border-radius:8px;border-left:3px solid #eab308;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;color:#854d0e;">
        <input type="checkbox" id="usr-only-own-dept" style="width:18px;height:18px;cursor:pointer;">
        <i class="fa-solid fa-eye-slash"></i>
        Показывать только свой отдел
      </label>
      <small style="color:#92400e;display:block;margin-top:6px;margin-left:26px;">
        Если включено — пользователь увидит <strong>только пипетки своего отдела</strong>.<br>
        Если выключено (по умолчанию) — увидит <strong>все пипетки</strong>.
      </small>
    </div>
        <div class="form-actions" style="justify-content:flex-start;">
          <button class="btn btn-success" onclick="saveUserSetting()">💾 Сохранить</button>
          <button class="btn btn-secondary" onclick="resetUserSettingForm()">Отмена</button>
        </div>
      </div>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}
function onUserRoleChange(role) {
  const checkboxes = document.querySelectorAll('#usr-permissions input[type="checkbox"]');
  checkboxes.forEach(cb => {
    if (role === 'admin') {
      cb.checked = true;
      cb.disabled = true;
    
    } else {
      cb.disabled = false;
      cb.checked = false;
    }
  });
}
function resetUserSettingForm() {
  ['usr-edit-id','usr-login','usr-password','usr-fullname','usr-position','usr-department'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('usr-role').value = 'user';
  document.getElementById('user-form-title').textContent = '➕ Добавить пользователя';
  const onlyOwnCb = document.getElementById('usr-only-own-dept');
  if (onlyOwnCb) onlyOwnCb.checked = false;
  // Сброс чекбоксов
  document.querySelectorAll('#usr-permissions input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
    cb.disabled = false;
  });
}

async function editUserSetting(id) {
  try {
    const users = await apiRequest('/users');
    const u = users.find(x => x.id === id);
    if (!u) return;

    document.getElementById('usr-edit-id').value = u.id;
    document.getElementById('usr-login').value = u.login;
    document.getElementById('usr-password').value = '';
    document.getElementById('usr-fullname').value = u.fullName || u.full_name;
    document.getElementById('usr-position').value = u.position;
    document.getElementById('usr-department').value = u.department || '';
    document.getElementById('usr-role').value = u.role;
    document.getElementById('user-form-title').textContent = '✏️ Редактирование: ' + u.login;

    // ▼▼▼ ГАЛОЧКА «ТОЛЬКО СВОЙ ОТДЕЛ» ▼▼▼
    const onlyOwnCb = document.getElementById('usr-only-own-dept');
    if (onlyOwnCb) onlyOwnCb.checked = !!u.onlyOwnDepartment;
    
    // ▼▼▼ ЗАПОЛНЯЕМ ЧЕКБОКСЫ ПРАВ ▼▼▼
        const extra = u.extraPermissions || [];

    document.querySelectorAll('#usr-permissions input[type="checkbox"]').forEach(cb => {
      if (u.role === 'admin') {
        cb.checked = true;
        cb.disabled = true;
      } else {
        cb.disabled = false;
        cb.checked = extra.includes(cb.value);
      }
    });

    document.getElementById('user-form-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveUserSetting() {
  const id = document.getElementById('usr-edit-id').value;
  const login = document.getElementById('usr-login').value.trim();
  const password = document.getElementById('usr-password').value.trim();
  const fullName = document.getElementById('usr-fullname').value.trim();
  const position = document.getElementById('usr-position').value.trim();
  const department = document.getElementById('usr-department').value.trim();
  const role = document.getElementById('usr-role').value;

  if (!login || !fullName || !position) { showToast('Заполните поля', 'error'); return; }
  if (!id && !password) { showToast('Укажите пароль для нового пользователя', 'error'); return; }

  const onlyOwnCb = document.getElementById('usr-only-own-dept');
  const onlyOwnDepartment = onlyOwnCb ? onlyOwnCb.checked : false;

  const extraPermissions = [];
  if (role !== 'admin') {
    document.querySelectorAll('#usr-permissions input[type="checkbox"]:checked').forEach(cb => {
      extraPermissions.push(cb.value);
    });
  }

  try {
    const payload = { login, password, fullName, position, department, role, onlyOwnDepartment, extraPermissions };

    if (id) {
      await apiRequest('/users/' + id, 'PUT', payload);
      showToast('Пользователь обновлён', 'success');
    } else {
      await apiRequest('/users', 'POST', payload);
      showToast('Пользователь создан', 'success');
    }

    if (id === currentUser.id) {
      const me = (await apiRequest('/users')).find(x => x.id === id);
      if (me) {
        currentUser.fullName = me.fullName || me.full_name;
        currentUser.position = me.position;
        currentUser.department = me.department;
        currentUser.role = me.role;
        currentUser.onlyOwnDepartment = !!me.onlyOwnDepartment;
        currentUser.extraPermissions = me.extraPermissions || [];
        setSession(currentUser, authToken);
        renderAuthUI();
      }
    }

    closeSettingsModal();
  } catch (e) { showToast(e.message, 'error'); }
}
async function deleteUserSetting(id) {
  if (!confirm('Удалить пользователя?')) return;
  try {
    await apiRequest('/users/' + id, 'DELETE');
    showToast('Удалён', 'success');
    renderUsersSettings();
  } catch (e) { showToast(e.message, 'error'); }
}

// ============================================================
// ВКЛАДКА: СИСТЕМА
// ============================================================
async function renderSystemSettings() {
  const c = document.getElementById('settings-content');
  try {
    const s = await apiRequest('/settings/system');
    c.innerHTML = `<h3>Системные настройки</h3>
      <div class="settings-form">
        <div class="form-group">
          <label>Порог предупреждения о поверке (дней)</label>
          <input type="number" id="sys-warn-days" value="${esc(s.warn_days || '30')}" min="1" max="365">
        </div>
        <button class="btn btn-success" onclick="saveSystemSetting()">💾 Сохранить</button>
      </div>`;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

async function saveSystemSetting() {
  const wd = document.getElementById('sys-warn-days').value;
  try {
    await apiRequest('/settings/system', 'PUT', { warn_days: String(wd) });
    settings.warnDays = parseInt(wd) || 30;
    showToast('Настройки сохранены', 'success');
    closeSettingsModal();
    render();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ============================================================
// ВКЛАДКА: ЛОГ
// ============================================================
async function renderLogSettings() {
  const c = document.getElementById('settings-content');
  try {
    const logs = await apiRequest('/log?limit=200');
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3>Журнал действий (${logs.length})</h3>
      <button class="btn btn-danger btn-sm" onclick="clearLogSetting()">🗑️ Очистить</button>
    </div>
    <div class="log-container"><table class="log-table">
      <thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Детали</th></tr></thead><tbody>`;
    if (!logs.length) {
      html += '<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8;">Пусто</td></tr>';
    } else {
      for (const l of logs) {
        html += `<tr>
          <td class="timestamp">${new Date(l.timestamp).toLocaleString('ru-RU')}</td>
          <td class="user">${esc(l.user_full_name)}</td>
          <td class="action">${esc(l.action)}</td>
          <td>${esc(l.details || '')}</td>
        </tr>`;
      }
    }
    html += '</tbody></table></div>';
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

async function clearLogSetting() {
  if (!confirm('Очистить журнал?')) return;
  await apiRequest('/log', 'DELETE');
  showToast('Журнал очищен', 'success');
  renderLogSettings();
}

// ============================================================
// ВКЛАДКА: БЭКАП
// ============================================================
async function renderBackupSettings() {
  const c = document.getElementById('settings-content');
  try {
    const backups = await apiRequest('/backup');
    let html = `<h3>Резервные копии</h3>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0;">
        <button class="btn btn-warning" onclick="createBackupSetting()">💾 Создать бэкап</button>
        <button class="btn btn-secondary" onclick="openBackupList()">🔄 Восстановить</button>
        <button class="btn btn-danger" onclick="resetAllDataSetting()">🗑️ Сбросить данные</button>
      </div>
      <h4 style="margin-top:20px;">Доступные бэкапы (${backups.length})</h4>
      <div>`;
    if (!backups.length) {
      html += '<p style="color:#94a3b8;">Нет бэкапов</p>';
    } else {
      backups.forEach(b => {
        html += `<div class="dept-item">
          <span class="dept-name">📁 ${esc(b.name)} (${(b.size/1024).toFixed(1)} KB)</span>
          <div class="dept-actions">
            <a class="btn btn-secondary btn-sm" href="/api/backup/download/${esc(b.name)}" download>⬇️</a>
            <button class="btn btn-danger btn-sm" onclick="deleteBackupSetting('${esc(b.name)}')">🗑️</button>
          </div>
        </div>`;
      });
    }
    html += `</div>`;
    c.innerHTML = html;
  } catch (e) {
    c.innerHTML = '<p style="color:#dc2626;">Ошибка: ' + e.message + '</p>';
  }
}

async function createBackupSetting() {
  try {
    await apiRequest('/backup', 'POST', {});
    showToast('Бэкап создан', 'success');
    renderBackupSettings();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteBackupSetting(name) {
  if (!confirm('Удалить бэкап?')) return;
  await apiRequest('/backup/' + encodeURIComponent(name), 'DELETE');
  showToast('Удалён', 'success');
  renderBackupSettings();
}

async function resetAllDataSetting() {
  if (!confirm('Удалить ВСЕ пипетки и историю? Это необратимо!')) return;
  if (!confirm('Точно?')) return;
  await apiRequest('/backup/reset', 'POST', {});
  showToast('Данные удалены', 'success');
  await loadPipetteData();
  closeSettingsModal();
}

async function openBackupList() {
  const c = document.getElementById('backup-list-container');
  try {
    const backups = await apiRequest('/backup');
    if (!backups.length) { showToast('Нет бэкапов', 'error'); return; }
    c.innerHTML = '<p style="color:#64748b;">Выберите бэкап для восстановления:</p>';
    backups.forEach(b => {
      c.innerHTML += `<div class="dept-item">
        <span class="dept-name">📁 ${esc(b.name)} (${(b.size/1024).toFixed(1)} KB)</span>
        <button class="btn btn-success btn-sm" onclick="doRestoreSetting('${esc(b.name)}')">Восстановить</button>
      </div>`;
    });
    document.getElementById('backup-modal').classList.add('active');
  } catch (e) { showToast(e.message, 'error'); }
}

async function doRestoreSetting(name) {
  if (!confirm('Восстановить из этого бэкапа? Текущие данные будут потеряны.')) return;
  try {
    const r = await apiRequest('/backup/restore/' + encodeURIComponent(name), 'POST', {});
    showToast('Бэкап восстановлен. Перезапустите приложение.', 'success');
    closeBackupModal();
  } catch (e) { showToast(e.message, 'error'); }
}

function closeBackupModal() {
  document.getElementById('backup-modal').classList.remove('active');
}
document.getElementById('backup-modal').addEventListener('click', e => {
  if (e.target.id === 'backup-modal') closeBackupModal();
});

console.log('🔬 Система учёта пипеток запущена');
console.log('👤 admin/admin, senior/senior, user/user');
