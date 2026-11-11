'use strict';

/* =============================================================
 * js/habits.js · 习惯打卡模块
 * -------------------------------------------------------------
 * 职责：
 *   1. 自定义添加 / 删除习惯
 *   2. 每日一键打卡、展示连续打卡天数
 *   3. 每个习惯附带月度打卡日历（可补打过去日期）
 * 依赖：app.js 暴露的 state / sb / $ / escapeHTML / showToast /
 *       todayStr / formatDate / parseDate / friendlyErr
 * 派发：dgp:habit-change（供目标进度与复盘仪表盘刷新）
 * ============================================================= */

let dgpHabits = [];                 // 习惯列表
let dgpLogs = [];                   // 全部打卡记录 [{ habit_id, log_date }]
let dgpLogSet = new Set();          // 快速查询集合："habitId|date"
let dgpHabitExpanded = null;        // 当前展开月历的习惯 id
let dgpHabitAvailable = true;       // 习惯表是否可用
let dgpHabitWarned = false;
let dgpMonthY = new Date().getFullYear();
let dgpMonthM = new Date().getMonth();

/* ---------- 数据加载 ---------- */

async function dgpLoadHabits() {
  if (!sb || !state.user) return;
  const list = $('habit-list');
  $('habit-loading').classList.remove('hidden');
  try {
    const { data, error } = await sb.from('habits')
      .select('*')
      .eq('user_id', state.user.id)
      .eq('is_archived', false)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    dgpHabits = data || [];

    const { data: logs, error: logErr } = await sb.from('habit_logs')
      .select('habit_id,log_date')
      .eq('user_id', state.user.id);
    if (logErr) throw logErr;
    dgpLogs = logs || [];
    dgpLogSet = new Set(dgpLogs.map((l) => l.habit_id + '|' + l.log_date));
    dgpHabitAvailable = true;
  } catch (err) {
    dgpHabits = [];
    dgpLogs = [];
    dgpLogSet = new Set();
    dgpHabitAvailable = false;
    if (!dgpHabitWarned) {
      dgpHabitWarned = true;
      showToast('习惯打卡未就绪：请先在 Supabase 执行 supabase.sql', 'error');
    }
  } finally {
    $('habit-loading').classList.add('hidden');
    dgpRenderHabits();
  }
}

/* ---------- 计算 ---------- */

// 连续打卡天数：今日未打卡时从昨天开始回溯
function dgpHabitStreak(habitId) {
  const set = new Set(
    dgpLogs.filter((l) => l.habit_id === habitId).map((l) => l.log_date)
  );
  let streak = 0;
  const d = new Date();
  if (!set.has(todayStr())) d.setDate(d.getDate() - 1);
  while (set.has(formatDate(d))) {
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/* ---------- 渲染 ---------- */

function dgpHabitCalHTML(h) {
  const y = dgpMonthY;
  const m = dgpMonthM;
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;  // 周一为一周起点
  const days = new Date(y, m + 1, 0).getDate();
  const today = todayStr();

  let cells = ['一', '二', '三', '四', '五', '六', '日']
    .map((d) => `<span class="mini-head">${d}</span>`).join('');
  for (let i = 0; i < offset; i++) cells += '<span></span>';

  for (let d = 1; d <= days; d++) {
    const ds = formatDate(new Date(y, m, d));
    const on = dgpLogSet.has(h.id + '|' + ds);
    const future = ds > today;
    cells += `<button type="button"
      class="mini-day ${on ? 'on' : ''} ${ds === today ? 'today' : ''}"
      data-habit="${h.id}" data-date="${ds}" ${future ? 'disabled' : ''}>${d}</button>`;
  }

  return `<div class="mini-title">
      <button type="button" class="link-btn text-[11px]" data-month="-1">‹ 上月</button>
      <span>${y} 年 ${m + 1} 月</span>
      <button type="button" class="link-btn text-[11px]" data-month="1">下月 ›</button>
    </div>
    <div class="mini-cal">${cells}</div>`;
}

function dgpHabitItemHTML(h) {
  const today = todayStr();
  const checked = dgpLogSet.has(h.id + '|' + today);
  const streak = dgpHabitStreak(h.id);
  const expanded = dgpHabitExpanded === h.id;

  return `<li class="habit-item ${checked ? 'checked' : ''}" data-id="${h.id}">
      <button class="habit-check" type="button" data-act="check" title="今日打卡">✓</button>
      <div class="flex-1 min-w-0">
        <div class="habit-meta">
          <span class="habit-name">${escapeHTML(h.icon || '🌱')} ${escapeHTML(h.name)}</span>
          <span class="streak">${streak > 0 ? '连续 ' + streak + ' 天' : '尚未开始'}</span>
        </div>
        ${expanded ? dgpHabitCalHTML(h) : ''}
      </div>
      <button class="link-btn text-[11px] shrink-0" type="button" data-act="cal">${expanded ? '收起' : '月历'}</button>
      <button class="todo-del" type="button" data-act="del" title="删除习惯">✕</button>
    </li>`;
}

function dgpRenderHabits() {
  const ul = $('habit-list');
  if (!ul) return;
  const todayCount = dgpHabits.filter((h) => dgpLogSet.has(h.id + '|' + todayStr())).length;
  $('habit-count').textContent = dgpHabits.length
    ? `今日 ${todayCount} / ${dgpHabits.length}`
    : '';
  ul.innerHTML = dgpHabits.map(dgpHabitItemHTML).join('');
  $('habit-empty').classList.toggle('hidden', dgpHabits.length > 0);

  if (dgpHabits.length === 0) {
    $('habit-empty').textContent = dgpHabitAvailable
      ? '还没有习惯，添加第一个吧。'
      : '习惯功能需先执行 supabase.sql';
  }
}

/* ---------- 操作 ---------- */

async function dgpAddHabit() {
  if (!sb || !state.user) return;
  const input = $('habit-input');
  const name = (input.value || '').trim();
  if (!name) {
    showToast('请填写习惯名称');
    return;
  }
  if (dgpHabits.some((h) => h.name === name)) {
    showToast('该习惯已存在');
    return;
  }
  const btn = $('habit-add');
  btn.disabled = true;
  try {
    const { data, error } = await sb.from('habits').insert({
      user_id: state.user.id,
      name,
      icon: $('habit-icon').value || '🌱',
      sort_order: dgpHabits.length,
    }).select().single();
    if (error) throw error;
    dgpHabits.push(data);
    input.value = '';
    dgpRenderHabits();
    showToast('习惯已添加');
  } catch (err) {
    showToast('添加失败：' + (friendlyErr(err) || '请确认已执行 supabase.sql'), 'error');
  } finally {
    btn.disabled = false;
  }
}

// 打卡 / 取消打卡（支持补打过去日期）
async function dgpToggleLog(habitId, ds) {
  if (!sb || !state.user || !habitId || !ds) return;
  const key = habitId + '|' + ds;
  const exists = dgpLogSet.has(key);
  try {
    if (exists) {
      const { error } = await sb.from('habit_logs')
        .delete()
        .eq('habit_id', habitId)
        .eq('log_date', ds)
        .eq('user_id', state.user.id);
      if (error) throw error;
      dgpLogSet.delete(key);
      dgpLogs = dgpLogs.filter((l) => !(l.habit_id === habitId && l.log_date === ds));
    } else {
      const { error } = await sb.from('habit_logs').insert({
        habit_id: habitId,
        user_id: state.user.id,
        log_date: ds,
      });
      if (error) throw error;
      dgpLogSet.add(key);
      dgpLogs.push({ habit_id: habitId, log_date: ds });
    }
    dgpRenderHabits();
    emit('habit-change');
  } catch (err) {
    showToast('打卡失败：' + (friendlyErr(err) || '请重试'), 'error');
  }
}

async function dgpDeleteHabit(habitId) {
  const h = dgpHabits.find((x) => x.id === habitId);
  if (!h) return;
  if (!window.confirm(`删除习惯「${h.name}」及其全部打卡记录？`)) return;
  try {
    const { error } = await sb.from('habits').delete().eq('id', habitId);
    if (error) throw error;
    dgpHabits = dgpHabits.filter((x) => x.id !== habitId);
    dgpLogs = dgpLogs.filter((l) => l.habit_id !== habitId);
    dgpLogSet = new Set(dgpLogs.map((l) => l.habit_id + '|' + l.log_date));
    if (dgpHabitExpanded === habitId) dgpHabitExpanded = null;
    dgpRenderHabits();
    emit('habit-change');
    showToast('习惯已删除');
  } catch (err) {
    showToast('删除失败：' + (friendlyErr(err) || '请重试'), 'error');
  }
}

/* ---------- 事件绑定 ---------- */

const dgpHabitAddBtn = $('habit-add');
if (dgpHabitAddBtn) dgpHabitAddBtn.addEventListener('click', dgpAddHabit);

const dgpHabitInput = $('habit-input');
if (dgpHabitInput) {
  dgpHabitInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dgpAddHabit();
    }
  });
}

const dgpHabitList = $('habit-list');
if (dgpHabitList) {
  dgpHabitList.addEventListener('click', (e) => {
    // 1) 月历日期：补打 / 取消
    const day = e.target.closest('.mini-day');
    if (day) {
      if (day.disabled) return;
      dgpToggleLog(day.dataset.habit, day.dataset.date);
      return;
    }
    // 2) 月历翻页
    const monthBtn = e.target.closest('[data-month]');
    if (monthBtn) {
      const delta = Number(monthBtn.dataset.month);
      dgpMonthM += delta;
      if (dgpMonthM < 0) { dgpMonthM = 11; dgpMonthY -= 1; }
      if (dgpMonthM > 11) { dgpMonthM = 0; dgpMonthY += 1; }
      dgpRenderHabits();
      return;
    }
    // 3) 习惯操作
    const item = e.target.closest('.habit-item');
    const act = e.target.closest('[data-act]');
    if (!item || !act) return;
    const id = item.dataset.id;
    if (act.dataset.act === 'check') dgpToggleLog(id, todayStr());
    else if (act.dataset.act === 'cal') {
      dgpHabitExpanded = dgpHabitExpanded === id ? null : id;
      dgpRenderHabits();
    } else if (act.dataset.act === 'del') {
      dgpDeleteHabit(id);
    }
  });
}

/* ---------- 生命周期 ---------- */

document.addEventListener('dgp:board-enter', dgpLoadHabits);

document.addEventListener('dgp:board-exit', () => {
  dgpHabits = [];
  dgpLogs = [];
  dgpLogSet = new Set();
  dgpHabitExpanded = null;
  dgpHabitAvailable = true;
  dgpHabitWarned = false;
  const ul = $('habit-list');
  if (ul) ul.innerHTML = '';
  const count = $('habit-count');
  if (count) count.textContent = '';
  const loading = $('habit-loading');
  if (loading) loading.classList.add('hidden');
  const empty = $('habit-empty');
  if (empty) empty.classList.add('hidden');
});

// 切换日期时，月历跟随到该日期所在月份
document.addEventListener('dgp:date-change', () => {
  const d = parseDate(state.date);
  dgpMonthY = d.getFullYear();
  dgpMonthM = d.getMonth();
  dgpRenderHabits();
});
