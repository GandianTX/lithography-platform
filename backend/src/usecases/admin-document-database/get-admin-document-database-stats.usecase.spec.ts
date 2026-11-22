// src/usecases/admin-document-database/get-admin-document-database-stats.usecase.spec.ts

import {
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { AdminAiConversationQueryService } from '@src/modules/lithography/queries/admin-ai-conversation.query.service';
import type { AdminAiReportQueryService } from '@src/modules/lithography/queries/admin-ai-report.query.service';
import type { AdminRepairRequestQueryService } from '@src/modules/lithography/queries/admin-repair-request.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { createAdminDocumentDatabaseAccessMocks } from '../../../test/support/account/admin-document-database-access.fixture';
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
 * 2026-11-21 需求调整：资料列表读侧一级管理员为 GLOBAL（功能 V5.6 R055、
 * reference-document-read-scope.ts），统计与列表必须同一口径——一级管理员
 * 资料统计覆盖全部公司正式资料（organizationId: null，不按组织过滤）；
 * 二级管理员仍被全域门槛失败关闭（不触发统计读取）。
 *
 * F1：全域入口先完成「角色 + 当前等级必须 1 + 可信成员事实」，任一项不满足时
 * 四类统计读取与组织解析之外的业务读取一律不发生，不降级为全库统计。
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
        memberRole: 'SUPER_ADMIN',
      }),
    }) as unknown as TrustedOrganizationContextQueryService;

  const makeHarness = () => {
    const access = createAdminDocumentDatabaseAccessMocks();
    const repair = makeRepairQueryService();
    const conversation = makeConversationQueryService();
    const report = makeReportQueryService();
    const reference = makeReferenceQueryService();
    const organizationContext = makeOrganizationContextService();
    const accountQueryService = {
      findAdminLevelByAccountId: access.findAdminLevelByAccountId,
    } as unknown as AccountQueryService;

    const usecase = new GetAdminDocumentDatabaseStatsUsecase(
      repair,
      conversation,
      report,
      reference,
      organizationContext,
      accountQueryService,
    );

    return { access, repair, conversation, report, reference, organizationContext, usecase };
  };

  it('四类统计并行聚合：口径与默认列表过滤一致，参考资料统计覆盖一级管理员全范围', async () => {
    const h = makeHarness();

    const stats = await h.usecase.execute({ session: createSuperAdminSession() });

    expect(stats).toEqual({
      repairRequestTotal: 3,
      aiConversationTotal: 7,
      aiReportTotal: 9,
      referenceDocumentTotal: 5,
    });
    // 参考资料：以 pageSize=1 的 withTotal 查询取真实总数，不取当页条数冒充；
    // 文档数据库为一级管理员全域口径：统计与资料列表读侧（resolveReferenceDocumentReadScope）
    // 同源同口径，只计未软删、已上架、归属已确认，不按本人组织收窄
    expect(h.reference.listDocuments).toHaveBeenCalledWith({
      filter: {},
      pagination: { page: 1, pageSize: 1, withTotal: true },
      scope: { kind: 'GLOBAL' },
    });
    expect(h.organizationContext.resolveForAccount).toHaveBeenCalledWith({
      accountId: createSuperAdminSession().accountId,
    });
    // 等级事实来自当前库读取，而非会话快照
    expect(h.access.findAdminLevelByAccountId).toHaveBeenCalledWith(
      createSuperAdminSession().accountId,
    );
    expect(h.repair.countAll).toHaveBeenCalledWith(null);
    expect(h.conversation.countAll).toHaveBeenCalledWith();
    expect(h.report.countAll).toHaveBeenCalledWith();
  });

  it.each(createUnauthorizedSessions().map(([label, session]) => ({ label, session })))(
    '$label 时授权先行拒绝，不触发任何统计查询',
    async ({ session }) => {
      const h = makeHarness();

      const error = (await captureThrownError(h.usecase.execute({ session }))) as { code?: string };

      expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
      // 要求 2：拒绝路径必须断言各依赖（四类计数/列表）均未被调用，而不只断错误码
      expect(h.repair.countAll).not.toHaveBeenCalled();
      expect(h.conversation.countAll).not.toHaveBeenCalled();
      expect(h.report.countAll).not.toHaveBeenCalled();
      expect(h.reference.listDocuments).not.toHaveBeenCalled();
      // 角色断言先行：等级与组织解析均不触发
      expect(h.access.findAdminLevelByAccountId).not.toHaveBeenCalled();
      expect(h.organizationContext.resolveForAccount).not.toHaveBeenCalled();
    },
  );

  it.each([2, null])('当前等级 %j 时失败关闭，不触发任何统计读取', async (level) => {
    const h = makeHarness();
    h.access.setAdminLevel(level);

    const error = (await captureThrownError(
      h.usecase.execute({ session: createSuperAdminSession() }),
    )) as { code?: string; message?: string };

    expect(error.code).toBe(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS);
    expect(error.message).toContain('仅一级管理员可以查看文档数据库统计');
    expect(h.repair.countAll).not.toHaveBeenCalled();
    expect(h.conversation.countAll).not.toHaveBeenCalled();
    expect(h.report.countAll).not.toHaveBeenCalled();
    expect(h.reference.listDocuments).not.toHaveBeenCalled();
    // 等级不满足时不再解析成员事实
    expect(h.organizationContext.resolveForAccount).not.toHaveBeenCalled();
  });

  it('可信成员事实缺失时失败关闭，不降级为全库统计', async () => {
    const h = makeHarness();
    (h.organizationContext.resolveForAccount as jest.Mock).mockRejectedValueOnce(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );

    const error = (await captureThrownError(
      h.usecase.execute({ session: createSuperAdminSession() }),
    )) as { code?: string };

    expect(error.code).toBe(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP);
    expect(h.repair.countAll).not.toHaveBeenCalled();
    expect(h.conversation.countAll).not.toHaveBeenCalled();
    expect(h.report.countAll).not.toHaveBeenCalled();
    expect(h.reference.listDocuments).not.toHaveBeenCalled();
  });
});
