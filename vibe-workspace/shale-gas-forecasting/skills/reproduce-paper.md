# Skill: reproduce-paper
何时用:任务要求"复现论文 / 用数据跑一遍论文方法"。
步骤:
1. 先读 Paper/ 下的论文摘要,提取:特征、目标变量、模型、论文报告的指标。
2. 再看 Data/ 下数据的列名——论文用的名字和数据集列名经常不一致,要做映射。
3. 把计划写成 research_space/outline.json(步骤、特征、指标),再写代码。
4. 脚本只用标准库,固定随机种子,结果落 research_space/detailed_results.json,图落 research_space/。
5. 运行失败就读 stderr 定位,改完重跑;不要在同一个错误上重复超过 3 次。
