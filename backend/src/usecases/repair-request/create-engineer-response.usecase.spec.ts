/// <reference types="jest" />
import { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  DomainError,
  INPUT_NORMALIZE_ERROR,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@src/core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type {
  EngineerResponseTargetSnapshot,
  EngineerResponseWriteSnapshot,
} from '@src/modules/lithography/lithography.types';
import type { RepairRequestService } from '@src/modules/lithography/repair-request.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { CreateEngineerResponseUsecase } from './create-engineer-response.usecase';

type RepairRequestServiceMock = {
  readonly findResponseTargetForUpdate: jest.Mock<Promise<EngineerResponseTargetSnapshot | null>>;
};

type EngineerResponseServiceMock = {
  readonly insertResponse: jest.Mock<Promise<EngineerResponseWriteSnapshot>>;
};

type AccountQueryServiceMock = {
  readonly findNicknamesByAccountIds: jest.Mock<Promise<Map<number, string>>>;
};

type TrustedOrganizationContextMock = {
  readonly resolveForAccount: jest.Mock;
};

/**
 * 回复写用例单测：只验证 UseCase 自身持有的业务决策
 * （roles + activeRole 回复写权限、输入语义收敛、昵称事务前读取、
 * 事务边界与归属派生、目标状态裁决、错误上抛），
 * 不复制 QueryService 的读权限规则（读权限归读用例与 E2E 覆盖）。
 */
describe('CreateEngineerResponseUsecase', () => {
  const transactionContext = Symbol(
    'transactionContext',
  ) as unknown as PersistenceTransactionContext;
  const requestId = 21;
  const customerAccountId = 7;
  const engineerSession: UsecaseSession = {
    accountId: 5,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
  };

  const acceptedTarget: EngineerResponseTargetSnapshot = {
    id: requestId,
    customerAccountId,
    isAccepted: true,
    acceptedByEngineerAccountId: engineerSession.accountId,
    deprecated: false,
    handlingStatus: null,
    closureStatus: null,
    serviceOrganizationId: 77,
  };

  const writeSnapshot: EngineerResponseWriteSnapshot = {
    id: 301,
    requestId,
    engineerAccountId: engineerSession.accountId,
    resolutionStatus: EngineerResolutionStatus.PENDING,
    responseText: '已初步处理',
    createdAt: new Date('2026-09-03T10:00:00.000Z'),
  };

  let repairRequestService: RepairRequestServiceMock;
  let engineerResponseService: EngineerResponseServiceMock;
  let accountQueryService: AccountQueryServiceMock;
  let trustedOrganizationContext: TrustedOrganizationContextMock;
  let transactionRunner: TransactionRunner;
  let usecase: CreateEngineerResponseUsecase;

  beforeEach(() => {
    repairRequestService = {
      findResponseTargetForUpdate: jest.fn().mockResolvedValue(acceptedTarget),
    };
    engineerResponseService = {
      insertResponse: jest.fn().mockResolvedValue(writeSnapshot),
    };
    accountQueryService = {
      findNicknamesByAccountIds: jest
        .fn()
        .mockResolvedValue(new Map([[engineerSession.accountId, '王工程师']])),
    };
    transactionRunner = {
      run: jest.fn(async (callback) => await callback(transactionContext)),
    };
    trustedOrganizationContext = {
      resolveForAccount: jest.fn().mockResolvedValue({
        membershipId: 1,
        organizationId: 77,
        organizationCode: 'SERVICE_B',
        organizationName: '服务公司 B',
        organizationKind: 'SERVICE_PROVIDER',
        memberRole: 'ENGINEER',
      }),
    };
    usecase = new CreateEngineerResponseUsecase(
      repairRequestService as unknown as RepairRequestService,
      engineerResponseService as unknown as ConstructorParameters<
        typeof CreateEngineerResponseUsecase
      >[1],
      accountQueryService as unknown as AccountQueryService,
      trustedOrganizationContext as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );
  });

  const command = (
    overrides: Partial<Parameters<CreateEngineerResponseUsecase['execute']>[0]> = {},
  ) => ({
    session: engineerSession,
    requestId,
    responseText: '已初步处理',
    resolutionStatus: EngineerResolutionStatus.PENDING,
    ...overrides,
  });

  const writtenData = () => engineerResponseService.insertResponse.mock.calls[0][0];

  describe('成功路径', () => {
    it('ENGINEER 回复成功并返回新回复稳定视图', async () => {
      const result = await usecase.execute(command());

      expect(result).toEqual({
        id: writeSnapshot.id,
        engineerNickname: '王工程师',
        resolutionStatus: writeSnapshot.resolutionStatus,
        responseText: writeSnapshot.responseText,
        createdAt: writeSnapshot.createdAt,
      });
      expect(result).not.toHaveProperty('engineerAccountId');
      expect(result).not.toHaveProperty('customerAccountId');
      expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    });

    it('正文首尾空白被 normalizeRequiredText 收敛后写入', async () => {
      await usecase.execute(command({ responseText: '   已初步处理   ' }));

      expect(writtenData().responseText).toBe('已初步处理');
    });

    it('requestId/engineerAccountId/customerAccountId 均从可信来源派生，客户端夹带的归属字段被忽略', async () => {
      // 入参契约只有 session/requestId/responseText/resolutionStatus，
      // 这里模拟调用方（Adapter 或恶意客户端）额外夹带归属账号字段，验证写入值不受影响
      const smuggled = {
        ...command({ responseText: ' 已初步处理 ' }),
        engineerAccountId: 999,
        customerAccountId: 888,
      } as unknown as Parameters<CreateEngineerResponseUsecase['execute']>[0];

      await usecase.execute(smuggled);

      expect(writtenData().requestId).toBe(requestId);
      expect(writtenData().engineerAccountId).toBe(engineerSession.accountId);
      expect(writtenData().engineerAccountId).not.toBe(999);
      expect(writtenData().customerAccountId).toBe(acceptedTarget.customerAccountId);
      expect(writtenData().customerAccountId).not.toBe(888);
    });

    it('昵称在事务开启前读取：昵称失败不会发生在回复写入之后', async () => {
      await usecase.execute(command());

      const nicknameCallOrder = (accountQueryService.findNicknamesByAccountIds as jest.Mock).mock
        .invocationCallOrder[0];
      const transactionCallOrder = (transactionRunner.run as jest.Mock).mock.invocationCallOrder[0];

      expect(nicknameCallOrder).toBeLessThan(transactionCallOrder);
    });

    it('目标锁定读取与回复写入使用同一个事务上下文', async () => {
      await usecase.execute(command());

      expect(repairRequestService.findResponseTargetForUpdate.mock.calls[0][1]).toBe(
        transactionContext,
      );
      expect(engineerResponseService.insertResponse.mock.calls[0][1]).toBe(transactionContext);
    });

    it('昵称缺失时回落为「工程师」（与详情批量富集同一回落规则）', async () => {
      accountQueryService.findNicknamesByAccountIds.mockResolvedValue(new Map());

      const result = await usecase.execute(command());

      expect(result.engineerNickname).toBe('工程师');
    });
  });

  describe('权限错误（不开启事务、不写入）', () => {
    const expectPermissionDenied = async (session: UsecaseSession) => {
      await expect(usecase.execute(command({ session }))).rejects.toMatchObject({
        code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
      });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.findResponseTargetForUpdate).not.toHaveBeenCalled();
      expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    };

    it('CUSTOMER 被拒绝', async () => {
      await expectPermissionDenied({
        accountId: 7,
        roles: [IdentityTypeEnum.CUSTOMER],
        activeRole: IdentityTypeEnum.CUSTOMER,
      });
    });

    it('SUPER_ADMIN 只继承读权限，写回复被拒绝', async () => {
      await expectPermissionDenied({
        accountId: 99,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
      });
    });

    it('混合角色 activeRole=SUPER_ADMIN：拒绝（守卫准入不等于回复写权限）', async () => {
      await expectPermissionDenied({
        accountId: 8,
        roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
        activeRole: IdentityTypeEnum.SUPER_ADMIN,
      });
    });

    it('混合角色 activeRole=ENGINEER：允许（接单人是该账号本身）', async () => {
      const hybridEngineerAccountId = 8;
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        acceptedByEngineerAccountId: hybridEngineerAccountId,
      });
      const session: UsecaseSession = {
        accountId: hybridEngineerAccountId,
        roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
        activeRole: IdentityTypeEnum.ENGINEER,
      };

      await expect(usecase.execute(command({ session }))).resolves.toMatchObject({
        id: writeSnapshot.id,
      });
    });

    it('roles=[ENGINEER]、activeRole 缺失：拒绝（失败关闭）', async () => {
      await expectPermissionDenied({ accountId: 5, roles: [IdentityTypeEnum.ENGINEER] });
    });

    it('roles=[SUPER_ADMIN]、activeRole=ENGINEER：拒绝（矛盾 Token：activeRole ∉ roles，失败关闭）', async () => {
      await expectPermissionDenied({
        accountId: 9,
        roles: [IdentityTypeEnum.SUPER_ADMIN],
        activeRole: IdentityTypeEnum.ENGINEER,
      });
    });
  });

  describe('输入错误（不开启事务、不写入）', () => {
    it.each([0, -1, 1.5, Number.NaN])('非正整数 requestId（%p）被拒绝', async (invalidId) => {
      await expect(usecase.execute(command({ requestId: invalidId }))).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.INVALID_PARAMS,
      });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it.each(['', '   '])('空字符串/纯空白正文（%j）被拒绝', async (blankText) => {
      await expect(usecase.execute(command({ responseText: blankText }))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY,
      });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('非法 resolutionStatus 被拒绝（值域语义不做猜测性修复）', async () => {
      await expect(
        usecase.execute(
          command({ resolutionStatus: 'DONE' as unknown as EngineerResolutionStatus }),
        ),
      ).rejects.toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE });

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('权限检查早于参数校验：CUSTOMER + 非法 ID 返回权限错误而非输入错误', async () => {
      await expect(
        usecase.execute(
          command({
            session: {
              accountId: 7,
              roles: [IdentityTypeEnum.CUSTOMER],
              activeRole: IdentityTypeEnum.CUSTOMER,
            },
            requestId: -1,
          }),
        ),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

      expect(transactionRunner.run).not.toHaveBeenCalled();
    });
  });

  describe('回复正文容量（MySQL TEXT UTF-8 字节上限 65,535）', () => {
    /**
     * 超限统一断言：拒绝码/文案正确，且计量发生在读昵称/查询申请/开启事务/
     * 调用写服务之前——四者均未被触发，不产生任何回复记录。
     */
    const expectOverCapacityRejected = async (responseText: string) => {
      await expect(usecase.execute(command({ responseText }))).rejects.toMatchObject({
        code: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
        message: '回复正文不能超过 65,535 字节（按 UTF-8 计算）',
      });

      expect(accountQueryService.findNicknamesByAccountIds).not.toHaveBeenCalled();
      expect(repairRequestService.findResponseTargetForUpdate).not.toHaveBeenCalled();
      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    };

    it('ASCII 65,535 bytes 合法并原样写入', async () => {
      const text = 'a'.repeat(65535);
      expect(Buffer.byteLength(text, 'utf8')).toBe(65535);

      await usecase.execute(command({ responseText: text }));

      expect(writtenData().responseText).toBe(text);
    });

    it('中文 21,845 字（65,535 bytes）合法并原样写入', async () => {
      const text = '中'.repeat(21845);
      expect(Buffer.byteLength(text, 'utf8')).toBe(65535);

      await usecase.execute(command({ responseText: text }));

      expect(writtenData().responseText).toBe(text);
    });

    it('emoji 16,383 个 + "abc"（65,535 bytes）合法并原样写入', async () => {
      const text = '😀'.repeat(16383) + 'abc';
      expect(Buffer.byteLength(text, 'utf8')).toBe(65535);

      await usecase.execute(command({ responseText: text }));

      expect(writtenData().responseText).toBe(text);
    });

    it('容量计量发生在 trim 之后：65,535 bytes 正文外加首尾空白仍合法', async () => {
      const text = `  ${'a'.repeat(65535)}  `;
      // 未 trim 时 65,539 bytes（超限），trim 后恰为 65,535 bytes（合法）
      expect(Buffer.byteLength(text, 'utf8')).toBe(65539);

      await usecase.execute(command({ responseText: text }));

      expect(writtenData().responseText).toBe('a'.repeat(65535));
    });

    it('ASCII 65,536 bytes 拒绝（不开启事务、不写入）', async () => {
      await expectOverCapacityRejected('a'.repeat(65536));
    });

    it('中文 21,846 字（65,538 bytes）拒绝（不开启事务、不写入）', async () => {
      const text = '中'.repeat(21846);
      expect(Buffer.byteLength(text, 'utf8')).toBe(65538);

      await expectOverCapacityRejected(text);
    });

    it('emoji 16,384 个（65,536 bytes）拒绝（不开启事务、不写入）', async () => {
      const text = '😀'.repeat(16384);
      expect(Buffer.byteLength(text, 'utf8')).toBe(65536);

      await expectOverCapacityRejected(text);
    });
  });

  describe('目标状态裁决（事务内锁定读取，失败均不插入回复）', () => {
    it('申请不存在返回统一不可访问错误（NOT_FOUND）', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue(null);

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('已删除申请返回统一不可访问错误（NOT_FOUND）', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        deprecated: true,
      });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('客户公司 A、服务公司 B：工程师属于 B 且本人接单 → 允许回复', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        serviceOrganizationId: 88,
      });
      trustedOrganizationContext.resolveForAccount.mockResolvedValue({
        membershipId: 1,
        organizationId: 88,
        organizationCode: 'SERVICE_B',
        organizationName: '服务公司 B',
        organizationKind: 'SERVICE_PROVIDER',
        memberRole: 'ENGINEER',
      });

      await expect(usecase.execute(command())).resolves.toMatchObject({ id: writeSnapshot.id });
      expect(engineerResponseService.insertResponse).toHaveBeenCalledTimes(1);
    });

    it('工程师属于客户公司 A、工单服务公司为 B：NOT_FOUND 且不写回复（不按客户公司兜底）', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        serviceOrganizationId: 88,
      });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('intake 缺失或无服务归属（可信服务公司为 null）：NOT_FOUND 且不写回复（不按历史接单人兜底）', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        serviceOrganizationId: null,
      });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('工单与 intake 两处服务公司冲突（可信服务公司为 null）：NOT_FOUND 且不写回复', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        serviceOrganizationId: null,
      });

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('工程师无组织归属：FORBIDDEN 且不写回复', async () => {
      trustedOrganizationContext.resolveForAccount.mockRejectedValue(
        new DomainError(
          PERMISSION_ERROR.ACCESS_DENIED,
          '当前账号不存在可信组织关系，无法执行该操作',
        ),
      );

      await expect(usecase.execute(command())).rejects.toMatchObject({
        code: PERMISSION_ERROR.ACCESS_DENIED,
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('尚未接单返回 NOT_ACCEPTED（业务状态冲突，提示先接单后回复）', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        isAccepted: false,
        acceptedByEngineerAccountId: null,
      });

      let caught: unknown;
      try {
        await usecase.execute(command());
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_ACCEPTED,
        details: { requestId },
      });
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('被其他工程师接单返回统一不可访问错误，不泄露他人接单状态', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValue({
        ...acceptedTarget,
        acceptedByEngineerAccountId: 42,
      });

      let caught: unknown;
      try {
        await usecase.execute(command());
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: REPAIR_REQUEST_ERROR.NOT_FOUND,
        details: { requestId },
      });
      // 错误 details 只含申请标识，不携带接单工程师身份
      expect(JSON.stringify((caught as { details?: unknown }).details ?? null)).not.toContain('42');
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('中断记录后仍处理中（IN_PROGRESS）可继续回复', async () => {
      repairRequestService.findResponseTargetForUpdate.mockResolvedValueOnce({
        ...acceptedTarget,
        handlingStatus: 'IN_PROGRESS',
        closureStatus: null,
      });

      await usecase.execute(command());

      expect(engineerResponseService.insertResponse).toHaveBeenCalledTimes(1);
    });

    it('已结单 / 处理已终结时拒绝回复，且不写回复（结单后回复只读）', async () => {
      for (const target of [
        { ...acceptedTarget, closureStatus: 'CLOSED' },
        { ...acceptedTarget, handlingStatus: 'COMPLETED' },
        { ...acceptedTarget, handlingStatus: 'UNRESOLVED' },
      ]) {
        repairRequestService.findResponseTargetForUpdate.mockResolvedValueOnce(target);

        await expect(usecase.execute(command())).rejects.toMatchObject({
          code: REPAIR_REQUEST_ERROR.CLOSED_STATE_CONFLICT,
          details: { requestId },
        });
        expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
      }
    });
  });

  describe('系统错误', () => {
    it('昵称查询失败时事务与写入不执行，错误上抛（避免「已写入但输出失败」窗口）', async () => {
      const nicknameFailure = new Error('nickname query failed');
      accountQueryService.findNicknamesByAccountIds.mockRejectedValue(nicknameFailure);

      await expect(usecase.execute(command())).rejects.toBe(nicknameFailure);

      expect(transactionRunner.run).not.toHaveBeenCalled();
      expect(repairRequestService.findResponseTargetForUpdate).not.toHaveBeenCalled();
      expect(engineerResponseService.insertResponse).not.toHaveBeenCalled();
    });

    it('回复 Service 抛出的系统错误正确向上传递，不掩盖', async () => {
      const writeFailure = new Error('insert failed');
      engineerResponseService.insertResponse.mockRejectedValue(writeFailure);

      await expect(usecase.execute(command())).rejects.toBe(writeFailure);

      expect(engineerResponseService.insertResponse).toHaveBeenCalledTimes(1);
    });
  });
});
