## 关联任务

- 模块：PR0 / PR0a，资料采集数据库与公共接口前置建设。
- 当前状态：A01/A04 修复及 D01/E01 本地收尾已执行完成：一轮 core 625项通过、39样例、KEEP前后不变及正常零残留；等待新候选交付、独立复核和 B 本人验收。
- 本地候选：`f39a8f9b2741da226f1136c0621d28641692bc2f` + 未提交及新增修复文件。**此旧 SHA 单独不包含修复；提交推送后必须在交付消息提供新完整 SHA。**
- 当前 PR 继续使用共享 fork `GandianTX/lithography-platform` 的 #1，base `main` / head `feat/data-collection-core`。本轮未更新远端正文、未核验新远端 head/CI。
- B 本人独立签收、新候选必要 CI 和 Review 完成前不合并；A/执行 AI 不代签、不自行合并。

## 改动内容

### 数据库与后端

- 新增组织、成员、资料/案例投稿、附件、冻结版本、审核和正式案例明细等九张表。
- 扩展现有参考资料表，支持组织归属、来源回链等信息。
- 实现两类草稿、私有单附件、送审冻结、退回重提、审核发布。
- 实现本组织参考资料读取及正式案例更正，保留管理员原有资料创建和上传能力。
- 修复 retained-only 清理生成空 WHERE 的问题，并补齐失败收尾、残留恢复及引用闭包回归测试。
- 移除会整表删除 `base_user_account` / `base_user_info` / `organization_membership` 的 `cleanupTestAccounts` 导出，迁移 13 个直接消费者（9 个 core + 3 个外围 + register 规格）为“真实 ID 账本 + 双门禁 + 残留指纹 + 统一收尾”，并新增第三/四类资源（第三方绑定、验证记录、维修申请、工程师回复）的归属收集、引用闭包与固定顺序精确删除。
- 针对 [B 的 Review](https://github.com/GandianTX/lithography-platform/pull/1#pullrequestreview-5646340531)，新增正式增量迁移入口 migration:status / migration:run / migration:verify，明确配置和目标，只执行 pending 迁移，不清表、不执行 synchronize 或 Mock Seed。
- 补齐迁移历史与结构预检、关键索引/外键有序列映射、MySQL 部分 DDL 失败诊断及恢复说明；主因、解锁和关闭失败均可见，收尾失败不提前输出最终成功。

### 前端公共适配

- 提供资料采集公共类型、GraphQL/附件 API 调用及错误适配。
- 适配现有参考资料调用方。
- 本 PR 不新增正式业务页面，不声明页面联调或视觉验收已经完成。

### 权限

- 客户不能读取资料库或提交资料。
- 工程师维护本人记录，阅读本组织正式资料。
- 管理员在本组织范围审核、维护正式资料，不自动继承工程师投稿写入口。
- 组织、本人、版本及附件归属由服务端校验。

## 数据库影响

- 新增九张表、扩展 reference_document，共新增十条 Migration。
- 未改写既有十四条基线 Migration，已逐文件与目标分支核对。
- 不依赖 synchronize 或手工改表交付。
- 已验证空库迁移、旧十四条加新增十条的升级演练；另在带合成旧资料的旧库副本上执行正式增量入口，历史 14→24，再次执行 0 条，核对旧正文、文件引用、软删事实保留及组织/入库方式回填。
- 同名索引或外键被改列的旧库会在升级写入前拒绝，历史保持 14 条，不自动修复错误结构后放行。
- MySQL 多步 DDL 失败不保证整体回滚；失败后保留现场，按实际历史/结构及备份恢复流程处理，不自动 down、清历史或盲目重试。
- 历史验收中已完整执行两轮 Seed，并核对非 Mock 合成记录逐字段不变；本轮不重复Seed或用其代替core保留核验。

## A 侧实际验证

执行使用 Node **22.19.0**。最新运行及候选指纹见[交付收尾执行回执](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-B审查core清理安全修复计划-20261026/A01-A04交付收尾与KEEP补证执行回执-20261028.md)。该链接须在本地材料实际提交推送后核对可读性。

- [x] A01：显式分页/字段加密/mock 配置校验并同源传递，缺失/空白拒绝，不依赖私人 env。
- [x] A04：子运行 null、信号、启动/等待错误等未确认结束时不认领、不登记、不 DROP；正常明确非零仍允许凭唯一匹配创建凭据交接。
- [x] A01/A04 局部负对照在临时源码/精确边界验证；恢复后通过，不修改工作区实现。
- [x] 前次独立终审实跑：后端 1332 项取得通过结果，31 项迁移实库专项条件跳过；首轮 6 项本机监听被沙箱拒绝后定向重跑 6/6，通过。不是把首轮失败写成整组 exit 0。
- [x] 前次独立终审实跑：前端 112 文件/1557 项通过，构建通过；后端 build/tools/spec 三套类型检查通过。被测源码、lock 未变，按命题沿用，不重复宣称新运行。
- [x] 本轮最终 core：Node22.19.0、独占非默认端口实例、无私人env副本、全局清库关闭，**48规格/625 passed，0 failed/0 skipped，runner exit0，一轮**；同轮39样例（A26/B13）。
- [x] E01：运行前后全部24表逐字段摘要一致，5个KEEP文件及完整存储文件清单一致；正常数据库/文件夹具和探针库残留0，检查exit0。前后快照SHA-256相同，详见收尾回执。
- [x] 既有14条 accepted Migration 未改；只新增十条迁移，九表及参考资料扩展属于已授权设计。
- [x] 原正式旧库增量升级、备份恢复及相关迁移验收事实保留；不冒称默认跳过的31项本轮已实库执行，也不重新覆盖 B 既有签收事实。
- [ ] B 针对新完整候选独立复现并签收。
- [ ] 新候选必要 CI 与 Review；旧 d4535bc 的历史 CI 不代替当前候选。

39 是请求响应样例数，不是 Jest 测试数。旧 557/600/622 等数字及双跑结果仅作为对应历史候选证据，不写成当前625项候选已双跑。

本轮新实例不接触共享/真实环境；此前默认3306/6379事故仍由实例拥有者另行处置，新的隔离验证不证明事故已恢复。

## 交接与验收入口

- [当前交付说明](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-复审交付材料-20261026/README.md)
- [B当前执行清单](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-复审交付材料-20261026/B独立验收执行清单.md)
- [本轮收尾回执](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-B审查core清理安全修复计划-20261026/A01-A04交付收尾与KEEP补证执行回执-20261028.md)
- [正式旧库增量升级说明](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/增量升级操作说明-20261026.md)

B 只接收 A 实际推送后的新完整 SHA，在自己的 Linux/WSL 独占可丢弃环境，用完整显式配置预检后，预置 KEEP、完整 core **一轮**并同轮导出39样例，再比较非夹具/文件及正常夹具残留。不要以旧 d4535bc、只有 f39a8f9 的提交、私人 env 或原生 Windows PID 事实作为本轮运行依据。

受控启动器依赖 Linux `/proc`；Windows 用户先进入 WSL。A02 执行参数自动白名单、A03 只读预检关闭诊断为后续 P3；本期约定只运行 core/明确本地规格，不能说软件已自动封锁全部范围外参数。

## 本 PR 不包含

- 正式资料采集及审核业务页面
- 真实 AI、分析转工单及结单总结页面
- OCR、多附件
- 同行开户、跨组织共享或训练授权
- demo 演示账号

## 合并前条件

B 独立签收、本次新候选必要 CI 通过、Review 问题解决并完成复审后，才进入合并流程。当前为普通 PR，不再保留 Draft 转 Ready 的步骤。

不由 PR 创建人自行合并，不直接修改 main。
最终合并回原项目仓库由项目负责人处理。
