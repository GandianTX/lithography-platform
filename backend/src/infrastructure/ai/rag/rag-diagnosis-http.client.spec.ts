// src/infrastructure/ai/rag/rag-diagnosis-http.client.spec.ts
// S2.1–S2.3 定向验证：配置与装配、零请求、单次调用、截止/取消、响应上限与归类。
// 假服务只监听 127.0.0.1，并在 afterAll 关闭。

import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  RAG_DIAGNOSIS_CLIENT,
  RAG_DIAGNOSIS_ERROR_CODES,
  RAG_DIAGNOSIS_FAULT_KEYS,
  RAG_DIAGNOSIS_RESPONSE_MAX_BYTES,
  type RagDiagnosisClient,
  type RagDiagnosisInput,
  type RagDiagnosisResult,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
import { AddressInfo } from 'node:net';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AiInfrastructureModule } from '../ai-infrastructure.module';
import { QwenGenerateProvider } from '../providers/qwen/qwen-generate.provider';
import { FakeRagDiagnosisClient } from './fake-rag-diagnosis.client';
import { findRagDiagnosisFixture } from './rag-diagnosis.fixture';
import { RagDiagnosisHttpClient } from './rag-diagnosis-http.client';

const FIXTURE_SCENARIOS = [
  'FIRST_ANALYSIS_EMPTY_HISTORY',
  'INDEPENDENT_CHAT',
  'WORK_ORDER_WITH_HISTORY',
] as const;

type RecordedRequest = Readonly<{
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}>;

type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  requests: readonly RecordedRequest[],
) => void;

type TestServer = Readonly<{
  server: Server;
  requests: RecordedRequest[];
  baseUrl: string;
}>;

const fixtureInput = (): RagDiagnosisInput => {
  const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
  if (!fixture) {
    throw new Error('缺少工单样例');
  }
  return fixture.input;
};

const successPayload = (): unknown => {
  const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
  if (!fixture) {
    throw new Error('缺少工单样例');
  }
  return {
    schemaVersion: 1,
    requestId: fixture.input.requestId,
    content: {
      text: fixture.expectedResult.text,
      visualization: fixture.expectedResult.visualization,
    },
  };
};

const failureCode = (result: RagDiagnosisResult): string => {
  if (result.ok) {
    throw new Error(`预期失败结果，实际成功：${result.requestId}`);
  }
  return result.code;
};

const startServer = async (handler: RequestHandler): Promise<TestServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res, requests);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}` };
};

const stopServer = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const createConfigService = (values: ReadonlyMap<string, unknown>): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) =>
      values.has(key) ? values.get(key) : defaultValue,
  }) as unknown as ConfigService;

const buildClient = (input: {
  readonly baseUrl: string;
  readonly mode?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly allowInsecureHttp?: boolean;
}): RagDiagnosisHttpClient =>
  new RagDiagnosisHttpClient(
    createConfigService(
      new Map<string, unknown>([
        ['ragDiagnosis.mode', input.mode ?? 'remote'],
        ['ragDiagnosis.baseUrl', input.baseUrl],
        ['ragDiagnosis.apiKey', input.apiKey ?? 'test-rag-key'],
        ['ragDiagnosis.timeoutMs', input.timeoutMs ?? 30000],
        ['ragDiagnosis.allowInsecureHttp', input.allowInsecureHttp ?? true],
      ]),
    ),
  );

describe('RagDiagnosisHttpClient', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Worker 模块在无密钥时仍可装配，调用返回 CONFIG_ERROR', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              ragDiagnosis: {
                mode: 'remote',
                baseUrl: '',
                apiKey: '',
                timeoutMs: 30000,
                allowInsecureHttp: false,
              },
            }),
          ],
        }),
        AiInfrastructureModule,
      ],
    }).compile();

    try {
      // 无 RAG 密钥不影响模块内既有 AI 能力的装配
      expect(moduleRef.get(QwenGenerateProvider)).toBeInstanceOf(QwenGenerateProvider);
      const client = moduleRef.get<RagDiagnosisClient>(RAG_DIAGNOSIS_CLIENT);
      const result = await client.diagnose(fixtureInput());
      expect(result).toEqual({
        ok: false,
        requestId: fixtureInput().requestId,
        code: RAG_DIAGNOSIS_ERROR_CODES.CONFIG_ERROR,
      });
    } finally {
      await moduleRef.close();
    }
  });

  it('独立消费模块可用注入令牌把真实客户端替换为替身', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              ragDiagnosis: {
                mode: 'disabled',
                baseUrl: '',
                apiKey: '',
                timeoutMs: 30000,
                allowInsecureHttp: false,
              },
            }),
          ],
        }),
        AiInfrastructureModule,
      ],
    })
      .overrideProvider(RAG_DIAGNOSIS_CLIENT)
      .useClass(FakeRagDiagnosisClient)
      .compile();

    const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
    if (!fixture) {
      throw new Error('缺少工单样例');
    }

    try {
      const client = moduleRef.get<RagDiagnosisClient>(RAG_DIAGNOSIS_CLIENT);
      expect(client).toBeInstanceOf(FakeRagDiagnosisClient);
      const result = await client.diagnose(fixture.input);
      expect(result).toEqual(fixture.expectedResult);
      expect((client as FakeRagDiagnosisClient).calls).toHaveLength(1);
    } finally {
      await moduleRef.close();
    }
  });

  it.each([
    ['模式为 disabled', { mode: 'disabled' }],
    ['缺少密钥', { apiKey: '   ' }],
    ['超时非正数', { timeoutMs: 0 }],
  ])('%s 时返回 CONFIG_ERROR 且零请求', async (_title, overrides) => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const result = await buildClient({ baseUrl, ...overrides }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.CONFIG_ERROR);
      expect(requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  it('明文 HTTP 仅在显式开关下允许', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const blocked = await buildClient({ baseUrl, allowInsecureHttp: false }).diagnose(
        fixtureInput(),
      );
      expect(failureCode(blocked)).toBe(RAG_DIAGNOSIS_ERROR_CODES.CONFIG_ERROR);
      expect(requests).toHaveLength(0);

      const allowed = await buildClient({ baseUrl, allowInsecureHttp: true }).diagnose(
        fixtureInput(),
      );
      expect(allowed.ok).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('拒绝非 http/https 目标且零请求', async () => {
    const result = await buildClient({ baseUrl: 'ftp://127.0.0.1:1' }).diagnose(fixtureInput());
    expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.CONFIG_ERROR);
  });

  it('本地校验失败时零请求', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose({
        ...fixtureInput(),
        question: '   ',
      });
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT);
      expect(requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  it('工单带历史按 V44 协议发送 role/text，字段名与顺序独立校对', async () => {
    const expectedHistory: readonly { role: 'USER' | 'ASSISTANT'; text: string }[] = [
      { role: 'USER', text: '手臂 1 运送掩模板中途停住，报警 E1042。' },
      { role: 'ASSISTANT', text: '请核对取板台真空与手臂位置传感器。' },
    ];
    const expectedEnvelope = {
      schemaVersion: 1,
      requestId: '55555555-5555-4555-8555-555555555555',
      sceneId: 'LITHO_WORKFLOW_V1',
      question: '按上轮建议核对后仍中断，下一步检查什么？',
      history: expectedHistory,
      context: {
        mode: 'WORK_ORDER' as const,
        equipmentModelCode: 'MODEL-INDEPENDENT',
        stage: 4,
        fault: {
          mainError: 'E1042',
          unitError: null,
          source: null,
          errorType: null,
          gpibStatus: '0',
          description: null,
          action: null,
          status: null,
        },
      },
    };

    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, {
        schemaVersion: 1,
        requestId: expectedEnvelope.requestId,
        content: { text: '独立样例正文', visualization: null },
      });
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose({
        requestId: expectedEnvelope.requestId,
        question: expectedEnvelope.question,
        history: expectedHistory,
        context: expectedEnvelope.context,
      });
      expect(result).toEqual({
        ok: true,
        requestId: expectedEnvelope.requestId,
        text: '独立样例正文',
        visualization: null,
      });
      expect(requests).toHaveLength(1);

      const sent = JSON.parse(requests[0].body) as Record<string, unknown>;
      expect(sent).toEqual(expectedEnvelope);
      const sentHistory = sent.history as { role: string; text: string }[];
      expect(sentHistory.map((item) => Object.keys(item))).toEqual([
        ['role', 'text'],
        ['role', 'text'],
      ]);
      expect(requests[0].body).not.toContain('"content"');
    } finally {
      await stopServer(server);
    }
  });

  it.each([
    ['根输入未知字段', { unexpected: true }],
    ['context 未知字段', { context: { ...fixtureInput().context, unexpected: true } }],
    [
      'fault 未知字段',
      {
        context: {
          ...fixtureInput().context,
          fault: { ...(fixtureInput().context.fault ?? {}), unexpected: true },
        },
      },
    ],
  ])('%s 时返回 INVALID_INPUT 且零请求', async (_title, patch) => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose({
        ...fixtureInput(),
        ...patch,
      });
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT);
      expect(requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  it.each([
    ['带尾随空白', `${fixtureInput().requestId} `],
    ['带前导空白', ` ${fixtureInput().requestId}`],
    ['非 UUID', 'not-a-uuid'],
  ])('requestId %s 时返回 INVALID_INPUT 且零请求', async (_title, requestId) => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose({ ...fixtureInput(), requestId });
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT);
      expect(requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  it('合法 UUID 原样发送并回显，成功结果使用同一 ID', async () => {
    const uppercaseId = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, {
        schemaVersion: 1,
        requestId: uppercaseId,
        content: { text: '正文', visualization: null },
      });
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose({
        ...fixtureInput(),
        requestId: uppercaseId,
      });
      expect(result).toEqual({
        ok: true,
        requestId: uppercaseId,
        text: '正文',
        visualization: null,
      });
      expect((JSON.parse(requests[0].body) as { requestId: string }).requestId).toBe(uppercaseId);
    } finally {
      await stopServer(server);
    }
  });

  it('发起前已取消时零请求', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const controller = new AbortController();
      controller.abort();
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput(), {
        signal: controller.signal,
      });
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.CANCELLED);
      expect(requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  it.each(FIXTURE_SCENARIOS)(
    '假服务按样例 %s 完成一次往返，信封、鉴权头与端点符合契约',
    async (scenario) => {
      const fixture = findRagDiagnosisFixture(scenario);
      if (!fixture) {
        throw new Error(`缺少样例：${scenario}`);
      }

      const { server, requests, baseUrl } = await startServer((_req, res) => {
        sendJson(res, 200, {
          schemaVersion: 1,
          requestId: fixture.input.requestId,
          content: {
            text: fixture.expectedResult.text,
            visualization: fixture.expectedResult.visualization,
          },
        });
      });

      try {
        const result = await buildClient({ baseUrl }).diagnose(fixture.input);
        expect(result).toEqual(fixture.expectedResult);
        expect(requests).toHaveLength(1);

        const request = requests[0];
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v1/diagnose');
        expect(request.headers.authorization).toBe('Bearer test-rag-key');
        expect(request.headers['content-type']).toBe('application/json');

        const envelope = JSON.parse(request.body) as unknown;
        expect(envelope).toEqual(fixture.expectedRequestEnvelope);
        if (fixture.expectedRequestEnvelope.context.fault !== null) {
          expect(
            Object.keys(
              (envelope as { context: { fault: Record<string, unknown> } }).context.fault,
            ),
          ).toEqual([...RAG_DIAGNOSIS_FAULT_KEYS]);
        }
      } finally {
        await stopServer(server);
      }
    },
  );

  it('同一 requestId 重试时每次各发一次请求，公共层不做去重或代次占用', async () => {
    const { server, baseUrl, requests } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    try {
      const client = buildClient({ baseUrl });
      const first = await client.diagnose(fixtureInput());
      const second = await client.diagnose(fixtureInput());

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect((JSON.parse(request.body) as { requestId: string }).requestId).toBe(
          fixtureInput().requestId,
        );
      }
    } finally {
      await stopServer(server);
    }
  });

  it('本地截止先于远端响应时返回 TIMEOUT，记录一次请求', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          sendJson(res, 200, successPayload());
        }
      }, 200);
    });

    try {
      const result = await buildClient({ baseUrl, timeoutMs: 20 }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.TIMEOUT);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('调用方取消先于远端响应时返回 CANCELLED，记录一次请求', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          sendJson(res, 200, successPayload());
        }
      }, 200);
    });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        const result = await buildClient({ baseUrl }).diagnose(fixtureInput(), {
          signal: controller.signal,
        });
        expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.CANCELLED);
        expect(requests).toHaveLength(1);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await stopServer(server);
    }
  });

  it('成功后清理计时器并移除外部取消监听', async () => {
    const { server, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });

    const originalSetTimeout = global.setTimeout;
    const scheduled: { delay: number | undefined; handle: NodeJS.Timeout }[] = [];
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(
        (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
          const handle = originalSetTimeout(handler, timeout, ...args);
          scheduled.push({ delay: timeout, handle });
          return handle;
        },
      );
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const removeListenerSpy = jest.spyOn(AbortSignal.prototype, 'removeEventListener');

    try {
      const controller = new AbortController();
      const result = await buildClient({ baseUrl, timeoutMs: 12345 }).diagnose(fixtureInput(), {
        signal: controller.signal,
      });
      expect(result.ok).toBe(true);

      const ownTimer = scheduled.find((item) => item.delay === 12345);
      expect(ownTimer).toBeDefined();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(ownTimer?.handle);
      expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      setTimeoutSpy.mockRestore();
      await stopServer(server);
    }
  });

  it('非 2xx 时取消响应体读取，归类不受收尾影响', async () => {
    const { server, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('{"error":"synthetic"}');
    });

    const cancelSpy = jest.spyOn(ReadableStream.prototype, 'cancel');

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE);
      expect(cancelSpy).toHaveBeenCalled();
    } finally {
      cancelSpy.mockRestore();
      await stopServer(server);
    }
  });

  it('响应体读取中途断连归 SERVICE_UNAVAILABLE，且只发一次请求', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, [
        ['Content-Type', 'application/json'],
        ['Content-Length', '1024'],
      ]);
      res.write('{"schemaVersion":1,');
      setTimeout(() => res.destroy(), 10);
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('截止先于取消发生时返回 TIMEOUT', async () => {
    // 服务端不响应，截止（20ms）与取消（40ms）同时挂起，先发生者胜出。
    const { server, requests, baseUrl } = await startServer(() => undefined);

    try {
      const controller = new AbortController();
      const cancelTimer = setTimeout(() => controller.abort(), 40);
      const result = await buildClient({ baseUrl, timeoutMs: 20 }).diagnose(fixtureInput(), {
        signal: controller.signal,
      });
      clearTimeout(cancelTimer);
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.TIMEOUT);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('取消先于截止发生时返回 CANCELLED', async () => {
    const { server, requests, baseUrl } = await startServer(() => undefined);

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const result = await buildClient({ baseUrl, timeoutMs: 5000 }).diagnose(fixtureInput(), {
        signal: controller.signal,
      });
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.CANCELLED);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('响应字节恰好 1 MiB 时接受，上限不提前拒绝', async () => {
    const requestId = fixtureInput().requestId;
    const makePayload = (padding: number): string =>
      JSON.stringify({
        schemaVersion: 1,
        requestId,
        content: { text: '有效正文', visualization: null },
        padding: 'x'.repeat(padding),
      });

    // padding 为纯 ASCII，先粗算再按实际字节数校正一次即可精确对齐上限。
    let padding = RAG_DIAGNOSIS_RESPONSE_MAX_BYTES;
    let body = makePayload(padding);
    padding += RAG_DIAGNOSIS_RESPONSE_MAX_BYTES - Buffer.byteLength(body, 'utf8');
    body = makePayload(padding);
    expect(Buffer.byteLength(body, 'utf8')).toBe(RAG_DIAGNOSIS_RESPONSE_MAX_BYTES);

    const { server, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end(body);
    });

    try {
      expect(await buildClient({ baseUrl }).diagnose(fixtureInput())).toEqual({
        ok: true,
        requestId,
        text: '有效正文',
        visualization: null,
      });
    } finally {
      await stopServer(server);
    }
  });

  it('重定向不被跟随，归为 SERVICE_UNAVAILABLE', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', '/redirected');
      res.end();
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('/v1/diagnose');
    } finally {
      await stopServer(server);
    }
  });

  it.each([
    [401, RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAUTHORIZED],
    [403, RAG_DIAGNOSIS_ERROR_CODES.SERVICE_FORBIDDEN],
    [413, RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT],
    [422, RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT],
    [429, RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE],
    [503, RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE],
    [504, RAG_DIAGNOSIS_ERROR_CODES.TIMEOUT],
  ])('状态码 %s 归类为 %s', async (status, expectedCode) => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      res.statusCode = status;
      res.end('{"error":"synthetic"}');
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(expectedCode);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('响应声明超过 1 MiB 时在读取前拒绝', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Length', String(RAG_DIAGNOSIS_RESPONSE_MAX_BYTES + 1));
      res.end();
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.INVALID_RESPONSE);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('无 Content-Length 的实际解码字节超过 1 MiB 时拒绝', async () => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.write('{"padding":"');
      res.end(`${'x'.repeat(RAG_DIAGNOSIS_RESPONSE_MAX_BYTES)}"}`);
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.INVALID_RESPONSE);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('网络异常不外泄原始异常，归为 SERVICE_UNAVAILABLE', async () => {
    const { server, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });
    await stopServer(server);

    const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
    expect(result).toEqual({
      ok: false,
      requestId: fixtureInput().requestId,
      code: RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE,
    });
  });

  it('failure 日志不含合成密钥与请求正文标记', async () => {
    const apiKeyMarker = 'synthetic-secret-marker-7f3a';
    const questionMarker = 'synthetic-question-marker-91c2';
    const { server, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('{"error":"synthetic"}');
    });

    const warnMock = Logger.prototype.warn as unknown as jest.Mock;
    warnMock.mockClear();

    try {
      const result = await buildClient({ baseUrl, apiKey: apiKeyMarker }).diagnose({
        ...fixtureInput(),
        question: `${questionMarker} 掩模板运送中断`,
      });
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.SERVICE_UNAVAILABLE);
      expect(warnMock).toHaveBeenCalled();

      const serialized = JSON.stringify(warnMock.mock.calls);
      expect(serialized).not.toContain(apiKeyMarker);
      expect(serialized).not.toContain(questionMarker);
    } finally {
      await stopServer(server);
    }
  });

  it('使用默认传输，不传入可关闭 TLS 校验的 agent 或 dispatcher', async () => {
    const { server, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, successPayload());
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(result.ok).toBe(true);

      const init = fetchSpy.mock.calls[0]?.[1];
      expect(init).toBeDefined();
      expect(init).not.toHaveProperty('agent');
      expect(init).not.toHaveProperty('dispatcher');
    } finally {
      await stopServer(server);
    }
  });

  it.each([
    ['非 JSON 正文', 'not-json'],
    ['错误版本', JSON.stringify({ ...(successPayload() as object), schemaVersion: 2 })],
    [
      '回显 requestId 不一致',
      JSON.stringify({
        ...(successPayload() as object),
        requestId: '44444444-4444-4444-8444-444444444444',
      }),
    ],
    ['空正文', JSON.stringify({ ...(successPayload() as object), content: { text: '   ' } })],
  ])('%s 归为 INVALID_RESPONSE', async (_title, body) => {
    const { server, requests, baseUrl } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixtureInput());
      expect(failureCode(result)).toBe(RAG_DIAGNOSIS_ERROR_CODES.INVALID_RESPONSE);
      expect(requests).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it('非法图形保留正文并降级为 visualization=null', async () => {
    const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
    if (!fixture) {
      throw new Error('缺少工单样例');
    }
    const payload = successPayload() as {
      content: { text: string; visualization: unknown };
    };
    payload.content.visualization = {
      sceneId: 'OTHER_SCENE',
      stage: 3,
      parts: [],
    };

    const { server, baseUrl } = await startServer((_req, res) => {
      sendJson(res, 200, payload);
    });

    try {
      const result = await buildClient({ baseUrl }).diagnose(fixture.input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toBe(fixture.expectedResult.text);
        expect(result.visualization).toBeNull();
      }
    } finally {
      await stopServer(server);
    }
  });
});
