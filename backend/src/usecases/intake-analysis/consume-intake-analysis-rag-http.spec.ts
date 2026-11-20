// src/usecases/intake-analysis/consume-intake-analysis-rag-http.spec.ts
// 受控 HTTP 模拟（仅监听 127.0.0.1）× 真实公共 RAG HTTP 客户端：
// 验证首析编排对请求构造、响应解析、超时、错误密钥、错误请求 ID、空正文与
// 非法 JSON 的端到端行为。模拟结果只用于测试，不代表真实模型。
//
// 注入真实 RagDiagnosisHttpClient + 替身业务服务，驱动 ConsumeIntakeAnalysisJobUsecase。

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { IntakeAnalysisService } from '@src/modules/lithography/intake-analysis.service';
import type { AiProviderCallRecordService } from '@src/modules/ai-provider-call-record/ai-provider-call-record.service';
import type { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import { RagDiagnosisHttpClient } from '@src/infrastructure/ai/rag/rag-diagnosis-http.client';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { ConsumeIntakeAnalysisJobUsecase } from './consume-intake-analysis-job.usecase';
import type { ConsumeIntakeAnalysisJobProcessInput } from './intake-analysis-worker.types';

const transactionContext = Symbol('tx') as unknown as PersistenceTransactionContext;

type RecordedRequest = {
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
};

type TestServer = {
  readonly server: Server;
  readonly requests: RecordedRequest[];
  readonly baseUrl: string;
};

const startServer = async (
  handler: (req: IncomingMessage, res: ServerResponse, requests: RecordedRequest[]) => void,
): Promise<TestServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
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

const createConfigService = (values: ReadonlyMap<string, unknown>): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) =>
      values.has(key) ? values.get(key) : defaultValue,
  }) as unknown as ConfigService;

const buildClient = (input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}) =>
  new RagDiagnosisHttpClient(
    createConfigService(
      new Map<string, unknown>([
        ['ragDiagnosis.mode', 'remote'],
        ['ragDiagnosis.baseUrl', input.baseUrl],
        ['ragDiagnosis.apiKey', input.apiKey ?? 'correct-rag-key'],
        ['ragDiagnosis.timeoutMs', input.timeoutMs ?? 30000],
        ['ragDiagnosis.allowInsecureHttp', true],
      ]),
    ),
  );

const buildProcessInput = (): ConsumeIntakeAnalysisJobProcessInput => ({
  queueName: 'intake-analysis',
  jobName: 'analyze',
  jobId: 'intake-analysis:21:g0',
  traceId: 'trace-http-1',
  intakeId: 21,
  generationNo: 0,
  attemptsMade: 0,
  maxAttempts: 3,
  startedAt: new Date('2026-11-20T10:00:00.000Z'),
});

const failureReasonOf = (usecase: ConsumeIntakeAnalysisJobUsecase): string | null => {
  const finish = (
    usecase as unknown as {
      intakeAnalysisService: { finishIntakeAnalysis: jest.Mock };
    }
  ).intakeAnalysisService.finishIntakeAnalysis;
  const call = finish.mock.calls.at(-1);
  if (!call) return null;
  const outcome = (call[0] as { input: { outcome: { kind: string; failureReason?: string } } })
    .input.outcome;
  return outcome.kind === 'FAILED' ? (outcome.failureReason ?? null) : null;
};

describe('首析编排 × 真实 RAG HTTP 客户端（本机模拟服务）', () => {
  let intakeAnalysisService: {
    claimForAnalysis: jest.Mock;
    finishIntakeAnalysis: jest.Mock;
    getIntakeForAnalysis: jest.Mock;
  };
  let asyncTaskRecordService: { recordStarted: jest.Mock; recordFinished: jest.Mock };
  let providerCallService: { createRecord: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    intakeAnalysisService = {
      claimForAnalysis: jest.fn().mockResolvedValue({
        kind: 'CLAIMED',
        intakeId: 21,
        generationNo: 0,
        attemptId: 501,
        startedAt: new Date(),
      }),
      finishIntakeAnalysis: jest
        .fn()
        .mockResolvedValue({ kind: 'WRITTEN', intakeId: 21, generationNo: 0 }),
      getIntakeForAnalysis: jest.fn().mockResolvedValue({
        intake: {
          id: 21,
          recordUuid: '6f0d1c62-2c66-4b1e-9f1e-2f1f0d1c6a11',
          customerAccountId: 7,
          customerOrganizationId: 77,
          serviceOrganizationId: 88,
          equipmentModelId: 3,
          errorCode: 'E-100',
          faultDescription: 'x'.repeat(5000),
          fileId: 'private-file-id',
          analysisStatus: 'RUNNING',
          analysisGeneration: 0,
          convertedRequestId: 11,
          createdAt: new Date(),
        },
        modelCode: 'LITHO-9000',
      }),
    };
    asyncTaskRecordService = {
      recordStarted: jest.fn().mockResolvedValue({ id: 1 }),
      recordFinished: jest.fn().mockResolvedValue({ id: 1 }),
    };
    providerCallService = { createRecord: jest.fn().mockResolvedValue({ id: 9 }) };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const buildUsecase = (client: RagDiagnosisHttpClient): ConsumeIntakeAnalysisJobUsecase =>
    new ConsumeIntakeAnalysisJobUsecase(
      intakeAnalysisService as unknown as IntakeAnalysisService,
      asyncTaskRecordService as unknown as AsyncTaskRecordService,
      providerCallService as unknown as AiProviderCallRecordService,
      {
        run: async (callback: (tx: PersistenceTransactionContext) => unknown) =>
          await callback(transactionContext),
      } as unknown as TransactionRunner,
      client,
    );

  it('成功响应：真实客户端解析正文并写回 SUCCEEDED，请求携带密钥且不含附件/账号信息', async () => {
    const server = await startServer((req, res, requests) => {
      const payload = JSON.parse(requests[requests.length - 1].body) as { requestId: string };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          requestId: payload.requestId,
          content: { text: '建议先检查主控报警与光源模块状态。', visualization: null },
        }),
      );
    });
    try {
      const usecase = buildUsecase(buildClient({ baseUrl: server.baseUrl }));
      const result = await usecase.process(buildProcessInput());

      expect(result.accepted).toBe(true);
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0];
      expect(request.headers.authorization).toBe('Bearer correct-rag-key');
      const payload = JSON.parse(request.body) as {
        requestId: string;
        question: string;
        context: { fault: { description: string } | null };
      };
      expect(payload.requestId).toEqual(expect.any(String));
      expect(payload.question.startsWith('设备型号：LITHO-9000\n错误码：E-100\n故障现象：')).toBe(
        true,
      );
      // 不发送附件、私有链接与无关账号信息
      expect(request.body).not.toContain('private-file-id');
      expect(request.body).not.toContain('customerAccountId');
      expect(failureReasonOf(usecase)).toBeNull();
      expect(intakeAnalysisService.finishIntakeAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            outcome: expect.objectContaining({ kind: 'SUCCEEDED' }),
          }),
        }),
      );
    } finally {
      await stopServer(server.server);
    }
  });

  it('错误密钥（401）：真实客户端归类 SERVICE_UNAUTHORIZED，写回受控失败', async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: 'unauthorized' }));
    });
    try {
      const usecase = buildUsecase(buildClient({ baseUrl: server.baseUrl, apiKey: 'wrong-key' }));
      const result = await usecase.process(buildProcessInput());

      expect(result.accepted).toBe(true);
      expect(failureReasonOf(usecase)).toBe('RAG_SERVICE_UNAUTHORIZED');
    } finally {
      await stopServer(server.server);
    }
  });

  it('错误请求 ID 回显：归类 INVALID_RESPONSE，不落有效正文', async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          requestId: 'not-the-request-id',
          content: { text: 'should be rejected', visualization: null },
        }),
      );
    });
    try {
      const usecase = buildUsecase(buildClient({ baseUrl: server.baseUrl }));
      await usecase.process(buildProcessInput());

      expect(failureReasonOf(usecase)).toBe('RAG_INVALID_RESPONSE');
      const outcome = (
        intakeAnalysisService.finishIntakeAnalysis.mock.calls[0][0] as {
          input: { outcome: { kind: string } };
        }
      ).input.outcome;
      expect(outcome.kind).toBe('FAILED');
    } finally {
      await stopServer(server.server);
    }
  });

  it('空正文：归类 INVALID_RESPONSE（明确失败，不写回空结果）', async () => {
    const server = await startServer((req, res, requests) => {
      const payload = JSON.parse(requests[requests.length - 1].body) as { requestId: string };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          requestId: payload.requestId,
          content: { text: '', visualization: null },
        }),
      );
    });
    try {
      const usecase = buildUsecase(buildClient({ baseUrl: server.baseUrl }));
      await usecase.process(buildProcessInput());

      expect(failureReasonOf(usecase)).toBe('RAG_INVALID_RESPONSE');
    } finally {
      await stopServer(server.server);
    }
  });

  it('非法 JSON：归类 INVALID_RESPONSE', async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"schemaVersion": 1, broken');
    });
    try {
      const usecase = buildUsecase(buildClient({ baseUrl: server.baseUrl }));
      await usecase.process(buildProcessInput());

      expect(failureReasonOf(usecase)).toBe('RAG_INVALID_RESPONSE');
    } finally {
      await stopServer(server.server);
    }
  });

  it('超时：短截止后归类 TIMEOUT，不无限等待', async () => {
    const server = await startServer((_req, res) => {
      // 不响应，直到客户端截止
      setTimeout(() => {
        try {
          res.statusCode = 200;
          res.end('{}');
        } catch {
          // 客户端已断开
        }
      }, 2000);
    });
    try {
      const usecase = buildUsecase(buildClient({ baseUrl: server.baseUrl, timeoutMs: 200 }));
      await usecase.process(buildProcessInput());

      expect(failureReasonOf(usecase)).toBe('RAG_TIMEOUT');
    } finally {
      await stopServer(server.server);
    }
  });
});
