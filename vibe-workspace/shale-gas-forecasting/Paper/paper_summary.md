# Hybrid data-driven framework for shale gas production forecasting (2023)

## 方法
以水平段长度(lateral length)、压裂砂量(prop_mass)、压裂段数(stages)三个特征预测首年产量,
比较 RF / GBDT / XGBoost 三种集成树模型,用 SHAP 解释特征贡献。

## 论文报告的结果
- 最佳模型 GBDT:R² = 0.87
- 特征重要性排序:prop_mass > lateral length > stages
