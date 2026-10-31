/// <reference types="jest" />
import { IdentityTypeEnum } from '@app-types/models/account.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { PERMISSION_ERROR, REPAIR_REQUEST_ERROR } from '@src/core/common/errors/domain-error';
import type {
  RepairRequestAcceptanceStatusSnapshot,
  RepairRequestAcceptWriteResult,
  RepairRequestDetailView,
} from '@src/modules/lithography/lithography.types';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { AcceptRepairRequestUsecase } from './accept-repair-request.usecase';
import type { GetEngineerRepairRequestDetailUsecase } from './get-engineer-repair-request-detail.usecase';

type RepairRequestServiceMock = {
  readonly acceptRequest: jest.Mock<Promise<RepairRequestAcceptWriteResult>>;
  readonly findAcceptanceStatus: jest.Mock<Promise<RepairRequestAcceptanceStatusSnapshot | null>>;
  readonly findOwnerOrganizationId: jest.Mock<Promise<number | null | undefined>>;
};

type OrganizationContextMock = {
  readonly tryResolveForAccount: jest.Mock;
};

type GetEngineerRepairRequestDetailUsecaseMock = {
  readonly execute: jest.Mock<Promise<RepairRequestDetailView>>;
};

/**
 * 接单用例单测：只验证 UseCase 自身持有的业务决策
 * （roles + activeRole 接单权限、入参校验、事务边界、写入参数来源、
 * 组织范围（同组织/跨组织/无归属存量一律拒绝）、
 * 未命中裁决、写后读复用），
 * 不复制 QueryService 的细粒度读权限规则（读权限归读用例与 E2E 覆盖）。
 */
describe('AcceptRepairRequestUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;
  const requestId = 21;
  const engineerSession: UsecaseSession = {
    accountId: 5,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
  };

  const detailView: RepairRequestDetailView = {
    id: requestId,
    requestNo: 'RR20260902100000ABC123',
    equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    contentMd: '# 设备维修申请',
    createdAt: new Date('2026-09-02T08:00:00.000Z'),
    isAccepted: true,
    acceptedAt: new Date('2026-09-02T08:30:00.000Z'),
    latestResolutionStatus: null,
    responses: [],
  };

  let repairRequestService: RepairRequestServiceMock;
  let getEngineerRepairRequestDetailUsecase: GetEngineerRepairRequestDetailUsecaseMock;
  let organizationContextQueryService: OrganizationContextMock;
  let transactionRunner: TransactionRunner;
  let usecase: AcceptRepairRequestUsecase;

  beforeEach(() => {
    repairRequestService = {
      acceptRequest: jest.fn().mockResolvedValue({ affected: 1 }),
      findAcceptanceStatus: jest.fn().mockResolvedValue(null),
      // 默认：工单归属与工程师当前组织一致（组织范围由下方决策用例单独覆盖）
      findOwnerOrganizationId: jest.fn().mockResolvedValue(77),
    };
    getEngineerRepairRequestDetailUsecase = {
      execute: jest.fn().mockResolvedValue(detailView),
    };
    organizationContextQueryService = {
      tryResolveForAccount: jest.fn().mockResolvedValue({
        membershipId: 1,
        organizationId: 77,
        organizationCode: 'CLIENT_DEFAULT',
        organizationName: '甲方默认组织',
        organizationKind: 'CLIENT',
        memberRole: 'ENGINEER',
      }),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    usecase = new AcceptRepairRequestUsecase(
      repairRequestService as unknown as RepairRequestService,
      getEngineerRepairRequestDetailUsecase as unknown as GetEngineerRepairRequestDetailUsecase,
      organizationContextQueryService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );
  });

  const writtenData = () => repairRequestService.acceptRequest.mock.calls[0][0];

  describe('成功路径', () => {
    it('ENGINEER 接单成功并返回写后详情', async () => {
      await expect(usecase.execute({ requestId, session: engineerSession })).resolves.toBe(
        detailView,
      );

      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(repairRequestService.acceptRequest).toHaveBeenCalledTimes(1);
      expect(repairRequestService.findAcceptanceStatus).not.toHaveBeenCalled();
    });

    it('engineerAccountId 只来自 Session：客户端夹带的接单人字段被忽略', async () => {
      // 入参契约只有 requestId 与 session，这里模拟调用方（Adapter 或恶意客户端）
      // 额外夹带 engineerAccountId / acceptedAt，验证写入值不受影响
      const smuggled = {
        requestId,
        session: engineerSession,
        engineerAccountId: 999,
        acceptedAt: new Date('2000-01-01T00:00:00.000Z'),
      } as unknown as { requestId: number; session: UsecaseSession };

      await usecase.execute(smuggled);

      expect(writtenData().engineerAccountId).toBe(engineerSession.accountId);
      expect(writtenData().engineerAccountId).not.toBe(999);
      expect(writtenData().acceptedAt.getTime()).not.toBe(
        new Date('2000-01-01T00:00:00.000Z').getTime(),
      );
    });

    it('acceptedAt 由后端生成，是落在调用区间内的有效 Date', async () => {
      const before = Date.now();
      await usecase.execute({ requestId, session: engineerSession });
      const after = Date.now();

      const { acceptedAt } = writtenData();
      expect(acceptedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(acceptedAt.getTime())).toBe(false);
      expect(acceptedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(acceptedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('事务边界由 UseCase 持有，条件更新与未命中读取共用同一 transactionContext', async () => {
      repairRequestService.acceptRequest.mockResolvedValue({ affected: 0 });
      repairRequestService.findAcceptanceStatus.mockResolvedValue({
        id: requestId,
        isAccepted: true,
        deprecated: false,
      });

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED,
      });

      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
      expect(repairRequestService.acceptRequest.mock.calls[0][1]).toBe(transactionContext);
      expect(repairRequestService.findAcceptanceStatus.mock.calls[0][1]).toBe(transactionContext);
    });

    it('成功后复用既有工程师详情用例，透传同一 requestId 与 session', async () => {
      await usecase.execute({ requestId, session: engineerSession });

      expect(getEngineerRepairRequestDetailUsecase.execute).toHaveBeenCalledTimes(1);
      expect(getEngineerRepairRequestDetailUsecase.execute).toHaveBeenCalledWith({
        requestId,
        session: engineerSession,
      });
    });
  });

  describe('组织范围决策', () => {
    it('无组织归属的存量工单：NOT_FOUND，不解析组织、不写入（不向全体工程师开放）', async () => {
      repairRequestService.findOwnerOrganizationId.mockResolvedValue(null);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });

      expect(organizationContextQueryService.tryResolveForAccount).not.toHaveBeenCalled();
      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('已归属工单且工程师同组织：允许接单', async () => {
      repairRequestService.findOwnerOrganizationId.mockResolvedValue(77);

      await expect(usecase.execute({ requestId, session: engineerSession })).resolves.toBe(
        detailView,
      );

      expect(organizationContextQueryService.tryResolveForAccount).toHaveBeenCalledWith({
        accountId: engineerSession.accountId,
        transactionContext,
      });
      expect(repairRequestService.acceptRequest).toHaveBeenCalledTimes(1);
    });

    it('已归属工单但工程师属于其他组织：NOT_FOUND 且不写入（不泄露工单存在性）', async () => {
      repairRequestService.findOwnerOrganizationId.mockResolvedValue(88);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });

      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('已归属工单但工程师无组织归属：NOT_FOUND 且不写入', async () => {
      repairRequestService.findOwnerOrganizationId.mockResolvedValue(77);
      organizationContextQueryService.tryResolveForAccount.mockResolvedValue(null);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });

      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
    });

    it('工单不存在（归属读取为 undefined）：NOT_FOUND 且不解析组织、不写入', async () => {
      repairRequestService.findOwnerOrganizationId.mockResolvedValue(undefined);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });

      expect(organizationContextQueryService.tryResolveForAccount).not.toHaveBeenCalled();
      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
    });
  });

  describe('入参决策', () => {
    it.each([0, -1, 1.5, Number.NaN])(
      '非正整数申请 ID（%p）被拒绝且不开始事务',
      async (invalidId) => {
        await expect(
          usecase.execute({ requestId: invalidId, session: engineerSession }),
        ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.INVALID_PARAMS });

        expect(transactionRunner.run).not.toHaveBeenCalled();
        expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
        expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
      },
    );
  });

  describe('角色准入决策', () => {
    it.each([[[IdentityTypeEnum.CUSTOMER]], [[IdentityTypeEnum.SUPER_ADMIN]], [[] as string[]]])(
      'roles=%j 且 activeRole 缺失被拒绝，不开始事务、不执行写入',
      async (roles) => {
        await expect(
          usecase.execute({ requestId, session: { accountId: 5, roles } }),
        ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

        expect(transactionRunner.run).not.toHaveBeenCalled();
        expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
        expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
      },
    );

    it('SUPER_ADMIN 只继承读权限：读详情用例不因角色准入被拒绝', async () => {
      // 反向确认「读权限继承不等于接单权限」：SUPER_ADMIN 走读用例不被本用例拦截，
      // 而接单入口被拦截，两者不共享同一判定
      const superAdminSession: UsecaseSession = {
        accountId: 99,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
      };
      await expect(
        usecase.execute({ requestId, session: superAdminSession }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });
  });

  describe('精确 activeRole 接单权限矩阵', () => {
    it('roles=[ENGINEER]、activeRole=ENGINEER：允许', async () => {
      const session: UsecaseSession = {
        accountId: 5,
        roles: [IdentityTypeEnum.ENGINEER],
        activeRole: IdentityTypeEnum.ENGINEER,
      };

      await expect(usecase.execute({ requestId, session })).resolves.toBe(detailView);
    });

    it('混合角色 activeRole=SUPER_ADMIN 被拒绝：守卫准入不等于接单写权限', async () => {
      const hybridSuperAdminSession: UsecaseSession = {
        accountId: 8,
        roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
      };

      await expect(
        usecase.execute({ requestId, session: hybridSuperAdminSession }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('混合角色 activeRole=ENGINEER：允许（同一账号切换当前角色后可接单）', async () => {
      const hybridEngineerSession: UsecaseSession = {
        accountId: 8,
        roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
        activeRole: IdentityTypeEnum.ENGINEER,
      };

      await expect(usecase.execute({ requestId, session: hybridEngineerSession })).resolves.toBe(
        detailView,
      );
    });

    it('roles=[ENGINEER]、activeRole 缺失：拒绝（失败关闭）', async () => {
      const sessionWithoutActiveRole: UsecaseSession = {
        accountId: 5,
        roles: [IdentityTypeEnum.ENGINEER],
      };

      await expect(
        usecase.execute({ requestId, session: sessionWithoutActiveRole }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it.each([IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.CUSTOMER] as const)(
      'roles 不含 ENGINEER、activeRole=%s：拒绝（activeRole 不能越过 roles）',
      async (activeRole) => {
        const session: UsecaseSession = { accountId: 9, roles: [activeRole], activeRole };

        await expect(usecase.execute({ requestId, session })).rejects.toMatchObject({
          code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
        });

        expect(transactionRunner.run).not.toHaveBeenCalled();
        expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
        expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
      },
    );

    it('roles=[SUPER_ADMIN]、activeRole=ENGINEER：拒绝（矛盾 Token：activeRole ∉ roles，失败关闭）', async () => {
      // 文档化对抗组合：activeRole 不能脱离 roles 单独授予 ENGINEER
      // （伪造/异常签发的 Token 即使声称 activeRole=ENGINEER 也被拦截）
      const contradictorySession: UsecaseSession = {
        accountId: 9,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.ENGINEER,
      };

      await expect(
        usecase.execute({ requestId, session: contradictorySession }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('权限拒绝错误不携带 accessGroup/角色列表等身份信息', async () => {
      const hybridSuperAdminSession: UsecaseSession = {
        accountId: 8,
        roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
      };

      let caught: unknown;
      try {
        await usecase.execute({ requestId, session: hybridSuperAdminSession });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
      expect(JSON.stringify(caught)).not.toContain('SUPER_ADMIN');
      expect(JSON.stringify(caught)).not.toContain('accessGroup');
    });
  });

  describe('条件更新未命中裁决（affected = 0）', () => {
    beforeEach(() => {
      repairRequestService.acceptRequest.mockResolvedValue({ affected: 0 });
    });

    it('记录不存在时返回 NOT_FOUND，且不泄漏接单人身份', async () => {
      repairRequestService.findAcceptanceStatus.mockResolvedValue(null);

      let caught: unknown;
      try {
        await usecase.execute({ requestId, session: engineerSession });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('记录已删除时返回 NOT_FOUND', async () => {
      repairRequestService.findAcceptanceStatus.mockResolvedValue({
        id: requestId,
        isAccepted: false,
        deprecated: true,
      });

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('记录已接单时返回 REPAIR_REQUEST_ALREADY_ACCEPTED，details 只含申请标识', async () => {
      repairRequestService.findAcceptanceStatus.mockResolvedValue({
        id: requestId,
        isAccepted: true,
        deprecated: false,
      });

      let caught: unknown;
      try {
        await usecase.execute({ requestId, session: engineerSession });
      } catch (error) {
        caught = error;
      }

      // 最小快照不读接单人：错误 details 不得含任何工程师账号标识
      expect(caught).toMatchObject({
        code: REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED,
        details: { requestId },
      });
      expect(JSON.stringify((caught as { details?: unknown }).details ?? null)).not.toContain(
        'engineer',
      );
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('记录仍未删除且未接单（不应出现的状态）时按系统失败上报', async () => {
      repairRequestService.findAcceptanceStatus.mockResolvedValue({
        id: requestId,
        isAccepted: false,
        deprecated: false,
      });

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.ACCEPT_FAILED,
        details: { requestId },
      });
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('未命中后只做一次最小状态读取，不额外读取详情或列表', async () => {
      repairRequestService.findAcceptanceStatus.mockResolvedValue(null);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });

      expect(repairRequestService.acceptRequest).toHaveBeenCalledTimes(1);
      expect(repairRequestService.findAcceptanceStatus).toHaveBeenCalledTimes(1);
      expect(repairRequestService.findAcceptanceStatus.mock.calls[0][0]).toBe(requestId);
    });
  });

  describe('写入失败路径', () => {
    it('Service 抛出的接单失败直接上抛，不执行写后详情读取', async () => {
      const dbFailure = { code: REPAIR_REQUEST_ERROR.ACCEPT_FAILED, details: { requestId } };
      repairRequestService.acceptRequest.mockRejectedValue(dbFailure);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toBe(
        dbFailure,
      );

      expect(repairRequestService.findAcceptanceStatus).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('事务开启失败时不执行写入与写后读取', async () => {
      (transactionRunner.run as jest.Mock).mockRejectedValueOnce(new Error('begin failed'));

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toThrow(
        'begin failed',
      );

      expect(repairRequestService.acceptRequest).not.toHaveBeenCalled();
      expect(getEngineerRepairRequestDetailUsecase.execute).not.toHaveBeenCalled();
    });

    it('写后详情读取失败时上抛读用例原始错误，不掩盖为接单失败', async () => {
      const readFailure = { code: 'REPAIR_REQUEST_NOT_FOUND', details: { requestId } };
      getEngineerRepairRequestDetailUsecase.execute.mockRejectedValue(readFailure);

      await expect(usecase.execute({ requestId, session: engineerSession })).rejects.toBe(
        readFailure,
      );

      expect(repairRequestService.acceptRequest).toHaveBeenCalledTimes(1);
    });
  });
});
