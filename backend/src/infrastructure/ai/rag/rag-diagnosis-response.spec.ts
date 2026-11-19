// src/infrastructure/ai/rag/rag-diagnosis-response.spec.ts
// 回复解析的协议反例矩阵（S3.1 正文与信封、S3.2 图形白名单与降级）。
//
// 只覆盖纯解析：输入为已按 1 MiB 截断后的字节，不涉及网络与配置。
// 口径：正文按 UTF-16 码元计；图形非法时保留正文并降级为 null。

import {
  RAG_DIAGNOSIS_SCENE_ID,
  RAG_DIAGNOSIS_SCHEMA_VERSION,
  RAG_DIAGNOSIS_TEXT_MAX_UNITS,
  RAG_VISUALIZATION_PART_IDS,
  RAG_VISUALIZATION_REQUIRED_PART_COUNT,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
import { findRagDiagnosisFixture } from './rag-diagnosis.fixture';
import { parseRagDiagnosisResponse } from './rag-diagnosis-response';

const fixture = findRagDiagnosisFixture('WORK_ORDER_WITH_HISTORY');
if (!fixture) {
  throw new Error('缺少工单样例');
}
const REQUEST_ID = fixture.input.requestId;

const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), 'utf8');

const parseBytes = (bytes: Uint8Array) =>
  parseRagDiagnosisResponse({ bytes, requestId: REQUEST_ID });

const parse = (value: unknown) => parseBytes(encode(value));

const parts = (): { partId: string; display: string }[] =>
  RAG_VISUALIZATION_PART_IDS.map((partId) => ({ partId, display: 'NORMAL' }));

const validVisualization = (): Record<string, unknown> => ({
  sceneId: RAG_DIAGNOSIS_SCENE_ID,
  stage: 3,
  parts: parts(),
});

const contentWith = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: '有效正文',
  visualization: validVisualization(),
  ...overrides,
});

const payloadWith = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: RAG_DIAGNOSIS_SCHEMA_VERSION,
  requestId: REQUEST_ID,
  content: contentWith(),
  ...overrides,
});

describe('parseRagDiagnosisResponse S3.1 信封与正文', () => {
  it('合法回复按样例解析成功', () => {
    expect(
      parse({
        schemaVersion: RAG_DIAGNOSIS_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        content: {
          text: fixture.expectedResult.text,
          visualization: fixture.expectedResult.visualization,
        },
      }),
    ).toEqual({
      ok: true,
      text: fixture.expectedResult.text,
      visualization: fixture.expectedResult.visualization,
    });
  });

  it.each([
    ['非 JSON 正文', Buffer.from('not-json', 'utf8')],
    ['非法 UTF-8 字节', Buffer.from([0xff, 0xfe, 0xfd])],
    ['顶层为数组', encode([])],
    ['顶层为字符串', encode('ok')],
    ['顶层为 null', encode(null)],
  ])('%s 时失败', (_label, bytes) => {
    expect(parseBytes(bytes as Uint8Array)).toEqual({ ok: false });
  });

  it.each([
    ['缺少 schemaVersion', payloadWith({ schemaVersion: undefined })],
    ['schemaVersion 为 2', payloadWith({ schemaVersion: 2 })],
    ['schemaVersion 为字符串 "1"', payloadWith({ schemaVersion: '1' })],
    ['requestId 缺失', payloadWith({ requestId: undefined })],
    ['requestId 不匹配', payloadWith({ requestId: '44444444-4444-4444-8444-444444444444' })],
    ['content 缺失', { schemaVersion: 1, requestId: REQUEST_ID }],
    ['content 为 null', payloadWith({ content: null })],
    ['content 为数组', payloadWith({ content: [] })],
    ['content 为字符串', payloadWith({ content: 'text' })],
    ['text 缺失', payloadWith({ content: { visualization: null } })],
    ['text 为数字', payloadWith({ content: { text: 42 } })],
    ['text 为 null', payloadWith({ content: { text: null } })],
    ['正文为空字符串', payloadWith({ content: contentWith({ text: '' }) })],
    ['正文仅空白', payloadWith({ content: contentWith({ text: '  \n\t ' }) })],
  ])('%s 时失败', (_label, payload) => {
    expect(parse(payload)).toEqual({ ok: false });
  });

  it('正文恰好 12000 个 UTF-16 码元时接受', () => {
    const text = '字'.repeat(RAG_DIAGNOSIS_TEXT_MAX_UNITS);
    expect(parse(payloadWith({ content: contentWith({ text }) }))).toEqual({
      ok: true,
      text,
      visualization: validVisualization(),
    });
  });

  it('正文超出 1 个 UTF-16 码元即失败（不截断）', () => {
    const text = '字'.repeat(RAG_DIAGNOSIS_TEXT_MAX_UNITS + 1);
    expect(parse(payloadWith({ content: contentWith({ text }) }))).toEqual({ ok: false });
  });
});

describe('parseRagDiagnosisResponse S3.2 图形白名单与降级', () => {
  it.each([
    ['图形缺失', payloadWith({ content: { text: '有效正文' } })],
    ['图形为 null', payloadWith({ content: contentWith({ visualization: null }) })],
    ['图形为空对象', payloadWith({ content: contentWith({ visualization: {} }) })],
    ['图形为数组', payloadWith({ content: contentWith({ visualization: [] }) })],
    [
      '部件为空数组',
      payloadWith({
        content: contentWith({
          visualization: { sceneId: RAG_DIAGNOSIS_SCENE_ID, stage: 3, parts: [] },
        }),
      }),
    ],
    [
      'sceneId 不匹配',
      payloadWith({
        content: contentWith({ visualization: { ...validVisualization(), sceneId: 'X' } }),
      }),
    ],
    [
      'stage 为 0',
      payloadWith({
        content: contentWith({ visualization: { ...validVisualization(), stage: 0 } }),
      }),
    ],
    [
      'stage 为 11',
      payloadWith({
        content: contentWith({ visualization: { ...validVisualization(), stage: 11 } }),
      }),
    ],
    [
      'stage 为小数',
      payloadWith({
        content: contentWith({ visualization: { ...validVisualization(), stage: 1.5 } }),
      }),
    ],
    [
      'stage 为字符串',
      payloadWith({
        content: contentWith({ visualization: { ...validVisualization(), stage: '3' } }),
      }),
    ],
    [
      'stage 缺失',
      payloadWith({
        content: contentWith({
          visualization: { sceneId: RAG_DIAGNOSIS_SCENE_ID, parts: parts() },
        }),
      }),
    ],
    [
      '部件少 1 个',
      payloadWith({
        content: contentWith({
          visualization: { ...validVisualization(), parts: parts().slice(0, -1) },
        }),
      }),
    ],
    [
      '部件多 1 个',
      payloadWith({
        content: contentWith({
          visualization: {
            ...validVisualization(),
            parts: [...parts(), { partId: 'controller', display: 'NORMAL' }],
          },
        }),
      }),
    ],
    [
      '部件重复导致缺失另一项',
      payloadWith({
        content: contentWith({
          visualization: {
            ...validVisualization(),
            parts: parts().map((part, index) =>
              index === parts().length - 1 ? { partId: 'controller', display: 'NORMAL' } : part,
            ),
          },
        }),
      }),
    ],
    [
      '未知 partId',
      payloadWith({
        content: contentWith({
          visualization: {
            ...validVisualization(),
            parts: parts().map((part, index) =>
              index === 0 ? { partId: 'unknown_part', display: 'NORMAL' } : part,
            ),
          },
        }),
      }),
    ],
    [
      '非法 display',
      payloadWith({
        content: contentWith({
          visualization: {
            ...validVisualization(),
            parts: parts().map((part, index) =>
              index === 0 ? { partId: part.partId, display: 'CRITICAL' } : part,
            ),
          },
        }),
      }),
    ],
    [
      '部件项不是对象',
      payloadWith({
        content: contentWith({
          visualization: {
            ...validVisualization(),
            parts: [...parts().slice(0, -1), 'controller'],
          },
        }),
      }),
    ],
  ])('%s 时保留正文并降级为 null', (_label, payload) => {
    expect(parse(payload)).toEqual({ ok: true, text: '有效正文', visualization: null });
  });

  it('图形合法时 stage 允许为 null', () => {
    expect(
      parse(
        payloadWith({
          content: contentWith({ visualization: { ...validVisualization(), stage: null } }),
        }),
      ),
    ).toEqual({
      ok: true,
      text: '有效正文',
      visualization: { sceneId: RAG_DIAGNOSIS_SCENE_ID, stage: null, parts: parts() },
    });
  });

  it('图形必须给齐 11 个部件，白名单内的 HIDDEN 展示态合法', () => {
    const hiddenParts = parts().map((part, index) =>
      index === 0 ? { partId: part.partId, display: 'HIDDEN' } : part,
    );
    expect(hiddenParts).toHaveLength(RAG_VISUALIZATION_REQUIRED_PART_COUNT);
    expect(
      parse(
        payloadWith({
          content: contentWith({ visualization: { ...validVisualization(), parts: hiddenParts } }),
        }),
      ),
    ).toEqual({
      ok: true,
      text: '有效正文',
      visualization: { sceneId: RAG_DIAGNOSIS_SCENE_ID, stage: 3, parts: hiddenParts },
    });
  });
});
