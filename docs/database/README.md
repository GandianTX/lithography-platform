# 数据库基线工作区

本目录只保留当前数据库部署材料和工程师注册审核验收记录。初始仓库仅包含本 README；后续加入的 PR0 过程材料、历史设计与验收记录已清理，历史可查 Git 记录。

## 当前正式入口

- 部署入口与范围：[v13-deployment/README.md](./v13-deployment/README.md)
- 部署 SOP：[v13-deployment/deployment-sop.md](./v13-deployment/deployment-sop.md)
- 字段字典：[v13-deployment/schema-dictionary.md](./v13-deployment/schema-dictionary.md)；该文件由后端迁移结构校验测试读取，修改时须同步迁移与测试。
- 数据契约：[v13-deployment/data-contracts.md](./v13-deployment/data-contracts.md)

## 近期验收

- 工程师自助注册与组织审核：[2026-10-29 历史设计与验收记录](./self-registration-engineer-approval-acceptance-20261029.md)

## 事实来源

- Schema 以 Entity 和 Migration 为准；本目录文档只解释决策与操作。
- 禁止通过个人数据库手工改表代替 Migration。
- 阶段性计划、执行回执和终审材料不再提交仓库，避免与当前基线混淆。
