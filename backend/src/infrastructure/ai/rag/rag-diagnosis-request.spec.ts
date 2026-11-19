// src/infrastructure/ai/rag/rag-diagnosis-request.spec.ts
// S2.2 定向验证：白名单构造、长度边界与 UTF-8 JSON 字节上限。

import {
  RAG_DIAGNOSIS_ERROR_CODES,
  RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS,
  RAG_DIAGNOSIS_FAULT_KEYS,
  RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS,
  RAG_DIAGNOSIS_HISTORY_LIMIT,
  RAG_DIAGNOSIS_QUESTION_MAX_UNITS,
  RAG_DIAGNOSIS_REQUEST_MAX_BYTES,
  RAG_DIAGNOSIS_SCENE_ID,
  RAG_DIAGNOSIS_SCHEMA_VERSION,
  type RagDiagnosisInput,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
import { findRagDiagnosisFixture } from './rag-diagnosis.fixture';
import { buildRagDiagnosisRequest } from './rag-diagnosis-request';

const baseInput = (): RagDiagnosisInput => {
  const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
  if (!fixture) {
    throw new Error('缺少工单样例');
  }
  return fixture.input;
};

const asInput = (value: unknown): RagDiagnosisInput => value as RagDiagnosisInput;

describe('buildRagDiagnosisRequest', () => {
  it('按白名单补齐版本与场景，并保持 fault 八字段键序', () => {
    const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
    if (!fixture) {
      throw new Error('缺少工单样例');
    }

    const built = buildRagDiagnosisRequest(fixture.input);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      throw new Error('工单样例应通过校验');
    }

    expect(built.envelope.schemaVersion).toBe(RAG_DIAGNOSIS_SCHEMA_VERSION);
    expect(built.envelope.sceneId).toBe(RAG_DIAGNOSIS_SCENE_ID);
    expect(built.envelope).toEqual(fixture.expectedRequestEnvelope);
    expect(Object.keys(built.envelope.context.fault ?? {})).toEqual([...RAG_DIAGNOSIS_FAULT_KEYS]);
    expect(built.envelope.context.fault?.gpibStatus).toBe('0');
    expect(built.byteLength).toBe(Buffer.byteLength(built.body, 'utf8'));
  });

  it('接受首析与独立对话的空历史', () => {
    for (const scenario of ['FIRST_ANALYSIS_EMPTY_HISTORY', 'INDEPENDENT_CHAT'] as const) {
      const fixture = findRagDiagnosisFixture(scenario);
      if (!fixture) {
        throw new Error(`缺少样例：${scenario}`);
      }
      const built = buildRagDiagnosisRequest(fixture.input);
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(built.envelope.history).toEqual([]);
      }
    }
  });

  it('去除问题、历史与故障字段外侧空白', () => {
    const input = asInput({
      ...baseInput(),
      question: '  手臂仍在中途停住  ',
      history: [{ role: 'USER', text: '  已核对取板台真空  ' }],
      context: {
        ...baseInput().context,
        equipmentModelCode: '  SYNTH-FIXTURE-MODEL  ',
        fault: {
          mainError: '  E1042  ',
          gpibStatus: '0',
        },
      },
    });

    const built = buildRagDiagnosisRequest(input);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }

    expect(built.envelope.question).toBe('手臂仍在中途停住');
    expect(built.envelope.history).toEqual([{ role: 'USER', text: '已核对取板台真空' }]);
    expect(built.envelope.context.equipmentModelCode).toBe('SYNTH-FIXTURE-MODEL');
    expect(Object.keys(built.envelope.context.fault ?? {})).toEqual([...RAG_DIAGNOSIS_FAULT_KEYS]);
    expect(built.envelope.context.fault?.mainError).toBe('E1042');
    expect(built.envelope.context.fault?.gpibStatus).toBe('0');
  });

  it('请求历史按 V44 协议使用 role 与 text，不输出 content', () => {
    const built = buildRagDiagnosisRequest(baseInput());
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }

    expect(built.envelope.history).toHaveLength(2);
    expect(built.envelope.history[0]).toEqual({
      role: 'USER',
      text: '掩模板运送至取板台时，手臂 1 动作中断，已记录报警原文 E1042。',
    });
    expect(built.envelope.history[1]).toEqual({
      role: 'ASSISTANT',
      text: '请先核对取板台真空与手臂位置传感器，再按规程复现一次运送动作。',
    });
    for (const item of built.envelope.history) {
      expect(Object.keys(item)).toEqual(['role', 'text']);
    }
    expect(built.body).not.toContain('"content"');
  });

  it('按 UTF-8 字节而非字符数计入 256 KiB 上限', () => {
    const built = buildRagDiagnosisRequest(
      asInput({
        ...baseInput(),
        context: { ...baseInput().context, equipmentModelCode: '中'.repeat(1000) },
      }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.byteLength).toBeGreaterThanOrEqual(3000);
    }
  });

  it('问题与历史单条允许精确上限，超出 1 个码元即拒绝', () => {
    const atLimit = buildRagDiagnosisRequest(
      asInput({
        ...baseInput(),
        question: 'a'.repeat(RAG_DIAGNOSIS_QUESTION_MAX_UNITS),
        history: [{ role: 'USER', text: 'b'.repeat(RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS) }],
      }),
    );
    expect(atLimit.ok).toBe(true);

    expect(
      buildRagDiagnosisRequest(
        asInput({ ...baseInput(), question: 'a'.repeat(RAG_DIAGNOSIS_QUESTION_MAX_UNITS + 1) }),
      ),
    ).toEqual({ ok: false, code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT });

    expect(
      buildRagDiagnosisRequest(
        asInput({
          ...baseInput(),
          history: [{ role: 'USER', text: 'b'.repeat(RAG_DIAGNOSIS_HISTORY_ITEM_MAX_UNITS + 1) }],
        }),
      ),
    ).toEqual({ ok: false, code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT });
  });

  it('请求正文恰好 256 KiB 时接受，超出 1 字节即拒绝', () => {
    const seed = buildRagDiagnosisRequest(
      asInput({
        ...baseInput(),
        context: { ...baseInput().context, equipmentModelCode: 'M' },
      }),
    );
    expect(seed.ok).toBe(true);
    if (!seed.ok) {
      return;
    }

    // 机型编码为纯 ASCII，每多 1 个字符正文正好多 1 字节，可精确对齐上限。
    const padding = RAG_DIAGNOSIS_REQUEST_MAX_BYTES - seed.byteLength;
    const exact = buildRagDiagnosisRequest(
      asInput({
        ...baseInput(),
        context: { ...baseInput().context, equipmentModelCode: `M${'m'.repeat(padding)}` },
      }),
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.byteLength).toBe(RAG_DIAGNOSIS_REQUEST_MAX_BYTES);
    }

    expect(
      buildRagDiagnosisRequest(
        asInput({
          ...baseInput(),
          context: { ...baseInput().context, equipmentModelCode: `M${'m'.repeat(padding + 1)}` },
        }),
      ),
    ).toEqual({ ok: false, code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT });
  });

  it.each([
    ['非 UUID 的 requestId', { requestId: 'not-a-uuid' }],
    ['空白问题', { question: '   ' }],
    [
      '历史条数超过上限',
      {
        history: Array.from({ length: RAG_DIAGNOSIS_HISTORY_LIMIT + 1 }, () => ({
          role: 'USER',
          text: 'x',
        })),
      },
    ],
    ['非法历史角色', { history: [{ role: 'SYSTEM', text: 'x' }] }],
    ['非法上下文模式', { context: { ...baseInput().context, mode: 'UNKNOWN' } }],
    ['阶段小于 1', { context: { ...baseInput().context, stage: 0 } }],
    ['阶段大于 10', { context: { ...baseInput().context, stage: 11 } }],
    ['阶段非整数', { context: { ...baseInput().context, stage: 1.5 } }],
    ['阶段为字符串', { context: { ...baseInput().context, stage: '2' } }],
    ['故障字段非字符串', { context: { ...baseInput().context, fault: { mainError: 1042 } } }],
    [
      '故障字段超过 4000 码元',
      {
        context: {
          ...baseInput().context,
          fault: { mainError: 'e'.repeat(RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS + 1) },
        },
      },
    ],
  ])('拒绝%s', (_title, patch) => {
    const built = buildRagDiagnosisRequest(asInput({ ...baseInput(), ...patch }));
    expect(built).toEqual({ ok: false, code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT });
  });

  it.each([
    ['根输入含未知字段', { unexpected: true }],
    ['context 含未知字段', { context: { ...baseInput().context, unexpected: true } }],
    ['history 项含未知字段', { history: [{ role: 'USER', text: '已核对', content: '已核对' }] }],
    [
      'fault 含未知字段',
      { context: { ...baseInput().context, fault: { mainError: 'E1042', unknownField: 'x' } } },
    ],
  ])('%s 时按 INVALID_INPUT 拒绝，不构造请求', (_title, patch) => {
    const built = buildRagDiagnosisRequest(asInput({ ...baseInput(), ...patch }));
    expect(built).toEqual({ ok: false, code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT });
  });

  it.each([
    ['带前导空白', ` ${baseInput().requestId}`],
    ['带尾随空白', `${baseInput().requestId} `],
    ['前后均有空白', `\t${baseInput().requestId}\n`],
  ])('requestId %s 时按 INVALID_INPUT 拒绝，不做 trim 归一化', (_title, requestId) => {
    expect(buildRagDiagnosisRequest(asInput({ ...baseInput(), requestId }))).toEqual({
      ok: false,
      code: RAG_DIAGNOSIS_ERROR_CODES.INVALID_INPUT,
    });
  });

  it('合法缺省与 null 不被未知字段校验误拒，fault 缺省字段补 null', () => {
    const nullContext = buildRagDiagnosisRequest(
      asInput({
        ...baseInput(),
        history: [],
        context: { mode: 'INDEPENDENT', equipmentModelCode: null, stage: null, fault: null },
      }),
    );
    expect(nullContext.ok).toBe(true);
    if (nullContext.ok) {
      expect(nullContext.envelope.context).toEqual({
        mode: 'INDEPENDENT',
        equipmentModelCode: null,
        stage: null,
        fault: null,
      });
    }

    const sparseFault = buildRagDiagnosisRequest(
      asInput({
        ...baseInput(),
        context: {
          mode: 'WORK_ORDER',
          equipmentModelCode: null,
          stage: 4,
          fault: { mainError: 'E1042' },
        },
      }),
    );
    expect(sparseFault.ok).toBe(true);
    if (sparseFault.ok) {
      expect(sparseFault.envelope.context.fault).toEqual({
        mainError: 'E1042',
        unitError: null,
        source: null,
        errorType: null,
        gpibStatus: null,
        description: null,
        action: null,
        status: null,
      });
    }
  });
});
