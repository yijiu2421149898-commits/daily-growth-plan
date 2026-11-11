'use strict';

/* =============================================================
 * js/diary-tools.js · 日记辅助模块
 * -------------------------------------------------------------
 * 职责：
 *   1. 内置 4 套日记模板（工作日复盘 / 周末总结 / 焦虑梳理 / 目标规划）
 *   2. 实时字数统计 + 本月累计字数
 *   3. 时光回溯：随机调取过往日记回顾
 * 依赖：app.js 暴露的 state / sb / $ / escapeHTML / showToast / selectDate / markDiaryDirty
 * 通信：监听 dgp:board-enter / board-exit / diary-loaded / date-change / month-change / diary-saved
 * ============================================================= */

/* ---------- 内置模板 ---------- */

const DGP_DIARY_TEMPLATES = [
  {
    key: 'workday',
    name: '工作日复盘',
    desc: '梳理当天要事与调整',
    body: `【今日要事】
1. 
2. 

【进展与收获】


【卡点与原因】


【明日调整】
- `,
  },
  {
    key: 'weekend',
    name: '周末总结',
    desc: '回顾一周，规划下周',
    body: `【本周回顾】


【高光时刻】


【遗憾与反思】


【下周计划】
- `,
  },
  {
    key: 'anxiety',
    name: '焦虑梳理',
    desc: '把情绪写下来，找回掌控感',
    body: `【此刻情绪】


【触发事件】


【我能控制的部分】


【下一步行动】
- `,
  },
  {
    key: 'goal',
    name: '目标规划',
    desc: '目标、差距与关键动作',
    body: `【目标】


【现状差距】


【关键动作】
1. 
2. 

【时间节点】`,
  },
];

/* ---------- 模块状态 ---------- */

let dgpTravelRows = [];       // 时光回溯候选日记
let dgpTravelCurrent = null;  // 当前展示的日记行
let dgpTravelLastDate = '';   // 上一篇日期，避免连续抽到同一篇
let dgpMonthWordsTimer = null;

/* ---------- 字数统计 ---------- */

// 统计字数：忽略空白字符（中英文均按字符计）
function dgpCountWords(text) {
  return String(text || '').replace(/\s/g, '').length;
}

// 更新「本日 N 字」
function dgpUpdateWordCount() {
  const el = $('diary-wordcount');
  const ta = $('diary-content');
  if (!el || !ta) return;
  el.textContent = '本日 ' + dgpCountWords(ta.value) + ' 字';
}

// 读取本月累计字数
async function dgpLoadMonthWords() {
  const el = $('diary-month-words');
  if (!el) return;
  if (!sb || !state.user) { el.textContent = ''; return; }

  const d = parseDate(state.date);
  const start = formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
  const end = formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));

  try {
    const { data, error } = await sb.from('diary')
      .select('content')
      .eq('user_id', state.user.id)
      .gte('record_date', start)
      .lte('record_date', end)
      .limit(1000);
    if (error) throw error;
    const total = (data || []).reduce((sum, r) => sum + dgpCountWords(r.content), 0);
    el.textContent = '本月共 ' + total + ' 字';
  } catch (err) {
    el.textContent = '';
  }
}

// 防抖刷新月度字数：保存/切换日期时避免频繁查询
function dgpScheduleMonthWords(delay) {
  clearTimeout(dgpMonthWordsTimer);
  dgpMonthWordsTimer = setTimeout(dgpLoadMonthWords, delay == null ? 600 : delay);
}

/* ---------- 模板菜单 ---------- */

function dgpRenderTemplateMenu() {
  const menu = $('template-menu');
  if (!menu) return;
  menu.innerHTML = '<p class="theme-menu-title">选择模板，内容将写入正文</p>' +
    DGP_DIARY_TEMPLATES.map((t) =>
      `<button type="button" class="theme-opt" data-template="${t.key}">
         <span class="min-w-0">
           <span class="block">${escapeHTML(t.name)}</span>
           <span class="block text-xs text-faint">${escapeHTML(t.desc)}</span>
         </span>
       </button>`).join('');
}

// 打开 / 收起模板菜单
function dgpToggleTemplateMenu(force) {
  const menu = $('template-menu');
  const btn = $('btn-template');
  if (!menu || !btn) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
}

// 应用模板：正文为空则直接写入，否则追加到末尾
function dgpApplyTemplate(key) {
  const tpl = DGP_DIARY_TEMPLATES.find((t) => t.key === key);
  if (!tpl) return;
  const ta = $('diary-content');
  if (!ta || !state.user) return;

  const cur = ta.value;
  if (!cur.trim()) {
    ta.value = tpl.body;
  } else {
    ta.value = cur.replace(/\s+$/, '') + '\n\n' + tpl.body;
  }
  ta.focus();
  ta.scrollTop = ta.scrollHeight;
  dgpToggleTemplateMenu(false);
  dgpUpdateWordCount();
  markDiaryDirty();   // 立即进入自动保存流程
  showToast('已套用「' + tpl.name + '」');
}

/* ---------- 时光回溯 ---------- */

// 拉取候选日记（排除当前日期与空内容）
async function dgpLoadTravelRows() {
  const { data, error } = await sb.from('diary')
    .select('*')
    .eq('user_id', state.user.id)
    .order('record_date', { ascending: false })
    .limit(300);
  if (error) throw error;
  dgpTravelRows = (data || []).filter((r) =>
    String(r.content || '').trim() && r.record_date !== state.date);
  return dgpTravelRows;
}

// 随机抽取一篇（尽量避开上一篇与当天）
function dgpPickTravelRow() {
  if (!dgpTravelRows.length) return null;
  let pool = dgpTravelRows.filter((r) => r.record_date !== dgpTravelLastDate);
  if (!pool.length) pool = dgpTravelRows;
  return pool[Math.floor(Math.random() * pool.length)];
}

function dgpRenderTravel() {
  const row = dgpTravelCurrent;
  const body = $('travel-body');
  const dateEl = $('travel-date');
  const catBox = $('travel-cats');
  if (!body || !dateEl || !catBox) return;

  if (!row) {
    dateEl.textContent = '';
    body.textContent = '还没有可以回顾的过往日记，先从今天写起吧。';
    catBox.innerHTML = '';
    return;
  }

  const d = parseDate(row.record_date);
  dateEl.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${weekCN(d)}`;
  body.textContent = row.content || '';

  // 展示该篇日记的分类标签（分类表缺失时静默跳过）
  const map = new Map((state.diaryCategories || []).map((c) => [c.id, c]));
  const cats = (row.category_ids || []).map((id) => map.get(id)).filter(Boolean);
  catBox.innerHTML = cats.map((c) =>
    `<span class="cat-chip" style="--chip:${c.color}">${escapeHTML(c.name)}</span>`).join('');
}

// 打开时光回溯弹窗
async function dgpOpenTravel() {
  if (!sb || !state.user) return;
  const modal = $('travel-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  $('travel-body').textContent = '正在翻找旧日记…';
  $('travel-date').textContent = '';
  $('travel-cats').innerHTML = '';
  try {
    await dgpLoadTravelRows();
  } catch (err) {
    dgpTravelRows = [];
  }
  dgpShowRandomDiary();
}

// 抽取并展示下一篇
function dgpShowRandomDiary() {
  const row = dgpPickTravelRow();
  dgpTravelCurrent = row;
  if (row) dgpTravelLastDate = row.record_date;
  dgpRenderTravel();
}

// 关闭弹窗
function dgpCloseTravel() {
  const modal = $('travel-modal');
  if (modal) modal.classList.add('hidden');
  dgpTravelCurrent = null;
}

/* ---------- 生命周期 ---------- */

function dgpDiaryToolsEnter() {
  dgpRenderTemplateMenu();
  dgpUpdateWordCount();
  dgpScheduleMonthWords(200);
}

function dgpDiaryToolsExit() {
  clearTimeout(dgpMonthWordsTimer);
  dgpToggleTemplateMenu(false);
  dgpCloseTravel();
  dgpTravelRows = [];
  dgpTravelCurrent = null;
  dgpTravelLastDate = '';
  const wc = $('diary-wordcount');
  if (wc) wc.textContent = '本日 0 字';
  const mw = $('diary-month-words');
  if (mw) mw.textContent = '';
}

/* ---------- 事件绑定 ---------- */

document.addEventListener('dgp:board-enter', dgpDiaryToolsEnter);
document.addEventListener('dgp:board-exit', dgpDiaryToolsExit);

// 日记加载完成 / 切换日期：同步字数与月度字数
document.addEventListener('dgp:diary-loaded', () => {
  dgpUpdateWordCount();
});

document.addEventListener('dgp:date-change', () => {
  dgpUpdateWordCount();
  dgpScheduleMonthWords(400);
});

document.addEventListener('dgp:month-change', () => {
  dgpScheduleMonthWords(400);
});

// 保存成功后刷新月度累计字数
document.addEventListener('dgp:diary-saved', () => {
  dgpUpdateWordCount();
  dgpScheduleMonthWords(1500);
});

// 实时字数统计（输入即更新，不影响 app.js 的自动保存）
const dgpDiaryContentEl = $('diary-content');
if (dgpDiaryContentEl) {
  dgpDiaryContentEl.addEventListener('input', dgpUpdateWordCount);
}

// 模板按钮与菜单
const dgpBtnTemplate = $('btn-template');
if (dgpBtnTemplate) {
  dgpBtnTemplate.addEventListener('click', (e) => {
    e.stopPropagation();
    dgpToggleTemplateMenu();
  });
}

const dgpTemplateMenu = $('template-menu');
if (dgpTemplateMenu) {
  dgpTemplateMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-template]');
    if (opt) dgpApplyTemplate(opt.dataset.template);
  });
}

// 点击外部关闭模板菜单
document.addEventListener('click', (e) => {
  const menu = $('template-menu');
  const btn = $('btn-template');
  if (!menu || !btn || menu.classList.contains('hidden')) return;
  if (menu.contains(e.target) || btn.contains(e.target)) return;
  dgpToggleTemplateMenu(false);
});

// 时光回溯
const dgpBtnTravel = $('btn-travel');
if (dgpBtnTravel) dgpBtnTravel.addEventListener('click', dgpOpenTravel);

const dgpTravelAgain = $('travel-again');
if (dgpTravelAgain) dgpTravelAgain.addEventListener('click', dgpShowRandomDiary);

const dgpTravelGo = $('travel-go');
if (dgpTravelGo) {
  dgpTravelGo.addEventListener('click', () => {
    if (!dgpTravelCurrent) return;
    const date = dgpTravelCurrent.record_date;
    dgpCloseTravel();
    selectDate(date);
  });
}

const dgpTravelClose = $('travel-close');
if (dgpTravelClose) dgpTravelClose.addEventListener('click', dgpCloseTravel);
