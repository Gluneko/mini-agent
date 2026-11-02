#!/usr/bin/env node
/**
 * agent-builder — 智能体搭建平台最小实现(单文件、零依赖,Node ≥ 18)
 * 对应 GeoGPT Agent Builder 四个模块:
 *   工具(MCP):商店 / 我的 MCP / 一键部署(stdio 启动命令)/ 自部署(http endpoint)/ 连接状态 / API Key / 子工具调试
 *             —— 真实 MCP 客户端:JSON-RPC 2.0 over stdio(initialize → tools/list → tools/call),请求 id 配对 + 超时
 *   技能(Skills):标准结构(SKILL.md 含 name/description/triggers)/ 导入转换 / 商店与我的技能
 *   智能体(Agents):自然语言创建 → 生成配置(名称/描述/提示词/推荐问题/挂载的 Skills 与 MCP 工具)→ YAML → 调试对话 → 发布
 *             运行时:system = 提示词 + 按需加载的 skill;tools = 已连接 MCP 服务器的子工具;ReAct 循环
 *   工作流(Workflow):节点图执行引擎(assign / code / condition / http(重试) / agent / end),变量上下文,执行轨迹
 *
 * 运行(全部无需 key):
 *   node agent-builder.js mcp list
 *   node agent-builder.js mcp connect gis-tools
 *   node agent-builder.js mcp debug gis-tools buffer_analysis '{"layer":"faults","distance_m":500}'
 *   node agent-builder.js mcp add my-tool --stdio "node mcp-geo-tools.js"
 *   node agent-builder.js skill list | skill import ./some-skill-dir
 *   node agent-builder.js create "帮我创建一个石油矿井进场选址的智能体" --mock
 *   node agent-builder.js chat site-selection "分析断层线 500 米缓冲区内的选址适宜性" --mock
 *   node agent-builder.js workflow run mineral-assistant --mock "找一下该区域的铜矿靶区"
 *   node agent-builder.js agents | publish site-selection --team
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const MOCK = flag('--mock');
const WS = path.join(__dirname, 'builder-workspace');
const P = { mcp: path.join(WS, 'mcp.json'), skills: path.join(WS, 'skills'), agents: path.join(WS, 'agents'), workflows: path.join(WS, 'workflows') };
const readJSON = (f, d) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

// ─────────────────────── 0. 工作区初始化(商店里的官方资源) ───────────────────────
function bootstrap() {
  if (fs.existsSync(P.mcp)) return;
  for (const d of [P.skills, P.agents, P.workflows]) fs.mkdirSync(d, { recursive: true });
  writeJSON(P.mcp, { servers: [
    { id: 'gis-tools', name: 'GIS基础工具', owner: 'geogpt', official: true, category: 'GIS工具', transport: 'stdio', command: `node ${path.join(__dirname, 'mcp-geo-tools.js')}`, timeout: 60, desc: '由GeoGPT提供的GIS基础工具,可针对shapefile、geojson和tiff类型的数据进行基础数据分析与空间计算。' },
    { id: 'web-search', name: 'GeoGPT联网搜索', owner: 'geogpt', official: true, category: '搜索工具', transport: 'stdio', command: `node ${path.join(__dirname, 'mcp-geo-tools.js')}`, timeout: 60, desc: '由GeoGPT提供的网络搜索工具,能帮您快速从互联网上查找并获取您需要的信息。' },
    { id: 'firecrawl', name: 'FireCrawl', owner: 'geogpt', official: false, category: '数据工具', transport: 'http', endpoint: 'https://mcp.firecrawl.dev/v1', protocol: 'StreamableHttp', requiresKey: 'FIRECRAWL_API_KEY', apiKey: null, desc: '智能网络爬虫与数据抓取服务。支持JS渲染、批量处理及内容智能过滤。' },
  ] });
  const skill = (name, desc, triggers, body) => fs.writeFileSync(path.join(P.skills, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\ntriggers: ${triggers}\nowner: geogpt\n---\n${body}\n`);
  skill('agent-config-updater', '根据用户描述生成或更新智能体配置(名称/提示词/工具/推荐问题)', '创建智能体, 修改智能体, 配置智能体', '步骤:1.获取当前可用 MCP 工具列表 2.从描述提取领域与任务 3.生成 Role/Background/Skills/Workflow 结构的提示词 4.按领域关键词挑选工具 5.写入 YAML 并给出 3 条推荐问题');
  skill('geo-visualizer', '将 GIS 数据(Shapefile、栅格、属性表)转化为地图与空间分析结果', 'GIS, 地质数据可视化, 缓冲区, 叠加分析, Shapefile', '优先用 MCP 的 GIS 工具做分析;结果以图层 + 属性表呈现;缓冲区/叠加/距离计算要说明参数与坐标系');
  skill('web-app-generator', '通过自然语言生成可预览可分享的网页应用', '网页应用, 落地页, 网站', '产出单文件 index.html;移动端适配;先写结构再写样式;生成后验证文件存在');
  writeJSON(path.join(P.agents, 'bird-scientist.json'), { id: 'bird-scientist', name: '燚山云迹-候鸟科学家', type: 'Config', owner: '江西师范大学', status: 'published', visibility: 'store', description: '候鸟生态全能助手,通晓候鸟世界奥秘,护航候鸟生存繁衍。', prompt: { role: '候鸟生态助手' }, skills: [], mcp: ['web-search'], model: 'Qwen3-32B', chat: { opening: '你好,我是候鸟科学家。', suggestions: ['东亚-澳大利西亚迁飞区有哪些关键停歇地?'] } });
  writeJSON(path.join(P.workflows, 'mineral-assistant.json'), { id: 'mineral-assistant', name: '矿产分析预测助手', type: 'Workflow', status: 'published',
    nodes: [
      { id: 'start', type: 'start', next: 'init' },
      { id: 'init', type: 'assign', label: '图层服务初始化', set: { layer_service: 'http://gis.local/layers', url: 'http://47.238.133.241/v1.0', extent: '113,22,115,24' }, next: 'calc' },
      { id: 'calc', type: 'code', label: '代码执行-计算TOKEN有效期', code: 'const ttl = vars.token_expires_at ? vars.token_expires_at - Date.now() : -1; return { result: ttl > 0 ? 1 : 0 };', next: 'check' },
      { id: 'check', type: 'condition', label: '判断当前TOKEN是否有效', expr: 'vars.result === 1', branches: { IF: 'stamp', ELSE: 'login' } },
      { id: 'login', type: 'http', label: 'POST /api/user/login', method: 'POST', url: '{{url}}/api/user/login', retry: 3, mockFailTimes: 2, set: { token: 'tok_7f3a', token_expires_at: '{{now+3600}}' }, next: 'stamp' },
      { id: 'stamp', type: 'assign', label: '寄存当前时间戳', set: { keytime: '{{now}}' }, next: 'lang' },
      { id: 'lang', type: 'code', label: '判断提问语言', code: 'return { lang: /[\\u4e00-\\u9fa5]/.test(vars.question) ? "zh" : "en" };', next: 'agent' },
      { id: 'agent', type: 'agent', label: '找矿工具智能体对话', strategy: 'FunctionCalling', model: 'Qwen3-32B', mcp: ['gis-tools'], input: '{{question}}', next: 'end' },
      { id: 'end', type: 'end' },
    ] });
}

// ─────────────────────── 1. MCP 客户端:真协议(JSON-RPC 2.0 over stdio) ───────────────────────
class McpStdioClient {
  constructor(command, timeoutSec = 60) {
    const [cmd, ...args] = command.split(/\s+/);
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.timeout = timeoutSec * 1000; this.seq = 0; this.pending = new Map(); this.buf = '';
    this.proc.stdout.on('data', d => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (line.trim()) this.onMessage(JSON.parse(line)); } });
    this.proc.stderr.on('data', d => process.stderr.write(`[mcp stderr] ${d}`));
  }
  onMessage(msg) {                                                             // 按 id 配对响应;迟到的直接丢
    const p = this.pending.get(msg.id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(msg.id);
    msg.error ? p.reject(new Error(`${msg.error.code} ${msg.error.message}`)) : p.resolve(msg.result);
  }
  request(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时(${this.timeout / 1000}s)`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async connect() {                                                            // MCP 握手三步
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-builder', version: '0.1.0' } });
    this.notify('notifications/initialized');
    return init;
  }
  listTools() { return this.request('tools/list').then(r => r.tools); }
  callTool(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() { this.proc.kill(); }
}
async function connectServer(s) {
  if (s.transport === 'http') { if (s.requiresKey && !s.apiKey) throw new Error('请配置有效的Key以连接工具(MCP)'); throw new Error('http 传输在本实现里仅登记配置,不实际连接'); }
  const c = new McpStdioClient(s.command, s.timeout);
  const info = await c.connect(); const tools = await c.listTools();
  return { client: c, info, tools };
}

// ─────────────────────── 2. Skills:标准结构 + 导入转换 + 按触发词挑选 ───────────────────────
function loadSkills() {
  return fs.readdirSync(P.skills).filter(f => f.endsWith('.md')).map(f => {
    const raw = fs.readFileSync(path.join(P.skills, f), 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); const meta = {};
    (m ? m[1] : '').split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    return { ...meta, triggers: (meta.triggers || '').split(',').map(s => s.trim()).filter(Boolean), body: (m ? m[2] : raw).trim(), file: f };
  });
}
function importSkill(dir) {                                                    // skill-converter:任意目录 → 标准 SKILL 结构
  const name = path.basename(dir).replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  const readme = ['SKILL.md', 'README.md', 'readme.md'].map(f => path.join(dir, f)).find(fs.existsSync);
  const body = readme ? fs.readFileSync(readme, 'utf8') : '(空技能包)';
  const desc = (body.split('\n').find(l => l.trim() && !l.startsWith('#')) || name).slice(0, 120);
  fs.writeFileSync(path.join(P.skills, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\ntriggers: ${name}\nowner: me\nstatus: draft\n---\n${body}\n`);
  return name;
}
const pickSkills = (text, skills) => skills.filter(s => s.triggers.some(t => t && text.includes(t)));

// ─────────────────────── 3. 智能体:自然语言创建 → 配置 → 运行时 ───────────────────────
const toYAML = (o, ind = '') => Object.entries(o).map(([k, v]) => Array.isArray(v) ? `${ind}${k}:\n${v.map(x => typeof x === 'object' ? `${ind}  -\n${toYAML(x, ind + '    ')}` : `${ind}  - ${x}`).join('\n')}` : (v && typeof v === 'object') ? `${ind}${k}:\n${toYAML(v, ind + '  ')}` : `${ind}${k}: ${String(v).includes('\n') ? '|\n' + String(v).split('\n').map(l => ind + '  ' + l).join('\n') : v}`).join('\n');

async function createAgent(desc) {
  console.log(`💬 ${desc}\n`);
  const skills = loadSkills(); const updater = skills.find(s => s.name === 'agent-config-updater');
  console.log(`📖 加载 skill: agent-config-updater —— ${updater.body.split(';')[0]}`);
  const mcp = readJSON(P.mcp, { servers: [] });
  console.log('🔧 获取 MCP 工具列表');
  const toolCatalog = [];
  for (const s of mcp.servers) { try { const { client, tools } = await connectServer(s); toolCatalog.push({ server: s.id, tools }); client.close(); console.log(`   ${s.name}: ${tools.length} 个子工具`); } catch (e) { console.log(`   ${s.name}: 未连接(${e.message})`); } }
  // mock 模型:从描述提取领域,生成配置;真模型把 toolCatalog + skills 目录喂进去做结构化输出
  const domain = desc.replace(/帮我|创建|一个|的?智能体|做|请/g, '').trim() || '通用助手';
  const wantsGIS = /选址|矿|地质|地形|GIS|缓冲|图层/.test(desc);
  const agent = {
    id: /选址/.test(desc) ? 'site-selection' : domain.replace(/\s+/g, '-').slice(0, 20), name: `${domain}智能体`, type: 'Chat', owner: 'me', status: 'draft', visibility: 'private',
    description: `基于${wantsGIS ? '地质、地形、交通、环保等多维度 GIS 空间分析' : '领域知识'},为${domain}提供智能化决策支持的智能体。${wantsGIS ? '支持缓冲区分析、叠加分析、坡度分析等空间计算。' : ''}`,
    prompt: { role: `${domain}智能体`, background: `${domain}需要综合多维度因素进行专业评估,本助手面向该场景提供分析与推荐。`, skills: '按需调用 GIS 工具做空间计算;结论附参数与依据;不确定时先澄清区域与数据。', workflow: '1.明确区域与约束 2.调用工具分析 3.综合评分排序 4.给出推荐与风险' },
    knowledge: [], skills: pickSkills(desc + (wantsGIS ? ' GIS' : ''), skills).map(s => s.name).filter(n => n !== 'agent-config-updater'),
    mcp: wantsGIS ? ['gis-tools'] : ['web-search'], model: 'Qwen3-32B',
    chat: { opening: `您好!我是${domain}智能体,能够基于多维度因素为您提供专业的评估与推荐服务。请上传相关数据或描述您的需求,我将为您展开分析。`, fileUpload: true,
      suggestions: wantsGIS ? [`请帮我分析某区域的${domain}适宜性,考虑地质、地形和交通因素`, '如何对候选区域进行缓冲区分析,排除环境敏感区和居民区?', `请根据已有的地质和地形数据,生成${domain}推荐方案并进行评分排序`] : [`介绍一下${domain}的关键问题`, '我应该从哪些数据开始?'] },
  };
  writeJSON(path.join(P.agents, `${agent.id}.json`), agent);
  fs.writeFileSync(path.join(P.agents, `${agent.id}.yaml`), toYAML(agent));
  console.log(`🔧 更新智能体 YAML 配置文件 → agents/${agent.id}.yaml`);
  console.log(`\n┌ 预览 ┐\n  ${agent.name}\n  ${agent.chat.opening}\n${agent.chat.suggestions.map(s => `  › ${s}`).join('\n')}\n  挂载: skills=${JSON.stringify(agent.skills)} mcp=${JSON.stringify(agent.mcp)} 模型=${agent.model}\n  状态: ${agent.status} · ${agent.visibility === 'private' ? '仅自己可用' : agent.visibility}`);
  console.log(`\n下一步: node agent-builder.js chat ${agent.id} "…" --mock   |   node agent-builder.js publish ${agent.id} --team`);
}

async function chatAgent(id, question) {
  const agent = readJSON(path.join(P.agents, `${id}.json`), null); if (!agent) return console.log(`未找到智能体 ${id}`);
  const skills = loadSkills().filter(s => agent.skills.includes(s.name));
  const system = `${Object.entries(agent.prompt).map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}:\n${v}`).join('\n\n')}\n\n${skills.map(s => `# Skill: ${s.name}\n${s.body}`).join('\n\n')}`;
  console.log(`🤖 ${agent.name}  模型=${agent.model}  skills=${skills.map(s => s.name).join(',') || '无'}`);
  // 挂载已连接 MCP 服务器的子工具 → 模型可调用的工具目录(name 带服务器前缀防冲突)
  const mcp = readJSON(P.mcp, { servers: [] }); const conns = [];
  for (const sid of agent.mcp) { const s = mcp.servers.find(x => x.id === sid); if (!s) continue; try { const c = await connectServer(s); conns.push({ sid, ...c }); console.log(`🔗 MCP ${s.name} 已连接,${c.tools.length} 个子工具`); } catch (e) { console.log(`⚠️ MCP ${s.name} 未连接:${e.message}`); } }
  const tools = conns.flatMap(c => c.tools.map(t => ({ name: `${c.sid}__${t.name}`, description: t.description, parameters: t.inputSchema, call: a => c.client.callTool(t.name, a) })));
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }];
  console.log(`\n💬 ${question}`);
  for (let step = 1; step <= 6; step++) {
    const msg = MOCK ? mockAgentModel(messages, tools, question) : await callModel(messages, tools);
    messages.push(msg);
    if (!msg.tool_calls?.length) { console.log(`\n✅ ${msg.content}`); break; }
    for (const tc of msg.tool_calls) {
      const t = tools.find(x => x.name === tc.function.name); const args = JSON.parse(tc.function.arguments || '{}');
      console.log(`🔧 [第 ${step} 步] ${tc.function.name}(${JSON.stringify(args)})`);
      let text; try { const r = await t.call(args); text = r.content.map(c => c.text).join('\n'); if (r.isError) text = '[工具错误] ' + text; } catch (e) { text = `[调用失败] ${e.message}`; }
      console.log(`   ↳ ${text.slice(0, 160)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
    }
  }
  conns.forEach(c => c.client.close());
}
function mockAgentModel(messages, tools, question) {
  const done = messages.filter(m => m.role === 'tool');
  const buffer = tools.find(t => t.name.endsWith('buffer_analysis'));
  if (buffer && !done.length) { const d = (question.match(/(\d+)\s*米/) || [])[1]; return { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: buffer.name, arguments: JSON.stringify({ layer: /断层/.test(question) ? 'faults' : 'samples', distance_m: Number(d || 500) }) } }] }; }
  if (buffer && done.length === 1 && tools.find(t => t.name.endsWith('get_layers_metadata'))) return { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: tools.find(t => t.name.endsWith('get_layers_metadata')).name, arguments: '{}' } }] };
  const r = done[0] ? JSON.parse(done[0].content.replace(/^\[.*?\] /, '') || '{}') : {};
  return { role: 'assistant', content: `基于缓冲区分析:${r.layer || '目标图层'} ${r.distance_m || ''} 米缓冲区面积约 ${r.area_km2 ?? '-'} km²,覆盖 ${r.features_covered ?? '-'} 个要素。结合图层元数据,建议优先在缓冲区外、坡度平缓、靠近道路的地块选址;下一步可对候选地块做叠加分析与评分排序。(参数:layer=${r.layer}, distance_m=${r.distance_m})` };
}
async function callModel(messages, tools) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.MODEL || 'gpt-4o-mini', messages, tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }) });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}`); return (await res.json()).choices[0].message;
}

// ─────────────────────── 4. 工作流:节点图执行引擎 ───────────────────────
async function runWorkflow(id, question) {
  const wf = readJSON(path.join(P.workflows, `${id}.json`), null); if (!wf) return console.log(`未找到工作流 ${id}`);
  const vars = { question }; const byId = Object.fromEntries(wf.nodes.map(n => [n.id, n]));
  const tpl = s => String(s).replace(/\{\{now\+(\d+)\}\}/g, (_, n) => Date.now() + n * 1000).replace(/\{\{now\}\}/g, Date.now()).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  console.log(`▶ 工作流 ${wf.name}\n`);
  let cur = 'start', guard = 0, failCount = {};
  while (cur && guard++ < 50) {
    const n = byId[cur]; const tag = `[${n.type}]`.padEnd(12);
    if (n.type === 'start') { cur = n.next; continue; }
    if (n.type === 'end') { console.log(`${tag} 结束`); break; }
    if (n.type === 'assign') { for (const [k, v] of Object.entries(n.set)) vars[k] = isNaN(tpl(v)) ? tpl(v) : Number(tpl(v)); console.log(`${tag} ${n.label} → ${Object.keys(n.set).join(', ')}`); cur = n.next; continue; }
    if (n.type === 'code') { const out = new Function('vars', n.code)(vars); Object.assign(vars, out); console.log(`${tag} ${n.label} → ${JSON.stringify(out)}`); cur = n.next; continue; }
    if (n.type === 'condition') { const ok = new Function('vars', `return (${n.expr})`)(vars); console.log(`${tag} ${n.label}: ${n.expr} → ${ok ? 'IF' : 'ELSE'}`); cur = n.branches[ok ? 'IF' : 'ELSE']; continue; }
    if (n.type === 'http') {                                                    // 失败时重试 N 次(mock 前 mockFailTimes 次失败)
      failCount[n.id] = (failCount[n.id] || 0) + 1;
      const fail = MOCK && failCount[n.id] <= (n.mockFailTimes || 0);
      console.log(`${tag} ${n.method} ${tpl(n.url)} → ${fail ? `失败(第 ${failCount[n.id]} 次)` : '200'}`);
      if (fail) { if (failCount[n.id] > n.retry) { console.log('   ⛔ 超过重试次数,工作流终止'); break; } console.log(`   ↻ 失败时重试(${failCount[n.id]}/${n.retry})`); continue; }
      for (const [k, v] of Object.entries(n.set || {})) vars[k] = isNaN(tpl(v)) ? tpl(v) : Number(tpl(v)); cur = n.next; continue;
    }
    if (n.type === 'agent') {
      console.log(`${tag} ${n.label}  策略=${n.strategy} 模型=${n.model} 工具箱=${n.mcp.join(',')}`);
      const mcp = readJSON(P.mcp, { servers: [] }); const conns = [];
      for (const sid of n.mcp) { const s = mcp.servers.find(x => x.id === sid); try { const c = await connectServer(s); conns.push({ sid, ...c }); } catch (e) { console.log(`   ⚠️ ${sid}: ${e.message}`); } }
      const tools = conns.flatMap(c => c.tools.map(t => ({ name: `${c.sid}__${t.name}`, description: t.description, parameters: t.inputSchema, call: a => c.client.callTool(t.name, a) })));
      const q = tpl(n.input); const msgs = [{ role: 'system', content: '你是找矿助手,先查图层元数据再做分析。' }, { role: 'user', content: q }];
      for (let i = 0; i < 4; i++) {
        const msg = MOCK ? mockMineralModel(msgs, tools) : await callModel(msgs, tools); msgs.push(msg);
        if (!msg.tool_calls?.length) { vars.answer = msg.content; console.log(`   ✅ ${msg.content}`); break; }
        for (const tc of msg.tool_calls) { const t = tools.find(x => x.name === tc.function.name); const args = JSON.parse(tc.function.arguments || '{}'); const r = await t.call(args); const text = r.content.map(c => c.text).join(''); console.log(`   🔧 ${tc.function.name}(${JSON.stringify(args)}) ↳ ${text.slice(0, 120)}`); msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text }); }
      }
      conns.forEach(c => c.client.close()); cur = n.next; continue;
    }
    throw new Error(`未知节点类型 ${n.type}`);
  }
  console.log(`\n📦 变量上下文: ${JSON.stringify({ ...vars, answer: vars.answer ? vars.answer.slice(0, 60) + '…' : undefined })}`);
}
function mockMineralModel(msgs, tools) {
  const done = msgs.filter(m => m.role === 'tool');
  const find = n => tools.find(t => t.name.endsWith(n));
  if (!done.length && find('get_layers_metadata')) return { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: find('get_layers_metadata').name, arguments: '{}' } }] };
  if (done.length === 1 && find('IDW_algorithm')) return { role: 'assistant', content: null, tool_calls: [{ id: 'm2', type: 'function', function: { name: find('IDW_algorithm').name, arguments: JSON.stringify({ field: 'Cu_ppm', power: 2 }) } }] };
  return { role: 'assistant', content: `已基于 3 个图层完成铜品位 IDW 插值(idw_Cu_ppm_p2.tif),高值异常集中在断层线交汇处,建议圈定 2 个靶区做进一步取样。` };
}

// ─────────────────────── 5. 管理命令 ───────────────────────
const STATUS = s => s.transport === 'http' ? (s.requiresKey && !s.apiKey ? '未连接 · 请配置API Key' : '未连接') : '已连接';
async function main() {
  bootstrap();
  const [cmd, sub, ...rest] = argv.filter(a => !a.startsWith('--'));
  const mcp = readJSON(P.mcp, { servers: [] });
  if (cmd === 'mcp' && (sub === 'list' || !sub)) {
    console.log('MCP 商店(官方)'); mcp.servers.filter(s => s.official).forEach(s => console.log(`  ${s.name.padEnd(14)} ${s.category.padEnd(8)} ${STATUS(s)}   ${s.desc.slice(0, 40)}…`));
    console.log('我的 MCP'); mcp.servers.filter(s => !s.official).forEach(s => console.log(`  ${s.name.padEnd(14)} ${(s.category || '').padEnd(8)} ${STATUS(s)}   ${s.transport}${s.endpoint ? ' ' + s.endpoint : ''}`)); return;
  }
  if (cmd === 'mcp' && sub === 'add') {                                        // 一键部署(stdio 启动命令)/ 自部署(http endpoint)
    const i = argv.indexOf('--stdio'), j = argv.indexOf('--http');
    const s = { id: rest[0], name: rest[0], owner: 'me', official: false, category: '其他', timeout: 60, desc: '' };
    if (i >= 0) Object.assign(s, { transport: 'stdio', command: argv[i + 1] }); else if (j >= 0) Object.assign(s, { transport: 'http', endpoint: argv[j + 1], protocol: 'StreamableHttp' }); else return console.log('用法: mcp add <id> --stdio "启动命令" | --http <endpoint>');
    mcp.servers.push(s); writeJSON(P.mcp, mcp); console.log(`已添加 ${s.id}(${s.transport}),访问与使用权限默认仅限本人`); return;
  }
  if (cmd === 'mcp' && sub === 'key') { const s = mcp.servers.find(x => x.id === rest[0]); s.apiKey = rest[1]; writeJSON(P.mcp, mcp); console.log(`已配置 ${s.name} 的 ${s.requiresKey}`); return; }
  if (cmd === 'mcp' && sub === 'connect') {
    const s = mcp.servers.find(x => x.id === rest[0]); if (!s) return console.log('未找到');
    try { const { client, info, tools } = await connectServer(s); console.log(`🔗 ${s.name} 已连接  server=${info.serverInfo.name}@${info.serverInfo.version} protocol=${info.protocolVersion}\n子工具列表(${tools.length}):`); tools.forEach(t => console.log(`  ${t.name.padEnd(26)} ${t.description}`)); client.close(); }
    catch (e) { console.log(`✗ ${s.name} ${e.message}`); } return;
  }
  if (cmd === 'mcp' && sub === 'debug') {                                      // 工具调试:输入参数 → 运行 → 返回结果
    const s = mcp.servers.find(x => x.id === rest[0]); const args = JSON.parse(rest[2] || '{}');
    try { const { client } = await connectServer(s); console.log(`工具调试: ${rest[1]}  输入 ${JSON.stringify(args)}`); const r = await client.callTool(rest[1], args); console.log(`${r.isError ? '✗' : '✓'} 输出: ${r.content.map(c => c.text).join('\n')}`); client.close(); }
    catch (e) { console.log(`✗ ${e.message}`); } return;
  }
  if (cmd === 'skill' && (sub === 'list' || !sub)) { loadSkills().forEach(s => console.log(`  ${s.name.padEnd(22)} ${s.owner === 'geogpt' ? '技能商店' : '我的技能'} ${(s.status || 'published').padEnd(9)} 触发: ${s.triggers.join(' / ')}\n${''.padEnd(24)}${s.description}`)); return; }
  if (cmd === 'skill' && sub === 'import') { const n = importSkill(rest[0]); console.log(`已导入并转换为标准 Skill 结构: skills/${n}.md(草稿,仅自己可用)`); return; }
  if (cmd === 'create') return createAgent(sub);
  if (cmd === 'chat') return chatAgent(sub, rest.join(' '));
  if (cmd === 'workflow' && sub === 'run') return runWorkflow(rest[0], rest.slice(1).join(' ') || '找一下该区域的铜矿靶区');
  if (cmd === 'agents') {
    const list = [...fs.readdirSync(P.agents).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(P.agents, f))), ...fs.readdirSync(P.workflows).map(f => readJSON(path.join(P.workflows, f)))];
    console.log('智能体商店'); list.filter(a => a.visibility === 'store').forEach(a => console.log(`  ${a.name.padEnd(20)} 创建人: ${a.owner}`));
    console.log('我的智能体'); list.filter(a => a.visibility !== 'store').forEach(a => console.log(`  ${a.name.padEnd(20)} [${a.type}]  ${a.status === 'published' ? '已发布' : '草稿'} · ${a.visibility === 'team' ? '团队可见' : '仅自己可用'}`)); return;
  }
  if (cmd === 'publish') { const f = path.join(P.agents, `${sub}.json`); const a = readJSON(f, null); if (!a) return console.log('未找到'); a.status = 'published'; a.visibility = flag('--team') ? 'team' : 'private'; writeJSON(f, a); console.log(`已发布 ${a.name}:${a.visibility === 'team' ? '团队可见' : '仅自己可见'}`); return; }
  console.log('命令: mcp list|add|key|connect|debug · skill list|import · create "描述" · chat <id> "问题" · workflow run <id> · agents · publish <id> [--team]');
}
main().catch(e => { console.error('运行失败:', e.message); process.exit(1); });
