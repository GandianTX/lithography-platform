// src/infrastructure/cloud/http-local-backup-cloud.client.ts

/**
 * 云备份服务的**受控 HTTP 客户端**（任务 09 S3.1／S4）。
 *
 * 纪律：
 * - 凭据只在请求头里出现，**不写日志、不进错误信息**（失败原因一律降级为受控码）；
 * - 网络异常、超时、非 2xx 一律映射为**受控失败码**，原始异常只作为 `cause` 保留；
 * - 响应体按"可能是不可信输入"处理：字段逐个校验形态，非法即失败关闭。
 */

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import axios, { type AxiosInstance } from 'axios';

import { LOCAL_CREDENTIAL_PURPOSE } from '@core/local-runtime/policy/local-credential-purpose.policy';
import {
  CLOUD_REMOTE_FAILURE_CODES,
  type CloudRemoteFailureCode,
} from '@core/local-runtime/policy/local-backup-cloud-upload.policy';

import {
  CLOUD_AUTHORIZATION_HEADER,
  CLOUD_PURPOSE_HEADER,
  LOCAL_BACKUP_CLOUD_CONFIG,
  type LocalBackupCloudConfig,
} from './local-backup-cloud.config';

/**
 * 受控失败码（大写下划线；执行层会再校验形态）。
 *
 * 单一来源：core 策略层 `CLOUD_REMOTE_FAILURE_CODES`。
 * 此前客户端自己写了一份同值常量（与策略层那套互不相通）⇒ 两处各改一处会漂移。
 */
export const CLOUD_FAILURE_CODES = CLOUD_REMOTE_FAILURE_CODES;

export type CloudFailureCode = CloudRemoteFailureCode;

export type CloudCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CloudFailureCode; readonly cause?: unknown };

@Injectable()
export class HttpLocalBackupCloudClient {
  readonly http: AxiosInstance;

  constructor(
    @Inject(LOCAL_BACKUP_CLOUD_CONFIG)
    readonly config: LocalBackupCloudConfig,
    private readonly logger: PinoLogger,
  ) {
    this.http = axios.create({ timeout: config.timeoutMs });
  }

  /** 是否已具备调用云服务的最小配置（地址 + 凭据） */
  get configured(): boolean {
    return this.config.baseUrl !== null && this.config.credential !== null;
  }

  /** 拼接云端路径（只拼本模块内的固定相对路径，不接受外部任意 URL） */
  buildUrl(relativePath: string): string {
    const base = this.config.baseUrl;
    if (base === null) {
      throw new Error('云服务地址未配置');
    }
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const normalizedPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  /** 受控请求头：凭据 + 固定云备份用途 */
  headers(): Record<string, string> {
    const credential = this.config.credential;
    if (credential === null) {
      throw new Error('云服务凭据未配置');
    }
    return {
      [CLOUD_AUTHORIZATION_HEADER]: `Bearer ${credential}`,
      [CLOUD_PURPOSE_HEADER]: LOCAL_CREDENTIAL_PURPOSE.CLOUD_BACKUP,
    };
  }

  /**
   * 发起一次受控请求：任何异常都映射为受控失败码。
   *
   * @param parse 响应体解析器；返回 null 表示形态非法（按失败关闭处理）
   */
  async call<T>(
    run: () => Promise<{ status: number; data: unknown }>,
    parse: (data: unknown) => T | null,
  ): Promise<CloudCallResult<T>> {
    if (!this.configured) {
      return { ok: false, code: CLOUD_FAILURE_CODES.CLOUD_NOT_CONFIGURED };
    }
    try {
      const response = await run();
      if (response.status >= 200 && response.status < 300) {
        const parsed = parse(response.data);
        if (parsed === null) {
          return { ok: false, code: CLOUD_FAILURE_CODES.CLOUD_INVALID_RESPONSE };
        }
        return { ok: true, value: parsed };
      }
      if (response.status >= 500) {
        return { ok: false, code: CLOUD_FAILURE_CODES.CLOUD_SERVER_ERROR };
      }
      return { ok: false, code: CLOUD_FAILURE_CODES.CLOUD_REJECTED };
    } catch (error) {
      const code = resolveNetworkFailureCode(error);
      // 原始异常只进服务端日志（凭据不在异常里，但仍不外泄到调用方）
      this.logger.error({ err: error, code }, '云备份服务调用失败');
      return { ok: false, code, cause: error };
    }
  }
}

/**
 * 网络类异常 → 受控失败码（不把原始文本带给调用方）。
 *
 * 口径（此前这里把 4xx／5xx 一律报成"云端不可达"，是**错误**的）：
 * - axios 默认 `validateStatus` 只接受 2xx ⇒ **非 2xx 一律 reject**，
 *   `run()` 内的 `status >= 500` 与"其余即 REJECTED"两个分支在生产路径**不可达**；
 * - 因此必须在 catch 分支里读 `error.response.status`：
 *   5xx ⇒ 服务端异常、4xx ⇒ 云端拒绝、其余 ⇒ 不可达；
 * - 否则"云端明确拒绝（载荷不合规／配额／权限）"会被报成"网络不可达"，
 *   排障方向被带偏，且 `CLOUD_REJECTED`／`CLOUD_SERVER_ERROR` 两个码**永远产生不出来**。
 *
 * 对照：业务同步链 `http-business-sync-receiver.ts` 同样检查 `error.response.status`。
 */
export function resolveNetworkFailureCode(error: unknown): CloudFailureCode {
  const candidate = error as { code?: unknown; response?: { status?: unknown } } | null;
  const status = candidate?.response?.status;
  if (typeof status === 'number') {
    if (status >= 500) {
      return CLOUD_FAILURE_CODES.CLOUD_SERVER_ERROR;
    }
    if (status >= 400) {
      return CLOUD_FAILURE_CODES.CLOUD_REJECTED;
    }
  }
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return CLOUD_FAILURE_CODES.CLOUD_TIMEOUT;
  }
  return CLOUD_FAILURE_CODES.CLOUD_UNREACHABLE;
}
