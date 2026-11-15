# S1 关键契约与兼容顺序

> 正式交接副本：保留原裁决及来源时点，后续明确裁决优先；不表示业务接口已实现。部署见 [SOP](deployment-sop.md)。

> 本文件把已确认的业务语义翻译成可执行的数据契约；只给推荐实现方式，不改变业务语义。未确认处在 [S1-open-issues.md](https://github.com/GandianTX/lithography-platform/blob/de742a59700450b42a951b64f0a41cddb12d294c/backend/plans/database-v13-deploy/S1-open-issues.md)。

## 1. 提交幂等（同一次提交重试不多建）

### 1.1 字段与唯一键

| 项       | 目标                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| 请求标识 | `maintenance_report.submission_request_id varchar(64)`，由客户端每次“提交动作”生成，重试复用 |
| 正文摘要 | `maintenance_report.submission_payload_hash char(64)`，提交事务内按规范化正文计算            |
| 唯一键   | `UNIQUE(created_by_account_id, owner_organization_id, submission_request_id)`                |
| 状态     | 报告新增 `DRAFT / SUBMITTED`；只允许 DRAFT→SUBMITTED 单向                                    |
| 事务边界 | 报告状态、报告版本冻结、`reference_document`、`stored_file` 绑定在同一事务                   |

### 1.2 判定规则

1. 同 `(created_by_account_id, owner_organization_id, submission_request_id)` + 同 `submission_payload_hash` + 已 SUBMITTED：返回既有结果，不新建版本/资料/绑定。
2. 同请求标识 + **不同摘要**：拒绝（冲突），不覆盖旧提交。
3. 新请求标识：允许新建；同一报告重复提交由“同工单唯一报告/同冻结版唯一资料”约束兜底。
4. 先置 SUBMITTED 再生成版本/资料；任何一步失败整体回滚，不留下半提交。
5. `submission_request_id` 与 `submission_payload_hash` 只增不改；历史 NULL 行不受唯一键影响（MySQL 允许多个 NULL）。

推荐技术取舍：不在 MySQL 中做“摘要自动生成列”，由应用在事务内计算并写入，避免规范化规则变更导致生成列无法演进；唯一键只做最终防线。

## 2. 同报告版本的复合外键

### 2.1 目标结构

| 项        | 目标                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| 子表      | `reference_document`                                                                               |
| 新增列    | `source_report_id int`、`source_report_version_id int`                                             |
| 被引用键  | `maintenance_report_version(id, report_id)` 的现有唯一键 `uk_maintenance_report_version_id_report` |
| 外键      | `(source_report_version_id, source_report_id)` → `(id, report_id)`                                 |
| 列序      | **版本列在前、报告列在后**，必须与被引用唯一键列序一致                                             |
| 删除/更新 | `ON DELETE RESTRICT ON UPDATE RESTRICT`                                                            |
| 生效唯一  | `UNIQUE(source_report_version_id)`（NULL 不占用）；**永久唯一：下架/软删不释放**（OI-03 已裁决）   |

### 2.2 内容来源 CHECK（逻辑约束，不是新增列）

`source_kind` 分支：`INDEPENDENT_REPORT` / `WORK_ORDER_SUMMARY` 必须同时有 `source_report_id` 与 `source_report_version_id`；`MATERIAL`（历史普通资料）允许两列为 NULL，但必须有旧来源/文件。CHECK 必须 NULL-safe，不能用 `NOT (a IS NULL AND b IS NULL)` 之类会在 NULL 上放行的表达式。

部署顺序：先加可空列 → 回填可从现有报告版本证明的历史行 → 建唯一键 → 建复合 FK → 再启用新写入 CHECK。禁止先建 NOT NULL/FK 再回填。

## 3. 生效修订

### 3.1 结构

| 项       | 目标                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 主表指针 | `reference_document.current_revision_no int unsigned NOT NULL DEFAULT 0`                    |
| 修订表   | `reference_document_revision(document_id, revision_no)`，`UNIQUE(document_id, revision_no)` |
| 快照     | 每行保存 `before_snapshot` 与 `after_snapshot`（完整可展示内容/归属/发布状态），不是仅差量  |
| 原件     | `reference_document.source_report_version_id` 绑定的原始冻结版**不因修订替换**              |
| 事务     | 修订行、主表指针、主表发布/归属字段同一事务更新                                             |

### 3.2 语义

- 首次技术处理生成 revision 1，`after_snapshot` 从原始冻结版继承正文，归属/发布字段按首次处理结果。
- 后续“上架/下架/归属/删除/正文修正”每次生成新 revision；`before_snapshot` = 当前生效 after，`after_snapshot` = 本次结果。
- 级联失效（如报告来源被替换）也生成 revision，记录失效原因，不物理删除历史。
- 并发：`SELECT ... FOR UPDATE` 锁主表行 + `UNIQUE(document_id, revision_no)` 兜底；冲突时重算 revision_no，不重放业务提交。
- 查询公开详情读**最新 revision 的 after_snapshot**；审计读全部 revision。

注意：`reference_document_revision`、`sync_conflict`、`backup_restore_run` 的版本号**按原稿写在 JSON 快照内部**（`schema_version`），读写两侧统一校验并拒绝未知版本；历史无版本 JSON 按显式旧格式读取，不冒充新格式。**不自动增加独立版本列**；确需新增时先报告理由与兼容影响（OI-02 已裁决）。

### 3.3 工单管理修订（repair_request_revision）

- `revision_no` 是本次生效的新业务修订号；`previous_version` 是本次修订锁定并核验过的上一生效修订号，不是快照格式版本。
- 写入契约（未来 R029/R030 执行器）：`SELECT repair_request ... FOR UPDATE` → 核验 `expected_version = current_revision_no`（过期拒绝）→ 取 `previous_version = current_revision_no`、`revision_no = previous_version + 1` → 同事务写修订行并推进 `current_revision_no`。首次修订明确写 `previous_version = 0`，后续写实际基版本。
- 第 43 条先追加 `previous_version int unsigned NULL`（历史行无法证明取值时保留 NULL）；第 44 条按已批准裁决把最终列收紧为 **NOT NULL、无默认值**：
  - 在任何 `ALTER` 之前校验 `previous_version IS NULL` 与 `previous_version >= revision_no`；
  - 存在违规即失败关闭，只输出脱敏计数与有限定位 ID，**不自动 UPDATE、不删除历史行、不猜测回填**；
  - 无违规才收紧列约束；`down` 只回退可空性，不伪造或删除任何版本值。
- 保留 CHECK `previous_version < revision_no` 作为顺序守卫（第 43 条创建时写作 `previous_version IS NULL OR previous_version < revision_no`；第 44 条收紧为非空后 NULL 分支不可达）；“修订号连续”仍是写入方与应用验收不变量，不是数据库约束。读取方不得用 `revision_no - 1` 重算并覆盖已存储值。
- 本节与 §3.2 的 `schema_version` 规则不同：`previous_version` 是业务修订号，不是 JSON 快照内部版本，不适用“版本号写在 JSON 内部”的约定。

## 4. 原件绑定（stored_file）

### 4.1 状态与绑定

| 阶段 | 状态                                                         | 规则                                                                      |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 上传 | `STAGING`                                                    | 生成 `file_id char(36)`、`upload_context_id`；业务字段为空                |
| 校验 | `VALID` / `FAILED`                                           | 校验大小 ≤ 20,000,000、类型、checksum；FAILED 不参与绑定                  |
| 绑定 | `business_type` + `business_id` 写入、`binding_status=BOUND` | 与业务保存/提交同一事务；校验上传人、公司、context、类型、状态            |
| 清理 | 临时                                                         | 仅清理超时且 `binding_status=TEMPORARY` 且无任何业务引用的 STAGING/FAILED |

### 4.2 约束

- 一个文件只能绑定一个业务对象；绑定后 `business_type/business_id` 不可改。
- 业务侧删除/下架不物理删 `stored_file`；有有效引用时拒绝物理删除。
- 旧附件表（报告附件/投稿附件）不动、不批量搬入 `stored_file`；新流程新文件才走统一目录（历史兼容）。
- 文件本体不入库、不入 Git；DB 只存引用、校验和、状态。

## 5. 管理员等级

| 项         | 目标                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段       | `base_user_account.admin_level tinyint NULL`                                                                                                                         |
| CHECK      | `admin_level IS NULL OR admin_level IN (1,2)`                                                                                                                        |
| 身份       | 1 级=甲方平台管理员；2 级=受管公司管理员；`identity_hint` 不得单独作为授权依据                                                                                       |
| 受控初始化 | 1 级 3 个（甲方公司）、2 级 3 个（各受管公司）；登录名/邮箱等为部署配置。**由显式 `--admin-bootstrap` 等受控参数触发**，不是每次 `init` 必然重建；未提供时跳过并记录 |
| 初始密码   | 仅在显式初始化时设置；`must_change_password=true`；重跑不重置密码                                                                                                    |
| 范围       | 1 级全平台；2 级限本公司 `organization_id`；审计 NULL 行不放大到全局                                                                                                 |
| 失败关闭   | 缺失/非法等级不提升为 1 级；碰撞/身份不明拒绝                                                                                                                        |
| 权限来源   | 运行时读 DB 等级+有效成员关系，不信任前端角色或 JWT 声明                                                                                                             |

推荐：管理员初始化脚本按 `login_email`（或明确唯一登录名）幂等 upsert；已存在账号只补必要等级映射且需显式配置，绝不覆盖密码/归属；任何碰撞以非 0 退出。升级后的旧管理员映射是**上线前置**，不阻塞无关结构与工具开发：

- 工具契约：输入“登录名 → admin_level（1/2）→ 组织”映射清单；输出预检报告（命中/未命中/歧义/冲突）。
- 验收：每个目标账号唯一命中；未映射账号保持 `admin_level=NULL`，管理操作失败关闭；重跑 0 变更；不自动推断等级。
- 映射清单不入库、不提交；仅由部署者按受控路径提供。

## 6. 历史数据与旧接口兼容

### 6.1 不可破坏的历史对象

- 保留全部 31 条迁移与 34 张表；不删正常记录、不删旧表/旧列、不 `down`、不 `synchronize`。
- 旧 `content_submission` / `content_submission_revision` / `content_review_record` / `alarm_panel_*` / 旧附件表：历史保留，按 6.2 逐入口处置；**不默认新增双写**。
- `maintenance_report` 旧状态值（如 PENDING_REVIEW/RETURNED/APPROVED）保留；新流程只写 DRAFT/SUBMITTED；CHECK 扩展而非替换。
- `reference_document` 旧 `source_submission_id/source_revision_id` 保留；新报告来源用新列；`ingest_method` 旧值保留并新增 `DIRECT_SUBMISSION`。
- 旧管理员没有 `admin_level` 时不自动提升；需显式受控映射；未映射期间涉及等级范围的管理操作应失败关闭，而不是按 1 级放行。

### 6.2 推荐兼容顺序（expand → adapt → backfill → tighten → stop old writes）

| 阶段        | 动作                                                                                                                        | 退出条件                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P0 扩展     | 新增可空列/新表/索引；不建 NOT NULL/唯一/FK 于旧行                                                                          | 迁移成功，旧接口行为不变                    |
| P1 适配     | 改写入者/读取者/GraphQL：新字段以**单一真源**写入（能直接替换则替换，不并行写两份）；新表读、权限按 admin_level；旧路径保留 | 现有 e2e 绿，新字段可读写，且无同一事实双写 |
| P2 回填     | 仅按可证明来源回填公司/来源/等级；记录无法回填的例外                                                                        | 回填脚本幂等、可重跑、有台账                |
| P3 收紧     | 加 NOT NULL/CHECK/唯一/FK；先检测零违规                                                                                     | 预检 0 违规，重跑 0 变更                    |
| P4 停旧写   | 停旧投稿新提交、旧 alarm 八槽位新写；保留读/历史                                                                            | 旧入口只读，无新数据写入                    |
| P5 清理闭包 | 扩 `e2e-scoped-cleanup` 与夹具，按新 FK 顺序删除                                                                            | 标准 core 零残留                            |

**不默认双写**：同一业务事实只允许一个权威写入位置。确有必要保留过渡写入时，必须单列：真源、目标、事务/幂等、失败补偿、停止条件，并作为待确认建议；未获确认前按“单一真源 + 最小适配”实施。

如需申报过渡双写，至少补齐以下五项（当前无任何已批准的双写项）：

| 申报项    | 必须说明                             |
| --------- | ------------------------------------ |
| 真源      | 哪一侧是权威事实，冲突时以谁为准     |
| 目标      | 另一侧何时写、写哪些字段、是否可重建 |
| 事务/幂等 | 是否同事务、请求标识、重复执行结果   |
| 失败补偿  | 一侧失败时的重试/补偿/对账方式       |
| 停止条件  | 何时停写、如何验证停写完成、谁批准   |

### 6.2.1 旧入口逐项处置

| 旧入口/对象                                                                 | 处置                      | 判据                                                                  |
| --------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| 普通资料投稿（`content_submission` 新建）                                   | **停止新写入**，历史只读  | 新报告走 `maintenance_report`；旧详情/下载按现有查询继续              |
| 资料审核（`content_submission_review` / `content_review_record`）           | **只读兼容**，不接新报告  | 新报告提交后不再进入普通资料审核链                                    |
| 旧资料（`content_submission_revision` 等）                                  | **保持旧行为/只读**       | 不自动转正、不批量改写、不删表                                        |
| 旧报警面板（`alarm_panel_*` / `maintenance_report_alarm`）                  | **保持旧行为 + 最小适配** | 历史八槽位保留；新故障面板写 `maintenance_report_fault`，不双写旧槽位 |
| 旧附件（`content_submission_attachment` / `maintenance_report_attachment`） | **保持旧行为/只读**       | 新原件走 `stored_file`；旧附件记录不删、不自动迁移                    |
| 旧报告状态                                                                  | **最小适配**              | 旧值保留，新写入只 DRAFT/SUBMITTED                                    |
| 旧管理员                                                                    | **受控映射 + 失败关闭**   | 见 §5；未映射不提升                                                   |
| 旧工程师注册审批                                                            | **保持旧行为**            | 审批链不取消、不并入管理员初始化                                      |

原则：能“保持旧行为”就不改；必须读新列才做“最小适配”；只有业务明确取消的入口才“停止新写入”；历史一律“只读兼容”，最终退役需单独批准。

### 6.3 逐表部署分类（推荐）

| 表/对象                          | 分类                             | 理由                                                               |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `base_user_account`              | 必须配套最小代码                 | 登录/改密要读 `must_change_password`；管理员范围要读 `admin_level` |
| `base_user_info`                 | 必须配套最小代码                 | 资料写 `real_name/customer_organization_id`                        |
| `organization`                   | 必须配套最小代码                 | 1 级公司维护/2 级名单使用新字段                                    |
| `ai_conversation` / `ai_message` | 先扩展再收紧                     | `request_id/owner_organization_id` 有历史 NULL                     |
| `local_backup_run`               | 先扩展再收紧                     | `organization_id` 历史 NULL + `trigger_type` 枚举冲突              |
| `local_upload_task`              | 先扩展再收紧                     | 新稳定身份列对历史行可空                                           |
| `maintenance_report`             | 必须配套最小代码 + 先扩展再收紧  | 幂等字段、状态机、提交事务                                         |
| `maintenance_report_step`        | 先扩展再收紧                     | 新结果/错误码列对旧行可空                                          |
| `reference_document`             | 必须配套最小代码 + 先扩展再收紧  | 复合 FK、来源分支、发布/归属读路径                                 |
| `repair_request`                 | 必须配套最小代码 + 先扩展再收紧  | 新公司/`intake_id` 对旧行不可直接 NOT NULL                         |
| `engineer_response`              | 可独立上线（字段长度/语义调整）  | 无新非空列                                                         |
| 17 候选新表                      | 可独立上线（除被旧表 FK 引用者） | 无旧消费者；`stored_file`/`maintenance_report_version` 相关需同批  |

## 7. 清理引用闭包

- 入口：`test/utils/e2e-scoped-cleanup.ts`、`test/utils/e2e-owned-fixture.ts`、`test/utils/e2e-db-guard.ts`、`src/infrastructure/database/test-support/`。
- 新增 FK 入边（必须在清理计划中排到父表之前）：
  `repair_request → repair_request_intake`、`intake_analysis_attempt → repair_request_intake`、
  `repair_process_entry/repair_request_revision → repair_request`、`ai_message_analysis → ai_message`、
  `maintenance_report_fault → maintenance_report`、`reference_document → maintenance_report_version/report`、
  `reference_document_revision → reference_document`、`sync_conflict/record_package_item → sync_receipt/record_package_import`、
  `backup_asset/backup_restore_run → local_company_setting/local_installation`（按实际 FK）。
- 推荐删除顺序（仅清理登记对象，不扩范围）：审计/绑定 → 修订 → 资料 → 报告子表 → 报告 → 工单修订/过程/响应 → 工单 → 分析尝试 → 报修入口 → AI 分析 → AI 消息/会话 → 同步冲突/包条目/包批次/回执 → 上传/恢复/资产/备份 → 本地授权/公司设置 → 安装。
- 多态引用（`stored_file.business_*`、`management_audit_event.target_*`）没有 FK，清理必须按显式登记逐条处理，不能靠 DB 级联。
- 现有 58 条 FK 的清理顺序不得改动语义；只在新 FK 处插入。

## 8. 终态迁移数 N 与表数 M（估算，不是预设指标）

| 口径       | 当前 | 估算终态           | 条件                                                                                                         |
| ---------- | ---- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| 迁移数 N   | 31   | 约 **39**（+8 条） | 仅用于规划；按安全依赖与 expand/tighten 顺序拆分，**不以固定条数作为业务审批前提**；安全评审要求拆分时可增加 |
| 业务表数 M | 34   | 约 **51**（34+17） | 17 候选独立建表时才是 51；**51 是方案结果，不是目标**；任何并入/复用都会降低 M                               |
| 历史迁移   | 31   | 31 不变            | 前 31 条逐文件哈希/摘要不变                                                                                  |

推荐的 8 条新迁移分组（仅分组建议，不是条数承诺）：

1. 账户/管理员/公司字段；2. 报修入口+分析尝试+工单字段；3. 过程+AI 分析；4. 报告故障+步骤/报告字段；
2. `stored_file`+资料修订+资料字段/复合 FK；6. 本地公司/授权+同步回执/冲突；7. U 盘包批次/条目+上传稳定身份；8. 备份资产/恢复+审计。

**17 个候选按独立表推进（OI-04 已裁决）；N≈39 仅作估算**：按安全依赖与 expand/tighten 顺序拆分，不为固定条数改变分组，也不把 39/51 写入验收指标。

## 9. 初始化/升级接口（S3 交付，S1 只定契约）

| 模式      | 输入                                           | 行为                                                                                          | 禁止                                             |
| --------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `init`    | 配置文件、显式库名、确认串、可选受控管理员参数 | 按 9.1 四态分派；仅对不存在库或空库建表；完整匹配终态只验证不重建；管理员仅在显式参数下初始化 | 不连接 3306 保留库；不覆盖已存在库；不对脏库建表 |
| `upgrade` | 配置文件、显式库名、确认串、backup 声明        | 检查前缀/非空历史 → GET_LOCK → 只跑 pending → verify → 重复 0 条                              | 不清空、不 down、不 `synchronize`                |
| `verify`  | 同 upgrade                                     | 契约校验、表/列/索引/FK/CHECK/生成列                                                          | 不写业务数据                                     |

### 9.1 `init` 四态

| 目标状态     | 判据                                       | 行为                                            |
| ------------ | ------------------------------------------ | ----------------------------------------------- |
| 库不存在     | 连接可建库、目标库名不存在                 | 核验服务器版本/权限/互斥后仅建指定库 → 全量迁移 |
| 已存在空库   | 无业务表、无迁移历史、无未知对象           | 允许首次初始化；先核对 `DATABASE()` 与目标一致  |
| 完整匹配终态 | 迁移历史完整、契约校验通过、pending=0      | 验证后无变化返回；**不重建、不重置管理员**      |
| 脏状态       | 旧业务表无历史、半迁移、未知对象、历史断裂 | 停止并非 0 退出；不 DROP/TRUNCATE/伪造迁移记录  |

目标身份核验：必须用显式主机/端口/库名与 `SELECT DATABASE()` 核对；**不得以“默认 3306”或本机 socket 路径代替目标身份确认**。

失败关闭：缺配置、错库、未确认、权限不足、未知迁移前缀、半迁移、目标非空但无历史证据均非 0 退出，并在首个业务写入前拒绝。

## 10. 支持环境与配置

- MySQL 8.0+（历史实测 8.0.46，`utf8mb4`，严格模式）；Node v22.19.0 / npm 10.9.3；Redis 7.0.15（仅既有队列需要）。
- 私密配置**可受保护地包含连接凭据**（如权限受限的文件/密钥环），但不得提交、不得写入日志或命令输出；输出只打印脱敏摘要。
- 迁移账号需目标库 DDL/DML；初始化建库需要 CREATE 权限；升级不得使用可跨库的高权账号。

## 11. 记录包检查/导入状态（第 39 条迁移契约）

- 对象：`record_package_import.check_status`、`record_package_item.check_result`、`record_package_item.result`。
- 状态与职责：
  - 包检查 `check_status`：`NULL`（历史未判定）／`PENDING`（未完成）／`PASSED`／`REJECTED`；
  - 包导入 `status`：`PENDING`／`RUNNING`／`SUCCEEDED`／`PARTIAL`／`FAILED`（仅导入阶段）；
  - 条目检查 `check_result`：`NULL`（未完成或历史未判定）／`PASSED`／`REJECTED`；
  - 条目导入 `result`：`NULL`（未执行）／`SUCCEEDED`／`FAILED`／`SKIPPED`／`CONFLICT`。
- 数据库可证组合：`RUNNING/SUCCEEDED/PARTIAL` 要求包检查 `PASSED`；包检查 `REJECTED` 只允许 `status=PENDING`；
  包检查 `PENDING` 只允许 `status=PENDING`；历史 `NULL` 只允许 `PENDING/FAILED`。
  条目检查 `REJECTED` 只允许 `result=NULL`；`result=SUCCEEDED` 要求 `check_result=PASSED`。
- usecase 职责：同包重试必须复用原 `package_id`；同一文件新内容不得重新生成编号绕过主键去重；
  检查结论必须绑定具体包版本与清单摘要；无法解析文件默认不新增独立审计记录（除非另行确认）。
- 旧数据：包 `RUNNING/SUCCEEDED/PARTIAL` → `PASSED`；条目 `SUCCEEDED` → `PASSED`；其余保持 `NULL`；迁移前预检失败时报告定位 ID，不做猜测回填。**该映射是 R072 需求前提驱动的迁移假设，不是旧记录已检查的证明；见 OI-15。**
- DDL 风险：MySQL DDL 隐式提交，跨表部分成功不能整体回滚；失败信息列出已完成步骤，
  已存在列/约束在重跑时跳过，可受控续跑。
