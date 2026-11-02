#!/usr/bin/env node
/**
 * research-agent — Deep / Deeper Discovery「深度研究 Agent」最小实现(单文件、零依赖,Node ≥ 18)
 *
 * 对应 GeoGPT Deep Discovery 的链路(终端输出对齐产品右侧"活动 / N 来源"面板):
 *   问题 → 拆解成研究步骤 → 每步多源检索(网页 / GeoGPT Library / 我的资源库)→ 相关性过滤 → 阅读做笔记
 *        → 已完成研究步骤 → 撰写报告(引言 / 目录 / 正文 / 结论 / 参考来源)→ 导出 Markdown
 * Deeper 模式(--deeper,对应手册 3.4):先澄清一个问题 → 生成研究方案 → 人确认/编辑 → 再执行。
 *
 * 长程任务三件套:有界拆解(最多 N 步)、每步预算与超时、检查点续跑(--resume)——"随意离开对话"靠的就是它。
 *
 * 运行:
 *   node research-agent.js --mock --fast                    # 无需 key,秒出完整轨迹 + 报告
 *   node research-agent.js --mock                           # 带节奏地"流"出活动面板(演示用)
 *   node research-agent.js --mock --deeper                  # Deeper:澄清 → 方案确认面板 → 执行
 *   node research-agent.js --mock --stop-after 2            # 模拟中途离开(跑完 2 步退出,检查点已存)
 *   node research-agent.js --mock --resume                  # 从检查点续跑
 *   OPENAI_API_KEY=xx OPENAI_BASE_URL=xx node research-agent.js "…"   # 拆解与写报告用真模型(检索仍为 mock)
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const optVal = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const MOCK = flag('--mock'), DEEPER = flag('--deeper'), RESUME = flag('--resume'), FAST = flag('--fast'), YES = flag('--yes');
const STOP_AFTER = Number(optVal('--stop-after')) || Infinity;
const QUESTION = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--stop-after').join(' ') || '地球是怎么形成的?';

// ─────────────────────── 1. 预算:长程任务不跑偏的硬约束 ───────────────────────
const BUDGET = {
  maxSteps: 4,            // 拆解上限:再大的问题也只拆 4 步,防"研究方案"无限膨胀
  perSearch: 4,           // 每个来源每次最多取 4 条
  readPerStep: 3,         // 每步最多精读 3 篇
  scoreThreshold: 0.35,   // 相关性阈值(与 RAG API 的 scoreThreshold 同义):低于它的命中直接丢
  stepTimeoutMs: 20000,   // 单步超时
  maxSources: 20,         // 全局来源上限
};
const sleep = ms => FAST ? Promise.resolve() : new Promise(r => setTimeout(r, ms));
const STATE_FILE = path.join(__dirname, '.research-state.json');

// ─────────────────────── 2. 状态 + 检查点:每完成一步就落盘,离开随时可续 ───────────────────────
const newState = q => ({ question: q, mode: DEEPER ? 'deeper' : 'deep', focus: '', steps: [], sources: [], activity: [], reportPath: null, startedAt: Date.now() });
const save = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const load = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

// ─────────────────────── 3. 活动面板:对齐产品右侧"活动 / N 来源" ───────────────────────
const chat = t => console.log(`\n💬 ${t}`);
function act(state, text) { state.activity.push(text); console.log(`\n● ${text}`); }
const searching = q => console.log(`    Searching   🔍 ${q}`);
const reading = items => { console.log('    Reading'); items.forEach(s => console.log(`                ${s.icon} ${s.title}${s.dropped ? '   (相关性 ' + s.score.toFixed(2) + ' 低于阈值,丢弃)' : ''}`)); };
const sourceCount = s => console.log(`    [${s.sources.length} 来源]`);
// 来源去重:同一 url/docId 只计一次——面板上 7 → 14 → 17 的累加就是去重后的数
function addSources(state, list) {
  const fresh = [];
  for (const s of list) {
    if (s.score < BUDGET.scoreThreshold) { s.dropped = true; continue; }
    if (state.sources.length >= BUDGET.maxSources) break;
    if (state.sources.some(x => x.key === s.key)) continue;
    s.n = state.sources.length + 1; state.sources.push(s); fresh.push(s);
  }
  return fresh;
}

// ─────────────────────── 4. 三个检索来源(mock 适配器;生产里是网页搜索 API / 公共库 RAG / 个人库 RAG) ───────────────────────
// 关键词归一化:先去标点,再去疑问框架词,最后去掉结尾的"的"——"地球是怎么形成的?" → "地球形成"
const kwOf = q => q.replace(/[?？。!！\s]/g, '').replace(/是怎么|是如何|怎么|如何|什么是|为什么|是什么/g, '').replace(/的$/, '') || q;
let decoyShown = false;
const SOURCES = {
  web:     { label: '网页',           icon: '🌐', search: async q => mockHits(q, 'web') },
  library: { label: 'GeoGPT Library', icon: '📄', search: async q => mockHits(q, 'library') },
  mine:    { label: '我的资源库',      icon: '📁', search: async q => mockHits(q, 'mine') },
};
function mockHits(q, kind) {
  const kw = kwOf(q);
  const tpl = {
    web: [[`${kw} – 维基百科,自由的百科全书`, .92], [`${kw}_百度百科`, .81], [`${kw} – 地质馆 – 中国科普博览`, .74], [`我们生活的${kw.slice(0, 2)}`, .58]],
    library: [[`History of ${kw}`, .88], [`Early ${kw}`, .83], [`Geological history of ${kw}`, .77], ...(decoyShown ? [] : [['Alkali metal', .21]])],   // 典型误命中,会被阈值拦掉(只演示一次)
    mine: [[`${kw}最新研究.pdf`, .86], [`${kw}综述_2024.pdf`, .69]],
  }[kind];
  if (kind === 'library') decoyShown = true;
  return tpl.slice(0, BUDGET.perSearch).map(([title, score]) => ({ title, score, kind, icon: SOURCES[kind].icon, key: `${kind}:${title}`, snippet: `${title} 中关于「${q}」的核心内容。` }));
}

// ─────────────────────── 5. 模型层:拆解 / 做笔记 / 写报告(mock 与真模型两套) ───────────────────────
async function llm(messages, json = false) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.MODEL || 'gpt-4o-mini', messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

// 演示问题的精选语料:让 mock 报告读起来像真的;其他问题走通用模板
const KB = {
  '地球形成': {
    steps: ['太阳系的起源与原行星盘的演化', '地球的吸积与早期分异', '地球大气与水的来源', '板块构造与地球的长期演化'],
    notes: {
      '太阳系的起源与原行星盘的演化': ['约 46 亿年前,一片太阳星云在自身引力下坍缩,中心形成原始太阳,周围物质摊成旋转的原行星盘。', '盘中尘埃通过静电吸附和碰撞逐渐聚集成厘米级颗粒,再长成千米级星子,这是行星形成的第一阶段。'],
      '地球的吸积与早期分异': ['星子之间反复碰撞合并形成原行星,原始地球在约 1 亿年内通过吸积长到接近现今质量。', '碰撞与放射性衰变释放的热量使早期地球熔融,重的铁镍下沉形成地核,轻的硅酸盐上浮形成地幔与原始地壳,这一过程称为分异。', '一颗火星大小的天体撞击原始地球(大碰撞假说),抛出的物质聚集形成月球。'],
      '地球大气与水的来源': ['原始大气主要来自火山脱气,以水蒸气、二氧化碳和氮气为主,而非今天的富氧大气。', '地表冷却后水蒸气凝结成海洋;彗星与含水小行星的撞击可能贡献了部分水,其比例仍在争论。'],
      '板块构造与地球的长期演化': ['地壳固化后逐步演化出板块构造,岩石圈板块的生成、俯冲与碰撞塑造了大陆与海洋的格局。', '约 24 亿年前的大氧化事件改变了大气成分,生命演化与地质过程自此深度耦合。'],
    },
  },
};
function mockDecompose(q) {
  const kb = KB[kwOf(q)]; if (kb) return kb.steps;
  const kw = kwOf(q);
  return [`${kw}的背景与基本概念`, `${kw}的主要理论与机制`, `${kw}的关键证据与数据`, `${kw}的争议与前沿进展`];
}
function mockNotes(q, step, sources) {
  const kb = KB[kwOf(q)]?.notes?.[step];
  const cite = i => `[${sources[i % sources.length]?.n ?? 1}]`;
  if (kb) return kb.map((t, i) => `${t}${cite(i)}`);
  return [`关于「${step}」,现有资料指出其核心在于${kwOf(q)}相关的基本原理与关键要素。${cite(0)}`, `多个来源从不同角度给出了证据与解释,主流观点趋于一致,细节上仍有讨论空间。${cite(1)}`];
}
async function decompose(state) {
  if (MOCK) return mockDecompose(state.question);
  const out = JSON.parse(await llm([{ role: 'system', content: `把用户的研究问题拆成最多 ${BUDGET.maxSteps} 个有序的研究步骤(子问题),只输出 JSON:{"steps":["…"]}。${state.focus ? '用户补充的侧重点:' + state.focus : ''}` }, { role: 'user', content: state.question }], true));
  return out.steps.slice(0, BUDGET.maxSteps);
}
async function takeNotes(state, step, sources) {
  if (MOCK) return mockNotes(state.question, step, sources);
  const text = await llm([{ role: 'system', content: '你是研究助理。根据给定来源,为该研究步骤写 2-3 条要点,每条末尾标注来源编号如 [1]。只输出要点,每行一条。' }, { role: 'user', content: `问题:${state.question}\n步骤:${step}\n来源:\n${sources.map(s => `[${s.n}] ${s.title}:${s.snippet}`).join('\n')}` }]);
  return text.split('\n').map(l => l.replace(/^[-•\d.\s]+/, '').trim()).filter(Boolean);
}

// ─────────────────────── 6. Deeper:澄清 + 研究方案确认(人在回路) ───────────────────────
// 全进程只开一个 stdin 读取器(单例):管道输入会一次性到达,开第二个读取器就拿不到剩下的行
let IO = null;
function lineReader() {
  if (IO) return IO;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = []; let waiter = null, closed = false;
  rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  return (IO = { ask: q => new Promise(r => { process.stdout.write(q); if (queue.length) return r(queue.shift()); if (closed) return r(null); waiter = r; }), close: () => rl.close() });
}
function renderPlan(steps) {
  console.log('\n📋 研究方案(确认后开始研究)');
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('  操作: y 开始研究 | n 取消 | d 2 删除第 2 步 | e 2 新标题 改第 2 步 | a 新标题 追加一步 | r 重新生成');
}
async function confirmPlan(state, steps) {
  renderPlan(steps);
  if (YES) { console.log('  → --yes 自动确认'); return steps; }
  const io = lineReader();
  {
    for (;;) {
      const line = await io.ask('> '); if (line === null) return null;
      const [op, ...rest] = line.trim().split(/\s+/); const i = Number(rest[0]) - 1;
      if (op === 'y') return steps; if (op === 'n') return null;
      if (op === 'd' && steps[i]) steps.splice(i, 1);
      else if (op === 'e' && steps[i]) steps[i] = rest.slice(1).join(' ');
      else if (op === 'a') { if (steps.length >= BUDGET.maxSteps) { console.log(`  ✗ 最多 ${BUDGET.maxSteps} 步(预算约束)`); continue; } steps.push(rest.join(' ')); }
      else if (op === 'r') { steps = await decompose(state); }
      else { console.log('  ✗ 不认识,输入 y / n / d 2 / e 2 新标题 / a 新标题 / r'); continue; }
      renderPlan(steps);
    }
  }
}

// ─────────────────────── 7. 研究一步:多源检索 → 相关性过滤 → 去重 → 精读做笔记(带超时) ───────────────────────
async function researchStep(state, step, isFirst) {
  const run = async () => {
    if (isFirst) { act(state, `搜索获得更多信息: ${state.question}`); searching(state.question); }
    let gathered = [];
    for (const [kind, src] of Object.entries(SOURCES)) {
      act(state, isFirst && kind === 'web' ? `初步调研与探索: ${state.question}` : `正在检索 ${src.label}: ${step.title}`);
      if (!(isFirst && kind === 'web')) searching(step.title);
      await sleep(350);
      const hits = await src.search(isFirst && kind === 'web' ? state.question : step.title);
      const fresh = addSources(state, hits);
      reading(hits); gathered.push(...fresh);
      await sleep(250);
    }
    sourceCount(state);
    const toRead = gathered.slice(0, BUDGET.readPerStep);      // 每步预算:只精读最相关的几篇
    step.sourceNs = toRead.map(s => s.n);
    step.notes = await takeNotes(state, step.title, toRead);
    act(state, `已完成【${step.title}】研究步骤,我将总结我的发现。`);
    step.status = 'done';
  };
  await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('单步超时')), BUDGET.stepTimeoutMs))]);
}

// ─────────────────────── 8. 报告:引言 / 目录 / 正文 / 结论 / 参考来源 ───────────────────────
async function writeReport(state) {
  const kw = kwOf(state.question);
  const date = new Date().toISOString().slice(0, 10);
  let body;
  if (MOCK) {
    body = state.steps.map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.notes.map(n => `${n}`).join('\n\n')}`).join('\n\n');
  } else {
    body = await llm([{ role: 'system', content: '你是科研写作助理。根据研究步骤与笔记写报告正文,每个步骤一节(## 编号. 标题),保留笔记里的来源编号 [n]。只输出正文 Markdown。' },
      { role: 'user', content: `问题:${state.question}\n\n${state.steps.map(s => `步骤:${s.title}\n${s.notes.join('\n')}`).join('\n\n')}` }]);
  }
  const toc = `- ${kw}\n${state.steps.map(s => `  - ${s.title}`).join('\n')}`;
  const refs = state.sources.map(s => `${s.n}. ${s.icon} ${s.title}(${SOURCES[s.kind].label})`).join('\n');
  const md = `# ${state.question} — Deep Discovery 报告

> ${date} · ${state.steps.length} 个研究步骤 · ${state.sources.length} 个来源 · 模式:${state.mode}${state.focus ? ' · 侧重:' + state.focus : ''}

## 引言

围绕「${state.question}」,本报告依次考察了${state.steps.map(s => s.title).join('、')}。资料来自网页、GeoGPT Library 与个人资源库三类来源,经相关性筛选与去重后精读整理。

## 目录

${toc}

${body}

## 结论

综合各研究步骤,${kw}是一个多阶段、多因素耦合的过程:${state.steps.map(s => s.title).join(' → ')}构成了理解它的主线。主流观点在框架上趋于一致,细节仍有开放问题,值得结合更多一手数据继续研究。

## 参考来源

${refs}
`;
  const file = path.join(__dirname, `report-${kw.replace(/\s+/g, '_')}.md`);
  fs.writeFileSync(file, md);
  return file;
}

// ─────────────────────── 入口:状态机 ───────────────────────
(async () => {
  let state;
  if (RESUME && fs.existsSync(STATE_FILE)) {
    state = load();
    const done = state.steps.filter(s => s.status === 'done').length;
    console.log(`↻ 从检查点恢复:「${state.question}」已完成 ${done}/${state.steps.length} 步,${state.sources.length} 个来源,继续。`);
  } else {
    state = newState(QUESTION);
    console.log(`🎯 ${QUESTION}`);
    chat(`开始Deep Discovery,你可以随意离开这个对话。完成后,我会生成一份报告。`);
    act(state, `开始 Deep Discovery: ${state.question}`);
    if (DEEPER) {
      // Deeper:先澄清一个细节;用户随意回复也行,模型自行判断
      if (!YES) { const a = await lineReader().ask(`\n❓ 为了更贴近你的需求:这个问题你更关注科学理论、地质年代,还是某个具体方面?(直接回车跳过)\n> `); state.focus = (a || '').trim(); }
      let steps = await decompose(state);
      steps = await confirmPlan(state, steps);
      if (!steps) return console.log('\n🚫 已取消');
      state.steps = steps.map(title => ({ title, status: 'pending' }));
      act(state, `研究方案已确认,开始 Deeper Discovery。`);
    } else {
      state.steps = (await decompose(state)).map(title => ({ title, status: 'pending' }));
    }
    save(state);
  }
  console.log(`\n⏳ Deep Discovery目前正在执行中。请稍等...  (${state.steps.length} 步)`);
  process.on('SIGINT', () => { save(state); console.log('\n\n💾 已保存检查点,随时 --resume 继续'); process.exit(130); });

  let doneThisRun = 0;
  for (const [i, step] of state.steps.entries()) {
    if (step.status === 'done') continue;
    try { await researchStep(state, step, i === 0); }
    catch (e) { act(state, `【${step.title}】研究步骤失败:${e.message},跳过并继续`); step.status = 'skipped'; }
    save(state);                                                   // 检查点:每步落盘
    if (++doneThisRun >= STOP_AFTER) { console.log(`\n🚪 模拟离开对话(已完成 ${state.steps.filter(s => s.status === 'done').length}/${state.steps.length} 步,检查点已存)。用 --resume 继续。`); return; }
  }

  act(state, '正在撰写 Deep Discovery 报告。');
  await sleep(500);
  state.reportPath = await writeReport(state);
  act(state, `Deep Discovery 已完成。(${state.sources.length} 来源)`);
  save(state);
  console.log(`\n📄 报告已导出: ${state.reportPath}\n${'─'.repeat(60)}`);
  console.log(fs.readFileSync(state.reportPath, 'utf8').split('\n').slice(0, 22).join('\n') + '\n…(完整内容见文件)');
})().catch(e => { console.error('运行失败:', e.message); process.exitCode = 1; }).finally(() => IO?.close());
