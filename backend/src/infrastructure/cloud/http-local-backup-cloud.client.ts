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
  CLOUD_AUTHORIZATION_HEADER,
  CLOUD_PURPOSE_HEADER,
  LOCAL_BACKUP_CLOUD_CONFIG,
  type LocalBackupCloudConfig,
} from './local-backup-cloud.config';

/** 受控失败码（大写下划线；执行层会再校验形态） */
export const CLOUD_FAILURE_CODES = {
  CLOUD_NOT_CONFIGURED: 'CLOUD_NOT_CONFIGURED',
  CLOUD_UNREACHABLE: 'CLOUD_UNREACHABLE',
  CLOUD_TIMEOUT: 'CLOUD_TIMEOUT',
  CLOUD_REJECTED: 'CLOUD_REJECTED',
  CLOUD_SERVER_ERROR: 'CLOUD_SERVER_ERROR',
  CLOUD_INVALID_RESPONSE: 'CLOUD_INVALID_RESPONSE',
} as const;

export type CloudFailureCode = (typeof CLOUD_FAILURE_CODES)[keyof typeof CLOUD_FAILURE_CODES];

export type CloudCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CloudFailureCode; readonly cause?: unknown };

@Injectable()
export class HttpLocalBackupCloudClient {
  readonly http: AxiosInstance;

  constructor(
    @Inject(LOCAL_BACKUP_CLOUD_CONFIG)
    private readonly config: LocalBackupCloudConfig,
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

/** 网络类异常 → 受控失败码（不把原始文本带给调用方） */
export function resolveNetworkFailureCode(error: unknown): CloudFailureCode {
  const candidate = error as { code?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return CLOUD_FAILURE_CODES.CLOUD_TIMEOUT;
  }
  return CLOUD_FAILURE_CODES.CLOUD_UNREACHABLE;
}
