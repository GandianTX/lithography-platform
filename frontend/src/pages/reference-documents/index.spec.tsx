// src/pages/reference-documents/index.spec.tsx
// @vitest-environment jsdom

/**
 * 独立资料列表页视觉边界（PR5 整页视觉计划 20260929 校准；替代 2026-09-23 的
 * 「只对齐表格局部、不启用整页变体」旧结论）。
 *
 * 新口径：
 * - 本页是**精确列表路由**，按新决策对齐 `gkj.html#knowledge-base-page` 的整页骨架：
 *   页面根挂 `reference-library-page`、页头走 `reference-library` 变体、工作区由 AppLayout 的
 *   `app-workspace--reference-library` 精确路由 modifier 开启（不在本组件内判定）。
 * - 但**仍然不得**出现 PR3 的五类整页 kb modifier（`.kb-page` / `.kb-card` / `.page-header--kb` /
 *   `.app-workspace--knowledge-base` / `.app-main--knowledge-base`）：两个路由取值同源、类名
 *   互不借用，契约见 frontend/docs/gkj-visual-baseline.md 第 6 节。
 * - 列表局部继续用 `reference-library-*` 窄职责作用域消费同一视觉 Token，不复用 `.kb-*` 壳类。
 *
 * 本文件固定三层契约：
 * 1. 结构契约：精确列表路由拥有独立 reference-library 变体，且不借用知识库整页变体；
 * 2. 汇总条契约（PR5 整页计划 S3）：三列取值必须来自真实状态源（列表 total / 类型枚举 /
 *    型号 query 状态），不出现固定演示数字与原型演示字段；
 * 3. 角色矩阵（S3-2）：新增入口属**页面页头主操作区**，仅 SUPER_ADMIN 渲染；ENGINEER 不渲染，
 *    列表本体（feature 组件）对两个角色渲染完全一致，不自行判定角色。
 *
 * 数据层由共享 GraphQL 入口 `@/shared/graphql` 的 `executeGraphQL` 桩提供（页面层不允许
 * 深层 import feature 内部 adapter）；列表状态机与展示结构仍由生产组件决定，测试不复制规则。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReferenceDocumentsPage } from './index';

const { executeGraphQLMock, navigateMock, sessionMock } = vi.hoisted(() => ({
  executeGraphQLMock: vi.fn(),
  navigateMock: vi.fn(),
  /** 角色矩阵可变量：用例内改写后重新渲染即可切换页面层判定结果 */
  sessionMock: { role: 'ENGINEER' as 'ENGINEER' | 'SUPER_ADMIN' },
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    useAuthSession: () => ({
      session: { accountId: 900102, role: sessionMock.role, userInfo: null },
      status: 'authenticated',
    }),
  };
});

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/graphql')>();

  return { ...actual, executeGraphQL: executeGraphQLMock };
});

/** 按 adapter 发出的 query 文本分发最小合法响应（型号下拉 + 资料列表） */
function stubGraphQLResponses(): void {
  executeGraphQLMock.mockImplementation((query: string) => {
    if (query.includes('query EquipmentModels')) {
      return Promise.resolve({
        equipmentModels: [
          {
            id: 49,
            modelCode: 'ASML-TWINSCAN-NXT-1980DI',
            modelName: 'ASML TWINSCAN NXT:1980Di',
          },
        ],
      });
    }

    if (query.includes('query ReferenceDocuments')) {
      return Promise.resolve({
        referenceDocuments: {
          items: [
            {
              id: 970001,
              title: '参考资料 970001',
              documentType: 'ERROR_CODE_MANUAL',
              equipmentModelId: 49,
              equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
              description: '说明文本',
              originalFilename: null,
              creatorNickname: '系统管理员',
              createdAt: '2026-08-10T08:00:00.000Z',
            },
          ],
          page: 1,
          pageSize: 10,
          total: 1,
        },
      });
    }

    return Promise.reject(new Error(`未登记的 GraphQL 请求：${query.slice(0, 60)}`));
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
  navigateMock.mockReset();
  sessionMock.role = 'ENGINEER';
  stubGraphQLResponses();
});

/** PR3 回归探针 `kbVariantNodes` 的同一集合：整页知识库 modifier，独立资料页必须为 0。 */
const PAGE_LEVEL_KB_MODIFIERS = [
  '.kb-page',
  '.kb-card',
  '.page-header--kb',
  '.app-workspace--knowledge-base',
  '.app-main--knowledge-base',
] as const;

describe('独立资料列表页的整页骨架与知识库视觉边界（PR5 整页视觉计划）', () => {
  it('页面根与页头走 reference-library 变体：五类整页 kb modifier 计数仍为 0', async () => {
    const { container } = render(<ReferenceDocumentsPage />);

    await screen.findByText('参考资料 970001');

    // 新变体落点：页面根 + 页头（工作区 modifier 由 AppLayout 精确路由负责，见 app-layout.spec.tsx）
    expect(container.querySelector('.reference-library-page')).not.toBeNull();
    expect(container.querySelector('.page-header--reference-library')).not.toBeNull();

    for (const selector of PAGE_LEVEL_KB_MODIFIERS) {
      expect(container.querySelector(selector), `${selector} 不应出现在独立资料页`).toBeNull();
    }
  });

  it('列表局部改用 reference-library-* 作用域对齐知识库表格，而非复用 .kb-* 壳类', async () => {
    const { container } = render(<ReferenceDocumentsPage />);

    await screen.findByText('参考资料 970001');

    // 局部表格作用域：S3 的落点（先红后绿，S3-1 已转绿）。
    expect(container.querySelector('.reference-library-table-scope')).not.toBeNull();
    // 同一位置上不得沿用知识库壳类，否则即为“变体泄露到独立资料页”。
    expect(container.querySelector('.kb-table-scope')).toBeNull();
    expect(container.querySelector('.kb-card')).toBeNull();
  });

  // PR5 整页计划 S0-6 / S3-2：汇总条三项必须来自真实状态源（列表 total / 类型枚举 / 型号 query），
  // 不得出现固定演示数字、Embedding Model、向量化等原型演示字段。
  it('真实汇总条：三项分别取自列表 total、后端类型枚举与型号 query，且不含演示字段', async () => {
    const { container } = render(<ReferenceDocumentsPage />);

    await screen.findByText('参考资料 970001');

    const summary = container.querySelector('.reference-library-summary');
    expect(summary).not.toBeNull();

    const cells = summary!.querySelectorAll('.reference-library-summary-cell');
    expect(cells.length).toBe(3);

    const [totalCell, typesCell, modelsCell] = Array.from(cells);
    // 1) 参考资料 = 列表状态机的 total（桩里 total=1，落在页头之外的独立单元格）
    expect(totalCell.querySelector('.reference-library-summary-label')?.textContent).toBe(
      '参考资料',
    );
    expect(totalCell.querySelector('.reference-library-summary-value')?.textContent).toBe(
      '共 1 条',
    );
    // 2) 支持类型 = 后端契约枚举的真实集合
    expect(typesCell.querySelector('.reference-library-summary-label')?.textContent).toBe(
      '支持类型',
    );
    expect(typesCell.querySelector('.reference-library-summary-value')?.textContent).toContain(
      '错误代码手册',
    );
    // 3) 适用型号 = 型号 query 的真实条数（桩里 1 条）
    expect(modelsCell.querySelector('.reference-library-summary-label')?.textContent).toBe(
      '适用型号',
    );
    expect(modelsCell.querySelector('.reference-library-summary-value')?.textContent).toBe(
      '1 个型号',
    );

    // 禁止原型演示字段
    const summaryText = summary!.textContent ?? '';
    for (const forbidden of ['Embedding', '向量化', '分块', '参与检索', 'Batch Actions']) {
      expect(summaryText, `汇总条不得出现演示字段 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('任务 07：页头不再渲染任何写入入口', () => {
  it.each(['ENGINEER', 'SUPER_ADMIN'] as const)(
    '%s 角色均无新增入口，页头动作区为空',
    async (role) => {
      sessionMock.role = role;

      const { container } = render(<ReferenceDocumentsPage />);
      await screen.findByText('参考资料 970001');

      expect(screen.queryByRole('button', { name: /新增资料/ })).toBeNull();
      expect(container.querySelector('.page-header-extra')).toBeNull();
      expect(container.querySelector('.ant-card-extra')).toBeNull();
      expect(navigateMock).not.toHaveBeenCalled();
    },
  );
});
