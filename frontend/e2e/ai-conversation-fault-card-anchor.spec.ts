// e2e/ai-conversation-fault-card-anchor.spec.ts
// 故障短卡锚定回归（任务 05 · 本地验收余项 S1）
//
// 目标断言（全部落在几何事实上，不以截图存在性代证）：
// 1. 故障短卡停靠在**场景右上角**：右边距桌面 20px、≤650px 视口 9px（与 V44 原型 .ai39-card 同口径）；
// 2. 短卡完整落在场景舞台矩形内，不越界、不压住场景边缘；
// 3. 故障连线终点由卡片自身几何推导（offsetLeft / offsetTop+height-12 区间内夹取），
//    必须落在卡片矩形内，即连线确实从卡片发出并指向故障部件，而不是从场景任意角落连出；
// 4. 短卡停留在舞台上半区，避免在窄屏压住聚焦中的故障部件。
//
// 本用例只依赖 mock 夹具，不依赖任何外部原型文件，可在默认 e2e 套件内运行。

import { expect, test } from '@playwright/test';

import { buildParts, createMockState, installGraphQLMock } from './helpers/ai-conversation-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';

/** 原型 .ai39-card 口径：桌面 right 20px / top 10px；≤650px 视口收窄为 right 9px（仍停靠右上） */
const CASES = [
  { name: '窄屏 390×844', width: 390, height: 844, rightInset: 9 },
  { name: '较窄窗口 700×900', width: 700, height: 900, rightInset: 20 },
  { name: '650 断点内侧 649×900', width: 649, height: 900, rightInset: 9 },
  { name: '650 断点外侧 651×900', width: 651, height: 900, rightInset: 20 },
  { name: '桌面 1440×900', width: 1440, height: 900, rightInset: 20 },
];

type Probe = {
  card: { x: number; y: number; w: number; h: number; right: number; bottom: number };
  stage: { x: number; y: number; w: number; h: number; right: number; bottom: number };
  offsetLeft: number;
  offsetTop: number;
  anchorY: number | null;
};

for (const c of CASES) {
  test(`故障短卡锚定 · ${c.name}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: c.width, height: c.height });
    await seedAuthSession(page, 'ENGINEER');
    const state = createMockState();
    state.statusQueue = [
      {
        status: 'SUCCEEDED',
        visualization: {
          sceneId: 'LITHO_WORKFLOW_V1',
          stage: 2,
          parts: buildParts('NORMAL', { reticle_arm: 'WARNING', reticle_table: 'HIGHLIGHT' }),
        },
      },
    ];
    await installGraphQLMock(page, state);
    await page.goto('/engineer/ai');
    await page.waitForTimeout(1200);
    await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
    await page.getByRole('button', { name: '发送问题' }).click();

    const card = page.locator('.ai-fault-card');
    await expect(card).toHaveAttribute('data-locked', 'true', { timeout: 15_000 });
    await page.waitForTimeout(400);

    const probe = await page.evaluate<Probe | null>(() => {
      const el = document.querySelector<HTMLElement>('.ai-fault-card');
      const stage = el?.offsetParent as HTMLElement | null;
      if (el === null || stage === null) {
        return null;
      }
      const r = el.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const canvas = document.querySelector('.ai-scene-canvas canvas');
      const anchorRaw = canvas?.getAttribute('data-fault-anchor-y');
      return {
        card: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
        stage: { x: s.x, y: s.y, w: s.width, h: s.height, right: s.right, bottom: s.bottom },
        offsetLeft: el.offsetLeft,
        offsetTop: el.offsetTop,
        anchorY: anchorRaw === null || anchorRaw === '' ? null : Number(anchorRaw),
      };
    });
    expect(probe).not.toBeNull();
    const p = probe as Probe;

    // 1) 停靠右上角：右边距与顶距按视口断点取原型口径
    expect(p.stage.right - p.card.right).toBeCloseTo(c.rightInset, 0);
    expect(p.card.y - p.stage.y).toBeCloseTo(10, 0);

    // 2) 可视边界：完整落在舞台内
    expect(p.card.x).toBeGreaterThanOrEqual(p.stage.x - 0.5);
    expect(p.card.right).toBeLessThanOrEqual(p.stage.right + 0.5);
    expect(p.card.y).toBeGreaterThanOrEqual(p.stage.y - 0.5);
    expect(p.card.bottom).toBeLessThanOrEqual(p.stage.bottom + 0.5);

    // 3) 连线终点（画布暴露的 data-fault-anchor-y）必须落在卡片矩形内，
    //    且位于卡片朝向故障部件的一侧（短卡在场景上部时自左下出线）。
    expect(p.anchorY).not.toBeNull();
    const anchorY = p.anchorY as number;
    expect(anchorY).toBeGreaterThanOrEqual(p.offsetTop);
    expect(anchorY).toBeLessThanOrEqual(p.offsetTop + p.card.h);
    expect(anchorY - p.offsetTop).toBeGreaterThan(p.card.h * 0.5);

    // 4) 短卡停留在舞台上半区，不压住聚焦中的故障部件
    expect(p.card.y - p.stage.y + p.card.h).toBeLessThan(p.stage.h * 0.5);
  });
}
