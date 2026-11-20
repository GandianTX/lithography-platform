// e2e/ai-conversation-face-color.spec.ts
// 几何色面回归（任务 05 · 独立验收 P2-3）
//
// 目标断言：正常态面片使用实色三档（顶面 / 奇数侧 / 偶数侧），不与背景混合。
// 旧实现用 globalAlpha 0.72 / 0.88 做明暗，颜色被背景稀释放灰，因此「精确命中原型面色」
// 的像素数为 0 → 本用例在旧实现上失败。只依赖 mock 夹具，可在默认 e2e 套件内运行。

import { expect, test } from '@playwright/test';

import { buildParts, createMockState, installGraphQLMock } from './helpers/ai-conversation-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';

/** V44 原型 AI33Paint 五档色面（浅色主题实色值） */
const FACE_COLORS = {
  normalTop: [51, 68, 88], // #334458
  normalSideA: [28, 41, 58], // #1c293a
  normalSideB: [38, 55, 74], // #26374a
  baseTop: [59, 73, 93], // #3b495d
  baseSideA: [40, 52, 73], // #283449
  faultTop: [232, 96, 102], // #e86066
};

type ColorCount = { rgb: string; count: number };

async function readCanvasColors(page: import('@playwright/test').Page): Promise<ColorCount[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.ai-scene-canvas canvas');
    if (canvas === null) {
      return [];
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      return [];
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map<string, number>();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) {
        continue;
      }
      const key = `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([rgb, count]) => ({ rgb, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 32);
  });
}

function hasExactColor(colors: ColorCount[], expected: readonly number[]): boolean {
  return colors.some((entry) => {
    const parts = entry.rgb.split(',').map(Number);
    return (
      parts.length === 3 &&
      Math.abs(parts[0] - expected[0]) <= 1 &&
      Math.abs(parts[1] - expected[1]) <= 1 &&
      Math.abs(parts[2] - expected[2]) <= 1
    );
  });
}

test.describe('几何色面实色化（任务 05 · P2-3）', () => {
  test('正常态面片为实色三档，不与背景混合', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    await installGraphQLMock(page, createMockState());
    await page.goto('/engineer/ai');
    await page.waitForTimeout(1500);

    const colors = await readCanvasColors(page);
    expect(colors.length, '应能读到画布像素颜色').toBeGreaterThan(0);

    expect(hasExactColor(colors, FACE_COLORS.normalTop), '正常态顶面应使用实色 #334458').toBe(true);
    expect(hasExactColor(colors, FACE_COLORS.normalSideA), '正常态奇数侧面应使用实色 #1c293a').toBe(
      true,
    );
    expect(hasExactColor(colors, FACE_COLORS.normalSideB), '正常态偶数侧面应使用实色 #26374a').toBe(
      true,
    );
    expect(hasExactColor(colors, FACE_COLORS.baseTop), '底座顶面应使用实色 #3b495d').toBe(true);
    expect(hasExactColor(colors, FACE_COLORS.baseSideA), '底座奇数侧面应使用实色 #283449').toBe(
      true,
    );
  });

  test('故障聚焦态目标部件使用故障态实色', async ({ page }) => {
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
    await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
    await page.getByRole('button', { name: '发送问题' }).click();
    await expect(page.locator('.ai-fault-card')).toHaveAttribute('data-locked', 'true', {
      timeout: 15_000,
    });
    await page.waitForTimeout(600);

    const colors = await readCanvasColors(page);
    expect(hasExactColor(colors, FACE_COLORS.faultTop), '故障态顶面应使用实色 #e86066').toBe(true);
  });
});
