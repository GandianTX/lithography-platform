/**
 * 业务同步接收端**受控替身**（任务 09 S2.2）。
 *
 * 用途：生产云接收端尚不可用（R-02 缺口）时，在**可丢弃环境**里按显式剧本产出
 * 核对回包，让本机派发链的落库路径（回执、冲突、续传）可被验证。
 *
 * 口径边界：
 * - 只存在于测试目录，**不注册到任何生产装配**：生产环境永远没有接收端，
 *   派发链据此把任务留在待传状态，绝不伪造成功；
 * - 剧本必须由用例显式给出，没有"自动成功"的乐观默认；
 * - 回包按剧本回显公司、身份、版本、摘要与已收原件清单，便于核对差异来源。
 */

import type {
  BusinessSyncDispatchRequest,
  BusinessSyncReceiverResponse,
} from '@core/local-runtime/policy/business-sync-protocol.policy';

/** 受控替身剧本 */
export type BusinessSyncReceiverStubScript =
  /** 云端接受：回显本机版本与摘要，并确认收到全部原件 */
  | { kind: 'ACCEPT' }
  /** 云端存在更新版本：需人工裁决 */
  | { kind: 'CONFLICT'; cloudVersionNo: number }
  /** 云端明确拒绝 */
  | { kind: 'REJECT'; reason: string }
  /** 部分成功：只收到部分原件 */
  | { kind: 'DROP_ORIGINALS' }
  /** 网络中断／响应丢失：调用抛错 */
  | { kind: 'ERROR' };

export class BusinessSyncReceiverStub {
  /** 收到的请求留痕（便于断言"发出去的到底是什么"） */
  readonly requests: BusinessSyncDispatchRequest[] = [];

  constructor(private readonly script: BusinessSyncReceiverStubScript) {}

  send(request: BusinessSyncDispatchRequest): Promise<BusinessSyncReceiverResponse> {
    this.requests.push(request);
    switch (this.script.kind) {
      case 'ERROR':
        return Promise.reject(new Error('接收端不可达'));
      case 'REJECT':
        return Promise.resolve({
          status: 'REJECTED',
          reason: this.script.reason,
          organizationId: request.organizationId,
          recordUuid: request.recordUuid,
          versionNo: request.versionNo,
          manifestChecksum: request.manifestChecksum,
          receivedOriginals: [],
          remoteResourceId: null,
          snapshot: null,
          receivedAt: null,
        });
      case 'CONFLICT':
        return Promise.resolve({
          status: 'CONFLICT',
          reason: 'CLOUD_NEWER',
          organizationId: request.organizationId,
          recordUuid: request.recordUuid,
          versionNo: this.script.cloudVersionNo,
          manifestChecksum: 'f'.repeat(64),
          receivedOriginals: request.originals,
          remoteResourceId: 'remote-cloud',
          snapshot: { schema_version: 1, version_no: this.script.cloudVersionNo },
          receivedAt: '2026-11-22T00:00:00.000Z',
        });
      case 'DROP_ORIGINALS':
        return Promise.resolve({
          status: 'ACCEPTED',
          reason: 'ACCEPTED',
          organizationId: request.organizationId,
          recordUuid: request.recordUuid,
          versionNo: request.versionNo,
          manifestChecksum: request.manifestChecksum,
          receivedOriginals: [],
          remoteResourceId: 'remote-partial',
          snapshot: null,
          receivedAt: '2026-11-22T00:00:00.000Z',
        });
      case 'ACCEPT':
      default:
        return Promise.resolve({
          status: 'ACCEPTED',
          reason: 'ACCEPTED',
          organizationId: request.organizationId,
          recordUuid: request.recordUuid,
          versionNo: request.versionNo,
          manifestChecksum: request.manifestChecksum,
          receivedOriginals: request.originals,
          remoteResourceId: 'remote-1',
          snapshot: { schema_version: 1, version_no: request.versionNo },
          receivedAt: '2026-11-22T00:00:00.000Z',
        });
    }
  }
}
