// src/usecases/repair-request/create-repair-request.types.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { RepairRequestSnapshot } from '@src/modules/lithography/lithography.types';

/**
 * 创建维修申请的身份快照（由 adapter 从可信 JWT 映射，客户端不可传）。
 *
 * 直接复用 `UsecaseSession`：客户公司与角色判定只认服务端事实
 * （客户公司仍在事务内按 `base_user_info.customer_organization_id` 复核）。
 */
export type CreateRepairRequestSession = UsecaseSession;

/** 客户私有报修原件引用（暂存态；绑定在提交事务内完成） */
export type CreateRepairRequestAttachmentInput = {
  fileId: string;
  uploadContextId: string;
};

/**
 * 创建维修申请命令。
 *
 * 字段为 adapter 结构校验后的原始输入；空白语义、长度语义、机型二选一、
 * 提交标识格式与附件成对关系由 usecase 判定（直调 usecase 不得绕过）。
 */
export type CreateRepairRequestCommand = {
  session: CreateRepairRequestSession;
  /** 稳定提交标识（36 位 UUID）：双击 / 并发 / 响应丢失重发都复用它 */
  recordUuid: string;
  /** 选定维修厂家（启用且具备维修服务资格，事务内复核） */
  serviceOrganizationId: number;
  /** 选择已有机型的 ID 与手填机型文本严格二选一 */
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  errorCode: string;
  faultDescription: string;
  /** 可选原件；未上传为 null */
  attachment?: CreateRepairRequestAttachmentInput | null;
};

/**
 * 创建维修申请结果。
 *
 * - `request`：真实的唯一工单快照（首次创建或同标识重放的原工单）；
 * - `intake`：报修原稿与首析执行意图（`WAITING` + 代次 0 由服务端落库）；
 * - `replayed`：本次是否命中间一提交标识并返回原记录（仅供适配层/测试观测，
 *   不改变客户端语义：两种情形都表示「本次提交有且仅有一套数据」）。
 */
export type CreateRepairRequestResult = {
  request: RepairRequestSnapshot;
  intake: {
    intakeId: number;
    analysisStatus: string;
    analysisGeneration: number;
  };
  replayed: boolean;
  /** 内部字段：事务内登记的首析投递 traceId（重放路径为 null），供事务后投递使用 */
  analysisTraceId: string | null;
  /**
   * 首析投递观测（任务 03 第二段）：traceId 是账本与队列的链路锚点，
   * delivered=false 表示事务提交后的入队未完成，housekeeping 会凭账本行补投。
   * 同标识重放路径不产生新投递意图，为 null。
   */
  analysisDelivery: {
    traceId: string;
    delivered: boolean;
  } | null;
};
