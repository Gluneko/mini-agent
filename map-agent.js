#!/usr/bin/env node
/**
 * map-agent — 地质图生成式「工具调用 Agent」最小实现(单文件、零依赖,Node ≥ 18)
 *
 * 对应 GeoGPT MapGenerator 的核心链路:
 *   自然语言指令 → 规划成工具调用序列 → 人在回路二次确认(增/删/改/排序)→ 事务式执行 → 地图快照
 *
 * 和 agent.js 的本质区别:agent.js 是 ReAct「走一步看一步」;这里是「先规划整段、确认后再执行」。
 * 原因:制图工具有副作用(直接改用户的图),必须让人在任何副作用发生前看到完整计划。
 *
 * 运行:
 *   node map-agent.js --mock --yes                       # 无需 key,自动确认,看完整轨迹
 *   node map-agent.js --mock                             # 无需 key,进入交互式确认面板(y/d/m/e/a/n)
 *   node map-agent.js --mock "把底图换成地形图,显示指北针"  # 自定义指令
 *   OPENAI_API_KEY=xx OPENAI_BASE_URL=xx node map-agent.js "…"   # 真模型做规划
 */
const readline = require('node:readline');

// ─────────────────────── 1. 地图状态:工具作用的对象 ───────────────────────
// 生产里这是 GIS 引擎里的地图文档;这里用一个普通对象让"工具改了什么"肉眼可见
const initialMap = () => ({
  basemap: 'vector',
  background: '#ffffff',
  crs: 'EPSG:4326',
  view: { center: [113.2, 23.1], zoom: 6 },
  layers: [
    { id: 'faults',  name: '断层线', type: 'line',    style: { color: '#333333', width: 1 }, labels: true,  filter: null },
    { id: 'samples', name: '采样点', type: 'point',   style: { color: '#1f77b4', shape: 'circle' }, labels: true, filter: null },
    { id: 'strata',  name: '地层面', type: 'polygon', style: { color: '#c8b98a', opacity: 0.6 }, labels: false, filter: null },
  ],
  components: {
    title:      { text: '未命名地质图', align: 'left', color: '#000000', visible: true },
    legend:     { visible: true, fontSize: 12 },
    scalebar:   { visible: false },
    northArrow: { visible: false, style: 'simple' },
  },
});

// ─────────────────────── 2. 工具注册表:三类工具(与 MapGenerator 文档一致) ───────────────────────
// 每个工具 = 类别 + 描述(给模型看的说明书)+ 参数 schema(校验依据)+ run(对状态的副作用)
const CAT = { INIT: '地图初始化', LAYER: '图层可视化', COMP: '地图组件' };
const layerOf = (map, id) => {
  const l = map.layers.find(l => l.id === id);
  if (!l) throw new Error(`图层 ${id} 不存在(可用:${map.layers.map(l => l.id).join('/')})`);
  return l;
};

const TOOLS = {
  set_basemap: { cat: CAT.INIT, desc: '切换底图',
    params: { basemap: { type: 'string', enum: ['vector', 'satellite', 'terrain'], required: true } },
    run: (m, a) => { m.basemap = a.basemap; return `底图 → ${a.basemap}`; } },
  set_background: { cat: CAT.INIT, desc: '设置地图背景颜色',
    params: { color: { type: 'string', required: true } },
    run: (m, a) => { m.background = a.color; return `背景色 → ${a.color}`; } },
  zoom_to: { cat: CAT.INIT, desc: '把视口缩放到某图层范围',
    params: { layer: { type: 'string', required: true } },
    run: (m, a) => { layerOf(m, a.layer); m.view = { center: [112.9, 22.8], zoom: 9, fit: a.layer }; return `视口缩放到图层 ${a.layer}`; } },
  set_crs: { cat: CAT.INIT, desc: '设置坐标系',
    params: { crs: { type: 'string', enum: ['EPSG:4326', 'EPSG:3857', 'EPSG:4490'], required: true } },
    run: (m, a) => { m.crs = a.crs; return `坐标系 → ${a.crs}`; } },

  set_symbol: { cat: CAT.LAYER, desc: '修改图层符号:颜色 / 线宽(线) / 形状(点)',
    params: { layer: { type: 'string', required: true }, color: { type: 'string' }, width: { type: 'number' }, shape: { type: 'string', enum: ['circle', 'square', 'triangle'] } },
    run: (m, a) => {
      const l = layerOf(m, a.layer);
      // 业务级校验:schema 只能管类型,"线宽只能用于线图层"这种规则要在这里守
      if (a.width !== undefined && l.type !== 'line') throw new Error(`width 只能用于线图层,${a.layer} 是 ${l.type}`);
      if (a.shape !== undefined && l.type !== 'point') throw new Error(`shape 只能用于点图层,${a.layer} 是 ${l.type}`);
      const { layer, ...style } = a; Object.assign(l.style, style);
      return `图层 ${l.name} 样式 → ${JSON.stringify(style)}`;
    } },
  set_labels: { cat: CAT.LAYER, desc: '显示或隐藏图层标注',
    params: { layer: { type: 'string', required: true }, visible: { type: 'boolean', required: true } },
    run: (m, a) => { layerOf(m, a.layer).labels = a.visible; return `图层 ${a.layer} 标注 → ${a.visible ? '显示' : '隐藏'}`; } },
  filter_features: { cat: CAT.LAYER, desc: '按属性条件筛选要素',
    params: { layer: { type: 'string', required: true }, field: { type: 'string', required: true }, op: { type: 'string', enum: ['>', '<', '=', '!='], required: true }, value: { type: 'number', required: true } },
    run: (m, a) => { layerOf(m, a.layer).filter = `${a.field} ${a.op} ${a.value}`; return `图层 ${a.layer} 筛选 → ${a.field} ${a.op} ${a.value}`; } },

  set_title: { cat: CAT.COMP, desc: '设置图名文本 / 对齐 / 颜色',
    params: { text: { type: 'string' }, align: { type: 'string', enum: ['left', 'center', 'right'] }, color: { type: 'string' } },
    run: (m, a) => { Object.assign(m.components.title, a, { visible: true }); return `图名 → ${JSON.stringify(a)}`; } },
  set_legend: { cat: CAT.COMP, desc: '图例显隐与字号',
    params: { visible: { type: 'boolean' }, fontSize: { type: 'number' } },
    run: (m, a) => { Object.assign(m.components.legend, a); return `图例 → ${JSON.stringify(a)}`; } },
  set_scalebar: { cat: CAT.COMP, desc: '比例尺显隐',
    params: { visible: { type: 'boolean', required: true } },
    run: (m, a) => { m.components.scalebar.visible = a.visible; return `比例尺 → ${a.visible ? '显示' : '隐藏'}`; } },
  set_north_arrow: { cat: CAT.COMP, desc: '指北针显隐与样式',
    params: { visible: { type: 'boolean' }, style: { type: 'string', enum: ['simple', 'compass', 'arrow'] } },
    run: (m, a) => { Object.assign(m.components.northArrow, a); return `指北针 → ${JSON.stringify(a)}`; } },
};

// 参数校验(护栏第一层):必填 / 类型 / 枚举 / 未知参数——模型输出永远当不可信输入
function validate(tool, args) {
  const t = TOOLS[tool];
  if (!t) throw new Error(`未知工具 ${tool}`);
  for (const [k, p] of Object.entries(t.params)) {
    if (p.required && args[k] === undefined) throw new Error(`${tool} 缺少必填参数 ${k}`);
    if (args[k] === undefined) continue;
    if (typeof args[k] !== p.type) throw new Error(`${tool}.${k} 应为 ${p.type},收到 ${typeof args[k]}`);
    if (p.enum && !p.enum.includes(args[k])) throw new Error(`${tool}.${k} 只能是 ${p.enum.join('/')},收到 ${args[k]}`);
  }
  for (const k of Object.keys(args)) if (!t.params[k]) throw new Error(`${tool} 不认识参数 ${k}`);
}

// ─────────────────────── 3. 规划器:自然语言 → 工具调用序列 ───────────────────────
// 真模型:把工具目录当说明书发给模型,要求返回 JSON 计划(结构化输出)
async function planWithModel(command) {
  const catalog = Object.entries(TOOLS).map(([name, t]) =>
    `- ${name}(${t.cat}):${t.desc};参数 ${JSON.stringify(Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, (p.enum ? p.enum.join('|') : p.type) + (p.required ? '*' : '')])))}`).join('\n');
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `你是地质制图助手。把用户指令拆成有序的工具调用计划,只用下列工具,只输出 JSON:{"plan":[{"tool":"…","args":{…},"why":"一句话说明"}]}。图层 id 可选:faults(断层线,line)/samples(采样点,point)/strata(地层面,polygon)。\n可用工具:\n${catalog}` },
        { role: 'user', content: command },
      ],
    }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content).plan;
}

// mock 规划器:关键词规则,让引擎无 key 也能跑通完整链路(生产里这一层就是模型)
// 按子句解析:一个逗号一件事,避免"隐藏…标注,…显示比例尺"这种跨子句误匹配——模型规划也常犯同类错,值得记住
function planWithMock(cmd) {
  const plan = [];
  const push = (tool, args, why) => plan.push({ tool, args, why });
  const layerIn = s => /断层/.test(s) ? 'faults' : /采样|样点/.test(s) ? 'samples' : /地层/.test(s) ? 'strata' : null;
  let lastLayer = 'faults';
  for (const c of cmd.split(/[,，;；。]/).map(s => s.trim()).filter(Boolean)) {
    const layer = layerIn(c) || lastLayer; if (layerIn(c)) lastLayer = layerIn(c);
    const off = /隐藏|关闭|去掉/.test(c);
    if (/底图/.test(c)) push('set_basemap', { basemap: /卫星/.test(c) ? 'satellite' : /地形/.test(c) ? 'terrain' : 'vector' }, '切换底图');
    if (/背景/.test(c)) push('set_background', { color: /深|黑/.test(c) ? '#1a1a1a' : '#ffffff' }, '设置背景色');
    if (/坐标系|投影/.test(c)) push('set_crs', { crs: /3857|墨卡托/.test(c) ? 'EPSG:3857' : /4490/.test(c) ? 'EPSG:4490' : 'EPSG:4326' }, '设置坐标系');
    const sym = {};
    if (/红/.test(c)) sym.color = '#d62728'; else if (/蓝/.test(c)) sym.color = '#1f77b4';
    const w = c.match(/(\d+)\s*(像素|px)/); if (w) sym.width = Number(w[1]);
    if (/三角/.test(c)) sym.shape = 'triangle'; else if (/方形|方块/.test(c)) sym.shape = 'square';
    if (Object.keys(sym).length) push('set_symbol', { layer, ...sym }, '修改图层符号');
    if (/标注/.test(c)) push('set_labels', { layer, visible: !off }, off ? '隐藏标注' : '显示标注');
    const f = c.match(/(\w+)\s*(大于|小于)\s*(\d+)/); if (f) push('filter_features', { layer, field: f[1], op: f[2] === '大于' ? '>' : '<', value: Number(f[3]) }, '按属性筛选');
    const t = c.match(/图名(?:改成|设为|叫|为)?\s*['"“‘]?([^'"”’]+?)['"”’]?(?:并|$)/);
    if (t) push('set_title', { text: t[1].replace(/居中|靠左|靠右/g, '').trim(), ...(/居中/.test(c) ? { align: 'center' } : /靠右/.test(c) ? { align: 'right' } : {}) }, '设置图名');
    if (/比例尺/.test(c)) push('set_scalebar', { visible: !off }, off ? '隐藏比例尺' : '显示比例尺');
    if (/指北针/.test(c)) push('set_north_arrow', { visible: !off, style: 'compass' }, off ? '隐藏指北针' : '显示指北针');
    if (/缩放|定位/.test(c)) push('zoom_to', { layer }, '缩放视口');
  }
  return plan;
}

// ─────────────────────── 4. 人在回路:二次确认面板(增 / 删 / 改 / 排序 / 继续 / 取消) ───────────────────────
function renderPlan(plan) {
  console.log('\n🙋 待执行计划(执行前请确认)');
  plan.forEach((s, i) => console.log(`  ${i + 1}. [${TOOLS[s.tool]?.cat ?? '未知'}] ${s.tool}  ${JSON.stringify(s.args)}   — ${s.why ?? ''}`));
  console.log(HELP);
}
const HELP = `  操作:  y 执行全部          n 取消
         d 2               删除第 2 步
         m 1 3             把第 1 步移到第 3 位
         e 3 width=5       改第 3 步的参数(可多个:e 3 width=5 color=#ff0000;也可整段 JSON:e 3 {"layer":"faults","width":5})
         a set_north_arrow visible=true style=compass   追加一步`;

// 解析参数:整段 JSON 直接替换;key=value 列表合并进原参数(true/false/数字自动转类型)
function parseArgs(tokens, base = {}) {
  const raw = tokens.join(' ').trim();
  if (raw.startsWith('{')) return JSON.parse(raw);
  const out = { ...base };
  for (const kv of tokens) {
    const i = kv.indexOf('='); if (i < 0) throw new Error(`参数要写成 key=value,收到 "${kv}"`);
    const k = kv.slice(0, i), v = kv.slice(i + 1);
    out[k] = v === 'true' ? true : v === 'false' ? false : (v !== '' && !isNaN(v)) ? Number(v) : v;
  }
  return out;
}

async function confirmPlan(plan, autoYes) {
  renderPlan(plan);
  if (autoYes) { console.log('  → --yes 自动确认'); return plan; }
  // 行队列:无论是人在终端敲,还是管道一次灌进多行,每一行都不丢——生产里的确认面板同理要处理"用户连点"
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = []; let waiter = null, closed = false;
  rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  const ask = q => new Promise(r => { process.stdout.write(q); if (queue.length) return r(queue.shift()); if (closed) return r(null); waiter = r; });
  try {
    for (;;) {
      const line = await ask('> ');
      if (line === null) return null;                       // 输入结束视为取消
      const [op, ...rest] = line.trim().split(/\s+/);
      const idx = Number(rest[0]) - 1;
      const stepOk = () => { if (!plan[idx]) throw new Error(`没有第 ${rest[0]} 步(当前 1-${plan.length})`); };
      try {
        if (op === 'y') return plan;
        if (op === 'n') return null;
        if (op === '' || op === '?') { console.log(HELP); continue; }
        if (op === 'd') { stepOk(); plan.splice(idx, 1); }
        else if (op === 'm') { stepOk(); const [s] = plan.splice(idx, 1); plan.splice(Number(rest[1]) - 1, 0, s); }
        else if (op === 'e') { stepOk(); const args = parseArgs(rest.slice(1), plan[idx].args); validate(plan[idx].tool, args); plan[idx].args = args; plan[idx].why = '(人工修改)'; }
        else if (op === 'a') { const args = parseArgs(rest.slice(1)); validate(rest[0], args); plan.push({ tool: rest[0], args, why: '(人工追加)' }); }
        else { console.log(`  ✗ 不认识 "${line.trim()}"。改参数请写:e 步骤号 key=value,例如 e 3 width=5(输入 ? 看全部操作)`); continue; }
      } catch (e) { console.log(`  ✗ ${e.message}`); continue; }
      renderPlan(plan);
    }
  } finally { rl.close(); }
}

// ─────────────────────── 5. 执行器:事务式——全部成功才提交,任一步失败整体回滚 ───────────────────────
function execute(plan, map) {
  const next = structuredClone(map);        // 在副本上执行;失败时原图纹丝不动
  console.log('\n⚙️  执行');
  for (const [i, s] of plan.entries()) {
    try {
      validate(s.tool, s.args);             // 确认面板里人可能改过参数,执行前再校验一次
      console.log(`  ${i + 1}. ${s.tool} ✓ ${TOOLS[s.tool].run(next, s.args)}`);
    } catch (e) {
      console.log(`  ${i + 1}. ${s.tool} ✗ ${e.message}\n  ⛔ 第 ${i + 1} 步失败,整段回滚,地图保持执行前状态`);
      return { ok: false, map, failedAt: i + 1, error: e.message };
    }
  }
  return { ok: true, map: next };
}

// ─────────────────────── 入口 ───────────────────────
const argv = process.argv.slice(2);
const mock = argv.includes('--mock'), autoYes = argv.includes('--yes');
const command = argv.filter(a => !a.startsWith('--')).join(' ')
  || '把底图换成卫星图,背景设为深色,把断层线加粗到 3 像素显示为红色,隐藏采样点标注,图名改成华南地区构造图并居中,显示比例尺';

(async () => {
  let map = initialMap();
  console.log(`🎯 指令: ${command}`);

  console.log('\n📝 规划');
  const plan = mock ? planWithMock(command) : await planWithModel(command);
  if (!plan.length) return console.log('  没有识别出可执行的制图操作');
  console.log(`  规划出 ${plan.length} 步`);

  const confirmed = await confirmPlan(plan, autoYes);
  if (!confirmed) return console.log('\n🚫 已取消,地图未改动');

  const result = execute(confirmed, map);
  map = result.map;

  console.log('\n🗺️  地图快照(生产里这一步是导出 JPG/PNG/PDF)');
  console.log(JSON.stringify({ basemap: map.basemap, background: map.background, crs: map.crs, view: map.view,
    layers: map.layers.map(l => ({ id: l.id, style: l.style, labels: l.labels, filter: l.filter })), components: map.components }, null, 2));
  if (!result.ok) process.exitCode = 1;
})().catch(e => { console.error('运行失败:', e.message); process.exit(1); });
