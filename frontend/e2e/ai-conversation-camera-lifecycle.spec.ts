// e2e/ai-conversation-camera-lifecycle.spec.ts
// 相机生命周期回归（任务 05 · 独立验收 P2-1）
//
// 目标断言（全部与实际绘制相连，不以故障卡 data-locked 代证相机）：
// 1. 故障定位动画在结束边界（3900ms）前后连续，结束后**保持**聚焦终态，不跳回初始视角；
// 2. 用户在动画期间接管时，从屏幕上实际看到的相机继续，不跳变；
// 3. 动画结束后拖拽 / 滚轮 / 方向键同样从当前相机继续；
// 4. Home 明确复位到初始视角；
// 5. reduced-motion 直接呈现目标终态（相机口径与 V44 原型一致：立即到目标视角）。
//
// 相机事实由画布自身暴露（data-camera-angle / data-camera-zoom），
// 其唯一真源与绘制、命中测试、故障锚点共用同一份「当前相机」。
// 本用例只依赖 mock 夹具，不依赖任何外部原型文件，可在默认 e2e 套件内运行。

import { expect, test } from '@playwright/test';

import { buildParts, createMockState, installGraphQLMock } from './helpers/ai-conversation-mocks';
import { seedAuthSession } from './helpers/auth-session-seed';

/** 原型 AI33Paint / AI33Model 常量：目标角度 0.37、初始角度 -0.39、结束边界 3900ms */
const TARGET_ANGLE = 0.37;
const INITIAL_ANGLE = -0.39;
const ANIMATION_END_MS = 3900;
const KEYBOARD_ROTATE_STEP = 0.18;
const DRAG_PER_PIXEL = 0.012;

type CameraSample = { angle: number; zoom: number };

async function readCamera(page: import('@playwright/test').Page): Promise<CameraSample | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector('.ai-scene-canvas canvas');
    if (canvas === null) {
      return null;
    }
    const angle = canvas.getAttribute('data-camera-angle');
    const zoom = canvas.getAttribute('data-camera-zoom');
    if (angle === null || zoom === null) {
      return null;
    }
    return { angle: Number(angle), zoom: Number(zoom) };
  });
}

/** 连续采样相机，直到达到 durationMs 或超时 */
async function sampleCamera(
  page: import('@playwright/test').Page,
  durationMs: number,
): Promise<CameraSample[]> {
  const samples: CameraSample[] = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const sample = await readCamera(page);
    if (sample !== null) {
      samples.push(sample);
    }
    await page.waitForTimeout(80);
  }
  return samples;
}

/** 触发一轮 WARNING 并等故障卡锁定 */
async function triggerWarning(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel('AI 提问').fill('手臂 1 无动作，怎么排查？');
  await page.getByRole('button', { name: '发送问题' }).click();
  await expect(page.locator('.ai-fault-card')).toHaveAttribute('data-locked', 'true', {
    timeout: 15_000,
  });
}

test.describe('相机生命周期（任务 05 · P2-1）', () => {
  test.beforeEach(async ({ page }) => {
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
  });

  test('聚焦途中 Tab 与普通点击不接管相机', async ({ page }) => {
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();
    const canvas = page.locator('.ai-scene-canvas canvas');
    await expect
      .poll(async () => (await readCamera(page))?.angle ?? INITIAL_ANGLE, {
        timeout: 8000,
        intervals: [30],
      })
      .toBeGreaterThan(INITIAL_ANGLE + 0.05);
    expect((await readCamera(page))!.angle).toBeLessThan(TARGET_ANGLE - 0.05);
    await canvas.focus();
    await page.keyboard.press('Tab');
    await canvas.click({ position: { x: 5, y: 5 } });
    await expect
      .poll(async () => (await readCamera(page))?.angle ?? INITIAL_ANGLE, { timeout: 6000 })
      .toBeCloseTo(TARGET_ANGLE, 3);
  });

  test('聚焦途中方向键从当前视角接管', async ({ page }) => {
    await page.getByLabel('AI 提问').fill('手臂 1 无动作');
    await page.getByRole('button', { name: '发送问题' }).click();
    const canvas = page.locator('.ai-scene-canvas canvas');
    await expect
      .poll(async () => (await readCamera(page))?.angle ?? INITIAL_ANGLE, {
        timeout: 8000,
        intervals: [30],
      })
      .toBeGreaterThan(INITIAL_ANGLE + 0.05);
    await canvas.focus();
    const before = (await readCamera(page))!.angle;
    expect(before).toBeLessThan(TARGET_ANGLE - 0.05);
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => (await readCamera(page))?.angle ?? INITIAL_ANGLE, { timeout: 5000 })
      .toBeCloseTo(before + KEYBOARD_ROTATE_STEP, 1);
  });

  test('动画结束边界前后相机连续，结束后保持聚焦终态', async ({ page }) => {
    await triggerWarning(page);

    // 覆盖锁定（2850ms）到结束（3900ms）之后的整段时间线
    const samples = await sampleCamera(page, ANIMATION_END_MS + 1200);
    expect(samples.length, '应能持续读取到相机事实').toBeGreaterThan(10);

    const first = samples[0];
    const last = samples[samples.length - 1];
    expect(first, '首帧应从初始视角开始').not.toBeNull();
    expect(last, '末帧应存在').not.toBeNull();

    // 1) 确实聚焦过：过程中出现不同于初始角度的中间值
    const moved = samples.some((sample) => Math.abs(sample.angle - INITIAL_ANGLE) > 0.01);
    expect(moved, '动画过程中相机应离开初始视角').toBe(true);

    // 2) 结束边界前后连续：相邻采样角度差不超过单帧最大变化量
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      expect(
        Math.abs(current.angle - previous.angle),
        `第 ${index} 次采样出现相机跳变`,
      ).toBeLessThan(0.05);
    }

    // 3) 结束后保持聚焦终态（不跳回初始视角）
    expect(last!.angle, '动画结束后相机应保持聚焦目标角度').toBeCloseTo(TARGET_ANGLE, 3);
    expect(last!.zoom, '动画结束后相机应保持聚焦缩放').toBeGreaterThan(1.0);
  });

  test('动画期间用户接管从当前相机继续，不跳回初始视角', async ({ page }) => {
    await triggerWarning(page);

    // 等到相机已离开初始角度但尚未到达目标（聚焦进行中）
    await expect
      .poll(
        async () => {
          const sample = await readCamera(page);
          return sample === null ? null : Math.abs(sample.angle - INITIAL_ANGLE);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0.05);

    const before = await readCamera(page);
    expect(before).not.toBeNull();

    // 用户用方向键接管
    await page.locator('.ai-scene-canvas canvas').focus();
    await page.keyboard.press('ArrowRight');

    // 等待下一帧绘制后再读相机事实
    await expect
      .poll(
        async () => {
          const sample = await readCamera(page);
          return sample === null ? null : sample.angle;
        },
        { timeout: 5_000 },
      )
      .toBeCloseTo(before!.angle + KEYBOARD_ROTATE_STEP, 2);
  });

  test('动画结束后拖拽与滚轮从当前相机继续，Home 复位', async ({ page }) => {
    await triggerWarning(page);
    await page.waitForTimeout(ANIMATION_END_MS + 800);

    const settled = await readCamera(page);
    expect(settled, '动画结束后应有相机事实').not.toBeNull();
    expect(settled!.angle, '动画结束后应保持聚焦终态').toBeCloseTo(TARGET_ANGLE, 3);

    // 拖拽：从当前角度继续（起点就是屏幕上看到的角度）
    const canvas = page.locator('.ai-scene-canvas canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2, { steps: 4 });
    await page.mouse.up();

    const dragged = await readCamera(page);
    expect(dragged).not.toBeNull();
    expect(
      Math.abs(dragged!.angle - (settled!.angle + 40 * DRAG_PER_PIXEL)),
      '拖拽应从当前相机继续，不跳变',
    ).toBeLessThan(0.05);

    // Home：明确复位到初始视角
    await canvas.focus();
    await page.keyboard.press('Home');
    await expect
      .poll(
        async () => {
          const sample = await readCamera(page);
          return sample === null ? null : sample.angle;
        },
        { timeout: 5_000 },
      )
      .toBeCloseTo(INITIAL_ANGLE, 3);
    const reset = await readCamera(page);
    expect(reset!.zoom, 'Home 应复位到初始缩放').toBeCloseTo(1, 3);
  });

  test('视口尺寸变化后相机不回退', async ({ page }) => {
    await triggerWarning(page);
    await page.waitForTimeout(ANIMATION_END_MS + 800);

    const before = await readCamera(page);
    expect(before!.angle, '动画结束后应保持聚焦终态').toBeCloseTo(TARGET_ANGLE, 3);

    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(500);

    const after = await readCamera(page);
    expect(after!.angle, 'resize 后相机不应回退到初始视角').toBeCloseTo(TARGET_ANGLE, 3);
  });

  test('新一轮定位以当前镜头为起点，不跳回初始视角', async ({ page }) => {
    await seedAuthSession(page, 'ENGINEER');
    const state = createMockState();
    const visualization = {
      sceneId: 'LITHO_WORKFLOW_V1',
      stage: 2,
      parts: buildParts('NORMAL', { reticle_arm: 'WARNING', reticle_table: 'HIGHLIGHT' }),
    };
    state.statusQueue = [
      { status: 'SUCCEEDED', visualization },
      { status: 'SUCCEEDED', visualization },
    ];
    await installGraphQLMock(page, state);
    await page.goto('/engineer/ai');

    await triggerWarning(page);
    await page.waitForTimeout(ANIMATION_END_MS + 800);

    // 用户拖拽离开目标视角
    const canvas = page.locator('.ai-scene-canvas canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(
        async () => {
          const sample = await readCamera(page);
          return sample === null ? null : sample.angle;
        },
        { timeout: 5_000 },
      )
      .toBeCloseTo(TARGET_ANGLE + 40 * DRAG_PER_PIXEL, 2);

    // 第二轮定位：动画起点应是当前镜头，过程中不得跳回初始视角
    await page.getByLabel('AI 提问').fill('取板台也异常，再看看');
    await page.getByRole('button', { name: '发送问题' }).click();

    const samples = await sampleCamera(page, 1200);
    expect(samples.length).toBeGreaterThan(3);
    const lowest = Math.min(...samples.map((sample) => sample.angle));
    expect(lowest, '新一轮定位过程中不得跳回初始视角（旧实现会从 -0.39 重新开始）').toBeGreaterThan(
      INITIAL_ANGLE + 0.05,
    );
  });

  test('reduced-motion 直接呈现目标终态', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    });
    const page = await context.newPage();
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
    await triggerWarning(page);

    // 减少动态效果时不做镜头运动，直接给终态
    await expect
      .poll(
        async () => {
          const sample = await readCamera(page);
          return sample === null ? null : sample.angle;
        },
        { timeout: 8_000 },
      )
      .toBeCloseTo(TARGET_ANGLE, 3);

    await context.close();
  });
});
