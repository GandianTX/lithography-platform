# S2 待实库执行的约束／事务／清理规格

> 2026-11-08 已完成授权实库执行：`lithography_v13_spec` 已升级到 38 条迁移，D 规格全量 **75 passed / 0 failed / 0 skipped**（其中真实库 73 项、离线元数据 2 项）；2.4 JSON 快照版本 24 项通过。其余未列入 §2.1—§3 的清理入口实库验收仍未执行。
> 2026-11-08 第 39 条迁移（记录包检查/导入状态）仅完成代码、离线单测与 §2.5 规格；**目标库仍为 38 条**，§2.5 实库执行待授权。**（历史口径保留）**
> 2026-11-08 第 39 条已在 `lithography_v13_spec` 定向升级：终态 39 条；§2.5 **12 passed**，D 全量 **87 passed / 0 failed / 0 skipped**，E 实库 **10 passed / 0 failed / 0 skipped**；详见 `execution-log.md` 第十六轮。
>
> 2026-11-08 另新增第 39 条迁移期（非空 38 态）实库规格 `record-package-state.migration.realdb.spec.ts`：默认跳过、未执行；A/B 待授权，C 部分 DDL 续跑为证据缺口。详见 `execution-log.md` 第十七轮。

## 1. 执行前置

- 使用单独授权库（建议 `lithography_v13_verify`），不得复用开发/测试/生产库。
- 保存执行前库名、实例、账号、MySQL 版本与目标库字符集；记录操作人。
- 禁止 `synchronize=true`、禁止 `down()`、禁止清库、禁止导入演示数据。
- 每条规格执行前记录 SQL 与预期错误码；执行后保存 `SHOW CREATE TABLE` 与 `information_schema` 查询结果。

## 2. 结构约束规格

### 2.1 唯一键与一次提交

| 规格                 | 操作                                                                                                      | 预期                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 报修转单唯一         | 对同一 `repair_request_intake.converted_request_id` 先后写入两个不同 `repair_request.id`                  | 第二次写入被 `uk_repair_request_intake_converted` 拒绝（ER_DUP_ENTRY）                              |
| 报修 intake 一对一   | 两条 `repair_request` 使用同一 `intake_id`                                                                | 第二条被 `uk_repair_request_intake` 拒绝                                                            |
| 报修记录编号         | 两条 `repair_request_intake` 使用同一 `record_uuid`                                                       | 第二条被 `uk_repair_request_intake_record_uuid` 拒绝                                                |
| 分析代数             | 同一 `intake_id` 写入两个 `generation_no=1` 的 `intake_analysis_attempt`                                  | 第二条被 `uk_intake_analysis_attempt_generation` 拒绝                                               |
| 问题分析一对一       | 两条 `ai_message_analysis` 使用同一 `question_message_id`                                                 | 第二条被 `uk_ai_message_analysis_question` 拒绝                                                     |
| 报告一次提交         | 同一 `created_by_account_id + owner_organization_id + submission_request_id` 写两条 `maintenance_report`  | 第二条被 `uk_maintenance_report_submission` 拒绝；不同 `submission_request_id` 可写入但需业务层判定 |
| 报告来源版本永久唯一 | 两条 `reference_document` 指向同一 `source_report_version_id`                                             | 第二条被 `uk_reference_document_source_report_version` 拒绝                                         |
| 下架/软删不释放唯一  | 将第一条来源文档 `publication_status='OFFLINE'`、`deprecated=1`、写入 `deleted_at` 后再插第二条同来源版本 | 仍被唯一键拒绝                                                                                      |
| 修订版本唯一         | 同一 `request_id` 写入两个相同 `revision_no`；同一 `document_id` 写入两个相同 `revision_no`               | 分别被 `uk_repair_request_revision_no`、`uk_reference_document_revision_no` 拒绝                    |
| 同步回执唯一         | 同一 `（record_uuid, organization_id, resource_type, version_no）` 写两条（可换 source_system）           | 第二条被 `uk_sync_receipt_scope_v13` 拒绝                                                           |
| 冲突记录唯一         | 同一 `（record_uuid, organization_id, resource_type, version_no）` 写两条冲突                             | 第二条被 `uk_sync_conflict_scope` 拒绝                                                              |
| 记录包条目唯一       | 同一 `（package_id, record_uuid, resource_type, version_no）` 写两条条目                                  | 第二条被 `uk_record_package_item_scope` 拒绝                                                        |
| 设备公司唯一         | 同一 `installation_id + organization_id` 写两条 `local_company_setting`                                   | 第二条被 `uk_local_company_setting_scope` 拒绝                                                      |
| 授权范围唯一         | 同一 `installation_id + account_id + organization_id` 写两条授权                                          | 第二条被 `uk_local_account_authorization_scope` 拒绝                                                |

### 2.2 外键与删除策略

| 规格               | 操作                                                                                         | 预期                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 同报告版本复合外键 | 写入 `source_report_id=A`、`source_report_version_id=属于报告 B 的版本`                      | 被 `fk_reference_document_source_report_version` 拒绝（复合列不匹配） |
| 故障步骤复合外键   | 写入 `maintenance_report_fault.report_id=A`、`step_code` 属于报告 B                          | 被 `fk_maintenance_report_fault_step` 拒绝                            |
| 报修 intake 环依赖 | 先建 `repair_request_intake` 后建 `repair_request(intake_id)`；删除仍被引用的 intake         | 删除被 `fk_repair_request_intake` RESTRICT 拒绝                       |
| 备份资产引用       | 删除仍被 `backup_asset.run_id` / `local_cleanup_run_id` 引用的 `local_backup_run`            | 删除被 RESTRICT 拒绝                                                  |
| 恢复运行引用       | 删除仍被 `backup_restore_run.backup_id` / `protection_backup_id` 引用的 `backup_asset`       | 删除被 RESTRICT 拒绝                                                  |
| 设备授权引用       | 删除仍被 `local_account_authorization` / `local_company_setting` 引用的 `local_installation` | 删除被 RESTRICT 拒绝                                                  |

### 2.3 NULL 安全 CHECK

| 规格               | 操作                                                                                                         | 预期                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 新报修必须有双公司 | `repair_request.intake_id` 非空但 `customer_organization_id` 或 `service_organization_id` 为空               | 被 `chk_repair_request_new_intake_companies` 拒绝                                                      |
| 旧报修保留空归属   | `repair_request.intake_id IS NULL` 且两个组织字段为 NULL                                                     | 允许写入；不得用该条件单独证明历史                                                                     |
| 结单成对           | `closure_status='CLOSED'` 但 `closed_at` 为空，或非 CLOSED 却有 `closed_at`                                  | 被 `chk_repair_request_closure` 拒绝                                                                   |
| 结单原因           | `closure_status='CLOSED'` 且 `closure_reason` 为空/空白                                                      | 被 `chk_repair_request_closure_reason` 拒绝                                                            |
| 当前修订号         | `current_revision_no < 0`                                                                                    | 被 `chk_repair_request_current_revision` 拒绝                                                          |
| AI 会话内容版本    | `content_version < 0`                                                                                        | 被 `chk_ai_conversation_content_version` 拒绝                                                          |
| AI 消息内容版本    | `content_version < 0`                                                                                        | 被 `chk_ai_message_content_version` 拒绝                                                               |
| 报告提交成对       | 仅填 `submission_request_id` 或仅填 `submission_payload_hash`                                                | 被 `chk_maintenance_report_submission_pair` 拒绝                                                       |
| 报告闭合原因       | `closure_reason` 越界值                                                                                      | 被 `chk_maintenance_report_closure_reason` 拒绝                                                        |
| 来源成对           | `source_report_id` 与 `source_report_version_id` 只有一个非空                                                | 被 `chk_reference_document_report_source_pair` 拒绝                                                    |
| 来源内容分支       | `source_kind='MATERIAL'` 却无正文/存储引用，或报告来源缺 ID                                                  | 被 `chk_reference_document_content_source_v13` 拒绝                                                    |
| 归属状态           | `ownership_status='CONFIRMED'` 且 `owner_organization_id` 为空                                               | 被 `chk_reference_document_ownership` 拒绝                                                             |
| 原件状态           | `status='VALID'` 但 `verified_at` 为空                                                                       | 被 `chk_stored_file_verified` 拒绝                                                                     |
| 原件绑定成对       | `binding_status` 与 `business_type/business_id` 不成对                                                       | 被 `chk_stored_file_binding_pair` 拒绝                                                                 |
| 分析失败原因       | `intake_analysis_attempt.status='FAILED'` 且 `failure_reason` 为空                                           | 被 `chk_intake_analysis_attempt_failure` 拒绝                                                          |
| 问题分析完成时间   | 非 PENDING/RUNNING 且 `completed_at` 为空                                                                    | 被 `chk_ai_message_analysis_completed` 拒绝                                                            |
| 快照 JSON 版本     | `repair_request_revision.snapshot` 的 JSON 无 `schema_version` 或与列值不一致                                | 被 `chk_repair_request_revision_schema` 拒绝                                                           |
| 修订上一版本顺序   | `previous_version` 为 `NULL`（43 条前历史行）、`0`（首版）或小于 `revision_no`                               | `NULL`/`0`/小于均通过；等于或大于 `revision_no` 被 `chk_repair_request_revision_previous_version` 拒绝 |
| 文档修订快照版本   | `reference_document_revision.snapshot` 的 JSON 无 `schema_version`                                           | 被 `chk_reference_document_revision_schema` 拒绝                                                       |
| 同步回执确认时间   | 非 PENDING/CONFLICT 且 `received_at` 与 `confirmed_at` 均为空                                                | 被 `chk_sync_receipt_confirm_time` 拒绝                                                                |
| 冲突确认人         | 状态为已确认但 `confirmed_by_account_id` 为空                                                                | 被 `chk_sync_conflict_confirmed` 拒绝                                                                  |
| 备份云回执         | `cloud_status='SUCCEEDED'` 且 `cloud_receipt` 为空                                                           | 被 `chk_backup_asset_cloud_receipt` 拒绝                                                               |
| 恢复保护备份       | `protection_backup_id` 等于 `backup_id`                                                                      | 被 `chk_backup_restore_run_protection` 拒绝                                                            |
| 备份运行结束时间   | `status='RUNNING'` 且有 `finished_at`，或非 RUNNING 无 `finished_at`                                         | 被 `chk_local_backup_run_finish` 拒绝                                                                  |
| 备份调度组合       | `backup_enabled=1` 且 `next_backup_at IS NULL`                                                               | 被 `chk_local_company_setting_backup_schedule` 拒绝                                                    |
| 自动上传组合       | `auto_upload_enabled=1` 且 `backup_enabled=0`                                                                | 被 `chk_local_company_setting_auto_upload` 拒绝                                                        |
| 恢复检查结论域     | `check_status NOT IN ('PENDING','PASSED','FAILED')` 且非 NULL                                                | 被 `chk_backup_restore_run_check_status` 拒绝                                                          |
| 恢复检查结论组合   | `status='FAILED/INTERRUPTED'` 且 `check_status='PASSED'`，或 `status='SUCCEEDED'` 且 `check_status='FAILED'` | 被 `chk_backup_restore_run_check_outcome` 拒绝                                                         |
| 故障阶段码域       | `phase_code` 非空且不在 `PHASE_01`—`PHASE_10`                                                                | 被 `chk_maintenance_report_fault_phase_code` 拒绝                                                      |
| 故障有效标记       | `is_active` 非空且不在 `(0,1)`                                                                               | 被 `chk_maintenance_report_fault_active` 拒绝                                                          |

历史未知的表示：上述新事实列（`source_installation_id`、`backup_asset` 的安装/版本/校验列、`check_status`、`target_installation_id`、`phase_code`、`is_active`）对旧行为 NULL；NULL 一律表示“无法从旧行证明”，不得在读取层当作通过、授权或已确认。新流程由写入者按 §13.8.2 保证完整性。

非空旧数据升级场景由 `s5-remaining-decisions.migration.spec.ts` 离线覆盖（不实库执行）：旧行原值保留、新列保持 NULL、故障生命周期与原始字段不互转、非法组合被拒绝、四列重复组在首次 DDL 前失败、部分 DDL 诊断边界与回退顺序。

> 2026-11-08 实测校正（第十二轮，`lithography_v13_spec`）：`repair_request_revision` 缺 `schema_version` 时 `JSON_EXTRACT` 为 SQL NULL，CHECK 求值 UNKNOWN 被放行（**真实约束缺陷**）；JSON null 与类型错误、与列值不等均被 `ER_CHECK_CONSTRAINT_VIOLATED / 3819 / HY000` 拒绝。`reference_document_revision` 缺键被拒，但 JSON null 因 `IS NOT NULL` 成立被放行（**真实约束缺陷**）；JSON null 之外的任意非空值也未受类型约束。详见 `execution-log.md` 第十二轮。

> 2026-11-08 修复已执行（第十三轮，`lithography_v13_spec`）：第 38 条迁移 `1775501600000` 在预检零违规后重建四条 CHECK，`repair_request_revision` 两侧保留与独立 `schema_version` 列相等；实库定向 2.4 共 24 项通过（合法值、两侧分别缺键、两侧分别 JSON null、repair 单侧等值不符），原先两条失败用例现已按目标约束被 3819/HY000 拒绝。

### 2.5 记录包检查/导入状态（第 39 条）

| 规格           | 操作                                                                        | 预期                                                           |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 检查通过未导入 | `check_status='PASSED'` 且 `status='PENDING'`                               | 允许写入（检查结论不表示导入成功）                             |
| 检查拒绝不导入 | `check_status='REJECTED'` 且 `status` 为 `RUNNING/SUCCEEDED/PARTIAL/FAILED` | 被 `chk_record_package_import_check_stage` 拒绝                |
| 检查未完成     | `check_status='PENDING'` 且 `status='RUNNING'`                              | 被 `chk_record_package_import_check_stage` 拒绝                |
| 历史未判定     | `check_status=NULL` 且 `status='SUCCEEDED/PARTIAL/RUNNING'`                 | 被 `chk_record_package_import_check_stage` 拒绝；`FAILED` 允许 |
| 包检查非法枚举 | `check_status='UNKNOWN'`                                                    | 被 `chk_record_package_import_check_status` 拒绝               |
| manifest 版本  | `manifest_json` 合法含 `schema_version` / 缺键 / 值为 JSON null             | 合法写入；后两者被 `chk_record_package_import_manifest` 拒绝   |
| 同包重试       | 相同 `package_id` 第二次插入                                                | 被主键拒绝；不得换号绕过去重                                   |
| 条目未执行     | `result=NULL` 且 `check_result=NULL`                                        | 允许写入                                                       |
| 条目四类结果   | `SUCCEEDED`+检查通过、`SKIPPED`/`CONFLICT` 历史未判定、`FAILED`+原因        | 允许写入                                                       |
| 条目成功前提   | `result='SUCCEEDED'` 且 `check_result=NULL`                                 | 被 `chk_record_package_item_check_stage` 拒绝                  |
| 条目检查拒绝   | `check_result='REJECTED'` 且 `result` 为任一非空值                          | 被 `chk_record_package_item_check_stage` 拒绝                  |
| 条目非法枚举   | `result='PENDING'` 或 `check_result='UNKNOWN'`                              | 分别被结果/检查域约束拒绝                                      |

> 旧行兼容、无法判定旧数据的预检拒绝、跨表部分 ALTER 失败与受控续跑，属于迁移期行为，由
> `src/infrastructure/database/record-package-state.migration.spec.ts` 以纯替身覆盖；不在已升级库上复现。

## 3. 事务规格

| 规格             | 操作                                                                                          | 预期                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 一次提交原子性   | 在同一事务内插入报告头与步骤，故意让第二步失败                                                | 事务回滚后无报告头、无步骤、无提交请求号残留                                                                                         |
| 转单原子性       | 同一事务内插入 `repair_request` 并回写 `repair_request_intake.converted_request_id`，中途失败 | 两侧均回滚，intake 仍为未转单                                                                                                        |
| 分析重试原子推进 | 并发两次把 `analysis_generation` 从 0 推进到 1                                                | 仅一次成功；失败方收到唯一键/乐观锁冲突，不生成第三条尝试记录                                                                        |
| 修订追加原子性   | 同一事务写修订快照并推进 `current_revision_no`                                                | 修订号连续；`previous_version` 等于写入前 `current_revision_no`（首版为 0）；中断后 `current_revision_no` 不超前于最大 `revision_no` |
| 管理员映射原子性 | 映射文件含一个不存在的公司编码                                                                | 整个映射事务回滚，不部分创建账号                                                                                                     |

### 3.1 初始化数据与重复执行（组织／管理员／开发样例）

> 目标：一个 `--mode=init` 命令闭合结构与所选初始化；重复执行不重建、不重置、不覆盖。
> 本组规格在授权的独立验收库执行，使用库外真实映射与强密码；不在本文件保存任何真实凭据。

| 规格             | 操作                                                                          | 预期                                                                              |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 组织受控创建     | 空库执行 init，提供组织映射                                                   | 公司按编码创建；重复执行返回 `UNCHANGED`，不重复插入                              |
| 组织身份冲突     | 映射中同一编码的 `kind`/`is_managed_company`/`is_service_provider` 与库内不同 | 失败关闭；不覆盖既有公司；init 数据事务整体回滚                                   |
| 1 级管理员公司   | 1 级管理员映射到非 `CLIENT` 公司                                              | 失败关闭，不创建账号                                                              |
| 2 级管理员公司   | 2 级管理员映射到 `is_managed_company=0` 公司                                  | 失败关闭，不创建账号                                                              |
| 默认 6 管理员    | 使用默认模板（1 级 3 个、2 级 3 个）执行 init                                 | 6 个账号均为 ACTIVE、资料 ACTIVE、三源角色事实一致、公司归属正确、成员关系 ACTIVE |
| 密码策略         | 管理员或开发账号密码不符合项目策略                                            | 在任何账号/资料写入前失败；不打印密码                                             |
| 重复执行不重置   | 修改库外映射中的密码后再次 init                                               | 既有账号返回 `UNCHANGED`；库内密码哈希不变                                        |
| 冲突身份拒绝     | 既有账号已带管理员等级，又被开发样例映射引用                                  | 失败关闭；不改等级、不改公司、不接管                                              |
| 开发样例默认关闭 | init 不提供 `--dev-accounts-file`                                             | 不创建任何客户/工程师样例账号                                                     |
| 开发样例目标库   | `--dev-accounts-file` 指向库名不含 `test/dev/local/drill` 的库                | 连接与写入前拒绝                                                                  |
| 默认开发样例     | 目标为开发库，使用默认模板（客户 2 个、工程师 2 个）                          | 客户/工程师角色、资料、公司归属、成员关系均正确；不生成工单/报告/审批历史         |
| 开发样例重复执行 | 再次执行同一 init                                                             | 全部返回 `UNCHANGED`；不重置密码、不重复成员关系                                  |
| 开发样例事实不全 | 既有账号缺 ACTIVE 成员关系或角色事实不一致                                    | 失败关闭，不自动授予资格                                                          |
| 事务原子性       | 映射中第 2 个账号的公司编码不存在                                             | 组织、管理员、开发样例全部回滚；库内无部分新增                                    |

### 3.2 D3 新库一键部署验收结果（2026-11-09）

授权实例 `909f9587-9fce-11f1-a353-00e0709ef3a9`（MySQL 8.0.46，`127.0.0.1:3306`），本轮创建并只操作 `lithography_v13_delivery_dev`；未触碰其他库。凭据、映射与证据在库外 `0700` 目录、`0600` 文件（`/home/gandiantx/.local/share/lithography-v13-d3-evidence`），不记录明文密码、完整哈希、密文或令牌。

口径澄清：“结构契约 202 列”是 `migration-schema-contract.ts` 的 `REQUIRED_COLUMNS`，即 V13 变更列子集，**不等于全表字段**。实库最终为 **51 张业务表、711 列、252 个索引、110 个外键、196 条 CHECK、4 个生成列**；全字段实际清单见证据 `03-sql/final-columns.txt`，设计逐行对照见 [S1](S1-object-and-field-dictionary.md)。本轮未发现契约列缺失；既有 34 表的逐字段语义复核沿用 S1，未在本轮重做。

> **2026-11-09 更正（保留上方历史证据，不覆盖当时结论）**：D3 的“4/4 通过、零残留”建立在按登录名/公司编码清理夹具的规格上；复核发现 INSERT 碰撞时存在误登记并可能按名称删除异主行的风险。同时，本节的空库结构校验当时只核对数量与名称，未覆盖“同名但类型/可空/默认值/索引列/外键目标/CHECK 表达式不同”的定义漂移。因此上述历史结果不得再表述为“全部结构已核对”或“清理零风险”。修复项：新增第 42 条修复迁移、D3 规格改为事务回滚＋真实 ID 账本、空库校验增加定义级比较；均待新一轮空库与约束/清理专项实库验收。

| 步骤 (命令要点)                                    | 结果                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 正式 init：组织+6 管理员，无开发选项               | 退出码 0；41 条迁移；6 管理员（1 级 3、2 级 3）；CUSTOMER/ENGINEER=0；verify 通过       |
| 同命令重跑                                         | 退出码 0；迁移 0 条；账号/资料/成员全部 `UNCHANGED`；快照逐项相等                       |
| 映射换另一组合规密码重跑                           | 退出码 0；既有密码哈希不变（原密码仍验证通过，快照相等）                                |
| 加 `--dev-accounts-file` + 确认                    | 退出码 0；客户 2、工程师 2；`must_change_password=0`；ACTIVE 成员与公司正确；无审批历史 |
| 开发模式重跑                                       | 退出码 0；全部 `UNCHANGED`；快照相等                                                    |
| 去掉开发选项再跑                                   | 退出码 0；既有 2+2 开发账号不新增、不删除                                               |
| 相同编码、不同名称的组织映射                       | 退出码 0；输出“名称/简称不同、未覆盖”告警；库内名称不变                                 |
| 版本化约束/事务专项 `v13-d3-constraint-acceptance` | 退出码 0；4/4 通过；夹具事务回滚，零残留                                                |

账号事实（非秘密）：`d3-admin-l1-01..03`（1 级→`D3-CLIENT-A`）、`d3-admin-l2-01..03`（2 级→`D3-PEER-A`），均 `must_change_password=1`；`d3-customer-01/02`（→`D3-CLIENT-A`）、`d3-engineer-01/02`（→`D3-PEER-A`），均 `must_change_password=0`。工程师资格按 ACTIVE ENGINEER 成员关系认定，未构造注册/审批历史。

约束专项覆盖：生成列四类实际计算与关联唯一冲突；SQL NULL 与 JSON null；非法枚举/状态/等级；唯一键；复合外键；RESTRICT；错误公司；等级冲突；邮箱碰撞；弱密码与缺确认在写入前拒绝；初始化事务内第二次写入失败后整体无部分新增。证据：`05-constraints/constraint-acceptance.log`、`06-final/final-state.txt`。

未覆盖：旧库升级起点仍未确认，不得把本次新库验收称为旧库升级验收；未验证旧业务 API、页面、真实登录或完整 core；未重做前 31 条迁移中既有字段的逐字段语义复核。

## 4. 清理入口规格

| 入口                               | 规格                            | 预期                                                                                                   |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `test/utils/e2e-scoped-cleanup.ts` | 先删被新表引用的 `organization` | 被 RESTRICT 拒绝；必须按新表 → 旧表顺序清理                                                            |
| `test/utils/e2e-scoped-cleanup.ts` | 清理 `local_installation`       | 先清 `local_account_authorization`、`local_company_setting`、`backup_asset`、`backup_restore_run` 引用 |
| `test/utils/e2e-owned-fixture.ts`  | 清理自有报告/原件               | 先清 `maintenance_report_fault`、`reference_document_revision`、`reference_document`，再清报告版本     |
| `test/utils/e2e-db-guard.ts`       | 检查清理后残留                  | 新表零残留；`reference_document` 的来源唯一键不因清理失败残留                                          |
| 专用清理入口                       | 备份资产与手动上传/清理         | 先清 `backup_restore_run`，再清 `backup_asset`，最后清 `local_backup_run`                              |

## 5. 状态

| 项                                   | 状态                             |
| ------------------------------------ | -------------------------------- |
| 不连库定向单测（契约/参数/映射解析） | 本轮已执行，见执行记录           |
| 目标结构 SQL 验证                    | D3 已执行（§3.2，51 表/711 列）  |
| 约束写入拒绝验证                     | D3 已执行（4/4 专项通过）        |
| 事务回滚验证                         | D3 已执行（无部分新增）          |
| 初始化数据与幂等（§3.1）             | D3 已执行（默认与开发模式）      |
| 清理入口顺序验证                     | 未执行（超出 D3 范围）           |
| MySQL 版本/字符集/时区确认           | 已确认 8.0.46 / utf8mb4 / +08:00 |
