// src/usecases/common/ports/business-sync-receiver.contract.ts
/**
 * 业务同步接收端契约（任务 09 S2.2）。
 *
 * 边界归属：把本机记录同步到云端并取回核对结果属本任务业务决策，故契约由
 * usecases 层声明，infrastructure 只提供实现。契约只描述"送出一份待同步内容
 * 并取回核对回包"，不描述云端内部实现，也不携带本机密钥材料。
 *
 * 装配口径：**未注册实现即视为生产接收端缺失**——派发链据此把任务留在待传
 * 状态（可续传），不得伪造成功。受控替身只允许在可丢弃环境显式装配。
 */

import type {
  BusinessSyncDispatchRequest,
  BusinessSyncReceiverResponse,
} from '@core/local-runtime/policy/business-sync-protocol.policy';

export const BUSINESS_SYNC_RECEIVER = Symbol('BUSINESS_SYNC_RECEIVER');

export type BusinessSyncReceiver = {
  /** 送出一份待同步内容并取回核对回包 */
  send(request: BusinessSyncDispatchRequest): Promise<BusinessSyncReceiverResponse>;
};

export type { BusinessSyncDispatchRequest, BusinessSyncReceiverResponse };
