## 交付目标

本PR提供资料/故障案例采集的数据库与公共接口，为后续三个真实角色的页面开发准备基础。此次补齐B Review提出的既有库正式增量升级入口，避免把清库演练当成保留旧数据的升级方式。

这是普通PR。A本地修复验收已完成，交付B复审及独立运行签收；B签收和新候选CI完成前不合并。

## 实现范围

- 新增组织、成员、投稿/两类明细、单附件、冻结版本、审核和正式案例明细九张表，扩展现有参考资料；保留原14条Migration，追加10条。
- 工程师维护本人草稿、附件、送审和重提；本组织管理员审核，批准冻结版本后进入现有参考资料库。
- 正式案例专属更正与正文同步；保留普通资料原创建/上传/编辑/下载能力。
- 组织权限来自可信成员事实；客户不进入资料库或投稿链路。
- 提供前端公开类型、GraphQL/REST适配及统一认证失败处理。
- 新增migration:status / migration:run / migration:verify，显式配置及写入确认，只执行pending；预检历史与关键结构、核对索引/外键有序列映射，验证旧资料保留及回填。
- MySQL部分DDL失败时保留现场并失败退出；主因、解锁和关闭错误可见；最终成功只在收尾完成后确认。

不包含后续业务页面、演示账号、AI模型/对话、OCR、多附件、同行开户、跨组织共享或训练授权。

## B Review修复说明

对应[Review 5646340531](https://github.com/GandianTX/lithography-platform/pull/1#pullrequestreview-5646340531)：

1. 正式入口已在候选代码中提供，不调用drill、清表、synchronize或Mock Seed。
2. 在带合成旧资料的独立14条历史旧库副本上运行正式入口：正常库14→24，再运行0条；旧正文、文件引用、软删事实保留，组织及入库方式正确回填。
3. 同名错误索引列、错误外键映射在第一条升级写入前拒绝，历史仍14，工具不擅自修复结构。
4. 31项实库专项覆盖配置/目标拒绝、历史/结构漂移、部分DDL成功、历史写入失败、结果未知及收尾失败；恢复步骤按实际状态区分旧前缀与完整终态。
5. B本人运行结果尚待填写，不以A或AI验证代签。

## A侧实际验证

环境：Node22.19.0，Linux，独立MySQL8.0.46和Redis；全量core关闭全库TRUNCATE，夹具清理显式授权。未操作保留库或生产库。

| 检查 | 结果 |
| --- | --- |
| 后端typecheck、无fix ESLint及架构/usecase/capability检查、build | 通过 |
| 后端unit | 109 suites passed、1 skipped；1332 passed、31 skipped |
| 迁移实库专项 | 上述条件跳过的31项另在隔离库全部通过 |
| 前端format/lint、unit及build | 112文件、1557项通过 |
| 完整core E2E | 41规格、557项通过，0失败/0跳过 |
| 空库与旧14+10迁移演练 | 通过；演练证据与正式增量入口证据分开 |
| 正式CLI旧库副本 | 正常升级/终态验证/二次0条通过；错索引/外键副本拒绝且不升级 |
| 正式Seed连续两次 | 通过，非Mock账号与资料逐字段保持 |
| 同库重复业务链与响应样例 | 业务协议规格5项、样例规格2项均两轮通过；每轮39条样例；业务夹具无残留，仅保留默认组织 |
| 测试敏感性 | 临时副本跳过列比较或提前成功时断言失败；恢复后通过 |
| 旧14条Migration | 与实际base逐文件字节一致 |

旧PR3专用check:entity-scope禁止Entity变化，不适用于本PR已授权九表及参考资料扩展；未将其误报为通过。完整适用性、真实I/O/受控替身、skip和环境限制见报告。

## 版本与证据

以本PR当前head为交付版本。修复前HEAD为68a78e2e46a166b4a7c16e6290872ffad3f6329a，本轮实现验收绑定该HEAD加报告内207文件指纹；后续文档整理单独留痕。正式交付消息应给出推送后的新完整SHA，不以修复前HEAD代表新增入口。

- [当前交付总入口](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-复审交付材料-20261026/README.md)
- [完整独立终审报告](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-最终独立终审-20261026/完整PR独立终审报告-20261026.md)
- [文档整理及证据沿用说明](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-复审交付材料-20261026/文档整理回执.md)
- [B独立验收入口](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0-A侧候选交付-20261025/B独立验收入口.md)
- [技术交接说明](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/PR0a-技术交接说明-20261025.md)
- [既有库正式升级与恢复](https://github.com/GandianTX/lithography-platform/blob/feat/data-collection-core/docs/database/增量升级操作说明-20261026.md)

上面使用共享fork功能分支的blob链接，需本轮文件推送后才可访问；固定版本引用应将分支名换为交付的新完整SHA。

## 待完成门禁

- [x] A侧本地实现与必要验收完成。
- [ ] 当前PR head已包含本轮修复，正文/交付SHA已核对。
- [ ] 新候选必要CI通过；旧HEAD绿色不沿用为新候选CI。
- [ ] B在隔离环境独立完成正式升级/门禁/两条链并记录签收。
- [ ] B复审及当前讨论完成，由有权限的合并人处理；A不自行合并。

以上未完成项在实际完成前保持未勾选。本PR不包含原始日志、响应JSON、环境文件、数据库dump或上传物。
