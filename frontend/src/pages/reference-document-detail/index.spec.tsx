// src/pages/reference-document-detail/index.spec.tsx
// @vitest-environment jsdom

/**
 * 参考资料详情页（/reference-documents/:documentId）页面级单测（任务 07 改造后）。
 *
 * 页面职责边界：路由参数解析（合法正整数才注入面板）+ 页头装配；
 * 面板内部状态机、NOT_FOUND 归一、历史版本与下载链路由 feature 自身 spec 覆盖。
 *
 * 任务 07 起详情为读取 + 管理入口装配：会话视角（角色/等级）由页面注入面板，
 * 授权由服务端裁决；非法参数不得发出任何 GraphQL 请求。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceDocumentDetail } from '@/features/reference-document';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import { ReferenceDocumentDetailPage } from './index';

const { executeGraphQLMock, navigateMock, paramsMock } = vi.hoisted(() => ({
  executeGraphQLMock: vi.fn(),
  navigateMock: vi.fn(),
  /** 路由参数可变量：用例内改写后重新渲染即可切换「合法 / 非法 ID」 */
  paramsMock: { documentId: '970002' as string | undefined },
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock, useParams: () => paramsMock };
});

vi.mock('@/features/auth-session', () => ({
  // 页面仅消费角色与管理员等级做入口显隐；会话其余能力与本页无关
  useAuthSession: () => ({
    status: 'authenticated',
    session: { role: 'ENGINEER', adminLevel: null },
  }),
}));

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/graphql')>();

  return { ...actual, executeGraphQL: executeGraphQLMock };
});

const DETAIL_ID = 970002;

function buildDetail(id: number): ReferenceDocumentDetail {
  return {
    id,
    title: 'NXE:3400C 光源维护指南（页面级 Mock）',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: 51,
    equipmentModelName: 'ASML TWINSCAN NXE:3400C',
    equipmentModelText: null,
    structuredContent: null,
    description: '光源模块周期性维护要点。',
    originalFilename: 'nxe-3400c-source-guide-mock.pdf',
    mimeType: 'application/pdf',
    hasFile: true,
    contentText: '# 光源维护指南',
    contentSource: 'ORIGINAL',
    sourceKind: 'MATERIAL',
    effectiveRevisionNo: 0,
    sourceReportId: null,
    sourceReportVersionId: null,
    frozenReport: null,
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseDetail: null,
    creatorNickname: '陈工',
    createdAt: '2026-08-02T09:30:00.000Z',
    viewerIsOriginalAuthor: false,
    updatedAt: '2026-08-05T14:00:00.000Z',
  };
}

/** 按 adapter 发出的 query 文本分发最小合法响应（详情 + 历史版本两条只读查询） */
function stubGraphQLResponses(): void {
  executeGraphQLMock.mockImplementation((query: string) => {
    if (query.includes('query ReferenceDocument(')) {
      return Promise.resolve({ referenceDocument: buildDetail(DETAIL_ID) });
    }

    if (query.includes('query ReferenceDocumentRevisions(')) {
      return Promise.resolve({
        referenceDocumentRevisions: {
          documentId: DETAIL_ID,
          currentRevisionNo: 0,
          sourceKind: 'MATERIAL',
          sourceReportVersionId: null,
          revisions: [],
        },
      });
    }

    return Promise.reject(new Error(`未登记的 GraphQL 请求：${query.slice(0, 60)}`));
  });
}

function renderPage() {
  return render(
    <MessageFeedbackProvider>
      <ReferenceDocumentDetailPage />
    </MessageFeedbackProvider>,
  );
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
  navigateMock.mockReset();
  paramsMock.documentId = String(DETAIL_ID);
  stubGraphQLResponses();
});

describe('参考资料详情页：合法参数与只读渲染', () => {
  it('合法正整数参数：发起详情与历史版本查询，渲染只读面板与下载入口', async () => {
    renderPage();

    expect(screen.getByRole('heading', { name: '参考资料详情' })).toBeTruthy();
    expect(await screen.findByText('NXE:3400C 光源维护指南（页面级 Mock）')).toBeTruthy();
    expect(await screen.findByText('历史版本')).toBeTruthy();

    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.any(String), { id: DETAIL_ID });
    expect(screen.getByRole('button', { name: '下载原件' })).toBeTruthy();

    // 任务 07 关闭旧写入口：页面级不再出现编辑 / 删除 / 新增
    expect(screen.queryByRole('button', { name: /编\s*辑/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删\s*除/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '新增资料' })).toBeNull();
  });
});

describe('参考资料详情页：非法路由参数不发请求', () => {
  const ILLEGAL_PARAMS: ReadonlyArray<readonly [label: string, raw: string | undefined]> = [
    ['非数字 abc', 'abc'],
    ['零 0', '0'],
    ['负数 -1', '-1'],
    ['小数 1.5', '1.5'],
    ['空串', ''],
    ['参数缺失（未提供）', undefined],
    ['超出安全整数范围', '9007199254740993'],
    ['前后空格', ' 970002 '],
  ];

  it.each(ILLEGAL_PARAMS)(
    '参数为 %s 时：统一 not-found 文案且零 GraphQL 请求',
    async (_label, raw) => {
      paramsMock.documentId = raw;

      renderPage();

      expect(await screen.findByText('参考资料不存在或不可查看。')).toBeTruthy();
      expect(executeGraphQLMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /编\s*辑/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /删\s*除/ })).toBeNull();
    },
  );
});
