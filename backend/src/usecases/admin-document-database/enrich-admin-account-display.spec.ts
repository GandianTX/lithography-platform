// src/usecases/admin-document-database/enrich-admin-account-display.spec.ts

import type {
  AdminAiConversationListItemQueryResult,
  AdminAiReportDetailQueryResult,
  AdminRepairRequestListItemQueryResult,
  AdminRepairRequestSummaryQueryResult,
} from '@src/modules/lithography/admin-document-database.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import {
  enrichAdminAiConversationListItems,
  enrichAdminAiReportDetail,
  enrichAdminAiReportListItems,
  enrichAdminRepairRequestListItems,
  enrichAdminRepairRequestSummary,
} from './enrich-admin-account-display';

/**
 * PR3 S4：账户展示信息批量富集单测。
 *
 * 核心断言：一页数据的账户富集恰好一次批量查询（防 N+1，计划表 S4.6）；
 * 缺失昵称/公司名安全回落；归属类账号 ID 在对外 View 中剥离（不泄露账号主键）。
 */
describe('enrich-admin-account-display', () => {
  const makeAccountQueryService = () =>
    ({
      findAccountDisplayInfosByAccountIds: jest.fn().mockResolvedValue(new Map()),
      findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
    }) as unknown as AccountQueryService;

  const repairItem = (
    overrides: Partial<AdminRepairRequestListItemQueryResult> = {},
  ): AdminRepairRequestListItemQueryResult => ({
    id: 880001,
    requestNo: 'RR-20260901-001',
    customerAccountId: 900001,
    equipmentModel: { id: 930001, modelCode: 'M', modelName: 'NXT' },
    errorCode: 'E-001',
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    isAccepted: false,
    acceptedAt: null,
    acceptedByEngineerAccountId: null,
    latestResolutionStatus: null,
    ...overrides,
  });

  it('维修申请列表：客户与工程师昵称一次批量查询（含去重）；账号 ID 剥离', async () => {
    const accountQueryService = makeAccountQueryService();
    (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock).mockResolvedValue(
      new Map([
        [900001, { nickname: '客户甲', companyName: '甲公司' }],
        [900002, { nickname: '陈工程师', companyName: null }],
      ]),
    );
    const items = [
      repairItem({ acceptedByEngineerAccountId: 900002 }),
      repairItem({ id: 880002, customerAccountId: 900002, acceptedByEngineerAccountId: 900002 }),
    ];

    const views = await enrichAdminRepairRequestListItems(accountQueryService, items);

    // 防串行 N+1：两条申请只触发一次批量账户查询，参数覆盖全部相关账号
    expect(accountQueryService.findAccountDisplayInfosByAccountIds).toHaveBeenCalledTimes(1);
    const calledIds = (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock).mock
      .calls[0][0] as number[];
    expect(calledIds).toEqual(expect.arrayContaining([900001, 900002]));
    // 展示信息填充 + 归属账号 ID 不外泄
    expect(views[0]).toMatchObject({
      customerNickname: '客户甲',
      companyName: '甲公司',
      acceptedByEngineerNickname: '陈工程师',
    });
    expect(views[0]).not.toHaveProperty('customerAccountId');
    expect(views[0]).not.toHaveProperty('acceptedByEngineerAccountId');
  });

  it('维修申请列表：缺失昵称/公司名安全回落，未接单时工程师昵称为 null', async () => {
    const accountQueryService = makeAccountQueryService();
    (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock).mockResolvedValue(
      new Map(),
    );

    const views = await enrichAdminRepairRequestListItems(accountQueryService, [repairItem()]);

    expect(views[0]).toMatchObject({
      customerNickname: '未知用户',
      companyName: null,
      acceptedByEngineerNickname: null,
    });
  });

  it('维修申请摘要：单条富集同口径（客户昵称/公司名/工程师昵称）', async () => {
    const accountQueryService = makeAccountQueryService();
    (accountQueryService.findAccountDisplayInfosByAccountIds as jest.Mock).mockResolvedValue(
      new Map([[900001, { nickname: '客户甲', companyName: null }]]),
    );
    const result = {
      ...repairItem(),
      faultDescription: '描述',
      contentMd: '# 正文',
      responses: [],
      revisions: [],
    } as unknown as AdminRepairRequestSummaryQueryResult;

    const view = await enrichAdminRepairRequestSummary(accountQueryService, result);

    expect(view).toMatchObject({ customerNickname: '客户甲', companyName: null });
    expect(view).not.toHaveProperty('customerAccountId');
  });

  it('AI 会话列表：工程师昵称一次批量查询，缺失回落「工程师」', async () => {
    const accountQueryService = makeAccountQueryService();
    (accountQueryService.findNicknamesByAccountIds as jest.Mock).mockResolvedValue(
      new Map([[900002, '陈工程师']]),
    );
    const items = [
      {
        id: 660001,
        requestId: 880001,
        requestNo: 'RR-20260901-001',
        engineerAccountId: 900002,
        status: 'COMPLETED',
        aiFeedback: null,
        createdAt: new Date('2026-09-02T09:00:00.000Z'),
        completedAt: null,
        messageCount: 12,
        reportCount: 1,
      } as unknown as AdminAiConversationListItemQueryResult,
      {
        id: 660002,
        requestId: 880002,
        requestNo: '',
        engineerAccountId: 900003,
        status: 'ACTIVE',
        aiFeedback: null,
        createdAt: new Date('2026-09-02T09:00:00.000Z'),
        completedAt: null,
        messageCount: 0,
        reportCount: 0,
      } as unknown as AdminAiConversationListItemQueryResult,
    ];

    const views = await enrichAdminAiConversationListItems(accountQueryService, items);

    expect(accountQueryService.findNicknamesByAccountIds).toHaveBeenCalledTimes(1);
    expect(views[0].engineerNickname).toBe('陈工程师');
    expect(views[1].engineerNickname).toBe('工程师');
    expect(views[0]).not.toHaveProperty('engineerAccountId');
  });

  it('AI 报告列表与详情：富集口径一致（一次批量 / 缺失回落）', async () => {
    const accountQueryService = makeAccountQueryService();
    (accountQueryService.findNicknamesByAccountIds as jest.Mock).mockResolvedValue(new Map());
    const items = [
      {
        id: 550001,
        requestId: 880001,
        requestNo: 'RR-20260901-001',
        requestMismatch: false,
        conversationId: 660001,
        engineerAccountId: 900002,
        reportTitle: '诊断报告',
        reportType: 'DIAGNOSIS',
        createdAt: new Date('2026-09-02T10:30:00.000Z'),
      },
    ];

    const views = await enrichAdminAiReportListItems(accountQueryService, items);
    expect(views[0].engineerNickname).toBe('工程师');
    expect(views[0]).not.toHaveProperty('engineerAccountId');

    const detail = {
      ...items[0],
      contentMd: '# 正文',
    } as unknown as AdminAiReportDetailQueryResult;
    const detailView = await enrichAdminAiReportDetail(accountQueryService, detail);
    expect(detailView.engineerNickname).toBe('工程师');
    expect(detailView).not.toHaveProperty('engineerAccountId');
  });

  it('空列表短路：不发起任何账户域查询', async () => {
    const accountQueryService = makeAccountQueryService();

    await enrichAdminRepairRequestListItems(accountQueryService, []);
    await enrichAdminAiConversationListItems(accountQueryService, []);
    await enrichAdminAiReportListItems(accountQueryService, []);

    expect(accountQueryService.findAccountDisplayInfosByAccountIds).not.toHaveBeenCalled();
    expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
  });
});
