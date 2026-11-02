#!/usr/bin/env node
/**
 * vibe-agent — Vibe Research「科研 Coding Agent」最小 harness(单文件、零依赖,Node ≥ 18,需 python3)
 *
 * 核心思路:把 coding agent 的 harness 用到科研复现上。
 *   工作区即状态(Data / Paper / 科研空间,文件就是记忆与产出)
 *   工具集少而正交(read_file / write_file / run_python / list_files / load_skill)
 *   执行反馈循环(写代码 → 跑 → 读报错 → 改 → 再跑),报错是信息不是失败
 *   Skills 按需加载(skills/*.md 是能力说明书,任务需要时才进上下文)
 *   护栏:步数上限、连续失败预算、单次执行超时、路径越界拦截、输出截断
 *
 * 运行:
 *   node vibe-agent.js --mock                    # 无需 key:初始化示例项目 → 复现论文 → 报错自修 → 产出结果/图/报告
 *   node vibe-agent.js --mock --fast             # 不加节奏
 *   node vibe-agent.js --mock "用 Data 里的数据复现论文并对比性能"
 *   OPENAI_API_KEY=xx node vibe-agent.js "…"     # 真模型驱动同一套 harness
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const MOCK = flag('--mock'), FAST = flag('--fast');
const TASK = argv.filter(a => !a.startsWith('--')).join(' ') || '请用 Data 文件夹里的数据复现这篇论文,并把性能和论文报告的结果做对比';
const sleep = ms => FAST ? Promise.resolve() : new Promise(r => setTimeout(r, ms));

// ─────────────────────── 1. 工作区:项目目录就是 Agent 的记忆与产出 ───────────────────────
const WS = path.join(__dirname, 'vibe-workspace', 'shale-gas-forecasting');
const SPACE = 'research_space';
const AREAS = { Data: '数据', Paper: '文档', [SPACE]: '科研空间' };
const GUARD = { maxSteps: 16, errorBudget: 3, runTimeoutMs: 20000, outputCap: 1500 };

function bootstrap() {
  if (fs.existsSync(path.join(WS, 'Data', 'shale_wells.csv'))) return;
  for (const d of ['Data', 'Paper', SPACE, 'skills']) fs.mkdirSync(path.join(WS, d), { recursive: true });
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;   // 固定种子:可复现
  const rows = ['well_id,lateral_length_m,proppant_tons,stages,first_year_production'];
  for (let i = 1; i <= 40; i++) {
    const lat = Math.round(1200 + rnd() * 2000), prop = Math.round(800 + rnd() * 2200), st = Math.round(10 + rnd() * 30);
    const prod = Math.round(0.25 * lat + 0.35 * prop + 6 * st + (rnd() - 0.5) * 300);   // 砂量 > 水平段长 > 段数,对应论文声称的排序
    rows.push(`W${String(i).padStart(3, '0')},${lat},${prop},${st},${prod}`);
  }
  fs.writeFileSync(path.join(WS, 'Data', 'shale_wells.csv'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(WS, 'Paper', 'paper_summary.md'), `# Hybrid data-driven framework for shale gas production forecasting (2023)

## 方法
以水平段长度(lateral length)、压裂砂量(prop_mass)、压裂段数(stages)三个特征预测首年产量,
比较 RF / GBDT / XGBoost 三种集成树模型,用 SHAP 解释特征贡献。

## 论文报告的结果
- 最佳模型 GBDT:R² = 0.87
- 特征重要性排序:prop_mass > lateral length > stages
`);
  fs.writeFileSync(path.join(WS, 'skills', 'reproduce-paper.md'), `# Skill: reproduce-paper
何时用:任务要求"复现论文 / 用数据跑一遍论文方法"。
步骤:
1. 先读 Paper/ 下的论文摘要,提取:特征、目标变量、模型、论文报告的指标。
2. 再看 Data/ 下数据的列名——论文用的名字和数据集列名经常不一致,要做映射。
3. 把计划写成 research_space/outline.json(步骤、特征、指标),再写代码。
4. 脚本只用标准库,固定随机种子,结果落 research_space/detailed_results.json,图落 research_space/。
5. 运行失败就读 stderr 定位,改完重跑;不要在同一个错误上重复超过 3 次。
`);
  fs.writeFileSync(path.join(WS, 'skills', 'compare-results.md'), `# Skill: compare-results
何时用:复现结果已产出,需要和论文对比。
输出 research_space/comparison_report.md:逐项对比指标(复现值 / 论文值 / 差异),
特征重要性排序是否一致,并给出"差异可能来自哪里"(模型不同、数据规模、噪声)。
`);
  fs.writeFileSync(path.join(WS, 'skills', 'write-report.md'), `# Skill: write-report
何时用:任务收尾。
产出 research_space/report.html:执行摘要、方法(三阶段:复现→对比→建议)、指标表、嵌入图、后续研究建议。
`);
}

// ─────────────────────── 2. 工具集:少而正交,每个都带护栏 ───────────────────────
const safe = p => { const abs = path.resolve(WS, p); if (!abs.startsWith(WS + path.sep)) throw new Error(`路径越界被拦截:${p}`); return abs; };
const cap = s => s.length > GUARD.outputCap ? s.slice(0, GUARD.outputCap) + `\n…(截断,共 ${s.length} 字)` : s;
const TOOLS = {
  list_files: { desc: '列出工作区文件', run: () => tree() },
  read_file:  { desc: '读取文件(前 60 行)', run: ({ path: p }) => cap(fs.readFileSync(safe(p), 'utf8').split('\n').slice(0, 60).join('\n')) },
  write_file: { desc: '写入文件(自动创建目录)', run: ({ path: p, content }) => { fs.mkdirSync(path.dirname(safe(p)), { recursive: true }); fs.writeFileSync(safe(p), content); return `已写入 ${p}(${content.length} 字)`; } },
  run_python: { desc: '在工作区沙箱运行 Python 脚本(超时 20s)', run: ({ path: p }) => {
    const r = spawnSync('python3', [safe(p)], { cwd: WS, encoding: 'utf8', timeout: GUARD.runTimeoutMs, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? '执行超时(20s)' : `无法执行:${r.error.message}`);
    return { exit: r.status, stdout: cap(r.stdout || ''), stderr: cap(r.stderr || '') };
  } },
  load_skill: { desc: '加载一个 skill 说明书到上下文', run: ({ name }) => fs.readFileSync(safe(`skills/${name}.md`), 'utf8') },
};
function tree(mark = new Set()) {
  return Object.entries(AREAS).map(([dir, label]) => {
    const files = fs.existsSync(path.join(WS, dir)) ? fs.readdirSync(path.join(WS, dir)).sort() : [];
    return `  ▾ ${label}\n` + (files.length ? files.map(f => `      ${mark.has(`${dir}/${f}`) ? '✦' : ' '} ${f}`).join('\n') : '      (空)');
  }).join('\n');
}

// ─────────────────────── 3. 模型层:真模型 / mock 脚本(mock 对报错是真反应的) ───────────────────────
async function callModel(messages) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.MODEL || 'gpt-4o-mini', messages,
      tools: Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: { name, description: t.desc, parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, name: { type: 'string' } } } } })) }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message;
}

// 复现脚本(纯标准库:多元线性回归 + R² + 标准化系数当特征重要性 + SVG 柱图)
const SCRIPT = features => `import csv, json, statistics
random_seed = 0  # 固定种子,可复现
FEATURES = ${JSON.stringify(features)}
TARGET = 'first_year_production'
rows = list(csv.DictReader(open('Data/shale_wells.csv')))
X = [[float(r[f]) for f in FEATURES] for r in rows]
y = [float(r[TARGET]) for r in rows]
means = [statistics.mean(c) for c in zip(*X)]; sds = [statistics.pstdev(c) for c in zip(*X)]
A = [[1.0] + [(v - m) / s for v, m, s in zip(row, means, sds)] for row in X]
n = len(A[0])
M = [[sum(A[k][i] * A[k][j] for k in range(len(A))) for j in range(n)] + [sum(A[k][i] * y[k] for k in range(len(A)))] for i in range(n)]
for i in range(n):
    M[i] = [v / M[i][i] for v in M[i]]
    for r in range(n):
        if r != i:
            f = M[r][i]; M[r] = [a - f * b for a, b in zip(M[r], M[i])]
beta = [M[i][n] for i in range(n)]
pred = [sum(b * a for b, a in zip(beta, row)) for row in A]
ss_res = sum((yi - pi) ** 2 for yi, pi in zip(y, pred)); ss_tot = sum((yi - statistics.mean(y)) ** 2 for yi in y)
r2 = 1 - ss_res / ss_tot
imp = {f: abs(b) for f, b in zip(FEATURES, beta[1:])}; tot = sum(imp.values()); imp = {k: round(v / tot, 3) for k, v in imp.items()}
results = {'model': 'OLS(standardized)', 'n': len(rows), 'r2': round(r2, 4), 'importance': imp,
           'importance_rank': sorted(imp, key=imp.get, reverse=True)}
json.dump(results, open('research_space/detailed_results.json', 'w'), indent=2, ensure_ascii=False)
bars = ''.join(f'<rect x="20" y="{20 + i * 40}" width="{int(v * 300)}" height="26" fill="#5B7FA6"/><text x="{28 + int(v * 300)}" y="{38 + i * 40}" font-size="13">{k} {v}</text>' for i, (k, v) in enumerate(sorted(imp.items(), key=lambda kv: -kv[1])))
open('research_space/fig_feature_importance.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="140" font-family="sans-serif">{bars}</svg>')
print(json.dumps(results, ensure_ascii=False))
`;

// mock 模型:按 skill 的步骤走;第一版脚本沿用论文里的列名 prop_mass(数据集里叫 proppant_tons)→ 真报错 → 读 stderr → 改列名重跑
function mockModel(messages) {
  const tools = messages.filter(m => m.role === 'tool');
  const last = tools[tools.length - 1];
  const done = name => tools.some(t => t.name === name && (!t.arg || true));
  const seen = (name, sub) => tools.some(t => t.name === name && (t.args || '').includes(sub || ''));
  const call = (name, args, thought) => ({ role: 'assistant', content: thought, tool_calls: [{ id: 'c' + tools.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (!seen('load_skill', 'reproduce-paper')) return call('load_skill', { name: 'reproduce-paper' }, '任务是复现论文,先加载 reproduce-paper 这个 skill 看步骤。');
  if (!seen('read_file', 'paper_summary')) return call('read_file', { path: 'Paper/paper_summary.md' }, '按 skill 第 1 步:读论文摘要,拿特征、指标和论文报告的结果。');
  if (!seen('read_file', 'shale_wells')) return call('read_file', { path: 'Data/shale_wells.csv' }, '第 2 步:看数据列名。');
  if (!seen('write_file', 'outline.json')) return call('write_file', { path: `${SPACE}/outline.json`, content: JSON.stringify({ task: '复现论文并对比', steps: ['读论文与数据', '写复现脚本(OLS,标准库)', '运行并产出 results/fig', '与论文对比', '写报告'], features: ['lateral_length_m', 'prop_mass', 'stages'], target: 'first_year_production', paper_claims: { r2: 0.87, importance_rank: ['prop_mass', 'lateral length', 'stages'] } }, null, 2) }, '第 3 步:先把计划落成 outline.json 再写代码。');
  if (!seen('write_file', 'reproduce_paper.py')) return call('write_file', { path: `${SPACE}/reproduce_paper.py`, content: SCRIPT(['lateral_length_m', 'prop_mass', 'stages']) }, '第 4 步:写复现脚本,特征名先沿用论文里的叫法。');
  const runs = tools.filter(t => t.name === 'run_python');
  if (runs.length === 0) return call('run_python', { path: `${SPACE}/reproduce_paper.py` }, '第 5 步:运行。');
  const lastRun = runs[runs.length - 1];
  if (lastRun.exit !== 0) {
    const m = (lastRun.stderr || '').match(/KeyError: '(\w+)'/);
    if (m && !seen('write_file', 'proppant_tons')) return call('write_file', { path: `${SPACE}/reproduce_paper.py`, content: SCRIPT(['lateral_length_m', 'proppant_tons', 'stages']) }, `报错 KeyError: '${m[1]}'——论文里叫 ${m[1]},数据集列名是 proppant_tons(第 2 步看到的),做列名映射后重写脚本。`);
    return call('run_python', { path: `${SPACE}/reproduce_paper.py` }, '修好了,重跑。');
  }
  if (!seen('load_skill', 'compare-results')) return call('load_skill', { name: 'compare-results' }, '跑通了,加载 compare-results 看对比要怎么写。');
  if (!seen('write_file', 'comparison_report')) {
    const r = JSON.parse(lastRun.stdout);
    const rankOk = r.importance_rank[0] === 'proppant_tons' && r.importance_rank[1] === 'lateral_length_m';
    return call('write_file', { path: `${SPACE}/comparison_report.md`, content: `# 复现结果 vs 论文\n\n| 指标 | 复现 | 论文 | 差异 |\n|---|---|---|---|\n| R² | ${r.r2} | 0.87 | ${(r.r2 - 0.87).toFixed(3)} |\n| 模型 | OLS(标准库) | GBDT | 模型族不同 |\n| 样本量 | ${r.n} | 未披露 | — |\n\n特征重要性排序:复现 ${r.importance_rank.join(' > ')};论文 prop_mass > lateral length > stages —— ${rankOk ? '一致' : '不一致'}。\n\n差异可能来源:①模型不同(线性 vs 集成树);②样本规模小;③合成噪声。结论:核心结论(砂量与水平段长度主导产量)可复现。\n` }, '按 skill 写对比报告,逐项列指标差异并解释来源。');
  }
  if (!seen('load_skill', 'write-report')) return call('load_skill', { name: 'write-report' }, '最后加载 write-report。');
  if (!seen('write_file', 'report.html')) {
    const r = JSON.parse(lastRun.stdout); const svg = fs.readFileSync(path.join(WS, SPACE, 'fig_feature_importance.svg'), 'utf8');
    return call('write_file', { path: `${SPACE}/report.html`, content: `<!doctype html><meta charset="utf-8"><title>Shale Gas Production Performance – Reproduction Report</title><style>body{font-family:sans-serif;max-width:760px;margin:40px auto;line-height:1.6}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 12px}</style><h1>Reproduction Report</h1><h2>Executive Summary</h2><p>复现 R² = ${r.r2}(论文 0.87),特征重要性排序 ${r.importance_rank.join(' > ')}。核心结论可复现。</p><h2>Methodology</h2><ol><li>复现:标准库 OLS,固定种子</li><li>对比:逐项指标与排序</li><li>建议:换集成树模型、扩大样本</li></ol><h2>Performance Comparison</h2><table><tr><th>指标</th><th>复现</th><th>论文</th></tr><tr><td>R²</td><td>${r.r2}</td><td>0.87</td></tr></table><h2>Feature Importance</h2>${svg}<h2>Follow-up</h2><p>用 GBDT 复现以对齐模型族;引入 SHAP 做逐样本解释。</p>` }, '写 HTML 报告,嵌入指标表和图。');
  }
  const r = JSON.parse(lastRun.stdout);
  const rankOk = r.importance_rank[0] === 'proppant_tons' && r.importance_rank[1] === 'lateral_length_m';   // 结论从结果推导,不预设
  return { role: 'assistant', content: `复现完成。产出:outline.json(计划)、reproduce_paper.py(脚本,经一次列名修复)、detailed_results.json、fig_feature_importance.svg、comparison_report.md、report.html。复现 R² = ${r.r2}(论文 0.87);特征重要性排序 ${r.importance_rank.join(' > ')},与论文${rankOk ? '一致' : '不完全一致(见对比报告的差异分析)'}。` };
}

// ─────────────────────── 4. 主循环:执行反馈驱动 + 护栏 ───────────────────────
async function run() {
  bootstrap();
  if (!flag('--keep')) { fs.rmSync(path.join(WS, SPACE), { recursive: true, force: true }); fs.mkdirSync(path.join(WS, SPACE)); }   // 科研空间每次从空开始(--keep 保留)
  const before = new Set(fs.readdirSync(path.join(WS, SPACE)).map(f => `${SPACE}/${f}`));
  const newFiles = () => new Set(fs.readdirSync(path.join(WS, SPACE)).map(f => `${SPACE}/${f}`).filter(f => !before.has(f)));   // 产出 = 本次运行新出现的文件,不管是谁写的
  console.log(`┌ zero2x Lab · Vibe Research ┐  项目: 页岩气产量预测   工作区: ${path.relative(process.cwd(), WS) || '.'}`);
  console.log('📁 资料区\n' + tree());
  console.log(`\n💬 ${TASK}\n`);
  const messages = [
    { role: 'system', content: `你是科研复现助手,在一个项目工作区里工作。工作区目录:Data(数据)、Paper(文档)、${SPACE}(科研空间,你的所有产出放这里)、skills(能力说明书)。开始前用 load_skill 加载相关 skill 并严格按其步骤执行;脚本只用 Python 标准库;运行失败先读 stderr 再修。` },
    { role: 'user', content: TASK },
  ];
  let consecutiveFails = 0;

  for (let step = 1; step <= GUARD.maxSteps; step++) {
    const msg = MOCK ? mockModel(messages) : await callModel(messages);
    messages.push(msg);
    if (msg.content) console.log(`🧠 ${msg.content}`);
    if (!msg.tool_calls?.length) { console.log(`\n✅ [第 ${step} 步] 完成`); break; }

    for (const tc of msg.tool_calls) {
      const name = tc.function.name, args = JSON.parse(tc.function.arguments || '{}');
      const argShow = args.path || args.name || '';
      console.log(`🔧 [第 ${step} 步] ${name}(${argShow})`);
      await sleep(350);
      let result, rec = { role: 'tool', tool_call_id: tc.id, name, args: JSON.stringify(args) };
      try {
        result = TOOLS[name] ? TOOLS[name].run(args) : (() => { throw new Error(`未知工具 ${name}`); })();
        if (name === 'run_python') {
          Object.assign(rec, result);
          if (result.exit === 0) { consecutiveFails = 0; console.log(`   ↳ exit 0\n   ${result.stdout.trim().split('\n').map(l => '   ' + l).join('\n')}`); }
          else { consecutiveFails++; console.log(`   ↳ ✗ exit ${result.exit}\n      ${result.stderr.trim().split('\n').slice(-1)[0]}`); }
          if (result.exit === 0) console.log('   科研空间: ' + [...newFiles()].map(f => '✦' + f.split('/')[1]).join('  '));
          result = JSON.stringify(result);
        } else if (name === 'write_file') {
          console.log(`   ↳ ${result}`);
          console.log('   科研空间: ' + [...newFiles()].map(f => '✦' + f.split('/')[1]).join('  '));
        } else if (name === 'load_skill') console.log(`   ↳ 已加载 skill(${result.length} 字)注入上下文`);
        else console.log(`   ↳ ${String(result).split('\n').length} 行`);
      } catch (e) { result = `[工具错误] ${e.message}`; console.log(`   ↳ ✗ ${e.message}`); }
      messages.push({ ...rec, content: String(result) });
      if (consecutiveFails >= GUARD.errorBudget) { console.log(`\n⛔ 连续 ${GUARD.errorBudget} 次运行失败,超出错误预算,停止并交由人处理(避免在同一个错误上无限打转)`); return; }
    }
  }
  console.log('\n📁 资料区(✦ 为本次产出)\n' + tree(newFiles()));
  console.log(`\n📄 报告: ${path.join(WS, SPACE, 'report.html')}`);
}
run().catch(e => { console.error('运行失败:', e.message); process.exit(1); });
