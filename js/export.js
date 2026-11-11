'use strict';

/* =============================================================
 * js/export.js · 导出增强模块
 * -------------------------------------------------------------
 * 职责：
 *   1. 复用 app.js 的 collectUserData 汇总数据
 *   2. 导出 Markdown（.md，便于二次编辑 / 归档）
 *   3. 导出 PDF（调用浏览器打印，选择「另存为 PDF」）
 *   4. 绑定顶部「导出」菜单（JSON / Markdown / PDF）
 * 依赖：app.js 暴露的 state / sb / $ / escapeHTML / showToast /
 *       collectUserData / exportUserData / formatDate / parseDate / weekCN
 * ============================================================= */

/* ---------- 通用工具 ---------- */

function dgpDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function dgpFileTag() {
  return todayStr().replace(/-/g, '');
}

// 分类 id -> 名称
function dgpExportCatMap(data) {
  return new Map((data.diary_categories || []).map((c) => [c.id, c]));
}

// 目标周期范围（与 goals.js 保持一致）
function dgpExportGoalRange(period, type) {
  if (type === 'quarter') {
    const parts = period.split('-Q');
    const y = Number(parts[0]);
    const q = Number(parts[1]);
    const startM = (q - 1) * 3;
    return {
      start: `${y}-${String(startM + 1).padStart(2, '0')}-01`,
      end: formatDate(new Date(y, startM + 3, 0)),
    };
  }
  const parts = period.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return { start: `${period}-01`, end: formatDate(new Date(y, m, 0)) };
}

function dgpExportGoalLabel(period, type) {
  if (!period) return '';
  if (type === 'quarter') {
    const p = period.split('-Q');
    return `${p[0]} 年第 ${p[1]} 季度`;
  }
  const p = period.split('-');
  return `${p[0]} 年 ${Number(p[1])} 月`;
}

// 计算目标完成值（手动 / 已完成待办 / 习惯打卡）
function dgpExportGoalValue(g, data) {
  const range = dgpExportGoalRange(g.period, g.type);
  if (g.link_type === 'todo') {
    return (data.todos || []).filter((t) =>
      t.is_completed && t.record_date >= range.start && t.record_date <= range.end
    ).length;
  }
  if (g.link_type === 'habit' && g.link_id) {
    return (data.habit_logs || []).filter((l) =>
      l.habit_id === g.link_id && l.log_date >= range.start && l.log_date <= range.end
    ).length;
  }
  return Number(g.current_value) || 0;
}

/* ---------- Markdown ---------- */

function dgpBuildMarkdown(data) {
  const catMap = dgpExportCatMap(data);
  const lines = [];
  const diaryCount = (data.diary || []).filter((d) => String(d.content || '').trim()).length;
  const todoDone = (data.todos || []).filter((t) => t.is_completed).length;
  const logCount = (data.habit_logs || []).length;

  lines.push('# 每日成长计划 · 数据导出');
  lines.push('');
  lines.push(`- 导出时间：${new Date(data.exported_at).toLocaleString('zh-CN')}`);
  if (data.user_email) lines.push(`- 账号：${data.user_email}`);
  lines.push(`- 数据概览：日记 ${diaryCount} 篇 · 待办完成 ${todoDone} 项 · 打卡 ${logCount} 次`);
  lines.push('');

  // ---- 按日期归并 ----
  const byDate = new Map();
  const ensure = (ds) => {
    if (!byDate.has(ds)) byDate.set(ds, { status: null, todos: [], diary: null });
    return byDate.get(ds);
  };
  (data.daily_status || []).forEach((r) => {
    const g = ensure(r.record_date);
    if (!g.status) g.status = r;
  });
  (data.todos || []).forEach((r) => ensure(r.record_date).todos.push(r));
  (data.diary || []).forEach((r) => {
    const g = ensure(r.record_date);
    if (!g.diary) g.diary = r;
  });

  const dates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  if (dates.length) {
    lines.push('## 每日记录');
    lines.push('');
    dates.forEach((ds) => {
      const g = byDate.get(ds);
      const d = parseDate(ds);
      lines.push(`### ${ds}（${weekCN(d)}）`);
      lines.push('');

      if (g.status && (g.status.mood || g.status.content)) {
        if (g.status.mood) lines.push(`**心情**：${g.status.mood}`);
        if (g.status.content) {
          lines.push('');
          lines.push(g.status.content);
        }
        lines.push('');
      }

      if (g.todos.length) {
        lines.push('**待办**');
        lines.push('');
        g.todos.forEach((t) => {
          lines.push(`- [${t.is_completed ? 'x' : ' '}] ${t.title}（${t.priority || '中'}）`);
        });
        lines.push('');
      }

      if (g.diary && String(g.diary.content || '').trim()) {
        const cats = (g.diary.category_ids || [])
          .map((id) => catMap.get(id))
          .filter(Boolean)
          .map((c) => c.name);
        lines.push(`**日记**${cats.length ? '｜分类：' + cats.join('、') : ''}`);
        lines.push('');
        lines.push(g.diary.content);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    });
  }

  // ---- 习惯 ----
  if ((data.habits || []).length) {
    lines.push('## 习惯打卡');
    lines.push('');
    data.habits.forEach((h) => {
      const logs = (data.habit_logs || [])
        .filter((l) => l.habit_id === h.id)
        .map((l) => l.log_date)
        .sort();
      lines.push(`### ${h.icon || '🌱'} ${h.name}`);
      lines.push('');
      lines.push(`- 累计打卡：${logs.length} 次`);
      if (logs.length) lines.push(`- 打卡日期：${logs.join('、')}`);
      lines.push('');
    });
  }

  // ---- 目标 ----
  if ((data.goals || []).length) {
    lines.push('## 目标管理');
    lines.push('');
    data.goals.forEach((g) => {
      const cur = dgpExportGoalValue(g, data);
      const target = Math.max(1, Number(g.target_value) || 1);
      const pct = Math.min(100, Math.round((cur / target) * 100));
      lines.push(`- **${g.title}**（${dgpExportGoalLabel(g.period, g.type)}）：${cur} / ${target}，完成 ${pct}%`);
    });
    lines.push('');
  }

  return '\ufeff' + lines.join('\n');
}

async function dgpExportMarkdown(userId, email, btn) {
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const data = await collectUserData(userId, email);
    const name = (email || 'user').split('@')[0];
    dgpDownload(`${name}_成长计划_${dgpFileTag()}.md`, dgpBuildMarkdown(data), 'text/markdown;charset=utf-8');
    showToast('Markdown 已导出');
  } catch (err) {
    showToast('导出失败：' + (friendlyErr(err) || '请稍后重试'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

/* ---------- PDF（浏览器打印另存） ---------- */

function dgpBuildPrintHTML(data) {
  const catMap = dgpExportCatMap(data);
  const esc = escapeHTML;
  const diaryCount = (data.diary || []).filter((d) => String(d.content || '').trim()).length;
  const todoDone = (data.todos || []).filter((t) => t.is_completed).length;
  const logCount = (data.habit_logs || []).length;

  const byDate = new Map();
  const ensure = (ds) => {
    if (!byDate.has(ds)) byDate.set(ds, { status: null, todos: [], diary: null });
    return byDate.get(ds);
  };
  (data.daily_status || []).forEach((r) => { const g = ensure(r.record_date); if (!g.status) g.status = r; });
  (data.todos || []).forEach((r) => ensure(r.record_date).todos.push(r));
  (data.diary || []).forEach((r) => { const g = ensure(r.record_date); if (!g.diary) g.diary = r; });
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  const blocks = dates.map((ds) => {
    const g = byDate.get(ds);
    const d = parseDate(ds);
    let html = `<section class="day">
        <h3>${ds}　${weekCN(d)}</h3>`;

    if (g.status && (g.status.mood || g.status.content)) {
      if (g.status.mood) html += `<p class="mood">心情：${esc(g.status.mood)}</p>`;
      if (g.status.content) html += `<p class="text">${esc(g.status.content).replace(/\n/g, '<br>')}</p>`;
    }

    if (g.todos.length) {
      html += '<ul class="todos">' + g.todos.map((t) =>
        `<li class="${t.is_completed ? 'done' : ''}">${t.is_completed ? '☑' : '☐'} ${esc(t.title)}
          <span class="pri">${esc(t.priority || '')}</span></li>`).join('') + '</ul>';
    }

    if (g.diary && String(g.diary.content || '').trim()) {
      const tags = (g.diary.category_ids || [])
        .map((id) => catMap.get(id)).filter(Boolean)
        .map((c) => `<span class="tag" style="color:${c.color};border-color:${c.color}">${esc(c.name)}</span>`)
        .join('');
      if (tags) html += `<p class="tags">${tags}</p>`;
      html += `<p class="diary">${esc(g.diary.content).replace(/\n/g, '<br>')}</p>`;
    }

    html += '</section>';
    return html;
  }).join('');

  const habitBlock = (data.habits || []).length
    ? `<section class="block"><h2>习惯打卡</h2>${
        data.habits.map((h) => {
          const n = (data.habit_logs || []).filter((l) => l.habit_id === h.id).length;
          return `<p class="line">${esc(h.icon || '🌱')} ${esc(h.name)}　累计 ${n} 次</p>`;
        }).join('')
      }</section>`
    : '';

  const goalBlock = (data.goals || []).length
    ? `<section class="block"><h2>目标管理</h2>${
        data.goals.map((g) => {
          const cur = dgpExportGoalValue(g, data);
          const target = Math.max(1, Number(g.target_value) || 1);
          const pct = Math.min(100, Math.round((cur / target) * 100));
          return `<p class="line">${esc(g.title)}（${esc(dgpExportGoalLabel(g.period, g.type))}）
            　${cur} / ${target}，完成 ${pct}%</p>`;
        }).join('')
      }</section>`
    : '';

  const title = `每日成长计划_${(data.user_email || 'user').split('@')[0]}_${dgpFileTag()}`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>${esc(title)}</title>
    <style>
      @page { size: A4; margin: 14mm 12mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0; color: #3d342b; background: #fff;
        font-family: "Songti SC", "STSong", "Noto Serif SC", "SimSun", serif;
        font-size: 12px; line-height: 1.9;
      }
      h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: 2px; }
      h2 { font-size: 15px; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e8ded0; }
      h3 { font-size: 13px; margin: 0 0 6px; color: #8f5f3e; }
      .meta { color: #8a7c6d; font-size: 11px; margin-bottom: 4px; }
      .overview { color: #6b5f53; font-size: 11.5px; margin: 6px 0 14px; }
      .day { border: 1px solid #eee3d4; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; page-break-inside: avoid; }
      .mood { margin: 0 0 3px; color: #a9744f; font-size: 11.5px; }
      .text, .diary { margin: 0 0 5px; white-space: pre-wrap; }
      .diary { padding-top: 5px; border-top: 1px dashed #eee3d4; }
      .todos { margin: 0 0 5px; padding-left: 15px; }
      .todos li { margin: 1px 0; }
      .todos li.done { color: #a99f92; text-decoration: line-through; }
      .pri { color: #b0a394; font-size: 10px; }
      .tag { display: inline-block; border: 1px solid; border-radius: 10px; padding: 0 6px; font-size: 10px; margin: 0 4px 4px 0; }
      .tags { margin: 0 0 4px; }
      .line { margin: 2px 0; }
      .block { page-break-inside: avoid; }
      footer { margin-top: 16px; padding-top: 6px; border-top: 1px solid #eee3d4; color: #b0a394; font-size: 10px; text-align: center; }
    </style></head><body>
      <h1>每日成长计划 · 记录导出</h1>
      <p class="meta">账号：${esc(data.user_email || '—')}　|　导出时间：${new Date(data.exported_at).toLocaleString('zh-CN')}</p>
      <p class="overview">日记 ${diaryCount} 篇　·　待办完成 ${todoDone} 项　·　打卡 ${logCount} 次</p>
      ${habitBlock}${goalBlock}
      <h2>每日记录</h2>
      ${blocks || '<p class="line">暂无记录</p>'}
      <footer>由「每日成长计划」生成</footer>
    </body></html>`;
}

function dgpPrintHTML(html) {
  const old = document.getElementById('dgp-print-frame');
  if (old) old.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'dgp-print-frame';
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  let printed = false;
  const run = () => {
    if (printed) return;
    printed = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      showToast('已打开打印窗口，请选择「另存为 PDF」');
    } catch (e) {
      showToast('无法打开打印窗口，请稍后重试', 'error');
    }
  };
  iframe.onload = () => setTimeout(run, 200);
  setTimeout(run, 900);
}

async function dgpExportPDF(userId, email, btn) {
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
  try {
    const data = await collectUserData(userId, email);
    dgpPrintHTML(dgpBuildPrintHTML(data));
  } catch (err) {
    showToast('导出失败：' + (friendlyErr(err) || '请稍后重试'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

/* ---------- 导出菜单绑定 ---------- */

const dgpExportMenu = $('export-menu');
if (dgpExportMenu) {
  dgpExportMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn || !state.user) return;
    toggleExportMenu(false);

    const type = btn.dataset.export;
    if (type === 'json') exportUserData(state.user.id, state.user.email, null);
    else if (type === 'md') dgpExportMarkdown(state.user.id, state.user.email, null);
    else if (type === 'pdf') dgpExportPDF(state.user.id, state.user.email, null);
  });
}
