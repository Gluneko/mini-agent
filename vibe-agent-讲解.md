# vibe-agent 讲解:怎么在面试里讲"Vibe Research(科研 Coding Agent harness)"

> 代码:`mini-agent/vibe-agent.js`(单文件 ~230 行,零依赖,需本机 python3)。mock 模式真跑 Python、真报错、真修复、真产出文件。

## 一、归属口径(先说这个)

> "Vibe Research 是 zero2x Lab 里的科研复现工作台。**我参与了它的早期架构设计,核心思路是把 coding agent 的 harness 用到科研复现上**——工作区即状态、工具集少而正交、执行反馈驱动循环、Skills 按需加载。**我离开后团队把它上线了;我自己实现了一版最小内核来验证这套 harness 设计**,可以现场跑。"

这句话三个支点都是真的:早期架构参与、离职后上线(不抢功)、自己写过内核(有代码)。

## 二、一句话定位

> "它不是聊天式研究,是**给科学家的 Claude Code**:用户丢进数据和论文,Agent 在项目工作区里写脚本、跑、读报错、改、再跑,产出结果文件、图和报告——所有产物都是文件,可复现、可导出。"

## 三、harness 五件套(对应代码五个区块)

```
工作区(Data / Paper / 科研空间 / skills)   ← 文件系统就是记忆与产出
      │
工具集:read_file · write_file · run_python · list_files · load_skill   ← 少而正交,每个带护栏
      │
主循环:模型 → 工具调用 → 结果(含报错)塞回 → 模型 …            ← 执行反馈驱动
      │
护栏:步数上限 16 · 连续失败预算 3 · 单次执行超时 20s · 路径越界拦截 · 输出截断
      │
Skills:skills/*.md 能力说明书,任务需要时 load_skill 注入上下文   ← 渐进式披露
```

演示轨迹(mock,13 步):load_skill(reproduce-paper)→ 读论文摘要 → 读数据列名 → 写 outline.json → 写脚本(沿用论文列名 prop_mass)→ **运行报错 KeyError** → 读 stderr 改成数据集列名 proppant_tons → 重跑成功(R² 与论文 0.87 对比)→ load_skill(compare-results)→ 写对比报告 → load_skill(write-report)→ 写 HTML 报告 → 完成。

## 四、五个设计决策

### 1. 为什么"工作区即状态",不把一切放上下文里?
上下文是易失的、有上限的;文件是持久的、可导出的、人能直接看的。计划写成 `outline.json`,结果落 `detailed_results.json`,图落 svg——**Agent 的记忆和产出统一成文件**,断了能续、导出即交付、人可以中途改文件再让它继续。这是 Agent 从"聊天玩具"变"生产工具"的分水岭。

### 2. 为什么报错不算失败?
coding agent 的核心能力就是**把报错当信息**:stderr 塞回上下文,模型读到 `KeyError: 'prop_mass'`,对照第 2 步看过的列名,改成 `proppant_tons` 重跑。演示里这一步是真的(不是脚本假装)。但要有**错误预算**:连续 3 次运行失败就停下交给人——防止在同一个错误上无限打转烧算力。

### 3. 为什么 Skills 要按需加载,不写进 system prompt?
把"怎么复现论文""怎么写对比""怎么写报告"全塞进 system prompt,每次调用都背着几千字,而且互相干扰。**渐进式披露**:system prompt 只说"有哪些 skill、什么时候加载",任务真需要时 `load_skill` 把那一份说明书注入。省上下文、准确率高、新增能力只加一个 md 文件——和 Claude Code 的 Skills / CLAUDE.md 是同一思想。

### 4. 工具集为什么只有五个?
读、写、跑、列、加载 skill——正交且够用。工具越多模型越容易选错;真正的能力差异来自 skill 说明书和执行反馈,不来自工具数量。`run_python` 是唯一有副作用的工具,所以护栏最重:cwd 锁在工作区、路径越界拦截、超时、输出截断、不继承敏感环境变量。

### 5. 可复现性为什么是科研场景的核心指标?
脚本固定随机种子、只用标准库、结果落 JSON、对比报告逐项列"复现值 / 论文值 / 差异"并解释差异来源(模型族不同、样本量、噪声)。**结论从结果推导,不预设**——代码里排序是否一致是算出来的,不是写死的。

## 五、认领边界

**我参与设计的**:harness 架构(工作区/工具集/循环/护栏/Skills 五件套)、执行反馈循环的容错策略、Skills 的渐进式加载机制、科研空间的产物追踪与前端呈现。
**团队完成的**:上线后的沙箱算力平台、上传与导出管道、精选案例库、Skills 市场。
**我自己写的**:这个最小内核,用来验证设计。

产品可对上的事实:Data / Paper / Research Space 三区、outline.json → generate_workflow.py → reproduce_paper.py → results/figs → comparison_report → HTML 报告的产物链、Research Skills / Manage Skills 入口、算力资源、导出项目。

## 六、面试 Q&A

**Q:和 Deep Discovery 的区别?**
> Deep Discovery 是"查资料写报告",产出是文本;Vibe Research 是"写代码跑实验",产出是文件和数据。前者靠检索反馈,后者靠执行反馈;前者的状态是检查点,后者的状态是整个工作区。

**Q:模型写的代码跑坏了环境怎么办?**
> 沙箱:cwd 锁在项目目录、路径越界直接拦、超时杀进程、输出截断、环境变量白名单;生产里是容器级隔离 + 算力配额。工具层的护栏不信任模型,和我其他 Agent 的原则一致。

**Q:和 Claude Code 是什么关系?**
> 同一个 harness 形状:Read/Write/Bash 对应 read/write/run_python,CLAUDE.md 和 Skills 对应 skills/*.md,权限确认对应护栏。我每天用 Claude Code(用户视角),这个是把同一套东西造给科学家(设计者视角)——两头都能讲。

**Q:怎么评估它做得好不好?**
> 复现成功率(能否产出与论文可比的指标)、平均修复轮次(报错到跑通要几轮)、产物完整率(结果/图/报告是否齐)、单任务算力成本。修复轮次暴涨就是 skill 说明书写得不够清楚的信号。

## 七、现场演示脚本(3 分钟)

```bash
cd ~/Downloads/mini-agent
node vibe-agent.js --mock          # 带节奏跑一遍,边看边说三句:
#  ① "注意它先 load_skill 再动手——说明书按需进上下文"
#  ② "注意第 6 步真报错、第 7 步读 stderr 改列名、第 8 步真跑通——执行反馈循环"
#  ③ "注意科研空间的 ✦ 一个个冒出来——产物是文件,可导出可复现"
open vibe-workspace/shale-gas-forecasting/research_space/report.html   # 打开产出的报告
```

## 八、下一步
1. 接真模型跑一次:`OPENAI_API_KEY=xx node vibe-agent.js "…"`,看模型自己怎么修 KeyError
2. 在 chat-router 里已注册为技能("复现论文 / 跑实验"意图会路由到它),三件套变四件套
3. 阿怪第五篇:"阿怪的工作间"
