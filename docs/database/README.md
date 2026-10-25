<!-- 文件位置：docs/database/README.md -->

# 数据库基线工作区

本目录用于保存已经确认的 Schema、ER 图、字段说明和数据库决策。

## PR0 当前交接入口

- 接手人先读：[PR0a 技术交接说明（给 B）](./PR0a-技术交接说明-20261025.md)，包含隔离环境、两场景复现、清理风险和待填写签收清单。
- 详细操作：[S7 交接材料与真实调用样例](./PR0-S7交接材料与真实调用样例-20261020.md)，已于 2026-10-25 修正执行参数和当前测试数量。
- 当前结构：[数据采集 Schema 快照](./data-collection-schema.md)。PR0 新增 9 张表、扩展现有参考资料表，保留已有基线，不重新设计一套资料库。
- 历史 S0—S8 和独立审查报告记录各自执行时点；不把历史“通过”或旧工作树状态视为当前 B 已签收、远端已合并或最终 CI 已通过。

Word 供单独发送阅读，仓库 Markdown 为可追踪的交接入口。执行前以同一提交下的当前契约和实现核实，不依赖本地被忽略的 `docs/plan/` 或临时文件。

## 首次基线流程

1. 确认唯一的业务 Schema。
2. 复用底座已有账户和基础设施表，不建立重复用户表。
3. 为新增业务表同时编写 Entity 和基线 Migration。
4. 在全新空库中仅通过 Migration 重建结构。
5. 比较字段、类型、默认值、索引、外键和约束。
6. 通过独立、幂等的 Seed 导入开发 Mock Data。
7. 基线合并后再开始页面并行开发。

## 全量 Mock Data

当前 23 张业务/基础表（原 14 张加 PR0 的 9 张）的开发模拟数据通过独立、幂等的后端 Seed 导入，不写入 Migration。Migration 执行记录表不计入此数。执行前先确认目标为个人开发环境，并在 Seed 使用的环境文件中配置 `MOCK_SEED_PASSWORD`，该密码供三类 Mock 账号登录；`FIELD_ENCRYPTION_KEY` 和 `FIELD_ENCRYPTION_IV` 也必须与 API 使用的值一致：

```bash
cd backend
SEED_DOTENV=env/.env.development npm run seed:mock
```

脚本默认读取 `backend/env/.env.e2e`，其次读取 `backend/env/.env.development`；上面的 Bash/WSL 命令显式选择个人开发配置，避免误用自动测试配置。执行前确认文件存在且指向预期个人数据库。它会检查 Migration 是否已创建当前所需的全部 23 张表，只更新保留的 Mock 主键/业务键，不清空其他数据，并在同一事务内校验账号密码、角色密文、各表数据量及业务外键链路。除设备型号外，Mock 自增主键保留在 `900000-999999` 区间。数据库名必须包含 `test`、`drill`、`dev` 或 `local`；其他非生产库还需显式设置 `SEED_ALLOW_NON_TEST_DB=true`。不能为绕过冲突向共享/生产库导入。

Schema 设计稿是首次基线的审核输入；代码合并后，Entity 表达当前 ORM 映射，Migration 是数据库可执行交付记录。禁止通过个人数据库中的手工改表代替 Migration。
