# 组织与维修数据增量验收记录（2026-10-29）

## 版本与范围

- 分支：`feat/maintenance-data-increment`；开发起点：`795eb577f45e5ece4694dec5efa322aba1ef9a3a`。
- 本记录整理自提交前各轮执行记录。实库结果产生于该起点之上的未提交工作区，不能表述为起点提交已经包含或验证了本次实现，也不代表 CI、薛一审或负责人二审通过。
- 交付为数据层增量及既有账号/工单兼容调整：5 条追加迁移、10 张新表，终态 29 条迁移、33 张业务表；`migrations` 等元数据表另计。
- [设计与实现说明](./organization-maintenance-data-increment-design.md)、[部署与升级 SOP](./部署与增量升级SOP-20261029.md)提供正式交接入口。临时阶段计划和旧基线盘点不属于本次提交。
- 本文只保留脱敏结果，不包含配置、备份、真实业务数据或原始测试日志。

## 已执行的迁移验证

| 验证               | 已记录结果                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 全新隔离库迁移链   | 29 条迁移、33 张业务表及结构契约核验通过                                                                          |
| PR0 旧库副本       | 真实 24 条历史副本上 `status` 为 5 pending，`run` 仅执行 5 条，`verify` 通过，第二次 `run` 执行 0 条              |
| 旧数据保留         | 21 张未变表逐字段序列化结果逐字节一致，受改造表旧列逐行摘要一致                                                   |
| 约束拒绝路径       | 重复 ACTIVE 成员、同账号第二有效组织、非法角色/离职时间组合及第二 RUNNING 备份被唯一键或 CHECK 拒绝，测试事务回滚 |
| 公共迁移器实库回归 | 31/31，通过半迁移拒绝、部分 DDL 失败现场及结构定义漂移反例                                                        |

上述迁移证据生成后的修正未改变 5 条迁移及结构契约，因此后续轮次沿用迁移结果，定向重验发生变化的运行逻辑。当前没有验证“有表但没有迁移历史”的开发库可以直接纳管升级；该情况不属于上述 24→29 证据。

## 业务、并发与权限

| 套件                                                 | 已记录结果                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `maintenance-report.integration.spec.ts`             | 5/5：冻结、冻结后拒绝编辑、退回重提版本、锁后读取、结果映射与终结守卫             |
| `repair-request.organization.integration.spec.ts`    | 9/9：本组织、无组织、跨组织及客户本人读取口径                                     |
| `maintenance-report.concurrency.integration.spec.ts` | 4/4：同工单建稿竞争、提交与编辑竞争、提交与加附件竞争、跨组织写入拒绝且无部分写入 |
| `local-runtime.concurrency.integration.spec.ts`      | 3/3：同幂等键入队、同目标版本不同幂等键入队、设置不同字段并发补丁                 |

并发套件使用独立 MySQL 连接和真实事务，通过 `performance_schema.data_lock_waits` 观察阻塞后继续竞争，不靠固定延迟或 Mock 调用顺序证明并发。测试过程中发现上传冲突回读未真正加锁，修正为 TypeORM 显式 `lock: { mode: 'pessimistic_write' }` 后重跑通过。

无归属存量工单只保留客户本人及原接单工程师的受限访问；未分配可信组织前不可进入公共待接单池或重新接单。报告与工单的组织一致性由用例锁后校验承担，不能把工单唯一键描述为跨组织复合外键；完整取舍见设计说明 §14。

## KEEP 与残留

- 在同一实例登记合成 KEEP：19 行，覆盖组织、账号、成员、机型、工单、报告内容与版本/附件/审核、上传任务及备份记录；另有 2 个文件哨兵。
- KEEP 就位时对 16 张相关表共 56 行及 2 个文件取确定性排序快照，比较逐字段摘要和文件路径/大小/内容摘要。
- 在两套并发与相关实库写入/清理链路执行前后，表摘要和文件清单完全一致，记录结果为 `KEEP_COMPARE_OK`。
- 测试夹具按登记 ID 清理并回读零残留；单独收尾 KEEP 后，差异恰为登记的 19 行及 2 个文件，记录结果为 `KEEP_RESIDUE_OK`。没有用 Seed 或整表清理覆盖差异。
- KEEP 使用的一次性探针与状态目录已删除。以上为当时运行回执，仓库未提供一键重放该 KEEP 探针的命令；不能把本文当作保留了原始快照或已提供自动 KEEP 执行器。
- 后续补跑的组织集成套件以自身残留断言核验，不冒称其执行时间也包含在此前 KEEP 快照区间内。

## 静态门禁与单测

已记录通过：`typecheck`、`build`、无自动修复的 ESLint（0 error，10 warning）、`prettier --check`、normalize guard、architecture fixtures、`check:entity-scope`、`capability:docs:check`。

修正轮全量后端单测记录为 114 个套件通过、3 个套件跳过，1394 passed、45 skipped、0 failed。随后仅修改上传锁选项及对应测试，并定向运行本地运行与报告目录及上述真实并发套件；该全量数字不是后续新增用例后的重新统计。默认关闭的实库套件在普通单测中跳过，不等于真实链路已执行。

## 可复现入口

命令均在 `backend` 中执行。数据库配置、隔离目标、测试账号及清理许可必须先按 SOP 核实；这些命令不授权访问共享开发库。

```bash
npm run typecheck
npm run test:unit -- --runInBand
npm run lint:usecase-normalize-guard
npm run lint:architecture-fixtures
npm run check:entity-scope
npm run capability:docs:check
npm run build
```

常规实库套件及破坏性迁移回归命令见 SOP。以下为新增并发套件，读取本地未跟踪的 `env/.env.e2e`，仅允许 `lithography_e2e`；账号须具备所需锁等待观测权限。缺少配置或保护前提时应失败，不得绕过门禁：

```bash
MAINTENANCE_REPORT_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
  npx jest src/usecases/maintenance-report/maintenance-report.concurrency.integration.spec.ts --runInBand

LOCAL_RUNTIME_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
  npx jest src/usecases/local-runtime/local-runtime.concurrency.integration.spec.ts --runInBand
```

## 已知交付边界

- AI 只有最小读取契约和测试注入模拟，生产未接入时明确不可用；真实输出、版本与历史回看尚未联调。
- 附件只有记录、格式/限额校验、冻结清单及审核选择，没有真实上传或服务端存储元数据回读。
- 本地运行只有身份、任务、回执与备份记录状态机，没有真实云接收端、调度器、备份文件生成或恢复编排；数据记录通过不等于真实备份恢复通过。
- 自助注册客户没有自动组织归属；没有新增组织分配公开入口，运维初始化须依据可信映射。
- 没有新增业务页面、报告 GraphQL/REST 接口或 PDF 导出，本次没有前端视觉验收证据。

PR 审核重点为组织隔离与旧数据兼容、单有效成员生成列、报告/版本/审核关联、锁序与冲突回读、清理保护及单列外键的实际保证范围。本文不代替审核者独立复核。
