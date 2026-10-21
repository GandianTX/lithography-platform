// src/usecases/admin-document-database/get-admin-document-database-stats.usecase.spec.ts

import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import type { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import type { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import type { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  captureThrownError,
  createSuperAdminSession,
  createUnauthorizedSessions,
} from '../../../test/support/account/admin-user.fixture';
import { GetAdminDocumentDatabaseStatsUsecase } from './get-admin-document-database-stats.usecase';

/**
 * PR3 S4：管理员文档数据库统计用例单测。
 *
 * 统计口径与各标签默认列表过滤一致（计划表 S3.3）：维修申请/参考资料不含
 * 软删除，AI 会话/报告计全量；参考资料总数取真实 total（pageSize=1 查询）。
 * A-PR0 §4.3：参考资料统计与资料列表使用相同组织范围（可信组织上下文解析）。
 */
describe('GetAdminDocumentDatabaseStatsUsecase', () => {
  const makeRepairQueryService = () =>
    ({ countAll: jest.fn().mockResolvedValue(3) }) as unknown as AdminRepairRequestQueryService;
  const makeConversationQueryService = () =>
    ({ countAll: jest.fn().mockResolvedValue(7) }) as unknown as AdminAiConversationQueryService;
  const makeReportQueryService = () =>
    ({ countAll: jest.fn().mockResolvedValue(9) }) as unknown as AdminAiReportQueryService;
  const makeReferenceQueryService = () =>
    ({
      listDocuments: jest.fn().mockResolvedValue({
        items: [],
        total: 5,
        page: 1,
        pageSize: 1,
      }),
    }) as unknown as ReferenceDocumentQueryService;
  const makeOrganizationContextService = () =>
    ({
      resolveForAccount: jest.fn().mockResolvedValue({
        membershipId: 950001,
        organizationId: 910001,
        organizationCode: 'CLIENT_DEFAULT',
        organizationName: '甲方默认组织',
        organizationKind: 'CLIENT',
        memberRole: 'ADMIN',
      }),
    }) as unknown as TrustedOrganizationContextQueryService;

  it('四类统计并行聚合：口径与默认列表过滤一致，参考资料统计带本组织范围', async () => {
    const repair = makeRepairQueryService();
    const conversation = makeConversationQueryService();
    const report = makeReportQueryService();
    const reference = makeReferenceQueryService();
    const organizationContext = makeOrganizationContextService();
    const usecase = new GetAdminDocumentDatabaseStatsUsecase(
      repair,
      conversation,
      report,
      reference,
      organizationContext,
    );

    const stats = await usecase.execute({ session: createSuperAdminSession() });

    expect(stats).toEqual({
      repairRequestTotal: 3,
      aiConversationTotal: 7,
      aiReportTotal: 9,
      referenceDocumentTotal: 5,
    });
    // 参考资料：以 pageSize=1 的 withTotal 查询取真实总数，不取当页条数冒充；
    // 组织范围来自可信组织上下文（与资料列表同一口径）
    expect(reference.listDocuments).toHaveBeenCalledWith({
      filter: {},
      pagination: { page: 1, pageSize: 1, withTotal: true },
      organizationId: 910001,
    });
    expect(organizationContext.resolveForAccount).toHaveBeenCalledWith({
      accountId: createSuperAdminSession().accountId,
    });
    expect(repair.countAll).toHaveBeenCalledWith();
    expect(conversation.countAll).toHaveBeenCalledWith();
    expect(report.countAll).toHaveBeenCalledWith();
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，不触发任何统计查询',
    async ({ session }) => {
      const repair = makeRepairQueryService();
      const conversation = makeConversationQueryService();
      const report = makeReportQueryService();
      const reference = makeReferenceQueryService();
      const organizationContext = makeOrganizationContextService();
      const usecase = new GetAdminDocumentDatabaseStatsUsecase(
        repair,
        conversation,
        report,
        reference,
        organizationContext,
      );

      const error = (await captureThrownError(usecase.execute({ session }))) as { code?: string };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      // 要求 2：拒绝路径必须断言各依赖（四类计数/列表）均未被调用，而不只断错误码
      expect(repair.countAll).not.toHaveBeenCalled();
      expect(conversation.countAll).not.toHaveBeenCalled();
      expect(report.countAll).not.toHaveBeenCalled();
      expect(reference.listDocuments).not.toHaveBeenCalled();
      // 组织解析也不应触发：授权拒绝先于组织解析
      expect(organizationContext.resolveForAccount).not.toHaveBeenCalled();
    },
  );
});
