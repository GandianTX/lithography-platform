# S1 未决问题与推荐方案（S1 校准版）

> 只列真正影响实施的冲突/缺口。已确认业务语义不在此改写；推荐方案供用户/评审裁决。**未决不等于已批准**：标注“待确认”的技术提议不得视为用户已同意。

## 1. 问题清单

| 编号  | 问题                                                                                                                           | 证据                                | 影响                                          | 推荐方案                                                                                                                                                                          | 状态分类                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OI-01 | `local_backup_run.trigger_type` 设计标“新增”，但表内已存在，且现有枚举 SCHEDULED/MANUAL/USB_EXPORT，目标只写 MANUAL/AUTO/RETRY | 设计 3.17 与 Entity/迁移            | 直接按新增会重复列；替换枚举会让历史行违约    | **按既有列调整**：扩展 CHECK 保留旧值并加入 AUTO/RETRY；不重写历史行；新旧值映射在读取层表达                                                                                      | 推荐技术取舍，待确认                                                |
| OI-02 | `reference_document_revision`、`sync_conflict`、`backup_restore_run` 的 JSON/快照“有格式版本”但无显式版本列                    | 设计 4.8/4.12/4.16                  | 格式演进无法可靠判别                          | **按原稿在 JSON 内显式 `schema_version`**，读写两侧统一校验并拒绝未知版本；历史无版本数据按显式旧格式读取，不冒充新格式；**不自动增加独立版本列**，确需新增须先报告理由与兼容影响 | 已由基线明确                                                        |
| OI-03 | `reference_document` 同报告版本唯一：下架/软删后是否允许同版本再发布                                                           | 设计 3.31 + A09                     | 普通 UNIQUE 会永久占用；部分唯一 MySQL 不支持 | **永久唯一**：下架、软删均不释放唯一性；管理修订只生成 `reference_document_revision`，不产生第二份原始正式资料、不修改原始冻结版本；不通过重新发布绕过一次正式提交                | 已由基线明确                                                        |
| OI-04 | 17 个候选是否全部独立建表；终态表数 M 与迁移数 N                                                                               | 主计划明确“不得自动写 51”           | 迁移拆分、测试与验收范围                      | 见 §2。**按 17 个独立表作为当前实施方案**（可复用现有对象时先报告，不自行改业务语义）；M≈51、N≈39 仅是估算，不为维持数量合并/拆分迁移                                             | 已由基线明确                                                        |
| OI-05 | 旧工单 `customer_organization_id`/`service_organization_id`/`intake_id` 回填来源未知                                           | 代码与文档无“旧 owner=服务公司”映射 | 新非空/唯一约束无法安全收紧                   | 见 §3。以升级前冻结的旧记录集合 + 可证明来源回填；`intake_id IS NULL` 不能单独证明历史；未知旧行保留 NULL；无归属访问受限                                                         | 阻塞 `repair_request` 收紧                                          |
| OI-06 | `maintenance_report.status` 旧值与新 DRAFT/SUBMITTED 状态机并存                                                                | 设计 3.26 + 现有枚举                | 历史行 CHECK/展示/查询过滤                    | 扩展 CHECK 保留旧值；新写入只允许 DRAFT/SUBMITTED；读取层映射旧值，不批量改写                                                                                                     | 推荐技术取舍，待确认                                                |
| OI-07 | 现有管理员无 `admin_level`，是否允许登录后继续管理                                                                             | 设计 3.1/5.3 与 A08                 | 升级后可能出现“全员无等级”导致管理功能不可用  | 见 §4。实现受控“账号→等级→公司”映射工具与验证；真实映射清单为上线前置；未映射失败关闭，**不自动推断等级、不猜测公司**                                                             | 实库/上线前置                                                       |
| OI-08 | 旧 `content_submission`/`alarm_panel_*` 等入口如何处置                                                                         | 主计划 4.2/A02                      | 新旧并存造成重复/不一致                       | **移除“保留双写”结论**；逐入口处置见契约 §6.2.1：保持旧行为/最小适配/停止新写入/只读兼容/后续退役；不默认双写                                                                     | 已由基线明确                                                        |
| OI-09 | V13 Excel 位于附件目录而非 `/home/gandiantx/temp`                                                                              | 本轮指纹与文件名                    | 输入来源可追溯性                              | **附件目录不是阻塞**：文件名为 `需求确认清单_V13_会议对齐版_20261106.xlsx`，内容 91 项与主计划一致；指纹已记录，无版本冲突即视为该件，不再要求确认目录                            | 已由基线明确                                                        |
| OI-10 | 操作库/授权/保留数据/备份源证据（S1 轮未连接 DB）                                                                              | 用户硬边界                          | 实库验证与正式部署                            | 只阻塞实际连接、写库与实库验证；**不阻塞 S2/S3 代码与工具开发**；授权后先只读核对                                                                                                 | 实库/上线前置（2026-11-08 只读核对已完成，写库授权仍未取得，见 §6） |
| OI-11 | 当前分支已入 fork main（PR #2），上游 PR #21 CLOSED；无开放 PR                                                                 | PR/CI 采集                          | 交付目标与 base 选择                          | 从更新后的 fork main `72de1096…` 新建实施分支；上游另开 PR，不 force-push                                                                                                         | 已由基线明确                                                        |
| OI-12 | `stored_file` 绑定为多态引用，无 FK；清理与越权风险                                                                            | 设计 4.6                            | 清理闭包与权限校验                            | 应用层强制“上传人+公司+context+类型+状态”校验；清理按登记逐条；不靠 DB FK                                                                                                         | 推荐技术取舍，待确认                                                |
| OI-13 | 17 候选的 FK 删除策略设计未逐条明确                                                                                            | 设计第 4 章                         | 清理顺序与历史保护                            | 默认 RESTRICT；仅纯 owned detail 经批准后 CASCADE；本轮不改业务删除语义                                                                                                           | 推荐技术取舍，待确认                                                |
| OI-14 | 记录包检查与导入状态补齐后：包身份与文件内容绑定由谁证明；无法解析文件是否留检查记录；历史 `NULL` 的读取语义                   | R070—R073、V5.3 与第 39 条实现      | 去重正确性、历史展示与审计范围                | DB 只保证 `package_id` PK 与条目四元组 UK；**同包重试复用原编号、同文件新内容不得换号由 usecase 保证**；无法解析文件**默认不新增独立审计**（确需时另行确认）；历史 `NULL` 读取为“历史未判定”，不冒充“检查未完成” | 已由本轮基线明确（DB 部分），usecase 语义待确认                     |
| OI-15 | 第 39 条历史回填把包 `RUNNING/SUCCEEDED/PARTIAL`、条目 `SUCCEEDED` 回填为 `PASSED`；但当前仓库无这些表的旧写入消费者，38 态结构也不记录检查事实 | 第 39 条迁移、`1775501400000`、全仓库 grep、V5.3 R071—R073 | 历史 `check_status/check_result=PASSED` 可能被误读为“历史已检查”的审计事实 | **不擅改迁移**：保留回填但登记为“R072 需求前提驱动的迁移假设”，不当作历史已检查证据；升级前导出受影响行清单并取得明确确认；若审计要求证明，另行批准最小迁移（对无法证明的行保留 NULL 并调整历史组合约束，或引入外部检查记录），不在本轮实施 | 证据不足，待裁决（阻塞“历史已检查”表述，不阻塞结构迁移） |

## 2. OI-04：17 候选逐项论证（推荐独立建表，待批准）

| #   | 候选                          | 独立理由                                        | 依赖                                         | 删除策略                   |
| --- | ----------------------------- | ----------------------------------------------- | -------------------------------------------- | -------------------------- |
| 1   | `repair_request_intake`       | 报修原始输入与工单生命周期分离，需独立唯一/幂等 | 被 `repair_request` 引用                     | RESTRICT                   |
| 2   | `intake_analysis_attempt`     | 每次分析尝试独立留痕，失败重试不能覆盖          | → `repair_request_intake`                    | RESTRICT                   |
| 3   | `repair_process_entry`        | 内部维修过程与客户回复、结单分离                | → `repair_request`                           | RESTRICT                   |
| 4   | `ai_message_analysis`         | 迟到回答归原问题，需独立结果行                  | → `ai_message`                               | RESTRICT                   |
| 5   | `maintenance_report_fault`    | INITIAL/RESET_NEW/STEP_NEW 面板独立保存         | → `maintenance_report`（+step_code）         | RESTRICT                   |
| 6   | `stored_file`                 | 原件身份/状态/绑定独立于业务表，多态引用        | 无 FK（应用层）                              | 仅按登记清理               |
| 7   | `repair_request_revision`     | 管理修订 before/after 快照，不能混入主表        | → `repair_request`                           | RESTRICT                   |
| 8   | `reference_document_revision` | 生效修订历史与当前指针分离                      | → `reference_document`                       | RESTRICT                   |
| 9   | `local_account_authorization` | 本机账号授权按设备/公司独立，非账号全局         | → `local_installation`/account               | RESTRICT                   |
| 10  | `local_company_setting`       | 同机多公司配置互不覆盖（installation+org 唯一） | → `local_installation`/`organization`        | RESTRICT                   |
| 11  | `sync_receipt`                | 每次同步的完整回执，不能只记任务状态            | → `local_upload_task`                        | RESTRICT                   |
| 12  | `sync_conflict`               | 冲突保留待处理，独立于回执成功/失败             | → `sync_receipt`                             | RESTRICT                   |
| 13  | `record_package_import`       | U 盘包批次身份与逐条结果分离                    | → 导入者/公司                                | RESTRICT                   |
| 14  | `record_package_item`         | 逐条导入结果；纯 owned detail                   | → `record_package_import`                    | RESTRICT；经批准可 CASCADE |
| 15  | `backup_asset`                | 云端资产副本独立登记，支持重试/清理             | → `local_company_setting`/`local_backup_run` | RESTRICT                   |
| 16  | `backup_restore_run`          | 恢复资格/结果/覆盖范围独立留痕                  | → `backup_asset`                             | RESTRICT                   |
| 17  | `management_audit_event`      | 三类管理操作留痕，多态目标；不可随业务删除      | 无 FK（应用层）                              | 不删                       |

结论：**17 项按独立表作为当前实施方案**（M≈51）；`stored_file`、`management_audit_event` 为多态、无 FK；`record_package_item` 仅在批准后允许 CASCADE。若实施中发现可复用现有对象，先报告理由与影响，不自行改变业务语义；**任何并入/复用都需单独论证并降低 M，不得为凑 51 表而拆分，也不得为维持估算数量而合并迁移。**

## 3. OI-05：旧工单可执行分流与回填

1. **识别旧行**：`intake_id IS NULL` **不能单独证明记录是历史数据**。升级前先冻结旧记录集合：在迁移执行前只读导出 `repair_request` 的主键集合（含 `id`、`request_no`、`created_at`、原 `owner_organization_id`、`customer_account_id`、`accepted_by_engineer_account_id`），以该集合的哈希与行数作为冻结证据；迁移后只有“属于冻结集合且无新入口创建记录”的行才按旧行处理。
2. **新写入判据**：新工单必须由入口在同一事务内创建 `repair_request_intake` 并写 `intake_id`；`intake_id IS NOT NULL` 的行强制 `customer_organization_id`、`service_organization_id` 非空。`intake_id IS NULL` 的行不因该判据自动获得非空要求。该判据可重复执行、可对任意快照复核。
3. **有限回填**：仅两条可证明路径——客户账号已有可核实的 `customer_organization_id` 时回填客户公司；旧 `owner_organization_id` 有文档/数据证明即服务公司时回填服务公司。**不猜测客户公司、服务公司，不伪造报修分析来源**；无依据的旧归属保留 NULL，不强行收紧成非空。
4. **限制无归属访问**：保留原客户账号、原接单工程师已有的受限读取；组织为 NULL 的旧行仅 1 级管理员按明确资源授权可读。2 级管理员只能读 `service_organization_id`/`customer_organization_id` 属于本公司的行。**不允许无归属旧工单新接单，也不放大组织可见范围。**
5. **验收**：回填脚本幂等、可重跑，输出“已回填/保持 NULL/冲突”台账；预检 0 违规后才收紧。冻结集合、回填台账与校验查询写入 S2 待实库执行规格，本轮不连接实库。

## 4. OI-07：受控管理员映射

- 工具：输入“登录名 → admin_level（1/2）→ 组织”清单，输出命中/未命中/歧义/冲突预检报告；不自动推断、不覆盖密码/归属。
- 验收：6 个目标账号唯一命中；未映射账号 `admin_level=NULL` 且管理操作失败关闭；重跑 0 变更；映射清单不提交。
- 门槛：映射是**升级上线前置**，不阻塞无关结构、迁移脚本与工具开发。

## 5. 问题分类（不混写）

| 分类                 | 项                                       | 含义                                                        |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| 已由基线明确         | OI-02、OI-03、OI-04、OI-08、OI-09、OI-11 | 已有裁决，按记录执行；OI-02/03/04 本轮同步为实施方案        |
| 推荐技术取舍，待确认 | OI-01、OI-06、OI-12、OI-13、OI-14 | 不阻塞开始编码，但落地前需确认；未确认前保留旧语义 |
| 证据不足，待裁决   | OI-15                                    | 未确认前不得把第 39 条回填写成“历史已检查”的审计事实 |
| 阻塞特定实现         | OI-05                                    | 未取得冻结旧集合与可证明回填依据前，不收紧 `repair_request` |
| 实库/上线前置        | OI-07、OI-10                             | 不阻塞 S2/S3 代码开发；阻塞实库验证与正式上线               |

**不再使用“非阻塞但 S2 前必须全部裁决”的笼统表述**：上表按“是否阻塞本轮/是否阻塞上线”分别归类。

## 6. S4 准备核对：OI-01/06/12/13 实现现状（2026-11-08，未自行批准）

> 详细证据见 [S4-pre-execution-precheck.md](S4-pre-execution-precheck.md) §3。四项均保持「待确认」，本节只补充代码事实，不构成裁决。

- **OI-01**：DB 层已按推荐方案实现（`chk_local_backup_run_trigger` 扩为 `SCHEDULED/MANUAL/AUTO/RETRY/USB_EXPORT`，历史行未重写）；**类型层已补齐**：`local-runtime.types.ts` 的 `LocalBackupTriggerType` 已扩为 5 值，`normalizeBackupTrigger` 用户输入白名单仍仅旧三值（AUTO/RETRY 为系统触发，不接受客户端输入），G-1 纯替身单测通过。**读取层业务映射语义仍待裁决**（未自行决定）。
- **OI-06**：DB 层已按推荐方案实现（状态 CHECK 增加 `SUBMITTED`、一致性 CHECK 同步扩展）；现有写入路径仍写 `PENDING_REVIEW`（旧行为保留、未批量改写）；「新写入只允许 DRAFT/SUBMITTED」属后续业务流，未实现。
- **OI-12**：`stored_file` 业务绑定（`business_type/business_id`）无 FK 与方案一致；应用层「上传人+公司+context+类型+状态」校验无消费者、未实现（属后续执行器）；**清理闭包已覆盖 17 新表**（G-3 已补齐，纯替身 28/28 通过，含登记/事实漂移/外部引用拒绝/删除顺序/解环/删除失败回滚/幂等/静态契约；实库清理验收待授权）。
- **OI-13**：17 张新表全部 FK 均为 RESTRICT（含 `record_package_item`，CASCADE 未获批故未采用）；实现与推荐默认一致。
- **OI-10 进展**：2026-11-08 用现有凭据完成只读核对（实例/版本/server_uuid/库清单/权限/Redis/配置加载），结果见 precheck §7；写库授权仍未取得，分类不变。

## 7. 第 39 条迁移：记录包检查/导入状态（2026-11-08，代码与离线验证完成，未写库）

- **已补齐能力**：包级 `check_status`、条目级 `check_result`；条目 `result` 改为可空并新增 `CONFLICT`；
  `manifest_json` 版本键收紧为“存在且非 JSON null”；检查与导入阶段通过组合约束分别表达。
- **保留不变**：`package_id` 主键与稳定包身份、`imported_by_account_id`、`manifest_json` 列名与类型、
  既有 FK、`uk_record_package_item_scope`；**不新增独立 `format_version`**，版本以 JSON 内键为单一来源。
- **旧数据（口径校正）**：`RUNNING/SUCCEEDED/PARTIAL → PASSED`、条目 `SUCCEEDED → PASSED` 是**R072 需求前提驱动的迁移假设**，不是旧记录已检查的证明；其余保持 `NULL`（“历史未判定”）；预检违规时失败关闭并输出定位 ID。详见 OI-15。
- **仍待裁决（不影响本轮离线完成）**：usecase 侧“同文件内容不得换号”的实现方式、无法解析文件是否留痕、
  `NULL` 在读取层的展示文案；见 OI-14。



## 8. OI-15：第 39 条历史回填依据（2026-11-08 核实，未写库）

### 8.1 实际保证

- 38 态（`1775501400000`）的 `record_package_import` 只有 `status` 域（PENDING/RUNNING/SUCCEEDED/PARTIAL/FAILED），`record_package_item.result` 为 `NOT NULL` 且只允许 SUCCEEDED/FAILED/SKIPPED；**没有任何检查列、检查记录或“检查通过才能导入”的数据库约束**。
- 第 39 条新增的 CHECK 只约束**迁移之后**的写入：`RUNNING/SUCCEEDED/PARTIAL` 要求 `check_status=PASSED`，条目 `SUCCEEDED` 要求 `check_result=PASSED`。它不能反向证明升级前的历史行曾经检查。
- 第 39 条把 `RUNNING/SUCCEEDED/PARTIAL → PASSED`、条目 `SUCCEEDED → PASSED` 的 UPDATE 是**迁移实现的选择**，不是数据库里已有的检查事实。

### 8.2 需求前提

功能 V5.3 R071—R073 的实际文本（冻结 docx）：

- R071 操作流程：“验证包来源、版本、公司、正文原件→检查重复冲突→保存检查结果”；数据库读写：“INSERT record_package_import、record_package_item（拟增）检查记录”。
- R072 前置条件：“所选包及条目检查合格，确认范围明确”；操作流程：“复核包版本与当前权限→逐条去重／冲突处理→保存实际结果”；数据库读写：“同次写业务、文件关联及 record_package_item.result”；异常与边界：“检查合格不等于成功”。
- R073：查询检查结论与导入结果，“按处理阶段区分检查与导入”。

这些文本说明**需求要求先检查再导入**，并定义了检查/导入两个阶段；但它是需求前提，不是旧记录已检查的实现证据。

### 8.3 旧消费者与写入路径

- 当前仓库源码中，`record_package_import` / `record_package_item` 只出现在：迁移、Entity、结构契约、清理工具/回归、V13 实库规格。**没有 usecase、module service、GraphQL resolver、旧接口或脚本写入这两张表**。
- `backend/dist/` 中的同名编译产物来自当前源码，不是独立旧消费者；不作为“旧实现保证”的证据。
- 两张表由未提交的 V13 迁移 `1775501400000` 新建；在 38 态中，任何具备 INSERT 权限的直接 SQL、外部工具或未来写入者都可以写 `status='SUCCEEDED'` / `result='SUCCEEDED'` 而不写检查事实。**没有消费者不等于没有绕过路径。**
- 因此：包 `RUNNING/SUCCEEDED/PARTIAL` 在旧实现中“必然经过检查”、条目 `SUCCEEDED` “必然代表检查通过后写入”，均**不能由当前代码或 38 态结构证明**。

### 8.4 分类结论

| 分类 | 结论 |
| --- | --- |
| 实际保证 | 仅 38 态已有的状态域、`result NOT NULL`、FAILED 必须有原因等；没有“检查通过才能导入”的历史保证。 |
| 没有消费者但属于已批准迁移假设 | 只有在用户明确批准“把 R072 需求前提视为历史事实”时，才能这样记；当前尚未取得该批准。 |
| 依据不足 | 把历史 `RUNNING/SUCCEEDED/PARTIAL` 或条目 `SUCCEEDED` 直接认作“已检查”的审计事实。当前回填属于这一类，不能冒充已证明。 |

**结论：第 39 条的回填映射目前只能登记为“需求前提驱动的迁移假设”；是否升格为“已批准迁移假设”需用户明确裁决。**

### 8.5 最小处理选择（本轮不实施迁移改动）

1. **保留迁移 + 明确假设（推荐，最小改动）**：不改第 39 条；升级前导出受影响包/条目清单，记录“回填 PASSED 为 R072 假设”；读取/展示层把历史 `PASSED` 标注为“历史推定”，不作为审计已检查证明。
2. **升级前人工确认**：由业务方对冻结的受影响行清单逐包/逐条确认“确已检查”，形成签字/工单证据后再升级；仍不改迁移。
3. **审计要求可证明时另立迁移**：对无法证明的历史行保留 `NULL`，并调整历史组合约束或新增显式来源列；这属于新的、需单独批准的最小迁移，不在本轮实施，也不得夹带进第 39 条。

## 9. 第三十二轮新增未决问题（2026-11-09）

本轮已关闭/记录的裁决：

- Q1 公司备份配置字段、Q2 授权签名三列、Q4 备份资产与恢复保护备份、Q6 管理员归属与权限判定、Q9 结单双 NULL 兼容、Q10 结构比对规范化：见 S5 §8.1—§8.2。
- Q7 历史身份：**未关闭**。已明确禁止以 `current_revision_no=0` 或 `intake_id IS NULL` 作判据；冻结真实历史 ID 集合是前置条件；三种可持久区分方案的取舍见 S5 §8.3，本轮不选型。

新增待决（按优先级）：

| 编号 | 问题 | 为什么现在必须定 | 若未定的后果 |
| ---- | ---- | ---------------- | ------------ |
| Q14 | 是否批准修改第 32 条（S5 §8.6 P-A） | A/B 两个挡点已由源码证据确认；不改第 32 条就没有可行升级路径 | 下一轮实库规格只能证明“阻断”，不能证明“可升级” |
| Q15 | Q7 选 O1（主表标记）还是 O2（历史映射表）；冻结集合来源、是否含软删行、谁签字确认完整 | 决定第 41 条迁移形态 | 历史行与旧入口新记录无法持久区分 |
| Q11 | `local_company_setting.next_backup_at` 旧行是否允许按 `initialized_at + 72h` 派生回填 | 决定该列能否在非空库做到 NOT NULL | 只能保持可空，或非空库拒绝迁移 |
| Q12 | `local_account_authorization` 三个签名列历史行保持三空，还是坚持 NOT NULL 并在非空库拒绝 | 决定授权表迁移在非空库的可执行性 | 若坚持 NOT NULL 又无历史证据，只能失败关闭 |
| Q13 | `backup_restore_run.check_status` 与 `maintenance_report_fault.phase_code` 的精确枚举 | 决定两条 CHECK 的最终表达式 | 只能先不加域 CHECK，约束不完整 |

已记录但不需本轮决定的偏差：

- `maintenance_report_fault` **不加** `(report_id, step_code)` 唯一键：设计允许同一报告内多分支/多步骤故障分别成行，直接加唯一键会误拒（S5 §8.2.6）。
- `backup_asset.storage_reference` 原样保留，不推断为云端引用；新增 `cloud_reference` 独立写入，不做回填（S5 §8.2.4）。


