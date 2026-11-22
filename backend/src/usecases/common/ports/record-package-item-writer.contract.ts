// src/usecases/common/ports/record-package-item-writer.contract.ts

/**
 * 记录包逐条导入的**受控写入端口**（任务 09 S3.2）。
 *
 * 为什么是端口而不是直接调用来源域用例：
 * - usecase 层只允许同域依赖（`local-architecture/no-cross-domain-usecases-imports`），
 *   任务 09 的导入编排不能直接 import 维修报告／资料／工单域的写入入口；
 * - 更重要的是：**写入必须走来源业务既有的受控入口**（身份、公司范围、版本条件
 *   都由来源域裁决），任务 09 不另立第二套权限口径（与「保留本地」同一条纪律）。
 *
 * 因此约定：
 * - 端口令牌落在 `usecases/common/**.contract.ts`（跨域边界契约，守卫放行）；
 * - **由来源域提供实现**并注册令牌；任务 09 在**调用期**惰性查找实现
 *   （未注册＝没有受控写入入口，逐条失败关闭，不静默跳过）；
 * - 端口返回**逐条结论**，由任务 09 落 `record_package_item.result`。
 */

import type { UsecaseSession } from '@app-types/auth/session.types';

/** 端口令牌（DI 注入用） */
export const RECORD_PACKAGE_ITEM_WRITER = 'RECORD_PACKAGE_ITEM_WRITER';

/** 可导入的资源类型 */
export type RecordPackageImportResourceType =
  'REFERENCE_DOCUMENT' | 'REPAIR_REQUEST' | 'MAINTENANCE_REPORT';

/** 单条导入的写入请求 */
export type RecordPackageItemWriteRequest = {
  resourceType: RecordPackageImportResourceType;
  /** 业务稳定编号（跨端一致；导入后按来源域能力决定是否保留） */
  recordUuid: string;
  /** 包内登记的业务版本号 */
  versionNo: number;
  /** 目标公司数据区（来源域会按会话复核，冲突即拒绝） */
  organizationId: number;
  /** 包内容快照（受控载荷，由来源域做形状校验） */
  body: Record<string, unknown>;
  /**
   * 已暂存的原件事实（S3 补丁 P3）。
   *
   * **不是包内路径**：编排侧按包根安全解析、复核字节数与 SHA-256 后，先登记为
   * 任务 11 的临时文件（VALID+TEMPORARY），再把登记事实交给写入方；
   * 写入方只拿到 `fileId`/`uploadContextId`，**不信任任何路径**。
   */
  originals: {
    fileId: string;
    uploadContextId: string;
    originalFilename: string;
    mimeType: string;
    byteSize: number;
    checksumSha256: string;
  }[];
  /** 正文与原件清单摘要（包清单登记值，来源域可复核） */
  manifestChecksum: string;
  /**
   * 来源账号（原记录作者／责任工程师，S3 补丁 P0-2／P4）。
   *
   * 为 `null` 表示**包内未携带来源身份**（旧包或来源记录本就无持久化作者）：
   * 受控写入方必须**失败关闭**——不得把导入人写成原作者。
   */
  sourceAccountId: number | null;
  /** 来源归属公司（数据为准；与目标公司不一致时受控写入方必须拒绝） */
  ownerOrganizationId: number | null;
  /**
   * 来源业务状态（如报告的 SUBMITTED／APPROVED）：导入正式事实必须知道来源状态，
   * 否则会把已通过结单的内容悄悄降级成待审草稿。缺失时受控写入方必须拒绝。
   */
  sourceStatus: string | null;
};

/** 单条导入的写入结论 */
export type RecordPackageItemWriteOutcome =
  /** 已新建 */
  | { status: 'CREATED'; localRecordId: number; reason: null }
  /** 本机已存在同一记录（重复导入） */
  | { status: 'DUPLICATE'; localRecordId: number | null; reason: null }
  /** 与本机既有事实冲突（版本／内容不一致），需人工裁决 */
  | { status: 'CONFLICT'; localRecordId: number | null; reason: string }
  /** 该资源类型没有受控写入入口，或本次写入被受控入口拒绝 */
  | { status: 'FAILED'; localRecordId: number | null; reason: string };

/** 受控写入端口 */
export interface RecordPackageItemWriter {
  /** 本实现支持的资源类型；不支持的类型必须由调用方判为失败关闭 */
  readonly supportedResourceTypes: readonly RecordPackageImportResourceType[];
  /**
   * 写入一条记录。
   *
   * 实现方**不得**绕过来源域的受控入口直接写业务表；也不得在失败时留下半条业务事实。
   */
  write(
    request: RecordPackageItemWriteRequest,
    session: UsecaseSession,
  ): Promise<RecordPackageItemWriteOutcome>;
}
