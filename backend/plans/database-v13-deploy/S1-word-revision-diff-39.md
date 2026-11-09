# 原始冻结 Word 差异清单（第 39 条迁移相关）

> 原始依据：《数据库设计 V1.1》第 4 章 §4.13/§4.14（文档段落 4308—4393）与功能 V5.3。
> **不覆盖原始 Word**。本清单仅列出需要修订的文字/字段差异，供评审后统一回写。
> 实现事实以代码与迁移为准；本轮不写库、不 commit。

## 1. `record_package_import`（Word §4.13）

| Word 原文/意图                         | 实际实现                                             | 差异性质 | 建议修订文字                                                        |
| -------------------------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `id` bigint 自增PK                     | `package_id` char(36) 主键                           | 等价替换 | 删除 `id`；以 `package_id` 作为稳定包编号与主键，并注明重试复用规则 |
| `package_uuid` char(36)                | 合并为 `package_id`                                  | 等价命名 | 合并两列；说明“稳定包编号即主键，不再另设 uuid”                     |
| `actor_account_id`                     | `imported_by_account_id`                             | 等价命名 | 改名为 `imported_by_account_id`，语义为“检查/导入操作者”            |
| `format_version` int unsigned NOT NULL | 无独立列                                             | 能力调整 | 删除独立列；版本以 `manifest_json.schema_version` 为单一来源        |
| `manifest` json                        | `manifest_json` longtext                             | 等价命名 | 改名为 `manifest_json`，按 JSON 文本存储并做 JSON 校验              |
| `check_status` varchar(16) NOT NULL    | 可空，新增于第 39 条                                 | 语义修正 | 改为可空；`NULL`=历史未判定，`PENDING/PASSED/REJECTED`              |
| `import_status`                        | `status`                                             | 等价命名 | 改名 `status`，明确仅表示导入阶段                                   |
| 未列出计数/完成时间                    | `item_total/item_succeeded/item_failed/completed_at` | 实现补充 | 增补四列；计数和不得超总数                                          |

## 2. `record_package_item`（Word §4.14）

| Word 原文/意图                      | 实际实现                                                         | 差异性质            | 建议修订文字                                                   |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `package_id` bigint FK              | `package_id` char(36) FK                                         | 类型修正            | 改为 char(36)，引用 `record_package_import.package_id`         |
| UK 仅“package_id、version_no”       | 四元组 UK `(package_id, record_uuid, resource_type, version_no)` | 实现补充            | 补全唯一键列，注明用于同包同条重复识别                         |
| `check_result` varchar(16) NOT NULL | 可空，新增于第 39 条                                             | 语义修正            | 改为可空；`NULL`=未完成或历史未判定，`PASSED/REJECTED`         |
| `import_result` varchar(24) 可空    | `result` varchar(16) 可空                                        | 等价命名 + 枚举补充 | 改名 `result`，合法值 `NULL/SUCCEEDED/FAILED/SKIPPED/CONFLICT` |
| `failure_reason` text               | `error_message` text                                             | 等价命名            | 改名 `error_message`；`FAILED` 时必填非空白                    |
| `receipt_id` bigint                 | `receipt_id` char(36)                                            | 类型修正            | 改为 char(36)，引用 `sync_receipt.receipt_id`                  |
| 未列出创建时间                      | `created_at` timestamp(3)                                        | 实现补充            | 增补创建时间                                                   |

## 3. 状态语义文字（Word §4.13/§4.14 说明段）

建议新增一段原文（不改已有业务语义）：

- 包检查与包导入分别表达：`check_status` 只表示检查结论，`status` 只表示导入阶段；
- 条目检查与条目导入分别表达：`check_result` 只表示逐条检查结论，`result` 只表示逐条导入结果；
- 检查未完成或拒绝不得表示导入成功；`SUCCEEDED` 必须已有检查通过；
- 同包重试必须复用原 `package_id`，同一文件新内容不得重新生成编号绕过去重；
- 历史无法证明的检查结论保持 `NULL`，读取语义为“历史未判定”，不冒充“检查未完成”；
- 无法解析文件默认不新增独立审计记录。

## 4. 不需修订项

- 表名、公司归属、导入者外键意图、包与条目分离、删除策略 RESTRICT；
- R070—R073 的业务结论（包属性/稳定编号/版本/清单校验、四类导入结果、检查合格前提、按阶段查询）。

## 5. 回写方式

- 评审通过后由文档负责人在原始 Word 上修订；本清单不自动合并、不覆盖原件；
- 若评审否决任一差异，需同步回退代码/迁移/契约，不保留“文档与实现并存”的分裂状态。
