'use strict';

/* =============================================================
 * js/categories.js · 日记分类模块
 * -------------------------------------------------------------
 * 职责：
 *   1. 分类数据加载与 7 个预设分类自动初始化
 *   2. 日记保存后弹出分类选择弹窗（支持多选）
 *   3. 自定义新增分类
 *   4. 顶部筛选栏：分类下拉 + 全文搜索
 *   5. AI 自动推荐分类（当前为本地关键词打分，预留真实 AI 接口）
 * 依赖：app.js 暴露的 state / sb / $ / escapeHTML / showToast 等
 * 通信：监听 dgp:board-enter / board-exit / diary-loaded / diary-saved
 *       派发 dgp:data-dirty（通知复盘仪表盘刷新）
 * ============================================================= */

/* ---------- 预设分类（首次使用时自动写入数据库） ---------- */
const DGP_PRESET_CATEGORIES = [
  { name: '副业创业', color: '#a9744f' },
  { name: '学习备考', color: '#5f7d9c' },
  { name: '情绪随笔', color: '#b18aae' },
  { name: '生活日常', color: '#93a17b' },
  { name: '感情', color: '#d18f8f' },
  { name: '收支复盘', color: '#c2a15a' },
  { name: '运动健康', color: '#6fae9f' },
];

/* 自定义分类的可选色板 */
const DGP_CAT_PALETTE = [
  '#a9744f', '#5f7d9c', '#b18aae', '#93a17b',
  '#d18f8f', '#c2a15a', '#6fae9f', '#8f8ce4', '#d99a8a',
];

/* ---------- 模块状态 ---------- */
let dgpCategories = [];                 // 当前用户全部分类
let dgpCatById = new Map();             // id -> 分类对象
let dgpCatAvailable = true;             // 分类表是否可用
let dgpCatWarned = false;               // 缺表提示只弹一次
let dgpCatModalDiaryId = null;          // 弹窗正在编辑的日记 id
let dgpCatSelected = new Set();         // 弹窗中已选分类 id
let dgpCatPrompted = new Set();         // 本次会话已提示过的日记 id
let dgpCatFilterId = '';                // 当前筛选分类
let dgpCatSearchTimer = null;

/* ---------- 分类数据加载 ---------- */

// 拉取分类；若为空则写入预设分类
async function dgpLoadCategories(ensurePreset) {
  if (!sb || !state.user) return;
  try {
    const { data, error } = await sb.from('diary_categories')
      .select('*')
      .eq('user_id', state.user.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;

    let rows = data || [];
    if (!rows.length && ensurePreset) {
      const payload = DGP_PRESET_CATEGORIES.map((c, i) => ({
        user_id: state.user.id,
        name: c.name,
        color: c.color,
        is_preset: true,
        sort_order: i,
      }));
      const { error: insErr } = await sb.from('diary_categories').insert(payload);
      // 并发场景下可能因唯一索引冲突，忽略后重新读取
      if (!insErr) {
        const res = await sb.from('diary_categories')
          .select('*')
          .eq('user_id', state.user.id)
          .order('sort_order', { ascending: true });
        rows = res.data || [];
      }
    }

    dgpCategories = rows;
    dgpCatById = new Map(rows.map((r) => [r.id, r]));
    state.diaryCategories = rows;     // 供日历圆点着色
    dgpCatAvailable = true;
  } catch (err) {
    dgpCatAvailable = false;
    dgpCategories = [];
    dgpCatById = new Map();
    state.diaryCategories = [];
    if (!dgpCatWarned) {
      dgpCatWarned = true;
      showToast('分类功能未就绪：请先在 Supabase 执行 supabase.sql', 'error');
    }
  }
}

// 渲染顶部分类筛选项
function dgpRenderFilter() {
  const sel = $('diary-filter');
  if (!sel) return;
  const options = ['<option value="">全部分类</option>']
    .concat(dgpCategories.map((c) =>
      `<option value="${c.id}">${escapeHTML(c.name)}</option>`))
    .concat(['<option value="__none__">未分类</option>']);
  sel.innerHTML = options.join('');
  sel.value = dgpCatFilterId;
}

/* ---------- 当前日记的分类标签 ---------- */

function dgpRenderDiaryCats() {
  const box = $('diary-cats');
  if (!box) return;
  if (!dgpCatAvailable) {
    box.innerHTML = '<span class="text-xs text-faint">分类功能需先执行 supabase.sql</span>';
    return;
  }
  const row = state.diaryRow;
  const ids = (row && Array.isArray(row.category_ids)) ? row.category_ids : [];
  const cats = ids.map((id) => dgpCatById.get(id)).filter(Boolean);
  box.innerHTML = cats.length
    ? cats.map((c) =>
        `<span class="cat-chip" style="--chip:${c.color}">${escapeHTML(c.name)}</span>`).join('')
    : '<span class="text-xs text-faint">未分类 · 点击「编辑分类」添加</span>';
}

/* ---------- 分类选择弹窗 ---------- */

function dgpRenderModalChips() {
  const box = $('cat-chips');
  if (!box) return;
  if (!dgpCategories.length) {
    box.innerHTML = '<span class="text-xs text-faint">暂无分类，可在下方新增</span>';
    return;
  }
  box.innerHTML = dgpCategories.map((c) => {
    const on = dgpCatSelected.has(c.id);
    return `<button type="button" class="cat-chip ${on ? 'on' : ''}"
              data-cat-id="${c.id}" style="--chip:${c.color}">${escapeHTML(c.name)}</button>`;
  }).join('');
}

/**
 * 打开分类弹窗
 * @param {string} diaryId 日记 id
 * @param {object} opts { aiIds: string[], hintText: string }
 */
function dgpOpenCategoryModal(diaryId, opts) {
  opts = opts || {};
  if (!dgpCatAvailable) {
    showToast('请先在 Supabase 执行 supabase.sql 创建分类表', 'error');
    return;
  }
  if (!diaryId) {
    showToast('请先写点内容，保存后即可分类');
    return;
  }
  dgpCatModalDiaryId = diaryId;

  // 当前选中：优先取本地行缓存
  const row = (state.diaryRow && state.diaryRow.id === diaryId) ? state.diaryRow : null;
  dgpCatSelected = new Set((row && row.category_ids) || []);

  // AI 推荐：仅在没有人工选择时自动预选，用户可自由修改
  const aiIds = Array.isArray(opts.aiIds) ? opts.aiIds : [];
  if (!dgpCatSelected.size && aiIds.length) {
    aiIds.forEach((id) => { if (dgpCatById.has(id)) dgpCatSelected.add(id); });
  }

  $('cat-modal-date').textContent = state.date.replace(/-/g, '/');
  $('cat-ai-hint').textContent = opts.hintText || '';
  $('category-modal').classList.remove('hidden');
  dgpRenderModalChips();
}

// 保存弹窗中的分类选择
async function dgpSaveCategories() {
  const id = dgpCatModalDiaryId;
  if (!id) return;
  const ids = [...dgpCatSelected];
  const btn = $('cat-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const { error } = await sb.from('diary')
      .update({ category_ids: ids, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    if (state.diaryRow && state.diaryRow.id === id) {
      state.diaryRow.category_ids = ids;
    }
    $('category-modal').classList.add('hidden');
    dgpCatPrompted.add(id);      // 已处理，避免自动再次弹出
    dgpRenderDiaryCats();
    refreshMarks();              // 日历彩色圆点
    emit('data-dirty');          // 复盘统计刷新
    showToast('分类已保存');
  } catch (err) {
    showToast('保存分类失败：' + (friendlyErr(err) || '请重试'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存分类';
  }
}

// 新增自定义分类
async function dgpAddCategory() {
  const input = $('cat-new-name');
  let name = (input.value || '').trim();
  if (!name) return;
  if (name.length > 12) name = name.slice(0, 12);
  if (dgpCategories.some((c) => c.name === name)) {
    showToast('该分类已存在');
    return;
  }
  const color = DGP_CAT_PALETTE[dgpCategories.length % DGP_CAT_PALETTE.length];
  const btn = $('cat-new-add');
  btn.disabled = true;
  try {
    const { data, error } = await sb.from('diary_categories').insert({
      user_id: state.user.id,
      name,
      color,
      is_preset: false,
      sort_order: dgpCategories.length,
    }).select().single();
    if (error) throw error;

    dgpCategories.push(data);
    dgpCatById.set(data.id, data);
    state.diaryCategories = dgpCategories;
    dgpCatSelected.add(data.id);   // 新分类默认选中
    input.value = '';
    dgpRenderModalChips();
    dgpRenderFilter();
    showToast('分类已新增');
  } catch (err) {
    showToast('新增失败：' + (friendlyErr(err) || '请重试'), 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- AI 分类推荐（预留真实接口） ---------- */

// 关键词词库：按分类名匹配，便于用户自定义同名分类也能生效
const DGP_AI_KEYWORDS = {
  '副业创业': ['副业', '项目', '客户', '变现', '收入', '产品', '上线', '运营', '流量', '合作', '生意', '商单', '接单'],
  '学习备考': ['学习', '复习', '考试', '备考', '课程', '笔记', '单词', '刷题', '阅读', '读书', '章节', '听课', '证书'],
  '情绪随笔': ['情绪', '焦虑', '难过', '开心', '压力', '平静', '烦躁', '累', '感受', '心情', '反思', '内耗', '自愈'],
  '生活日常': ['早餐', '午餐', '晚餐', '天气', '出门', '家务', '收拾', '买菜', '朋友', '电影', '日常', '周末', '散步', '做饭'],
  '感情': ['喜欢', '想念', '陪伴', '争吵', '恋人', '家人', '男朋友', '女朋友', '感情', '关系', '告白', '失恋'],
  '收支复盘': ['支出', '花费', '消费', '预算', '记账', '工资', '理财', '存款', '买了', '账单', '省钱', '收入'],
  '运动健康': ['跑步', '健身', '运动', '瑜伽', '睡眠', '早起', '喝水', '体重', '锻炼', '散步', '健康', '拉伸', '早睡'],
};

/**
 * 根据正文给出分类推荐（返回分类 id 数组）
 * 说明：这里是轻量的本地关键词打分，后续接入真实 AI 时
 *      只需替换本函数实现（例如调用大模型接口），调用方无需改动。
 */
function dgpRecommendCategories(text) {
  const content = String(text || '');
  if (!content.trim()) return [];
  const scores = dgpCategories.map((c) => {
    const words = DGP_AI_KEYWORDS[c.name] || [];
    let score = 0;
    words.forEach((w) => {
      if (content.includes(w)) score += 1;
    });
    return { id: c.id, name: c.name, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scores.slice(0, 2).map((x) => x.id);
}

// 生成 AI 推荐提示文案
function dgpAiHint(ids) {
  const names = (ids || []).map((id) => (dgpCatById.get(id) || {}).name).filter(Boolean);
  if (!names.length) return 'AI 暂未识别出明显分类，可手动选择。';
  return 'AI 建议：' + names.join('、') + '（已预选，可手动修改）';
}

/* ---------- 筛选与全文搜索 ---------- */

// 生成摘要片段（围绕关键词截取）
function dgpExcerpt(text, kw, len) {
  len = len || 90;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!kw) return t.slice(0, len) + (t.length > len ? '…' : '');
  const i = t.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return t.slice(0, len) + (t.length > len ? '…' : '');
  const start = Math.max(0, i - 30);
  return (start > 0 ? '…' : '') + t.slice(start, start + len) + (start + len < t.length ? '…' : '');
}

async function dgpRunSearch() {
  const panel = $('diary-results');
  if (!panel || !sb || !state.user) return;
  const kw = ($('diary-search').value || '').trim();
  const cat = dgpCatFilterId;

  if (!kw && !cat) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="text-xs text-faint">检索中…</p>';

  try {
    let q = sb.from('diary')
      .select('id,record_date,content,category_ids')
      .eq('user_id', state.user.id);
    if (kw) q = q.ilike('content', `%${kw}%`);
    if (cat === '__none__') q = q.or('category_ids.is.null,category_ids.eq.{}');
    else if (cat) q = q.contains('category_ids', [cat]);
    q = q.order('record_date', { ascending: false }).limit(50);

    const { data, error } = await q;
    if (error) throw error;
    dgpRenderResults(data || [], kw);
  } catch (err) {
    panel.innerHTML =
      '<p class="text-xs" style="color:var(--accent)">检索失败：请确认已在 Supabase 执行 supabase.sql（category_ids 字段）</p>';
  }
}

function dgpRenderResults(rows, kw) {
  const panel = $('diary-results');
  if (!rows.length) {
    panel.innerHTML = '<p class="text-sm text-faint py-2">没有找到匹配的日记。</p>';
    return;
  }
  const items = rows.map((r) => {
    const cats = (r.category_ids || [])
      .map((id) => dgpCatById.get(id)).filter(Boolean)
      .map((c) => `<span class="cat-chip" style="--chip:${c.color}">${escapeHTML(c.name)}</span>`)
      .join('');
    return `<div class="result-item">
        <button class="result-date" type="button" data-jump="${r.record_date}">
          ${String(r.record_date || '').slice(5).replace('-', '/')}
        </button>
        <div class="min-w-0">
          <p class="result-text">${escapeHTML(dgpExcerpt(r.content, kw))}</p>
          ${cats ? `<div class="flex flex-wrap gap-1 mt-1">${cats}</div>` : ''}
        </div>
      </div>`;
  }).join('');
  panel.innerHTML = `<div class="flex items-center justify-between mb-2">
      <p class="text-xs text-faint">共 ${rows.length} 条结果</p>
      <button class="link-btn text-xs" type="button" data-clear-search>清除筛选</button>
    </div>
    <div class="space-y-1.5 max-h-72 overflow-y-auto scroll-area">${items}</div>`;
}

// 清除筛选与搜索
function dgpClearSearch() {
  dgpCatFilterId = '';
  const sel = $('diary-filter');
  if (sel) sel.value = '';
  const input = $('diary-search');
  if (input) input.value = '';
  const panel = $('diary-results');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
}

/* ---------- 模块生命周期 ---------- */

async function dgpCategoriesEnter() {
  if (!sb || !state.user) return;
  await dgpLoadCategories(true);
  dgpRenderFilter();
  dgpRenderDiaryCats();
  refreshMarks();          // 分类加载完成后重新着色日历圆点
  emit('data-dirty');      // 通知复盘仪表盘按最新分类重新统计
}

function dgpCategoriesExit() {
  dgpCategories = [];
  dgpCatById = new Map();
  dgpCatSelected = new Set();
  dgpCatPrompted = new Set();
  dgpCatModalDiaryId = null;
  dgpCatAvailable = true;
  dgpCatWarned = false;
  state.diaryCategories = [];
  dgpClearSearch();
  const box = $('diary-cats');
  if (box) box.innerHTML = '';
  const chipBox = $('cat-chips');
  if (chipBox) chipBox.innerHTML = '';
  const hint = $('cat-ai-hint');
  if (hint) hint.textContent = '';
  const modal = $('category-modal');
  if (modal) modal.classList.add('hidden');
}

/* ---------- 事件绑定 ---------- */

document.addEventListener('dgp:board-enter', dgpCategoriesEnter);
document.addEventListener('dgp:board-exit', dgpCategoriesExit);

document.addEventListener('dgp:diary-loaded', () => {
  dgpRenderDiaryCats();
});

// 保存后智能提示分类（每篇日记只自动弹一次）
document.addEventListener('dgp:diary-saved', (e) => {
  const detail = e.detail || {};
  const id = detail.id;
  if (!dgpCatAvailable || !id) return;
  if (dgpCatPrompted.has(id)) return;
  if (($('category-modal') && !$('category-modal').classList.contains('hidden'))) return;

  const text = String(detail.content || '').trim();
  if (text.length < 10) return;

  const row = (state.diaryRow && state.diaryRow.id === id) ? state.diaryRow : null;
  if (row && row.category_ids && row.category_ids.length) return;

  dgpCatPrompted.add(id);
  const aiIds = dgpRecommendCategories(text);
  dgpOpenCategoryModal(id, { aiIds: aiIds, hintText: dgpAiHint(aiIds) });
});

// 弹窗内分类多选
const dgpChipBox = $('cat-chips');
if (dgpChipBox) {
  dgpChipBox.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat-id]');
    if (!chip) return;
    const id = chip.dataset.catId;
    if (dgpCatSelected.has(id)) dgpCatSelected.delete(id);
    else dgpCatSelected.add(id);
    dgpRenderModalChips();
  });
}

const dgpCatNewAdd = $('cat-new-add');
if (dgpCatNewAdd) dgpCatNewAdd.addEventListener('click', dgpAddCategory);

const dgpCatNewName = $('cat-new-name');
if (dgpCatNewName) {
  dgpCatNewName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dgpAddCategory();
    }
  });
}

const dgpCatSave = $('cat-save');
if (dgpCatSave) dgpCatSave.addEventListener('click', dgpSaveCategories);

const dgpCatCancel = $('cat-cancel');
if (dgpCatCancel) {
  dgpCatCancel.addEventListener('click', () => {
    $('category-modal').classList.add('hidden');
    if (dgpCatModalDiaryId) dgpCatPrompted.add(dgpCatModalDiaryId);
  });
}

// 主动点击「编辑分类」
const dgpBtnEditCats = $('btn-edit-cats');
if (dgpBtnEditCats) {
  dgpBtnEditCats.addEventListener('click', () => {
    if (!state.diaryId) {
      showToast('请先写点内容，保存后即可分类');
      return;
    }
    dgpOpenCategoryModal(state.diaryId, {
      hintText: '为这篇日记选择分类，可多选。',
    });
  });
}

// 主动点击「AI 推荐分类」
const dgpBtnAiCat = $('btn-ai-cat');
if (dgpBtnAiCat) {
  dgpBtnAiCat.addEventListener('click', () => {
    if (!state.diaryId) {
      showToast('请先写点内容，保存后即可分类');
      return;
    }
    const text = $('diary-content').value || '';
    if (!text.trim()) {
      showToast('先写点内容，AI 才能给出建议');
      return;
    }
    const aiIds = dgpRecommendCategories(text);
    dgpOpenCategoryModal(state.diaryId, {
      aiIds: aiIds,
      hintText: dgpAiHint(aiIds),
    });
  });
}

// 筛选下拉
const dgpFilterSel = $('diary-filter');
if (dgpFilterSel) {
  dgpFilterSel.addEventListener('change', () => {
    dgpCatFilterId = dgpFilterSel.value;
    dgpRunSearch();
  });
}

// 全文搜索（输入防抖）
const dgpSearchInput = $('diary-search');
if (dgpSearchInput) {
  dgpSearchInput.addEventListener('input', () => {
    clearTimeout(dgpCatSearchTimer);
    dgpCatSearchTimer = setTimeout(dgpRunSearch, 320);
  });
  dgpSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(dgpCatSearchTimer);
      dgpRunSearch();
    }
  });
}

// 搜索结果：跳转日期 / 清除筛选
const dgpResultsBox = $('diary-results');
if (dgpResultsBox) {
  dgpResultsBox.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      selectDate(jump.dataset.jump);
      return;
    }
    if (e.target.closest('[data-clear-search]')) dgpClearSearch();
  });
}
