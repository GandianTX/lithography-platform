// src/modules/lithography/record-package-export.types.ts

import type { LocalRuntimeViewerScope } from '@core/local-runtime/policy/local-runtime-viewer-scope.policy';
import type {
  RecordPackageItemRejection,
  RecordPackageResourceType,
} from '@core/local-runtime/policy/record-package-manifest.policy';

/**
 * 记录包导出契约（任务 09 R070，S2.3）。
 *
 * 导出是**逐条结果**语义：范围内不存在/归属未知/版本未生效/文件不可读
 * 的条目单独拒绝，不影响其他条目；全部失败时整包不产生。
 * 条目身份（record_uuid）由导出侧确定性派生（见 record-package-export.policy）。
 */

/**
 * 来源账号**可移植身份**的解析契约（窄类型契约，任务 09 S1-2）。
 *
 * 为什么用契约而不是直接依赖账号域：
 * - 账号域（`modules/account`）与业务域（`modules/lithography`）是**并列的业务模块**，
 *   业务模块之间不得直接依赖（AGENTS「Business `modules` may depend on `modules/common`,
 *   but not on other business-domain modules」）；
 * - 跨域读取按「提升到 usecase 编排」处理：本契约由 **usecase 层**用账号域
 *   QueryService 组装后传入，服务层只调用它取事实，不认识账号域。
 *
 * 返回值全部可空：账号行缺失或历史行未生成稳定标识时如实返回 null，
 * 不得回退到数字 id 猜测。
 */
export type RecordPackageSourceIdentityResolver = (accountId: number) => Promise<{
  /** 跨端稳定账号标识（`base_user_account.account_uuid`） */
  accountUuid: string | null;
  /** 可移植账号名（`base_user_account.login_name`） */
  loginName: string | null;
  /** 姓名快照（交叉核对用） */
  name: string | null;
}>;

export type RecordPackageExportCommand = {
  organizationId: number;
  /** 导出目标目录（本机绝对路径；必须不存在或为空目录，防覆盖） */
  targetPath: string;
  resourceType: RecordPackageResourceType;
  recordIds: number[];
  /**
   * 导出人账号（会话账号）：逐条记录级授权的"本人"判定事实。
   * 此前该参数被命名为 `_exportedByAccountId` 且**完全未使用**，
   * 导致导出侧只按公司范围放行（任务 09 S1-3 已修）。
   */
  exporterAccountId: number;
  /** 导出人的查看者范围（一级／二级／工程师；服务端按会话复核） */
  exporterScope: LocalRuntimeViewerScope;
  /** 来源账号可移植身份的解析契约（由 usecase 层注入账号域读取能力） */
  resolveSourceIdentity: RecordPackageSourceIdentityResolver;
};

/** 已完成读取与文件登记的导出条目（进入清单） */
export type RecordPackageExportEntry = {
  recordId: number;
  recordUuid: string;
  resourceType: RecordPackageResourceType;
  versionNo: number;
  contentSnapshot: unknown;
  files: RecordPackageExportFileEntry[];
  /**
   * 来源账号（原记录作者／责任工程师）：随包入清单，导入侧据此核验并保持原作者
   * （S3 补丁 P0-2／P4）。**不得**用导入人冒充原作者。
   */
  sourceAccountId: number | null;
  /**
   * 来源账号的**跨端稳定标识**（`base_user_account.account_uuid`）。
   * 目标机按列查找命中即证明是同一条账号事实；未命中时导入侧再按账号名映射。
   */
  sourceAccountUuid: string | null;
  /** 来源账号的**可移植账号名**（`login_name`）：次级映射依据。 */
  sourceAccountLoginName: string | null;
  /** 来源账号的姓名快照（交叉核对用，不作唯一判据） */
  sourceAccountName: string | null;
  /** 来源归属公司（数据为准） */
  ownerOrganizationId: number;
  /**
   * 关联记录的跨端稳定编号（如工单总结关联的工单 `repair_request.record_uuid`）。
   * 目标机据此定位"那一张工单"，不按源机数字外键猜。
   */
  relatedRecordUuid: string | null;
  /** 关联记录的资源类型（如 `REPAIR_REQUEST`） */
  relatedRecordType: string | null;
  /** 来源记录的设备机型编码（`equipment_model.model_code`）：跨设备定位机型的稳定依据 */
  sourceEquipmentModelCode: string | null;
  /** 来源业务状态（导入正式事实需要知道来源状态；不适用时为 null） */
  sourceStatus: string | null;
};

/** 包内文件与来源的对应关系（复制时流式核对） */
export type RecordPackageExportFileEntry = {
  relativePath: string;
  /** 来源存储引用（由服务端登记，导出层经只读流读取，不经手绝对路径） */
  storageReference: string;
  /** 登记的校验值（可空：来源未登记时只实测写入清单） */
  expectedSha256: string | null;
  expectedByteSize: number | null;
};

/** 逐条导出结论 */
export type RecordPackageExportItemOutcome = {
  recordId: number;
  recordUuid: string | null;
  resourceType: RecordPackageResourceType;
  versionNo: number | null;
  outcome: 'EXPORTED' | 'REJECTED';
  rejection: RecordPackageItemRejection | null;
  message: string | null;
};

export type RecordPackageExportResult = {
  packageId: string;
  packagePath: string;
  organizationId: number;
  resourceType: RecordPackageResourceType;
  manifestChecksum: string;
  itemTotal: number;
  itemExported: number;
  itemFailed: number;
  items: RecordPackageExportItemOutcome[];
};
