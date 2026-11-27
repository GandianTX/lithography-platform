// e2e/reference-library-visual.spec.ts
//
// PR5 S3-1 / S3-5 / S3-6 / S3-7 独立资料列表（/reference-documents）局部视觉验收
//（无后端确定性版本）：会话由 helpers/auth-session-seed 预置，GraphQL 一律 stub，
// 不依赖真实后端、开发库或 backend/env/.env.development，fresh clone 直接可跑。
// 真实前后端链路（管理员上传/编辑/软删、工程师只读下载）由 reference-document-real.spec.ts
// 承担，职责分离。
//
// 验收内容（PR5 整页视觉计划 20260929 + 计划表 S3-1 / S3-5 / S3-6，
// 数值源 frontend/docs/gkj-visual-baseline.md §6.3 / §6.6）：
// - 整页骨架（本轮范围变更）：`/reference-documents` 精确列表路由对齐 gkj 知识库页整页骨架——
//   页头 top 70.5±0.5px / 高 67px、真实汇总条 top 157.5px / 高 67.5px / 下距 16px、
//   列表卡 top 241±0.5px；工作区纯色 #f3f4f6 且取消 1280px 上限（1920 内容 x236 / w1658，
//   1366/1440 左边界仍 236px）；
// - 仍然不借用知识库整页变体：五类整页 kb modifier（与 PR3 回归探针 kbVariantNodes 同一集合）
//   为 0，且不出现 .kb-card / .kb-table-scope / .kb-summary —— 两个路由取值同源、类名互不借用；
// - 真实汇总条（S3）：三列分别取自列表 total、后端类型枚举与型号 query 条数，无演示字段；
// - 卡壳（PR5 R1）：与 .kb-card 同一套 token——白底 / 1px #e5e7eb / 10px 圆角 /
//   0 1px 3px rgba(15,23,42,.05) / overflow hidden；卡内 AntD Table 顶角归零（由外卡裁切）；
// - 工具区：搜索框 36px / 6px 圆角，同排「筛选」按钮 36px / 6px 圆角（与原型工具栏同构）；
// - 筛选区（PR5 R2）：默认收起（占 0px）、点「筛选」展开；展开时卡内「工具区—筛选区—表格—
//   卡底分页」四段连续贴合，工具区/筛选区各带 12px padding + 1px 底线，段间相对间距为 0
//   （原型 gkj.html L1043-1072）；默认态表格 top − 卡 top = 62px、展开态 = 123px（1440）；
// - P1-2（S3 评审修复轮）：输入非空后出现的清除按钮必须与知识库变体同源（透明底、无边框、
//   padding 0、浅灰 #94a3b8、cursor pointer），不得退化为浏览器默认按钮；
// - 紧凑表格：表头 35.5px / 10px，正文行 38.5px / 11px，行线 1px；
// - 卡底分页行：padding 7.5px 16px（纵向收敛使整行 39px，PR5 整页计划 S4-2）、10px 字号、
//   两端对齐，含「共 N 条」；24px 真实分页器点击目标不压缩；
// - 1366×768 / 1440×900 / 1920×1080 与 375×667 均无整页横向滚动（横滚只允许发生在表格内部，
//   基准 §6.4.4）；
// - S3-5：标题 / 说明 / 原始文件名三列单行截断（ellipsis + 原生 title 全文），三列**分别**验证
//   截断确实发生（scrollWidth > clientWidth）且不撑高行、不撑破页面，点击被截断单元格仍进入详情路由；
// - S3-7：本文件即 PR5「整页骨架对齐 + 类名互不借用」基准的可执行副本，
//   数值取自 baseline §6.3 / §6.4.4 / §6.6，不改写 baseline §6 其他路由的既有断言。
//
// 截图与 JSON 写入 testInfo outputPath（frontend/test-results/...），由采集人复制归档到
// docs/tmp/PR/PR5-证据（本地可追溯，不随 PR 提交）。
//
// GraphQL stub 与夹具（LIST_ITEMS / LONG_TEXT_ITEMS / LONG_TITLE / LONG_DESCRIPTION /
// LONG_FILENAME）由 helpers/reference-document-mocks.ts 统一提供（PR5 S6 收口抽取），
// 本文件只导入，不再持有第二份平行实现。

import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { seedAuthSession } from './helpers/auth-session-seed';
import {
  EQUIPMENT_MODELS,
  installReferenceLibraryMocks,
  LIST_ITEMS,
  LONG_DESCRIPTION,
  LONG_FILENAME,
  LONG_TEXT_ITEMS,
  LONG_TITLE,
} from './helpers/reference-document-mocks';
import {
  buildEvidenceFileName,
  captureStableViewport,
  prepareStableViewport,
  readPngDimensions,
  waitForFontsReady,
} from './helpers/visual-evidence';

const PAGE_PATH = '/reference-documents';
const ROLE = 'ENGINEER';

/** 基准 §6.3 的紧凑数值（取自原型实测，不是当前实现自证） */
const SEARCH_HEIGHT = '36px';
const SEARCH_RADIUS = '6px';
const HEAD_CELL_HEIGHT = '35.5px';
const HEAD_CELL_FONT_SIZE = '10px';
const BODY_CELL_HEIGHT = '38.5px';
const BODY_CELL_FONT_SIZE = '11px';
// 卡底分页行（PR5 整页视觉计划 S4-2）：保留 24px 真实分页器，纵向 padding 收敛为 7.5px，
// 使整行 border-box 高 39px（对齐原型 39px 卡底）；横向保持原型 16px。
const FOOTER_PADDING = '7.5px 16px';
const FOOTER_FONT_SIZE = '10px';

/** PR5 整页视觉计划 §2 的整页坐标契约（1440×900，M 档） */
const HEADER_TOP = 70.5;
const HEADER_HEIGHT = 67;
const CARD_TOP = 241;
const SUMMARY_HEIGHT = 67.5;
const SUMMARY_BOTTOM_GAP = 16;
const SUMMARY_TOP = HEADER_TOP + HEADER_HEIGHT + 20; // 70.5 + 67 + 20 = 157.5

/** PR3 回归探针 kbVariantNodes 的同一集合：整页知识库 modifier，独立资料页必须为 0。 */
const PAGE_LEVEL_KB_MODIFIERS = [
  '.kb-page',
  '.kb-card',
  '.page-header--kb',
  '.app-workspace--knowledge-base',
  '.app-main--knowledge-base',
] as const;

/** 视口清单：1440×900 为基准 §1 锁定视口；1366×768 与 1920×1080 为 PR5 整页计划的
 *  整页坐标视口（S5-1）；375×667 用于暴露整页横滚并守护窄屏不复制桌面 48.5px 节奏。 */
const VIEWPORTS = [
  { height: 900, label: '1440x900', width: 1440 },
  { height: 768, label: '1366x768', width: 1366 },
  { height: 1080, label: '1920x1080', width: 1920 },
  { height: 667, label: '375x667', width: 375 },
] as const;

/** 桌面视口（>1024px）：整页纵向节奏与绝对坐标契约只在这一档成立 */
const isDesktopViewport = (label: string) => label !== '375x667';

test('独立资料列表整页对齐知识库骨架：页头/汇总条/列表卡坐标、紧凑密度与卡底分页（PR5 整页 S1–S4）', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  const evidenceDir = testInfo.outputPath();
  mkdirSync(evidenceDir, { recursive: true });

  await seedAuthSession(page, ROLE);
  await installReferenceLibraryMocks(page);
  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};
  // 同轮四视口默认/展开态截图必须共享同一干净 SHA（逐张记录，结束时断言一致）
  const captureShas: string[] = [];

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto(PAGE_PATH);
    await waitForFontsReady(page);

    // 通用工作区与默认页头：知识库整页变体不进入该路由
    await expect(page.locator('.page-title')).toHaveText('历史维修记录库');
    for (const selector of PAGE_LEVEL_KB_MODIFIERS) {
      await expect(page.locator(selector), `${selector} 不应出现在独立资料页`).toHaveCount(0);
    }
    await expect(page.locator('.kb-table-scope')).toHaveCount(0);

    // 整页骨架入口（PR5 整页计划 S1/S2/S3）：页面根、页头变体与真实汇总条均落在独立类名下
    await expect(page.locator('.reference-library-page')).toHaveCount(1);
    await expect(page.locator('.page-header--reference-library')).toHaveCount(1);
    await expect(page.locator('.reference-library-summary')).toHaveCount(1);
    await expect(page.locator('.reference-library-summary-cell')).toHaveCount(3);
    // 汇总条三项全部来自真实状态：列表 total（10 条夹具）、后端类型枚举、型号 query 条数
    await expect(page.locator('.reference-library-summary-cell').nth(0)).toContainText(
      `共 ${LIST_ITEMS.length} 条`,
    );
    await expect(page.locator('.reference-library-summary-cell').nth(1)).toContainText(
      '错误代码手册',
    );
    await expect(page.locator('.reference-library-summary-cell').nth(2)).toContainText(
      `${EQUIPMENT_MODELS.length} 个型号`,
    );

    await expect(page.getByText('光源模块维护指南')).toBeVisible();

    // 工具区：36px 搜索框 + 同排 36px「筛选」按钮（同一套 --radius-control；与原型工具栏同构）
    const search = page.locator('.reference-library-search');
    await expect(search).toHaveCount(1);
    expect(await search.evaluate((el) => getComputedStyle(el).height)).toBe(SEARCH_HEIGHT);
    expect(await search.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(SEARCH_RADIUS);
    const searchIcon = search.locator('svg');
    expect(await searchIcon.evaluate((el) => getComputedStyle(el).height), '搜索图标 16×16').toBe(
      '16px',
    );
    expect(await searchIcon.evaluate((el) => getComputedStyle(el).marginRight)).toBe('8px');

    // 卡壳（PR5 R1）：独立资料页卡与 .kb-card 用同一套 token（基准 §6.1 / §6.5）——
    // 白底 / 1px #e5e7eb / 10px 圆角 / 0 1px 3px rgba(15,23,42,.05) / overflow hidden
    const card = page.locator('.reference-library-card .ant-card');
    await expect(card).toHaveCount(1);
    const cardStyles = await card.evaluate((el) => {
      const style = getComputedStyle(el);

      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        borderTopWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        overflow: style.overflow,
      };
    });
    expect(cardStyles, '独立资料页卡壳必须与 .kb-card 同一套 token').toEqual({
      backgroundColor: 'rgb(255, 255, 255)',
      borderColor: 'rgb(229, 231, 235)',
      borderTopWidth: '1px',
      borderRadius: '10px',
      boxShadow: 'rgba(15, 23, 42, 0.05) 0px 1px 3px 0px',
      overflow: 'hidden',
    });

    // 卡内 AntD Table 顶角归零：顶角由外卡 10px 裁切（原型 .kb-table 无自身圆角）
    expect(
      await page
        .locator('.reference-library-table-scope .ant-table')
        .evaluate((el) => getComputedStyle(el).borderRadius),
      '表格自身圆角必须归零（由外卡 10px 裁切）',
    ).toBe('0px');
    expect(
      await page
        .locator('.reference-library-table-scope .ant-table-thead th')
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
      '表头首个单元格顶角必须归零',
    ).toBe('0px');

    // 工具区几何：12px padding + 1px 底线；「筛选」按钮 36px / 6px
    const toolbar = page.locator('.reference-library-toolbar');
    expect(await toolbar.evaluate((el) => getComputedStyle(el).padding)).toBe('12px');
    expect(
      await toolbar.evaluate((el) => getComputedStyle(el).borderBottomWidth),
      '工具区 1px 底线',
    ).toBe('1px');

    const filterButton = page.locator('.reference-library-toolbar-button');
    await expect(filterButton).toHaveCount(1);
    await expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    expect(await filterButton.evaluate((el) => getComputedStyle(el).height)).toBe(SEARCH_HEIGHT);
    expect(await filterButton.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(
      SEARCH_RADIUS,
    );

    // 默认态（PR5 R2）：筛选区不渲染、占 0px；表格 top − 卡 top = 62±0.5px
    // 复检轮 O1：不渲染 Card 卡头（列表标题由页面 PageHeader 承载），卡体不带内边距。
    await expect(page.locator('.reference-library-filter-panel')).toHaveCount(0);
    expect(
      await page.locator('.reference-library-card .ant-card-head').count(),
      '独立资料页不应渲染 Card 卡头（与原型 .kb-card 同构）',
    ).toBe(0);
    const cardBody = page.locator('.reference-library-card .ant-card-body');
    expect(
      await cardBody.evaluate((el) => getComputedStyle(el).paddingTop),
      '卡体不再自带内边距（由工具区 12px 承担）',
    ).toBe('0px');

    const defaultPositions = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);

        if (!el) {
          throw new Error(`缺少段节点：${selector}`);
        }

        const rect = el.getBoundingClientRect();

        return { bottom: rect.bottom, top: rect.top };
      };

      return {
        card: box('.reference-library-card .ant-card'),
        table: box('.reference-library-table-scope'),
        toolbar: box('.reference-library-toolbar'),
      };
    });
    const defaultTableOffset = defaultPositions.table.top - defaultPositions.card.top;
    expect(
      Math.abs(defaultTableOffset - 62),
      `默认态表格 top − 卡 top 应为 62px（实测 ${defaultTableOffset}px）`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(defaultPositions.toolbar.top - (defaultPositions.card.top + 1)),
      '工具区应紧贴卡上边框内侧（无卡头时才成立）',
    ).toBeLessThanOrEqual(0.5);

    // PR5 整页计划 S0-4 / S0-5 / S1-2：整页纵向节奏与工作区几何。
    // 公式：22（工作区顶距）+ 48.5（顶部节奏）+ 67（页头）+ 20（页头下距）
    //      + 67.5（汇总条）+ 16（汇总条下距）= 241（列表卡 top）
    // 窄屏不消费 48.5px 桌面节奏，故本组断言只锚定桌面视口。
    let pageGeometrySnapshot: Record<string, number | string> | null = null;

    if (isDesktopViewport(viewport.label)) {
      const pageGeometry = await page.evaluate(() => {
        const rect = (selector: string) => {
          const el = document.querySelector(selector);

          if (!el) {
            throw new Error(`缺少整页节点：${selector}`);
          }

          const box = el.getBoundingClientRect();

          return {
            bottom: box.bottom,
            height: box.height,
            left: box.left,
            top: box.top,
            width: box.width,
          };
        };

        return {
          card: rect('.reference-library-card .ant-card'),
          header: rect('.page-header'),
          main: rect('.app-main--reference-library'),
          summary: rect('.reference-library-summary'),
          workspaceBg: getComputedStyle(
            document.querySelector('.app-workspace--reference-library') as Element,
          ).backgroundColor,
        };
      });

      expect(
        Math.abs(pageGeometry.header.top - HEADER_TOP),
        `页头 top 应为 ${HEADER_TOP}px（实测 ${pageGeometry.header.top}px）`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(pageGeometry.header.height - HEADER_HEIGHT),
        `页头高度应为 ${HEADER_HEIGHT}px（实测 ${pageGeometry.header.height}px）`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(pageGeometry.summary.top - SUMMARY_TOP),
        `汇总条 top 应为 ${SUMMARY_TOP}px（实测 ${pageGeometry.summary.top}px）`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(pageGeometry.summary.height - SUMMARY_HEIGHT),
        `汇总条高度应为 ${SUMMARY_HEIGHT}px（实测 ${pageGeometry.summary.height}px）`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(pageGeometry.card.top - pageGeometry.summary.bottom - SUMMARY_BOTTOM_GAP),
        `汇总条下距应为 ${SUMMARY_BOTTOM_GAP}px（实测 ${
          pageGeometry.card.top - pageGeometry.summary.bottom
        }px）`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(pageGeometry.card.top - CARD_TOP),
        `列表卡 top 应为 ${CARD_TOP}px（实测 ${pageGeometry.card.top}px）`,
      ).toBeLessThanOrEqual(0.5);

      // 工作区：纯色（取消通用渐变）+ 精确路由变体
      expect(pageGeometry.workspaceBg, '资料列表工作区应为纯色 #f3f4f6').toBe('rgb(243, 244, 246)');

      // 内容左边界固定 236px（210 侧栏 + 26 工作区左 padding）；
      // 1920 下取消 1280px 上限占满剩余宽度（1920 − 236 − 26 = 1658）
      expect(
        Math.abs(pageGeometry.main.left - 236),
        `内容左边界应为 236px（实测 ${pageGeometry.main.left}px）`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(pageGeometry.main.width - (viewport.width - 262)),
        `内容宽度应为视口 − 262px（实测 ${pageGeometry.main.width}px）`,
      ).toBeLessThanOrEqual(0.5);

      pageGeometrySnapshot = {
        cardTop: pageGeometry.card.top,
        contentLeft: pageGeometry.main.left,
        contentWidth: pageGeometry.main.width,
        headerHeight: pageGeometry.header.height,
        headerTop: pageGeometry.header.top,
        summaryBottomGap: pageGeometry.card.top - pageGeometry.summary.bottom,
        summaryHeight: pageGeometry.summary.height,
        summaryTop: pageGeometry.summary.top,
        workspaceBackground: pageGeometry.workspaceBg,
      };
    }

    const fileName = buildEvidenceFileName({
      area: 'reference-library-list',
      capturedAt,
      role: ROLE,
      viewportLabel: viewport.label,
    });
    const pngPath = path.join(evidenceDir, fileName);
    const capture = await captureStableViewport(page, { fileName, filePath: pngPath });
    const png = readPngDimensions(pngPath);
    expect(png).toEqual({ height: viewport.height, width: viewport.width });

    // 展开态（PR5 R2）：点「筛选」后筛选区渲染（12px padding + 1px 底线），
    // Select 与搜索框同高同圆角（AntD v6 的 Select 视觉盒是 .ant-select 根元素）；
    // 1440 下表格 top − 卡 top = 123±0.5px（工具区 62px + 筛选区 61px）
    await filterButton.click();
    await expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    const filterPanel = page.locator('.reference-library-filter-panel');
    await expect(filterPanel).toHaveCount(1);
    expect(await filterPanel.evaluate((el) => getComputedStyle(el).padding)).toBe('12px');
    expect(
      await filterPanel.evaluate((el) => getComputedStyle(el).borderBottomWidth),
      '筛选区 1px 底线',
    ).toBe('1px');

    const filterSelects = filterPanel.locator('.ant-select');
    await expect(filterSelects).toHaveCount(2);
    const filterSelect = filterSelects.first();
    expect(await filterSelect.evaluate((el) => getComputedStyle(el).height)).toBe(SEARCH_HEIGHT);
    expect(await filterSelect.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(
      SEARCH_RADIUS,
    );

    const expandedPositions = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);

        if (!el) {
          throw new Error(`缺少段节点：${selector}`);
        }

        const rect = el.getBoundingClientRect();

        return { bottom: rect.bottom, top: rect.top };
      };

      return {
        card: box('.reference-library-card .ant-card'),
        filter: box('.reference-library-filter-panel'),
        footer: box('.reference-library-card-footer'),
        table: box('.reference-library-table-scope'),
        toolbar: box('.reference-library-toolbar'),
      };
    });
    const expandedTableOffset = expandedPositions.table.top - expandedPositions.card.top;

    // 375 下筛选区因两个 Select 换行而更高，只锚定 1440 基准视口
    if (viewport.label === '1440x900') {
      expect(
        Math.abs(expandedTableOffset - 123),
        `展开态表格 top − 卡 top 应为 123px（实测 ${expandedTableOffset}px）`,
      ).toBeLessThanOrEqual(0.5);
    }

    const gapAfterToolbar = expandedPositions.filter.top - expandedPositions.toolbar.bottom;
    const gapAfterFilter = expandedPositions.table.top - expandedPositions.filter.bottom;
    const gapAfterTable = expandedPositions.footer.top - expandedPositions.table.bottom;
    expect(
      Math.abs(gapAfterToolbar),
      `工具区与筛选区之间不应有额外间距（实测 ${gapAfterToolbar}px）`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(gapAfterFilter),
      `筛选区与表格之间不应有额外间距（实测 ${gapAfterFilter}px）`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(gapAfterTable),
      `表格与卡底分页之间不应有额外间距（实测 ${gapAfterTable}px）`,
    ).toBeLessThanOrEqual(0.5);

    // 紧凑表格密度（基准 §6.3）
    const scope = page.locator('.reference-library-table-scope');
    await expect(scope).toHaveCount(1);
    const headCell = scope.locator('.ant-table-thead th').first();
    expect(await headCell.evaluate((el) => getComputedStyle(el).height)).toBe(HEAD_CELL_HEIGHT);
    expect(await headCell.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      HEAD_CELL_FONT_SIZE,
    );
    // 正文行取真实数据行：AntD 在开启 scroll.x 时会先渲染一条 height:0 的测量行，不能用 tbody td 首个
    const bodyCell = scope.locator('.ant-table-tbody tr.ant-table-row td.ant-table-cell').first();
    expect(await bodyCell.evaluate((el) => getComputedStyle(el).height)).toBe(BODY_CELL_HEIGHT);
    expect(await bodyCell.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      BODY_CELL_FONT_SIZE,
    );

    // 卡底分页行：统计 + 紧凑分页两端对齐
    const footer = page.locator('.reference-library-card-footer');
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText(`共 ${LIST_ITEMS.length} 条`);
    expect(await footer.evaluate((el) => getComputedStyle(el).padding)).toBe(FOOTER_PADDING);
    expect(await footer.evaluate((el) => getComputedStyle(el).fontSize)).toBe(FOOTER_FONT_SIZE);
    // 卡底收敛至 39px（PR5 整页计划 S4-2）：7.5 + 24（真实分页器）+ 7.5
    expect(
      await footer.evaluate((el) => getComputedStyle(el).height),
      '卡底分页行应收敛为 39px',
    ).toBe('39px');
    expect(
      await footer.locator('.ant-pagination').evaluate((el) => getComputedStyle(el).height),
      '分页器点击目标保持 24px，不压缩',
    ).toBe('24px');
    await expect(footer.locator('.ant-pagination')).toBeVisible();

    // 横滚只允许发生在表格内部（基准 §6.4.4）
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${viewport.label} 不应出现整页横向滚动`).toBeLessThanOrEqual(0);

    // 展开态整页证据（与默认态分开留档，供 R4 并排比对）
    const expandedFileName = `reference-library-filter-expanded-${viewport.label}.png`;
    const expandedPngPath = path.join(evidenceDir, expandedFileName);
    const expandedCapture = await captureStableViewport(page, {
      fileName: expandedFileName,
      filePath: expandedPngPath,
    });
    captureShas.push(capture.gitSha, expandedCapture.gitSha);

    // P1-2（S3 评审修复轮）：清除按钮是「输入非空后才渲染」的 DOM，必须与 .kb-search-clear 同源。
    // 放在默认态截图之后执行，避免防抖重载影响前面的 ready 断言与截图内容。
    const searchInput = search.locator('input');
    await searchInput.fill('维护');
    const clearButton = search.locator('.reference-library-search-clear');
    await expect(clearButton).toHaveCount(1);
    const clearStyles = await clearButton.evaluate((el) => {
      const style = getComputedStyle(el);

      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        color: style.color,
        cursor: style.cursor,
        marginLeft: style.marginLeft,
        padding: style.padding,
      };
    });
    expect(clearStyles, '清除按钮必须与 .kb-search-clear 同源，不得退化为浏览器默认按钮').toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '0px',
      color: 'rgb(148, 163, 184)',
      cursor: 'pointer',
      marginLeft: '8px',
      padding: '0px',
    });
    const filledSearchFileName = `reference-library-search-filled-${viewport.label}.png`;
    const filledSearchPng = path.join(evidenceDir, filledSearchFileName);
    // 局部截图例外（登记于 frontend/docs/testing.md）：搜索框元素截图，非全视口；
    // 截图前仍复用统一稳定前置（滚动复位 + 布局稳定）
    await prepareStableViewport(page, filledSearchFileName);
    await search.screenshot({ path: filledSearchPng });

    evidence[viewport.label] = {
      capture,
      cardStyles,
      clearStyles,
      defaultFileName: fileName,
      defaultPng: png,
      defaultTableOffset,
      expandedCapture,
      expandedPng: path.basename(expandedPngPath),
      expandedTableOffset,
      filledSearchPng: path.basename(filledSearchPng),
      pageGeometry: pageGeometrySnapshot,
      gaps: {
        afterFilter: gapAfterFilter,
        afterTable: gapAfterTable,
        afterToolbar: gapAfterToolbar,
      },
      overflow,
    };
  }

  expect(new Set(captureShas).size, '四视口默认/展开态截图必须共享同一 SHA').toBe(1);

  const evidenceJson = path.join(evidenceDir, 'reference-library-visual-evidence.json');
  writeFileSync(
    evidenceJson,
    JSON.stringify(
      {
        capturedAt: capturedAt.toISOString(),
        gitSha: captureShas[0],
        role: ROLE,
        viewports: evidence,
      },
      null,
      2,
    ),
  );
  console.log(`[visual-evidence] ${evidenceJson}`);
});

test('长标题 / 说明 / 原始文件名单行截断且详情入口仍可操作（PR5 S3-5）', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  const evidenceDir = testInfo.outputPath();
  mkdirSync(evidenceDir, { recursive: true });

  await seedAuthSession(page, ROLE);
  await installReferenceLibraryMocks(page, LONG_TEXT_ITEMS);
  const capturedAt = new Date();
  const evidence: Record<string, unknown> = {};
  // 同轮四视口长文本截图必须共享同一干净 SHA（逐张记录，结束时断言一致）
  const captureShas: string[] = [];

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto(PAGE_PATH);
    await waitForFontsReady(page);

    const scope = page.locator('.reference-library-table-scope');
    await expect(scope).toHaveCount(1);
    // 三个长文本列（标题 / 说明 / 原始文件名）统一走 ellipsis
    await expect(scope.locator('th.ant-table-cell-ellipsis')).toHaveCount(3);

    const row = scope.locator('.ant-table-tbody tr.ant-table-row').first();
    const ellipsisCells = row.locator('td.ant-table-cell-ellipsis');
    await expect(ellipsisCells).toHaveCount(3);

    const cellStyles = await ellipsisCells.evaluateAll((cells) =>
      cells.map((cell) => {
        const style = getComputedStyle(cell);
        return {
          overflow: style.overflow,
          textContent: cell.textContent ?? '',
          textOverflow: style.textOverflow,
          title: cell.getAttribute('title'),
          whiteSpace: style.whiteSpace,
        };
      }),
    );

    for (const [index, cell] of cellStyles.entries()) {
      expect(cell.overflow, `第 ${index + 1} 个长文本列 overflow`).toBe('hidden');
      expect(cell.textOverflow, `第 ${index + 1} 个长文本列 text-overflow`).toBe('ellipsis');
      expect(cell.whiteSpace, `第 ${index + 1} 个长文本列 white-space`).toBe('nowrap');
      // 原生 title 属性必须存在（与下一行精确值断言互补：此处只保证不缺失，不假设
      // 「渲染文本 == 原始值」——说明列 null 渲染为「—」、文件名 null 渲染为「纯文本」）
      expect(cell.title, `第 ${index + 1} 个长文本列原生 title 不应缺失`).toBeTruthy();
    }
    expect(cellStyles.map((cell) => cell.title)).toEqual([
      LONG_TITLE,
      LONG_DESCRIPTION,
      LONG_FILENAME,
    ]);

    // 截断必须真的发生：三列**分别**测量内容宽 > 可见宽
    //（P2-2 修复：此前只对标题列测量，却把结论写成「三列均已机械证明」）
    const truncation = await ellipsisCells.evaluateAll((cells) =>
      cells.map((cell) => ({
        clientWidth: cell.clientWidth,
        scrollWidth: cell.scrollWidth,
      })),
    );
    for (const [index, cell] of truncation.entries()) {
      expect(
        cell.scrollWidth,
        `第 ${index + 1} 个长文本列应真的被截断（内容宽 > 可见宽）`,
      ).toBeGreaterThan(cell.clientWidth);
    }
    const titleCell = ellipsisCells.first();

    // 单行截断不撑高行：仍保持基准 §6.3 的 38.5px 正文行高
    expect(await row.evaluate((el) => getComputedStyle(el).height)).toBe(BODY_CELL_HEIGHT);

    // 整页仍无横向滚动（长文本不得撑破页面，基准 §6.4.4）
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${viewport.label} 长文本不应造成整页横向滚动`).toBeLessThanOrEqual(0);

    const fileName = buildEvidenceFileName({
      area: 'reference-library-long-text',
      capturedAt,
      role: ROLE,
      viewportLabel: viewport.label,
    });
    const pngPath = path.join(evidenceDir, fileName);
    const capture = await captureStableViewport(page, { fileName, filePath: pngPath });
    captureShas.push(capture.gitSha);
    const png = readPngDimensions(pngPath);
    expect(png).toEqual({ height: viewport.height, width: viewport.width });

    // 详情入口仍可操作：点击被截断的标题单元格仍进入详情路由
    await titleCell.click();
    await expect(page).toHaveURL(new RegExp(`/reference-documents/${LONG_TEXT_ITEMS[0].id}$`));

    evidence[viewport.label] = { capture, fileName, overflow, png, truncation };
  }

  expect(new Set(captureShas).size, '四视口长文本截图必须共享同一 SHA').toBe(1);

  const evidenceJson = path.join(evidenceDir, 'reference-library-long-text-evidence.json');
  writeFileSync(
    evidenceJson,
    JSON.stringify(
      {
        capturedAt: capturedAt.toISOString(),
        gitSha: captureShas[0],
        role: ROLE,
        viewports: evidence,
      },
      null,
      2,
    ),
  );
  console.log(`[visual-evidence] ${evidenceJson}`);
});
