# S3 正式部署工具 SOP

> 适用范围：`backend` 的 `database:deploy`（`--mode=init` / `--mode=upgrade`）。
> 工具负责结构与迁移复核；仅在显式文件与确认口令下初始化组织、管理员和开发样例账号。
> 不创建数据库、不创建 MySQL 账号、不授予系统权限、不启动 API/Worker、不导入工单/报告等演示业务数据。

## 1. 前置环境

- Node.js 与仓库锁定版本一致；已安装 backend 依赖。
- 目标 MySQL 8.0 已由 DBA 创建，字符集 `utf8mb4`，时区与 `DB_TIMEZONE` 一致。
- 迁移账号只授予目标库所需权限，不复用管理员账号。
- 迁移与备份窗口已确认；API/Worker 已按运维流程停写或进入维护模式。
- 已准备仓库之外的环境文件与（可选）管理员映射文件，权限 `0600`。
- 存量库若已具备 `repair_request` 旧行，必须准备库外历史身份清单
  `V13_LEGACY_REPAIR_REQUEST_MANIFEST` 指定的 JSON（见 4.4）。清单含真实主键与行指纹，
  **不得提交 Git**；Git 只保存格式说明、校验工具与合成样例。

## 2. 权限清单

迁移账号至少需要：

- `SELECT`、`INSERT`、`UPDATE`、`DELETE`（迁移历史表与回填）
- `CREATE`、`ALTER`、`DROP`（仅限本次结构变更需要的对象；工具不会清库）
- `INDEX`、`REFERENCES`
- `CREATE TEMPORARY TABLES`（如目标结构校验使用临时表）
- 对目标库执行 `GET_LOCK` / `RELEASE_LOCK` 的连接权限（普通连接即可）

不得授予全局 `FILE`、`SUPER`、`GRANT OPTION`，也不得使用 `--force` 类绕过。

### 2.1 专项观测权限（与部署权限分开）

- 上节是**部署/迁移权限**，不包含、也不自动附带专项观测权限。
- 真实 MySQL 并发验收需要观察其他会话的锁等待，使用 `PROCESS`（读取
  `information_schema.processlist`）与 `performance_schema.data_lock_waits` 的 `SELECT` 权限。
- `S4-E` 清理验收不读取 `information_schema.innodb_trx`（该表需要全局 `PROCESS`），
  改用 `performance_schema.events_transactions_current` 的**当前用户/当前连接**视图，
  只需要 `performance_schema` 的 `SELECT`，不需要全局 `PROCESS`。
- **实际连接必须自身开启采集**：权限齐全、全局 consumer/instrument 为 `YES`，都不能保证
  参与造数/事务/收尾的某条池连接仍可观测。预检与收尾计数必须核验实际目标线程的
  `performance_schema.threads.INSTRUMENTED=YES`，并在计数前再次核验；不能只验证一次临时
  预检连接就假定后续池连接具备采集能力。
- **不可观测时不得报告零事务**：线程停采、线程消失、状态缺失、查询异常或存在其他停采的
  当前用户前台线程时，规格必须报“事务观测不可用（不可观测）”并失败关闭，不能把未知状态
  当作 `0` 个活动事务，也不能自动开启全局/线程采集或扩权。
- **字节事实冲突时保留行并报错**：恢复条件必须与登记事实字节精确（文本使用
  `CAST(column AS BINARY) = CAST(? AS BINARY)`，不依赖 `utf8mb4_0900_ai_ci` 普通等号）；
  条件更新未命中不能视为恢复成功。发现另一连接改写时，不覆盖、不删除该行，跳过随后通用
  清理，报告可定位行 ID 与冲突原因；不得强删制造“零残留”。冲突行如确需回收，只能由独立
  测试执行者凭原始创建账本与精确字节事实处理，且先保存行被保留的直接证据。
- 上述权限只由 DBA 在**另行明确授权的专用实例/专用账号**上授予并记录，不属于部署授权；
  禁止为了跑通验收而给部署账号补授 `PROCESS`，也不得修改 `mysql` 系统权限表。
- 缺少观测能力时，规格必须在任何夹具写入之前失败关闭（零造数），由维护者申请专项授权后重跑；
  不得降级为固定 `sleep`、仅看最终计数或跳过观测断言。
- `E2E_V13_CONTROLLED_FAULT=1` 是默认关闭的受控实库故障注入开关，只允许在专项授权窗口中
  针对专用库开启，用于验证“创建/修改后断言失败仍精确回收”；不得在共享库或常规回归中开启。
- `E2E_V13_INSTRUMENT_INJECTION=1`（线程停采反例）与 `E2E_V13_SECOND_CONNECTION=1`
  （R02 第二连接干扰反例）同样默认关闭，只在另行授权的专用库与专用测试连接上开启；
  所需权限单独列清（见 2.2），不得使用 root 或修改全局采集开关。
- 线程停采反例的恢复责任只由首次条件 `UPDATE` 明确命中 1 行的执行方登记；命中 0 行或结果未知时保持现状，
  不得按线程标识认领他人 `NO` 状态。登记发生在断言之前，后续断言失败仍由该执行方在 `finally` 恢复并读回确认。
- `FAULT-UPDATE` 的恢复冲突由用例自身的受控外部连接改写 `local_backup_run.finished_at` 制造，
  不依赖 `E2E_V13_SECOND_CONNECTION`；冲突在恢复阶段实际发生处立即登记套件级保留，
  用例、通用清理与 `afterAll` 统一读取该保留事实。

### 2.2 线程停采与第二连接反例的权限清单（需另行授权）

- 线程停采注入（`E2E_V13_INSTRUMENT_INJECTION=1`）：
  - `SELECT` on `performance_schema.threads`、`performance_schema.events_transactions_current`、
    `performance_schema.setup_consumers`、`performance_schema.setup_instruments`；
  - `UPDATE` on `performance_schema.threads`（仅用于把**明确授权的测试连接**线程置为
    `INSTRUMENTED=NO`，再用 `finally` 恢复；不修改全局 consumer/instrument，不改其他线程）。
  - `performance_schema.threads` 无法按行授权，因此注入工具必须在 `UPDATE` 前核验本轮连接的
    `CONNECTION_ID`、`THREAD_ID`、`PROCESSLIST_USER`、`TYPE=FOREGROUND` 与原 `INSTRUMENTED=YES`；
    实际写入使用同时包含这些事实的条件 `UPDATE`，`affectedRows` 必须为 1，任一事实不符即拒绝。
    恢复使用同样的条件精确命中并读回确认；未确认、线程消失或恢复失败时保留错误并停止后续写入。
    不得按用户名批量更新，也不得用一次临时预检连接代替实际测试连接。
  - 最小授权示例（需另行批准，行级授权不可用）：
    `GRANT UPDATE ON performance_schema.threads TO '<专用测试账号>'@'<授权来源>';`
  - 若目标 MySQL 版本要求更新他人会话线程行还需额外管理权限，则该权限也须单独授权；
    不得以 root 或全局 `SUPER` 代替。
  - 低权限配置若缺 `FIELD_ENCRYPTION_KEY/IV`，交付组中的约束验收规格会在造数前失败关闭；
    应申请专用低权限配置补齐这两项，不得改用高权限部署配置冒充低权限证据。
- 第二连接干扰（`E2E_V13_SECOND_CONNECTION=1` +
  `E2E_V13_CONTROLLED_FAULT=1` + `E2E_V13_CONTROLLED_FAULT_CASE=R02-CONFLICT`）：
  - 目标库 `stored_file` 的 `SELECT` / `UPDATE` / `DELETE`（第二受控连接提交仅大小写变化）；
  - 被测清理器使用同一授权账号执行精确恢复；冲突行回收由独立执行者按
    `file_id` 与 `CAST(original_filename AS BINARY)` 精确匹配处理。
  - 不得操作审查方现场、共享库、Redis 或原事故数据；不重建整套数据库、不新增迁移。
- `FAULT-UPDATE` 恢复冲突（`E2E_V13_CONTROLLED_FAULT=1` + `E2E_V13_CONTROLLED_FAULT_CASE=FAULT-UPDATE`）：
  - `local_backup_run` 的 `SELECT` / `UPDATE`；受控外部连接只改写 `finished_at`，不改其他列；
  - 恢复按本轮写入值做字节精确 CAS；命中 0 行即登记套件级保留，不覆盖外部值、不反向删除保留行；
    保留行的父安装种子属既有基线，不得为追求零残留而删除。

## 3. 配置位置

- 已知部署角色与运行期账号由运维另行创建。
- 环境文件模板：[database-deploy.env.example](database-deploy.env.example)。真实文件放在仓库外。
- 组织映射模板：[organization-bootstrap.example.json](organization-bootstrap.example.json)。
- 管理员映射模板：[admin-bootstrap.example.json](admin-bootstrap.example.json)（默认 6 个：1 级 3 个、2 级 3 个）。
- 开发样例账号模板：[dev-accounts.example.json](dev-accounts.example.json)（默认客户 2 个、工程师 2 个，数量可增减）。
- 上述 JSON 均含 `REPLACE_` 占位符，直接使用会因密码策略/必填校验失败；真实清单由上线负责人提供且不入库。
- 环境变量键固定为 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASS`、`DB_NAME`、`DB_TIMEZONE`、`DB_SYNCHRONIZE=false`。
- 初始化账号还需要 `FIELD_ENCRYPTION_KEY` 与 `FIELD_ENCRYPTION_IV`（16 字符），用于写入并校验 `meta_digest`；缺失时交付失败关闭。
- 权威规格 runner 的配置文件只接受上述显式列举的连接字段与两项加密配置；不接受其他 `DB_*`、
  任意大写变量，也不接受 `V13_*`/`E2E_*`/`D3_*`/`NODE_ENV` 等控制变量。目标库、实例 UUID、白名单、
  组别与清理许可只由入口显式确认，配置夹带时在执行前拒绝。

## 4. 正式命令

在 `backend/` 目录执行。

### 4.1 首次初始化（空库）

```bash
cd backend
npm run database:deploy -- \
  --mode=init \
  --config-file=/secure/path/lithography-deploy.env \
  --database=lithography_v13 \
  --confirm-database=lithography_v13
```

- 目标库必须已存在且为空（无业务表）。工具不会创建数据库。
- 工具会检查实际连接目标、获取互斥锁、执行全部迁移、复核终态。
- 如果库已完整迁移且终态校验通过，命令返回「无变化」。

### 4.2 空库初始化并显式初始化组织、管理员与开发样例

三个映射文件与三个确认口令都在**同一条命令**中生效，顺序固定为组织 → 管理员 → 开发样例，
并共用一个数据事务：任一账号失败时组织与账号都不会留下半成品。省略某个文件则该类数据不初始化。

```bash
npm run database:deploy -- \
  --mode=init \
  --config-file=/secure/path/lithography-deploy.env \
  --database=lithography_v13_dev \
  --confirm-database=lithography_v13_dev \
  --organization-bootstrap-file=/secure/path/organizations.json \
  --confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP \
  --admin-bootstrap-file=/secure/path/admin-bootstrap.json \
  --confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP \
  --dev-accounts-file=/secure/path/dev-accounts.json \
  --confirm-dev-accounts=APPLY-DEV-ACCOUNTS
```

正式环境通常**不带** `--dev-accounts-file` 与 `--confirm-dev-accounts`；开发样例默认关闭。

#### 4.2.1 已验证命令（D3，2026-11-09）

以下命令在授权实例 `909f9587-9fce-11f1-a353-00e0709ef3a9` 的空库
`lithography_v13_delivery_dev` 上实际执行，退出码 0：41 条迁移、终态 verify 通过、
1 级管理员 3 个、2 级管理员 3 个，未创建客户／工程师。

```bash
cd backend
npm run database:deploy -- \
  --mode=init \
  --config-file=/secure/path/lithography-deploy.env \
  --database=lithography_v13_delivery_dev \
  --confirm-database=lithography_v13_delivery_dev \
  --organization-bootstrap-file=/secure/path/organizations.json \
  --confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP \
  --admin-bootstrap-file=/secure/path/admin-bootstrap.json \
  --confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP
```

需要开发样例时，在同一条命令追加
`--dev-accounts-file=/secure/path/dev-accounts.json --confirm-dev-accounts=APPLY-DEV-ACCOUNTS`；
目标库名必须含 `test/dev/local/drill`。实测客户 2、工程师 2，`must_change_password=0`。
重复执行同一条命令返回 `UNCHANGED`，不重置密码、不重复成员关系；更换映射密码重跑也不会重置既有密码。
验收证据与结构清单见 [S2 §3.2](https://github.com/GandianTX/lithography-platform/blob/de742a59700450b42a951b64f0a41cddb12d294c/backend/plans/database-v13-deploy/S2-db-verification-specs.md)。

#### 4.2.2 组织映射

- `organization_code` 是稳定业务键；不存在才创建；
- 已存在时只核对 `kind`、`is_managed_company`、`is_service_provider`，不一致失败关闭，不改名、不接管；
- 编码相同但名称/简称不同：不覆盖既有名称，输出告警要求人工核对差异；
- 仅接受 `status=ACTIVE`；1 级管理员只能绑定 `CLIENT` 公司，2 级管理员只能绑定 `is_managed_company=true` 的受管公司；
- 公司编码、名称与归属必须由上线负责人提供，工具不猜测。

#### 4.2.2 管理员映射

- 默认交付口径：1 级 3 个、2 级 3 个（模板即 3+3）；具体账号、公司与凭据由受控配置决定；
- 初始密码必须通过项目密码策略（与登录/注册同一 `PasswordPolicyService`）；真实密码只在库外受限配置，不打印；
- 新账号写入 ACTIVE 账号、ACTIVE 资料、SUPER_ADMIN 三源角色事实与 ACTIVE 组织成员关系，并标记必须修改初始密码；
- 账号已存在时绝不重置密码；已有等级/公司归属不被覆盖；与映射不一致时失败关闭；
- 公司编码不存在时失败关闭，不猜测公司。

#### 4.2.3 开发样例账号（显式、默认关闭）

- 仅当同时提供 `--dev-accounts-file` 与 `--confirm-dev-accounts=APPLY-DEV-ACCOUNTS` 才写入；
- 目标库名必须包含 `test`、`dev`、`local` 或 `drill` 之一，否则在连接与写入前拒绝；
- 默认模板为客户 2 个、工程师 2 个；数组长度可调整，但配置中不得出现重复账号/邮箱；
- 客户：ACTIVE CUSTOMER 三源角色事实、ACTIVE 资料、`customer_organization_id` 指向配置公司、
  ACTIVE CUSTOMER 组织成员关系；
- 工程师：ACTIVE ENGINEER 三源角色事实、ACTIVE 资料、ACTIVE ENGINEER 组织成员关系；
  不写注册/审批历史，不生成工单、报告、文件等业务样例；
- 密码同样必须符合项目密码策略；已存在账号绝不重置密码、不覆盖等级/公司/角色；
  事实不完整（缺资料、缺 ACTIVE 成员关系、角色不一致、带管理员等级等）一律失败关闭。

### 4.3 升级（存量库）

```bash
npm run database:deploy -- \
  --mode=upgrade \
  --config-file=/secure/path/lithography-deploy.env \
  --database=lithography_v13 \
  --confirm-database=lithography_v13
```

- 只运行 pending；不清库、不调用 drill、不伪造历史。
- 无 pending 时做终态校验并返回「无变化」。
- `upgrade` 拒绝管理员初始化参数。
- **真实存量升级尚未承诺**：本轮承诺的是空库 init 与受控/合成库的升级演练；
  生产存量库的升级窗口、备份、历史事实确认与回退方案必须另行评审和书面授权，
  不能因离线测试或合成库通过而视为已承诺或已验收。
- 旧行回填迁移（以文件名为准）：
  - `1775501700000-add-record-package-check-and-import-result-states-for-v13.migration.ts`
    在任何 `ALTER` 前先扫描历史行：JSON 缺键/JSON null、非法枚举、非法检查/导入组合、
    失败无原因、计数越界会直接失败关闭并输出定位 ID；此时**未执行任何 ALTER**，
    按定位 ID 人工确认后重跑。
  - 对历史行回填 `PASSED` 属“需求前提驱动的迁移假设”。正式部署若存在受影响历史行，
    **必须先导出冻结清单并取得业务/审计确认**；合成库或测试库的验收结果不能替代历史事实确认。
    当前工具不提供冻结清单导出入口（G-11），由 DBA/只读 SQL 导出并附变更单。
  - 该迁移跨表执行多条 `ALTER`，MySQL DDL 隐式提交**不能整体回滚**；失败信息会列出已完成步骤，
    已存在的列/约束在重跑时跳过。修复后直接重跑 `upgrade` 即可续跑，不要手工删迁移历史。

### 4.4 历史工单身份清单（31 态旧库 / 旧版增量已执行库）

`1775501100000-alter-repair-ai-report-for-v13.migration.ts` 在收紧中断/无法修复原因约束前，
必须先把真实旧工单标记为历史行，否则合法的旧行会被新约束误拒。

```bash
npm run database:deploy -- \
  --mode=upgrade \
  --config-file=/secure/path/lithography-deploy.env \
  --database=lithography_v13 \
  --confirm-database=lithography_v13 \
  --legacy-repair-manifest=/secure/path/legacy-repair-identities.json
```

清单格式（合成样例见
[legacy-repair-identity-manifest.sample.json](legacy-repair-identity-manifest.sample.json)）：

- `formatVersion`: 固定 `1`；
- `source`: `V13_31_STATE`（31 态全量旧库）或 `V13_INCREMENTAL_EXECUTED`（旧版增量已执行库）；
- `frozenAt`: 冻结时间（ISO 8601）；
- `rows[]`: 每行 `{ id, fingerprint }`；
  `fingerprint = sha256(JSON.stringify([id, intakeId, handlingStatus, handlingResult]))`。

约束：

- 31 态路径要求清单与库内工单**数量一致且逐条指纹匹配**；
- 旧版增量路径允许库内出现清单之外的新行，但清单内 ID 必须存在且指纹一致；
- 禁止用 `intake_id IS NULL`、`revision_no = 0` 或时间猜测代替清单；
- 清单缺失、重复 ID、非法指纹、数量/指纹不一致时立即失败关闭；
- 工具只把清单内 ID 的 `is_historical` 置 1，不修改原因、不补造业务事实；
- `1775501900000-close-s5-structural-gaps-for-v13.migration.ts` 对缺失
  `is_historical` 的旧版增量库复用同一清单与同一校验；已有该列时跳过清单。

### 4.5 已执行旧版增量的补齐

若目标库已执行旧版 `1775501100000`～`1775501800000` 但尚未执行
`1775501900000-close-s5-structural-gaps-for-v13.migration.ts`：

- 直接运行 `upgrade`，由追加迁移补齐 F1—F5 结构；
- 该迁移在**任何 DDL 前**完成全部预检（同步回执四列重复组、
  历史身份清单、旧合法状态组合），预检失败时不做部分变更；
- 旧行**原地保留**：`sync_receipt`、`backup_asset`、`backup_restore_run`、
  `maintenance_report_fault` 不需要为空；新增事实列对历史行保持 NULL
  （历史未知），工具不猜测填充、不删除旧行、不迁移到归档表；
- 唯一会阻断升级的数据事实是 `sync_receipt` 同一
  `(organization_id, resource_type, record_uuid, version_no)` 出现重复组：
  工具只报告样本并停止，**不允许**自动合并、择一保留或删除；先由业务确认，
  再由有权限的人在工作库外处置后重试；
- 追加迁移只能修复前序迁移**成功执行后**的结构缺口；
  若前序迁移已经失败并不在迁移历史中，末尾追加迁移无法替代它，必须按第 9 节人工处置。

## 5. 执行前备份与停写

1. 停写 API/Worker 或切换维护模式，确认无新写入。
2. 生成全量备份并记录备份 ID/校验和；备份未验证前不执行结构变更。
3. 记录执行前 `SHOW CREATE TABLE`/迁移历史/行数基线。
4. 若库中有旧工单/记录包历史，先冻结升级前旧记录集合（见 OI-05、OI-15）：
   对 `repair_request` 导出 `{id, intakeId, handlingStatus, handlingResult}` 并计算指纹，
   形成 4.4 的库外清单，核对数量后取得业务/审计明确确认；确认前不得执行
   `1775501100000-alter-repair-ai-report-for-v13.migration.ts`。
   不要用 `intake_id IS NULL` 单独判定历史。

## 6. 执行后 verify

工具在结束前会执行：

- 实际目标核验；
- 迁移历史完整性；
- `REQUIRED_*` 结构契约（列类型/长度/符号/NULL/默认/生成表达式、
  索引唯一性与列序、外键列序与规则、CHECK 表达式）；
- 关键 `CHECK` 必须 `ENFORCED=YES`；`NOT ENFORCED` 与缺失一并通过失败关闭；
- `base_user_account.uk_login_name` 与 `uk_login_email` 等关键唯一索引必须存在；
- 预期之外的业务表在 pending 执行前和终态复核时都失败关闭，不静默忽略；
- 数据级校验（旧资料回填、归属待确认等）；
- pending 必须为 0。

结论口径：

- **结构完成**：上述契约与 pending=0 全部通过；
- **业务未实现**：结构存在但对应 API/Worker 行为尚未交付，不得以结构通过代替；
- **实库待验证**：离线测试/类型检查通过 ≠ 实库已验收，必须完成实库回归。

此外人工复核：

```sql
SELECT * FROM migrations ORDER BY id;
SHOW CREATE TABLE maintenance_report;
SHOW CREATE TABLE reference_document;
SELECT COUNT(*) FROM reference_document WHERE source_report_version_id IS NOT NULL
  GROUP BY source_report_version_id HAVING COUNT(*) > 1;
```

## 7. 重复执行

- 同一命令可重复执行：结构完整时返回「无变化」。
- 禁止通过重新发布、软删或下架释放报告来源版本唯一性。
- 禁止手工删除迁移历史记录来「重跑」。
- 组织映射重复执行只核对已有公司，不覆盖、不改名、不重复创建；名称差异只告警不写入。
- 管理员与开发样例映射重复执行返回 `UNCHANGED`，不重建账号、不重置密码、不覆盖等级和公司。
- 已有账号事实不完整或与映射冲突时失败关闭，而不是为了“幂等”静默接管。

## 8. 初始化数据上线前置

- 真实「公司 → 编码 → 类别/标记」清单、默认 6 个管理员（3 个 1 级、3 个 2 级）的
  「账号 → 等级 → 公司」清单必须在上线前完成评审，均放在库外受限配置。
- 未映射管理员在运行时失败关闭，不自动提升等级、不猜测公司。
- 开发样例账号默认关闭；只有验收/开发目标库才允许显式启用，数量由映射文件决定。
- 缺少真实映射不阻塞结构迁移；但上线必须完成组织与管理员映射。

## 9. 失败恢复

| 失败点                  | 处置                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 目标库/账号/权限错误    | 停止；修正环境文件或授权后重跑；不修改代码绕过                                                                                                                                             |
| 已获取锁超时            | 确认无其他部署/迁移进程；检查未释放锁；必要时由 DBA 清理会话                                                                                                                               |
| 非空库无历史            | 停止；确认是否选错库；不得用 init 覆盖                                                                                                                                                     |
| 未知对象/半迁移         | 停止；保存 `SHOW CREATE TABLE` 与迁移历史；用 `status` 查看 pending 与疑似半迁移对象；人工确认对象属于哪条迁移、是否可安全跳过后再动                                                       |
| DDL 部分失败            | 停止；保留失败点与已执行迁移；按失败文件名和错误中的“已完成步骤”核对列/约束存在性；修复后重跑 `upgrade` 续跑；禁止伪造历史或手工补记录                                                     |
| 旧版增量结构缺口        | 运行 `upgrade` 让 `1775501900000-close-s5-structural-gaps-for-v13.migration.ts` 补齐；若其预检因同步回执四列重复组失败，先按业务确认并在工作库外处置，工具不会自动合并、择一保留或删除旧行 |
| 前序迁移已失败          | 末尾追加迁移不能替代失败的前序迁移；必须人工恢复前序迁移的历史记录或按已提交 DDL 对齐后续跑条件，不得手工插入迁移历史                                                                      |
| 终态校验失败            | 停止；按输出逐项定位；未修复前不得启动 API/Worker                                                                                                                                          |
| 组织映射冲突            | 结构迁移已提交，但初始化数据事务整体回滚；按错误中的编码核对已有公司类别/标记，禁止手工改库“凑”配置；确认后重跑 init                                                                       |
| 管理员/开发样例映射失败 | 结构迁移已提交，但初始化数据事务整体回滚（组织与全部账号均未落库）；修正映射后重跑 init，结构将返回无变化并重新应用初始化                                                                  |
| 开发样例被拒绝          | 检查目标库名是否含 `test/dev/local/drill`、确认口令是否一致；这是防止样例进入正式库的安全门                                                                                                |

## 10. 工具明确不做

- 不创建数据库、不创建 MySQL/系统账号、不授予数据库权限；
- 默认不初始化组织、管理员或开发样例；只有显式文件与确认口令才执行；
- 不生成工单、报告、文件等业务样例数据，不写入注册/审批历史；
- 不启动或停止 API/Worker；
- 不安装 systemd/服务、不修改系统权限；
- 不导入演示业务数据；
- 不执行 `synchronize`、`drop`、`down()` 或清库；
- 不连接未显式指定的数据库；
- 不自动判定历史记录“已检查”，不代替业务确认冻结清单（G-11）；
- 不自动修复半迁移，不自动合并/删除同步回执重复组，不凭旧 `storage_reference` 猜测云端地址；
- 不承诺自动恢复；第 9 节均为人工处置条件。

## 11. 实库验收补充（2026-11-09）

### 11.1 旧候选字节历史的识别

- 表结构存在、但当前迁移字节要求的列/约束缺失时，`upgrade` 会在预检阶段 fail-closed 拒绝；
  这是**正确拒绝**，不得当作可跳过、不得手工补列/补约束、不得手工写迁移历史。
- 典型：`repair_request.is_historical` 由当前 `1775501100000` 补齐，但契约登记所有者为
  `1775501900000`；旧库若 1100000 由更早字节执行，40 态预检不会要求该列，
  1900000 重建闭单约束时会因缺列失败。
- 处置：停止并保留现场；记录“已提交 DDL + 实际历史 + 缺失对象”；由维护者决定是否修复
  1900000 对缺列的兼容。修复待执行迁移后必须重新冻结，并通过受影响的升级专项与新的完整 core。

### 11.2 隐藏与阻塞 CHECK 的重建顺序

- 重建 CHECK 采用“先 DROP 再 ADD”，MySQL DDL 非事务；ADD 失败会留下**约束已删除**的半迁移。
- 出现该现场时：不得手工 ADD 约束、不得回退历史；以 `SHOW CREATE TABLE` 与迁移“已完成步骤”
  核对，交由维护者按 11.1 处理。

### 11.3 实库规格的运行口径

实库规格统一通过专用入口运行，不得直接调用 `npx jest`：

```
cd backend
V13_AUTHORITATIVE_SPECS=1 \
V13_SPEC_TARGET_DB=<目标库> \
V13_SPEC_SERVER_UUID=<uuid> \
V13_SPEC_CONFIG_FILE=<0600 的库配置> \
E2E_ALLOW_PHYSICAL_CLEANUP=1 \
npx ts-node -P tsconfig.spec.json -r tsconfig-paths/register \
  test/run-v13-authoritative-spec.ts <delivery|upgrade>
```

- 专用配置 [jest-v13-authoritative.config.js](../../../backend/test/jest-v13-authoritative.config.js) 不注册
  `globalSetup` / `globalTeardown`，不连接默认库、不全库清理、不操作 Redis，也不回退
  `.env.e2e` / `.env.development`；缺少 `V13_AUTHORITATIVE_SPECS=1` 时拒绝加载。
- 入口先以完全相同的配置、环境和 `--runTestsByPath` 路径运行 `--listTests`，
  将实际文件集合与固定清单逐项比较；缺失或多出任何文件都在执行前失败关闭。
- 配置文件必须是 `0600`、所在目录 `0700`，且 `DB_NAME` 必须等于 `V13_SPEC_TARGET_DB`；
  `DB_*` 只来自该文件，不接受外部多目标白名单。
- 规格自身在建立连接前检查显式开关、专用配置与单目标白名单；连接后核验
  `DATABASE()` 与 `@@server_uuid`。第 43 条升级规格在自身连接上同时核验两者。
- 只核对文件集合时追加 `V13_SPEC_LIST_ONLY=1`；此模式不建立任何数据库连接。
- 上游 consumer 与线程停采注入口径：`V13_SPEC_INJECTION_PROFILE=none|normal|conflict|fault` 必须同时设置
  `V13_SPEC_ISOLATED_INSTANCE=1`；入口在建立连接前要求 `DB_HOST` 为回环且 `DB_PORT != 3306`。
  normal 启用 P1/P2 注入；conflict 追加 `R02-CONFLICT,FAULT-UPDATE` 受控故障与第二连接；
  fault 只启用 `FAULT-UPDATE`，并明确不设置 `E2E_V13_SECOND_CONNECTION`，可通过
  `V13_SPEC_INSTRUMENT_FAULT_CASE=UNKNOWN|ASSERT-AFTER` 追加停采收尾验收。

- 规格不得硬编码由 `UUID()` 生成的种子值（如 `local_installation.installation_id`），应读取目标库真值；
- 迁移条数等基线常量应随候选冻结更新，避免把候选演进口径当成漂移。

### 11.4 核心 E2E 的 KEEP 前置

- 必须显式保持 `E2E_SKIP_DB_CLEANUP=true`、`E2E_ALLOW_DB_CLEANUP=0`、
  `E2E_ALLOW_PHYSICAL_CLEANUP=1`、`E2E_ALLOWED_DB_NAMES=lithography_e2e`；
- Redis 使用本轮独占实例（空闲端口 + mktemp 目录，仅绑 `127.0.0.1`），不使用共享 6379；
- 先确认目标库独占、UUID 正确、基线迁移与数据快照已保存，再插入 KEEP 并登记独立账本；
- 升级被预检拒绝时不得进入 core，不得以清库/重建替代。

### 11.5 本轮实测命令（2026-11-10，第 46 轮历史现场）

> 本节记录第 46 轮在 3306 交付库的历史命令；当前隔离实例口径以 11.9 为准。

前置（缺一不可）：

- MySQL 8.0.46，`127.0.0.1:3306`，`@@server_uuid` 与授权值一致；工具不安装 MySQL、不建账号、不改系统权限表。
- 两个库由本轮在**确认不存在后**创建为空库，`utf8mb4 / utf8mb4_0900_ai_ci`；已存在则停止，不覆盖、不复用。
- 环境文件、组织/管理员/开发样例映射均放在仓库外，文件 `0600`、目录 `0700`；不打印密码或哈希。
- 开发样例仅在目标库名含 `test/dev/local/drill` 且显式提供文件与确认口令时写入；正式库不带该选项。

交付库（空库，一条命令完成结构 + 组织 + 6 管理员 + 2 客户 + 2 工程师）：

```bash
cd backend
npm run database:deploy -- --mode=init \
  --config-file=<0600 库配置> --database=<交付库> --confirm-database=<交付库> \
  --organization-bootstrap-file=<组织映射> \
  --confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP \
  --admin-bootstrap-file=<管理员映射> \
  --confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP \
  --dev-accounts-file=<开发样例映射> \
  --confirm-dev-accounts=APPLY-DEV-ACCOUNTS
npm run migration:verify -- --config-file=<0600 库配置> --database=<交付库>
```

- 原命令重跑：0 条迁移、全部 `UNCHANGED`，密码哈希、角色、等级与归属不变。
- 去掉 `--dev-accounts-file` 与 `--confirm-dev-accounts` 再跑：不新增、不删除开发账号。
- 验收口径（本轮终态）：44 条迁移、51 张业务表（含 `migrations` 共 52 张）、按映射创建的组织数（本轮为 1 个合成公司）、
  10 个账号、10 条成员关系；3 个一级管理员与 3 个二级管理员、2 个客户、2 个工程师。

当前 44 态升级（使用仓库当前迁移，执行目录 `backend`）：

```bash
npm run database:deploy -- --mode=upgrade \
  --config-file=<0600 库配置> --database=<升级库> --confirm-database=<升级库>
npm run migration:verify -- --config-file=<0600 库配置> --database=<升级库>
```

- 43→44 专项：第 44 条在**任何 ALTER 之前**校验 `previous_version IS NULL` 与 `previous_version >= revision_no`；
  合法行（0=首版、后续=实际基版本）保留并收紧为 NOT NULL；存在 NULL 或非法版本序时失败关闭，
  只输出脱敏计数与有限定位 ID，不自动回填、不删除历史行。
- 再次 upgrade 必须为 0 条且终态校验通过；终态为第 44 条。

冻结 43 态历史路径（只用于追溯 42→43 证据，不得与上面的 44 态命令混用）：

- 候选：库外冻结的 43 条候选（聚合指纹 `94fc2845…3643`），仓库当前迁移中不含该候选；不得用仓库 44 条迁移替代，
  也不得用该路径结果为当前 44 态背书。
- 执行目录：`backend`；历史库例：`lithography_rq1_42`（42 态起点的专用库）。
- 仅在还原库外冻结候选后执行，且仍需该库的单独授权：

```bash
V13_AUTHORITATIVE_SPECS=1 V13_SPEC_TARGET_DB=<42 态起点库> \
V13_SPEC_SERVER_UUID=<uuid> V13_SPEC_CONFIG_FILE=<0600 库配置> \
E2E_ALLOW_PHYSICAL_CLEANUP=1 \
npx ts-node -r tsconfig-paths/register test/run-v13-authoritative-spec.ts upgrade
npm run migration:verify -- --config-file=<0600 库配置> --database=<42 态起点库>
```

- 历史结论（仅对应冻结 43 态）：旧行 `previous_version` 保持 NULL、其他旧字段不变；0→1、1→2 合法。

### 11.6 `previous_version` 已批准裁决与落实边界

- 已获用户批准的最终裁决：`previous_version` 最终 **NOT NULL、无默认值**；首次修订写 0，后续写实际基版本；
  保留 `previous_version < revision_no` 顺序守卫；旧行无法证明取值时拒绝升级，不猜测回填、不删除。
- 第 44 条落实情况：先校验再收紧，违规零 ALTER；`down` 只回退可空性，不伪造或删除版本值。
- 仍不得宣称任意真实旧库已验证：本轮只对明确起点、明确来源的专用库验证；
  生产存量库若存在 NULL 历史行，必须先由业务/审计确认处置，不能因本轮专用库通过而视为已承诺。
- 任何文档、提交或验收记录都只陈述本轮起点、来源、保留内容与拒绝条件，不代替批准。

### 11.6.1 事务观测能力边界（RQ6）

- 精确清理的默认前置只读取 `performance_schema.events_transactions_current` 与 `PS_CURRENT_THREAD_ID()`，
  **不读取** `information_schema.innodb_trx`，也不把全局 `PROCESS` 作为默认前置。
- 授权账号 `gandiantx@127.0.0.1` 在本轮之前即持有 `PROCESS`（非本轮授予）。本轮**未授予、未回收、未修改**任何权限，
  因此不在该账号上演示“无 `PROCESS`”的真实条件；无权限/未启用采集/不可观测返回空的分支由离线能力用例覆盖，
  不以空结果冒充“无活动事务”。
- `assertTransactionObservationCapability` 必须先确认 `@@performance_schema=1`，且
  `global_instrumentation`、`thread_instrumentation`、`events_transactions_current` 三个 consumer
  与 `transaction` instrument 全部启用，才允许进入造数；任一上游开关关闭或不可确认时明确拒绝，
  绝不返回“零事务”。
- 停采恢复只认本轮条件 `UPDATE` 命中 1 行：命中才登记恢复责任并在收尾执行；
  0 行表示他人已停采，保持其 `NO`、保留现场并诊断，不做反向恢复。

### 11.7 历史失败与事故记录保留

- §11.1、§11.2 记录的旧候选字节识别失败、隐藏/阻塞 CHECK 重建半迁移等现场与处置口径继续保留；
- 本轮及后续修复只追加新记录，不删除、不改写既有失败与事故记录，也不把未复验的旧结论标为已通过。

### 11.8 第 4 项 RQ 收口实测（2026-11-10，第 48 轮历史现场）

> 本节 UUID、计数与保留 ID 均为第 48 轮历史事实；当前最终候选见 11.9。

- 实例：`/tmp` 下独立 `mysqld`，`127.0.0.1:3307`，MySQL 8.0.46，
  `@@server_uuid=7e75b5a6-dd06-11f1-808d-00e0709ef3a9`，`performance_schema=ON`，`--default-time-zone=+08:00`；
  未停止、未修改承载其他开发库的 3306 实例，未改系统权限表。
- 目标库：空库 `lithography_v13_test`（含开发标记，供 D3 开发账号守卫使用），
  `database:deploy --mode=init` 结果 44 条迁移 / 51 张业务表，退出码 0；执行前 17 张清理表均为 0。
- 正常档（`V13_SPEC_INJECTION_PROFILE=normal V13_SPEC_ISOLATED_INSTANCE=1`）：
  `3 suites passed / 72 passed / 3 skipped`，退出码 0；覆盖上游 consumer 分别关闭时拒绝并恢复、
  真实活动事务计数 1 与回滚归零、第二连接先停采时零命中保持 `NO`。
- 冲突档（`V13_SPEC_INJECTION_PROFILE=conflict`，注入 `R02-CONFLICT,FAULT-UPDATE` 与第二连接）：
  `75 passed / 0 skipped`，退出码 0。
- Jest 退出后独立连接复核：保留冲突文件 `file_id=26eed0a0-588e-42dd-b2fd-18e73f29fbce`
  （字节值 `S4E-R02-WRITTEN-MWAPGBGY9C833E02.TXT`，uploader=9904992、owner_organization=21）；
  保留冲突备份 `local_backup_run id=5`（`SUCCEEDED`、`finished_at=2001-02-03 04:05:06.007`，
  `installation_id` 指向唯一安装种子）；账号、组织、安装引用均在。
- 快照：44 条迁移、`organization id=1` 与安装种子不变、触发器 0；17 张清理表中仅 `stored_file=1`
  （按设计保留），其余 16 张为 0；`local_backup_run=1`（按设计保留）。
  该保留现场不是零残留，处置前不得将同库用于零残留组验收，也不得为制造通过删除保留行。
- 静态与构建：`typecheck`、变更文件 ESLint/Prettier、`npm run build` 退出码 0；
  `test:unit` 为 `8 skipped suites / 159 passed`、`202 skipped / 1889 passed / 2091 total`，退出码 0。

### 11.9 第 50 轮最终候选实库验收（2026-11-10，当前口径）

- 实例：新建 `/tmp/v13-isolated-20261110T140903Z`（0700），仅 `127.0.0.1:3307`，全新 datadir/socket/pid/日志，
  启动前确认 3307 空闲；`@@server_uuid=490feee1-dd10-11f1-9b49-00e0709ef3a9`；未使用 3306、Redis 或他人进程。
- 初始化管理员只创建 `litho_v13_test` 专用账号并授予目标库、观测 SELECT、`threads.INSTRUMENTED` 与
  `setup_consumers.ENABLED` 权限；专项不使用 root。空库执行一次
  `database:deploy --mode=init` 得到 44 条迁移、51 张业务表，`migration:verify` 与种子核验退出码 0。
- 当前命令模板（五种入口共用，`--listTests` 先机器校验 3 文件集合）：

```bash
cd backend
V13_AUTHORITATIVE_SPECS=1 \
V13_SPEC_CONFIG_FILE=<0600 库配置> \
V13_SPEC_TARGET_DB=lithography_v13_test \
V13_SPEC_SERVER_UUID=<实际 @@server_uuid> \
E2E_ALLOW_PHYSICAL_CLEANUP=1 \
V13_SPEC_ISOLATED_INSTANCE=1 \
V13_SPEC_INJECTION_PROFILE=<normal|fault|conflict> \
[V13_SPEC_INSTRUMENT_FAULT_CASE=<UNKNOWN|ASSERT-AFTER>] \
npx ts-node -P tsconfig.spec.json -r tsconfig-paths/register \
  test/run-v13-authoritative-spec.ts delivery
```

- 结果：normal `72 passed / 6 skipped`；fault（不设置 `E2E_V13_SECOND_CONNECTION`）`75 passed / 3 skipped`；
  fault-UNKNOWN 与 fault-ASSERT-AFTER 各 `76 passed / 2 skipped`；conflict 及 R09 `76 passed / 2 skipped`；
  五次均为 3 suites passed、退出码 0。
- 进程退出后独立 mysql 连接复核：`local_backup_run id=5/9/13/17` 仍在，
  `finished_at=2001-02-03 04:05:06.007` 保留，`installation_id` 引用存在，本账号 active transaction=0；
  冲突文件 `file_id=4a467f73-1efe-47c1-a382-945c1ea03a5f`（uploader=9905052、owner_organization=81、`STAGING`）
  保留；17 张清理表中仅 `stored_file=1`，其余 16 张为 0。该现场不是零残留，不得用于零残留档验收或删除保留行制造通过。
- 统计与构建：`test:unit` `205 skipped / 1895 passed / 2100 total`、`0 failed / 0 todo`，退出码 0；
  `npm run build` 退出码 0。上一轮 `1892/2095` 无保留原始 JSON 支撑，以本轮 JSON 为准。
