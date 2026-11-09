# S4 第 39 条迁移逐文件 SHA-256（冻结候选）

> 采集日期：2026-11-08（Asia/Shanghai）。本轮未修改任何迁移文件；下表 39 个文件在第十七轮前后一致。

## 算法与口径

- 仓库根目录：`/home/gandiantx/lithography-platform`。
- 路径形式：相对仓库根目录的 POSIX 路径，统一以 `backend/src/infrastructure/database/migrations/` 开头。
- 排序：按文件名（即 13 位时间戳 + 名称）升序，`LC_ALL=C` 等价字典序。
- 逐文件：`sha256sum <path>`，输出为 `<64位hex>  <path>`（两个空格）。
- 聚合：把 39 行 `sha256sum` 文本按上述顺序拼接后整体再做一次 SHA-256。
- 前 38 条聚合（路径形式一致）：`624c4570ef86873b363370a93b9746355ba0e0b57c46baec430a1f9e5f96f86d`。
- 全 39 条聚合：`8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`。

复算命令（仓库根目录）：

```bash
find backend/src/infrastructure/database/migrations -maxdepth 1 -name '*.migration.ts' | sort | xargs sha256sum | tee /tmp/migrations-39.txt
sha256sum /tmp/migrations-39.txt
```

## 逐文件清单

|   # | 时间戳          | 文件                                                                                   | SHA-256                                                            |
| --: | --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
|   1 | `1773889200000` | `1773889200000-create-ai-provider-call-record-table.migration.ts`                      | `bc3db9e2e11aa0874410f22741fc0cbb129e0543435d08313e249efc4df2a5d5` |
|   2 | `1773924900000` | `1773924900000-create-base-user-account-table.migration.ts`                            | `f7820ad7013264e866d35d82a60b410cfb1ef18dbbea36a7b92810fad30f458e` |
|   3 | `1773925000000` | `1773925000000-create-base-user-info-table.migration.ts`                               | `f8bcf8d1135d6748566a13ffad779392af438e234238ce1fef7984cc89bceefa` |
|   4 | `1773925700000` | `1773925700000-create-base-async-task-record-table.migration.ts`                       | `1cbe2a0c1474e389627063e4841eae5b8c5709aa89325f27f3012a0e8e5e899c` |
|   5 | `1773926400000` | `1773926400000-create-base-third-party-auth-table.migration.ts`                        | `d36ec95573a11c8bcc0e15e4eafe9324c226703ce64de631c274d80507bdf617` |
|   6 | `1773927600000` | `1773927600000-create-base-verification-record-table.migration.ts`                     | `96aa213ecd20a600a80119f28d6ae0d4fc6e12ee76c9b92aa6d95412517cdbb5` |
|   7 | `1775200800000` | `1775200800000-create-ai-workflow-context-table.migration.ts`                          | `102f9c89173a45202447c6891dd9663ab582b17a665e546dbc00edf4f76d338a` |
|   8 | `1775200900000` | `1775200900000-create-equipment-model-table.migration.ts`                              | `769b1f9404e1c34615d4a1dba68c6ee9d590588106077d729f32ebd7263810dc` |
|   9 | `1775201000000` | `1775201000000-create-repair-request-table.migration.ts`                               | `8a2a52e60b9fcbd81132adb6b42cfbba9651c9e0802458877bfef196658a2afa` |
|  10 | `1775201100000` | `1775201100000-create-ai-conversation-table.migration.ts`                              | `ce64a94d5e00e9c03ff8bc7b7f930adab2569c3b752d9515da1551ec77ad2b93` |
|  11 | `1775201200000` | `1775201200000-create-ai-message-table.migration.ts`                                   | `154ac5bfafbfa71125d09a2c56d4016d007f9fe944b3999ae8855bcd23f28c49` |
|  12 | `1775201300000` | `1775201300000-create-ai-report-table.migration.ts`                                    | `3641067048dcdee11433fbf3f974266c7c03aa2bd3cd25c0beff6383e828752a` |
|  13 | `1775201400000` | `1775201400000-create-engineer-response-table.migration.ts`                            | `5d71397207cbdd13bdf7c9a8b15a2744267b262c75deb821bd8bd865313fed96` |
|  14 | `1775201500000` | `1775201500000-create-reference-document-table.migration.ts`                           | `4f604217f713213ab752098dd12f68aa53d8afe62ef7839a15e27aaeb45a095b` |
|  15 | `1775301000000` | `1775301000000-create-organization-table.migration.ts`                                 | `ab6cbcc4902f24cd96db704dabec739417f79baa3d985bdaebe84d42a5ebb5ae` |
|  16 | `1775301100000` | `1775301100000-create-organization-membership-table.migration.ts`                      | `30801b02143ad5d85bdd3ae74c47dff7aabbf6af5afb017f4c698472a6f66e9e` |
|  17 | `1775301200000` | `1775301200000-create-content-submission-table.migration.ts`                           | `5a96652857a01cf703b681e3f6cefd4eb5d19561f0a629c713a056729bd3822c` |
|  18 | `1775301300000` | `1775301300000-create-material-submission-detail-table.migration.ts`                   | `711655ff7ec5c3cc04ca81153b3980244c9eab6c3eda770022bbb825fe630aaf` |
|  19 | `1775301400000` | `1775301400000-create-fault-case-submission-detail-table.migration.ts`                 | `0b8db1d0fa70cbef35997adc6b84b9c0865396cb47e397e53dea84a146351d76` |
|  20 | `1775301500000` | `1775301500000-create-content-submission-attachment-table.migration.ts`                | `26957f4843b84e29440bc640260c691858542f5b2f8ece8f14b6933d892b4120` |
|  21 | `1775301600000` | `1775301600000-create-content-submission-revision-table.migration.ts`                  | `d91e5668307c516cce0e0095cc4d1f4ba5e05b7ab4527781db494687cdb57c1c` |
|  22 | `1775301700000` | `1775301700000-create-content-submission-review-table.migration.ts`                    | `773e1ce56566ad4d64dc1059bb9ddec9577f4fc0d6aea3641c75692ad8fd20a6` |
|  23 | `1775301800000` | `1775301800000-create-reference-document-case-detail-table.migration.ts`               | `34df36ab7db50f67dde3869888b8bf19878c8df6f29eff399b7cdd53a8a20bfb` |
|  24 | `1775301900000` | `1775301900000-alter-reference-document-organization-fields.migration.ts`              | `d0632f258a97138abbd4050e3a9bbe75d56a376ac06ad33931e235f579bbc83b` |
|  25 | `1775401000000` | `1775401000000-alter-organization-membership-customer-single-active.migration.ts`      | `7a402f11403c8eb549e39a1d1bac42c5edb30523029195f31436c51570a02992` |
|  26 | `1775401100000` | `1775401100000-alter-repair-request-organization-and-handling.migration.ts`            | `02cfdbafec7a49557ed541a255c53e69b0bd1fa7b4b37d89bbf8efc228074dee` |
|  27 | `1775401200000` | `1775401200000-create-maintenance-report-and-content.migration.ts`                     | `b400fb349f11423950545d9f2586168c2e6b2762eecafcbed003d28d7619d235` |
|  28 | `1775401300000` | `1775401300000-create-maintenance-report-attachment-version-review.migration.ts`       | `1f89625deb7b9fe5bf98a3f98579329e4ecb181984a4a01f05bd68000991b833` |
|  29 | `1775401400000` | `1775401400000-create-local-installation-upload-backup.migration.ts`                   | `d0ba493bae7bbb004c49e72c2e3dff4eccc6d751cd1100bb6cb69abfc18db4ca` |
|  30 | `1775401500000` | `1775401500000-create-engineer-registration-application.migration.ts`                  | `bf19de8b1bf7f830c25a36269b959a27553fae274b13ca397e9c30fcfb345163` |
|  31 | `1775401600000` | `1775401600000-add-null-safe-handling-constraints.migration.ts`                        | `7c7a0a2c1f3a8dd83c4b75b0a3ea9123a39380f1cc859b176611215db0a86b14` |
|  32 | `1775501000000` | `1775501000000-alter-accounts-and-organizations-for-v13.migration.ts`                  | `698fb832135d4417a3c08cdcb3044473327d6d9bb7141adf48cefa7831d8b93a` |
|  33 | `1775501100000` | `1775501100000-alter-repair-ai-report-for-v13.migration.ts`                            | `bb28ca2c1754824bade94b99052d8887c69c77175f065ab8566882b60a1d814f` |
|  34 | `1775501200000` | `1775501200000-create-stored-file-and-repair-intake-for-v13.migration.ts`              | `13c50b7b2dad6d34b816fa6904126bcdd95326fb82cc9edec7602b9f07f9903a` |
|  35 | `1775501300000` | `1775501300000-create-report-fault-and-revisions-for-v13.migration.ts`                 | `75bd5b226fb1ae7b0bfe06fab0a6931a9043d1b7d7169e6b8b6aaa90f8eb2a86` |
|  36 | `1775501400000` | `1775501400000-create-local-sync-and-package-for-v13.migration.ts`                     | `c6e0090402c5018eea18fa9bab7a33953346857257149b5dbc2030c87939a903` |
|  37 | `1775501500000` | `1775501500000-create-backup-and-audit-for-v13.migration.ts`                           | `3207d0f50b07902169b0215720a7db1c8e91c65987a8d059ae76ca154574ddbf` |
|  38 | `1775501600000` | `1775501600000-fix-json-snapshot-version-checks-for-v13.migration.ts`                  | `826647d4ce7e5c8b7dedc1b44a19085abdb442a85a1ecb29d48905e41a6af0f5` |
|  39 | `1775501700000` | `1775501700000-add-record-package-check-and-import-result-states-for-v13.migration.ts` | `2c59866f614ba4b4b783f54bde7a9907f6759250d45aa2d0760f114177a6ecfb` |

## 使用边界

- 本文只冻结候选，不构成迁移执行或验收通过。
- 前 31 条为已接受基线；第 32—39 条为本轮 V13 追加迁移。任何文件内容变化都必须重新冻结，并说明旧证据不能沿用的范围。
- 第 39 条文件 SHA-256 为 `2c59866f614ba4b4b783f54bde7a9907f6759250d45aa2d0760f114177a6ecfb`；新实库规格在构建 38 态和升级前会运行时校验该值。

## 附录 A：2026-11-09 经批准修订（第二轮）

以上 39 行清单保留为**修订前历史冻结值**，不覆盖、不改写；本节记录本次获批变更后的现行值。

| 项                                                                                         | 修订前                                                                              | 修订后                                                                      | 依据                                                             |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 第 32 条 `1775501100000-alter-repair-ai-report-for-v13.migration.ts`                       | `bb28ca2c1754824bade94b99052d8887c69c77175f065ab8566882b60a1d814f`                  | `ee5868be919bc4bd9e7342a1f400109d440cd2824be2b18e7482eaeab1edda2c`          | 用户 2026-11-09 明确批准的第 32 条例外修复（1—5 + 前置兼容预检） |
| 第 40 条 `1775501800000-restore-maintenance-report-helpfulness-range-for-v13.migration.ts` | 不存在                                                                              | `2265008f0e708e0644220fee72a8eb42b9a339ec588573bfb913503a3970889b`          | 追加修复迁移（已执行旧版第 32 条的目标收敛到 1—5）               |
| 迁移文件数                                                                                 | 39                                                                                  | 40                                                                          | 同上                                                             |
| 全量聚合（`sha256sum <40 行清单文本>`）                                                    | `8827ded2c1b71aacf3a03b692a847a7f00222dfdbc3e4d19345811783e67707f`（39 行，历史值） | `c7d6eb6780078f780b350421ec1ad05ef9d36cd5963c534cdead7ff0ebfb10cd`（40 行） | 同上                                                             |

核对结论（逐文件比对原 39 行清单）：

- 变化的只有第 32 条一个文件；其余 38 个文件的 SHA-256 与上表完全一致。
- 新增第 40 条一个文件，无其他新增、删除或重命名。
- 前 31 条与 `1775501000000` 均未改动。
- 原 39 条聚合 `8827ded2…` 在修订后**无法复算**，仅作为历史冻结值保留；任何引用都必须说明对应版本。
- 修订前文件字节由重建快照校验：按本附录记录的删改点反向还原后 SHA-256 恰为 `bb28ca2c…`，可证 diff 精确。

## 附录 B：2026-11-09 S5 剩余裁决修订（第三轮）

以上正文 39 行与附录 A 的 40 行记录均保留为历史冻结值，不覆盖、不改写；本节记录 `1775501900000` 候选首次冻结与现行 41 条清单。

| 项                                                                                              | 值                                                                 | 依据                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| 第 41 条 `1775501900000-close-s5-structural-gaps-for-v13.migration.ts`                          | `b556b7a3742b9ad7c8612a2f2398e965f42b37b03f8f255f222b9734b65d8315` | S5 Q11/Q13/Q16/Q17/Q18 落实（§13.8），尚未实库验收       |
| 第 32 条 `1775501100000-alter-repair-ai-report-for-v13.migration.ts`（现行）                    | `f4f1f0652aa7f845fb216d3f5b49b854ce5a2c4f304f168b55087e92f3858874` | 附录 A 后仅更新过时说明注释，无 DDL 变化（旧值仍保留为历史） |
| 第 40 条 `1775501800000-restore-maintenance-report-helpfulness-range-for-v13.migration.ts`      | `2265008f0e708e0644220fee72a8eb42b9a339ec588573bfb913503a3970889b` | 与附录 A 一致                                             |
| 迁移文件数                                                                                      | 41                                                                 | 31 基线 + 第 32—41 条                                     |
| 全量聚合（`sha256sum <41 行清单文本>`，`LC_ALL=C` 排序）                                        | `bd8790b7f1ee149f1728deeb330ae0ac5ce8c62c383c5e982fe12236723d774a` | 本轮复算                                                 |

核对结论：

- 原 39 行、附录 A 的 40 行聚合值均无法用于 41 条清单，只能作为对应版本的历史证据引用。
- 本轮新增只包含第 41 条一个迁移文件；第 32 条仅注释修订，第 40 条与附录 A 一致。
- 迁移历史允许“追加新文件 + 注释级修订”，不允许改写已执行迁移的 DDL；任何 DDL 变化必须新增追加迁移并重新冻结。
