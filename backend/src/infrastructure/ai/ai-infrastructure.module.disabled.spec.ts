// src/infrastructure/ai/ai-infrastructure.module.disabled.spec.ts

/**
 * RAG disabled 模式的离线装配烟测（PR #20 合并后验收）：
 * - 测试进程显式设置 LITHO_RAG_MODE=disabled；
 * - 用 global ConfigService 替身提供 disabled 的 ragDiagnosis 配置，
 *   编译真实 AiInfrastructureModule 与 AiCapabilityModule；
 * - 不注册、不初始化 TypeORM / Redis / BullMQ，也不连接任何真实服务；
 * - 调用 RAG_DIAGNOSIS_CLIENT 时在配置解析阶段失败为 CONFIG_ERROR，
 *   fetch 零调用，证明禁用模式不会向真实 RAG 发请求。
 *
 * 这里验证的是“禁用模式仍能装配且不发请求”，不代表默认生产启动；
 * 真实 AppConfigModule 的生产预检由 config.module.rag.spec.ts 覆盖。
 */

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import {
  RAG_DIAGNOSIS_CLIENT,
  RAG_DIAGNOSIS_ERROR_CODES,
  type RagDiagnosisClient,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
// eslint-disable-next-line local-architecture/no-infrastructure-to-modules-imports -- 仅离线装配烟测需要编译能力锚点模块，不引入任何业务实现
import { AiCapabilityModule } from '@src/modules/common/ai-capability/ai-capability.module';
import { AiInfrastructureModule } from './ai-infrastructure.module';
import { findRagDiagnosisFixture } from './rag/rag-diagnosis.fixture';

const DISABLED_RAG_CONFIG = {
  mode: 'disabled',
  baseUrl: '',
  apiKey: '',
  allowInsecureHttp: false,
  timeoutMs: 30000,
} as const;

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: {
        get: (key: string, defaultValue?: unknown) => {
          if (key === 'ragDiagnosis') return DISABLED_RAG_CONFIG;
          if (key.startsWith('ragDiagnosis.')) {
            const field = key.slice('ragDiagnosis.'.length) as keyof typeof DISABLED_RAG_CONFIG;
            return DISABLED_RAG_CONFIG[field] ?? defaultValue;
          }
          return defaultValue;
        },
      },
    },
  ],
  exports: [ConfigService],
})
class DisabledRagConfigStubModule {}

describe('RAG disabled：AI 基础设施模块离线装配', () => {
  const originalMode = process.env.LITHO_RAG_MODE;
  let closeModule: (() => Promise<void>) | null = null;

  beforeAll(() => {
    process.env.LITHO_RAG_MODE = 'disabled';
  });

  afterAll(async () => {
    if (closeModule) {
      await closeModule();
    }
    if (originalMode === undefined) {
      delete process.env.LITHO_RAG_MODE;
    } else {
      process.env.LITHO_RAG_MODE = originalMode;
    }
  });

  it('禁用模式下模块可编译，RAG 客户端可解析且不发起 fetch', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DisabledRagConfigStubModule, AiInfrastructureModule, AiCapabilityModule],
    }).compile();
    closeModule = () => moduleRef.close();

    const client = moduleRef.get<RagDiagnosisClient>(RAG_DIAGNOSIS_CLIENT);
    expect(client).toBeDefined();

    // 任何真实网络访问都会命中该替身并让用例失败
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('disabled 模式不得发起 fetch');
    });

    try {
      const fixture = findRagDiagnosisFixture('FIRST_ANALYSIS_EMPTY_HISTORY');
      expect(fixture).not.toBeNull();

      const result = await client.diagnose(fixture!.input);

      expect(result).toMatchObject({
        ok: false,
        code: RAG_DIAGNOSIS_ERROR_CODES.CONFIG_ERROR,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
