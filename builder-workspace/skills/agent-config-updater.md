---
name: agent-config-updater
description: 根据用户描述生成或更新智能体配置(名称/提示词/工具/推荐问题)
triggers: 创建智能体, 修改智能体, 配置智能体
owner: geogpt
---
步骤:1.获取当前可用 MCP 工具列表 2.从描述提取领域与任务 3.生成 Role/Background/Skills/Workflow 结构的提示词 4.按领域关键词挑选工具 5.写入 YAML 并给出 3 条推荐问题
