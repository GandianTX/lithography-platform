// src/features/ai-conversation/domain/ai-visualization.spec.ts

import { describe, expect, it } from 'vitest';

import {
  parseAiVisualization,
  pickAiHighlightedParts,
  resolveAiPartDisplays,
} from './ai-visualization';

const PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
];

function buildParts(display: string) {
  return PART_IDS.map((partId) => ({ partId, display }));
}

describe('ai-visualization', () => {
  it('解析合法图形：11 个部件、stage 1–10', () => {
    const result = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 2,
      parts: buildParts('NORMAL'),
    });
    expect(result.degraded).toBe(false);
    expect(result.visualization?.parts).toHaveLength(11);
    expect(result.visualization?.stage).toBe(2);
  });

  it('解析合法图形：stage 为 null（证据不足）同样接受', () => {
    const result = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: null,
      parts: buildParts('NORMAL'),
    });
    expect(result.degraded).toBe(false);
    expect(result.visualization?.stage).toBeNull();
  });

  it('null 图形不是降级，只表示本轮无图', () => {
    const result = parseAiVisualization(null);
    expect(result.degraded).toBe(false);
    expect(result.visualization).toBeNull();
  });

  it('部件缺失 → 降级为流程参考图', () => {
    const result = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 2,
      parts: buildParts('NORMAL').slice(0, 10),
    });
    expect(result.degraded).toBe(true);
    expect(result.visualization).toBeNull();
  });

  it('部件重复 → 降级', () => {
    const parts = buildParts('NORMAL');
    parts[1] = { partId: parts[0].partId, display: 'NORMAL' };
    const result = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 2,
      parts,
    });
    expect(result.degraded).toBe(true);
  });

  it('未知 partId / 未知展示态 → 降级', () => {
    const unknownPart = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 2,
      parts: [...buildParts('NORMAL').slice(0, 10), { partId: 'unknown', display: 'NORMAL' }],
    });
    expect(unknownPart.degraded).toBe(true);

    const unknownDisplay = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 2,
      parts: [...buildParts('NORMAL').slice(0, 10), { partId: 'wafer_stage', display: 'BROKEN' }],
    });
    expect(unknownDisplay.degraded).toBe(true);
  });

  it('结构非法（非对象）→ 降级', () => {
    expect(parseAiVisualization('nope').degraded).toBe(true);
  });

  it('有有效图形时以图形为准（含 HIDDEN 与 WARNING）', () => {
    const parts = buildParts('NORMAL');
    parts[8] = { partId: 'alignment_table', display: 'WARNING' };
    parts[9] = { partId: 'wafer_stage', display: 'HIDDEN' };
    const { visualization } = parseAiVisualization({
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 6,
      parts,
    });
    const displays = resolveAiPartDisplays({
      visualization,
      fallbackStage: 6,
    });
    expect(displays.alignment_table).toBe('WARNING');
    expect(displays.wafer_stage).toBe('HIDDEN');
    expect(displays.wafer_arm).toBe('NORMAL');
  });

  it('无有效图形时回到阶段参考图（清除旧定位）', () => {
    const displays = resolveAiPartDisplays({ visualization: null, fallbackStage: 6 });
    expect(displays.wafer_arm).toBe('HIGHLIGHT');
    expect(displays.alignment_table).toBe('HIGHLIGHT');
    expect(displays.reticle_arm).toBe('NORMAL');
  });

  it('图例只提示 HIGHLIGHT / WARNING', () => {
    const displays = resolveAiPartDisplays({ visualization: null, fallbackStage: 2 });
    const parts = pickAiHighlightedParts(displays);
    expect(parts.map((part) => part.partId)).toEqual(['reticle_arm', 'reticle_table']);
    expect(parts.every((part) => part.display === 'HIGHLIGHT')).toBe(true);
  });
});
