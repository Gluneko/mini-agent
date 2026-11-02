# agent-builder 讲解:怎么在面试里讲"智能体搭建平台 + MCP(Agent 基建)"

> 代码:`mini-agent/agent-builder.js`(~330 行)+ `mini-agent/mcp-geo-tools.js`(~50 行,一个真实的 MCP Server)。零依赖,Node ≥ 18,全部命令无需 key。
> 定位:前四个 Agent 是"跑 Agent 的",这个是"**造 Agent 的**"——基建层。

## 一、归属口径

> "GeoGPT 的智能体搭建平台(Agent Builder)由四个模块组成:MCP 工具、Skills、智能体、工作流。**平台的前端与服务层是我负责的**——MCP 工具商店与自定义接入、子工具调试面板、智能体配置与调试预览、工作流编排画布(React Flow)。为了吃透底层,我自己实现了一版最小内核:**一个符合协议的 MCP 客户端和服务端、Skills 的标准结构与导入、自然语言生成智能体配置的链路、以及一个节点图工作流引擎**。"

## 二、一句话定位

> "它是给科学家的 Dify/GPTs:用一句话生成智能体配置,把知识库、Skills、MCP 工具组合进去,调试后发布;复杂任务用工作流拖拽编排。底层四件事:**工具怎么接(MCP)、能力怎么复用(Skills)、智能体怎么装配(Config)、多步怎么编排(Workflow)**。"

## 三、四个模块与代码对应

```
MCP 工具 ──── McpStdioClient:spawn 进程 → initialize 握手 → notifications/initialized → tools/list → tools/call
              请求 id 配对 + 超时 + 迟到响应丢弃;商店/我的 MCP;一键部署(stdio 启动命令)/ 自部署(http endpoint);API Key 门禁;子工具调试
Skills ────── skills/*.md:frontmatter(name/description/triggers)+ 正文;按触发词挑选;importSkill 把任意目录转成标准结构
智能体 ────── createAgent:加载 agent-config-updater skill → 拉 MCP 工具目录 → 生成配置(名称/描述/Role-Background-Skills-Workflow 提示词/推荐问题/挂载)→ YAML → 预览
              chatAgent:system = 提示词 + 已挂载 skill;tools = 已连接 MCP 服务器的子工具(带服务器前缀防冲突)→ ReAct 循环
工作流 ────── runWorkflow:节点图 + 变量上下文;assign / code / condition(IF-ELSE)/ http(失败重试 N 次)/ agent(FunctionCalling + 工具箱)/ end
```

演示轨迹(8 条命令,4 分钟):`mcp list` → `mcp connect gis-tools`(真握手)→ `mcp debug`(合法 / 缺参数 / 未配 Key)→ `skill list` → `create "帮我创建一个石油矿井进场选址的智能体"` → `chat site-selection "…"` → `workflow run mineral-assistant` → `publish` + `agents`。

## 四、五个设计决策

### 1. MCP 为什么要实现真协议,不 mock?
面试官问"MCP 是什么"时,能说出**握手三步**(initialize 交换 protocolVersion 与 capabilities → 客户端发 initialized 通知 → tools/list)、**JSON-RPC 的 id 配对与超时**、**工具错误用 result.isError 而不是 JSON-RPC error**(协议区分"传输/方法错误"和"工具执行失败")——这些细节只有写过才说得出。而且 `mcp-geo-tools.js` 可以被 Claude Code / Cursor 直接挂载,互操作性是 MCP 的全部意义。

### 2. 工具名为什么加服务器前缀(`gis-tools__buffer_analysis`)?
多个 MCP 服务器可能暴露同名工具;模型看到的工具目录必须全局唯一,调用时再拆回 server + tool 路由。生产里前缀还承担权限边界(哪个智能体能用哪台服务器)。

### 3. Skills 为什么是"按触发词挑选 + 渐进式披露"?
`agent-config-updater` 只在"创建/修改/配置智能体"时进上下文;`geo-visualizer` 只在 GIS 相关任务时挂到智能体上。system prompt 永远只装当前任务需要的说明书。导入转换(skill-converter)把任意 GitHub 仓库/目录规范成同一结构——**生态靠标准结构,不靠人工改写**。

### 4. 自然语言创建智能体,模型和代码怎么分工?
模型:从描述提取领域、生成提示词与推荐问题(理解与表达);代码:拉工具目录、按关键词挑选挂载、写 YAML、校验必填(边界与结构)。产品里"生成过程中系统可能向用户提出补充问题"就是模型判断配置缺失时的澄清——和我路由里的中置信澄清同一机制。

### 5. 工作流引擎为什么是"节点 + 变量上下文 + 显式分支",不是让 Agent 自由发挥?
科研流程要**可复用、可审计、可重跑**:节点顺序固定、变量可见、HTTP 节点自带失败重试(截图里"失败时重试 3 次")、条件分支显式(IF/ELSE)。Agent 只放在需要理解和表达的节点(找矿工具智能体对话),其余用确定性节点——**确定性的交给代码,不确定的交给模型**,和四件套一脉相承。

## 五、认领边界

**我负责/参与设计的**:平台前端与服务层(商店/我的 MCP/添加与调试面板/配置页/调试预览/工作流画布)、工具目录到模型工具 schema 的映射与前缀路由、Skills 的结构约定与按需加载、自然语言生成配置的链路设计。
**团队/服务**:MCP 一键部署的容器化托管、智能体运行时的模型服务、审核与分享链路、Web/Mobile App 生成的沙箱。
**我自己写的**:这份最小内核(MCP 客户端 + 服务端、Skills、配置生成、工作流引擎)。

产品可对上的事实(手册 4.x + 截图):四种自然语言创建模式 + 两种低代码模式;MCP 商店/我的 MCP/一键部署 STDIO 启动命令与超时/自部署 StreamableHttp·SSE/配置 API Key/子工具调试;技能商店分类与详情(概述/文件结构/CLI 集成)、skill-converter 从 GitHub 导入;智能体商店/我的智能体类型标签 Config·Workflow·Chat·Web·H5;工作流画布节点(代码执行、条件、变量赋值、HTTP 重试、Agent 节点策略 FunctionCalling + 工具箱)。

## 六、面试 Q&A

**Q:MCP 和 function calling 什么关系?**
> function calling 是模型厂商的"调用格式"(模型怎么表达要调工具);MCP 是"工具怎么被发现和连接"的基础设施(host/client/server,tools/resources/prompts,stdio 或 HTTP)。我的实现里 MCP 的 tools/list 结果被映射成 function calling 的工具 schema——两层各干各的。

**Q:一键部署 MCP 和自部署有什么区别?**
> 一键部署:用户只给 stdio 启动命令,平台在容器里拉起进程、管生命周期和超时;自部署:用户已有 MCP Server,给 endpoint(StreamableHttp 或 SSE),平台只做连接与鉴权。前者降低门槛,后者适合有基础设施的团队。

**Q:MCP 工具调用失败怎么处理?**
> 三类:传输/方法错误(JSON-RPC error,如方法不存在)、工具执行错误(result.isError,如缺参数)、超时(客户端按 timeout 拒绝并清理 pending)。前两类原样塞回模型让它决定重试或换路,超时是引擎层的硬边界。子工具调试面板的价值就是让用户在挂到智能体之前把这三类都试一遍。

**Q:Skills 和提示词的区别?**
> 提示词是这个智能体的人设与任务;Skill 是可复用的能力说明书,可以被多个智能体、多个创建模式(网页/移动/智能体)共享,有自己的生命周期(草稿/发布/商店)。"把规范 Skill 化"本质是把知识从提示词里拆出来变成可管理的单元。

**Q:工作流里 Agent 节点和普通节点怎么协作?**
> 变量上下文是总线:确定性节点算出 token、语言、时间戳放进 vars,Agent 节点通过模板 `{{question}}` 读输入、把回答写回 vars.answer;Agent 节点自带工具箱(挂哪些 MCP 服务器)和策略(FunctionCalling / ReAct)。

**Q:这套东西怎么评估?**
> 平台侧:创建成功率、首次调试通过率、工具连接成功率;智能体侧:任务成功率、工具调用准确率、平均步数;工作流侧:节点失败率与重试命中率。子工具调试面板和调试预览就是把评估前置到发布之前。

## 七、现场演示脚本(4 分钟)

```bash
cd ~/Downloads/mini-agent
node agent-builder.js mcp connect gis-tools            # ① 真握手:protocol / serverInfo / 5 个子工具
node agent-builder.js mcp debug gis-tools buffer_analysis '{"layer":"faults"}'   # ② 缺参数 → isError(协议级区分)
node agent-builder.js create "帮我创建一个石油矿井进场选址的智能体" --mock       # ③ 一句话 → 配置 + 预览(对照官网截图)
node agent-builder.js chat site-selection "分析断层线 500 米缓冲区内的选址适宜性" --mock   # ④ 挂载 MCP 工具 ReAct
node agent-builder.js workflow run mineral-assistant --mock                        # ⑤ 对照 React Flow 截图逐节点讲
```
边演示边说:"注意 MCP 是真协议不是假装"→"注意工具错误和方法错误是两条通道"→"注意工作流里只有一个节点是模型,其余全是确定性节点"。

## 八、五件套总览(更新版)

| 实现 | 角色 | 核心机制 |
|---|---|---|
| mini-agent | 最小引擎 | ReAct + 步数熔断 + 重复检测 |
| map-agent | 副作用型 Agent | plan-first + 确认面板 + 事务回滚 |
| research-agent | 长程型 Agent | 有界拆解 + 预算 + 检查点续跑 |
| vibe-agent | 执行型 Agent | 工作区即状态 + 执行反馈 + Skills |
| chat-router | 调度中枢 | 显式 > 粘性 > 隐式 + 前置检查 + 结构化块 |
| **agent-builder** | **基建:造 Agent 的平台** | **MCP 真协议 + Skills 标准结构 + 配置生成 + 工作流引擎** |

一句话收尾:**上面五个是"跑 Agent",这一个是"让别人也能造 Agent"——平台化就是把我在前五个里手写的东西变成可配置、可复用、可分发的单元。**
