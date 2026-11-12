// src/usecases/admin-document-database/get-admin-ai-report-detail.usecase.spec.ts

import { ADMIN_DOCUMENT_DATABASE_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiReportDetailQueryResult } from '@src/modules/lithography/admin-document-database.types';
import type { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { GetAdminAiReportDetailUsecase } from './get-admin-ai-report-detail.usecase';

/**
 * PR3 S4：管理员 AI 报告详情用例单测（只读正文，无任何写能力）。
 *
 * 用例层语义：授权先行 → 动态 ID 校验先行 → NOT_FOUND 原样冒泡 → 富集剥离账号 ID。
 * 既有 (conversationId, reportType) 唯一约束只复用不修改（本用例无写路径）。
 */
describe('GetAdminAiReportDetailUsecase', () => {
  const detailResult = {
    id: 550001,
    requestId: 880001,
    requestNo: 'RR-20260901-001',
    requestMismatch: false,
    conversationId: 660001,
    engineerAccountId: 900002,
    reportTitle: '诊断报告',
    reportType: 'DIAGNOSIS',
    contentMd: '# 报告正文',
    createdAt: new Date('2026-09-02T10:30:00.000Z'),
  } as unknown as AdminAiReportDetailQueryResult;

  const adminAiReportQueryService = {
    findDetailById: jest.fn().mockResolvedValue(detailResult),
  } as unknown as AdminAiReportQueryService;

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map([[900002, '陈工程师']])),
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 12 }),
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new GetAdminAiReportDetailUsecase(
    adminAiReportQueryService,
    accountQueryService,
    organizationContextService,
  );

  beforeEach(() => {
    (adminAiReportQueryService.findDetailById as jest.Mock)
      .mockClear()
      .mockResolvedValue(detailResult);
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockClear().mockResolvedValue(1);
    (accountQueryService.findNicknamesByAccountIds as jest.Mock)
      .mockClear()
      .mockResolvedValue(new Map([[900002, '陈工程师']]));
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，报告查询与账户富集均不触发（要求 2）',
    async ({ session }) => {
      const error = (await captureThrownError(usecase.execute({ session, reportId: 550001 }))) as {
        code?: string;
      };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(adminAiReportQueryService.findDetailById).not.toHaveBeenCalled();
      expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
    },
  );

  it('SUPER_ADMIN 读取详情：正文与工程师昵称可见，账号 ID 不外泄', async () => {
    const view = await usecase.execute({
      session: createSuperAdminSession(),
      reportId: 550001,
    });

    expect(view).toMatchObject({
      id: 550001,
      reportTitle: '诊断报告',
      contentMd: '# 报告正文',
      engineerNickname: '陈工程师',
    });
    expect(view).not.toHaveProperty('engineerAccountId');
  });

  it('一级管理员全范围，二级管理员只按可信组织读取报告详情', async () => {
    await usecase.execute({ session: createSuperAdminSession(), reportId: 550001 });
    expect(adminAiReportQueryService.findDetailById).toHaveBeenLastCalledWith(550001, undefined);

    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);
    await usecase.execute({ session: createSuperAdminSession(), reportId: 550001 });
    expect(adminAiReportQueryService.findDetailById).toHaveBeenLastCalledWith(550001, 12);
  });

  it.each([0, -1, 1.5])('reportId %j 非法时在查询前拒绝', async (reportId) => {
    const error = (await captureThrownError(
      usecase.execute({ session: createSuperAdminSession(), reportId }),
    )) as { code?: string };

    expect(error.code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS);
    expect(adminAiReportQueryService.findDetailById).not.toHaveBeenCalled();
  });

  it('NOT_FOUND（不存在统一口径）原样冒泡且不富集', async () => {
    const domainError = Object.assign(new Error('AI 报告不存在或不可访问'), {
      name: 'DomainError',
      code: ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND,
    });
    (adminAiReportQueryService.findDetailById as jest.Mock).mockRejectedValue(domainError);

    const error = (await captureThrownError(
      usecase.execute({ session: createSuperAdminSession(), reportId: 550001 }),
    )) as { code?: string };

    expect(error.code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
  });
});
