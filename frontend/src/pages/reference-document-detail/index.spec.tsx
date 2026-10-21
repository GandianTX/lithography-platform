// src/pages/reference-document-detail/index.spec.tsx
// @vitest-environment jsdom

/**
 * 参考资料详情页（/reference-documents/:documentId）页面级单测（PR5 S4-5）。
 *
 * 页面职责边界：路由参数解析（合法正整数才注入面板）+ 角色判定（精确 SUPER_ADMIN 才放行
 * 编辑/软删）+ 页头装配；面板内部状态机、NOT_FOUND 归一与下载链路由 feature 自身 spec 覆盖，
 * 本文件不复制其规则。
 *
 * 非法参数（abc / 0 / 负数 / 小数 / 空 / 未提供 / 超出安全整数）必须在页面层被拦下：
 * 呈现统一 not-found 文案，且**不得发出任何 GraphQL 请求**——非法值直接进 Int! 变量会成为
 * 输入/序列化错误，被归入 failed 态从而出现「重试仍失败」的死循环入口（负责人 0909 修复要求）。
 * 为防止「不发请求」断言恒真（页面若不发任何请求则非法参数用例与合法参数用例同时通过），
 * 本文件配对保留一条合法参数正例，钉住「合法 ID 确实会发起详情查询」。
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceDocumentDetail } from '@/features/reference-document';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import { ReferenceDocumentDetailPage } from './index';

const { executeGraphQLMock, navigateMock, paramsMock, sessionMock } = vi.hoisted(() => ({
  executeGraphQLMock: vi.fn(),
  navigateMock: vi.fn(),
  /** 路由参数可变量：用例内改写后重新渲染即可切换「合法 / 非法 ID」 */
  paramsMock: { documentId: '970002' as string | undefined },
  /** 角色矩阵可变量：用例内改写后重新渲染即可切换页面层判定结果 */
  sessionMock: { role: 'ENGINEER' as 'ENGINEER' | 'SUPER_ADMIN' },
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock, useParams: () => paramsMock };
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

const DETAIL_ID = 970002;

function buildDetail(id: number): ReferenceDocumentDetail {
  return {
    id,
    title: 'NXE:3400C 光源维护指南（页面级 Mock）',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: 51,
    equipmentModelName: 'ASML TWINSCAN NXE:3400C',
    equipmentModelText: null,
    description: '光源模块周期性维护要点。',
    originalFilename: 'nxe-3400c-source-guide-mock.pdf',
    mimeType: 'application/pdf',
    hasFile: true,
    contentText: '# 光源维护指南',
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseDetail: null,
    creatorNickname: '陈工',
    createdAt: '2026-08-02T09:30:00.000Z',
    updatedAt: '2026-08-05T14:00:00.000Z',
  };
}

/** 按 adapter 发出的 query 文本分发最小合法响应（本页只发详情查询） */
function stubGraphQLResponses(): void {
  executeGraphQLMock.mockImplementation((query: string) => {
    if (query.includes('query ReferenceDocument(')) {
      return Promise.resolve({ referenceDocument: buildDetail(DETAIL_ID) });
    }

    return Promise.reject(new Error(`未登记的 GraphQL 请求：${query.slice(0, 60)}`));
  });
}

/**
 * 渲染页面。
 *
 * 详情面板经 `useMessageFeedback()` 消费反馈端口（下载失败等），Provider 是必要装配条件，
 * 故测试走真实 Provider wrapper，而不是让缺失 Provider 的装配回归假绿。
 */
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
  sessionMock.role = 'ENGINEER';
  stubGraphQLResponses();
});

describe('参考资料详情页：合法参数与查询发起', () => {
  it('合法正整数参数：发起一次详情查询并按 ID 渲染面板', async () => {
    renderPage();

    expect(screen.getByRole('heading', { name: '参考资料详情' })).toBeTruthy();
    expect(await screen.findByText('NXE:3400C 光源维护指南（页面级 Mock）')).toBeTruthy();

    // 正向锚点：合法 ID 确实发出查询（否则非法参数的「零请求」断言会恒真）
    expect(executeGraphQLMock).toHaveBeenCalledTimes(1);
    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.any(String), { id: DETAIL_ID });
  });
});

describe('参考资料详情页：角色矩阵（编辑/软删入口）', () => {
  it('SUPER_ADMIN：编辑与删除入口可见，下载入口可见', async () => {
    sessionMock.role = 'SUPER_ADMIN';

    renderPage();
    await screen.findByText('NXE:3400C 光源维护指南（页面级 Mock）');

    expect(screen.getByRole('button', { name: /编\s*辑/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /删\s*除/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下载文件/ })).toBeTruthy();
  });

  it('ENGINEER：编辑与删除入口不可见，但下载入口保留（页面可见角色均可下载）', async () => {
    sessionMock.role = 'ENGINEER';

    renderPage();
    await screen.findByText('NXE:3400C 光源维护指南（页面级 Mock）');

    expect(screen.queryByRole('button', { name: /编\s*辑/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删\s*除/ })).toBeNull();
    expect(screen.getByRole('button', { name: /下载文件/ })).toBeTruthy();
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
      // 非法值不得进 Int! 变量（否则会落 failed 态并暴露「重试仍失败」入口）
      expect(executeGraphQLMock).not.toHaveBeenCalled();
      // 防探测态：不给出编辑 / 删除入口，仅提供返回列表
      expect(screen.queryByRole('button', { name: /编\s*辑/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /删\s*除/ })).toBeNull();
    },
  );
});
