// src/features/reference-document/ui/pending-ownership-list.spec.tsx
// @vitest-environment jsdom

/**
 * 归属待核实列表面板单测（任务 07 R061-01）。
 *
 * 覆盖：
 * - 清单渲染 PENDING 条目及现有归属线索（上传者昵称、公司展示名）；
 * - 点击条目进入归属待核实详情路由（与普通资料库详情路由分开）；
 * - 空清单与加载失败（含重试）状态；
 * - 分页：goToPage 触发下一页查询。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceDocumentListPage } from '../infrastructure/reference-document.types';
import * as referenceDocumentAdapter from '../infrastructure/reference-document-adapter';

import { PendingOwnershipReferenceDocumentList } from './pending-ownership-list';

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../infrastructure/reference-document-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentAdapter>();

  return {
    ...actual,
    fetchPendingOwnershipReferenceDocuments: vi.fn(),
  };
});

const navigateMock = vi.fn();
const fetchListMock = vi.mocked(referenceDocumentAdapter.fetchPendingOwnershipReferenceDocuments);

function buildPage(overrides: Partial<ReferenceDocumentListPage> = {}): ReferenceDocumentListPage {
  return {
    items: [
      {
        id: 970101,
        title: '来源不明的维护笔记',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelId: null,
        equipmentModelName: null,
        equipmentModelText: null,
        description: null,
        originalFilename: null,
        organizationName: '未知组织',
        ingestMethod: 'ADMIN_DIRECT',
        sourceKind: 'MATERIAL',
        effectiveRevisionNo: 0,
        caseHandlingStatus: null,
        creatorNickname: '未知用户',
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
    ...overrides,
  };
}

beforeEach(() => {
  fetchListMock.mockReset();
  navigateMock.mockReset();
});

describe('PendingOwnershipReferenceDocumentList（任务 07 R061-01）', () => {
  it('渲染待核实条目与现有归属线索，点击进入待核实详情路由', async () => {
    fetchListMock.mockResolvedValue(buildPage());

    render(<PendingOwnershipReferenceDocumentList />);

    expect(await screen.findByText('来源不明的维护笔记')).toBeTruthy();
    expect(screen.getByText('未知用户')).toBeTruthy();
    expect(screen.getByText('未知组织')).toBeTruthy();
    expect(screen.getByText('共 1 条')).toBeTruthy();

    fireEvent.click(screen.getByText('来源不明的维护笔记'));
    expect(navigateMock).toHaveBeenCalledWith('/admin/reference-ownership/970101');
    // 不发普通资料库查询（专用清单查询）
    expect(fetchListMock).toHaveBeenCalledTimes(1);
  });

  it('空清单：统一空态，不伪造条目', async () => {
    fetchListMock.mockResolvedValue(buildPage({ items: [], total: 0 }));

    render(<PendingOwnershipReferenceDocumentList />);

    expect(await screen.findByText('暂无归属待核实资料。')).toBeTruthy();
  });

  it('加载失败：展示错误消息并支持重试', async () => {
    fetchListMock.mockRejectedValueOnce(new Error('network down'));

    render(<PendingOwnershipReferenceDocumentList />);

    expect(await screen.findByText('归属待核实清单加载失败，请稍后重试。')).toBeTruthy();

    fetchListMock.mockResolvedValue(buildPage());
    fireEvent.click(screen.getByRole('button', { name: '重 试' }));

    expect(await screen.findByText('来源不明的维护笔记')).toBeTruthy();
  });

  it('翻页：goToPage 携带目标页码查询第二页', async () => {
    fetchListMock.mockResolvedValue(
      buildPage({
        total: 12,
        items: Array.from({ length: 10 }, (_, index) => ({
          id: 970100 + index,
          title: `条目 ${index + 1}`,
          documentType: 'MAINTENANCE_GUIDE',
          equipmentModelId: null,
          equipmentModelName: null,
          equipmentModelText: null,
          description: null,
          originalFilename: null,
          organizationName: '未知组织',
          ingestMethod: 'ADMIN_DIRECT',
          sourceKind: 'MATERIAL',
          effectiveRevisionNo: 0,
          caseHandlingStatus: null,
          creatorNickname: '未知用户',
          createdAt: '2026-11-01T00:00:00.000Z',
        })),
      }),
    );

    render(<PendingOwnershipReferenceDocumentList />);

    expect(await screen.findByText('条目 1')).toBeTruthy();

    fetchListMock.mockResolvedValue(
      buildPage({
        page: 2,
        total: 12,
        items: [
          {
            id: 970111,
            title: '条目 11',
            documentType: 'MAINTENANCE_GUIDE',
            equipmentModelId: null,
            equipmentModelName: null,
            equipmentModelText: null,
            description: null,
            originalFilename: null,
            organizationName: '未知组织',
            ingestMethod: 'ADMIN_DIRECT',
            sourceKind: 'MATERIAL',
            effectiveRevisionNo: 0,
            caseHandlingStatus: null,
            creatorNickname: '未知用户',
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      }),
    );
    // AntD 分页项为 li + a 结构（与 reference-document-list.spec 同模式）
    const secondPage = document.querySelector('.ant-pagination-item-2 a') as HTMLElement | null;
    expect(secondPage).toBeTruthy();
    fireEvent.click(secondPage!);

    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith({ page: 2, pageSize: 10 });
    });
    expect(await screen.findByText('条目 11')).toBeTruthy();
  });
});
