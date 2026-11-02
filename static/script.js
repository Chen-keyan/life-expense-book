// ============================================================
//  生活费账本 · script.js
//  【四件套角色】门面的水电开关：监听用户动作 → fetch 喊厨房 → 把结果画到页面上
//
//  一条完整的数据流：点按钮 → 发请求 → app.py 处理 → 读写 data.db → 响应回来 → 更新页面
// ============================================================

const appEl = document.getElementById('app');

// 厨房塞在 data-* 里的分类清单
const CATS = {
  expense: JSON.parse(appEl.dataset.expenseCats),
  income: JSON.parse(appEl.dataset.incomeCats),
};

// 每个分类长什么样：一个 emoji + 一个颜色（环形图靠它上色）
const META = {
  餐饮: { emoji: '🍚', color: '#C34F2B' },
  奶茶: { emoji: '🧋', color: '#D98A5F' },
  交通: { emoji: '🚌', color: '#4C7C93' },
  购物: { emoji: '🛍️', color: '#E0A33E' },
  娱乐: { emoji: '🎮', color: '#8C6AA8' },
  学习: { emoji: '📚', color: '#3F6B4E' },
  日用: { emoji: '🧴', color: '#7E8C56' },
  医疗: { emoji: '💊', color: '#C47A72' },
  话费: { emoji: '📱', color: '#5A616E' },
  其他: { emoji: '✨', color: '#A3907E' },
  生活费: { emoji: '💰', color: '#3F6B4E' },
  兼职: { emoji: '💼', color: '#4C7C93' },
  奖学金: { emoji: '🎓', color: '#E0A33E' },
  红包: { emoji: '🧧', color: '#C34F2B' },
};
const meta = name => META[name] || { emoji: '✨', color: '#A3907E' };

// ---------- 小工具 ----------
const n2 = v => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = v => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = id => document.getElementById(id);

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthOf = s => s.slice(0, 7);
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- 状态 ----------
let month = monthOf(todayStr());
// 支持 ?month=2026-10 直接看某个月（方便存书签/发给同学）
const urlMonth = new URLSearchParams(location.search).get('month');
if (urlMonth && /^\d{4}-\d{2}$/.test(urlMonth)) month = urlMonth;
let stats = null;
let records = [];
let formType = 'expense';
let formCat = CATS.expense[0];
let editingId = null;      // null = 正在"记一笔"；有值 = 正在修改那一笔

// ============================================================
//  渲染：首屏仪表盘
// ============================================================
function renderHero() {
  const s = stats;
  const over = s.budget_left < 0;
  const usedPct = Math.min(s.used_pct, 100);

  // 半圆进度：pathLength=100，所以 dasharray 的"100"就是整条弧
  // 注意必须写到 style 上——CSS 里那条 stroke-dasharray 会盖掉 HTML 属性
  const fill = $('gauge-fill');
  fill.style.strokeDasharray = `${usedPct} 100`;
  fill.classList.toggle('over', over);

  $('gauge-label').textContent = over ? '已超支' : '本月还能花';
  // 首屏只给整数：角分放在这里既挤又没用
  $('gauge-amount').textContent = over
    ? `-¥${n0(Math.abs(s.budget_left))}`
    : `¥${n0(s.budget_left)}`;

  $('hero-eyebrow').textContent = s.count
    ? `已花 ¥${n2(s.total_expense)} · 预算 ¥${n0(s.budget)} · 已用 ${s.used_pct}%`
    : `预算 ¥${n0(s.budget)} · 还没开始记`;

  // —— 一句话结论：先把"照这么花下去会怎样"说清楚
  let verdict;
  if (s.count === 0) {
    verdict = '这个月还是一张白纸。';
  } else if (s.is_current && s.projected_expense !== null) {
    const gap = s.projected_left;
    verdict = gap < 0
      ? `照前 ${s.elapsed_days} 天的花法，月底要花 ¥${n0(s.projected_expense)}，<b class="warn">超预算 ¥${n0(-gap)}</b>。`
      : `照前 ${s.elapsed_days} 天的花法，月底花 ¥${n0(s.projected_expense)}，还能剩 <b>¥${n0(gap)}</b>。`;
  } else if (s.is_current) {
    // 月初头两天，样本太少，不硬着头皮预测
    verdict = `这月已经花了 <b>¥${n0(s.total_expense)}</b>。`;
  } else if (s.month < monthOf(todayStr())) {
    // 过完的月份：跟预算比，而不是跟收入比，口径要统一
    verdict = s.budget_left >= 0
      ? `这个月花了 ¥${n0(s.total_expense)}，预算还剩 <b>¥${n0(s.budget_left)}</b>。`
      : `这个月花了 ¥${n0(s.total_expense)}，<b class="warn">超预算 ¥${n0(-s.budget_left)}</b>。`;
  } else {
    verdict = '这个月还没到。';
  }
  $('hero-verdict').innerHTML = verdict;

  // —— 第二行：钱到底去哪了
  if (s.count === 0) {
    $('hero-diagnosis').textContent = '记下第一笔，这里会告诉你钱是怎么没的。';
  } else {
    let text = `钱主要花在 <b>${esc(s.top_category)}</b> 上，¥${n2(s.top_category_total)}，占了 ${s.top_category_pct}%`;
    text += s.by_category.length > 1 ? `；其次是 ${esc(s.by_category[1].category)}（${s.by_category[1].pct}%）。` : '。';
    if (s.is_current && s.days_left > 0 && !over) {
      text += ` 后面 ${s.days_left} 天，每天别超过 ¥${n2(s.per_day_left)}。`;
    }
    $('hero-diagnosis').innerHTML = text;
  }

  $('fact-days').textContent = s.days_left > 0 ? `${s.days_left} 天` : '已过完';
  $('fact-perday').textContent = s.days_left > 0 ? `¥${n2(s.per_day_left)}` : '—';
  $('fact-count').textContent = `${s.count} 笔`;
  $('fact-income').textContent = `¥${n0(s.total_income)}`;
  $('foot-budget').textContent = `¥${n0(s.budget)}`;

  $('month-label').textContent = `${s.month.slice(0, 4)} 年 ${Number(s.month.slice(5))} 月`;
  $('back-today').classList.toggle('is-hidden', s.is_current);
}

// ============================================================
//  渲染：钱去哪了（环形图 + 图例）
// ============================================================
function renderDonut() {
  const s = stats;
  const donut = $('donut');
  const legend = $('legend');
  const empty = $('donut-empty');

  const has = s.by_category.length > 0 && s.total_expense > 0;
  empty.classList.toggle('is-hidden', has);

  if (!has) {
    donut.style.background = 'var(--track)';
    legend.innerHTML = '';
    $('donut-total').textContent = '¥0';
    return;
  }

  // 用累计金额算百分比，避免四舍五入后留下缝隙
  let acc = 0;
  const stops = s.by_category.map(c => {
    const from = acc / s.total_expense * 100;
    acc += c.total;
    const to = acc / s.total_expense * 100;
    return `${meta(c.category).color} ${from.toFixed(3)}% ${to.toFixed(3)}%`;
  });
  donut.style.background = `conic-gradient(from -90deg, ${stops.join(',')})`;
  $('donut-total').textContent = `¥${n0(s.total_expense)}`;

  legend.innerHTML = s.by_category.map(c => `
    <li>
      <span class="dot" style="background:${meta(c.category).color}"></span>
      <span class="name">${esc(c.category)}</span>
      <span class="pct">${c.pct}%</span>
      <span class="val">¥${n2(c.total)}</span>
    </li>
  `).join('');
}

// ============================================================
//  渲染：每天花了多少
// ============================================================
function renderBars() {
  const s = stats;
  // 看本月时只画"已经过去的日子"，否则 30 格里有 28 格是空的，什么都看不出来
  const elapsed = s.is_current ? Number(todayStr().slice(8)) : s.daily.length;
  const daily = s.daily.slice(0, Math.max(elapsed, 1));
  const rawMax = Math.max(...daily, 0);        // 真实最大值，可能为 0
  const max = Math.max(rawMax, 1);             // 只用来算高度，避免除以 0
  const bars = $('bars');
  const axis = $('bars-axis');
  const mon = Number(s.month.slice(5));

  $('bars-note').textContent = daily.length >= s.daily.length
    ? `${mon} 月每天`
    : `${mon} 月 1—${daily.length} 日`;

  // 一分钱都没花：别画一排 0 高度的空柱子，直接说一句话
  $('bars-budget').classList.add('is-hidden');
  if (rawMax <= 0) {
    bars.innerHTML = '<p class="chart-empty">这个月还没有支出</p>';
    axis.innerHTML = '';
    $('bars-tip').textContent = '记下第一笔，这里会长出柱子。';
    return;
  }

  bars.innerHTML = daily.map((v, i) => {
    const h = v > 0 ? Math.max(v / max * 100, 4) : 0;
    const cls = v === 0 ? 'zero' : (v === max ? 'peak' : '');
    return `<div class="bar ${cls}" style="height:${h}%"
                 title="${mon} 月 ${i + 1} 日 · ¥${n2(v)}"></div>`;
  }).join('');

  axis.innerHTML = daily.map((_, i) => {
    const d = i + 1;
    const step = daily.length > 20 ? 5 : (daily.length > 10 ? 3 : 1);
    const show = d === 1 || d % step === 0 || d === daily.length;
    return `<span>${show ? d : ''}</span>`;
  }).join('');

  // 每天额度参考线：把"每天还能花多少"画到柱子上，一眼看出哪天花猛了
  const line = $('bars-budget');
  const cap = s.per_day_left;
  const showLine = s.is_current && s.days_left > 0 && cap > 0 && max > 0 && cap < max * 3;
  line.classList.toggle('is-hidden', !showLine);
  if (showLine) {
    // 柱子区实际高度 = 128 - 顶部 6px 内边距
    const h = Math.min(cap / max, 1) * 122;
    line.style.bottom = `${h}px`;
    $('bars-budget-label').textContent = `每天额度 ¥${n0(cap)}`;
  }

  // 找出花得最狠的一天 + 超额度天数
  const maxIdx = daily.indexOf(max);
  const spentDays = daily.filter(v => v > 0).length;
  if (max <= 0) {
    $('bars-tip').textContent = '这几天还没有支出记录。';
  } else {
    let text = `花得最狠的是 <b>${mon} 月 ${maxIdx + 1} 日</b>，¥${n2(max)}。`;
    if (showLine) {
      const overDays = daily.filter(v => v > cap).length;
      text += overDays
        ? ` 有 <b>${overDays}</b> 天超过了每天额度 ¥${n0(cap)}。`
        : ` 每天都在每天额度 ¥${n0(cap)} 以内，稳。`;
    } else {
      const avg = s.total_expense / Math.max(spentDays, 1);
      text += ` 有花钱的 ${spentDays} 天里，平均每天 ¥${n2(avg)}。`;
    }
    $('bars-tip').innerHTML = text;
  }
}

// ============================================================
//  渲染：流水（按日期分组）
// ============================================================
function renderFlow() {
  const box = $('flow');
  $('flow-note').textContent = records.length ? `共 ${records.length} 笔` : '';

  if (!records.length) {
    box.innerHTML = '';
    $('flow-empty').classList.remove('is-hidden');
    return;
  }
  $('flow-empty').classList.add('is-hidden');

  // 按日期分组（记录本身已经按时间倒序）
  const groups = new Map();
  for (const r of records) {
    const day = r.created_at.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(r);
  }

  const today = todayStr();
  const html = [...groups.entries()].map(([day, list]) => {
    const dt = new Date(day + 'T00:00:00');
    const spend = list.filter(r => r.type === 'expense').reduce((a, r) => a + r.amount, 0);
    const gain = list.filter(r => r.type === 'income').reduce((a, r) => a + r.amount, 0);
    const tag = day === today ? '今天' : WEEK[dt.getDay()];

    const sums = [];
    if (spend > 0) sums.push(`支出 ¥${n2(spend)}`);
    if (gain > 0) sums.push(`收入 ¥${n2(gain)}`);

    const rows = list.map(r => `
      <li data-id="${r.id}">
        <span class="ico">${meta(r.category).emoji}</span>
        <span class="desc">
          <b>${esc(r.category)}</b>
          <i>${r.note ? esc(r.note) + ' · ' : ''}${r.created_at.slice(11)}</i>
        </span>
        <span class="amt ${r.type}">
          ${r.type === 'income' ? '+' : '−'}¥${n2(r.amount)}
        </span>
        <button class="edit" data-id="${r.id}" title="修改">✎</button>
        <button class="del" data-id="${r.id}" title="删除">×</button>
      </li>
    `).join('');

    return `
      <div class="day">
        <div class="day-head">
          <span class="day-date"><b>${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日</b>${tag}</span>
          <span class="day-sum">${sums.join(' · ')}</span>
        </div>
        <ul class="rows">${rows}</ul>
      </div>
    `;
  }).join('');

  box.innerHTML = html;
}

// ============================================================
//  一次性刷新
// ============================================================
async function refresh() {
  const [recRes, statRes] = await Promise.all([
    fetch(`/api/records?month=${month}`),
    fetch(`/api/stats?month=${month}`),
  ]);
  records = await recRes.json();
  stats = await statRes.json();
  renderHero();
  renderDonut();
  renderBars();
  renderFlow();
}

// ============================================================
//  月份切换
// ============================================================
$('prev-month').addEventListener('click', () => { month = shiftMonth(month, -1); refresh(); });
$('next-month').addEventListener('click', () => { month = shiftMonth(month, 1); refresh(); });
$('back-today').addEventListener('click', () => { month = monthOf(todayStr()); refresh(); });

// ============================================================
//  记一笔弹层
// ============================================================
const addDialog = $('add-dialog');

function paintCatGrid() {
  $('cat-label').textContent = formType === 'income' ? '从哪来' : '花在哪';
  $('cat-grid').innerHTML = CATS[formType].map(c => `
    <button type="button" class="cat-chip ${c === formCat ? 'is-active' : ''}" data-cat="${c}">
      <span class="emoji">${meta(c).emoji}</span>${esc(c)}
    </button>
  `).join('');
}

$('cat-grid').addEventListener('click', e => {
  const chip = e.target.closest('.cat-chip');
  if (!chip) return;
  formCat = chip.dataset.cat;
  paintCatGrid();
});

$('type-seg').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  formType = btn.dataset.type;
  formCat = CATS[formType][0];          // 换了收支类型，分类也得重置
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('is-active', b === btn));
  paintCatGrid();
});

// 同一个弹层干两件事：传 record 就是"改一笔"，不传就是"记一笔"
function openDialog(record) {
  editingId = record ? record.id : null;
  formType = record ? record.type : 'expense';
  formCat = record ? record.category : CATS.expense[0];

  document.querySelectorAll('.seg-btn').forEach(b =>
    b.classList.toggle('is-active', b.dataset.type === formType));
  paintCatGrid();

  $('f-amount').value = record ? record.amount : '';
  $('f-note').value = record ? (record.note || '') : '';
  $('f-date').value = record
    ? record.created_at.slice(0, 10)
    // 新增时：看着本月就填今天，看着别的月份就填那个月的 1 号
    : (month === monthOf(todayStr()) ? todayStr() : `${month}-01`);
  $('form-msg').textContent = '';

  $('sheet-title').textContent = record ? '改一笔' : '记一笔';
  $('submit-btn').textContent = record ? '保存修改' : '记下这一笔';

  addDialog.showModal();
  $('f-amount').focus();
  $('f-amount').select();
}

$('open-add').addEventListener('click', () => openDialog(null));

// 按 Esc 或 × 关掉弹层时，一定要退出"修改模式"，
// 否则下次点"记一笔"会变成去改上一笔
addDialog.addEventListener('close', () => { editingId = null; });

$('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const amount = $('f-amount').value;
  if (!amount || Number(amount) <= 0) {
    $('form-msg').textContent = '先填个金额吧';
    return;
  }

  // 改 → PUT /api/records/<id>；增 → POST /api/records
  const res = await fetch(editingId ? `/api/records/${editingId}` : '/api/records', {
    method: editingId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount, type: formType, category: formCat,
      note: $('f-note').value, date: $('f-date').value,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    $('form-msg').textContent = err.error || '没存上，重试一下';
    return;
  }

  const saved = await res.json();
  month = monthOf(saved.created_at);   // 补记/改到别的月份时，自动跳过去看一眼
  addDialog.close();
  editingId = null;
  refresh();
});

// ============================================================
//  删除
// ============================================================
$('flow').addEventListener('click', async e => {
  const del = e.target.closest('.del');
  if (del) {
    await fetch(`/api/records/${del.dataset.id}`, { method: 'DELETE' });
    refresh();
    return;
  }

  // 点这一行的任何地方（除了删除）都能改 —— 不用非得瞄准那个小铅笔
  const row = e.target.closest('li[data-id]');
  if (!row) return;
  const rec = records.find(r => r.id === Number(row.dataset.id));
  if (rec) openDialog(rec);
});

// ============================================================
//  预算 / 示例数据 / 清空
// ============================================================
const budgetDialog = $('budget-dialog');

$('open-budget').addEventListener('click', () => {
  $('f-budget').value = stats ? Math.round(stats.budget) : 1500;
  budgetDialog.showModal();
  $('f-budget').select();
});

$('budget-form').addEventListener('submit', async e => {
  e.preventDefault();
  const budget = $('f-budget').value;
  if (!budget || Number(budget) <= 0) return;
  await fetch('/api/budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ budget }),
  });
  budgetDialog.close();
  refresh();
});

$('load-demo').addEventListener('click', async () => {
  await fetch('/api/demo', { method: 'POST' });
  month = monthOf(todayStr());
  refresh();
});

$('clear-all').addEventListener('click', async () => {
  if (!confirm('确定清空所有记录？这个操作没法撤销。')) return;
  await fetch('/api/records/all', { method: 'DELETE' });
  refresh();
});

// ============================================================
//  弹层通用关闭
// ============================================================
document.querySelectorAll('dialog').forEach(dlg => {
  dlg.addEventListener('click', e => {
    if (e.target === dlg) dlg.close();           // 点遮罩关闭
  });
});
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

// ============================================================
//  开张
// ============================================================
refresh().then(() => {
  // 带 #add 打开就直接弹"记一笔"，方便存成书签
  if (location.hash === '#add') {
    openDialog(null);
    return;
  }
  // 带 ?edit=<id> 打开就直接弹出那一笔的修改框
  const editId = new URLSearchParams(location.search).get('edit');
  if (editId) {
    const rec = records.find(r => r.id === Number(editId));
    if (rec) openDialog(rec);
  }
});
