// src/usecases/stored-file/cleanup-expired-stored-files.usecase.ts

/**
 * 过期暂存原件清理用例（任务 09 P3-3 跨资源失败补偿）。
 *
 * 语义：
 * - **受理 ≠ 已清理**：本用例只做"扫描 → 裁决 → 逐项执行 → 逐项记结果"，
 *   不产生"全部已清理"的笼统结论；每项都有 `CLEANED`／`RETAINED`／`FAILED` 与原因；
 * - 范围＝**本机安装映射的公司**（未映射则不清理，不猜公司、不跨公司清理）；
 * - 保留窗口到期且**未被任何业务引用**的暂存行才会被释放并回收字节；
 *   被引用的原件（含退役但仍持外键的附件）**一律保留**。
 *
 * 底层事实与执行在 `modules/lithography/stored-file-retention.service.ts`，
 * 判定口径在 `core/stored-file/policy/stored-file-retention.policy.ts`（纯函数）。
 */

import { Injectable } from '@nestjs/common';

import {
  StoredFileRetentionService,
  type StoredFileRetentionResult,
} from '@src/modules/lithography/stored-file-retention.service';

export type CleanupExpiredStoredFilesCommand = {
  /** 覆盖保留窗口（天）；缺省用策略层常量 */
  retentionDays?: number;
  /** 单次候选上限 */
  limit?: number;
};

@Injectable()
export class CleanupExpiredStoredFilesUsecase {
  constructor(private readonly storedFileRetentionService: StoredFileRetentionService) {}

  async execute(
    command: CleanupExpiredStoredFilesCommand = {},
  ): Promise<StoredFileRetentionResult> {
    return this.storedFileRetentionService.cleanupAllExpired({
      now: new Date(),
      retentionDays: command.retentionDays,
      limit: command.limit,
    });
  }
}
