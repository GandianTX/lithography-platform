# S0 基线盘点与输入冻结

> 本文件只记录事实与证据；未修改任何业务代码、Entity、Migration，未连接数据库，未执行 build/install/seed/清理/commit/push/PR。

## 1. 本轮范围与硬边界

- 执行 `database-v13-deployment-plan.md` 的 S0＋S1：基线盘点、需求映射、设计清单、未决问题与执行记录。
- 不进入实现：不改业务代码/Entity/Migration，不建库、不迁移、不 Seed、不清理、不 commit/push、不创建 PR。
- 不自行切分支、merge、stash、reset；保留工作区与暂存区全部已有改动。
- 不覆盖原始 Word（`/home/gandiantx/temp` 下四份文档只读；V13 Excel 只读）。

## 2. 输入冻结与指纹

| 文件                                                                    | 版本                    | 位置                                                                                                                                     | SHA-256                                                            | 结论                                                             |
| ----------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `一键部署数据库开发任务书-V1.0-基于功能V5.3与页面V6.3-20261107.docx`    | 任务书 V1.0 / 20261107  | `/home/gandiantx/temp/一键部署数据库开发任务书-V1.0-基于功能V5.3与页面V6.3-20261107.docx`                                                | `b335a7ba177026034f4456870d044fb1711ef13801d695db9fad7ba4c2b28fa2` | 与主计划 1.1 指纹一致，冻结                                      |
| `按功能划分-功能需求文档-V5.3-提交幂等与生效修订-基于V13-20261107.docx` | 功能 V5.3 / 20261107    | `/home/gandiantx/temp/按功能划分-功能需求文档-V5.3-提交幂等与生效修订-基于V13-20261107.docx`                                             | `b162a51d37afe7f3e1557dec3836b63bb4ff5b8df78ebb1a2c98a6ee8f6fe890` | 与主计划 1.1 指纹一致，冻结                                      |
| `按页面划分-页面需求文档-V6.3-提交幂等与生效修订-基于V13-20261107.docx` | 页面 V6.3 / 20261107    | `/home/gandiantx/temp/按页面划分-页面需求文档-V6.3-提交幂等与生效修订-基于V13-20261107.docx`                                             | `3756789546551d5098258914a8c6d542b818593b1b339364730300ecae429f0c` | 与主计划 1.1 指纹一致，冻结                                      |
| `数据库表设计说明-V1.1-基于V13功能V5.3-配套页面V6.3-20261107.docx`      | 表说明 V1.1 / 20261107  | `/home/gandiantx/temp/数据库表设计说明-V1.1-基于V13功能V5.3-配套页面V6.3-20261107.docx`                                                  | `c1da2ac26eb9dd33e91a58b3136cf278bdc12caad0dff19c9be0d2c396b6e0d8` | 与主计划 1.1 指纹一致，冻结                                      |
| `光刻机AI智能故障诊断_需求确认清单_V13_会议对齐版_20261106.xlsx`        | 需求清单 V13 / 20261106 | `/home/gandiantx/.codex/attachments/ad730321-068a-40a1-a61f-3a07767cfbce/光刻机AI智能故障诊断_需求确认清单_V13_会议对齐版_20261106.xlsx` | `47f089263908aee635779e010028335a65bd0505930d248b9a5ce188bb8d8887` | 指纹已记录；文件名/内容/版本一致，OI-09 已明确（目录不作为阻塞） |

说明：四份 Word 的全 SHA-256 与主计划 1.1 记录的指纹一致，未用旧版替代。V13 Excel 位于附件目录而非 `/home/gandiantx/temp`，已按用户提供件读取并记录指纹；文件内为 91 条需求（R001—R048、R050—R092，R049 不存在）。**OI-09 已明确：附件目录不作为阻塞，以文件名、内容与指纹确认该件即为指定 V13，不再要求确认存放目录。**

## 3. Git / PR / CI 基线

### 3.1 本地状态（只读采集）

```text
== BRANCH ==
feat/maintenance-data-increment
== HEAD ==
3821e71ccb7b8caa18e1ad4d695cff21b0e7832c
== STATUS ==
 M backend/plans/README.md
?? backend/plans/database-v13-deployment-plan.md
== STATUS COUNT ==
2
== STAGED ==
== UNSTAGED ==
M	backend/plans/README.md
== REMOTES ==
origin	https://github.com/GandianTX/lithography-platform.git (fetch)
origin	https://github.com/GandianTX/lithography-platform.git (push)
upstream	https://github.com/litho-ai-support/lithography-platform.git (fetch)
upstream	https://github.com/litho-ai-support/lithography-platform.git (push)
== REMOTE MAIN ==
795eb577f45e5ece4694dec5efa322aba1ef9a3a
cc4c87e57e328eee3893a07f3776880f56e1b226
== BRANCH -vv ==
  backup/feat-auth-shell-before-split 428a8d1 feat(frontend): 根路由登录态自动分发并移除旧首页
  feat/admin-user-management          7e6297a [upstream/feat/admin-user-management: 领先 2] Merge remote-tracking branch 'origin/main' into feat/admin-user-management
  feat/auth-shell                     428a8d1 [upstream/feat/auth-shell] feat(frontend): 根路由登录态自动分发并移除旧首页
  feat/engineer-repair-complete       67cc444 [upstream/feat/engineer-repair-complete: 领先 2] Merge remote-tracking branch 'origin/main' into feat/engineer-repair-complete
  feat/engineer-repair-handle         94d390f [upstream/feat/engineer-repair-handle: 丢失] fix(repair-request): enforce active role and reconcile acceptance
  feat/engineer-response              e3cd5e7 [upstream/feat/engineer-response: 丢失] fix(repair-request): guard response reconciliation and text capacity
  feat/login-auth-session-clean       692f4bc [upstream/feat/login-auth-session-clean: 丢失] feat(auth): implement login session and role routing
* feat/maintenance-data-increment     3821e71 [origin/feat/maintenance-data-increment] fix(test): require creation ownership for trigger teardown
  fix/auth-admin-visual-finish        9c465f4 [upstream/fix/auth-admin-visual-finish] fix(e2e): 夹具登记先于写文件且恢复事务锁行写前核验
  fix/auth-token-expiry-feedback      355cca2 [upstream/fix/auth-token-expiry-feedback: 丢失] fix(auth): handle expired sessions with safe return
  main                                795eb57 [origin/main] Merge pull request #1 from GandianTX/feat/data-collection-core
== STASH ==
stash@{0}: On fix/auth-admin-visual-finish: pre-merge-pr5-main-sync
stash@{1}: On feat/engineer-repair-complete: pr4-wip-before-merge-main-20260923
stash@{2}: On feat/admin-user-management: pre-merge-admin-user-management
== AHEAD/BEHIND upstream ==
0	22
== LAST 8 ==
3821e71 fix(test): require creation ownership for trigger teardown
09c1351 fix(database): close authorization and fixture cleanup review gaps
eb0619a fix(account): enforce organization boundaries and safe e2e teardown
e4dca62 fix(database): close cleanup and constraint review gaps
24f7565 feat(registration): add organization-scoped engineer approval
30c2732 fix(test): guard maintenance fixture cleanup and race teardown
ec11508 feat(database): add organization-scoped maintenance records
795eb57 Merge pull request #1 from GandianTX/feat/data-collection-core
```

### 3.2 远端实际 SHA（`git ls-remote`，未 fetch）

```text
== ls-remote origin main ==
72de1096d0a2aa2d62ed55a48ab49ebc3398000a	refs/heads/main
== ls-remote upstream main ==
cc4c87e57e328eee3893a07f3776880f56e1b226	refs/heads/main
== ls-remote origin branch ==
3821e71ccb7b8caa18e1ad4d695cff21b0e7832c	refs/heads/feat/maintenance-data-increment
== ls-remote upstream branch ==
```

### 3.3 PR 状态

```text
== fork repo PRs ==
2	feat(database): 补齐组织隔离、维修报告与工程师注册审核数据闭环	feat/maintenance-data-increment	MERGED	2026-10-30T06:13:22Z
1	feat(PR0): 资料采集数据库与公共接口基础	feat/data-collection-core	MERGED	2026-10-25T16:10:14Z
== upstream repo PRs ==
21	Feat/maintenance data increment	GandianTX:feat/maintenance-data-increment	CLOSED	2026-10-30T06:06:22Z
20	Feat/data collection core	GandianTX:feat/data-collection-core	CLOSED	2026-10-25T12:39:54Z
19	Fix/auth admin visual finish	fix/auth-admin-visual-finish	MERGED	2026-10-03T05:02:11Z
18	Fix/customer document visual finish	fix/customer-document-visual-finish	MERGED	2026-09-30T10:48:37Z
17	Feat/engineer repair complete	feat/engineer-repair-complete	MERGED	2026-09-25T05:14:53Z
16	Feat/document database	feat/document-database	MERGED	2026-09-21T15:54:50Z
15	Feat/admin user management	feat/admin-user-management	MERGED	2026-09-18T12:16:39Z
14	Feat/gkj visual shell	feat/gkj-visual-shell	MERGED	2026-09-15T03:44:52Z
12	feat(admin-users): add super admin user management	feat/admin-user-management	MERGED	2026-09-11T10:43:25Z
11	Feat/reference document library	feat/reference-document-library	MERGED	2026-09-09T05:58:33Z
10	feat(repair-request): add engineer response workflow	feat/engineer-response	MERGED	2026-09-04T04:43:36Z
9	Feat/engineer repair handle	feat/engineer-repair-handle	MERGED	2026-09-02T10:41:58Z
8	Feat/customer repair manage	feat/customer-repair-manage	MERGED	2026-09-02T03:33:48Z
7	Feat/repair request read model	feat/repair-request-read-model	MERGED	2026-09-01T09:53:52Z
6	fix(auth): 补充 Access Token 失效提示与安全返回	fix/auth-token-expiry-feedback	MERGED	2026-08-29T12:24:45Z
4	Feat/customer repair create	feat/customer-repair-create	MERGED	2026-08-28T12:00:45Z
3	feat(auth): implement login session and role routing	feat/login-auth-session-clean	MERGED	2026-08-27T09:53:59Z
2	Feat/auth shell	feat/auth-shell	CLOSED	2026-08-26T15:49:46Z
1	feat: 建立数据库、角色与新人开发基线	chore/database-auth-onboarding	MERGED	2026-08-25T10:51:08Z
== PR21 detail ==
{"base":"litho-ai-support/lithography-platform","closed_at":"2026-10-30T06:08:08Z","head":"GandianTX/lithography-platform","headref":"feat/maintenance-data-increment","headsha":"24f75655eef913b30467ccc05ed9bebbaf846f03","merged_at":null,"state":"closed","title":"Feat/maintenance data increment"}
```

> 注：`gh pr list` 的日期列不是 merge 时间；PR #2 的 API `merged_at` 为 **2026-11-04T04:44:37Z**，上游 PR #21 的 `closed_at` 为 2026-10-30T06:08:08Z、`merged_at=null`。

| 事实                    | 证据                                       | 含义                                              |
| ----------------------- | ------------------------------------------ | ------------------------------------------------- |
| 当前分支                | `feat/maintenance-data-increment`          | 本轮保持不动                                      |
| 本地 HEAD               | `3821e71ccb7b8caa18e1ad4d695cff21b0e7832c` | 当前唯一工作 SHA                                  |
| fork main（实际远端）   | `72de1096...`                              | PR #2 的 merge commit，已合入 fork main           |
| fork 分支（实际远端）   | `3821e71...`                               | 与本地 HEAD 一致                                  |
| 上游 main（实际远端）   | `cc4c87e...`                               | 当前分支相对上游 22 ahead / 0 behind              |
| 本地 `origin/main` 跟踪 | `795eb57...`                               | 已过期，不能当作最新 fork 基线                    |
| fork PR #2              | MERGED（head=`3821e71`，merge=`72de1096`） | 当前 HEAD 已进入 fork main                        |
| 上游 PR #21             | CLOSED（未合并，head=`24f7565`）           | 上游交付尚未完成；当前 HEAD 比该 head 多 4 个提交 |
| 当前 HEAD 是否有开放 PR | 无                                         | 后续需新开 PR                                     |

API compare（fork main `72de1096...` vs HEAD `3821e71...`）返回：

```text
== object 72de1096 ==
fatal: git cat-file: could not get object info
== PR2 detail ==
{"base":"GandianTX/lithography-platform","baseRef":"main","headsha":"3821e71ccb7b8caa18e1ad4d695cff21b0e7832c","merge_commit":"72de1096d0a2aa2d62ed55a48ab49ebc3398000a","merged_at":"2026-11-04T04:44:37Z","title":"feat(database): 补齐组织隔离、维修报告与工程师注册审核数据闭环"}
== compare fork main vs HEAD ==
{"ahead_by":7,"behind_by":1,"status":"diverged","total_commits":7}
```

该差异来自 merge 拓扑：PR #2 的 head 就是当前 HEAD，但 fork main 是 merge commit 且之后可能有新提交；实施前应以更新后的 fork main 为准重新确认（不本轮 fetch）。

### 3.4 CI 对应 SHA

```text
== 3821e71ccb7b8caa18e1ad4d695cff21b0e7832c ==
{"state":"pending","total_count":0}
{"runs":[{"conclusion":"success","name":"Frontend unit (Windows)","status":"completed"},{"conclusion":"success","name":"Backend","status":"completed"},{"conclusion":"success","name":"Frontend","status":"completed"}],"total":3}

== 24f75655eef913b30467ccc05ed9bebbaf846f03 ==
{"state":"pending","total_count":0}
{"runs":[{"conclusion":"success","name":"Frontend unit (Windows)","status":"completed"},{"conclusion":"success","name":"Backend","status":"completed"},{"conclusion":"success","name":"Frontend","status":"completed"}],"total":3}
```

## 4. 工作区与暂存区保护

- 暂存区：空。
- 工作区：`M backend/plans/README.md`（计划目录索引的既有改动）、`?? backend/plans/database-v13-deployment-plan.md`（本计划）。
- 既有 stash 共 3 个（`stash@{0}` pre-merge-pr5-main-sync、`stash@{1}` pr4-wip-before-merge-main-20260923、`stash@{2}` pre-merge-admin-user-management），本轮未查看内容、未 pop、未 drop，原样保留。
- 本轮未 add/commit/stash/reset/checkout，两个既有改动保持原样。
- 本轮新增文件仅位于 `backend/plans/database-v13-deploy/`。

## 5. 31 条迁移静态盘点

基线口径：`backend/src/infrastructure/database/migrations/*.ts` 共 31 个文件；逐文件 SHA-256 见下表，后续 A02 以前 31 条逐文件摘要/哈希不变为准。

| #   | 文件                                                                                                                                                                                                            | SHA-256（前16）    | 静态动作                         | 涉及表                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | [1773889200000-create-ai-provider-call-record-table.migration.ts](../../src/infrastructure/database/migrations/1773889200000-create-ai-provider-call-record-table.migration.ts)                                 | `bc3db9e2e11aa087` | 创建 AI provider 调用记录表      | ai_provider_call_record                                                                                                     |
| 2   | [1773924900000-create-base-user-account-table.migration.ts](../../src/infrastructure/database/migrations/1773924900000-create-base-user-account-table.migration.ts)                                             | `f7820ad7013264e8` | 创建账号表与状态/登录唯一约束    | base_user_account                                                                                                           |
| 3   | [1773925000000-create-base-user-info-table.migration.ts](../../src/infrastructure/database/migrations/1773925000000-create-base-user-info-table.migration.ts)                                                   | `f8bcf8d1135d6748` | 创建用户资料表与账号唯一关联     | base_user_info                                                                                                              |
| 4   | [1773925700000-create-base-async-task-record-table.migration.ts](../../src/infrastructure/database/migrations/1773925700000-create-base-async-task-record-table.migration.ts)                                   | `1cbe2a0c1474e389` | 创建异步任务记录表               | base_async_task_record                                                                                                      |
| 5   | [1773926400000-create-base-third-party-auth-table.migration.ts](../../src/infrastructure/database/migrations/1773926400000-create-base-third-party-auth-table.migration.ts)                                     | `d36ec95573a11c8b` | 创建第三方绑定表与 provider 唯一 | base_third_party_auth                                                                                                       |
| 6   | [1773927600000-create-base-verification-record-table.migration.ts](../../src/infrastructure/database/migrations/1773927600000-create-base-verification-record-table.migration.ts)                               | `96aa213ecd20a600` | 创建验证记录表与过期/状态索引    | base_verification_record                                                                                                    |
| 7   | [1775200800000-create-ai-workflow-context-table.migration.ts](../../src/infrastructure/database/migrations/1775200800000-create-ai-workflow-context-table.migration.ts)                                         | `102f9c89173a4520` | 创建 AI 工作流上下文表           | ai_workflow_context                                                                                                         |
| 8   | [1775200900000-create-equipment-model-table.migration.ts](../../src/infrastructure/database/migrations/1775200900000-create-equipment-model-table.migration.ts)                                                 | `769b1f9404e1c346` | 创建设备型号表                   | equipment_model                                                                                                             |
| 9   | [1775201000000-create-repair-request-table.migration.ts](../../src/infrastructure/database/migrations/1775201000000-create-repair-request-table.migration.ts)                                                   | `8a2a52e60b9fcbd8` | 创建报修工单表                   | repair_request                                                                                                              |
| 10  | [1775201100000-create-ai-conversation-table.migration.ts](../../src/infrastructure/database/migrations/1775201100000-create-ai-conversation-table.migration.ts)                                                 | `ce64a94d5e00e9c0` | 创建 AI 会话表                   | ai_conversation                                                                                                             |
| 11  | [1775201200000-create-ai-message-table.migration.ts](../../src/infrastructure/database/migrations/1775201200000-create-ai-message-table.migration.ts)                                                           | `154ac5bfafbfa711` | 创建 AI 消息表                   | ai_message                                                                                                                  |
| 12  | [1775201300000-create-ai-report-table.migration.ts](../../src/infrastructure/database/migrations/1775201300000-create-ai-report-table.migration.ts)                                                             | `3641067048dcdee1` | 创建 AI 报告表                   | ai_report                                                                                                                   |
| 13  | [1775201400000-create-engineer-response-table.migration.ts](../../src/infrastructure/database/migrations/1775201400000-create-engineer-response-table.migration.ts)                                             | `5d71397207cbdd13` | 创建工程师响应表                 | engineer_response                                                                                                           |
| 14  | [1775201500000-create-reference-document-table.migration.ts](../../src/infrastructure/database/migrations/1775201500000-create-reference-document-table.migration.ts)                                           | `4f604217f713213a` | 创建参考资料主表                 | reference_document                                                                                                          |
| 15  | [1775301000000-create-organization-table.migration.ts](../../src/infrastructure/database/migrations/1775301000000-create-organization-table.migration.ts)                                                       | `ab6cbcc4902f24cd` | 创建公司表                       | organization                                                                                                                |
| 16  | [1775301100000-create-organization-membership-table.migration.ts](../../src/infrastructure/database/migrations/1775301100000-create-organization-membership-table.migration.ts)                                 | `30801b02143ad5d8` | 创建公司成员关系表与单活跃约束   | organization_membership                                                                                                     |
| 17  | [1775301200000-create-content-submission-table.migration.ts](../../src/infrastructure/database/migrations/1775301200000-create-content-submission-table.migration.ts)                                           | `5a96652857a01cf7` | 创建旧投稿表                     | content_submission                                                                                                          |
| 18  | [1775301300000-create-material-submission-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301300000-create-material-submission-detail-table.migration.ts)                           | `711655ff7ec5c3cc` | 创建资料投稿明细表               | material_submission_detail                                                                                                  |
| 19  | [1775301400000-create-fault-case-submission-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301400000-create-fault-case-submission-detail-table.migration.ts)                       | `0b8db1d0fa70cbef` | 创建故障案例投稿明细表           | fault_case_submission_detail                                                                                                |
| 20  | [1775301500000-create-content-submission-attachment-table.migration.ts](../../src/infrastructure/database/migrations/1775301500000-create-content-submission-attachment-table.migration.ts)                     | `26957f4843b84e29` | 创建投稿附件表                   | content_submission_attachment                                                                                               |
| 21  | [1775301600000-create-content-submission-revision-table.migration.ts](../../src/infrastructure/database/migrations/1775301600000-create-content-submission-revision-table.migration.ts)                         | `d91e5668307c516c` | 创建投稿修订表                   | content_submission_revision                                                                                                 |
| 22  | [1775301700000-create-content-submission-review-table.migration.ts](../../src/infrastructure/database/migrations/1775301700000-create-content-submission-review-table.migration.ts)                             | `773e1ce56566ad4d` | 创建投稿审核记录表               | content_submission_review                                                                                                   |
| 23  | [1775301800000-create-reference-document-case-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301800000-create-reference-document-case-detail-table.migration.ts)                   | `34df36ab7db50f67` | 创建参考资料案例明细表           | reference_document_case_detail                                                                                              |
| 24  | [1775301900000-alter-reference-document-organization-fields.migration.ts](../../src/infrastructure/database/migrations/1775301900000-alter-reference-document-organization-fields.migration.ts)                 | `d0632f258a97138a` | 参考资料补充归属公司/可见性字段  | reference_document                                                                                                          |
| 25  | [1775401000000-alter-organization-membership-customer-single-active.migration.ts](../../src/infrastructure/database/migrations/1775401000000-alter-organization-membership-customer-single-active.migration.ts) | `7a402f11403c8eb5` | 收紧客户公司单活跃成员约束       | organization_membership                                                                                                     |
| 26  | [1775401100000-alter-repair-request-organization-and-handling.migration.ts](../../src/infrastructure/database/migrations/1775401100000-alter-repair-request-organization-and-handling.migration.ts)             | `02cfdbafec7a4955` | 工单补充客户公司/处理结果字段    | repair_request                                                                                                              |
| 27  | [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)                               | `b400fb349f114239` | 创建维护报告根/步骤/附件等表     | maintenance_report、maintenance_report_alarm、maintenance_report_step                                                       |
| 28  | [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts)   | `1f89625deb7b9fe5` | 创建报告附件版本/审核表          | maintenance_report_attachment、maintenance_report_review、maintenance_report_version、maintenance_report_version_attachment |
| 29  | [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)                           | `d0ba493bae7bbb00` | 创建本地安装/上传/备份表         | local_backup_run、local_installation、local_upload_task                                                                     |
| 30  | [1775401500000-create-engineer-registration-application.migration.ts](../../src/infrastructure/database/migrations/1775401500000-create-engineer-registration-application.migration.ts)                         | `bf19de8b1bf7f830` | 创建工程师注册申请表             | engineer_registration_application                                                                                           |
| 31  | [1775401600000-add-null-safe-handling-constraints.migration.ts](../../src/infrastructure/database/migrations/1775401600000-add-null-safe-handling-constraints.migration.ts)                                     | `7c7a0a2c1f3a8dd8` | 补充 NULL-safe 处理约束          | repair_request                                                                                                              |

统计：31 个迁移文件；其中 27 个建表迁移覆盖 34 张表，4 个 ALTER/收紧迁移。未发现重复建表或缺失表。

## 6. 34 张现有表静态盘点

| #   | 表                                      | 分区 | Entity                                                                                                                                    | 相关迁移                                                                                                                                                                                                      | 现有字段数 | 目标设计行 | 现有约束 | 直接消费者 | 测试文件 |
| --- | --------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | -------- | ---------- | -------- |
| 1   | `base_user_account`                     | 3.1  | [account.entity.ts](../../src/modules/account/base/entities/account.entity.ts)                                                            | [1773924900000-create-base-user-account-table.migration.ts](../../src/infrastructure/database/migrations/1773924900000-create-base-user-account-table.migration.ts)                                           | 9          | 2          | 3        | 42         | 5        |
| 2   | `base_user_info`                        | 3.2  | [user-info.entity.ts](../../src/modules/account/base/entities/user-info.entity.ts)                                                        | [1773925000000-create-base-user-info-table.migration.ts](../../src/infrastructure/database/migrations/1773925000000-create-base-user-info-table.migration.ts)                                                 | 20         | 2          | 3        | 37         | 5        |
| 3   | `ai_provider_call_record`               | 3.3  | [ai-provider-call-record.entity.ts](../../src/modules/ai-provider-call-record/ai-provider-call-record.entity.ts)                          | [1773889200000-create-ai-provider-call-record-table.migration.ts](../../src/infrastructure/database/migrations/1773889200000-create-ai-provider-call-record-table.migration.ts)                               | 28         | 0          | 14       | 6          | 1        |
| 4   | `ai_workflow_context`                   | 3.4  | [ai-workflow-context.entity.ts](../../src/modules/ai-workflow-context/ai-workflow-context.entity.ts)                                      | [1775200800000-create-ai-workflow-context-table.migration.ts](../../src/infrastructure/database/migrations/1775200800000-create-ai-workflow-context-table.migration.ts)                                       | 28         | 0          | 10       | 5          | 1        |
| 5   | `base_async_task_record`                | 3.5  | [async-task-record.entity.ts](../../src/modules/async-task-record/async-task-record.entity.ts)                                            | [1773925700000-create-base-async-task-record-table.migration.ts](../../src/infrastructure/database/migrations/1773925700000-create-base-async-task-record-table.migration.ts)                                 | 22         | 0          | 12       | 10         | 0        |
| 6   | `ai_conversation`                       | 3.6  | [ai-conversation.entity.ts](../../src/modules/lithography/entities/ai-conversation.entity.ts)                                             | [1775201100000-create-ai-conversation-table.migration.ts](../../src/infrastructure/database/migrations/1775201100000-create-ai-conversation-table.migration.ts)                                               | 7          | 4          | 7        | 10         | 2        |
| 7   | `ai_message`                            | 3.7  | [ai-message.entity.ts](../../src/modules/lithography/entities/ai-message.entity.ts)                                                       | [1775201200000-create-ai-message-table.migration.ts](../../src/infrastructure/database/migrations/1775201200000-create-ai-message-table.migration.ts)                                                         | 7          | 2          | 9        | 5          | 0        |
| 8   | `ai_report`                             | 3.8  | [ai-report.entity.ts](../../src/modules/lithography/entities/ai-report.entity.ts)                                                         | [1775201300000-create-ai-report-table.migration.ts](../../src/infrastructure/database/migrations/1775201300000-create-ai-report-table.migration.ts)                                                           | 8          | 0          | 7        | 8          | 1        |
| 9   | `content_submission_attachment`         | 3.9  | [content-submission-attachment.entity.ts](../../src/modules/lithography/entities/content-submission-attachment.entity.ts)                 | [1775301500000-create-content-submission-attachment-table.migration.ts](../../src/infrastructure/database/migrations/1775301500000-create-content-submission-attachment-table.migration.ts)                   | 11         | 0          | 7        | 10         | 1        |
| 10  | `content_submission_review`             | 3.10 | [content-submission-review.entity.ts](../../src/modules/lithography/entities/content-submission-review.entity.ts)                         | [1775301700000-create-content-submission-review-table.migration.ts](../../src/infrastructure/database/migrations/1775301700000-create-content-submission-review-table.migration.ts)                           | 8          | 0          | 9        | 9          | 1        |
| 11  | `content_submission_revision`           | 3.11 | [content-submission-revision.entity.ts](../../src/modules/lithography/entities/content-submission-revision.entity.ts)                     | [1775301600000-create-content-submission-revision-table.migration.ts](../../src/infrastructure/database/migrations/1775301600000-create-content-submission-revision-table.migration.ts)                       | 11         | 0          | 10       | 8          | 1        |
| 12  | `content_submission`                    | 3.12 | [content-submission.entity.ts](../../src/modules/lithography/entities/content-submission.entity.ts)                                       | [1775301200000-create-content-submission-table.migration.ts](../../src/infrastructure/database/migrations/1775301200000-create-content-submission-table.migration.ts)                                         | 10         | 0          | 8        | 10         | 1        |
| 13  | `engineer_registration_application`     | 3.13 | [engineer-registration-application.entity.ts](../../src/modules/lithography/entities/engineer-registration-application.entity.ts)         | [1775401500000-create-engineer-registration-application.migration.ts](../../src/infrastructure/database/migrations/1775401500000-create-engineer-registration-application.migration.ts)                       | 12         | 0          | 12       | 7          | 0        |
| 14  | `engineer_response`                     | 3.14 | [engineer-response.entity.ts](../../src/modules/lithography/entities/engineer-response.entity.ts)                                         | [1775201400000-create-engineer-response-table.migration.ts](../../src/infrastructure/database/migrations/1775201400000-create-engineer-response-table.migration.ts)                                           | 7          | 1          | 8        | 12         | 2        |
| 15  | `equipment_model`                       | 3.15 | [equipment-model.entity.ts](../../src/modules/lithography/entities/equipment-model.entity.ts)                                             | [1775200900000-create-equipment-model-table.migration.ts](../../src/infrastructure/database/migrations/1775200900000-create-equipment-model-table.migration.ts)                                               | 7          | 0          | 3        | 25         | 6        |
| 16  | `fault_case_submission_detail`          | 3.16 | [fault-case-submission-detail.entity.ts](../../src/modules/lithography/entities/fault-case-submission-detail.entity.ts)                   | [1775301400000-create-fault-case-submission-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301400000-create-fault-case-submission-detail-table.migration.ts)                     | 15         | 0          | 6        | 7          | 1        |
| 17  | `local_backup_run`                      | 3.17 | [local-backup-run.entity.ts](../../src/modules/lithography/entities/local-backup-run.entity.ts)                                           | [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)                         | 16         | 4          | 7        | 5          | 0        |
| 18  | `local_installation`                    | 3.18 | [local-installation.entity.ts](../../src/modules/lithography/entities/local-installation.entity.ts)                                       | [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)                         | 10         | 1          | 5        | 5          | 0        |
| 19  | `local_upload_task`                     | 3.19 | [local-upload-task.entity.ts](../../src/modules/lithography/entities/local-upload-task.entity.ts)                                         | [1775401400000-create-local-installation-upload-backup.migration.ts](../../src/infrastructure/database/migrations/1775401400000-create-local-installation-upload-backup.migration.ts)                         | 15         | 4          | 10       | 4          | 0        |
| 20  | `maintenance_report_alarm`              | 3.20 | [maintenance-report-alarm.entity.ts](../../src/modules/lithography/entities/maintenance-report-alarm.entity.ts)                           | [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)                             | 7          | 0          | 7        | 4          | 0        |
| 21  | `maintenance_report_attachment`         | 3.21 | [maintenance-report-attachment.entity.ts](../../src/modules/lithography/entities/maintenance-report-attachment.entity.ts)                 | [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts) | 16         | 0          | 12       | 8          | 0        |
| 22  | `maintenance_report_review`             | 3.22 | [maintenance-report-review.entity.ts](../../src/modules/lithography/entities/maintenance-report-review.entity.ts)                         | [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts) | 7          | 0          | 7        | 7          | 0        |
| 23  | `maintenance_report_step`               | 3.23 | [maintenance-report-step.entity.ts](../../src/modules/lithography/entities/maintenance-report-step.entity.ts)                             | [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)                             | 12         | 6          | 9        | 4          | 0        |
| 24  | `maintenance_report_version_attachment` | 3.24 | [maintenance-report-version-attachment.entity.ts](../../src/modules/lithography/entities/maintenance-report-version-attachment.entity.ts) | [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts) | 6          | 0          | 6        | 4          | 0        |
| 25  | `maintenance_report_version`            | 3.25 | [maintenance-report-version.entity.ts](../../src/modules/lithography/entities/maintenance-report-version.entity.ts)                       | [1775401300000-create-maintenance-report-attachment-version-review.migration.ts](../../src/infrastructure/database/migrations/1775401300000-create-maintenance-report-attachment-version-review.migration.ts) | 10         | 0          | 10       | 7          | 0        |
| 26  | `maintenance_report`                    | 3.26 | [maintenance-report.entity.ts](../../src/modules/lithography/entities/maintenance-report.entity.ts)                                       | [1775401200000-create-maintenance-report-and-content.migration.ts](../../src/infrastructure/database/migrations/1775401200000-create-maintenance-report-and-content.migration.ts)                             | 28         | 15         | 21       | 10         | 0        |
| 27  | `material_submission_detail`            | 3.27 | [material-submission-detail.entity.ts](../../src/modules/lithography/entities/material-submission-detail.entity.ts)                       | [1775301300000-create-material-submission-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301300000-create-material-submission-detail-table.migration.ts)                         | 10         | 0          | 5        | 7          | 1        |
| 28  | `organization_membership`               | 3.28 | [organization-membership.entity.ts](../../src/modules/lithography/entities/organization-membership.entity.ts)                             | [1775301100000-create-organization-membership-table.migration.ts](../../src/infrastructure/database/migrations/1775301100000-create-organization-membership-table.migration.ts)                               | 10         | 0          | 10       | 17         | 1        |
| 29  | `organization`                          | 3.29 | [organization.entity.ts](../../src/modules/lithography/entities/organization.entity.ts)                                                   | [1775301000000-create-organization-table.migration.ts](../../src/infrastructure/database/migrations/1775301000000-create-organization-table.migration.ts)                                                     | 7          | 9          | 4        | 15         | 4        |
| 30  | `reference_document_case_detail`        | 3.30 | [reference-document-case-detail.entity.ts](../../src/modules/lithography/entities/reference-document-case-detail.entity.ts)               | [1775301800000-create-reference-document-case-detail-table.migration.ts](../../src/infrastructure/database/migrations/1775301800000-create-reference-document-case-detail-table.migration.ts)                 | 13         | 0          | 3        | 6          | 1        |
| 31  | `reference_document`                    | 3.31 | [reference-document.entity.ts](../../src/modules/lithography/entities/reference-document.entity.ts)                                       | [1775201500000-create-reference-document-table.migration.ts](../../src/infrastructure/database/migrations/1775201500000-create-reference-document-table.migration.ts)                                         | 23         | 13         | 20       | 15         | 2        |
| 32  | `repair_request`                        | 3.32 | [repair-request.entity.ts](../../src/modules/lithography/entities/repair-request.entity.ts)                                               | [1775201000000-create-repair-request-table.migration.ts](../../src/infrastructure/database/migrations/1775201000000-create-repair-request-table.migration.ts)                                                 | 19         | 8          | 24       | 23         | 4        |
| 33  | `base_third_party_auth`                 | 3.33 | [third-party-auth.entity.ts](../../src/modules/third-party-auth/third-party-auth.entity.ts)                                               | [1773926400000-create-base-third-party-auth-table.migration.ts](../../src/infrastructure/database/migrations/1773926400000-create-base-third-party-auth-table.migration.ts)                                   | 8          | 0          | 3        | 7          | 0        |
| 34  | `base_verification_record`              | 3.34 | [verification-record.entity.ts](../../src/modules/verification-record/verification-record.entity.ts)                                      | [1773927600000-create-base-verification-record-table.migration.ts](../../src/infrastructure/database/migrations/1773927600000-create-base-verification-record-table.migration.ts)                             | 15         | 0          | 7        | 8          | 0        |

合计：34 张表、**442** 条现有字段行（S1 校准后；初版 439）、298 条现有约束行、**71** 条现有表目标设计行（初版 59）、367 个直接消费者文件、41 个直接测试文件。明细见 [S1-object-and-field-dictionary.md](S1-object-and-field-dictionary.md)。

## 7. 部署工具与直接消费者

| 工具                                                        | 位置                                                                                             | 当前能力                                                                              | 与本计划关系                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `scripts/migration.ts`                                      | [migration.ts](../../scripts/migration.ts)                                                       | status / verify / run；只跑 pending，不自动 down                                      | 既有迁移入口                                             |
| `src/infrastructure/database/incremental-migration.ts`      | [incremental-migration.ts](../../src/infrastructure/database/incremental-migration.ts)           | 支持 `--config-file`、`--database`、`--confirm-database`、GET_LOCK、status/verify/run | 升级入口可复用                                           |
| `src/infrastructure/database/verify-empty-db-migrations.ts` | [verify-empty-db-migrations.ts](../../src/infrastructure/database/verify-empty-db-migrations.ts) | 空库结构演练与关键表/索引/CHECK/FK 校验                                               | 不作为正式 init                                          |
| `migration-schema-contract.ts`                              | [migration-schema-contract.ts](../../src/infrastructure/database/migration-schema-contract.ts)   | 34 张必需表、索引、FK、CHECK 契约                                                     | 需随新目标扩展                                           |
| `package.json`                                              | [package.json](../../package.json)                                                               | `migration:*`、`seed:*` 等脚本                                                        | **缺 `database:deploy` 与 `--mode init/upgrade/verify`** |

缺口：任务书要求的统一部署入口 `npm run database:deploy -- --mode init|upgrade|verify --config-file ... --confirm-database ...` 尚不存在；现有入口不创建数据库、不编排管理员初始化。属于 S3 实现项，S1 只记录。

直接消费者与清理入口：`test/utils/e2e-scoped-cleanup.ts`、`test/utils/e2e-owned-fixture.ts`、`test/utils/e2e-db-guard.ts`、`src/infrastructure/database/test-support/`。新增 17 个候选表与 58 条现有 FK 会改变删除顺序，必须在 S2 扩清理闭包（见 S1 契约文档第 8 节）。

## 8. 环境与操作库边界

- 本轮**未连接任何数据库**，未启动/停止 MySQL/Redis，未建库、未迁移、未 seed、未清理。
- 因此以下 S0 项**未取得本轮证据**：操作库实例/端口/库名、迁移账号授权、备份源、保留数据确认。主计划记录的历史观察（开发库 30 条迁移、测试库 31 条迁移、均 34 表）只作为线索，不作为本轮验收。
- 支持环境（文档与历史证据）：MySQL 8.0+（历史实测 8.0.46）、Node v22.19.0、npm 10.9.3、Redis 7.0.15；`package-lock.json` 存在。
- 未执行 `npm ci`/build/lint/typecheck/单测，避免在未授权环境产生副作用；S2/S4 再按 A15 执行。

## 9. 与旧计划的差异（沿用主计划 4.2）

- 旧 V2/增量计划用于赛题提交和既有 30/31 测量；仍是铁律：不删正常记录、不以 `synchronize`、不用 `down`、不整库重建、不把仓库内 6 条开发迁移当生产迁移。
- 本计划不把 34 当终态、不把 91 条当岗位权限表、不用 `identity_hint`/FK 冒充权限、不自动生成“旧 owner=服务公司”映射、不让候选表变成 51 张终态结论。
- 主计划 4.3/4.4 的技术判断与“建议接受/重新评估”本轮未逐条复核；S1 只把可证实的代码事实写入清单，未证实的保留为未决项。

## 10. S0 结论

- 输入指纹全部一致，**未触发“缺失/冲突即停止对应部分”**；Excel 来源目录已按 OI-09 明确，不再要求确认。
- 基线可冻结：HEAD `3821e71`、31 条迁移逐文件哈希、34 张表、部署工具与消费者清单。
- 真正阻塞不在 S0 文档层：数据库授权/实际库证据、旧数据回填依据、N/M 与 17 候选落位审批（见 S1 未决问题）。
