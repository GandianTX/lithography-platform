// frontend/e2e/helpers/task09-local-runtime-mocks.spec.ts

import { describe, expect, it } from 'vitest';

import {
  classifyTableOverflow,
  TASK09_TABLE_OVERFLOW_POLICY,
  TASK09_VISUAL_PAGES,
  TASK09_VISUAL_VIEWPORTS,
} from './task09-local-runtime-mocks';

/**
 * 候选页面清单与判定口径的**回归保护**。
 *
 * 为什么要有这份单测：
 * - 度量规格与提交级截图规格共用同一份页面清单；清单一旦被某一份单独改动，
 *   两侧就会对"哪些页面被验收"得出不同结论（上一轮就出现过：
 *   度量四页、截图两页）。这里把"四页齐全、三视口齐全、卡片声明齐全"钉住。
 * - 表格溢出判定口径曾出现两侧不一致（截图侧旧口径 ⇒ 窄屏假失败），
 *   这里把"可滚动祖先 ⇒ 不算页面级溢出"钉住。
 */
describe('任务 09 候选页面清单与判定口径', () => {
  it('候选页面恰好四类，且路径互不相同', () => {
    expect(TASK09_VISUAL_PAGES.map((page) => page.label)).toEqual([
      'record-packages',
      'sync-conflicts',
      'local-settings',
      'local-backup',
    ]);
    expect(new Set(TASK09_VISUAL_PAGES.map((page) => page.path)).size).toBe(
      TASK09_VISUAL_PAGES.length,
    );
  });

  it('每一页都显式声明卡片面（缺失即视为口径漂移）', () => {
    for (const page of TASK09_VISUAL_PAGES) {
      expect(['REQUIRED', 'NONE']).toContain(page.card);
      expect(page.cardNote.length).toBeGreaterThan(0);
      expect(page.v44Counterpart.length).toBeGreaterThan(0);
    }
  });

  it('视口恰好三档（1440×900／1366×768／390×844）', () => {
    expect(TASK09_VISUAL_VIEWPORTS.map((viewport) => viewport.label)).toEqual([
      '1440x900',
      '1366x768',
      '390x844',
    ]);
  });

  it('表格溢出判定：允许自身可横向滚动容器内的超宽', () => {
    expect(TASK09_TABLE_OVERFLOW_POLICY.allowScrollableAncestor).toBe(true);
    expect(classifyTableOverflow(640, true)).toBe(0);
  });

  it('表格溢出判定：找不到可滚动祖先即为真实溢出', () => {
    expect(classifyTableOverflow(640, false)).toBe(640);
  });

  it('表格溢出判定：未超宽恒为 0', () => {
    expect(classifyTableOverflow(0, false)).toBe(0);
    expect(classifyTableOverflow(-5, false)).toBe(0);
  });
});
