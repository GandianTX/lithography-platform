# S6 逐项 RQ 回复草稿（2026-11-10，第 38 轮）

> 口径：只陈述本轮在 `feat/database-v13-deploy` 上实际执行并留证的检查。
> 起点均为库外冻结候选或本轮新建空库，**不宣称任意真实旧库已验证**。
> 证据根目录：`/home/gandiantx/.local/share/lithography-v13-rq-evidence/`（0700，文件 0600；不入库）。
> 迁移终态 44 条；`ALL44=72dc3718fba8fd350beda73477a811d4de96c907eb9c3d117eaaff495ce99eb9`
> （排序后逐文件 `sha256sum` 再取 `sha256`）；前 43 条未改。
> 实库实例：`127.0.0.1:3306`，`@@server_uuid=909f9587-9fce-11f1-a353-00e0709ef3a9`，MySQL 8.0.46。

## RQ1 目标确认与 42→43 原反例路径

- 反例：runner 以错误 UUID 仍进入迁移/写入；配置夹带实际 UUID 绕过入口。
- 修复：入口显式白名单与 UUID 独立确认；配置保留变量在执行前拒绝。
- 实库证据（`02-rq1/`）：
  - `lithography_rq1_42` 由库外冻结 42 条候选正向构建（仅前 42 条，不 DROP、不清库、不关外键）。
  - 错误 UUID：runner 在 beforeAll 拒绝，`实际 server_uuid=... 与 E2E_EXPECTED_SERVER_UUID=000... 不一致`，退出码 1。
  - 错误 UUID + 配置夹带实际 UUID：`拒绝执行：配置文件包含保留变量 V13_SPEC_SERVER_UUID`，未连库。
  - 拒绝前后快照（`42-before.json` / `42-after-reject.json`）逐字节一致：42 条历史、列/索引/CHECK、全部表校验和不变。
  - 合法 42→43：冻结 43 条候选 runner，13 passed / 0 failed，退出码 0。
  - 43→44 与最终 44 态：当前仓库 `database:deploy --mode upgrade` 执行第 44 条，`migration:verify` 通过，历史 44。
- 限制：冻结 42/43 候选仅用于本轮反例与合法路径，不代表任意真实旧库。

## RQ2 结构漂移拒绝

- 反例：CHECK 被 `NOT ENFORCED` 或关键索引缺失时仍通过。
- 修复：终态 verify 与 init/upgrade 均校验强制执行状态与索引定义。
- 实库证据（`04-rq2/`，`lithography_rq2_constraint`，44 条终态）：
  - 单项禁用 `organization.chk_organization_service_provider`：
    - verify：`关键 CHECK 未强制执行: organization.chk_organization_service_provider enforced=NO`，退出码 1；
    - init 与 upgrade 均拒绝，原因同一条 CHECK；
    - 恢复 `ENFORCED` 后 verify 通过，快照与原始一致。
  - 单项移除 `uk_login_name`：
    - verify：`关键索引缺失` 与 `关键索引定义缺失`，退出码 1；
    - init 与 upgrade 均拒绝；
    - 按原定义恢复唯一索引后 verify 通过，快照与原始一致。
  - 两类漂移分开制造，未同时存在。

## RQ3 账号邮箱冲突与整批回滚

- 反例：既有管理员/工程师映射到他人已占用邮箱仍写入；合法新增与冲突同批时留下半批数据。
- 修复：既有账号按登录名核对邮箱与归属，冲突失败关闭；初始化数据在同一事务内整批提交/回滚。
- 实库证据（`05-rq3/`，`lithography_rq3_account_dev`，一条 init 完成 44 条迁移 + 1 公司 + 3×一级 + 3×二级 + 2 客户 + 2 工程师）：
  - 既有管理员映射到既有工程师邮箱：拒绝，错误同时点名管理员与占用账号；账号事实快照与基線完全一致。
  - 既有工程师映射到既有管理员邮箱：拒绝，错误点名工程师与占用账号；快照一致。
  - 合法新增在前、冲突在后（管理员/工程师各一次）：整批回滚，新增账号 0 行残留；快照一致。
  - 原合法映射复跑：全部 `UNCHANGED`，快照一致（邮箱、密码哈希、角色/等级、资料、公司、成员资格）。
  - 去掉 dev 选项复跑：不新增、不删除 10 个账号；快照一致。
- 说明：邮箱、密码哈希、角色/等级、资料与归属通过库外 `account-facts.js` 快照比对；密码不落日志。

## RQ4 工程师公司资格

- 反例：`kind=PEER` 被当成维修资格；`is_service_provider` 被误当管理名单。
- 修复：工程师必须绑定 `ACTIVE + is_managed_company=1`；`is_service_provider` 独立判定。
- 实库证据（`06-rq4/`，`lithography_rq4_org_dev`，44 条终态）：
  - 新建工程师映射到 `ACTIVE + kind=PEER + is_managed_company=0`：拒绝；账号快照一致。
  - 既有工程师复跑改为未入名单公司：拒绝；账号快照一致。
  - 合法新增在前、非法工程师在后：整批回滚，新账号 0 行残留；快照一致。
  - `ACTIVE + is_managed_company=1 + is_service_provider=0` 的公司允许工程师创建；verify 通过。

## RQ5 升级写入前未知表拒绝

- 反例：未知表存在时仍执行 pending/回填；仅用 verify 而未走正式 upgrade。
- 修复：`database:deploy --mode upgrade` 在 pending/回填前检查未登记业务表并失败关闭。
- 实库证据（`07-rq5/`）：
  - `lithography_rq5_43`（冻结 43 条正向构建）与 `lithography_rq5_42`（冻结 42 条正向构建）分别创建带哨兵未知表。
  - 正式 upgrade：均在任何 pending 前拒绝，执行迁移 0 条；历史、原表、原行、哨兵与快照完全不变。
  - 精确移除本轮未知表后：43→44 与 42→44 均合法升级并终态校验通过；`previous_version` 合法值 0/1 原值保留。
  - 再次 upgrade：0 条迁移，全部不变。

## RQ6 精确清理与事务观测

- 反例：默认读取需 `PROCESS` 的 `INNODB_TRX`；CREATE/UPDATE 后断言失败留下残留或覆盖异主修改。
- 修复：默认只读 `performance_schema`；观测能力不足在造数前失败关闭；条件恢复使用原值/写入值 CAS。
- 实库证据（`08-rq6/`，`lithography_rq6_cleanup`，44 条终态）：
  - 正常清理规格：14 passed / 2 skipped（受控故障默认关闭），退出码 0。
  - `E2E_V13_CONTROLLED_FAULT=1`：16 passed / 0 failed，退出码 0；覆盖 CREATE 后真实断言失败精确回收、
    UPDATE 后断言失败按 status + finished_at 写入值条件恢复，主错误/收尾错误/残留诊断保留。
  - 观测前置：`@@performance_schema=1`、`events_transactions_current=YES`；未读取 `INNODB_TRX`。
  - 正常交付组（`09-baseline/`）：3 suites / 68 passed / 2 skipped；基线 10 个账号事实前后一致，夹具零残留。
- 限制：授权账号在本轮前已持有 `PROCESS`（非本轮授予，未授予/未回收/未改系统表）。
  因此未在该账号上演示“无 `PROCESS`”的真实条件；无权限/未启用/不可观测分支由离线能力用例覆盖，
  不把空结果当成“无活动事务”。

## RQ44 previous_version 收紧

- 反例：第 44 条直接 ALTER，NULL 旧行被默认值或隐式转换吞掉；或猜测回填、删除历史行。
- 修复：第 44 条在**任何 ALTER 前**校验 `IS NULL` 与 `>= revision_no`；违规零 ALTER、失败关闭，
  只输出脱敏计数与最多 20 个定位 ID；无违规才收紧为 `int unsigned NOT NULL` 且无默认值；`down` 只回退可空性。
- 实库证据（`03-rq44/`、`07-rq5/`、`09-baseline/`）：
  - 新空库一条 init：`previous_version` 为 `int unsigned / NO / NULL 默认 / extra 空`，历史 44。
  - `lithography_rq5_43` 合法 43 态（previous_version=0、1）经正式 upgrade 收紧，原值保留。
  - `lithography_rq44_previous` 43 态插入合法首版与 NULL 历史行：正式 upgrade 在第 44 条任何 ALTER 前拒绝，
    历史仍 43、列仍可空、两行均保留；未回填、未删除、未伪造通过。
  - 该 NULL 拒绝库保留现场，不要求升级成功。

## 未关闭与不适用项

- `npm run check:entity-scope` 退出码 1（旧 PR3 entity-scope 按既有裁决记不适用；未改政策骗绿）。
- 未验证：任意真实旧库、真实登录/前端/Redis/Worker/完整业务 core（不在本期范围）。
- 未 push、未回复 PR、未合并。
