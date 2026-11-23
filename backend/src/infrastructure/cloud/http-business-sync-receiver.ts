// src/infrastructure/cloud/http-business-sync-receiver.ts

/**
 * 业务同步接收端的**受控 HTTP 实现**（任务 09 新计划第 12 项）。
 *
 * 定位：把本机待同步记录**送出**到云端并取回核对回包；
 * 回包按 `core/local-runtime/policy/business-sync-protocol.policy` 的契约解析，
 * **本机不盲信云端**：字段逐个校验形态，非法即失败关闭（由派发链按失败处理）。
 *
 * 纪律（与云备份客户端同一条）：
 * - 凭据只在请求头里出现，**不写日志、不进错误信息**；
 * - 网络异常／超时／非 2xx 一律映射为**受控失败码**，原始异常只作为 `cause` 保留；
 * - 只拼接本模块内固定的相对路径，**不接受外部任意 URL**。
 *
 * 传输口径：`multipart/form-data`（与**备份上传**同一套 multipart 约定）：
 * - 部件 `metadata`：JSON，内容为已接受契约 `BusinessSyncDispatchRequest` 的跨端稳定事实
 *   （公司、身份、版本、正文快照、原件清单摘要、幂等键）；
 * - 部件 `originals/<相对路径>`：**原件的真实字节**。
 *
 * 为什么必须带字节：只送清单等于"只报账不交货"——云端拿不到原件，
 * 完整性核对必然落到 `ORIGINALS_INCOMPLETE`，业务侧表现为"同步永远失败"。
 * 清单说"要传什么"，字节说"真的传了什么"，两者必须逐项对上（本机派发前已复核）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import axios, { type AxiosInstance } from 'axios';

import type {
  BusinessSyncDispatchRequest,
  BusinessSyncReceiverResponse,
} from '@core/local-runtime/policy/business-sync-protocol.policy';
import { LOCAL_CREDENTIAL_PURPOSE } from '@core/local-runtime/policy/local-credential-purpose.policy';
import type { BusinessSyncReceiver } from '@usecases/common/ports/business-sync-receiver.contract';

import { BUSINESS_SYNC_CLOUD_CONFIG, type BusinessSyncCloudConfig } from './business-sync.config';
import { CLOUD_AUTHORIZATION_HEADER, CLOUD_PURPOSE_HEADER } from './local-backup-cloud.config';

/** 受控失败码（大写下划线；**不含**地址、凭据与正文） */
export const BUSINESS_SYNC_FAILURE_CODES = {
  BUSINESS_SYNC_NOT_CONFIGURED: 'BUSINESS_SYNC_NOT_CONFIGURED',
  BUSINESS_SYNC_UNREACHABLE: 'BUSINESS_SYNC_UNREACHABLE',
  BUSINESS_SYNC_TIMEOUT: 'BUSINESS_SYNC_TIMEOUT',
  BUSINESS_SYNC_REJECTED: 'BUSINESS_SYNC_REJECTED',
  BUSINESS_SYNC_SERVER_ERROR: 'BUSINESS_SYNC_SERVER_ERROR',
  BUSINESS_SYNC_INVALID_RESPONSE: 'BUSINESS_SYNC_INVALID_RESPONSE',
  BUSINESS_SYNC_INVALID_PAYLOAD: 'BUSINESS_SYNC_INVALID_PAYLOAD',
} as const;

export type BusinessSyncFailureCode =
  (typeof BUSINESS_SYNC_FAILURE_CODES)[keyof typeof BUSINESS_SYNC_FAILURE_CODES];

/** 业务同步失败（受控；原始异常只作为 cause 保留） */
export class BusinessSyncCallError extends Error {
  constructor(
    readonly code: BusinessSyncFailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BusinessSyncCallError';
  }
}

/** 固定相对路径：只允许本模块内的业务同步入口 */
const BUSINESS_SYNC_RECORDS_PATH = '/business-sync/records';

/** multipart 部件名与文件名：元数据部件 */
const METADATA_PART = 'metadata';
const METADATA_FILE = 'metadata.json';

/**
 * 原件相对路径白名单：只允许 `originals/<文件名>`。
 *
 * 为什么在**发送端**再挡一次：multipart 的部件名来自清单里的相对路径，
 * 部件名会成为接收方的落盘路径成分。清单虽由本机服务端生成（已净化），
 * 但这里再挡一道绝对路径、盘符、`..` 与嵌套分隔符，
 * 保证"即使清单被污染，也不会把路径语义送出去"。
 */
const ORIGINAL_RELATIVE_PATH_PATTERN = /^originals\/[A-Za-z0-9._-]+$/;

@Injectable()
export class HttpBusinessSyncReceiver implements BusinessSyncReceiver {
  private readonly http: AxiosInstance;

  constructor(
    @Inject(BUSINESS_SYNC_CLOUD_CONFIG)
    private readonly config: BusinessSyncCloudConfig,
    private readonly logger: PinoLogger,
  ) {
    this.http = axios.create({ timeout: config.timeoutMs });
  }

  /** 是否已具备调用云端的最小配置（地址 + 凭据） */
  get configured(): boolean {
    return this.config.baseUrl !== null && this.config.credential !== null;
  }

  /** 送出一次待同步内容并取回核对回包 */
  async send(request: BusinessSyncDispatchRequest): Promise<BusinessSyncReceiverResponse> {
    if (!this.configured) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_NOT_CONFIGURED,
        '云端业务同步入口未配置',
      );
    }
    const url = this.buildUrl();
    const headers = this.headers();
    this.assertOriginalRelativePaths(request);
    const payload = {
      organization_id: request.organizationId,
      installation_id: request.installationId,
      account_id: request.accountId,
      resource_type: request.resourceType,
      record_uuid: request.recordUuid,
      version_no: request.versionNo,
      manifest_checksum: request.manifestChecksum,
      body: request.body,
      originals: request.originals.map((original) => ({
        relative_path: original.relativePath,
        sha256: original.sha256,
        byte_size: original.byteSize,
      })),
      idempotency_key: request.idempotencyKey,
    };
    try {
      // multipart：元数据一个部件，原件字节每个一个部件（部件名＝清单里的相对路径）
      const form = new FormData();
      form.append(
        METADATA_PART,
        new Blob([JSON.stringify(payload)], { type: 'application/json' }),
        METADATA_FILE,
      );
      for (const original of request.originalPayloads) {
        form.append(
          original.relativePath,
          new Blob([new Uint8Array(original.bytes)]),
          original.relativePath.split('/').pop() ?? original.relativePath,
        );
      }
      const response = await this.http.post(url, form, {
        // HTTP 头名用计算属性给出（头名是协议字面量，不受属性命名规则约束）
        headers: { ...headers, ['Content-Type']: 'multipart/form-data' },
      });
      return this.parseResponse(response?.data);
    } catch (error) {
      throw this.toControlledError(error);
    }
  }

  /** 拼接云端路径（只拼本模块内的固定相对路径） */
  private buildUrl(): string {
    const base = this.config.baseUrl;
    if (base === null) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_NOT_CONFIGURED,
        '云端业务同步入口未配置',
      );
    }
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalizedBase}${BUSINESS_SYNC_RECORDS_PATH}`;
  }

  /**
   * 原件相对路径白名单校验（发送端最后一道闸）。
   *
   * 清单与字节的相对路径必须**一一对应且都在白名单内**：
   * - 路径不在白名单（绝对路径、盘符、`..`、嵌套分隔符）⇒ 不送出；
   * - 清单与字节的路径集合不一致 ⇒ 不送出（避免"清单说有、字节是另一件"）。
   */
  private assertOriginalRelativePaths(request: BusinessSyncDispatchRequest): void {
    const declared = request.originals.map((original) => original.relativePath);
    const payloadPaths = request.originalPayloads.map((payload) => payload.relativePath);
    const allPaths = [...declared, ...payloadPaths];
    if (allPaths.some((path) => !ORIGINAL_RELATIVE_PATH_PATTERN.test(path))) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
        '原件相对路径不合规，不送出',
      );
    }
    if (declared.length !== payloadPaths.length) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
        '原件清单与字节条目不一致，不送出',
      );
    }
    if (new Set(declared).size !== declared.length) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
        '原件相对路径重复，无法逐项对应，不送出',
      );
    }
    for (const path of declared) {
      if (!payloadPaths.includes(path)) {
        throw new BusinessSyncCallError(
          BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
          '原件清单与字节条目不一致，不送出',
        );
      }
    }
  }

  /** 受控请求头：凭据 + 固定业务同步用途（不得与云备份凭据混用） */
  private headers(): Record<string, string> {
    const credential = this.config.credential;
    if (credential === null) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_NOT_CONFIGURED,
        '云端业务同步凭据未配置',
      );
    }
    return {
      [CLOUD_AUTHORIZATION_HEADER]: `Bearer ${credential}`,
      [CLOUD_PURPOSE_HEADER]: LOCAL_CREDENTIAL_PURPOSE.BUSINESS_SYNC,
    };
  }

  /**
   * 解析回包：按"可能是不可信输入"处理，字段逐个校验形态。
   *
   * 非法即失败关闭（不把非法值透传给本机裁决层）。
   */
  private parseResponse(raw: unknown): BusinessSyncReceiverResponse {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
        '云端回包不是对象',
      );
    }
    const record = raw as Record<string, unknown>;
    const status = record['status'];
    if (status !== 'ACCEPTED' && status !== 'CONFLICT' && status !== 'REJECTED') {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
        '云端回包状态非法',
      );
    }
    const receivedOriginals = record['received_originals'];
    if (!Array.isArray(receivedOriginals)) {
      throw new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
        '云端回包原件清单非法',
      );
    }
    const originals = receivedOriginals.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new BusinessSyncCallError(
          BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
          '云端回包原件条目非法',
        );
      }
      const entry = item as Record<string, unknown>;
      const relativePath = entry['relative_path'];
      const sha256 = entry['sha256'];
      const byteSize = entry['byte_size'];
      if (
        typeof relativePath !== 'string' ||
        typeof sha256 !== 'string' ||
        typeof byteSize !== 'number' ||
        !Number.isInteger(byteSize) ||
        byteSize < 0
      ) {
        throw new BusinessSyncCallError(
          BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
          '云端回包原件条目形态非法',
        );
      }
      return { relativePath, sha256, byteSize };
    });
    return {
      status,
      reason: typeof record['reason'] === 'string' ? record['reason'] : '',
      organizationId:
        typeof record['organization_id'] === 'number' ? record['organization_id'] : null,
      recordUuid: typeof record['record_uuid'] === 'string' ? record['record_uuid'] : null,
      versionNo: typeof record['version_no'] === 'number' ? record['version_no'] : null,
      manifestChecksum:
        typeof record['manifest_checksum'] === 'string' ? record['manifest_checksum'] : null,
      receivedOriginals: originals,
      remoteResourceId:
        typeof record['remote_resource_id'] === 'string' ? record['remote_resource_id'] : null,
      snapshot:
        typeof record['snapshot'] === 'object' && record['snapshot'] !== null
          ? (record['snapshot'] as Record<string, unknown>)
          : null,
      receivedAt: typeof record['received_at'] === 'string' ? record['received_at'] : null,
    };
  }

  /** 网络异常／超时／非 2xx ⇒ 受控失败码（原始异常只作为 cause 保留） */
  private toControlledError(error: unknown): BusinessSyncCallError {
    if (error instanceof BusinessSyncCallError) {
      return error;
    }
    const code = (error as { code?: string } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_TIMEOUT,
        '云端业务同步请求超时',
        error,
      );
    }
    const response = (error as { response?: { status?: number } } | null)?.response;
    if (response !== undefined && response !== null) {
      if (response.status === 400 || response.status === 409 || response.status === 422) {
        return new BusinessSyncCallError(
          BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_REJECTED,
          '云端业务同步拒绝了本次送出',
          error,
        );
      }
      return new BusinessSyncCallError(
        BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_SERVER_ERROR,
        '云端业务同步返回异常状态',
        error,
      );
    }
    this.logger.warn({ reason: message }, '云端业务同步不可达');
    return new BusinessSyncCallError(
      BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_UNREACHABLE,
      '云端业务同步不可达',
      error,
    );
  }
}
