// src/features/content-submission/infrastructure/content-submission-adapter.spec.ts

/**
 * 内容投稿真实 GraphQL adapter 单测（A-PR0 §4.1 九操作）。
 *
 * vi.mock 保留真实错误类，只替换 executeGraphQL；断言错误映射走
 * extensions.code 大类码主信号 + extensions.errorCode 可选细化（仅型号不存在），
 * 并覆盖生产环境隐藏 errorCode / errorMessage 的退化场景与读取链路
 * not-found 防探测归并（契约见 backend/docs/api/graphql-error-contract-current.md）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sharedGraphql from '@/shared/graphql';
import { GraphQLIngressError } from '@/shared/graphql';

import {
  createContentSubmissionDraft,
  fetchContentSubmissionRevision,
  fetchMyContentSubmission,
  fetchMyContentSubmissions,
  fetchReviewContentSubmission,
  fetchReviewContentSubmissions,
  reviewContentSubmissionDecision,
  submitContentSubmission,
  updateContentSubmissionDraft,
} from './content-submission-adapter';

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGraphql>();

  return {
    ...actual,
    executeGraphQL: vi.fn(),
  };
});

const executeGraphQLMock = vi.mocked(sharedGraphql.executeGraphQL);

function buildDomainIngressError(options: {
  code: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  return new GraphQLIngressError({
    type: 'graphql',
    message: options.errorMessage ?? '请求处理失败。',
    graphqlErrors: [
      {
        message: options.errorMessage ?? '请求处理失败。',
        extensions: {
          code: options.code,
          ...(options.errorCode ? { errorCode: options.errorCode } : {}),
          ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
        },
      },
    ],
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

const listItem = {
  id: 501,
  title: '投稿标题',
  submissionKind: 'MATERIAL',
  status: 'DRAFT',
  currentRevisionNo: null,
  lastSubmittedAt: null,
  updatedAt: '2026-10-01T08:00:00.000Z',
  createdAt: '2026-10-01T07:00:00.000Z',
};

const listPage = {
  items: [listItem],
  total: 1,
  page: 1,
  pageSize: 10,
};

describe('fetchMyContentSubmissions', () => {
  it('无筛选时只传分页变量，不携带 filter', async () => {
    executeGraphQLMock.mockResolvedValue({ myContentSubmissions: listPage });

    await expect(fetchMyContentSubmissions({ page: 1, pageSize: 10 })).resolves.toEqual(listPage);
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('myContentSubmissions'),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
      },
    );
  });

  it('筛选变量按契约字段映射：titleKeyword → title，空白搜索词视为无筛选', async () => {
    executeGraphQLMock.mockResolvedValue({ myContentSubmissions: listPage });

    await fetchMyContentSubmissions(
      { page: 2, pageSize: 10 },
      { titleKeyword: '  干涉仪  ', submissionKind: 'FAULT_CASE', status: 'RETURNED' },
    );

    expect(executeGraphQLMock).toHaveBeenLastCalledWith(expect.any(String), {
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true },
      filter: { title: '干涉仪', submissionKind: 'FAULT_CASE', status: 'RETURNED' },
    });

    await fetchMyContentSubmissions({ page: 1, pageSize: 10 }, { titleKeyword: '   ' });

    expect(executeGraphQLMock).toHaveBeenLastCalledWith(expect.any(String), {
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('后端 total 可空字段缺失时兜底为 0，page/pageSize 兜底为请求值', async () => {
    executeGraphQLMock.mockResolvedValue({
      myContentSubmissions: { items: [], total: null, page: null, pageSize: null },
    });

    await expect(fetchMyContentSubmissions({ page: 3, pageSize: 20 })).resolves.toEqual({
      items: [],
      total: 0,
      page: 3,
      pageSize: 20,
    });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchMyContentSubmissions({ page: 1, pageSize: 10 })).rejects.toBe(networkError);
  });
});

describe('fetchMyContentSubmission', () => {
  const mineDetail = {
    id: 501,
    submissionKind: 'MATERIAL',
    status: 'PENDING_REVIEW',
    currentRevisionNo: 2,
    lastSubmittedAt: '2026-10-02T09:00:00.000Z',
    publishedAt: null,
    material: {
      title: '材料标题',
      documentType: 'CHECKLIST',
      equipmentModelId: null,
      equipmentModelName: null,
      equipmentModelText: '手填机型',
      description: null,
      contentText: '正文',
    },
    faultCase: null,
    currentAttachment: null,
    latestReview: null,
    publishedDocument: { documentId: 970088, available: true },
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
  };

  it('成功返回本人投稿详情（材料类别 faultCase 为 null 原样穿透）', async () => {
    executeGraphQLMock.mockResolvedValue({ myContentSubmission: mineDetail });

    await expect(fetchMyContentSubmission(501)).resolves.toEqual({
      ok: true,
      detail: mineDetail,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('myContentSubmission'),
      {
        id: 501,
      },
    );
  });

  it('NOT_FOUND（不存在 / 他人投稿 / 跨组织统一口径）归并 not-found；errorMessage 优先', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'NOT_FOUND',
        errorCode: 'CONTENT_SUBMISSION_NOT_FOUND',
        errorMessage: '投稿不存在或不可查看。',
      }),
    );

    await expect(fetchMyContentSubmission(501)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '投稿不存在或不可查看。',
    });
  });

  it('FORBIDDEN（守卫拒绝）同详情读取既有契约归并 not-found，不泄露存在性', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({ code: 'FORBIDDEN', errorCode: 'INSUFFICIENT_PERMISSIONS' }),
    );

    await expect(fetchMyContentSubmission(501)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
      message: '投稿不存在或不可查看。',
    });
  });

  it('生产隐藏 errorCode/errorMessage 时仍按大类码归并并落兜底文案', async () => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code: 'NOT_FOUND' }));

    await expect(fetchMyContentSubmission(501)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '投稿不存在或不可查看。',
    });
  });

  it('transport 失败不归并为业务拒绝，仍上抛', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchMyContentSubmission(501)).rejects.toBe(networkError);
  });
});

describe('fetchContentSubmissionRevision', () => {
  const revision = {
    revisionId: 9001,
    submissionId: 501,
    submissionKind: 'MATERIAL',
    revisionNo: 2,
    schemaVersion: 1,
    titleSnapshot: '材料标题',
    payloadSnapshot: { title: '材料标题' },
    attachment: null,
    noticeVersion: 1,
    confirmedAt: '2026-10-02T08:59:00.000Z',
    submittedAt: '2026-10-02T09:00:00.000Z',
    review: null,
  };

  it('成功返回冻结版本', async () => {
    executeGraphQLMock.mockResolvedValue({ contentSubmissionRevision: revision });

    await expect(fetchContentSubmissionRevision(501, 2)).resolves.toEqual({
      ok: true,
      revision,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('contentSubmissionRevision'),
      { submissionId: 501, revisionNo: 2 },
    );
  });

  it('NOT_FOUND（非授权范围统一口径）归并 not-found', async () => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code: 'NOT_FOUND' }));

    await expect(fetchContentSubmissionRevision(501, 2)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '该版本不存在或不可查看。',
    });
  });

  it('transport 失败不归并为业务拒绝，仍上抛', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchContentSubmissionRevision(501, 2)).rejects.toBe(networkError);
  });
});

describe('fetchReviewContentSubmissions', () => {
  it('审核队列复用同一筛选映射（类别 / 状态等值）', async () => {
    executeGraphQLMock.mockResolvedValue({ reviewContentSubmissions: listPage });

    await fetchReviewContentSubmissions(
      { page: 1, pageSize: 10 },
      { submissionKind: 'FAULT_CASE', status: 'PENDING_REVIEW' },
    );

    expect(executeGraphQLMock).toHaveBeenLastCalledWith(
      expect.stringContaining('reviewContentSubmissions'),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
        filter: { submissionKind: 'FAULT_CASE', status: 'PENDING_REVIEW' },
      },
    );
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchReviewContentSubmissions({ page: 1, pageSize: 10 })).rejects.toBe(
      networkError,
    );
  });
});

describe('fetchReviewContentSubmission', () => {
  const reviewDetail = {
    submissionId: 501,
    submissionKind: 'FAULT_CASE',
    status: 'PENDING_REVIEW',
    currentRevisionNo: 2,
    lastSubmittedAt: '2026-10-02T09:00:00.000Z',
    submittedByAccountId: 1002,
    currentRevision: { revisionId: 9001, revisionNo: 2 },
    reviewHistory: [],
  };

  it('成功返回审核详情（含提交账号展示用 ID）', async () => {
    executeGraphQLMock.mockResolvedValue({ reviewContentSubmission: reviewDetail });

    await expect(fetchReviewContentSubmission(501)).resolves.toEqual({
      ok: true,
      detail: reviewDetail,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('reviewContentSubmission'),
      { id: 501 },
    );
  });

  it('FORBIDDEN（非本组织管理员）归并 not-found，不泄露存在性', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({ code: 'FORBIDDEN', errorCode: 'ACCESS_DENIED' }),
    );

    await expect(fetchReviewContentSubmission(501)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '投稿不存在或不可查看。',
    });
  });

  it('transport 失败不归并为业务拒绝，仍上抛', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchReviewContentSubmission(501)).rejects.toBe(networkError);
  });
});

describe('createContentSubmissionDraft', () => {
  const input = { kind: 'MATERIAL' as const, fields: { title: '材料标题' } };

  it('创建成功返回保存状态', async () => {
    executeGraphQLMock.mockResolvedValue({
      createContentSubmissionDraft: {
        id: 501,
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
        updatedAt: '2026-10-01T08:00:00.000Z',
      },
    });

    await expect(createContentSubmissionDraft(input)).resolves.toEqual({
      ok: true,
      id: 501,
      submissionKind: 'MATERIAL',
      status: 'DRAFT',
      updatedAt: '2026-10-01T08:00:00.000Z',
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('createContentSubmissionDraft'),
      { input },
    );
  });

  it.each([
    [
      'NOT_FOUND（create 的唯一来源是型号不存在）',
      { code: 'NOT_FOUND', errorCode: 'CONTENT_SUBMISSION_EQUIPMENT_MODEL_NOT_FOUND' },
      'model-not-found',
      '所选设备型号不存在，请重新选择。',
    ],
    [
      'BAD_USER_INPUT',
      { code: 'BAD_USER_INPUT', errorCode: 'CONTENT_SUBMISSION_INVALID_PARAMS' },
      'invalid-input',
      '输入不符合要求，请检查后重新提交。',
    ],
    [
      'FORBIDDEN（守卫拒绝）',
      { code: 'FORBIDDEN', errorCode: 'INSUFFICIENT_PERMISSIONS' },
      'forbidden',
      '当前账号没有执行该操作的权限。',
    ],
    [
      '生产隐藏 errorCode 的大类码退化',
      { code: 'INTERNAL_SERVER_ERROR' },
      'operation-failed',
      '操作失败，请稍后重试。',
    ],
  ])('%s → %s', async (_name, extensions, reason, fallback) => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({ ...extensions, errorMessage: '后端业务消息' }),
    );

    // errorMessage 存在时优先展示后端业务消息
    await expect(createContentSubmissionDraft(input)).resolves.toEqual({
      ok: false,
      reason,
      message: '后端业务消息',
    });

    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    // errorMessage 缺失时落前端兜底文案
    await expect(createContentSubmissionDraft(input)).resolves.toEqual({
      ok: false,
      reason,
      message: fallback,
    });
  });

  it('未映射大类码（UNAUTHENTICATED 鉴权失效）不吞为业务拒绝，仍上抛', async () => {
    const unauthenticated = buildDomainIngressError({ code: 'UNAUTHENTICATED' });
    executeGraphQLMock.mockRejectedValue(unauthenticated);

    await expect(createContentSubmissionDraft(input)).rejects.toBe(unauthenticated);
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(createContentSubmissionDraft(input)).rejects.toBe(networkError);
  });
});

describe('updateContentSubmissionDraft', () => {
  const patch = { title: '改名后的标题' };

  it('保存成功返回真实保存状态；变量形状为 { id, input: { patch } }', async () => {
    executeGraphQLMock.mockResolvedValue({
      updateContentSubmissionDraft: {
        id: 501,
        submissionKind: 'MATERIAL',
        status: 'DRAFT',
        updatedAt: '2026-10-03T08:00:00.000Z',
      },
    });

    await expect(updateContentSubmissionDraft(501, patch)).resolves.toEqual({
      ok: true,
      id: 501,
      submissionKind: 'MATERIAL',
      status: 'DRAFT',
      updatedAt: '2026-10-03T08:00:00.000Z',
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('updateContentSubmissionDraft'),
      { id: 501, input: { patch } },
    );
  });

  it.each([
    [
      'NOT_FOUND 默认归并（投稿不存在 / 非本人）',
      { code: 'NOT_FOUND', errorCode: 'CONTENT_SUBMISSION_NOT_FOUND' },
      'not-found',
    ],
    [
      'NOT_FOUND 细化为型号不存在',
      { code: 'NOT_FOUND', errorCode: 'CONTENT_SUBMISSION_EQUIPMENT_MODEL_NOT_FOUND' },
      'model-not-found',
    ],
    ['生产隐藏 errorCode 时大类码退化为 not-found（不误判）', { code: 'NOT_FOUND' }, 'not-found'],
    [
      'BAD_USER_INPUT（草稿空 / 字段非法）',
      { code: 'BAD_USER_INPUT', errorCode: 'CONTENT_SUBMISSION_DRAFT_EMPTY' },
      'invalid-input',
    ],
    [
      'CONFLICT（状态不允许编辑）',
      { code: 'CONFLICT', errorCode: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE' },
      'state-conflict',
    ],
    [
      'FORBIDDEN（守卫拒绝）',
      { code: 'FORBIDDEN', errorCode: 'INSUFFICIENT_PERMISSIONS' },
      'forbidden',
    ],
    [
      '落库失败（系统侧）',
      { code: 'INTERNAL_SERVER_ERROR', errorCode: 'CONTENT_SUBMISSION_UPDATE_FAILED' },
      'operation-failed',
    ],
  ])('%s → %s', async (_name, extensions, reason) => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    await expect(updateContentSubmissionDraft(501, patch)).resolves.toMatchObject({
      ok: false,
      reason,
    });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(updateContentSubmissionDraft(501, patch)).rejects.toBe(networkError);
  });
});

describe('submitContentSubmission', () => {
  const input = { libraryNoticeConfirmed: true };

  it('送审成功返回版本号与状态', async () => {
    executeGraphQLMock.mockResolvedValue({
      submitContentSubmission: {
        submissionId: 501,
        revisionId: 9002,
        revisionNo: 3,
        status: 'PENDING_REVIEW',
      },
    });

    await expect(submitContentSubmission(501, input)).resolves.toEqual({
      ok: true,
      submissionId: 501,
      revisionId: 9002,
      revisionNo: 3,
      status: 'PENDING_REVIEW',
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('submitContentSubmission'),
      { id: 501, input },
    );
  });

  it.each([
    [
      '完整性不足 / 未确认入库告知',
      { code: 'BAD_USER_INPUT', errorCode: 'CONTENT_SUBMISSION_DRAFT_EMPTY' },
      'invalid-input',
    ],
    [
      'CONFLICT（状态不允许重提）',
      { code: 'CONFLICT', errorCode: 'CONTENT_SUBMISSION_STATE_NOT_EDITABLE' },
      'state-conflict',
    ],
    ['NOT_FOUND（投稿不存在 / 非本人）', { code: 'NOT_FOUND' }, 'not-found'],
  ])('%s → %s', async (_name, extensions, reason) => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    await expect(submitContentSubmission(501, input)).resolves.toMatchObject({
      ok: false,
      reason,
    });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(submitContentSubmission(501, input)).rejects.toBe(networkError);
  });
});

describe('reviewContentSubmissionDecision', () => {
  it('通过成功时携带发布资料 ID', async () => {
    executeGraphQLMock.mockResolvedValue({
      reviewContentSubmissionDecision: {
        submissionId: 501,
        status: 'PUBLISHED',
        documentId: 970088,
      },
    });

    await expect(
      reviewContentSubmissionDecision({
        submissionId: 501,
        revisionId: 9002,
        decision: 'APPROVE',
        publishAttachment: true,
      }),
    ).resolves.toEqual({ ok: true, submissionId: 501, status: 'PUBLISHED', documentId: 970088 });
  });

  it('退回成功时 documentId 缺失兜底为 null', async () => {
    executeGraphQLMock.mockResolvedValue({
      reviewContentSubmissionDecision: { submissionId: 501, status: 'RETURNED', documentId: null },
    });

    await expect(
      reviewContentSubmissionDecision({
        submissionId: 501,
        revisionId: 9002,
        decision: 'RETURN',
        comment: '请补充复现步骤',
      }),
    ).resolves.toEqual({ ok: true, submissionId: 501, status: 'RETURNED', documentId: null });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('reviewContentSubmissionDecision'),
      {
        input: {
          submissionId: 501,
          revisionId: 9002,
          decision: 'RETURN',
          comment: '请补充复现步骤',
        },
      },
    );
  });

  it.each([
    ['CONFLICT（版本不符 / 已被审核）', { code: 'CONFLICT' }, 'state-conflict'],
    [
      'BAD_USER_INPUT（退回意见缺失等）',
      { code: 'BAD_USER_INPUT', errorCode: 'CONTENT_SUBMISSION_INVALID_PARAMS' },
      'invalid-input',
    ],
    ['NOT_FOUND（非本组织 / 不存在）', { code: 'NOT_FOUND' }, 'not-found'],
    ['FORBIDDEN（守卫拒绝）', { code: 'FORBIDDEN' }, 'forbidden'],
  ])('%s → %s', async (_name, extensions, reason) => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    await expect(
      reviewContentSubmissionDecision({
        submissionId: 501,
        revisionId: 9002,
        decision: 'APPROVE',
        publishAttachment: false,
      }),
    ).resolves.toMatchObject({ ok: false, reason });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(
      reviewContentSubmissionDecision({
        submissionId: 501,
        revisionId: 9002,
        decision: 'APPROVE',
        publishAttachment: false,
      }),
    ).rejects.toBe(networkError);
  });
});
