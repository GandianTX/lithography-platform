# 任务 07 / 09：维修记录同步状态对接草案 v0.1

供蔡、薛确认。依据任务 07 当前源码中的 Entity 和迁移整理，未查询实库；JSON 是服务端批量读取契约样例，不是已经上线的 API。

## 1. 谁做什么

- 任务 07 沿用「我的资料记录」列表和详情：先查有权记录，再在用例层批量查询当前页的同步状态，最后把可展示的状态附到记录上。详情复用同一接口，传一条记录即可。不新增浏览器直调的同步查询端点。
- 任务 09 提供同步状态查询的真实实现，负责聚合业务任务、完整回执及有效冲突，并负责冲突详情、对比和处理权限。任务 07 只展示状态，以及有权处理时的入口。
- 未接任务 09 前，在任务 07 用例层预留窄的 `*.contract.ts` 边界。默认实现不查同步表、不触发上传，返回「未接入」；测试可注入替身。接口传输方式及落地路径另行对齐，不为预留另建队列或外部 API。

## 2. 现有字段如何对应

| 契约字段 | 现有结构和边界 |
| --- | --- |
| `organizationId` | 从已授权的报告资源 `maintenance_report.owner_organization_id` 取值，对照回执和冲突的 `organization_id`。不是前端输入，也不是查一级管理员的技术归属。 |
| `resourceType` | 对应 `sync_receipt.resource_type`、`sync_conflict.resource_type`。样例的 `MAINTENANCE_REPORT` 是待确认的值，不是现行枚举；历史报告、工单总结是报告的 `source_type`，不要直接当同步资源类型。`local_upload_task.entity_type` 是分项类型（如 `REPORT_VERSION`、`ATTACHMENT`），不是同一字段。 |
| `recordUuid` | 对应任务、回执、冲突的 `record_uuid`。当前 `maintenance_report` 和 `reference_document` 没有这一列，任务 09 须与任务 06/07 对齐其持久来源和查找方式。不用 `report.id`、`entity_local_id` 或 `submission_request_id` 冒充跨端 UUID。 |
| `sourceVersion` | 对应 `local_upload_task.source_version` 和 `sync_receipt.version_no`；匹配冲突时核对 `sync_conflict.local_version`，不能把历史字段 `sync_conflict.version_no` 当成本地版本。正式报告可考虑映射 `maintenance_report_version.version_no`，待任务 09 确认；资料管理修订版本不得冒充报告同步版本。 |
| `conflictId` | 来自 `sync_conflict.conflict_id`；只在当前版本确有待处理冲突且用户有处理权时提供入口。任务 09 打开和确认处理时仍须重新核权。 |

**现阶段的真实断点：**报告查询已有报告 ID 和 `current_version_no`，但草稿的 `current_version_no=0`，不能区别两次草稿编辑。如果任务 09 要同步草稿，需要另有可信的业务版本映射；映射未确认时不给草稿填造假的 UUID 或版本，不发真实查询，状态为未知。此次预留不要求改表，也不承诺草稿同步已经可用。

## 3. 批量请求与返回

- [请求 JSON](task07-task09-sync-status-request.example.json) 与 [返回 JSON](task07-task09-sync-status-response.example.json) 按四个字段精确对应：公司、资源类型、记录 UUID、当前业务版本。调用者身份通过可信服务端会话单独传递，不在 JSON 中接受浏览器自报。
- `local_upload_task` 没有直接的 `organization_id` 或 `resource_type` 列。任务 09 须用可信来源确定安装实例、公司及资源关联（例如核验 `installation_id` 对应的安装归属以及任务绑定）；仅按 UUID 查任务不够。归属不能确认则不返回该任务的状态。
- 任务 07 按完整键匹配返回行，不采用顺序匹配。漏项、重复结果、旧版本或同步查询异常，均不把该条判成成功，也不影响原记录的列表、分页数量和详情。

## 4. 状态约定

以下是展示状态，不是把数据库枚举原样透传：

| 状态 | 判定 |
| --- | --- |
| `NOT_CONNECTED` | 任务 07 尚未装配任务 09 的实现。 |
| `UNKNOWN` | 无法确认身份范围、映射或当前版本结果，或查询暂不可用。 |
| `NOT_APPLICABLE` | 后端明确确认该记录不走本地同步；不能用「缺任务」推断。网页版可隐藏同步列，只显示草稿／已入库。 |
| `NO_TASK` | 适用同步且已准确查询，但当前版本尚无任务；不是失败也不是成功。 |
| `PENDING` / `UPLOADING` / `FAILED` | 取任务 09 聚合后的当前版本业务任务状态，只看 `BUSINESS_SYNC`，不混入 `BACKUP_UPLOAD`。旧行缺关键字段或仅剩取消任务时，不能推断已同步。 |
| `SYNCED` | 当前版本有匹配的 `SUCCEEDED` 回执，任务 09 验证清单校验值与实际应同步的正文、有效原件完整一致；仅见任务 `SUCCEEDED` 或旧版本回执不算成功。 |
| `CONFLICT` | 任务 09 确认当前版本存在未解决的冲突。只有 `canResolveConflict=true` 且具备有效冲突标识时才显示处理入口；处理返回后重新查状态。 |

任务 09 返回的 `message` 仅限面向用户的安全提示，不透传快照、回执正文、内部错误或文件路径。任务状态和回执矛盾时由任务 09 明确裁决；未确认前不显示成功。

## 5. 交付与验收

请薛确认：① UUID 的来源；② 正式／草稿版本映射；③ `resourceType` 取值与本地任务的公司、安装归属匹配；④ 完整回执判定与状态优先级；⑤ 冲突标识、处理权限和页面路由。确认前，任务 07 可先做默认适配与替身测试，不能绑定不存在的 API。

最低验收：批量查询一页只调用一次；一级管理员的技术成员关系不作资料公司筛选；非本人或无权资源不进入本页的同步查询；旧版本回执、仅任务成功、缺任务均不显示已同步；无处理权不显示处理入口；同步查询异常不影响记录阅读。真实同步、完整回执和冲突处理由任务 09 联调验收。
