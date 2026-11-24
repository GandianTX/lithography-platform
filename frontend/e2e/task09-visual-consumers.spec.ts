// frontend/e2e/task09-visual-consumers.spec.ts

import { expect, test } from '@playwright/test';

import { seedAuthSession } from './helpers/auth-session-seed';
import {
  installLocalRuntimeMocks,
  TASK09_REPO_CARD_PADDING,
  TASK09_V44_CARD_PADDING,
} from './helpers/task09-local-runtime-mocks';

/**
 * G28 局部对齐的**消费者回归**（任务 09 第 11 项第 2 条："在该页面局部对齐并检验其他直接消费者"）。
 *
 * 背景：V44 原型实测卡片体（`.ant-card-body`）内边距为 24px，而仓内 `.data-card` 为 16px。
 * 本轮按任务书要求**页面局部对齐**（`.v44-panel-page` 覆盖 `--panel-padding: 24px`），
 * **没有**全局改 `.data-card`——它是跨任务共享的卡片语言，直接消费者逾 20 处。
 *
 * 因此必须验证两件事（否则"局部"就只是口号）：
 * 1. **目标页**确实取到 24px（对齐生效）；
 * 2. **其他直接消费者**确实仍取 16px（未被波及，页面几何不变）。
 *
 * 消费者清单来自 `src/index.css` 里 `.data-card` 的真实消费点（静态核对 + 浏览器实测双证）：
 * 登录、注册、管理端工作台、工程师工作台等**不在** `.v44-panel-page` 作用域内。
 *
 * mock-only：不连真实后端（GraphQL 全部拦截），只断言**渲染后的 computed style**。
 */

/** 非任务 09 目标页的 `.data-card` 直接消费者（至少各渲染一张公共卡片面） */
const OTHER_CONSUMER_PAGES = [
  { label: '登录页', path: '/login', role: 'CUSTOMER' as const },
  { label: '客户注册页', path: '/register/customer', role: 'CUSTOMER' as const },
  { label: '管理端工作台', path: '/admin', role: 'SUPER_ADMIN' as const },
  { label: '工程师工作台', path: '/engineer', role: 'ENGINEER' as const },
];

/** 任务 09 目标页（已挂 `.v44-panel-page`） */
const V44_ALIGNED_PAGES = [
  { label: '本地设置', path: '/local-settings', role: 'ENGINEER' as const },
  { label: '备份与恢复', path: '/local-backup', role: 'ENGINEER' as const },
];

test.describe('G28 局部对齐：目标页生效且其他直接消费者不受影响', () => {
  for (const target of V44_ALIGNED_PAGES) {
    test(`目标页 ${target.label}：公共卡片体内边距应为 V44 实测值 ${TASK09_V44_CARD_PADDING}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedAuthSession(page, target.role);
      await installLocalRuntimeMocks(page);

      await page.goto(target.path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 });
      await page.waitForSelector('.data-card', { timeout: 10_000 });

      const cards = page.locator('.data-card');
      const count = await cards.count();
      expect(count, `${target.label} 应至少渲染一张公共卡片面`).toBeGreaterThan(0);

      // 逐张核对：作用域只应改内边距，圆角等其余几何不变
      const paddings = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.data-card')).map((node) => {
          const style = window.getComputedStyle(node);
          return { padding: style.padding, radius: style.borderRadius };
        }),
      );
      for (const card of paddings) {
        expect(
          card.padding,
          `${target.label} 的每张 .data-card 内边距都应为 ${TASK09_V44_CARD_PADDING}`,
        ).toBe(TASK09_V44_CARD_PADDING);
        expect(card.radius, `${target.label} 的卡片圆角应为 14px（未被 G28 波及）`).toBe(
          '14px',
        );
      }
    });
  }

  for (const target of OTHER_CONSUMER_PAGES) {
    test(`其他消费者 ${target.label}：公共卡片体内边距应保持仓内默认 ${TASK09_REPO_CARD_PADDING}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedAuthSession(page, target.role);
      await installLocalRuntimeMocks(page);

      await page.goto(target.path);
      await page.waitForSelector('h1, h2', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForSelector('.data-card', { timeout: 10_000 });

      const paddings = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.data-card')).map(
          (node) => window.getComputedStyle(node).padding,
        ),
      );
      expect(paddings.length, `${target.label} 应至少渲染一张公共卡片面`).toBeGreaterThan(0);
      for (const padding of paddings) {
        expect(
          padding,
          `${target.label} 的 .data-card 内边距不应被任务 09 的 V44 局部对齐波及`,
        ).toBe(TASK09_REPO_CARD_PADDING);
      }
    });
  }
});
