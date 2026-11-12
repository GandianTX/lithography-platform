// src/usecases/admin-document-database/get-admin-repair-request-summary.usecase.spec.ts

import { ADMIN_DOCUMENT_DATABASE_ERROR, PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminRepairRequestSummaryQueryResult } from '@src/modules/lithography/admin-document-database.types';
import type { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { GetAdminRepairRequestSummaryUsecase } from './get-admin-repair-request-summary.usecase';

/**
 * PR3 S4：管理员维修申请摘要用例单测。
 *
 * 用例层语义：授权先行 → 动态 ID 校验先行 → QueryService NOT_FOUND 原样冒泡
 * （不区分「不存在」与「已删除」，防删除状态探测）→ 单条富集剥离账号 ID。
 */
describe('GetAdminRepairRequestSummaryUsecase', () => {
  const summaryResult = {
    id: 880001,
    requestNo: 'RR-20260901-001',
    customerAccountId: 900001,
    equipmentModel: { id: 930001, modelCode: 'M', modelName: 'NXT' },
    errorCode: 'E-001',
    faultDescription: '描述',
    contentMd: '# 正文',
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    isAccepted: false,
    acceptedAt: null,
    acceptedByEngineerAccountId: null,
    latestResolutionStatus: null,
  } as unknown as AdminRepairRequestSummaryQueryResult;

  const adminRepairRequestQueryService = {
    findSummaryById: jest.fn().mockResolvedValue(summaryResult),
  } as unknown as AdminRepairRequestQueryService;

  const accountQueryService = {
    findAccountDisplayInfosByAccountIds: jest
      .fn()
      .mockResolvedValue(new Map([[900001, { nickname: '客户甲', companyName: '甲公司' }]])),
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
  } as unknown as AccountQueryService;

  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 42 }),
  } as unknown as TrustedOrganizationContextQueryService;

  const usecase = new GetAdminRepairRequestSummaryUsecase(
    adminRepairRequestQueryService,
    accountQueryService,
    organizationContextService,
  );

  beforeEach(() => {
    (adminRepairRequestQueryService.findSummaryById as jest.Mock)
      .mockClear()
      .mockResolvedValue(summaryResult);
    (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock)
      .mockClear()
      .mockResolvedValue(new Map([[900001, { nickname: '客户甲', companyName: '甲公司' }]]));
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockClear().mockResolvedValue(1);
    (organizationContextService.resolveForAccount as jest.Mock)
      .mockClear()
      .mockResolvedValue({ organizationId: 42 });
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，摘要查询与账户富集均不触发（要求 2）',
    async ({ session }) => {
      const error = (await captureThrownError(usecase.execute({ session, requestId: 880001 }))) as {
        code?: string;
      };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      expect(adminRepairRequestQueryService.findSummaryById).not.toHaveBeenCalled();
      expect(accountQueryService.findAccountDisplayInfosByAccountIds).not.toHaveBeenCalled();
    },
  );

  it('SUPER_ADMIN 读取摘要：富集展示昵称且账号 ID 不外泄', async () => {
    const view = await usecase.execute({
      session: createSuperAdminSession(),
      requestId: 880001,
    });

    expect(view).toMatchObject({
      id: 880001,
      customerNickname: '客户甲',
      companyName: '甲公司',
      contentMd: '# 正文',
    });
    expect(view).not.toHaveProperty('customerAccountId');
    expect(view).not.toHaveProperty('acceptedByEngineerAccountId');
  });

  it('二级管理员摘要按可信成员组织收敛（跨公司 ID 交由查询层统一 NOT_FOUND）', async () => {
    (accountQueryService.findAdminLevelByAccountId as jest.Mock).mockResolvedValue(2);

    await usecase.execute({ session: createSuperAdminSession(), requestId: 880001 });

    expect(adminRepairRequestQueryService.findSummaryById).toHaveBeenCalledWith(880001, 42);
  });

  it('一级管理员摘要保留全平台范围', async () => {
    await usecase.execute({ session: createSuperAdminSession(), requestId: 880001 });

    expect(adminRepairRequestQueryService.findSummaryById).toHaveBeenCalledWith(880001, undefined);
  });

  it.each([0, -1, 1.5])('requestId %j 非法时在查询前拒绝', async (requestId) => {
    const error = (await captureThrownError(
      usecase.execute({ session: createSuperAdminSession(), requestId }),
    )) as { code?: string };

    expect(error.code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.INVALID_PARAMS);
    expect(adminRepairRequestQueryService.findSummaryById).not.toHaveBeenCalled();
  });

  it('QueryService NOT_FOUND（不存在/已软删统一口径）原样冒泡', async () => {
    const domainError = Object.assign(new Error('维修申请不存在或不可访问'), {
      name: 'DomainError',
      code: ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND,
    });
    (adminRepairRequestQueryService.findSummaryById as jest.Mock).mockRejectedValue(domainError);

    const error = (await captureThrownError(
      usecase.execute({ session: createSuperAdminSession(), requestId: 880001 }),
    )) as { code?: string };

    expect(error.code).toBe(ADMIN_DOCUMENT_DATABASE_ERROR.NOT_FOUND);
    // NOT_FOUND 后不进行富集
    expect(accountQueryService.findAccountDisplayInfosByAccountIds).not.toHaveBeenCalled();
  });
});
