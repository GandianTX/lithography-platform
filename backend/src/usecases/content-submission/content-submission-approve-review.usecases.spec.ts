// src/usecases/content-submission/content-submission-approve-review.usecases.spec.ts
//
// 任务 07 收口（2026-11-20）：投稿审核决定写路径已按确认需求关闭，
// `ReturnContentSubmissionUsecase` / `ApproveContentSubmissionUsecase` 及其上传发布夹具
// 随用例一并移除；本规格只保留审核队列/详情的合法历史读取。

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  CONTENT_SUBMISSION_ERROR,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { GetReviewDetailUsecase } from './get-review-detail.usecase';
import { ListReviewQueueUsecase } from './list-review-queue.usecase';

afterEach(() => {
  jest.restoreAllMocks();
});

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const superAdmin = session(['SUPER_ADMIN'], 900099);

/** 可信组织成员事实替身（甲方默认组织） */
const membership = {
  membershipId: 950001,
  organizationId: 910001,
  organizationCode: 'CLIENT_DEFAULT',
  organizationName: '甲方默认组织',
  organizationKind: 'CLIENT',
  memberRole: 'SUPER_ADMIN',
};

describe('ListReviewQueueUsecase（审核队列）', () => {
  const queuePage = () => ({ items: [], total: 0, page: 1, pageSize: 20 });

  const makeQueryService = () => ({
    listReviewQueue: jest.fn().mockResolvedValue(queuePage()),
  });

  const makeOrganizationContextService = () => ({
    resolveForAccount: jest.fn().mockResolvedValue(membership),
  });

  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();

    const usecase = new ListReviewQueueUsecase(
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    return { usecase, queryService, organizationContextService };
  };

  const queueCommand = (overrides: Record<string, unknown> = {}) => ({
    session: superAdmin,
    pagination: { mode: 'OFFSET' as const, page: 1, pageSize: 20 },
    ...overrides,
  });

  it('默认待审队列：status 缺省按 PENDING_REVIEW，本组织范围单过滤', async () => {
    const { usecase, queryService } = makeUsecase();

    const result = await usecase.execute(queueCommand());

    expect(queryService.listReviewQueue).toHaveBeenCalledWith({
      ownerOrganizationId: 910001,
      filter: { title: undefined, submissionKind: undefined, status: 'PENDING_REVIEW' },
      pagination: { page: 1, pageSize: 20, withTotal: false },
    });
    expect(result).toEqual(queuePage());
  });

  it('显式筛选：标题词 trim、类别与状态透传', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute(
      queueCommand({
        filter: { title: ' 手册 ', submissionKind: 'MATERIAL', status: 'RETURNED' },
      }),
    );

    expect(queryService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { title: '手册', submissionKind: 'MATERIAL', status: 'RETURNED' },
      }),
    );
  });

  it('空白状态筛选视为未提供：仍按默认待审', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute(queueCommand({ filter: { status: '   ' } }));

    expect(queryService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ status: 'PENDING_REVIEW' }),
      }),
    );
  });

  it('非法状态值：INVALID_PARAMS 且不触发查询', async () => {
    const { usecase, queryService } = makeUsecase();

    await expect(
      usecase.execute(queueCommand({ filter: { status: 'UNKNOWN' } })),
    ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });
    expect(queryService.listReviewQueue).not.toHaveBeenCalled();
  });

  it('工程师账号不能使用审核功能：不触发组织解析与查询', async () => {
    const { usecase, queryService, organizationContextService } = makeUsecase();

    await expect(usecase.execute(queueCommand({ session: engineer }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.listReviewQueue).not.toHaveBeenCalled();
  });

  it('非 OFFSET 分页：INVALID_PARAMS', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute(queueCommand({ pagination: { mode: 'CURSOR' as const } })),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
  });

  it('页大小超过上限收敛为 100，页码下限为 1', async () => {
    const { usecase, queryService } = makeUsecase();

    await usecase.execute(
      queueCommand({
        pagination: { mode: 'OFFSET' as const, page: 0, pageSize: 500, withTotal: true },
      }),
    );

    expect(queryService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { page: 1, pageSize: 100, withTotal: true } }),
    );
  });
});

describe('GetReviewDetailUsecase（审核详情）', () => {
  const reviewDetail = (overrides: Record<string, unknown> = {}) => ({
    submissionId: 970001,
    submissionKind: 'MATERIAL',
    status: 'PENDING_REVIEW',
    currentRevisionNo: 1,
    lastSubmittedAt: new Date('2026-02-01T10:00:00.000Z'),
    submittedByAccountId: 900001,
    currentRevision: null,
    reviewHistory: [],
    ...overrides,
  });

  const makeQueryService = () => ({
    findSubmissionAccessFacts: jest
      .fn()
      .mockResolvedValue({ submittedByAccountId: 900001, ownerOrganizationId: 910001 }),
    findReviewDetail: jest.fn().mockResolvedValue(reviewDetail()),
  });

  const makeOrganizationContextService = () => ({
    resolveForAccount: jest.fn().mockResolvedValue(membership),
  });

  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();

    const usecase = new GetReviewDetailUsecase(
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
    );

    return { usecase, queryService, organizationContextService };
  };

  it('本组织管理员读取详情：完整视图透传', async () => {
    const { usecase, queryService } = makeUsecase();

    const result = await usecase.execute({ session: superAdmin, submissionId: 970001 });

    expect(queryService.findReviewDetail).toHaveBeenCalledWith({ submissionId: 970001 });
    expect(result).toEqual(reviewDetail());
  });

  it('跨组织投稿：统一 NOT_FOUND（不区分不存在）', async () => {
    const queryService = makeQueryService();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce({
      submittedByAccountId: 900001,
      ownerOrganizationId: 910002,
    });
    const { usecase, queryService: queryServiceRef } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryServiceRef.findReviewDetail).not.toHaveBeenCalled();
  });

  it('投稿不存在：统一 NOT_FOUND', async () => {
    const queryService = makeQueryService();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(null);
    const { usecase } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
  });

  it('工程师账号不能使用审核功能：不触发组织解析与读取', async () => {
    const { usecase, queryService, organizationContextService } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(queryService.findSubmissionAccessFacts).not.toHaveBeenCalled();
  });

  it('投稿 ID 非法：INVALID_PARAMS', async () => {
    const { usecase } = makeUsecase();

    await expect(usecase.execute({ session: superAdmin, submissionId: 0 })).rejects.toMatchObject({
      code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS,
    });
  });

  it('访问事实存在而详情缺失：NOT_FOUND（并发删除防御）', async () => {
    const queryService = makeQueryService();
    queryService.findReviewDetail.mockResolvedValueOnce(null);
    const { usecase } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
  });
});
