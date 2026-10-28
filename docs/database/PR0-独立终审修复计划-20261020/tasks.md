<!-- 文件位置：docs/database/PR0-独立终审修复计划-20261020/tasks.md -->

# PR0 三项 P1 修复任务清单

依据：[spec.md](./spec.md)。状态：待批准。完成一项才勾选；未运行项保持未勾选。

## T0 基准与安全（F0）

- [x] T0.1 记录并复核分支/HEAD/merge-base/tracked+untracked 清单；确认 `.tmp-review/`、既有回执、Word 未被修改。
- [x] T0.2 只读确认实库 host/port、`SELECT DATABASE()`、隔离级别、可丢弃性、白名单；不打印凭据。
- [ ] T0.3 把 R01/R02/R03 反例落成测试（先红）：清理所有权、Seed 碰撞、投稿旧快照。
  - 反例用例已落位（C01–C09、S01–S06、W-RR/W01–W07）并有绿跑证据；修复前的独立“红跑”输出未归档，故不勾选，详见执行回执第六节。

验证：`git status`、`git diff --stat`、只读 SQL 输出留证。

## T1 R02 清理安全（F1）

- [x] T1.1 重写 `backend/test/utils/e2e-scoped-cleanup.ts`：ledger、residue 指纹、单事务预检、精确 ID 删除、错误格式。
- [x] T1.2 `test-organizations.ts`：移除自然键十连删；`seedTestOrganizations` 复用前核验指纹并支持 `ownership`；`seedTestMemberships` 归属核验。
- [x] T1.3 `test-accounts.ts`：移除公开自然键清理；`seedTestAccounts/createTestAccount` 支持 `ownership`。
- [x] T1.4 迁移 04×6 调用点（residue.accounts + owned）。
- [x] T1.5 迁移 09×2：组织/账号指纹；机型改自增并登记；固定资料登记。
- [x] T1.6 迁移 10×2：组织指纹；fixture 清理保持既有事务路径。
- [x] T1.7 迁移 11×5、12×2：组织/账号指纹 + owned。
- [x] T1.8 更新 `e2e-scoped-cleanup.e2e-spec.ts` B 部分并新增 `e2e-scoped-cleanup-ownership.e2e-spec.ts`（C01–C09）；登记 core 且仅一次。

验证：
```bash
cd backend
npm run typecheck
npm run test:unit -- --runInBand
E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:file -- test/utils/e2e-scoped-cleanup.e2e-spec.ts
E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:file -- test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts
```
门槛：C01–C09 无实库部分全绿且冲突场景 DELETE=0；真实部分在 F4 复跑。

## T2 R03 Seed 碰撞（F2）

- [x] T2.1 新增 `backend/scripts/seed-mock.organization-write.ts`（无启动副作用）。
- [x] T2.2 `seed-mock.ts` 组织/成员定义改调用新模块；事务与错误传播保留。
- [x] T2.3 新增 `backend/scripts/seed-mock.organization-write.spec.ts` 覆盖 S01–S06。
- [x] T2.4 `seed-mock.contract.spec.ts` 与 F04 快照契约无回归。

验证：`npm run test:unit -- --runInBand`；S07 实库双跑留到 F4。

## T3 R01 当前读（F3）

- [x] T3.1 QueryService 新增/改造写前锁定读；送审附件专用当前读；普通读保持无锁。
- [x] T3.2 更新草稿/送审 usecase 传事务 manager。
- [x] T3.3 扫描同族写侧读取，仅修影响合并/附件/冻结者。
- [x] T3.4 QueryService 锁契约测试 + W01–W07 确定性交错测试 + W08 分流测试。

验证：`npm run test:unit -- --runInBand`；真实双连接在 F4。

## T4 实库/协议验收（F4）

- [x] T4.1 清理专项 C01–C10：非空库、连续两次、无全局 TRUNCATE、哨兵前后逐字段对比。
- [x] T4.2 投稿并发 W01–W08：真实双连接/屏障，单跑与整组一致。
- [x] T4.3 Seed S01–S07：专用库正常双跑 + 冲突回滚。
- [x] T4.4 Migration：空库全量；旧基线+fixture 增量升级；核验列/索引/FK/CHECK 与旧数据保留。
- [x] T4.5 真实协议：04 用户创建、09 普通资料、10 聚合统计、11 投稿/样例、12 案例更正；production 错误码脱敏。
- [x] T4.6 N03-A/B/C 文件竞争与回滚回归。
- [x] T4.7 默认 core：新 spec 实际登记一次并整组执行。

命令模板（仅在已确认隔离库执行）：
```bash
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:file -- test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:file -- test/11-content-submission/content-submission-integration.e2e-spec.ts
E2E_SKIP_DB_CLEANUP=true E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:core
```

## T5 工程门禁与回执（F5）

- [x] T5.1 后端 typecheck、capability docs、两个 lint 脚本、完整 unit、build。
- [x] T5.2 前端 format:check、lint、test:unit、build。
- [x] T5.3 含 untracked 的无 fix ESLint；`git diff --check`。
- [x] T5.4 新建 `执行回执-20261020.md`：基准、清单、C/S/W 状态、命令/退出码/数量、未验证项、T01–T20 对照、脱敏证据索引。

## T6 交接与远端待办（F6）

- [x] T6.1 仅列出 B 复核步骤与 T20 待办；不由 A/AI 代签。
- [x] T6.2 列出 fork/base/head、PR 描述、Review、CI 待回读项；无授权不做远端写操作。

## 停止条件

三个 P1 与必要未验证项关闭后重新独立终审；环境/远端缺失时如实保留阻塞，不假报完成。
