// src/infrastructure/ai/rag/rag-diagnosis-http.client.ts
// RAG 公共诊断客户端的受控 HTTP 实现（S2.1–S2.3 / RAG-A01、A03、A04）。
//
// 行为约束：
// - 目标和密钥只取自受控配置；缺失、禁用或非法一律 `CONFIG_ERROR`，不发起请求；
// - 每次 `diagnose` 最多一次请求，不重试；发起前已取消为零请求；
// - 禁用重定向、TLS 校验保持 Node 默认开启，明文 HTTP 仅在显式开关下允许；
// - 本地校验失败 `INVALID_INPUT`；网络、429／503、重定向归 `SERVICE_UNAVAILABLE`；
// - 截止与取消由先发生者决定，响应解码超过 1 MiB 在解析前拒绝；
// - 任何原始传输异常都不外泄，只记录脱敏后的归类信息。

import { Logger, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RAG_DIAGNOSIS_ERROR_CODES,
  RAG_DIAGNOSIS_RESPONSE_MAX_BYTES,
  type RagDiagnosisClient,
  type RagDiagnosisErrorCode,
  type RagDiagnosisFailure,
  type RagDiagnosisInput,
  type RagDiagnosisOptions,
  type RagDiagnosisResult,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
import { buildRagDiagnosisRequest } from './rag-diagnosis-request';
import { parseRagDiagnosisResponse } from './rag-diagnosis-response';

type RagDiagnosisTerminalCause = 'TIMEOUT' | 'CANCELLED';

type ResolvedRagDiagnosisConfig = Readonly<{
  endpoint: URL;
  apiKey: string;
  timeoutMs: number;
}>;

type ResolveConfigResult =
  Readonly<{ ok: true; config: ResolvedRagDiagnosisConfig }> | Readonly<{ ok: false }>;

const MAX_TIMEOUT_MS = 2_147_483_647;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

@Injectable()
export class RagDiagnosisHttpClient implements RagDiagnosisClient {
  private readonly logger = new Logger(RagDiagnosisHttpClient.name);

  constructor(private readonly configService: ConfigService) {}

  async diagnose(
    input: RagDiagnosisInput,
    options?: RagDiagnosisOptions,
  ): Promise<RagDiagnosisResult> {
    // 失败结果只回显调用方传入的原始 ID，不在此归一化；发送与回显比较统一使用已校验信封 ID。
    const requestId = isRecord(input) && typeof input.requestId === 'string' ? input.requestId : '';

    try {
      // 发起前已取消：不读配置、不构造请求，直接零请求返回。
      if (options?.signal?.aborted === true) {
        return this.failure(requestId, RAG_DIAGNOSIS_ERROR_CODES.CANCELLED);
      }

      const built = buildRagDiagnosisRequest(input);
      if (!built.ok) {
        return this.failure(requestId, built.code);
      }

      const resolved = this.resolveConfig();
      if (!resolved.ok) {
        this.logger.warn(
          { event: 'rag_diagnosis_config_invalid' },
          'RAG 诊断客户端未启用或配置非法',
        );
        return this.failure(requestId, RAG_DIAGNOSIS_ERROR_CODES.CONFIG_ERROR);
      }

      return await this.execute({
        requestId: built.envelope.requestId,
        body: built.body,
        config: resolved.config,
        externalSignal: options?.signal,
      });
    } catch {
      // 兜底：任何未预期异常都转为可辨识错误，不把原始异常抛给消费方。
      return this.failure(requestId, RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
  }

  private async execute(params: {
    readonly requestId: string;
    readonly body: string;
    readonly config: ResolvedRagDiagnosisConfig;
    readonly externalSignal?: AbortSignal;
  }): Promise<RagDiagnosisResult> {
    const { requestId, body, config, externalSignal } = params;
    const startedAt = Date.now();
    const controller = new AbortController();
    let terminal: RagDiagnosisTerminalCause | null = null;

    const markTerminal = (cause: RagDiagnosisTerminalCause): void => {
      if (terminal !== null) {
        return;
      }
      terminal = cause;
      controller.abort();
    };
    const onExternalAbort = (): void => markTerminal('CANCELLED');

    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      if (externalSignal.aborted) {
        onExternalAbort();
      }
    }
    const timer = setTimeout(() => markTerminal('TIMEOUT'), config.timeoutMs);

    const getTerminal = (): RagDiagnosisTerminalCause | null => terminal;

    try {
      let response: Response;
      try {
        response = await fetch(config.endpoint, {
          method: 'POST',
          headers: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Content-Type': 'application/json',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            Accept: 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        return this.loggedFailure({
          requestId,
          code: this.classifyTerminal(terminal),
          durationMs: Date.now() - startedAt,
          endpoint: config.endpoint,
        });
      }

      return await this.handleResponse({
        response,
        requestId,
        startedAt,
        config,
        getTerminal,
      });
    } catch {
      return this.loggedFailure({
        requestId,
        code: this.classifyTerminal(terminal),
        durationMs: Date.now() - startedAt,
        endpoint: config.endpoint,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async handleResponse(params: {
    readonly response: Response;
    readonly requestId: string;
    readonly startedAt: number;
    readonly config: ResolvedRagDiagnosisConfig;
    readonly getTerminal: () => RagDiagnosisTerminalCause | null;
  }): Promise<RagDiagnosisResult> {
    const { response, requestId, startedAt, config, getTerminal } = params;
    const fail = (code: RagDiagnosisErrorCode): RagDiagnosisFailure =>
      this.loggedFailure({
        requestId,
        code,
        status: response.status,
        durationMs: Date.now() - startedAt,
        endpoint: config.endpoint,
      });

    const terminal = getTerminal();
    if (terminal !== null) {
      await this.discard(response);
      return fail(this.classifyTerminal(terminal));
    }

    if (!response.ok) {
      await this.discard(response);
      return fail(this.mapStatus(response.status));
    }

    if (this.declaresOversizedBody(response)) {
      await this.discard(response);
      return fail(RAG_DIAGNOSIS_ERROR_CODES.INVALID_RESPONSE);
    }

    const bytes = await this.readBody(response);
    if (bytes === null) {
      return fail(RAG_DIAGNOSIS_ERROR_CODES.INVALID_RESPONSE);
    }

    const parsed = parseRagDiagnosisResponse({ bytes, requestId });
    if (!parsed.ok) {
      return fail(RAG_DIAGNOSIS_ERROR_CODES.INVALID_RESPONSE);
    }

    return {
      ok: true,
      requestId,
      text: parsed.text,
      visualization: parsed.visualization,
    };
  }

  private resolveConfig(): ResolveConfigResult {
    const rawMode = this.configService.get<unknown>('ragDiagnosis.mode');
    const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : 'remote';
    if (mode !== 'remote') {
      return { ok: false };
    }

    const baseUrl = this.configService.get<string>('ragDiagnosis.baseUrl', '');
    const apiKey = this.configService.get<string>('ragDiagnosis.apiKey', '');
    const timeoutMs = this.configService.get<number>('ragDiagnosis.timeoutMs', 30000);
    const allowInsecureHttp =
      this.configService.get<boolean>('ragDiagnosis.allowInsecureHttp', false) === true;

    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      return { ok: false };
    }
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return { ok: false };
    }
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      return { ok: false };
    }

    const endpoint = this.resolveEndpoint(baseUrl, allowInsecureHttp);
    if (endpoint === null) {
      return { ok: false };
    }

    return {
      ok: true,
      config: {
        endpoint,
        apiKey: apiKey.trim(),
        timeoutMs,
      },
    };
  }

  private resolveEndpoint(baseUrl: string, allowInsecureHttp: boolean): URL | null {
    let endpoint: URL;
    try {
      endpoint = new URL(baseUrl);
    } catch {
      return null;
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      return null;
    }
    if (endpoint.protocol === 'http:' && !allowInsecureHttp) {
      return null;
    }
    if (endpoint.username.length > 0 || endpoint.password.length > 0) {
      return null;
    }

    // 目标地址只接受受控 base URL；查询串与片段不参与调用，统一清空避免泄漏。
    endpoint.search = '';
    endpoint.hash = '';
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/diagnose`;
    return endpoint;
  }

  private classifyTerminal(terminal: RagDiagnosisTerminalCause | null): RagDiagnosisErrorCode {
    if (terminal === 'TIMEOUT') {
      return RAG_DIAGNOSIS_ERROR_CODES.TIMEOUT;
    }
    if (terminal === 'CANCELLED') {
      return RAG_DIAGNOSIS_ERROR_CODES.CANCELLED;
    }
    return RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE;
  }

  private mapStatus(status: number): RagDiagnosisErrorCode {
    if (status === 401) {
      return RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAUTHORIZED;
    }
    if (status === 403) {
      return RAG_DIAGNOSIS_ERROR_CODES.SERVICE_FORBIDDEN;
    }
    if (status === 413 || status === 422) {
      return RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT;
    }
    if (status === 504) {
      return RAG_DIAGNOSIS_ERROR_CODES.TIMEOUT;
    }
    return RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE;
  }

  private declaresOversizedBody(response: Response): boolean {
    const raw = response.headers.get('content-length');
    if (raw === null) {
      return false;
    }
    const declared = Number(raw);
    return Number.isFinite(declared) && declared > RAG_DIAGNOSIS_RESPONSE_MAX_BYTES;
  }

  private async readBody(response: Response): Promise<Uint8Array | null> {
    const body = response.body;
    if (!body) {
      return null;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > RAG_DIAGNOSIS_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks, total);
  }

  private async discard(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // 收尾失败不影响归类结果。
    }
  }

  private loggedFailure(input: {
    readonly requestId: string;
    readonly code: RagDiagnosisErrorCode;
    readonly status?: number;
    readonly durationMs: number;
    readonly endpoint: URL;
  }): RagDiagnosisFailure {
    if (input.code !== RAG_DIAGNOSIS_ERROR_CODES.CANCELLED) {
      this.logger.warn(
        {
          event: 'rag_diagnosis_call_failed',
          requestId: input.requestId,
          code: input.code,
          status: input.status ?? null,
          durationMs: input.durationMs,
          endpoint: `${input.endpoint.origin}${input.endpoint.pathname}`,
        },
        'RAG 诊断调用失败',
      );
    }
    return this.failure(input.requestId, input.code);
  }

  private failure(requestId: string, code: RagDiagnosisErrorCode): RagDiagnosisFailure {
    return { ok: false, requestId, code };
  }
}
