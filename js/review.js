'use strict';

/* =============================================================
 * js/review.js · 复盘仪表盘模块
 * -------------------------------------------------------------
 * 职责：
 *   1. 本月情绪占比（环形图 + 图例）
 *   2. 本月各分类日记数量（横向条形）
 *   3. 总数据看板：日记总数 / 已完成待办 / 打卡次数
 * 依赖：app.js 暴露的 state / sb / $ / escapeHTML / MOODS /
 *       formatDate / parseDate / todayStr
 * ============================================================= */

/* 情绪配色：与四套主题都能和谐共存的中低饱和色 */
const DGP_MOOD_COLORS = {
  '愉悦': '#e0a86a',
  '平静': '#93a17b',
  '低落': '#7f96b5',
  '烦躁': '#c97c7c',
  '疲惫': '#b3a89a',
};

let dgpReviewTimer = null;

/* ---------- 渲染 ---------- */

function dgpReviewMoodChart(moodRows) {
  const counts = {};
  moodRows.forEach((r) => {
    if (r.mood) counts[r.mood] = (counts[r.mood] || 0) + 1;
  });
  const total = moodRows.filter((r) => r.mood).length;

  const legend = $('mood-legend');
  const donut = $('mood-donut');
  const center = $('mood-donut-center');

  if (!total) {
    donut.style.background = 'var(--line)';
    center.innerHTML = '暂无<br>记录';
    legend.innerHTML = '<p class="text-xs text-faint">本月还没有记录心情。</p>';
    return;
  }

  // 环形图：按固定顺序累加扇区
  let acc = 0;
  const stops = [];
  MOODS.forEach((m) => {
    const n = counts[m.label] || 0;
    if (!n) return;
    const pct = (n / total) * 100;
    stops.push(`${DGP_MOOD_COLORS[m.label]} ${acc}% ${acc + pct}%`);
    acc += pct;
  });
  donut.style.background = `conic-gradient(${stops.join(',')})`;
  center.innerHTML = `本月<br>${total} 天`;

  legend.innerHTML = MOODS.map((m) => {
    const n = counts[m.label] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return `<div class="legend-row">
        <span class="legend-dot" style="background:${DGP_MOOD_COLORS[m.label]}"></span>
        <span class="legend-name">${m.emoji} ${m.label}</span>
        <span class="legend-val">${n} 天 · ${pct}%</span>
      </div>`;
  }).join('');
}

function dgpReviewCategoryChart(diaryRows) {
  const box = $('cat-bars');
  if (!box) return;
  if (!diaryRows.length) {
    box.innerHTML = '<p class="text-xs text-faint">本月还没有日记。</p>';
    return;
  }

  const cats = state.diaryCategories || [];
  const countById = new Map();
  let unclassified = 0;

  diaryRows.forEach((r) => {
    const ids = Array.isArray(r.category_ids) ? r.category_ids : [];
    if (!ids.length) {
      unclassified += 1;
      return;
    }
    ids.forEach((id) => countById.set(id, (countById.get(id) || 0) + 1));
  });

  const items = cats
    .map((c) => ({ id: c.id, name: c.name, color: c.color, n: countById.get(c.id) || 0 }))
    .filter((x) => x.n > 0);
  if (unclassified) items.push({ id: 'none', name: '未分类', color: 'var(--faint)', n: unclassified });

  if (!items.length) {
    box.innerHTML = '<p class="text-xs text-faint">本月日记还没有分类。</p>';
    return;
  }

  const max = Math.max.apply(null, items.map((x) => x.n));
  box.innerHTML = items.map((x) => {
    const w = Math.max(4, Math.round((x.n / max) * 100));
    return `<div class="bar-row">
        <div class="bar-head">
          <span class="legend-dot" style="background:${x.color}"></span>
          <span class="bar-name">${escapeHTML(x.name)}</span>
          <span class="bar-num">${x.n} 篇</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${w}%;background:${x.color}"></div>
        </div>
      </div>`;
  }).join('');
}

function dgpReviewTotals(diaryCount, todoDone, logCount) {
  const box = $('totals');
  if (!box) return;
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));
  box.innerHTML = `
    <div class="stat-box">
      <div class="stat-num">${fmt(diaryCount)}</div>
      <div class="stat-label">日记总数</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">${fmt(todoDone)}</div>
      <div class="stat-label">待办完成</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">${fmt(logCount)}</div>
      <div class="stat-label">打卡次数</div>
    </div>`;
}

/* ---------- 数据加载 ---------- */

async function dgpReviewLoad() {
  if (!sb || !state.user) return;
  const uid = state.user.id;
  const d = parseDate(state.date);
  const start = formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
  const end = formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const periodEl = $('review-period');
  if (periodEl) periodEl.textContent = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;

  // 1) 本月心情 + 本月日记（分类可能不存在，需回退）
  let moodRows = [];
  let diaryRows = [];
  try {
    const [moodRes, diaryRes] = await Promise.all([
      sb.from('daily_status').select('mood')
        .eq('user_id', uid).gte('record_date', start).lte('record_date', end),
      sb.from('diary').select('category_ids')
        .eq('user_id', uid).gte('record_date', start).lte('record_date', end),
    ]);
    moodRows = moodRes.data || [];
    if (diaryRes.error) {
      // 未升级数据库时只统计数量
      const fallback = await sb.from('diary').select('record_date')
        .eq('user_id', uid).gte('record_date', start).lte('record_date', end);
      diaryRows = (fallback.data || []).map(() => ({ category_ids: [] }));
    } else {
      diaryRows = diaryRes.data || [];
    }
  } catch (err) {
    moodRows = [];
    diaryRows = [];
  }
  dgpReviewMoodChart(moodRows);
  dgpReviewCategoryChart(diaryRows);

  // 2) 总数据看板（count 查询，失败时显示 —）
  let diaryCount = null;
  let todoDone = null;
  let logCount = null;
  try {
    const [a, b, c] = await Promise.all([
      sb.from('diary').select('id', { count: 'exact', head: true }).eq('user_id', uid),
      sb.from('todos').select('id', { count: 'exact', head: true })
        .eq('user_id', uid).eq('is_completed', true),
      sb.from('habit_logs').select('id', { count: 'exact', head: true }).eq('user_id', uid),
    ]);
    if (!a.error) diaryCount = a.count;
    if (!b.error) todoDone = b.count;
    if (!c.error) logCount = c.count;
  } catch (err) { /* 忽略单项统计失败 */ }
  dgpReviewTotals(diaryCount, todoDone, logCount);
}

// 合并高频事件，减少请求
function dgpReviewSchedule(delay) {
  clearTimeout(dgpReviewTimer);
  dgpReviewTimer = setTimeout(dgpReviewLoad, delay || 500);
}

/* ---------- 生命周期 ---------- */

document.addEventListener('dgp:board-enter', () => dgpReviewSchedule(300));
document.addEventListener('dgp:date-change', () => dgpReviewSchedule(300));
document.addEventListener('dgp:month-change', () => dgpReviewSchedule(300));

// 各类数据变化：延迟刷新，避免输入日记时频繁请求
document.addEventListener('dgp:diary-saved', () => dgpReviewSchedule(1800));
document.addEventListener('dgp:todos-change', () => dgpReviewSchedule(600));
document.addEventListener('dgp:habit-change', () => dgpReviewSchedule(600));
document.addEventListener('dgp:goal-change', () => dgpReviewSchedule(600));
document.addEventListener('dgp:data-dirty', () => dgpReviewSchedule(600));

document.addEventListener('dgp:board-exit', () => {
  clearTimeout(dgpReviewTimer);
  const donut = $('mood-donut');
  if (donut) donut.style.background = 'var(--line)';
  const center = $('mood-donut-center');
  if (center) center.innerHTML = '暂无<br>记录';
  const legend = $('mood-legend');
  if (legend) legend.innerHTML = '';
  const bars = $('cat-bars');
  if (bars) bars.innerHTML = '';
  const totals = $('totals');
  if (totals) totals.innerHTML = '';
  const periodEl = $('review-period');
  if (periodEl) periodEl.textContent = '';
});
