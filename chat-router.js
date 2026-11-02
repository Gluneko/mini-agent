#!/usr/bin/env node
/**
 * chat-router — GeoGPT「对话入口 + 意图识别路由」最小实现(单文件、零依赖,Node ≥ 18)
 *
 * 对应产品形态(用户手册 1.x):
 *   模型切换 ｜ 输入 # 选技能(学术检索 / 文献阅读 / 表格提取 / 代码)｜ 融合知识库检索(带编号引用 + 相关链接·N)
 *   代码执行(执行代码 → 代码执行结果)｜ 文献搜索(编号论文列表)｜ Deep Discovery 开关 ｜ 地质图生成
 *
 * 路由三层(优先级从高到低):
 *   ① 显式:用户点了技能 / 开了 Deep Discovery —— 用户说了算,永不二次猜测
 *   ② 粘性:多轮里"再把比例尺隐藏"跟着上一轮的 Agent 走
 *   ③ 隐式:意图分类器打分 → 高置信直接路由;中置信先澄清;低置信落到普通对话
 * 路由前做「前置条件检查」:文献阅读没文档、表格提取没图片 → 先要材料,不空转。
 * 输出统一为「结构化块」{type: route|markdown|citations|papers|code|code_result|ask|activity}——前端按 type 分发渲染。
 *
 * 运行:
 *   node chat-router.js --mock                              # 交互式会话(输入 # 看技能,/dd 开关 Deep Discovery,/model 切模型)
 *   node chat-router.js --mock --yes "把底图换成卫星图,显示比例尺"   # 一句话直达地图 Agent
 *   node chat-router.js --mock --yes --dd "地球是怎么形成的?"       # 开着 Deep Discovery 发问 → 研究 Agent
 *   node chat-router.js --mock --yes "#学术检索 沿海城市海岸带地貌变迁"
 */
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const optVal = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const MOCK = flag('--mock'), YES = flag('--yes');
const VALUED = ['--model', '--doc', '--image'];
const ONESHOT = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1])).join(' ');

// ─────────────────────── 1. 会话状态(对应产品的一个"会话") ───────────────────────
const session = {
  id: Math.random().toString(16).slice(2, 10),
  model: optVal('--model') || 'Qwen2.5-72B-GeoGPT_openai',
  models: ['Qwen2.5-72B-GeoGPT_openai', 'DeepSeekR1-GeoGPT', 'GeoGPT-R1-Preview'],
  deepDiscovery: flag('--dd'), deeper: flag('--deeper'),
  attachments: { doc: optVal('--doc'), image: optVal('--image') },
  history: [],            // [{role, content}] 给普通对话用的多轮上下文
  lastRoute: null,        // 粘性路由的依据
};

// ─────────────────────── 2. 结构化块输出:前端按 type 分发渲染 ───────────────────────
function emit(block) {
  const tag = `[${block.type}]`.padEnd(13);
  switch (block.type) {
    case 'route':       return console.log(`\n${tag} → ${block.skill}  (${block.reason}${block.confidence != null ? `,置信 ${block.confidence.toFixed(2)}` : ''})`);
    case 'markdown':    return console.log(`${tag} ${block.content.replace(/\n/g, '\n              ')}`);
    case 'citations':   return console.log(`${tag} 相关链接 · ${block.items.length}\n` + block.items.map((c, i) => `              ${i + 1}. ${c.icon} ${c.title}`).join('\n'));
    case 'papers':      return console.log(`${tag} 以下是我们找到的关于「${block.query}」的文献:\n` + block.items.map((p, i) => `              ${i + 1}. ${p.title}:${p.abstract} —— ${p.authors} ——《${p.journal}》—— ${p.year}`).join('\n'));
    case 'code':        return console.log(`${tag} \`\`\`${block.lang}   [执行代码] [复制]\n${block.content.split('\n').map(l => '              ' + l).join('\n')}\n              \`\`\``);
    case 'code_result': return console.log(`${tag} 执行的代码 >   代码执行结果\n              ${block.content.replace(/\n/g, '\n              ')}`);
    case 'ask':         return console.log(`${tag} ❓ ${block.content}`);
    case 'activity':    return console.log(`${tag} ● ${block.content}`);
    default:            return console.log(`${tag} ${JSON.stringify(block)}`);
  }
}

// ─────────────────────── 3. 技能注册表:路由的"目录"(描述给分类器看,requires 给前置检查用) ───────────────────────
const SKILLS = {
  chat:    { label: '对话',         desc: '普通问答,事实类问题走融合知识库检索', requires: [], risk: 'auto' },
  scholar: { label: '学术检索',     desc: '通过对话检索学术信息(Semantic Scholar)', requires: [], risk: 'auto', hash: true },
  docread: { label: '文献阅读',     desc: '询问关于文档的任何问题', requires: ['doc'], risk: 'auto', hash: true },
  table:   { label: '表格提取',     desc: '从图片中提取表格', requires: ['image'], risk: 'auto', hash: true },
  code:    { label: '代码',         desc: '解答编程疑问,可执行 Python', requires: [], risk: 'confirm', hash: true },
  map:     { label: '地质图生成',   desc: '用自然语言修改/生成地质图(底图、图层、图名、比例尺等)', requires: [], risk: 'confirm', agent: 'map-agent.js' },
  research:{ label: 'Deep Discovery', desc: '需要多源深入调研并产出报告的问题', requires: [], risk: 'confirm', agent: 'research-agent.js' },
  vibe:    { label: 'Vibe Research', desc: '复现论文 / 用数据跑实验并产出结果与报告(科研 coding agent)', requires: [], risk: 'confirm', agent: 'vibe-agent.js' },
};
const hashMenu = () => Object.entries(SKILLS).filter(([, s]) => s.hash).map(([k, s]) => `  #${s.label}  ${s.desc}`).join('\n');

// ─────────────────────── 4. 意图分类器:显式 > 粘性 > 隐式(打分 + 阈值) ───────────────────────
const T_ROUTE = 0.7, T_ASK = 0.5;     // 高于 0.7 直接路由;0.5-0.7 先澄清;低于 0.5 落到对话
function classify(text) {
  // ① 显式:# 技能 或 Deep Discovery 开关——用户的选择永远优先
  const m = text.match(/^#(\S+)\s*(.*)$/);
  if (m) { const k = Object.keys(SKILLS).find(k => SKILLS[k].label === m[1]); if (k) return { skill: k, text: m[2] || text, confidence: 1, reason: '用户选择技能' }; }
  if (session.deepDiscovery) return { skill: 'research', text, confidence: 1, reason: 'Deep Discovery 已开启' };
  if (!MOCK) return classifyWithModel(text);
  // ③ 隐式(mock 规则版;生产里是模型做结构化输出 {intent, confidence, args})
  const rules = [
    ['map',     /(地质图|底图|图层|比例尺|图名|指北针|标注|坐标系|视口).*(改|换|加|隐藏|显示|生成|设|缩放|去掉)|(改|换|加|隐藏|显示|生成|设|缩放).*(地质图|底图|图层|比例尺|图名|指北针|标注)/, .92],
    ['scholar', /查找.*(论文|文献)|检索.*(论文|文献)|相关论文|研究论文|文献综述|papers?\b/i, .88],
    ['code',    /写.*(代码|脚本|函数)|python|实现一个|计算并打印|帮我写个|代码怎么/i, .86],
    ['docread', /(这篇|这份|以下|上传的).*(文献|文档|论文|材料).*(概要|总结|讲了|问题)|概要以下文献|总结这篇/, .84],
    ['table',   /(提取|识别).*(表格)|表格提取|图片里的表/, .84],
    ['vibe',    /复现.*(论文|实验|结果)|reproduce|用.*数据.*(跑|复现|训练)|跑一遍.*(方法|模型)/i, .9],
    ['research',/(深入|全面|系统).*(调研|研究|分析)|做一份.*报告|综述一下|来龙去脉/, .62],   // 中置信:先问要不要开 Deep Discovery
  ];
  for (const [skill, re, confidence] of rules) if (re.test(text)) return { skill, text, confidence, reason: '意图分类' };
  // ② 粘性:短句 + 承接词,跟着上一轮的 Agent 走(生产里粘性要带衰减,只看最近 1-2 轮)
  if (session.lastRoute && ['map', 'scholar', 'code'].includes(session.lastRoute) && /^(再|然后|接着|顺便|另外|把|还有)/.test(text) && text.length < 40)
    return { skill: session.lastRoute, text, confidence: .75, reason: `承接上一轮(${SKILLS[session.lastRoute].label})` };
  return { skill: 'chat', text, confidence: .55, reason: '默认对话' };
}
async function classifyWithModel(text) {
  const catalog = Object.entries(SKILLS).map(([k, s]) => `- ${k}:${s.desc}`).join('\n');
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.MODEL || 'gpt-4o-mini', response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: `把用户消息分类到一个技能,只输出 JSON {"skill":"…","confidence":0-1}。技能:\n${catalog}\n上一轮技能:${session.lastRoute || '无'}` }, { role: 'user', content: text }] }),
  });
  const out = JSON.parse((await res.json()).choices[0].message.content);
  return { skill: SKILLS[out.skill] ? out.skill : 'chat', text, confidence: out.confidence ?? .6, reason: '模型分类' };
}

// ─────────────────────── 5. 技能处理器 ───────────────────────
const kwOf = q => q.replace(/[?？。!！\s]/g, '').replace(/是怎么|是如何|怎么|如何|什么是|为什么|是什么|有什么|介绍一下|请|帮我/g, '').replace(/的$/, '') || q;

// 5a 对话:事实类问题走融合知识库检索(多源 → 引用编号 → 相关链接);闲聊直接答
async function handleChat(text) {
  const factual = /是什么|为什么|怎么|如何|什么|特点|介绍|哪些|区别/.test(text);
  if (!factual) return emit({ type: 'markdown', content: MOCK ? `好的,我在。有地学相关的问题随时问我。(会话 ${session.id},模型 ${session.model})` : await llmText(text) });
  const kw = kwOf(text);
  emit({ type: 'activity', content: `融合知识库检索:网页 / 公共数据库 / 个人文档库 / 模型知识 → 「${kw}」` });
  const cites = [
    { icon: '🌐', title: `论${kw} – 学报` }, { icon: '🌐', title: `${kw}要素分析 – 期刊` }, { icon: '📄', title: `${kw} – GeoGPT Library` },
    { icon: '📁', title: `${kw}报告2009–2019 – 我的资源库` }, { icon: '🌐', title: `${kw}_百度百科` },
  ];
  emit({ type: 'markdown', content: `关于${kw},综合多源资料可以概括为三点:\n1. 基本特征:主流文献对其定义与范围有一致描述。[1][3]\n2. 影响因素:区域条件与长期演化共同作用,不同来源给出的侧重点略有差异。[2][4]\n3. 近期进展:最新研究补充了新的观测证据。[3][5]\n希望这些信息对你有帮助!` });
  emit({ type: 'citations', items: cites });
}
// 5b 学术检索:Semantic Scholar(mock)→ 编号论文列表
async function handleScholar(text) {
  const kw = kwOf(text.replace(/请查找关于|的研究论文|查找|检索|相关论文|论文|文献/g, ''));
  emit({ type: 'activity', content: `Semantic Scholar 检索:「${kw}」` });
  emit({ type: 'papers', query: kw, items: [
    { title: `${kw}35年变化`, abstract: `以面向对象的分类器为主辅以人工解译,分析${kw}的时空特征…`, authors: '帅艳民, 曲歌, 邵聪颖', journal: '生态科学', year: 2022 },
    { title: `城市化进程下${kw}时空变化分析`, abstract: `基于 2005–2020 年多期遥感影像,高效、精确地测量${kw}的动态变化…`, authors: '刘源, 李婷', journal: '自然资源遥感', year: 2024 },
    { title: `${kw}近现代地质环境变化`, abstract: `10~10²a 级别的相对快速的缓变型地质环境变化,主要包括水体、湿地和盐沼…`, authors: '钟新宝, 康慧', journal: '第四纪研究', year: 2002 },
    { title: `${kw}遥感调查`, abstract: `研究${kw}的变迁规律及其驱动因素…`, authors: '王立, 陈晨', journal: '海洋学报', year: 2019 },
  ] });
}
// 5c 代码:生成代码块 → 用户点"执行代码"(risk=confirm)→ 沙箱执行 → 结果块
async function handleCode(text) {
  const seismic = /地震|均值|标准差|统计/.test(text);
  const code = seismic
    ? `import random, statistics\n\n# 生成示例地震波数据(1000 个数据点,符合正态分布)\nrandom.seed(0)\nseismic_data = [random.gauss(0.0, 1.0) for _ in range(1000)]\n\n# 计算均值和标准差(样本标准差)\nmean_value = statistics.mean(seismic_data)\nstd_deviation = statistics.stdev(seismic_data)\n\nprint("地震波数据统计结果:")\nprint(f"均值: {mean_value:.4f}")\nprint(f"标准差: {std_deviation:.4f}")`
    : `# 根据你的描述生成的示例\ndata = list(range(1, 11))\nprint("平方和:", sum(x * x for x in data))`;
  emit({ type: 'markdown', content: `以下是${seismic ? '计算地震波数据均值和标准差' : '按你的需求写'}的 Python 代码示例:` });
  emit({ type: 'code', lang: 'python', content: code });
  const ok = YES || (await lineReader().ask('执行代码?(y/n)> ')) === 'y';     // 执行有副作用,必须由人触发——对应产品里的"执行代码"按钮
  if (!ok) return emit({ type: 'markdown', content: '未执行。' });
  emit({ type: 'activity', content: '沙箱执行:python3,超时 10s,无网络' });
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 10000 });
  emit({ type: 'code_result', content: r.error ? `(本机无 python3,mock 结果)\n地震波数据统计结果:\n均值: -0.0453\n标准差: 0.9875` : (r.stdout || r.stderr).trim() });
}
// 5d 文献阅读 / 表格提取:前置条件在路由层已检查,这里直接处理(mock)
async function handleDocRead(text) {
  const p = session.attachments.doc; const head = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').slice(0, 5).join(' ').slice(0, 120) : '(文件不可读)';
  emit({ type: 'activity', content: `文献阅读:已加载 ${path.basename(p)}` });
  emit({ type: 'markdown', content: `这份文档的概要:开篇提到「${head}…」。你可以继续问它的任何细节,我会定位到原文段落作答。` });
}
async function handleTable(text) {
  emit({ type: 'activity', content: `表格提取:OCR ${path.basename(session.attachments.image)}` });
  emit({ type: 'markdown', content: `| 样本 | 深度(m) | 含量(%) |\n|---|---|---|\n| S-01 | 12.5 | 3.2 |\n| S-02 | 18.0 | 4.7 |\n(已从图片中识别 2 行 3 列,可导出到表库)` });
}
// 5e 子 Agent:地质图生成 / Deep Discovery —— 独立进程,自带确认面板与检查点
function handleAgent(skill, text) {
  const s = SKILLS[skill];
  const args = [path.join(__dirname, s.agent), '--mock', ...(YES ? ['--yes'] : []),
    ...(skill === 'research' ? ['--fast', ...(session.deeper ? ['--deeper'] : [])] : []), ...(skill === 'vibe' ? ['--fast'] : []), text];
  emit({ type: 'activity', content: `交给 ${s.label} Agent(独立进程:${s.agent})` });
  IO?.pause();                                                    // 把终端让给子 Agent 的确认面板
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, MODEL: session.model } });
  IO?.resume();
  emit({ type: 'activity', content: `${s.label} Agent 结束(exit ${r.status})` });
}
async function llmText(text) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.MODEL || 'gpt-4o-mini', messages: [...session.history.slice(-6), { role: 'user', content: text }] }) });
  return (await res.json()).choices[0].message.content;
}

// ─────────────────────── 6. 路由主流程:分类 → 阈值 → 前置条件 → 分发 ───────────────────────
async function route(raw) {
  const text = raw.trim(); if (!text) return;
  session.history.push({ role: 'user', content: text });
  let d = await classify(text);

  if (d.confidence < T_ROUTE && d.confidence >= T_ASK && d.skill !== 'chat') {           // 中置信:澄清一次,不瞎猜
    emit({ type: 'ask', content: `这个问题看起来适合用「${SKILLS[d.skill].label}」深入处理,要用它吗?(y = 用,其他 = 普通对话回答)` });
    const a = YES ? 'y' : await lineReader().ask('> ');
    d = a === 'y' ? { ...d, confidence: 1, reason: '用户确认' } : { skill: 'chat', text, confidence: 1, reason: '用户选择普通对话' };
  }
  emit({ type: 'route', skill: SKILLS[d.skill].label, reason: d.reason, confidence: d.confidence });

  const missing = SKILLS[d.skill].requires.filter(k => !session.attachments[k]);          // 前置条件:缺材料先要材料,不空转
  if (missing.length) return emit({ type: 'ask', content: `使用「${SKILLS[d.skill].label}」需要先${missing.map(k => k === 'doc' ? '上传文档(/attach doc 路径)' : '上传图片(/attach image 路径)').join('、')}。` });

  session.lastRoute = d.skill;
  const handlers = { chat: handleChat, scholar: handleScholar, code: handleCode, docread: handleDocRead, table: handleTable };
  if (SKILLS[d.skill].agent) return handleAgent(d.skill, d.text);
  await handlers[d.skill](d.text);
}

// ─────────────────────── 7. 会话命令(对应界面上的开关与菜单) ───────────────────────
function header() {
  console.log(`\n┌ GeoGPT 会话 ${session.id} ┐  模型: ${session.model}  |  Deep Discovery: ${session.deepDiscovery ? 'ON' + (session.deeper ? '(Deeper)' : '') : 'off'}  |  附件: ${Object.entries(session.attachments).filter(([, v]) => v).map(([k, v]) => `${k}=${path.basename(v)}`).join(' ') || '无'}`);
  console.log(`  输入 # 看技能 ｜ /dd 开关 Deep Discovery ｜ /deeper 开关 Deeper ｜ /model 切换模型 ｜ /attach doc|image 路径 ｜ /new 新会话 ｜ /quit`);
}
async function command(line) {
  const [c, ...rest] = line.trim().split(/\s+/);
  if (line.trim() === '#') return console.log(hashMenu()), true;
  if (c === '/dd') { session.deepDiscovery = !session.deepDiscovery; header(); return true; }
  if (c === '/deeper') { session.deeper = !session.deeper; header(); return true; }
  if (c === '/model') { const i = session.models.indexOf(session.model); session.model = rest[0] || session.models[(i + 1) % session.models.length]; header(); return true; }
  if (c === '/attach') { session.attachments[rest[0]] = rest[1]; header(); return true; }
  if (c === '/new') { session.history = []; session.lastRoute = null; session.id = Math.random().toString(16).slice(2, 10); header(); return true; }
  if (c === '/quit') return 'quit';
  return false;
}

// 单例 stdin 读取器(与其他 agent 相同的行队列实现)
let IO = null;
function lineReader() {
  if (IO) return IO;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = []; let waiter = null, closed = false;
  rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  return (IO = { ask: q => new Promise(r => { process.stdout.write(q); if (queue.length) return r(queue.shift()); if (closed) return r(null); waiter = r; }),
    pause: () => rl.pause(), resume: () => rl.resume(), close: () => rl.close() });
}

// ─────────────────────── 入口 ───────────────────────
(async () => {
  if (ONESHOT) { header(); console.log(`\n你: ${ONESHOT}`); await route(ONESHOT); return; }
  header();
  const io = lineReader();
  for (;;) {
    const line = await io.ask('\n你> '); if (line === null) break;
    const c = await command(line); if (c === 'quit') break; if (c === true) continue;
    await route(line);
  }
})().catch(e => { console.error('运行失败:', e.message); process.exitCode = 1; }).finally(() => IO?.close());
