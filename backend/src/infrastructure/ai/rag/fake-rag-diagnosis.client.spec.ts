// src/infrastructure/ai/rag/fake-rag-diagnosis.client.spec.ts
// S1 定向验证：三组合成样例的契约口径 + 替身行为 + 03／05 两个最小消费者装配。

import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  RAG_DIAGNOSIS_CLIENT,
  RAG_DIAGNOSIS_ERROR_CODES,
  RAG_DIAGNOSIS_FAULT_KEYS,
  RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS,
  RAG_DIAGNOSIS_HISTORY_LIMIT,
  RAG_DIAGNOSIS_QUESTION_MAX_UNITS,
  RAG_DIAGNOSIS_SCENE_ID,
  RAG_DIAGNOSIS_SCHEMA_VERSION,
  RAG_DIAGNOSIS_STAGE_MAX,
  RAG_DIAGNOSIS_STAGE_MIN,
  RAG_DIAGNOSIS_TEXT_MAX_UNITS,
  RAG_VISUALIZATION_DISPLAYS,
  RAG_VISUALIZATION_PART_IDS,
  RAG_VISUALIZATION_REQUIRED_PART_COUNT,
  type RagDiagnosisClient,
  type RagDiagnosisInput,
  type RagDiagnosisSuccess,
  type RagDiagnosisVisualization,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
import { FakeRagDiagnosisClient } from './fake-rag-diagnosis.client';
import {
  RAG_DIAGNOSIS_FIXTURES,
  findRagDiagnosisFixture,
  type RagDiagnosisFixture,
} from './rag-diagnosis.fixture';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireFixture = (scenario: RagDiagnosisFixture['scenario']): RagDiagnosisFixture => {
  const fixture = findRagDiagnosisFixture(scenario);
  if (!fixture) {
    throw new Error(`缺少样例：${scenario}`);
  }
  return fixture;
};

/** 最小消费者：模拟 03 首析只取正文 */
@Injectable()
class MinimalFirstAnalysisConsumer {
  constructor(@Inject(RAG_DIAGNOSIS_CLIENT) private readonly client: RagDiagnosisClient) {}

  async analyze(input: RagDiagnosisInput): Promise<RagDiagnosisSuccess> {
    const result = await this.client.diagnose(input);
    if (!result.ok) {
      throw new Error(`first_analysis_failed:${result.code}`);
    }
    return result;
  }
}

/** 最小消费者：模拟 05 对话只取图形 */
@Injectable()
class MinimalConversationConsumer {
  constructor(@Inject(RAG_DIAGNOSIS_CLIENT) private readonly client: RagDiagnosisClient) {}

  async requestVisualization(input: RagDiagnosisInput): Promise<RagDiagnosisVisualization | null> {
    const result = await this.client.diagnose(input);
    return result.ok ? result.visualization : null;
  }
}

describe('RAG 诊断合成样例', () => {
  it('三组样例分别覆盖首析空历史、独立对话、工单对话带历史', () => {
    expect(RAG_DIAGNOSIS_FIXTURES).toHaveLength(3);
    expect(RAG_DIAGNOSIS_FIXTURES.map((fixture) => fixture.scenario)).toEqual([
      'FIRST_ANALYSIS_EMPTY_HISTORY',
      'INDEPENDENT_CHAT',
      'WORK_ORDER_WITH_HISTORY',
    ]);

    expect(requireFixture('FIRST_ANALYSIS_EMPTY_HISTORY').input.history).toHaveLength(0);
    expect(requireFixture('INDEPENDENT_CHAT').input.history).toHaveLength(0);
    expect(requireFixture('WORK_ORDER_WITH_HISTORY').input.history.length).toBeGreaterThan(0);
  });

  it('requestId 唯一且为标准 UUID', () => {
    const requestIds = RAG_DIAGNOSIS_FIXTURES.map((fixture) => fixture.input.requestId);
    expect(new Set(requestIds).size).toBe(requestIds.length);
    for (const requestId of requestIds) {
      expect(requestId).toMatch(UUID_V4_PATTERN);
    }
  });

  it('question 已去首尾空白且长度在 1–2000 UTF-16 码元', () => {
    for (const fixture of RAG_DIAGNOSIS_FIXTURES) {
      const { question } = fixture.input;
      expect(question).toBe(question.trim());
      expect(question.length).toBeGreaterThanOrEqual(1);
      expect(question.length).toBeLessThanOrEqual(RAG_DIAGNOSIS_QUESTION_MAX_UNITS);
    }
  });

  it('history 满足角色、条数与单条长度限制', () => {
    for (const fixture of RAG_DIAGNOSIS_FIXTURES) {
      expect(fixture.input.history.length).toBeLessThanOrEqual(RAG_DIAGNOSIS_HISTORY_LIMIT);
      for (const item of fixture.input.history) {
        expect(['USER', 'ASSISTANT']).toContain(item.role);
        expect(item.text).toBe(item.text.trim());
        expect(item.text.length).toBeGreaterThanOrEqual(1);
        expect(item.text.length).toBeLessThanOrEqual(RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS);
      }
    }
  });

  it('context 模式与阶段合法，可信机型编码只出现在工单样例', () => {
    for (const fixture of RAG_DIAGNOSIS_FIXTURES) {
      const { context } = fixture.input;
      expect(['INDEPENDENT', 'WORK_ORDER']).toContain(context.mode);
      if (context.stage !== null) {
        expect(Number.isInteger(context.stage)).toBe(true);
        expect(context.stage).toBeGreaterThanOrEqual(RAG_DIAGNOSIS_STAGE_MIN);
        expect(context.stage).toBeLessThanOrEqual(RAG_DIAGNOSIS_STAGE_MAX);
      }
    }

    expect(
      requireFixture('FIRST_ANALYSIS_EMPTY_HISTORY').input.context.equipmentModelCode,
    ).toBeNull();
    expect(requireFixture('INDEPENDENT_CHAT').input.context.equipmentModelCode).toBeNull();
    expect(
      requireFixture('WORK_ORDER_WITH_HISTORY').input.context.equipmentModelCode,
    ).not.toBeNull();
  });

  it('工单样例的 fault 给齐八字段并保留字符串 "0"', () => {
    const fixture = requireFixture('WORK_ORDER_WITH_HISTORY');
    const wireFault = fixture.expectedRequestEnvelope.context.fault;
    expect(wireFault).not.toBeNull();
    if (!wireFault) {
      throw new Error('工单样例缺少 fault');
    }
    expect(Object.keys(wireFault)).toEqual([...RAG_DIAGNOSIS_FAULT_KEYS]);
    expect(wireFault.gpibStatus).toBe('0');
    expect(wireFault.mainError).toBe('E1042');
  });

  it('期望线上信封等于入参并补齐固定版本与场景', () => {
    for (const fixture of RAG_DIAGNOSIS_FIXTURES) {
      const envelope = fixture.expectedRequestEnvelope;
      expect(envelope.schemaVersion).toBe(RAG_DIAGNOSIS_SCHEMA_VERSION);
      expect(envelope.sceneId).toBe(RAG_DIAGNOSIS_SCENE_ID);
      expect(envelope.requestId).toBe(fixture.input.requestId);
      expect(envelope.question).toBe(fixture.input.question);
      expect(envelope.history).toEqual(fixture.input.history);
      expect(envelope.context.mode).toBe(fixture.input.context.mode);
      expect(envelope.context.equipmentModelCode).toBe(fixture.input.context.equipmentModelCode);
      expect(envelope.context.stage).toBe(fixture.input.context.stage);
    }
  });

  it('成功结果的正文与图形满足契约限制', () => {
    for (const fixture of RAG_DIAGNOSIS_FIXTURES) {
      const success = fixture.expectedResult;
      expect(success.ok).toBe(true);
      expect(success.requestId).toBe(fixture.input.requestId);
      expect(success.text).toBe(success.text.trim());
      expect(success.text.length).toBeGreaterThanOrEqual(1);
      expect(success.text.length).toBeLessThanOrEqual(RAG_DIAGNOSIS_TEXT_MAX_UNITS);

      const visualization = success.visualization;
      if (!visualization) {
        throw new Error(`样例缺少图形：${fixture.scenario}`);
      }
      expect(visualization.sceneId).toBe(RAG_DIAGNOSIS_SCENE_ID);
      expect(visualization.stage).toBe(fixture.input.context.stage);
      expect(visualization.parts).toHaveLength(RAG_VISUALIZATION_REQUIRED_PART_COUNT);

      const partIds = visualization.parts.map((part) => part.partId);
      expect(new Set(partIds).size).toBe(RAG_VISUALIZATION_REQUIRED_PART_COUNT);
      expect([...partIds].sort()).toEqual([...RAG_VISUALIZATION_PART_IDS].sort());

      const displays: readonly string[] = RAG_VISUALIZATION_DISPLAYS;
      for (const part of visualization.parts) {
        expect(displays).toContain(part.display);
      }
    }
  });
});

describe('FakeRagDiagnosisClient', () => {
  it('按 requestId 返回固定样例结果并记录入参', async () => {
    const fake = new FakeRagDiagnosisClient();
    const fixture = requireFixture('WORK_ORDER_WITH_HISTORY');

    const result = await fake.diagnose(fixture.input);

    expect(result).toEqual(fixture.expectedResult);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.input).toBe(fixture.input);
    expect(fake.calls[0]?.signalAborted).toBe(false);
  });

  it('发起前已取消时返回 CANCELLED', async () => {
    const fake = new FakeRagDiagnosisClient();
    const fixture = requireFixture('FIRST_ANALYSIS_EMPTY_HISTORY');
    const controller = new AbortController();
    controller.abort();

    const result = await fake.diagnose(fixture.input, { signal: controller.signal });

    expect(result).toEqual({
      ok: false,
      requestId: fixture.input.requestId,
      code: RAG_DIAGNOSIS_ERROR_CODES.CANCELLED,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.signalAborted).toBe(true);
  });

  it('未登记的 requestId 明确失败', async () => {
    const fake = new FakeRagDiagnosisClient();
    const fixture = requireFixture('INDEPENDENT_CHAT');

    await expect(
      fake.diagnose({ ...fixture.input, requestId: '44444444-4444-4444-8444-444444444444' }),
    ).rejects.toThrow(/未登记 requestId/);
  });

  it('注入令牌为 Symbol 且两个最小消费者可共用同一替身装配', async () => {
    expect(typeof RAG_DIAGNOSIS_CLIENT).toBe('symbol');

    const moduleRef = await Test.createTestingModule({
      providers: [
        FakeRagDiagnosisClient,
        { provide: RAG_DIAGNOSIS_CLIENT, useExisting: FakeRagDiagnosisClient },
        MinimalFirstAnalysisConsumer,
        MinimalConversationConsumer,
      ],
    }).compile();

    try {
      const fake = moduleRef.get(FakeRagDiagnosisClient);
      const firstAnalysis = moduleRef.get(MinimalFirstAnalysisConsumer);
      const conversation = moduleRef.get(MinimalConversationConsumer);
      const firstAnalysisFixture = requireFixture('FIRST_ANALYSIS_EMPTY_HISTORY');
      const independentFixture = requireFixture('INDEPENDENT_CHAT');
      const workOrderFixture = requireFixture('WORK_ORDER_WITH_HISTORY');

      const analyzed = await firstAnalysis.analyze(firstAnalysisFixture.input);
      expect(analyzed.text).toBe(firstAnalysisFixture.expectedResult.text);

      // 05 两种对话：独立对话（空历史）与工单对话（带历史）共用同一替身
      const independentVisualization = await conversation.requestVisualization(
        independentFixture.input,
      );
      expect(independentVisualization).toEqual(independentFixture.expectedResult.visualization);

      const visualization = await conversation.requestVisualization(workOrderFixture.input);
      expect(visualization).toEqual(workOrderFixture.expectedResult.visualization);
      expect(fake.calls).toHaveLength(3);
    } finally {
      await moduleRef.close();
    }
  });
});
