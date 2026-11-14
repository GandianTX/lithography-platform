# V13 数据库正式交接

本目录是新环境部署和本期数据库复审的仓库入口，不依赖 `backend/plans`、开发者临时脚本或本机数据库。执行计划和完整阶段日志仅保留本地，不作为运行依赖。

## 部署材料

- [正式部署 SOP](deployment-sop.md)：预建空库、一条正式命令、账号初始化、重复执行、明确起点的升级、安全测试入口及失败边界。
- [字段字典](schema-dictionary.md)：设计来源、现有与新增对象、字段和约束；表内阶段状态保留原记录时点，不替代当前源码与正式 verify。
- [数据契约](data-contracts.md)：数据不变量、事务和兼容语义，含批准后的 `previous_version` 非空裁决。

## 无秘密模板

- [部署环境](database-deploy.env.example)
- [生产组织映射](organization-bootstrap.example.json)
- [生产管理员映射](admin-bootstrap.example.json)
- [开发组织映射](dev-organizations.example.json)
- [开发管理员映射](dev-admin.example.json)
- [开发账号映射](dev-accounts.example.json)
- [开发联调样例](dev-data.example.json)
- [历史身份清单合成样例](legacy-repair-identity-manifest.sample.json)

复制模板到仓库外受限位置，再替换占位值。真实密码、密钥、历史身份清单、dump 和原始日志不得提交 Git。

## 当前交付边界

- 44 条迁移，51 张业务表；预建空库后使用 `database:deploy --mode=init`。
- 生产入口（`--environment=production`，默认）一条命令完成迁移、必要系统数据、组织与 3 个一级 + 3 个二级管理员；
  不创建开发账号、模拟公司、业务样例或样例文件。
- 开发入口（`--environment=development` + `--expect-server-uuid` + `--confirm-dev-target`）可在同一条命令中
  追加组织、6 个管理员、开发客户/工程师与计划要求的机型/工单/报告/资料样例；开发数据默认关闭，
  目标库须通过实例 UUID、实际库名、确认库与开发标记四项核对，现有共享库直接拒绝。
- 开发样例稳定键幂等：重跑不重复、不覆盖用户合法编辑；同键异主失败关闭。不生成 AI/同步/备份/导入记录。
  资料必须有不可变 `seed_key`，标题只展示；存储引用由 `seed_key` 派生且正式改名不改写。
  资料本轮只支持带无敏感信息的 `.txt` 原件；原件目录须为以目标库名命名的专属目录并通过重复确认，
  首次认领须排他记录实例 UUID + 精确库名，写入后回读核对字节数与 SHA-256，重跑只核对不覆盖。
- `upgrade` 仅执行 pending，拒绝任何初始化数据；只用于已经确认来源与起点的库。现有合成旧态证据不等于任意真实业务库已验收；无法满足新约束时拒绝，不猜测回填、不删数据制造成功。
- `previous_version` 最终非空、无默认版本；第 44 条预检发现未知历史值即拒绝。
- 接口、前端、真实登录、Worker、Redis、云端执行器与完整业务 core 不因本目录资料而宣称完成。

## 最近补验与保留现场

最近受影响路径的停采拒绝、真实事务/回滚计数、R02 字节精确恢复以及 D3 九项功能验收已有修复方证据；复审回执已按仓库文档清理策略移除。
后续同类收尾补修验证了写入后读取失败仍登记恢复、未登记第三方文件名不会被独立收尾认领删除。
冲突文件/冲突备份行及必要账号、组织父资源进入套件级保留集合；用例收尾、通用清理与 `afterAll` 均不会再次认领删除，Jest 退出后可由独立连接复核冲突行、外部写入值与引用仍在。该保留现场不是零残留交付结果，处置前不得将同库用于 R09 零残留组验收。不得未经授权清理。
事务观测预检与计数同时要求 `global_instrumentation`、`thread_instrumentation`、`events_transactions_current` 三个 consumer 及 transaction instrument 开启；任一上游开关关闭时明确拒绝，不返回零事务。

旧 PR3 `check:entity-scope` 的禁止结构变更限制按既有裁决在本期记为不适用，不表述为命令通过。历史裁决与更早执行日志可从本 PR 历史提交追溯；本地计划不是新环境的前置条件。

## 独立复审

由薛对实际提交及同 SHA 的 CI、部署和专项证据复审；不自行批准或合并。原共享库及 Redis 事故继续单独跟踪，不因本轮交付而宣称已恢复。
