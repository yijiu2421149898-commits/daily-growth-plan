
'use strict';

/* ==================== 一、Supabase 配置（部署前替换） ==================== */
const SUPABASE_URL = "https://pvuykhguhzhbzumumfou.supabase.co"
const SUPABASE_ANON_KEY = "sb_publishable_a8P6p8OvjN9UFaT2Yi3ong_ozdIY-bX"

/* ==================== 二、常量与全局状态 ==================== */

// 心情选项：mood 字段存中文标签，展示时映射表情
const MOODS = [
  { emoji: '😊', label: '愉悦' },
  { emoji: '😌', label: '平静' },
  { emoji: '😔', label: '低落' },
  { emoji: '😤', label: '烦躁' },
  { emoji: '🥱', label: '疲惫' },
];

// Todo 优先级对应的左侧色条颜色
const PRIORITY_COLORS = { '高': 'var(--accent)', '中': 'var(--celadon)', '低': 'var(--faint)' };

const THEME_KEY = 'dgp-theme';
const STATUS_DELAY = 1000;   // 每日状态：输入后 1 秒自动保存
const DIARY_DELAY = 1500;    // 日记：输入后 1.5 秒自动保存

const state = {
  user: null,            // 当前登录用户（Supabase auth user）
  isAdmin: false,        // 由 raw_user_meta_data.is_admin 判断
  date: todayStr(),      // 当前选中日期 YYYY-MM-DD
  viewYear: 0,           // 日历当前展示年份
  viewMonth: 0,          // 日历当前展示月份（0-11）
  markedDates: new Map(),// 日历圆点：日期 -> { s: 状态, t: 待办, d: 日记 }
  todos: [],             // 当前日期的待办列表
  completedOpen: false,  // 已完成列表展开/收起
  statusId: null,        // 当前日期 daily_status 记录 id（有则更新，无则插入）
  diaryId: null,         // 当前日期 diary 记录 id
  diaryRow: null,        // 当前日期 diary 整行（供分类模块读取 category_ids）
  diaryCategories: [],   // 日记分类列表（供日历圆点着色）
  mood: '',              // 当前选中的心情
  statusTimer: null, statusDirty: false,
  diaryTimer: null, diaryDirty: false,
  adminUser: null,       // 管理员专区当前选中的用户 { id, email }
};

let sb = null;           // Supabase 客户端
let toastTimer = null;
let pendingClear = null; // 清空确认弹窗上下文 { userId, label }
let adminCategoryMap = new Map(); // 管理员查看记录时的分类映射 id -> { name, color }

/* ==================== 三、工具函数 ==================== */

const $ = (id) => document.getElementById(id);

// 本地时区的当天日期（YYYY-MM-DD）
function todayStr() {
  return formatDate(new Date());
}
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// 解析 YYYY-MM-DD 为本地 Date（避免时区偏移）
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// 周几的中文表示
function weekCN(d) { return '周' + '日一二三四五六'[d.getDay()]; }

// 防 XSS：渲染用户内容前转义
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 把 Supabase 错误转为温和的中文提示
function friendlyErr(err) {
  const msg = (err && (err.message || err.error_description)) || '';
  const m = msg.toLowerCase();
  if (m.includes('failed to fetch') || m.includes('network')) return '网络异常';
  if (m.includes('row-level security') || m.includes('permission')) return '没有操作权限';
  if (m.includes('jwt')) return '登录状态已过期，请重新登录';
  return msg ? msg.slice(0, 80) : '';
}
function authErrorToCN(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login credentials')) return '邮箱或密码不正确，请核对后重试';
  if (m.includes('email not confirmed')) return '邮箱尚未完成验证，请联系管理员';
  if (m.includes('too many requests')) return '尝试次数过多，请稍后再试';
  if (m.includes('failed to fetch') || m.includes('network')) return '网络异常，请检查网络后重试';
  if (m.includes('invalid api key') || m.includes('supabase url')) return '站点尚未配置 Supabase 连接信息，请联系管理员';
  return '登录失败，请稍后重试';
}

// 轻提示（底部浮现，不打断操作）
function showToast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', type === 'error');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// 卡片内保存状态文字
function setHint(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'save-hint' + (kind === 'saving' ? ' hint-saving' : kind === 'err' ? ' hint-err' : '');
}
const setStatusHint = (t, k) => setHint('status-hint', t, k);
const setDiaryHint = (t, k) => setHint('diary-hint', t, k);

/**
 * 模块间解耦通信：主逻辑通过自定义事件通知各功能模块
 * 事件名统一为 dgp:<name>，detail 携带上下文数据
 */
function emit(name, detail) {
  try {
    document.dispatchEvent(new CustomEvent('dgp:' + name, { detail: detail || {} }));
  } catch (e) { /* 忽略事件派发异常 */ }
}

/* ==================== 四、初始化与视图切换 ==================== */

document.addEventListener('DOMContentLoaded', init);

function init() {
  initTheme();
  renderMoodButtons();
  bindEvents();

  // 校验 Supabase 配置是否已替换占位符
  const configured = typeof supabase !== 'undefined'
    && !SUPABASE_URL.includes('YOUR_PROJECT')
    && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';
  if (!configured) {
    showView('login');
    setLoginError('站点尚未配置 Supabase 连接信息（app.js 顶部），请联系管理员。');
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // 恢复会话：刷新页面保持登录
  sb.auth.getSession().then(({ data }) => {
    if (data && data.session) enterBoard(data.session.user);
    else showView('login');
  });

  // 监听会话变化：登录进入看板 / 退出返回登录页
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') resetToLogin();
    else if (session && event === 'SIGNED_IN' && !state.user) enterBoard(session.user);
  });
}

function showView(name) {
  $('view-login').classList.toggle('hidden', name !== 'login');
  $('view-board').classList.toggle('hidden', name !== 'board');
}

// 登录成功后进入主看板
function enterBoard(user) {
  state.user = user;
  state.isAdmin = !!(user.user_metadata && user.user_metadata.is_admin);
  state.date = todayStr();
  const now = new Date();
  state.viewYear = now.getFullYear();
  state.viewMonth = now.getMonth();

  $('nav-user').textContent = user.email || '';
  $('btn-admin').classList.toggle('hidden', !state.isAdmin);

  showView('board');
  updateDateLabel();
  renderCalendar();
  refreshMarks();      // 日历圆点
  loadAllDayData();    // 三个模块并行加载当天数据
  emit('board-enter'); // 通知扩展模块（分类 / 习惯 / 目标 / 复盘）初始化
}

// 退出登录 / 会话失效后回到登录页
function resetToLogin() {
  state.user = null;
  state.isAdmin = false;
  state.todos = [];
  state.markedDates = new Map();
  state.statusId = null;
  state.diaryId = null;
  state.diaryRow = null;
  state.diaryCategories = [];
  state.mood = '';
  state.completedOpen = false;

  emit('board-exit');   // 通知扩展模块清理自身状态

  $('nav-user').textContent = '';
  $('btn-admin').classList.add('hidden');
  $('status-content').value = '';
  $('diary-content').value = '';
  $('todo-list').innerHTML = '';
  $('todo-done-list').innerHTML = '';
  $('todo-done-wrap').classList.add('hidden');
  $('todo-empty').classList.remove('hidden');
  $('todo-count').textContent = '';
  $('login-password').value = '';
  setStatusHint('');
  setDiaryHint('');
  updateMoodActive();
  updateStatusCount();

  $('admin-modal').classList.add('hidden');
  $('confirm-modal').classList.add('hidden');
  showView('login');
}

/* ==================== 五、主题切换（4 套） ==================== */

const THEMES = ['cream', 'night', 'mint', 'slate'];

function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式忽略 */ }
  if (t === 'dark' || t === 'ocean') t = 'night';                  // 兼容旧版取值
  if (!THEMES.includes(t)) t = 'cream';
  applyTheme(t, false);
}

// 应用主题：写 data-theme + 记忆到 localStorage
function applyTheme(name, persist = true) {
  if (!THEMES.includes(name)) name = 'cream';
  document.documentElement.setAttribute('data-theme', name);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* 忽略 */ }
  }
  document.querySelectorAll('[data-set-theme]').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.setTheme === name));
}

// 打开 / 收起主题面板
function toggleThemeMenu(force) {
  const menu = $('theme-menu');
  const btn = $('btn-theme');
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
}

// 打开 / 收起导出菜单
function toggleExportMenu(force) {
  const menu = $('export-menu');
  const btn = $('btn-export');
  if (!menu || !btn) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
}

/* ==================== 六、登录 / 退出 ==================== */

async function onLoginSubmit(e) {
  e.preventDefault();
  // 未配置 Supabase 时客户端未建立，直接给出明确提示
  if (!sb) {
    setLoginError('尚未配置 Supabase 连接信息：请先替换 app.js 顶部的 SUPABASE_URL 与 SUPABASE_ANON_KEY。');
    return;
  }
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) { setLoginError('请输入邮箱和密码'); return; }

  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = '登录中…';
  setLoginError('');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) setLoginError(authErrorToCN(error.message));
    // 成功后由 onAuthStateChange 自动进入看板
  } catch (err) {
    // 显示底层原因，便于排查（如 Failed to fetch / 域名错误）
    const detail = (err && err.message) || '';
    setLoginError('连接 Supabase 失败，请检查 URL 是否正确、项目是否已启用' + (detail ? `（${detail.slice(0, 60)}）` : ''));
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
}

function setLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

async function onLogout() {
  try { await flushPendingSaves(); } catch (e) { /* 保存失败不阻塞退出 */ }
  if (sb) await sb.auth.signOut();  // 触发 SIGNED_OUT → resetToLogin
  resetToLogin();
}

/* ==================== 七、模块1：每日状态记录 ==================== */

// 渲染五个心情按钮
function renderMoodButtons() {
  const group = $('mood-group');
  group.innerHTML = MOODS.map((m) =>
    `<button type="button" class="mood-btn" data-mood="${m.label}">
       <span class="em">${m.emoji}</span><span>${m.label}</span>
     </button>`
  ).join('');
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.mood-btn');
    if (!btn || !state.user) return;
    state.mood = btn.dataset.mood;
    updateMoodActive();
    markStatusDirty();
  });
}

function updateMoodActive() {
  document.querySelectorAll('.mood-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mood === state.mood));
}

function updateStatusCount() {
  $('status-count').textContent = `${$('status-content').value.length} / 300`;
}

// 输入/选心情后进入“待保存”状态，1 秒后自动提交
function markStatusDirty() {
  state.statusDirty = true;
  setStatusHint('保存中…', 'saving');
  clearTimeout(state.statusTimer);
  state.statusTimer = setTimeout(saveDailyStatus, STATUS_DELAY);
  updateStatusCount();
}

// 保存每日状态：有记录则更新，无则插入
async function saveDailyStatus() {
  clearTimeout(state.statusTimer);
  state.statusTimer = null;
  if (!state.statusDirty || !sb || !state.user) return;

  const content = $('status-content').value;
  const mood = state.mood || null;
  // 全空且尚无记录时不产生空数据
  if (!state.statusId && !mood && !content) { setStatusHint(''); state.statusDirty = false; return; }

  state.statusDirty = false;
  setStatusHint('保存中…', 'saving');
  try {
    if (state.statusId) {
      const { error } = await sb.from('daily_status')
        .update({ mood, content, updated_at: new Date().toISOString() })
        .eq('id', state.statusId);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('daily_status')
        .insert({ user_id: state.user.id, record_date: state.date, mood, content })
        .select('id')
        .single();
      if (error) throw error;
      state.statusId = data.id;
    }
    setStatusHint('已保存', 'ok');
    refreshMarks();
  } catch (err) {
    state.statusDirty = true; // 保留脏标记，便于下次重试
    setStatusHint('保存失败，请重试', 'err');
  }
}

// 加载某天状态并回填
async function loadDailyStatus() {
  $('status-loading').classList.remove('hidden');
  try {
    const { data, error } = await sb.from('daily_status')
      .select('*')
      .eq('user_id', state.user.id)
      .eq('record_date', state.date)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw error;
    const row = data && data[0];
    state.statusId = row ? row.id : null;
    state.mood = (row && row.mood) || '';
    $('status-content').value = (row && row.content) || '';
    updateMoodActive();
    updateStatusCount();
    setStatusHint(row ? '已保存' : '');
  } catch (err) {
    setStatusHint('加载失败', 'err');
  } finally {
    $('status-loading').classList.add('hidden');
  }
}

/* ==================== 八、模块2：Todo 待办清单 ==================== */

async function loadTodos() {
  $('todo-loading').classList.remove('hidden');
  try {
    // 优先按手动排序字段读取；若数据库尚未执行升级脚本则自动回退
    let res = await sb.from('todos')
      .select('*')
      .eq('user_id', state.user.id)
      .eq('record_date', state.date)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (res.error && /sort_order/i.test(res.error.message || '')) {
      res = await sb.from('todos')
        .select('*')
        .eq('user_id', state.user.id)
        .eq('record_date', state.date)
        .order('created_at', { ascending: true });
    }
    if (res.error) throw res.error;
    state.todos = res.data || [];
    renderTodos();
  } catch (err) {
    state.todos = [];
    renderTodos();
    showToast('待办加载失败，请稍后重试', 'error');
  } finally {
    $('todo-loading').classList.add('hidden');
  }
}

// 渲染：未完成在上，已完成折叠收起
function renderTodos() {
  const pending = state.todos.filter((t) => !t.is_completed);
  const done = state.todos.filter((t) => t.is_completed);

  $('todo-list').innerHTML = pending.map(todoItemHTML).join('');
  $('todo-empty').classList.toggle('hidden', pending.length > 0);
  $('todo-count').textContent = pending.length ? `${pending.length} 项待完成` : '';

  const wrap = $('todo-done-wrap');
  wrap.classList.toggle('hidden', done.length === 0);
  $('todo-done-list').innerHTML = done.map(todoItemHTML).join('');
  $('todo-done-list').classList.toggle('hidden', !state.completedOpen);
  $('todo-done-toggle').textContent = state.completedOpen
    ? '收起已完成'
    : `查看已完成（${done.length}）`;
}

function todoItemHTML(t) {
  const color = PRIORITY_COLORS[t.priority] || PRIORITY_COLORS['中'];
  // 触屏端没有 HTML5 拖拽，提供上移 / 下移按钮（桌面端由 CSS 隐藏）
  const moveBtns = t.is_completed ? '' : `
      <span class="todo-move">
        <button type="button" data-act="up" title="上移" aria-label="上移">↑</button>
        <button type="button" data-act="down" title="下移" aria-label="下移">↓</button>
      </span>`;
  return `<li class="todo-item ${t.is_completed ? 'done' : ''}" style="border-left-color:${color}"
              data-id="${t.id}" draggable="${t.is_completed ? 'false' : 'true'}">
      <span class="todo-handle" title="拖拽排序" aria-hidden="true">⋮⋮</span>
      <input type="checkbox" ${t.is_completed ? 'checked' : ''} data-act="toggle" />
      <span class="todo-title">${escapeHTML(t.title)}</span>
      <span class="text-[11px] text-faint shrink-0">${escapeHTML(t.priority || '')}</span>
      ${moveBtns}
      <button class="todo-del" data-act="del" type="button" title="删除">✕</button>
    </li>`;
}

async function addTodo() {
  if (!sb || !state.user) return;
  const input = $('todo-input');
  const title = input.value.trim();
  if (!title) { showToast('请先填写待办内容'); input.focus(); return; }

  const btn = $('todo-add');
  btn.disabled = true;
  try {
    // 新待办排在当前列表末尾
    const maxOrder = state.todos.reduce((m, t) => Math.max(m, Number(t.sort_order) || 0), 0);
    const payload = {
      user_id: state.user.id,
      record_date: state.date,
      title,
      priority: $('todo-priority').value,
      is_completed: false,
      sort_order: maxOrder + 1,
    };
    let res = await sb.from('todos').insert(payload);
    // 数据库尚未执行升级脚本时不带排序字段重试，保证原有功能可用
    if (res.error && /sort_order/i.test(res.error.message || '')) {
      delete payload.sort_order;
      res = await sb.from('todos').insert(payload);
    }
    if (res.error) throw res.error;
    input.value = '';
    await loadTodos();
    refreshMarks();
    emit('todos-change');
  } catch (err) {
    showToast('添加失败：' + (friendlyErr(err) || '请稍后重试'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggleTodo(id) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return;
  try {
    const { error } = await sb.from('todos')
      .update({ is_completed: !t.is_completed, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    t.is_completed = !t.is_completed;
    renderTodos();
    refreshMarks();
    emit('todos-change');
  } catch (err) {
    showToast('操作失败，请重试', 'error');
  }
}

async function deleteTodo(id) {
  try {
    const { error } = await sb.from('todos').delete().eq('id', id);
    if (error) throw error;
    state.todos = state.todos.filter((x) => x.id !== id);
    renderTodos();
    refreshMarks();
    emit('todos-change');
  } catch (err) {
    showToast('删除失败，请重试', 'error');
  }
}

/**
 * 拖拽排序：把 dragId 移动到 targetId 之前 / 之后
 * @param {string} dragId   被拖动的待办 id
 * @param {string} targetId 目标待办 id
 * @param {boolean} after   true=放到目标之后，false=放到目标之前
 */
async function reorderTodo(dragId, targetId, after) {
  const pending = state.todos.filter((t) => !t.is_completed);
  const from = pending.findIndex((t) => t.id === dragId);
  if (from < 0) return;

  const arr = pending.slice();
  const [moved] = arr.splice(from, 1);
  let idx = arr.findIndex((t) => t.id === targetId);
  if (idx < 0) return;
  arr.splice(after ? idx + 1 : idx, 0, moved);

  // 本地先行更新，保证拖拽即时生效
  arr.forEach((t, i) => { t.sort_order = i; });
  state.todos = [...arr, ...state.todos.filter((t) => t.is_completed)];
  renderTodos();

  try {
    await Promise.all(arr.map((t, i) =>
      sb.from('todos').update({ sort_order: i }).eq('id', t.id)
    ));
    emit('todos-change');
  } catch (err) {
    showToast('排序保存失败，请重试', 'error');
  }
}

/**
 * 触屏端排序：把指定待办与相邻项交换
 * @param {string} id    待办 id
 * @param {number} delta -1 上移 / 1 下移
 */
function moveTodo(id, delta) {
  const pending = state.todos.filter((t) => !t.is_completed);
  const i = pending.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= pending.length) return;
  // 复用拖拽排序：下移放到目标之后，上移放到目标之前
  reorderTodo(id, pending[j].id, delta > 0);
}

/* ==================== 九、模块3：日记笔记 ==================== */
function markDiaryDirty() {
  if (!state.user) return;
  state.diaryDirty = true;
  setDiaryHint('保存中…', 'saving');
  clearTimeout(state.diaryTimer);
  state.diaryTimer = setTimeout(saveDiary, DIARY_DELAY);
}

async function saveDiary() {
  clearTimeout(state.diaryTimer);
  state.diaryTimer = null;
  if (!state.diaryDirty || !sb || !state.user) return;

  const content = $('diary-content').value;
  if (!state.diaryId && !content) { setDiaryHint(''); state.diaryDirty = false; return; }

  state.diaryDirty = false;
  setDiaryHint('保存中…', 'saving');
  const isNew = !state.diaryId;
  try {
    if (state.diaryId) {
      const { error } = await sb.from('diary')
        .update({ content, updated_at: new Date().toISOString() })
        .eq('id', state.diaryId);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('diary')
        .insert({ user_id: state.user.id, record_date: state.date, content })
        .select('id')
        .single();
      if (error) throw error;
      state.diaryId = data.id;
    }
    // 同步本地行缓存，供分类标签即时展示
    state.diaryRow = {
      ...(state.diaryRow || {}),
      id: state.diaryId,
      record_date: state.date,
      content,
      category_ids: (state.diaryRow && state.diaryRow.category_ids) || [],
    };
    setDiaryHint('已保存', 'ok');
    refreshMarks();
    emit('diary-saved', { id: state.diaryId, isNew, content });
  } catch (err) {
    state.diaryDirty = true;
    setDiaryHint('保存失败，请重试', 'err');
  }
}

async function loadDiary() {
  setDiaryHint('加载中…', 'saving');
  try {
    const { data, error } = await sb.from('diary')
      .select('*')
      .eq('user_id', state.user.id)
      .eq('record_date', state.date)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw error;
    const row = data && data[0];
    state.diaryId = row ? row.id : null;
    state.diaryRow = row || null;
    $('diary-content').value = (row && row.content) || '';
    setDiaryHint(row ? '已保存' : '');
    emit('diary-loaded', { row: row || null });
  } catch (err) {
    setDiaryHint('加载失败', 'err');
  }
}

// 切换日期/退出前，把未落库的编辑立即保存
async function flushPendingSaves() {
  const jobs = [];
  if (state.statusDirty) jobs.push(saveDailyStatus());
  if (state.diaryDirty) jobs.push(saveDiary());
  await Promise.all(jobs);
}

/* ==================== 十、模块4：日历组件 ==================== */

function renderCalendar() {
  const y = state.viewYear;
  const m = state.viewMonth;
  $('cal-title').textContent = `${y}年${m + 1}月`;

  const grid = $('cal-grid');
  let html = ['一', '二', '三', '四', '五', '六', '日']
    .map((d) => `<div class="cal-head">${d}</div>`).join('');

  // 周一为第一列的前置空位
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < offset; i++) html += '<div></div>';

  const today = todayStr();
  for (let d = 1; d <= days; d++) {
    const ds = formatDate(new Date(y, m, d));
    const cls = ['cal-day'];
    if (ds === today) cls.push('today');
    if (ds === state.date) cls.push('selected');
    const mark = state.markedDates.get(ds);
    let dots = '';
    if (mark) {
      // 日记分类色点（最多两枚）+ 状态 / 待办点，保持精致小巧
      const catColors = (mark.dc || []).slice(0, 2);
      dots = '<span class="cal-dots">'
        + catColors.map((c) => `<i class="dot" style="background:${c}"></i>`).join('')
        + (mark.s ? '<i class="dot dot-status"></i>' : '')
        + (mark.t ? '<i class="dot dot-todo"></i>' : '')
        + (mark.d && !catColors.length ? '<i class="dot dot-diary"></i>' : '')
        + '</span>';
    }
    html += `<button type="button" class="${cls.join(' ')}" data-date="${ds}">${d}${dots}</button>`;
  }
  grid.innerHTML = html;
}

// 获取全部记录日期及分类，用于日历圆点（状态 / 待办 / 日记分类各一色）
async function refreshMarks() {
  if (!sb || !state.user) return;
  try {
    const uid = state.user.id;
    let diaryRes = await sb.from('diary')
      .select('record_date,category_ids')
      .eq('user_id', uid);
    // 数据库尚未执行升级脚本时回退为基础字段
    if (diaryRes.error) {
      diaryRes = await sb.from('diary').select('record_date').eq('user_id', uid);
    }
    const [a, b] = await Promise.all([
      sb.from('daily_status').select('record_date').eq('user_id', uid),
      sb.from('todos').select('record_date').eq('user_id', uid),
    ]);

    const map = new Map();
    const mark = (rows, key) => (rows || []).forEach((row) => {
      const ds = row.record_date;
      const g = map.get(ds) || {};
      g[key] = true;
      map.set(ds, g);
    });
    mark(a.data, 's');
    mark(b.data, 't');

    // 日记：记录存在 + 分类颜色（用于彩色圆点）
    const colorById = new Map((state.diaryCategories || []).map((c) => [c.id, c.color]));
    (diaryRes.data || []).forEach((row) => {
      const g = map.get(row.record_date) || {};
      g.d = true;
      const colors = (row.category_ids || [])
        .map((id) => colorById.get(id))
        .filter(Boolean);
      if (colors.length) g.dc = [...new Set(colors)];
      map.set(row.record_date, g);
    });

    state.markedDates = map;
    renderCalendar();
  } catch (err) { /* 圆点标记失败不影响主流程 */ }
}

// 点击日历切换日期：先保存未落库编辑，再整体加载该日数据
async function selectDate(dateStr) {
  if (!dateStr || dateStr === state.date) return;
  try { await flushPendingSaves(); } catch (e) { /* 忽略，继续切换 */ }
  state.date = dateStr;
  state.completedOpen = false;
  updateDateLabel();
  renderCalendar();
  loadAllDayData();
  emit('date-change');   // 通知各模块同步日期相关视图
}

function updateDateLabel() {
  const d = parseDate(state.date);
  $('date-label').textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${weekCN(d)}`;
}

// 切换日历月份
function shiftMonth(delta) {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.viewMonth = m;
  state.viewYear = y;
  renderCalendar();
  emit('month-change');
}

// 三个模块并行加载当前日期数据
function loadAllDayData() {
  if (!sb || !state.user) return;
  loadDailyStatus();
  loadTodos();
  loadDiary();
}

/* ==================== 十一、数据导出与清空 ==================== */

// 读取可选表（数据库未升级时返回空数组，不影响主流程）
async function safeSelect(table, userId, orderCol) {
  try {
    let q = sb.from(table).select('*').eq('user_id', userId);
    if (orderCol) q = q.order(orderCol, { ascending: true });
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
}

/**
 * 汇总某个用户的全部数据（普通用户=自己；管理员可传任意用户）
 * 供 JSON / Markdown / PDF 三种导出共用
 */
async function collectUserData(userId, email) {
  const core = await Promise.all([
    sb.from('daily_status').select('*').eq('user_id', userId).order('record_date', { ascending: true }),
    sb.from('todos').select('*').eq('user_id', userId).order('record_date', { ascending: true }),
    sb.from('diary').select('*').eq('user_id', userId).order('record_date', { ascending: true }),
  ]);
  core.forEach((r) => { if (r.error) throw r.error; });

  const [habits, habitLogs, goals, categories] = await Promise.all([
    safeSelect('habits', userId, 'created_at'),
    safeSelect('habit_logs', userId, 'log_date'),
    safeSelect('goals', userId, 'created_at'),
    safeSelect('diary_categories', userId, 'sort_order'),
  ]);

  return {
    app: '每日成长计划',
    exported_at: new Date().toISOString(),
    user_id: userId,
    user_email: email || '',
    daily_status: core[0].data || [],
    todos: core[1].data || [],
    diary: core[2].data || [],
    habits,
    habit_logs: habitLogs,
    goals,
    diary_categories: categories,
  };
}

// 导出某用户全部数据为 JSON（普通用户=自己；管理员可传任意用户）
async function exportUserData(userId, email, btn) {
  if (!sb) return;
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
  try {
    const payload = await collectUserData(userId, email);
    // 文件名：用户名 + 导出日期
    const name = (email || 'user').split('@')[0];
    const dateTag = todayStr().replace(/-/g, '');
    downloadJSON(`${name}_成长计划备份_${dateTag}.json`, payload);
    showToast('JSON 备份已导出');
  } catch (err) {
    showToast('导出失败：' + (friendlyErr(err) || '请稍后重试'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 打开清空确认弹窗（需输入「确认清空」才能执行）
function openConfirmModal(userId, label) {
  pendingClear = { userId, label };
  $('confirm-text').textContent =
    `即将删除 ${label} 的全部每日状态、待办与日记记录，操作不可恢复。`;
  $('confirm-input').value = '';
  $('confirm-ok').disabled = true;
  $('confirm-modal').classList.remove('hidden');
  $('confirm-input').focus();
}

async function doClear() {
  if (!pendingClear || !sb) return;
  const { userId } = pendingClear;
  const ok = $('confirm-ok');
  ok.disabled = true;
  ok.textContent = '清空中…';
  try {
    // 依次清空该用户的全部记录（RLS 兜底校验权限）
    await sb.from('daily_status').delete().eq('user_id', userId);
    await sb.from('todos').delete().eq('user_id', userId);
    await sb.from('diary').delete().eq('user_id', userId);
    // 新增模块的表：缺表时忽略错误
    const safeDelete = async (table) => {
      try { await sb.from(table).delete().eq('user_id', userId); } catch (e) { /* 忽略 */ }
    };
    await safeDelete('habit_logs');
    await safeDelete('habits');
    await safeDelete('goals');
    await safeDelete('diary_categories');
    $('confirm-modal').classList.add('hidden');
    showToast('数据已清空');

    // 清空的是自己：同步重置看板视图
    if (state.user && userId === state.user.id) {
      state.statusId = null;
      state.diaryId = null;
      state.mood = '';
      $('status-content').value = '';
      $('diary-content').value = '';
      updateMoodActive();
      updateStatusCount();
      setStatusHint('');
      setDiaryHint('');
      refreshMarks();
      loadAllDayData();
    }
    // 清空的是管理员专区正在查看的用户：刷新详情
    if (!$('admin-modal').classList.contains('hidden') && state.adminUser && state.adminUser.id === userId) {
      loadAdminDetail(state.adminUser.id, state.adminUser.email);
    }
  } catch (err) {
    showToast('清空失败：' + (friendlyErr(err) || '请稍后重试'), 'error');
  } finally {
    ok.disabled = false;
    ok.textContent = '确认清空';
    pendingClear = null;
  }
}

/* ==================== 十二、管理员专区：用户管理 ==================== */

async function openAdminModal() {
  $('admin-modal').classList.remove('hidden');
  $('admin-user-list').innerHTML = '';
  $('admin-list-loading').classList.remove('hidden');
  $('admin-detail-empty').classList.remove('hidden');
  $('admin-detail').classList.add('hidden');
  state.adminUser = null;
  await loadAdminUsers();
}

// 拉取用户列表：优先新版 admin_list_users，回退旧版 list_users
async function loadAdminUsers() {
  const ul = $('admin-user-list');
  try {
    let res = await sb.rpc('admin_list_users');
    if (res.error) res = await sb.rpc('list_users');
    if (res.error) throw res.error;
    renderAdminUsers(res.data || []);
  } catch (err) {
    $('admin-list-loading').classList.add('hidden');
    ul.innerHTML =
      `<li class="text-xs leading-relaxed" style="color:var(--accent)">
         无法获取用户列表。请在 Supabase 中执行 supabase.sql（内含 list_users 与 admin_list_users 函数），
         并确认当前账号的 is_admin 为 true。
       </li>`;
  }
}

function renderAdminUsers(users) {
  const ul = $('admin-user-list');
  $('admin-list-loading').classList.add('hidden');
  if (!users.length) {
    ul.innerHTML = '<li class="text-xs text-faint">暂无用户</li>';
    return;
  }
  ul.innerHTML = users.map((u) => {
    const meta = u.raw_user_meta_data || {};
    const isAdmin = u.is_admin === true || meta.is_admin === true;
    const disabled = u.disabled === true
      || !!(u.banned_until && new Date(u.banned_until) > new Date());
    const email = u.email || '(无邮箱)';
    return `<li>
        <button class="admin-user-btn" type="button"
                data-id="${u.id}" data-email="${escapeHTML(email)}" data-disabled="${disabled ? '1' : '0'}">
          <span class="truncate">${escapeHTML(email)}</span>
          ${isAdmin ? '<span class="text-[10px]" style="color:var(--accent)">管理员</span>' : ''}
          ${disabled ? '<span class="text-[10px]" style="color:var(--accent)">已禁用</span>' : ''}
        </button>
      </li>`;
  }).join('');
}

// 禁用 / 恢复账号（通过 RPC 修改 auth.users.banned_until）
async function toggleAdminDisabled() {
  if (!sb || !state.adminUser) return;
  const u = state.adminUser;
  const next = !u.disabled;
  const label = next ? '禁用' : '恢复';
  if (!window.confirm(`确认${label}账号 ${u.email}？`)) return;
  try {
    const { error } = await sb.rpc('admin_set_user_disabled', {
      target_user: u.id,
      disabled: next,
    });
    if (error) throw error;
    u.disabled = next;
    updateAdminDisableBtn();
    showToast(`账号已${label}`);
    await loadAdminUsers();
  } catch (err) {
    showToast('操作失败：' + (friendlyErr(err) || '请确认已执行 supabase.sql'), 'error');
  }
}

function updateAdminDisableBtn() {
  const btn = $('admin-disable');
  if (!btn) return;
  const disabled = !!(state.adminUser && state.adminUser.disabled);
  btn.textContent = disabled ? '恢复账号' : '禁用账号';
  btn.classList.toggle('btn-accent', disabled);
}

// 加载选中用户的全部记录，按日期倒序归并展示（只读）
async function loadAdminDetail(uid, email) {
  $('admin-detail-empty').classList.add('hidden');
  const detail = $('admin-detail');
  detail.classList.remove('hidden');
  $('admin-detail-user').textContent = email || uid;
  updateAdminDisableBtn();
  const body = $('admin-detail-body');
  body.innerHTML = '<p class="text-xs text-faint">正在加载记录…</p>';

  try {
    const [s, t, d, cats, hs, gs] = await Promise.all([
      sb.from('daily_status').select('*').eq('user_id', uid).order('record_date', { ascending: false }),
      sb.from('todos').select('*').eq('user_id', uid).order('record_date', { ascending: false }),
      sb.from('diary').select('*').eq('user_id', uid).order('record_date', { ascending: false }),
      safeSelect('diary_categories', uid, 'sort_order'),
      safeSelect('habits', uid, 'created_at'),
      safeSelect('goals', uid, 'created_at'),
    ]);
    [s, t, d].forEach((r) => { if (r.error) throw r.error; });

    // 分类 id -> {name,color}，供日记分类标签展示
    adminCategoryMap = new Map(cats.map((c) => [c.id, c]));

    // 按日期归并三类数据
    const byDate = new Map();
    const ensure = (ds) => {
      if (!byDate.has(ds)) byDate.set(ds, { status: null, todos: [], diary: null });
      return byDate.get(ds);
    };
    (s.data || []).forEach((r) => { const g = ensure(r.record_date); if (!g.status) g.status = r; });
    (t.data || []).forEach((r) => ensure(r.record_date).todos.push(r));
    (d.data || []).forEach((r) => { const g = ensure(r.record_date); if (!g.diary) g.diary = r; });

    // 顶部摘要：习惯 / 目标数量
    let summary = '';
    if (hs.length || gs.length) {
      summary = `<div class="flex flex-wrap gap-3 text-xs text-faint mb-3">
          <span>习惯 ${hs.length} 个</span><span>目标 ${gs.length} 个</span>
        </div>`;
    }

    const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
    if (!dates.length) {
      body.innerHTML = summary + '<p class="text-sm text-faint py-6">该用户暂无任何记录。</p>';
      return;
    }
    body.innerHTML = summary + dates.map((ds) => adminDayHTML(ds, byDate.get(ds))).join('');
  } catch (err) {
    body.innerHTML =
      `<p class="text-sm" style="color:var(--accent)">加载失败：${escapeHTML(friendlyErr(err) || '请稍后重试')}</p>`;
  }
}

function adminDayHTML(ds, g) {
  const d = parseDate(ds);
  const title = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${weekCN(d)}`;
  const moodObj = g.status && g.status.mood ? MOODS.find((m) => m.label === g.status.mood) : null;

  let html = `<div class="border border-line rounded-md p-3">
      <p class="text-xs text-faint mb-2">${title}</p>`;
  if (g.status && (g.status.mood || g.status.content)) {
    html += `<p class="text-sm mb-1">${moodObj ? moodObj.emoji + ' ' + moodObj.label : ''}</p>`;
    if (g.status.content) {
      html += `<p class="text-sm text-soft whitespace-pre-wrap mb-2">${escapeHTML(g.status.content)}</p>`;
    }
  }
  if (g.todos.length) {
    html += '<ul class="mb-2 space-y-1">' + g.todos.map((t) =>
      `<li class="text-sm flex gap-2 items-baseline">
         <span class="${t.is_completed ? 'text-faint line-through' : ''}">${escapeHTML(t.title)}</span>
         <span class="text-[11px] text-faint shrink-0">${escapeHTML(t.priority || '')}</span>
       </li>`
    ).join('') + '</ul>';
  }
  if (g.diary && g.diary.content) {
    // 日记分类标签
    const catTags = (g.diary.category_ids || [])
      .map((id) => adminCategoryMap.get(id))
      .filter(Boolean)
      .map((c) => `<span class="admin-cat-tag" style="--chip:${c.color}">${escapeHTML(c.name)}</span>`)
      .join('');
    if (catTags) html += `<div class="flex flex-wrap gap-1 mb-1">${catTags}</div>`;
    html += `<p class="text-sm text-soft whitespace-pre-wrap border-t border-line pt-2 mt-1">${escapeHTML(g.diary.content)}</p>`;
  }
  const empty = !(g.status && (g.status.mood || g.status.content)) && !g.todos.length && !(g.diary && g.diary.content);
  if (empty) html += '<p class="text-xs text-faint">（空记录）</p>';
  html += '</div>';
  return html;
}

/* ==================== 十三、事件绑定 ==================== */

function bindEvents() {
  // —— 登录 / 导航栏 ——
  $('login-form').addEventListener('submit', onLoginSubmit);
  // —— 主题：面板开关 + 选项切换 + 点击空白处收起 ——
  $('btn-theme').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleThemeMenu();
  });
  $('theme-menu').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-set-theme]');
    if (!opt) return;
    applyTheme(opt.dataset.setTheme);   // 立即生效并记忆
    toggleThemeMenu(false);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#theme-menu') || e.target.closest('#btn-theme')) return;
    if (!$('theme-menu').classList.contains('hidden')) toggleThemeMenu(false);
  });
  $('btn-logout').addEventListener('click', onLogout);

  // —— 导出菜单：JSON / Markdown / PDF（具体导出逻辑见 js/export.js） ——
  $('btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExportMenu();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#export-menu') || e.target.closest('#btn-export')) return;
    if (!$('export-menu').classList.contains('hidden')) toggleExportMenu(false);
  });

  $('btn-clear').addEventListener('click', () => {
    if (state.user) openConfirmModal(state.user.id, state.user.email || '你自己');
  });
  $('btn-admin').addEventListener('click', openAdminModal);

  // —— 每日状态 ——
  $('status-content').addEventListener('input', markStatusDirty);

  // —— Todo ——
  $('todo-add').addEventListener('click', addTodo);
  $('todo-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });
  $('todo-done-toggle').addEventListener('click', () => {
    state.completedOpen = !state.completedOpen;
    renderTodos();
  });
  // 待办勾选 / 删除（两个列表共用事件委托）
  const onTodoClick = async (e) => {
    const item = e.target.closest('.todo-item');
    const act = e.target.closest('[data-act]');
    if (!item || !act) return;
    const id = item.dataset.id;
    if (act.dataset.act === 'toggle') await toggleTodo(id);
    else if (act.dataset.act === 'del') await deleteTodo(id);
    else if (act.dataset.act === 'up') moveTodo(id, -1);
    else if (act.dataset.act === 'down') moveTodo(id, 1);
  };
  $('todo-list').addEventListener('click', onTodoClick);
  $('todo-done-list').addEventListener('click', onTodoClick);

  // 待办拖拽排序（仅未完成列表，置灰的已完成项不可拖动）
  let dragTodoId = null;
  const pendingList = $('todo-list');
  pendingList.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.todo-item');
    if (!item || item.getAttribute('draggable') !== 'true') return;
    dragTodoId = item.dataset.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragTodoId); } catch (err) { /* 兼容性忽略 */ }
  });
  pendingList.addEventListener('dragend', () => {
    pendingList.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    pendingList.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    dragTodoId = null;
  });
  pendingList.addEventListener('dragover', (e) => {
    const item = e.target.closest('.todo-item');
    if (!item || !dragTodoId || item.dataset.id === dragTodoId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    pendingList.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });
  pendingList.addEventListener('drop', async (e) => {
    const item = e.target.closest('.todo-item');
    if (!item || !dragTodoId) return;
    e.preventDefault();
    const rect = item.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    const targetId = item.dataset.id;
    item.classList.remove('drag-over');
    await reorderTodo(dragTodoId, targetId, after);
    dragTodoId = null;
  });

  // —— 日记 ——
  $('diary-content').addEventListener('input', markDiaryDirty);

  // —— 日历 ——
  $('cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('cal-next').addEventListener('click', () => shiftMonth(1));
  $('cal-today').addEventListener('click', () => {
    const now = new Date();
    state.viewYear = now.getFullYear();
    state.viewMonth = now.getMonth();
    renderCalendar();
    selectDate(todayStr());
  });
  $('cal-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-day');
    if (btn) selectDate(btn.dataset.date);
  });

  // —— 管理员专区 ——
  $('admin-close').addEventListener('click', () => $('admin-modal').classList.add('hidden'));
  $('admin-user-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-user-btn');
    if (!btn) return;
    document.querySelectorAll('.admin-user-btn').forEach((b) => b.classList.remove('active-user'));
    btn.classList.add('active-user');
    state.adminUser = {
      id: btn.dataset.id,
      email: btn.dataset.email,
      disabled: btn.dataset.disabled === '1',
    };
    loadAdminDetail(state.adminUser.id, state.adminUser.email);
  });
  $('admin-disable').addEventListener('click', toggleAdminDisabled);
  $('admin-export').addEventListener('click', (e) => {
    if (state.adminUser) exportUserData(state.adminUser.id, state.adminUser.email, e.currentTarget);
  });
  $('admin-clear').addEventListener('click', () => {
    if (state.adminUser) openConfirmModal(state.adminUser.id, state.adminUser.email || '该用户');
  });

  // —— 清空确认弹窗 ——
  $('confirm-cancel').addEventListener('click', () => {
    $('confirm-modal').classList.add('hidden');
    pendingClear = null;
  });
  // 输入「确认清空」后才允许执行
  $('confirm-input').addEventListener('input', () => {
    $('confirm-ok').disabled = $('confirm-input').value.trim() !== '确认清空';
  });
  $('confirm-ok').addEventListener('click', doClear);
}
