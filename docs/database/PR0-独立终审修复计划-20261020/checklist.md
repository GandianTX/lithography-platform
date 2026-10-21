# 验收清单（PR0 独立终审修复 · 20261020）

> 逐项以“实际运行证据”判定；未运行或未取得证据的项不得勾选。
> 证据索引见 [执行回执-20261020.md](./执行回执-20261020.md)。

## 一、R02：测试清理归属与引用闭包

- [x] 清理助手只按自然键定位候选，逐字段指纹校验通过后才纳入删除集合（C02/C03/C09）
- [x] 删除集合只含 lifetime ledger 记录的精确 ID；固定 ID / 自然键不再直接驱动删除（C04/C07）
- [x] 单事务内先完成全部资源预检（含根行 `FOR UPDATE`），预检失败即零删除（C06/C07/C08）
- [x] 引用闭包拒绝外部引用（账号在附件/版本/审核/文档、机型在明细/文档/请求等）（C05）
- [x] 双门禁（`E2E_ALLOW_PHYSICAL_CLEANUP=1` + `SELECT DATABASE()` 白名单）先于任何数据接触（C01）
- [x] `owned` 为空且无 residue 时为纯 no-op（不开启事务、不执行 DELETE）
- [x] 04/09/10/11/12 组调用点全部迁移到统一 helper；01/03/05/06/08/99 历史规格仍保留旧整表函数 `cleanupTestAccounts`（已加显式警告注释，属本计划范围外，登记为 B 交接观察项）
- [x] `e2e-scoped-cleanup-ownership.e2e-spec.ts` 覆盖 C01–C09，且在 `test/jest-e2e.js` 的 core 列表中仅登记一次
- [x] 真实库 C 系列连续两次执行通过（非空库、`E2E_SKIP_DB_CLEANUP=true`，无全局 TRUNCATE）

## 二、R03：Seed 组织/成员主键碰撞

- [x] 组织写入先双键（固定 ID + `organization_code`）预检，冲突即抛错，不覆盖异主行
- [x] `CLIENT_DEFAULT` 按编码解析 Migration 基线真实 ID，不改其 id/name/kind/status
- [x] 成员写入先按固定 ID 与 `(organization_id, account_id)` 双键预检，冲突不更新 FK/角色
- [x] 新模块无启动副作用（不 dotenv、不建 DataSource、导入不执行逻辑）
- [x] S01–S06 单测通过；既有 contract spec 无回归（2 suites / 14 tests）
- [x] 实库非空双跑成功；异主哨兵注入后 Seed 失败关闭且哨兵与成员逐字段不变；恢复后重跑成功

## 三、R01：投稿锁后当前读

- [x] `readMaterialDetailForWrite` / `readFaultCaseDetailForWrite` 必须经事务 manager 并加 `pessimistic_write`
- [x] 送审附件冻结事实使用事务内当前读（CURRENT 行加锁）
- [x] 普通详情/列表/下载读取无新增锁
- [x] 锁顺序为投稿主表 → 明细/附件，锁持有到提交或回滚
- [x] 锁契约单测（含 W08 分流）通过（unit 108 suites / 1318 tests）
- [x] W01–W07 真实双连接确定性交错用例通过（19 tests；隔离级别实测 REPEATABLE-READ）

## 四、工程门禁

- [x] 后端 `npm run typecheck` 通过
- [x] 后端 `npm run lint` 通过（0 error，仅既有 complexity warning）
- [x] 后端 `npm run test:unit` 通过（108 suites / 1318 tests）
- [x] 后端 `npm run test:e2e:core` 通过（第一轮含全库清理；40 suites / 0 failed）
- [x] 后端 `npm run test:e2e:core` 再次通过（`E2E_SKIP_DB_CLEANUP=true`，无全库 TRUNCATE；40 suites / 0 failed）
- [x] 空库迁移演练通过（24 条）
- [x] 旧库升级演练通过（14 基线 + 10 新增，可重跑）
- [x] 前端 `format:check` / `lint` / `test:unit` / `build` 通过

## 五、边界与交付

- [x] 未新增表、未加乐观版本列、未改已接受 Migration、未改全局隔离级别（本轮仅测试/脚本与 QueryService 读取路径）
- [x] 未在 `src/` 注入测试钩子（交错屏障只在测试侧委托包装；`src/` 内无 `E2E_`/`lockAttempt`/`parkNext` 引用）
- [x] 未 commit / rebase / push / 开 PR；HEAD 仍为 `cc4c87e`，远端操作留待 B 复核授权
- [x] 新增执行回执，历史回执未被覆写
- [x] B 交接待办（远端授权项）已列出，未将未执行项标记为完成
