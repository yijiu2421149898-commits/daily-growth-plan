'use strict';

/* =============================================================
 * js/goals.js · 目标管理模块
 * -------------------------------------------------------------
 * 职责：
 *   1. 新增月度 / 季度目标
 *   2. 绑定「已完成待办」或「习惯打卡」自动计算进度
 *   3. 展示进度条与完成百分比
 * 依赖：app.js 暴露的 state / sb / $ / escapeHTML / showToast /
 *       formatDate / parseDate / friendlyErr
 * 派发：dgp:goal-change（供复盘仪表盘刷新）
 * ============================================================= */

let dgpGoals = [];              // 进行中的目标
let dgpGoalHabits = [];         // 可绑定的习惯 [{id,name,icon}]
let dgpDoneDates = [];          // 已完成待办的日期集合
let dgpGoalLogs = [];           // 全部打卡记录
let dgpGoalAvailable = true;
let dgpGoalWarned = false;

/* ---------- 周期工具 ---------- */

function dgpGoalPeriodLabel(period, type) {
  if (!period) return '';
  if (type === 'quarter') {
    const parts = period.split('-Q');
    return `${parts[0]} 年第 ${parts[1]} 季度`;
  }
  const parts = period.split('-');
  return `${parts[0]} 年 ${Number(parts[1])} 月`;
}

// 计算周期起止日期（含首尾）
function dgpGoalRange(period, type) {
  if (type === 'quarter') {
    const parts = period.split('-Q');
    const y = Number(parts[0]);
    const q = Number(parts[1]);
    const startM = (q - 1) * 3;
    const start = `${y}-${String(startM + 1).padStart(2, '0')}-01`;
    const end = formatDate(new Date(y, startM + 3, 0));
    return { start, end };
  }
  const parts = period.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return {
    start: `${period}-01`,
    end: formatDate(new Date(y, m, 0)),
  };
}

// 生成周期下拉选项
function dgpGoalBuildPeriods() {
  const type = $('goal-type').value;
  const sel = $('goal-period');
  if (!sel) return;
  const d = parseDate(state.date || todayStr());
  const y = d.getFullYear();
  let options = '';
  if (type === 'month') {
    for (let m = 1; m <= 12; m++) {
      const v = `${y}-${String(m).padStart(2, '0')}`;
      options += `<option value="${v}">${y} 年 ${m} 月</option>`;
    }
    sel.innerHTML = options;
    sel.value = `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  } else {
    for (let q = 1; q <= 4; q++) {
      const v = `${y}-Q${q}`;
      options += `<option value="${v}">${y} 年 Q${q}</option>`;
    }
    sel.innerHTML = options;
    sel.value = `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  }
}

/* ---------- 数据加载 ---------- */

// 习惯下拉：供「习惯打卡」进度来源选择
async function dgpGoalLoadHabitOptions() {
  if (!sb || !state.user) return;
  try {
    const { data, error } = await sb.from('habits')
      .select('id,name,icon')
      .eq('user_id', state.user.id)
      .eq('is_archived', false)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    dgpGoalHabits = data || [];
  } catch (err) {
    dgpGoalHabits = [];
  }
  const sel = $('goal-habit');
  if (!sel) return;
  if (!dgpGoalHabits.length) {
    sel.innerHTML = '<option value="">暂无习惯，请先添加</option>';
    return;
  }
  sel.innerHTML = dgpGoalHabits.map((h) =>
    `<option value="${h.id}">${escapeHTML(h.icon || '🌱')} ${escapeHTML(h.name)}</option>`).join('');
}

async function dgpLoadGoals() {
  if (!sb || !state.user) return;
  const loading = $('goal-loading');
  if (loading) loading.classList.remove('hidden');
  try {
    const { data, error } = await sb.from('goals')
      .select('*')
      .eq('user_id', state.user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    dgpGoals = data || [];
    dgpGoalAvailable = true;

    // 统计源：已完成待办日期 + 全部打卡记录（量级小，一次拉取）
    const [todoRes, logRes] = await Promise.all([
      sb.from('todos').select('record_date').eq('user_id', state.user.id).eq('is_completed', true),
      sb.from('habit_logs').select('habit_id,log_date').eq('user_id', state.user.id),
    ]);
    dgpDoneDates = (todoRes.data || []).map((r) => r.record_date);
    dgpGoalLogs = logRes.data || [];
  } catch (err) {
    dgpGoals = [];
    dgpDoneDates = [];
    dgpGoalLogs = [];
    dgpGoalAvailable = false;
    if (!dgpGoalWarned) {
      dgpGoalWarned = true;
      showToast('目标管理未就绪：请先在 Supabase 执行 supabase.sql', 'error');
    }
  } finally {
    if (loading) loading.classList.add('hidden');
    dgpRenderGoals();
  }
}

/* ---------- 进度计算 ---------- */

function dgpGoalProgress(g) {
  const range = dgpGoalRange(g.period, g.type);
  let cur = Number(g.current_value) || 0;

  if (g.link_type === 'todo') {
    cur = dgpDoneDates.filter((d) => d >= range.start && d <= range.end).length;
  } else if (g.link_type === 'habit' && g.link_id) {
    cur = dgpGoalLogs.filter((l) =>
      l.habit_id === g.link_id && l.log_date >= range.start && l.log_date <= range.end
    ).length;
  }

  const target = Math.max(1, Number(g.target_value) || 1);
  return {
    cur,
    target,
    pct: Math.min(100, Math.round((cur / target) * 100)),
  };
}

/* ---------- 渲染 ---------- */

function dgpGoalItemHTML(g) {
  const p = dgpGoalProgress(g);
  const sourceLabel = g.link_type === 'todo'
    ? '已完成待办'
    : g.link_type === 'habit'
      ? '习惯打卡'
      : '手动记录';
  const habit = g.link_type === 'habit'
    ? dgpGoalHabits.find((h) => h.id === g.link_id)
    : null;

  return `<li class="goal-item" data-id="${g.id}">
      <div class="goal-head">
        <span class="goal-title">${escapeHTML(g.title)}</span>
        <span class="goal-tag">${escapeHTML(dgpGoalPeriodLabel(g.period, g.type))}</span>
        <span class="goal-tag">${escapeHTML(sourceLabel)}${habit ? ' · ' + escapeHTML(habit.name) : ''}</span>
        <button class="todo-del" type="button" data-act="del" title="删除目标">✕</button>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${p.pct}%"></div></div>
      <div class="goal-foot">
        <span>${p.cur} / ${p.target}</span>
        <span style="color:var(--accent)">${p.pct}%</span>
        <span class="flex-1"></span>
        ${g.link_type === 'manual' ? '<button class="link-btn text-[11px]" type="button" data-act="plus">+1 进展</button>' : ''}
      </div>
    </li>`;
}

function dgpRenderGoals() {
  const ul = $('goal-list');
  if (!ul) return;
  ul.innerHTML = dgpGoals.map(dgpGoalItemHTML).join('');
  $('goal-count').textContent = dgpGoals.length ? `${dgpGoals.length} 个进行中` : '';
  $('goal-empty').classList.toggle('hidden', dgpGoals.length > 0);
  if (!dgpGoals.length) {
    $('goal-empty').textContent = dgpGoalAvailable
      ? '暂时没有进行中的目标，添加一个吧。'
      : '目标功能需先执行 supabase.sql';
  }
}

/* ---------- 操作 ---------- */

async function dgpAddGoal() {
  if (!sb || !state.user) return;
  const title = ($('goal-title').value || '').trim();
  if (!title) {
    showToast('请填写目标名称');
    return;
  }
  const type = $('goal-type').value;
  const period = $('goal-period').value;
  const linkType = $('goal-source').value;
  const linkId = linkType === 'habit' ? $('goal-habit').value : null;
  if (linkType === 'habit' && !linkId) {
    showToast('请选择要绑定的习惯');
    return;
  }
  const target = Math.max(1, Number($('goal-target').value) || 1);

  const btn = $('goal-add');
  btn.disabled = true;
  try {
    const { error } = await sb.from('goals').insert({
      user_id: state.user.id,
      title,
      type,
      period,
      target_value: target,
      current_value: 0,
      link_type: linkType,
      link_id: linkId,
      status: 'active',
    });
    if (error) throw error;
    $('goal-title').value = '';
    await dgpLoadGoals();
    emit('goal-change');
    showToast('目标已添加');
  } catch (err) {
    showToast('添加失败：' + (friendlyErr(err) || '请确认已执行 supabase.sql'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function dgpDeleteGoal(id) {
  if (!window.confirm('确认删除该目标？')) return;
  try {
    const { error } = await sb.from('goals').update({ status: 'archived' }).eq('id', id);
    if (error) throw error;
    dgpGoals = dgpGoals.filter((g) => g.id !== id);
    dgpRenderGoals();
    emit('goal-change');
  } catch (err) {
    showToast('删除失败：' + (friendlyErr(err) || '请重试'), 'error');
  }
}

// 手动目标：进展 +1
async function dgpGoalPlusOne(id) {
  const g = dgpGoals.find((x) => x.id === id);
  if (!g) return;
  const next = Math.min(Number(g.target_value) || 1, (Number(g.current_value) || 0) + 1);
  try {
    const { error } = await sb.from('goals')
      .update({ current_value: next, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    g.current_value = next;
    dgpRenderGoals();
    emit('goal-change');
  } catch (err) {
    showToast('更新失败：' + (friendlyErr(err) || '请重试'), 'error');
  }
}

/* ---------- 事件绑定 ---------- */

const dgpGoalAddBtn = $('goal-add');
if (dgpGoalAddBtn) dgpGoalAddBtn.addEventListener('click', dgpAddGoal);

const dgpGoalTitle = $('goal-title');
if (dgpGoalTitle) {
  dgpGoalTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dgpAddGoal();
    }
  });
}

const dgpGoalType = $('goal-type');
if (dgpGoalType) {
  dgpGoalType.addEventListener('change', dgpGoalBuildPeriods);
}

// 进度来源切换：习惯选择框按需显示
const dgpGoalSource = $('goal-source');
if (dgpGoalSource) {
  dgpGoalSource.addEventListener('change', () => {
    const sel = $('goal-habit');
    if (!sel) return;
    sel.classList.toggle('hidden', dgpGoalSource.value !== 'habit');
  });
}

const dgpGoalList = $('goal-list');
if (dgpGoalList) {
  dgpGoalList.addEventListener('click', (e) => {
    const item = e.target.closest('.goal-item');
    const act = e.target.closest('[data-act]');
    if (!item || !act) return;
    const id = item.dataset.id;
    if (act.dataset.act === 'del') dgpDeleteGoal(id);
    else if (act.dataset.act === 'plus') dgpGoalPlusOne(id);
  });
}

/* ---------- 生命周期 ---------- */

document.addEventListener('dgp:board-enter', async () => {
  dgpGoalBuildPeriods();
  await dgpGoalLoadHabitOptions();
  dgpLoadGoals();
});

document.addEventListener('dgp:board-exit', () => {
  dgpGoals = [];
  dgpGoalHabits = [];
  dgpDoneDates = [];
  dgpGoalLogs = [];
  dgpGoalAvailable = true;
  dgpGoalWarned = false;
  const ul = $('goal-list');
  if (ul) ul.innerHTML = '';
  const count = $('goal-count');
  if (count) count.textContent = '';
  const loading = $('goal-loading');
  if (loading) loading.classList.add('hidden');
  const empty = $('goal-empty');
  if (empty) empty.classList.add('hidden');
  const title = $('goal-title');
  if (title) title.value = '';
});

// 切换日期时同步周期默认值
document.addEventListener('dgp:date-change', dgpGoalBuildPeriods);

// 待办完成状态变化 → 重新计算绑定进度
document.addEventListener('dgp:todos-change', dgpLoadGoals);

// 打卡 / 习惯变化 → 刷新习惯下拉与进度
document.addEventListener('dgp:habit-change', async () => {
  await dgpGoalLoadHabitOptions();
  dgpLoadGoals();
});
