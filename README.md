# mini-agent — 六个最小 Agent 内核(零依赖,单文件,可跑)

> Six minimal, zero-dependency Agent kernels in plain Node.js. Each one isolates a single idea behind production AI agents: the ReAct loop and its circuit breakers, plan-confirm-execute with transactional tools, long-horizon research with checkpoints, intent routing with confidence thresholds, a coding-agent harness driven by execution feedback, and an agent builder with a real MCP client and server. Every kernel runs in `--mock` mode without an API key; add `OPENAI_API_KEY` (any OpenAI-compatible endpoint) to let a real model drive the same harness.

这是我在做 GeoGPT 智能体平台与 Agent 链路时,为吃透底层自己从零实现的六个最小内核。生产系统是它们的工程化放大:步数熔断变成可配置策略、工具注册表变成 MCP 工具商店、执行轨迹变成前端可视化。每个文件 200 到 330 行,只用 Node 标准库;`--mock` 模式不需要任何 key,接真模型只需环境变量。

## 六个内核

| 文件 | 内核 | 回答的问题 | 一句话 |
|---|---|---|---|
| `agent.js` | ReAct 执行引擎 | Agent 的主循环长什么样,怎么不死循环 | 工具注册表 → 模型选工具 → 执行 → 结果塞回;三层刹车:步数上限、重复调用检测、超时;上下文裁剪保 system 与首条任务 |
| `map-agent.js` | 地质图生成 Agent(工具调用型) | 有副作用的工具怎么让人放心 | 规划整段 → 确认面板(增 / 删 / 改参数 / 调序)→ schema + 业务双层校验 → 在状态副本上事务执行,失败整体回滚 |
| `research-agent.js` | Deep Discovery(长程型) | 长任务怎么不跑偏、怎么离开再续 | 有界拆解 ≤4 步;每步多源检索 → 阈值 0.35 过滤 → 去重封顶 20 → 精读 ≤3 篇;每步落检查点 `--resume` 续跑;Deeper 先确认方案 |
| `chat-router.js` | 对话入口与意图路由 | 什么时候该交给模型判断 | 显式选择 1.0 > 粘性承接 0.75 > 分类打分(≥0.7 直走 / 0.5–0.7 澄清 / <0.5 普通对话);前置条件检查;输出按 type 分发的结构化块 |
| `vibe-agent.js` | 科研 Coding Agent harness | harness 到底是什么 | 工作区即状态;五个正交工具 read / write / run_python / list / load_skill;执行反馈驱动循环(报错是输入);护栏:步数 16、连续失败预算 3、超时 20s、路径越界拦截、输出截断;Skills 按需加载 |
| `agent-builder.js` + `mcp-geo-tools.js` | 智能体搭建平台 + 真 MCP | 工具怎么接、能力怎么复用、多步怎么编排 | `McpStdioClient`:spawn → initialize 握手 → notifications/initialized → tools/list → tools/call,请求 id 配对、超时、迟到响应丢弃;`mcp-geo-tools.js` 是一个符合协议的 MCP Server,可被 Claude Code 等宿主挂载;Skills 标准结构;自然语言生成智能体配置;节点图工作流引擎 |

## 跑起来(全部不需要 key)

```bash
npm run react        # ReAct:算式 + 时间,看执行轨迹与熔断
npm run map          # 地质图:规划 → 确认 → 校验 → 事务执行 → 快照
npm run research     # Deep Discovery:拆解 → 检索过滤 → 精读 → 报告
npm run research:resume   # 跑 2 步"离开",再从检查点续跑
npm run router       # 对话入口:#技能 / 承接 / 分类打分 / 澄清
npm run vibe         # Coding harness:真跑 python、真报错、真修复、产出文件(需本机 python3)
npm run mcp          # 与真实 MCP Server 握手、列工具
npm run workflow     # 节点图工作流,只有 agent 节点是模型
```

接真模型:

```bash
OPENAI_API_KEY=sk-xx OPENAI_BASE_URL=https://api.xx.com/v1 MODEL=gpt-4o-mini node vibe-agent.js "复现论文里的产量预测并对比"
```

## 贯穿六个内核的四句话

- **任务性质决定循环策略**:能试错的用 ReAct 逐步,不能试错的先出完整计划再执行。
- **风险决定人在哪一步介入**:副作用发生前人一定看到完整计划;低风险查询自动,高风险写操作确认。
- **模型负责理解和表达,代码负责边界和成本**:拆解、笔记、报告交给模型;检索、过滤、何时停、步数、预算全是代码。
- **工作区即状态**:上下文易失有上限,文件持久可导出人可读;断了能续,人能中途改文件再让它继续。

## 目录

```
agent.js                ReAct 引擎
map-agent.js            地质图 Agent
research-agent.js       Deep Discovery
chat-router.js          对话入口与意图路由
vibe-agent.js           Coding harness(vibe-workspace/ 是一个示例工作区:Data / Paper / skills / research_space)
agent-builder.js        智能体搭建平台(builder-workspace/ 是 MCP 配置 / agents / skills / workflows)
mcp-geo-tools.js        真实 MCP Server(stdio,JSON-RPC)
*-讲解.md               每个内核的设计说明与取舍
```

## 与 GeoGPT 的关系

这些内核对应 GeoGPT 里我负责的部分:智能体搭建平台(提示词 / 知识库 / MCP 工具商店 / 工作流)的前端与服务层、工具调用协议(结构化事件、二次确认、中间态可视化)、意图路由、Deep Discovery 的检查点与活动事件流。模型侧的训练与微调是算法团队;应用侧链路是工程团队的工作,我深度参与。

姊妹项目:[stream-chat-demo](https://github.com/Gluneko/stream-chat-demo)(流式协议)、[collab-notes](https://github.com/Gluneko/collab-notes)(协同编辑)、[mini-sheet](https://github.com/Gluneko/mini-sheet)(表格引擎)。

MIT
