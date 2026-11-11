# S6 逐项 RQ 回复草稿（2026-11-10，第 38 轮）

> 仓库交接副本：保留历轮记录及未推送时点，不将历史结果改为当前独立批准。后续第 47 轮冲突文件按设计保留，不能将该运行宣称零残留；原始日志与执行计划保留本地，不是部署依赖。本副本迁移仅涉及文档路径，未改变运行时代码、迁移或实库状态。

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
  - 本轮补充（`16-not-enforced/`，`lithography_rq5_43`，候选 `ea394fd857744bbcecbf183f81b1f95d398e0d6`）：
    `engineer_response.chk_engineer_response_text` 原定义
    ``(char_length(trim(`response_text`)) > 0)``、基线 `ENFORCED=YES`；
    改为 `NOT ENFORCED`（**不删除**）后正式 verify 退出 1，并报告
    `关键 CHECK 未强制执行: engineer_response.chk_engineer_response_text enforced=NO`；
    可靠 finally 恢复 `ENFORCED` 后 verify 退出 0，状态、结构、数据与 44 条迁移历史均与基线快照逐字节一致。
    **明确：本项是 `NOT ENFORCED` 反例，不以此前删除 CHECK（缺失）的结果替代。**

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
- 实库证据（`07-rq5/`、`12-rq5-44/`）：
  - `lithography_rq5_43`（冻结 43 条正向构建）与 `lithography_rq5_42`（冻结 42 条正向构建）分别创建带哨兵未知表。
  - 正式 upgrade：均在任何 pending 前拒绝，执行迁移 0 条；历史、原表、原行、哨兵与快照完全不变。
  - 精确移除本轮未知表后：43→44 与 42→44 均合法升级并终态校验通过；`previous_version` 合法值 0/1 原值保留。
  - 再次 upgrade：0 条迁移，全部不变。
  - 44 态、pending=0 复验（`lithography_rq5_43`）：迁移历史 44 条，名称、时间戳、顺序与仓库一致；正式 verify 退出码 0，
    业务表 51 张；status 显示 `pending 0 条`。
  - 基线快照：52 张基础表、44 条历史、0 个触发器、0 个本账号活动事务（`44-before.json`，
    sha256 `8c7fe156c07b73229996bc5c8203c311bf979fa9f8be19cf1e2ac51d9e3674bb`）。
  - 创建前确认 `rq5_44_unknown_probe_2c9d` 不存在；随后创建 `id int NOT NULL` / `payload varchar(64) NOT NULL` /
    主键 `id` 的唯一未知表及哨兵行 `(1, 'RQ5-44-SENTINEL-20261110')`，并登记定义、哨兵和引用数（0）。
  - 正式 `database:deploy --mode upgrade` 退出码 1，原因明确为
    `存在预期之外的业务表: rq5_44_unknown_probe_2c9d`；无“已执行 N 条迁移”，无收尾错误。
  - 拒绝前后快照逐字节一致（sha256 `49301f2bbc884ae0054a5d298fd23e07891624ea9cce0b3023e63dc63f219cc1`），
    哨兵仍在、历史仍 44。
  - finally 复核表定义、哨兵与引用关系后，精确 `DROP TABLE`（不使用 `IF EXISTS`）退出码 0，残留 0；
    删除后快照与基线逐字节一致（sha256 `8c7fe156...`）。
  - 恢复后正式 verify 退出码 0；upgrade 退出码 0，`pending 0`、`无变化`；最终 52 张基础表、44 条历史、
    0 个触发器、0 个驻留会话、0 个残留合成对象。

## RQ6 精确清理与事务观测

- 反例：默认读取需 `PROCESS` 的 `INNODB_TRX`；CREATE/UPDATE 后断言失败留下残留或覆盖异主修改。
- 修复：默认只读 `performance_schema`；观测能力不足在造数前失败关闭；条件恢复使用原值/写入值 CAS。
- 本轮补齐：7 条真实遗漏的既有 CHECK 纳入契约并加回归；观测能力在首次写入前一次预检
  threads/consumer/instrument/目标连接可见性；R01/R02/R03 成功后立即登记收尾事实并新增默认关闭的受控中断。
- 实库证据（`08-rq6/`，`lithography_rq6_cleanup`，44 条终态）：
  - 正常清理规格：14 passed / 2 skipped（受控故障默认关闭），退出码 0。
  - `E2E_V13_CONTROLLED_FAULT=1`：16 passed / 0 failed，退出码 0；覆盖 CREATE 后真实断言失败精确回收、
    UPDATE 后断言失败按 status + finished_at 写入值条件恢复，主错误/收尾错误/残留诊断保留。
  - 观测前置：`@@performance_schema=1`、`events_transactions_current=YES`；未读取 `INNODB_TRX`。
  - 正常交付组（`09-baseline/`）：3 suites / 68 passed / 2 skipped；基线 10 个账号事实前后一致，夹具零残留。
- 上述正常/受控故障运行使用的 `gandiantx@127.0.0.1` 含全局 `PROCESS`（非本轮授予），只作为功能证据，
  不作为“无 `PROCESS`”反例。
- 真实无 `PROCESS` 条件（`14-rq6-lowpriv/`、`15-final-3fix/`，低权限账号由用户本轮创建，配置在库外 0600）：
  - `litho_rq6_a@127.0.0.1`：无全局 `PROCESS`，无角色；目标库 9 项库级权限，并补齐
    `performance_schema.setup_consumers`、`setup_instruments`、`threads`、`events_transactions_current` 的 `SELECT`。
  - `litho_rq6_c@127.0.0.1`：同上，但不含 `performance_schema.threads` 的 `SELECT`。
  - `litho_rq6_b@127.0.0.1`：仅目标库 9 项库级权限，无任何 `performance_schema` 授权。
  - 配置输入缺陷（先明确指出，未静默改文件）：B 的 `DB_PASS` 多一个前导 `=` 且缺 host/port/db/timezone；
    C 的 `DB_PASS` 同样多一个前导 `=`；三者均缺 `FIELD_ENCRYPTION_KEY/IV`，故交付组沿用既定部署配置。
    运行封装在内存中披露后纠正并补齐，未改原文件、未落盘新密码、未创建账号或变更授权。
    B/C 的实测均使用**明确修正后的有效连接参数**（去掉一个前导 `=`；B 补齐 host/port/db/timezone），
    并非原样使用缺陷文件。
  - 条件 A：`--listTests` 精确为单一清理规格；实际执行退出码 0，**14 passed / 0 failed / 2 skipped**；
    快照前后逐字节一致，`s4e_` 夹具、驻留会话、活动事务、用户级锁、触发器均 0。
  - 条件 C（仅缺 `threads`）：退出码 1，**4 passed / 10 failed / 2 skipped**；10 个实库用例均在 `beforeAll` 因
    `事务观测能力不可用：无法读取 performance_schema.threads…；拒绝创建夹具（零造数）` 失败；
    实例写语句计数器前后差 0，快照逐字节一致。
  - 条件 B（`threads` 与观测表都缺）：同一入口在造数前拒绝，错误同时列出
    `threads`、`events_transactions_current`、`setup_consumers`、`setup_instruments`；退出码 1，
    **4 passed / 10 failed / 2 skipped**；写语句计数器前后差 0，快照逐字节一致。
  - R01/R02/R03 受控中断（`E2E_V13_CONTROLLED_FAULT=1` + `R01|R02|R03`）：各 **16 passed / 0 failed**，退出码 0；
    退出后精确回收本轮资源、非目标不变，主错误与收尾错误可追溯。
  - 最终交付组（`15-final-3fix/`，`lithography_rq3_account_dev`，44 条终态）：3 suites / **68 passed / 2 skipped**，
    退出码 0；前后快照逐字节一致，基线 10 账号 / 2 组织不变，17 表零残留。
- 结论：RQ6 条件 A/C/B、三项受控中断与最终交付组均已取得实库证据，不再保留未验证状态。

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

## RQ6 第 43 轮残项修复（观测能力与 R02 字节精确恢复）

- 观测能力：预检与收尾计数固定在实际 `observationRunner` 连接；
  `performance_schema.threads` 同时核验当前线程 `TYPE=FOREGROUND`、`INSTRUMENTED=YES`，
  并统计当前用户其他前台线程是否停采，覆盖造数/事务/收尾使用的池连接。
  `countActiveOwnTransactions` 每次计数前重新核验这些前提；线程停采、线程消失、
  状态缺失、查询异常或存在停采池连接时统一报“事务观测不可用（不可观测）”，
  拒绝把未知状态当作 `0`，helper 不开启任何全局/线程采集。
- R02 恢复：`stored_file.original_filename` 条件改为
  `CAST(original_filename AS BINARY) = CAST(? AS BINARY)`，不再依赖
  `utf8mb4_0900_ai_ci` 普通等号；同一恢复事实中的 `file_id` 也增加字节精确条件，
  避免主键仅大小写变化后被普通等号命中；`guardedCasRestore` 检查 `affectedRows===1`，
  未命中立即失败并报告 `targetId` 与冲突原因。冲突时 `cleanupCase` 在恢复阶段直接返回，
  不覆盖、不删除该行，也不进入随后通用清理；`local_backup_run.status` 的同类文本条件
  一并改为字节精确，`finished_at` 条件保留。
- 本轮新增默认关闭反例：
  `E2E_V13_INSTRUMENT_INJECTION=1` 验证“真实活动事务被观测、回滚后归零”与
  “仅停采实际测试连接、首次造数前拒绝、零业务写入、finally 恢复原状态”；
  `E2E_V13_SECOND_CONNECTION=1` + `E2E_V13_CONTROLLED_FAULT=1` +
  `E2E_V13_CONTROLLED_FAULT_CASE=R02-CONFLICT` 验证“另一受控连接仅改大小写后拒绝恢复、
  冲突行保留并输出可定位 ID”；独立收尾只使用受控修改前登记的预期字节值，
  未登记的第三方值保留、`DELETE affectedRows=0`，零匹配不视为回收成功。
- 本轮**没有新的实库写入授权**，未执行上述实库反例；现有授权仅覆盖既有
  `lithography_rq6_cleanup` / `lithography_rq3_account_dev` 等专项，未覆盖
  `performance_schema.threads` 的 `UPDATE`（线程停采）与第二受控连接写入。
  所需权限与授权缺口见 SOP 2.2；获批前保持默认关闭。
- 离线验证：类型检查、定向回归、变更文件 ESLint/Prettier、`nest build`、`git diff --check`
  与完整后端单测结果见本轮执行记录；未通过则不提交、不 push、不回复 PR、不合并。

## RQ6 第 44 轮实库反例与交付组复验（2026-11-10）

- 候选 `674d9750b40aa850a6aefa05ad920cca196b4046`；44 条迁移
  `ALL44=72dc3718fba8fd350beda73477a811d4de96c907eb9c3d117eaaff495ce99eb9`。
  库 `lithography_rq6_cleanup`（44 态），账号 `litho_rq6_a@127.0.0.1`
  （无全局 `PROCESS`、无角色、无 `performance_schema.threads` 的 `UPDATE`），配置库外 0600/0700。
- 反例 A 正常观测（`E2E_V13_INSTRUMENT_INJECTION=1`）：**1 passed / 18 skipped，退出码 0**；
  实际参与专项的连接建立真实事务被识别为 **1**，回滚后再次计数为 **0**。
- 反例 A 单线程停采：**未执行**（缺 `UPDATE ON performance_schema.threads`；未自行 `GRANT`、
  未用 root、未改全局开关，也未进入造数）。最小授权：
  `GRANT UPDATE ON performance_schema.threads TO 'litho_rq6_a'@'127.0.0.1';`
  注入工具已改为 `UPDATE` 前核验 `CONNECTION_ID`/`THREAD_ID`/`PROCESSLIST_USER`/
  `TYPE=FOREGROUND`/原 `INSTRUMENTED=YES`，以同时包含这些事实的条件 `UPDATE` 且
  `affectedRows=1` 才放行；恢复同样精确命中并读回确认，失败即停止后续写入。
  该修复仅通过静态/离线检查，实库行为证据待授权后补。
- 反例 B 正常对照（`E2E_V13_CONTROLLED_FAULT=1` + `CASE=R02`）：
  **1 passed / 18 skipped，退出码 0**；注入读取失败、字节精确 CAS 命中 **1 行**、
  主错误可追溯、精确回收后快照回基线。
- 反例 B 并发冲突（`CASE=R02-CONFLICT` + `E2E_V13_SECOND_CONNECTION=1`）：
  **1 passed / 18 skipped，退出码 0**；第二受控连接提交仅大小写不同的文件名后，
  字节精确 CAS **未命中**，输出 `targetId` 与冲突诊断，**不覆盖、不删除**该行，
  不进入随后通用清理；保存的直接证据为
  `file_id=9602dbaf-7aa0-4681-8e73-e71b0e07d99a`、
  `original_filename_bytes=5334452d5230322d5752495454454e2d4d5741494e454a3035343530323336422e545854`
  （大写 `S4E-R02-WRITTEN-...TXT`）。当轮证据保存后的独立收尾曾按冲突行当前字节回收；
  该做法已在第 47 轮修正为仅使用受控修改前登记的预期字节值：未登记第三方值保留，
  `DELETE affectedRows=0`，零匹配不视为回收成功；**不把保留记为清理器零残留**。
- 正常交付组：`e2e-scoped-cleanup.v13.realdb.spec.ts` +
  `e2e-owned-fixture.e2e-spec.ts`，**2 suites / 59 passed / 5 skipped / 0 failed，退出码 0**；
  5 项 skip 均为默认关闭的受控故障/线程停采用例。
  `v13-d3-constraint-acceptance.realdb.spec.ts` **未执行**：唯一授权低权限配置缺
  `FIELD_ENCRYPTION_KEY/IV`，会在 `beforeAll` 造数前失败关闭；未补配置、未切换库、
  未用高权限部署配置冒充低权限证据，受阻部分如实报告。
- 快照前后 `sha256` 均为 `fee380c13369b0ea6972e4bcde7c54fcde79bce3feccf79dd3aaa9e0c59f30d6`，
  逐字节一致：52 表结构/索引/外键/CHECK、44 条迁移历史、种子与行数不变；S4E/D3C/OWNED
  残留 0，`stored_file`/`repair_request`/`intake`/`attempt` 0，触发器 0，本账号活动事务 0，
  除核对连接外无驻留前台线程。`data_locks`/`metadata_locks` 无 `SELECT` 权限，未直接读取，
  未宣称已核验锁表。
- `typecheck`、变更文件 ESLint、Prettier、`git diff --check` 均退出 0；生产源码未变，
  沿用 `674d975` 的完整后端单测结果。未 push、未回复 PR、未合并。

## RQ6 第 45 轮补跑：线程停采与 D3（2026-11-10）

- 账号 `litho_rq6_a@127.0.0.1` 已获临时
  `GRANT UPDATE (INSTRUMENTED) ON performance_schema.threads`；仍无全局 `PROCESS`、无角色；
  仅用 `lithography_rq6_cleanup` 与授权实例 UUID，未用 root、未扩权、未建库。
- 单线程停采（`E2E_V13_INSTRUMENT_INJECTION=1`）：**1 passed / 18 skipped / 0 failed，退出码 0**。
  实测 `thread_id=14358`、`connection_id=12103`、`original=YES`、`injected=NO`；
  造数前对已停采实际连接的观测拒绝、池级预检拒绝，未返回 0；
  `finally` 条件恢复并读回确认；运行后本账号 `INSTRUMENTED<>YES` 前台线程为 **0**。
  授权 `performance_schema.threads` UPDATE 共 **2 次**（停采、恢复各 1），
  业务 INSERT/UPDATE/DELETE 与 DDL 为 **0**，23 表计数与全库快照前后一致。
- 首次停采执行因列别名 `CURRENT_USER` 与 MySQL 保留函数冲突，在任何 UPDATE 前失败
  （未改线程状态）；改为 `current_user_value` 后复跑通过，`typecheck`/ESLint/Prettier 均为 0。
- D3 专用配置：新建 `account-a-d3.env`（0700/0600，未覆盖原文件），保留同一低权限身份与目标库；
  `FIELD_ENCRYPTION_KEY/IV` 从该部署既有 0600 配置 `round43-final/deploy-delivery.env`
  原样读取（均 16 字符），未重新生成/猜测/打印，未提交。
- D3 实库单文件：**8 passed / 1 failed，退出码 1**。失败用例为
  “初始化事务失败不留部分新增，密码与目标库在写入前拒绝”：规格要求目标库名包含
  `test/dev/local/drill`，授权库 `lithography_rq6_cleanup` 被安全门按设计拒绝。
  未改安全门、未加 skip、未放宽断言、未重命名或新建库，故本轮无法通过，**不记为 passed**。
- D3 运行后快照 `sha256` 仍为
  `fee380c13369b0ea6972e4bcde7c54fcde79bce3feccf79dd3aaa9e0c59f30d6`；
  S4E/D3C/OWNED 残留 0，相关业务表 0，触发器 0，活动事务 0，停采线程 0。
- 未重跑已通过的实际事务观测、R02 正常/并发冲突与交付组两项。
  因 D3 未全通过，未追加文档提交；未 push、未回复 PR、未合并。

## RQ6 第 46 轮 D3 功能验收补跑（rq3_account_dev，2026-11-10）

- 授权目标：`127.0.0.1:3306`、UUID `909f9587-9fce-11f1-a353-00e0709ef3a9`、
  库 `lithography_rq3_account_dev`。
- 使用该库既有部署账号与本机 0600/0700 受限配置
  `/home/gandiantx/secure/lithography-v13/delivery-verify/rq3-account-dev.env`；
  账号 `gandiantx@127.0.0.1` 具备全局 `PROCESS`/`SUPER` 等权限。
  **本次仅为 D3 功能验收，不声称低权限证据**；未用 root、未扩权、未新建库、未改默认 env。
- 基线核对：`CURRENT_USER()=gandiantx@127.0.0.1`、
  `DATABASE()=lithography_rq3_account_dev`、MySQL `8.0.46`、UUID 一致；
  44 条迁移、52 张表（51 张业务表）、0 触发器、安装种子存在。
- 正式 verify：`npm run migration:verify -- --config-file=<0600 配置>
--database=lithography_rq3_account_dev`，**退出码 0**；
  输出“业务表 51 张；历史校验与数据回填校验通过”。
- 基线快照 `sha256=5b50db359c88635da972593418e094ef19cca4384d7fcb49395cf73f33db3f3c`。
- D3 单文件（安全入口先 `--listTests` 精确 1 文件，再 `--runTestsByPath`）：
  **1 suite / 9 passed / 0 failed / 0 skipped，退出码 0**；未加 skip、未放宽断言。
- 运行后快照哈希与基线完全相同：已有账号、组织、结构、数据与迁移历史未变，
  D3/S4E/OWNED 夹具零残留；`innodb_trx` 0、`innodb_temp_table_info` 0、
  `data_locks` 0；元数据锁仅核对连接自身对 `performance_schema.metadata_locks`
  的 `SHARED_READ`，非测试遗留；本账号前台连接仅核对连接 1 条，活动事务 0。
- 保留第 45 轮在 `lithography_rq6_cleanup` 的 **8 passed / 1 failed** 历史：
  失败原因为授权库名不含 `test/dev/local/drill`，被开发账号安全门按设计拒绝；
  旧运行不改写、不合并。
- 本轮未改代码、未改安全门、未重跑停采/R02/完整单测。
  文档通过 Prettier、链接与 `git diff --check` 后追加提交；未 push、未回复 PR、未合并。

## RQ6 第 47 轮：两处收尾安全遗漏修复（2026-11-10）

- `FAULT-UPDATE`：写入前由数据库确定并规范化 `finished_at`，`UPDATE` 成功后立即登记
  原值、写入值与字节精确 CAS 条件；回读只做核验。实库已验证“回读注入失败后仍恢复”
  与“外部改写后拒绝覆盖并报告 `targetId`”，各 **1 passed / 18 skipped，退出码 0**。
- `R02-CONFLICT` 独立收尾：`DELETE` 只用受控修改前登记的预期字节值，当前值只用于比较
  与定位；未登记第三方值保留，`affectedRows=0`，不继续通用删除；必要父资源一并保留，
  `afterAll` 不为追求零残留反向删除。实库 **1 passed / 18 skipped，退出码 0**；
  保留证据 `file_id=e3530b83-306a-46d6-a43a-1b0536a7ec44`、`account_id=9905040`、
  `organization_id=120`。
- 正常回收对照（`CASE=R02`）：**1 passed / 18 skipped，退出码 0**。
- 非目标基线（`organization id=1`、安装种子、44 条迁移、触发器数）每次运行前后一致；
  17 表中仅保留证据 `stored_file` 为 1，其余 16 表为 0。该证据会使同库 R09 零残留
  断言不成立；授权维护者复核处置前，不将该库用于零残留交付组断言。
  未改迁移/Entity/权限/部署，未重跑其他 RQ 或旧业务 core。
- 静态检查：`typecheck`、变更文件 ESLint、Prettier、`git diff --check` 均退出 0。
- 追加修复提交；未 push、未回复 PR、未合并。

## RQ6 第 48 轮：4 项 RQ 收口与隔离实例实库复跑（2026-11-10）

- 入口与目标：专用隔离实例 `127.0.0.1:3307`（MySQL 8.0.46，`@@server_uuid=7e75b5a6-dd06-11f1-808d-00e0709ef3a9`，
  `performance_schema=1`）；空库 `lithography_v13_test` 由本轮创建并 `database:deploy --mode=init` 初始化：
  44 条迁移、51 张业务表（含 `migrations` 共 52 张）、1 行安装种子。未连接或修改共享 3306 实例、Redis、
  审查方现场与原事故数据。
- P1 上游依赖：`global_instrumentation`、`thread_instrumentation` 分别关闭时计数明确拒绝、不返回零事务，
  恢复后事务可见；正常采集可观测真实活动事务（计数 1），回滚后归零。
  normal 档 `3 suites passed / 72 passed / 3 skipped`，退出码 0。
- P2 停采恢复：第二连接先停采时本轮 `UPDATE` 零命中，判定 `not-applied`，保持他人 `NO` 且不反向恢复；
  本轮成功命中 `applied` 时才登记并执行恢复。normal 档实库通过。
- P3 冲突跨收尾：`R02-CONFLICT` 与 `FAULT-UPDATE` 在 conflict 档执行，`75 passed / 0 skipped`，退出码 0。
  Jest 退出后用独立 mysql 连接复核：冲突 `stored_file` 行仍在（`file_id=26eed0a0-588e-42dd-b2fd-18e73f29fbce`，
  字节值 `S4E-R02-WRITTEN-MWAPGBGY9C833E02.TXT`，uploader=`9904992`、owner_organization=`21`、`STAGING`）；
  冲突备份行 `local_backup_run id=5` 仍在（`SUCCEEDED`、`finished_at=2001-02-03 04:05:06.007`，
  `installation_id` 指向唯一安装种子）；账号、组织、安装引用均存在。
  17 张清理表中仅 `stored_file=1`（保留），其余 16 张为 0；`local_backup_run=1`（保留）。该保留现场**不是零残留**。
- conflict 档首次执行暴露 R04/R06 的全局零残留断言未考虑设计保留；两处已改为“除已登记保留外精确零行”，
  并仍断言保留行存在；未修改或放宽 R09，也未删除保留行制造通过。
  （第 49/50 轮更正：R09 已同步读取精确登记的保留集合，“未修改 R09”的表述自第 49 轮起不再成立。
  第 50 轮 conflict 档再次实库通过，保留集合按实际 `file_id` / `local_backup_run.id` 核验。）
- P4 文档：PR 正文仅保留当前交接说明并统一链接本目录；终态为 44 条迁移、51 张业务表。
- 最终静态与构建：`typecheck`、变更文件 ESLint/Prettier 退出码 0；`test:unit` 为
  `8 skipped suites / 159 passed`，`202 skipped / 1889 passed / 2091 total`，退出码 0；`npm run build` 退出码 0。
- 未改迁移、Entity、旧业务接口、MySQL 服务或系统权限表；未 push、未回复 PR、未合并。

## RQ6 第 49 轮：P1/P2 最小修复与文档更正（2026-11-10）

- 范围：只改 V13 专项验收规格、测试工具与交付文档；未改迁移、Entity、旧接口，未连库、未 push、未回复 PR、未合并。
- P1 竞争用例恢复归属：`finally` 不再只凭线程标识恢复。首次条件 UPDATE 的分类结果在任何断言之前登记为恢复责任；
  命中 0 行、结果未知或线程事实不全时保持现状，不认领其他执行方写入的状态。新增离线回归 3 条：
  零命中、结果未知、成功写入后断言失败仍按登记事实恢复。
- P2 实际恢复冲突登记：套件级保留改为在恢复阶段实际冲突处（CAS 命中 0 行）立即登记，不再依赖故障注入开关；
  用例、通用清理与 `afterAll` 统一读取该保留事实，父安装种子仍由既有基线保护。`FAULT-UPDATE` 的冲突改由
  受控外部连接制造，`E2E_V13_SECOND_CONNECTION` 仅保留给 `R02-CONFLICT`；无冲突正常回收保留为独立对照用例。
- P3 文档：`PR正文.md` 的 6 条链接改为同目录相对链接，并注明粘贴 PR 正文时的仓库链接口径；按模板补齐
  数据库影响、验证与不适用项；SOP 将冻结 43 态命令单列为历史路径，与当前 44 态命令分开。
- 更正第 48 轮记录：R09 已改为读取精确登记的保留集合（`stored_file`、`local_backup_run` 等），
  不能再声称“未修改 R09”；第 48 轮 R04/R06 的记录保留为历史事实，不回写覆盖。
- 验证：定向离线回归与 capability 规格通过；`typecheck`、变更文件 ESLint/Prettier、
  `test:unit`（`202 skipped / 1892 passed / 2095 total`）与 `npm run build` 退出码均为 0。
  实库正常档、冲突档与 R09 专项未在本轮复跑，需隔离实例另行授权。
  （第 50 轮更正：上述 `1892/2095` 没有保留原始 Jest JSON 支撑，保留的 21:08 原始日志为
  `202 skipped / 1889 passed / 2091 total`；最终候选实测为 `205 skipped / 1895 passed / 2100 total`，
  以第 50 轮的 JSON 与日志为准。）

## RQ6 第 50 轮：三项修复集中实库验收与本地提交（2026-11-10）

- 范围：沿用第 49 轮 P1/P2/P3 修复，仅补验收所需的默认关闭停采故障与 runner `fault` 入口；
  未改迁移、Entity、旧业务接口；未 push、未回复 PR、未合并。
- 现场：分支 `feat/database-v13-deploy`，冻结 HEAD `f434d0084b5dcbda8258d0b41f6e48721f8001b3`；
  工作区修复未 reset/stash/amend。证据在仓库外
  `~/.local/share/lithography-v13-rq-evidence/round50/`（目录 0700、文件 0600）。
- 隔离实例：新建 `/tmp/v13-isolated-20261110T140903Z`（datadir/socket/pid/日志均在其中，
  启动前确认 3307 空闲），仅绑定 `127.0.0.1:3307`，`@@server_uuid=490feee1-dd10-11f1-9b49-00e0709ef3a9`；
  未连接或修改 3306、Redis、审查方现场与事故数据。初始化管理员只用于创建 `litho_v13_test` 专用账号及
  库级/观测 SELECT/`threads.INSTRUMENTED`/`setup_consumers.ENABLED` 授权；专项不使用 root。
  空库 `lithography_v13_test` 由本轮创建，`database:deploy --mode=init` 得到 44 条迁移、51 张业务表，
  `migration:verify` 与安装种子/迁移计数核验退出码 0。
- 冻结指纹：候选 14 个代码/配置/测试文件逐文件 SHA-256 见 `candidate-files.sha256`；44 条迁移逐文件
  SHA-256 见 `migrations-files.sha256`，聚合指纹 `05ea36ee9638ca314064966599d920f2bee734a5d933a4fb56035974be785877`。
  关键文件：`e2e-scoped-cleanup.v13.realdb.spec.ts=bb43a921…`、`run-v13-authoritative-spec.ts=67d378dc…`、
  `e2e-scoped-cleanup.ts=d5be801d…`、`v13-authoritative-config.spec.ts=d8a2d28d…`（完整值见证据文件）。
  `--listTests` 在 normal / fault / fault-UNKNOWN / fault-ASSERT-AFTER / conflict 五种入口下均由入口机器校验为
  同一 3 文件集合后再 `--runTestsByPath`。
- A 零命中：受控第三连接先把目标线程置 `NO`；被测路径的首次条件 UPDATE 为 0 行，分类 `not-applied`、
  `shouldRestore=false`；`finally` 计划为 `keep` 且不发恢复写入。直接证据 `instrumented=NO` 保存后，
  由测试执行者按注入事实恢复为 `YES`。实库通过。
- B 结果未知：真实 UPDATE 命中 1 行但主动丢弃返回值，分类 `unknown`；报告
  `thread_id/connection_id/user` 与“结果未知”，不归为成功或零命中；`finally` 保持 `NO`，执行者收尾恢复。
  实库通过。
- C 成功后断言失败：命中 1 行后、断言前已登记恢复责任；受控断言失败后仍按登记事实恢复 `YES`。实库通过。
- 真实备份冲突：`fault` 档明确不设置 `E2E_V13_SECOND_CONNECTION`，保留登记不依赖 `conflictArmed`；
  受控连接改写 `finished_at` 并提交，CAS 恢复命中 0 行后在冲突位置登记套件级保留。normal 对照断言原始
  `INJECTED_READ_FAILURE:FAULT-UPDATE`；冲突用例断言原始失败含 `恢复冲突` 与 `targetId=17`。
  Jest 进程退出后由独立 mysql 连接复核：`local_backup_run id=5/9/13/17` 仍在、外部值
  `2001-02-03 04:05:06.007` 保留、`installation_id` 引用存在、本账号 active transaction=0。
  trace 见证据目录 `run-fault-update.log` 的 `[S4-E/FAULT-UPDATE-CONFLICT]` 行。
- 正常对照与专项：normal 档 `72 passed / 6 skipped`；fault 档（无外部冲突的 FAULT-UPDATE 正常恢复与精确回收）
  `75 passed / 3 skipped`；fault-UNKNOWN 与 fault-ASSERT-AFTER 各 `76 passed / 2 skipped`；
  conflict 档及 R09 `76 passed / 2 skipped`。五次退出码均 0。
- conflict 保留：`stored_file file_id=4a467f73-1efe-47c1-a382-945c1ea03a5f`
  （原始文件名字节 `S4E-R02-WRITTEN-MWARW4WDCCED9192.TXT`，uploader=9905052、owner_organization=81、`STAGING`）；
  `local_backup_run id=17`（`SUCCEEDED`、`finished_at=2001-02-03 04:05:06.007`）。17 张清理表中仅
  `stored_file=1`，其余 16 张为 0；`local_backup_run` 共 4 行保留（含前序受控反例 5/9/13）。
  该现场不是零残留；未删除保留行、未 TRUNCATE、未关闭外键、未重置 AUTO_INCREMENT。
- 统计更正：完整单测 `8 skipped suites / 159 passed`、`205 skipped / 1895 passed / 2100 total`、
  `0 failed / 0 todo`，退出码 0；`npm run build` 退出码 0。上一轮文档的 `1892/2095` 无保留原始 JSON 支撑，
  保留的 21:08 日志为 `202/1889/2091`；本轮以实测 JSON 替换，不做算术修补。
- 未覆盖：真实旧库升级、前端/真实登录、Redis、Worker、完整业务 core、真实云端执行器不在本轮范围；
  `npm run check:entity-scope` 仍为 1（既有裁决记不适用）。

## 第 51 轮：实例级 consumer 未知写入结果的收尾修复（2026-11-11）

- 对应 dd0d2e9 复审的唯一 P2：条件 UPDATE 发出前固定实例 UUID、消费者及原状态；明确命中 1 行才返回恢复函数，
  调用方在任何后续断言前登记。0 行或未知结果不认领恢复，停止后续测试/注入并输出当前可确认状态及执行者处置责任。
- 新增 `test/utils/consumer-instrumentation.ts` 与 6 条离线回归。用例保留主错误，恢复/回滚/释放错误分别收集，
  避免 finally 覆盖原始故障；条件恢复要求精确命中并读回原状态。
- 新建隔离 MySQL 8.0.46（127.0.0.1:3307，UUID `00e7be55-dd5c-11f1-85cf-00e0709ef3a9`），
  专用库 `lithography_v13_test`。正式 `database:deploy --mode=init` 与 `migration:verify` 退出码 0，44 迁移、51 业务表。
  专项使用专用非 root 账号；管理员只用于隔离实例管理和独立读取/处置。
- 实际验收编排：仓库外 `node /tmp/v13-consumer-accept.cjs setup|normal|unknown|restore|post-restore|checks|shutdown`
  分阶段运行；逐条命令及退出码保存在证据目录各 `*.command.json`。测试环境由正式 runner 的 `buildEnvironment` 派生，
  专用 Jest 配置、显式 UUID/库名/白名单/许可不变。每次先 `--listTests` 精确核对 1 个或 3 个文件，再执行 `--runTestsByPath`。
- normal：候选单文件 18 passed / 0 failed / 6 skipped，退出 0。两个上游 consumer 正常恢复；真实事务计数 1→回滚后 0。
- unknown：临时源码副本只在 MySQL 已执行 global consumer 关闭后抛出 `INJECTED_CONSUMER_WRITE_RESULT_LOST`，
  不改正式候选；选择上游 consumer 单用例。0 passed / 1 failed / 23 skipped，退出 1。
  预期失败内容明确包含实例 UUID、`consumer=global_instrumentation original=YES current=NO`、原始错误及停止注入/人工处置说明。
  整个 Jest 退出后独立连接确认 global consumer 为 NO、thread 与 events consumer 仍为 YES；此失败不冒记为通过。
- 独立执行者保存上述直接证据后，核对实例 UUID/端口，按名称及 NO 条件恢复 YES，命中 1 行；读回三项均 YES。
  post-restore：最终候选 3 suites / 72 passed / 0 failed / 6 skipped，退出 0，包含恢复后的活动事务观测。
  normal、unknown、post-restore 三次全表数据快照均逐字节一致；无通过删除未知状态制造验收成功。
- 完整单测原始 JSON：160 passed / 8 skipped suites；1901 passed / 205 skipped / 2106 total，0 failed，退出 0。
  typecheck、spec tsc、变更文件 ESLint/Prettier、build、diff 检查通过。44 条迁移、Entity、外键、目标守卫均未改。
- 证据：`~/.local/share/lithography-v13-rq-evidence/round51-consumer/`（0700/0600），包括进程退出后设置快照、数据快照、
  临时副本唯一注入 diff、Jest JSON、执行者恢复前后记录。仅关闭本轮独立 mysqld，保留 datadir 和证据；未操作共享 3306/Redis/审查方现场。
- 本轮追加本地提交；未 push、未回复 PR、未合并。既有 `v13-authoritative-config.spec.ts` 的纯格式工作区改动不纳入本轮提交。

## 第 52 轮：双失败具体诊断的实际 Jest 补验（2026-11-11）

- 对应 `5ab64d8` 复审的唯一 P2。恢复失败包装错误保留 cause，并只读取得当前状态；
  `createConsumerInjectionFailure` 保留原始错误对象到 `AggregateError.errors`，同时把主错误、每个收尾错误和状态写入
  Jest 实际显示的 message。读回失败明确输出 `current=UNKNOWN` 及读回原因；原状态、实例和 consumer 可定位。
  已确认写入才恢复的责任规则及后续注入拦截保持不变。
- 新增 4 条离线回归，10 条 consumer 回归全部通过。覆盖结构化对象身份、主/恢复错误的可见 message、状态读回成功/失败，
  确认没有因显示诊断而新增写入或重试恢复。
- 全新 MySQL 8.0.46 隔离实例：127.0.0.1:3307，UUID `f20f830a-dd67-11f1-9c45-00e0709ef3a9`，
  专用库 `lithography_v13_test`；正式 init/verify 均退出 0，44 条迁移、51 张业务表。
  专项使用专用非 root 账号，管理员仅负责隔离实例设置、独立读取、处置和关闭。
- 实际编排为仓库外 `node /tmp/v13-consumer-accept52.cjs` 分别执行 `setup`、`normal`、`double`、
  `restore double`、`double-read-unknown`、`restore double-read-unknown`、`post-restore`、`checks`、`shutdown`。
  环境由正式 runner 的 `buildEnvironment` 派生；每次先 `--listTests` 精确校验 1 或 3 文件，再执行 `--runTestsByPath`。
  两种故障运行均追加 `-t 'INSTRUMENT (上游 consumer|仅停采测试连接)'`，同时选择被测故障及其后续注入。
  原始 cwd、命令参数、退出码分别保存在各 `*.command.json`，临时副本注入 diff 单列保存，不改正式候选。
- `double`：真实停采成功后触发带 `INJECTED_CONSUMER_PRIMARY_ASSERTION` 标记的 Jest 主断言失败，恢复写入抛出
  `INJECTED_CONSUMER_RECOVERY_FAILURE`。实际 Jest message 同时显示两个标记、UUID、consumer、`original=YES current=NO`，
  已确认写入责任、恢复条件及执行者处置说明。0 passed / 2 failed / 22 skipped，退出 1；第二个失败来自 beforeEach 拦截。
- `double-read-unknown`：在同一双失败上再让诊断读取抛出 `INJECTED_CONSUMER_STATE_READ_FAILURE`。
  实际 Jest message 仍显示主错误和恢复错误，状态明确为 `current=UNKNOWN`、含读回错误；
  0 passed / 2 failed / 22 skipped，退出 1；后续注入同样被拦截。两次预期失败均不计为通过。
- 每次整个 Jest 进程退出后，独立连接读取均为 global consumer NO、thread/events consumer YES。
  保存直接证据后执行者核对 UUID/端口及原状态，按名称和 NO 条件恢复 YES，分别明确命中 1 行并读回三项 YES。
  初始 `normal` 与最终 `post-restore` 各 3 suites / 72 passed / 0 failed / 6 skipped，退出 0，真实事务观测 1→回滚后 0。
  四次运行全表数据快照均前后一致；未操作共享 3306、Redis 或既有现场。
- 完整单测原始 JSON：160 passed / 8 skipped suites，1905 passed / 205 skipped / 2110 total，0 failed，退出 0。
  正式/工具/spec 类型检查、变更文件 ESLint/Prettier、build、diff 检查通过。迁移、Entity、外键和目标守卫未改。
- 关闭前独立读取三项 consumer 均 YES、活动事务及测试账号会话均 0；只关闭本轮 mysqld，数据目录保留。
  证据在 `~/.local/share/lithography-v13-rq-evidence/round52-consumer-double-failure/`（0700/0600）。
  本轮仅追加本地修复提交，未 push、未回复 PR、未合并；原有配置测试格式改动继续保留于工作区。

## 第 53 轮：F1 CHECK 定义、F2 独占连接收尾与 F3 执行者恢复（2026-11-11）

- 基线：分支 `feat/database-v13-deploy`，HEAD `996d3c1934392ec4b5cf4da528f4f62a7fa1033e`；
  保留既有工作区改动与 3 个 stash。未改前 44 条迁移、业务接口、外键、目标库守卫与清理器拒绝语义，
  未 reset/amend/清库/重置 AUTO_INCREMENT；本轮不 commit、不 push、不回复 PR、不合并。
- F1 定义完整性：
  - `REQUIRED_CHECKS` 共 199 项，全部具备显式表达式定义；补齐 79 条继承 CHECK（前 44 条迁移创建），
    并为 20 条确有表达式变化的 CHECK 增加 `stages`（含 `organization_membership_role`、
    `repair_request_handling_mapping`、`repair_request_handling_time`）。
  - `requireCheckDefinition` 对缺失定义、缺少 `since`/`clause`、未在 `REQUIRED_CHECKS` 登记、
    阶段 `since` 非递增或早于终态一律抛错；正式校验的 `collectCheckDefinitionIssues` 改为遍历
    `REQUIRED_CHECKS`，缺定义直接报告“关键 CHECK 缺少表达式定义”，不再因查找返回 `undefined` 静默跳过。
  - 前缀校验使用 `resolveCheckDefinitionAt`：旧前缀按当时有效阶段校验，终态按最新定义校验；
    创建前不产生该 CHECK 要求。正式入口仍由既有 `assertRequiredStructureDefinitions` 调用链执行。
  - 新增离线回归：`organization.chk_organization_kind` 与
    `repair_request.chk_repair_request_handling_mapping` 改为 `TRUE` 均以
    `关键 CHECK 定义漂移` 拒绝；正确终态通过；旧前缀按旧定义通过；漏登记定义产生
    `继承CHECK 缺少精确定义`；既有缺失、`NOT ENFORCED`、已登记漂移拒绝保持。
- F2 独占连接收尾：
  - 复用既有 `destroyExclusiveQueryRunner`，新增 `settleExclusiveQueryRunner` 并让
    `runGuardedQueryRunnerTransaction` 改走同一实现，不另建平行机制。
  - 按驱动实际 `isTransactionActive` 收尾：活动事务先回滚；回滚失败或仍活动时销毁本轮独占连接；
    仅确认无活动事务后才普通 `release`；不销毁共享 DataSource/连接池。
  - 已覆盖同文件同模式：consumer 注入/验证事务、`FAULT-UPDATE` 第二连接、`R02-CONFLICT` 第二/三连接、
    `INSTRUMENT` 正常事务、`afterAll` 观测连接、停采及断言失败连接。主错误、回滚、销毁与释放错误分别保留，
    主错误存在时收尾错误打印到 Jest 输出，无主错误时再抛出。
- F3 执行者恢复独立于证据断言：
  - 线程 UNKNOWN 用例在真实 `affectedRows=1` 后、任何后续读取/断言前登记
    `threadId/connectionId/processlistUser/expectedInstrumented`。
  - 被测 UNKNOWN 路径仍按分类结果 `keep`，不自动恢复；执行者恢复放入独立 `finally`，按登记事实精确恢复并读回。
  - 恢复失败或读回未确认时置位注入拦截、销毁停采独占连接（不回池）；证据断言与恢复错误互不覆盖。
- 离线验证（本轮未具备新增实库授权，未连接共享 3306/Redis/审查方或事故现场）：
  - `npx jest`（7 个受影响数据库规格，含 F1 规格、schema 契约、v13-db-verification、
    e2e-scoped-cleanup 离线档、capability、consumer-instrumentation）：
    `7 suites passed`、`167 passed / 86 skipped / 253 total`，退出码 0。
  - `npx jest --config /tmp/jest-offline-owned-fixture.js`（仓库外临时配置，仅跳过实库 globalSetup）：
    `38 passed / 7 skipped / 45 total`、0 failed，退出码 0；覆盖事务启动后抛错、提交后释放失败、
    正常失败回滚、回滚失败、销毁失败与主错误保留。
  - `npm run typecheck` 退出码 0；变更 5 文件 `npx eslint` 0 error（12 条 `max-depth` warning，不阻断）。
  - 44 条迁移文件 `git status` 无改动，迁移指纹未变；未改 Entity。
- 待补证（需另行授权的专用隔离实例）：
  - F1 实库把 `organization.chk_organization_kind`、`repair_request.chk_repair_request_handling_mapping`
    改为 `TRUE` 后 `migration:verify` 拒绝，以及旧前缀合法态通过。
  - F2 启动部分成功、UPDATE/commit 失败、回滚失败、destroy/release 失败的实际 Jest 输出与
    “活动连接未普通回池”直接证据。
  - F3 成功写入后读回失败、证据断言失败、执行者恢复失败三档；证明被测路径未擅自恢复、
    执行者 `finally` 确实执行、恢复未确认时后续注入被拦截。
- 原 Entity `ai_helpfulness` 差异（单列，不顺带改输入策略）：
  `maintenance-report.entity.ts` 声明 `BETWEEN 1 AND 4`，而第 44 条迁移、校验契约与字段字典均为
  `BETWEEN 1 AND 5`。本轮保持交付库与校验契约为 1..5，不修改 Entity，也不改变输入策略；
  该差异留待独立裁决。

## 第 53 轮集中实库验收（2026-11-11）

- 冻结与实例：HEAD `996d3c19…`、分支 `feat/database-v13-deploy`、3 个 stash 保持、暂存区为空；
  44 条迁移逐文件 SHA-256 与上一轮一致。仅使用新建专用实例 `127.0.0.1:3307`，
  UUID `32aab37e-dd78-11f1-a06e-00e0709ef3a9`，datadir `/tmp/v13-f1f3-1794364374/data/`，
  账号 `v13_test`；未连接共享 3306、Redis、审查方实例或事故现场。
  `v13-authoritative-config.spec.ts` 的既有格式改动保留在工作区，不纳入交付指纹。
- 基线修正：正式 init 先暴露 6 条 CHECK 定义漂移（mapping、handling_time、
  repair_request_revision、reference_document_revision、sync_conflict、backup_restore_run）。
  根因是终态校验集合只登记创建时间戳，未包含同名 CHECK 的最终阶段 `since`，导致回退旧阶段；
  已在 `collectAllStructureRequirements` 纳入 `CHECK_DEFINITIONS` 的终态与阶段时间戳，并补离线回归用例。
  修正后 `v13_accept` 与新建 `v13_accept_test` 的正式 init/verify 均退出 0。
- F1 漂移反例（各单独执行，互不复用通过结论）：
  - `organization.chk_organization_kind` → `CHECK (TRUE) ENFORCED`，`migration:verify` 退出 1，
    issue 仅命中该约束的定义漂移；受保护恢复后 `SHOW CREATE TABLE`、约束清单、`ENFORCED`、
    表数据与基线完全一致，verify 退出 0。
  - `repair_request.chk_repair_request_handling_mapping` 同样退出 1 且仅命中该约束；恢复一致后退出 0。
  - 合法旧前缀：按迁移时间戳正向构建前 30 条（含旧 mapping 定义、不含终态迁移），
    正式 `migration:status` 退出 0 且无结构 issue，正式 `database:deploy --mode=upgrade` 退出 0；
    未伪造迁移历史，也未要求只支持终态的 verify 接受旧态。
- F2 临时副本故障注入（候选源码未改）：实库 Jest 6/6 passed，退出 0。覆盖启动部分成功、
  事务内 UPDATE 失败、提交回执丢失、回滚失败、回滚+销毁均失败、释放失败；
  断言连接事件为先回滚后释放、回滚失败时不普通 release 且仅销毁本轮独占连接、
  共享 DataSource 仍可查询；主错误、回滚/销毁/释放错误均实际可见。
  提交回执丢失档不宣称已回滚或未写入，独立连接读回该行确实存在后再清理。
  回滚失败档独立确认行未落库且服务端线程已消失。
- F3 临时副本故障注入（真实停采命中 1 行后）：
  - 读回失败档：被测 UNKNOWN 路径记录“不执行自动恢复”，执行者在独立 finally 按登记事实恢复，
    日志确认 `YES`；Jest 以注入读回错误预期失败（0 passed / 1 failed / 23 skipped，退出 1）。
  - 断言失败档：`Expected YES / Received NO` 证明被测路径未恢复，执行者恢复确认 `YES`；
    预期失败计数同上。
  - 执行者恢复失败档：同时启用下一条注入用例，恢复抛错后销毁停采独占连接、置位拦截，
    下一条用例在 beforeEach 被拒绝（0 passed / 2 failed / 22 skipped，退出 1）。
    进程退出后独立连接确认测试账号无 `INSTRUMENTED='NO'` 线程、无活动事务；
    该连接因销毁而消失，记录为线程消失，不写成恢复为 YES。
- 最小回归：F1 离线规格 46 passed；正常交付组（`delivery` + normal 注入档，目标
  `v13_accept_test`）72 passed / 6 skipped / 0 failed，退出 0（首轮 `v13_accept` 因库名不含
  test/dev/local/drill 被 d3 守卫拒绝，属环境前置不匹配，不计作通过）；typecheck 退出 0；
  5 个变更代码文件 eslint 0 error、12 条既有 `max-depth` warning。
- 残留与不变量：`v13_accept`/`v13_accept_test` 中 F2/D3 测试行均为 0，活动事务 0，
  `v13_test` 无停采线程；44 条迁移与候选源码 SHA-256 复核未变。
- 本轮未 commit、未 push、未回复 PR、未合并；仅依据上述证据判断是否具备提交条件。

## 第 54 轮专项复查：恢复责任与连接状态分离（2026-11-11）

- 冻结与实例：HEAD `754ebf987a5e4f051bd48e1e8071cf2d890e72ec`（与预期一致）、分支
  `feat/database-v13-deploy`、3 个 stash 保持、暂存区为空；44 条迁移逐文件 SHA-256 与第 53 轮一致，
  聚合值仍为 `72dc3718fba8fd350beda73477a811d4de96c907eb9c3d117eaaff495ce99eb9`；
  未改前 44 条迁移、Entity、业务接口与目标库守卫。仅使用既有专用实例 `127.0.0.1:3307`，
  UUID `32aab37e-dd78-11f1-a06e-00e0709ef3a9`，datadir `/tmp/v13-f1f3-1794364374/data/`，账号 `v13_test`；
  未连接共享 3306、Redis、审查方实例或事故现场。`v13-authoritative-config.spec.ts` 的既有格式改动保留，
  本轮未触碰。
- 修改的源码文件（仅 1 个）：`backend/src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts`
  （SHA-256 `6e0575de229f9b68c3e93fc4eae68431b3437d74aac2e3ef9d209ad389617ec5`）；
  验收记录仅改本文件。核对：本文与命令中均未出现 `UEKNOWN` 拼写，实际启用档位为
  `V13_SPEC_INSTRUMENT_FAULT_CASE=UNKNOWN`（见下方各档命令与日志首行过滤器），不存在拼写差异。
  - 零命中：前置停采结果在任何断言/读回前登记；本轮 0 行不写恢复 UPDATE，不认领他人状态；
    连接状态独立读回，只有 YES 才按现有受保护收尾普通 release；**读回 NO 或无法确认时先置位
    套件级拦截，再销毁本轮两个独占连接，禁止普通 release；销毁失败也不解除拦截、不退回普通释放**。
    不为让同进程其他反例继续执行而放宽拦截。
  - UNKNOWN：未登记恢复责任不再等同于可回池；独立读回只有 YES 才普通 release，NO 或读回失败
    一律置位拦截并销毁；执行者明确收到 1 行时按登记事实恢复并读回。
  - ASSERT-AFTER：原断言、恢复与销毁错误分别保留，多错误以 `AggregateError` 首行同时给出
    `原断言=`、`恢复=`、`销毁=` 具体原因；恢复抛错或读回未确认时外层不再普通 release。
  - 同专项同模式：`INSTRUMENT 仅停采测试连接` 改为仅“明确 applied 且恢复无错”才 release，
    0 行/未知/恢复失败一律销毁并置位拦截；未扩大修改范围。
- 离线替身（`/tmp/v13-recheck-thread.cjs`，及仅调整命中行数的 `-zero-applied` 变体）逐条断言，退出码均 0：
  - `zero`：`restores=0`、`DESTROY×2`、无 `POOL_RELEASE`、`blocked=true`。
  - `zero-applied`（前置命中 1 行、本轮命中 0 行）：`STOP`、`restores=0`、`DESTROY×2`、无 `POOL_RELEASE`、`blocked=true`。
  - `lost`（UNKNOWN 回执丢失）：`restores=0`、`DESTROY`、无 `POOL_RELEASE`、`blocked=true`。
  - `restore`（ASSERT-AFTER 主断言失败且恢复抛错）：首行同时含
    `原断言=expect(received).toBe(expected) // Object.is equality` 与 `恢复=RESTORE_FAILED`；
    `DESTROY`、无 `POOL_RELEASE`、`blocked=true`。
  - `read` / `assert`（正常对照）：`RESTORE` 后读回 YES 才 `POOL_RELEASE YES`，`blocked=false`。
- 静态与离线回归：`npx tsc -p tsconfig.json --noEmit` 退出 0；该文件 `npx eslint` 0 error /
  9 warning（全为既有 `max-depth`，HEAD 基线 12 warning），退出 0；`npx jest
  src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts --runInBand` 4 passed /
  20 skipped，退出 0。
- 临时源码副本实库验证（`/tmp/v13-recheck-1794367212/backend`，该文件与工作区 SHA-256 一致
  `6e0575de…`；配置 `/tmp/v13-f1f3-1794364374/runner-test.env`，库 `v13_accept_test`，
  实例 `127.0.0.1:3307` / `32aab37e-dd78-11f1-a06e-00e0709ef3a9`）。
  分进程入口为副本内 `test/tmp-p54-filtered-run.ts`（复用正式入口的 `buildEnvironment` 与
  文件集合，仅追加 Jest `-t` 名称过滤；不入库），日志在 `evidence/p54-p*.log`：

  | 档 | 命令要点 | passed / failed / skipped | 退出码 | 结论 |
  | --- | --- | --- | --- | --- |
  | P1 零命中 + 同进程下一条注入用例 | `V13_SPEC_INJECTION_PROFILE=fault`、`V13_SPEC_INSTRUMENT_FAULT_CASE=UNKNOWN`、`-t 'INSTRUMENT 另一连接先停采\|INSTRUMENT 首次停采结果未知'` | 1 / 1 / 76（78） | 1 | 零命中用例通过；UNKNOWN 被 `beforeEach` 实际拦截，属预期失败，不计作通过 |
  | P2 UNKNOWN（独立进程） | 同上，`-t 'INSTRUMENT 首次停采结果未知'` | 1 / 0 / 77（78） | 0 | 通过；执行者恢复读回 YES 后普通释放 |
  | P3 ASSERT-AFTER（独立进程） | `V13_SPEC_INSTRUMENT_FAULT_CASE=ASSERT-AFTER`、`-t 'INSTRUMENT 首次停采成功后受控断言失败'` | 1 / 0 / 77（78） | 0 | 通过；恢复读回 YES 后普通释放 |
  | P4 正常对照（normal） | `V13_SPEC_INJECTION_PROFILE=normal`、`-t 'INSTRUMENT 仅停采测试连接'` | 1 / 0 / 77（78） | 0 | 通过；`original=YES injected=NO`，恢复读回 YES 后普通释放，未置位拦截 |
  | P5 默认交付档 | 无 `V13_SPEC_INJECTION_PROFILE`（默认 `none`）、正式入口 `npx ts-node test/run-v13-authoritative-spec.ts delivery`、无 `-t` | 68 / 0 / 10（78） | 0 | 通过；**默认交付档（未启用停采注入）**，不称为 normal 注入档 |

  - P1 证据原文：`未登记恢复责任：条件 UPDATE 命中 0 行，本轮未成功写入，不恢复也不认领他人状态；前置停采=applied`；
    `保留第三连接停采状态：thread_id=51 connection_id=15 instrumented=NO`；
    `目标线程未确认恢复：instrumented=NO；先置位拦截再销毁本轮独占连接`；
    `独占连接销毁完成（未普通回池）：S4-E 被测停采连接、S4-E 前置停采连接；套件级拦截=true；恢复计划=keep，恢复 UPDATE 0 次`；
    随后同一进程选中的 UNKNOWN 用例在 `beforeEach` 处失败：
    `线程采集状态未确认：已停止本实例上的后续测试及故障注入，等待执行者处置`
    （`e2e-scoped-cleanup.v13.realdb.spec.ts:1565`）。
  - P2 证据原文：`受控未知结果：首次停采结果未知：thread_id=55 connection_id=19 user=v13_test…`；
    `未知结果保留现场：…；instrumented=NO`；无“执行者恢复失败”输出，未置位拦截。
  - P3 证据原文：`断言失败后恢复计划：本轮条件 UPDATE 明确命中 1 行，按登记事实恢复`；未置位拦截。
  - P4 证据原文：`thread_id=61 connection_id=25 original=YES injected=NO`；未置位拦截。
- 连接事件（进程退出后由独立连接核对 `performance_schema.threads`）：
  - P1 的 `thread_id=51`（connection 15）与同轮第二独占连接属销毁档，退出后无记录，记录为“线程消失”，
    不写成“恢复为 YES”。
  - P2 `thread_id=55`（connection 19）、P4 `thread_id=61`（connection 25）在进程内读回 YES 后才普通释放；
    退出后同样无记录，记录为“线程消失”，不据此宣称“恢复为 YES”。
  - 核对时实例当前最大 `THREAD_ID=75`，上述线程号未被复用；无 `INSTRUMENTED='NO'` 的活动线程，
    无本账号活动事务。
- 作废运行：一次 `delivery` conflict profile 跑在遗留库 `v13_accept` 上，为“套件级拦截”最终调整前的
  中间版本，且库名不含 test/dev/local/drill 被 D3 守卫拒绝（1 failed / 75 passed / 2 skipped，退出 1），
  另有同库遗留数据导致 R04/R06/R09 失败；另有一次旧版外部脚本用 `ts-node register` 载入入口时
  编译失败（`TS5011`），未执行任何用例。两者均不作为本轮验收结论，已被上面的分进程运行取代。
- 本轮未 commit、未 push、未回复 PR、未合并；未重跑完整单测、接口、真实登录、前端、Redis、Worker
  或完整业务 core。

## 未关闭与不适用项

- `npm run check:entity-scope` 退出码 1（旧 PR3 entity-scope 按既有裁决记不适用；未改政策骗绿）。
- 未验证：任意真实旧库、真实登录/前端/Redis/Worker/完整业务 core（不在本期范围）。
- 未 push、未回复 PR、未合并。
