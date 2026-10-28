// test/06-repair-request/repair-request-response.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AudienceTypeEnum, IdentityTypeEnum } from '@app-types/models/account.types';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { EngineerResponseEntity } from '@src/modules/lithography/entities/engineer-response.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { TokenHelper } from '@src/modules/auth/token.helper';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { App } from 'supertest/types';
import type { Response as SupertestResponse } from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { getAccountIdByLoginName, login, postGql } from '../utils/e2e-graphql-utils';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type ResidueEquipmentModelFingerprint,
  type ResidueRepairRequestFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

const CREATE_RESPONSE_MUTATION = `
  mutation CreateEngineerResponse($input: CreateEngineerResponseInput!) {
    createEngineerResponse(input: $input) {
      id
      engineerNickname
      resolutionStatus
      responseText
      createdAt
    }
  }
`;

const ACCEPT_MUTATION = `
  mutation AcceptRepairRequest($id: Int!) {
    acceptRepairRequest(id: $id) { id isAccepted acceptedAt }
  }
`;

const ENGINEER_DETAIL_QUERY = `
  query EngineerRepairRequest($id: Int!) {
    engineerRepairRequest(id: $id) {
      id
      requestNo
      isAccepted
      latestResolutionStatus
      responses { id engineerNickname resolutionStatus responseText createdAt }
    }
  }
`;

const MY_DETAIL_QUERY = `
  query MyRepairRequest($id: Int!) {
    myRepairRequest(id: $id) {
      id
      latestResolutionStatus
      responses { id engineerNickname resolutionStatus responseText createdAt }
    }
  }
`;

const ENGINEER_LIST_QUERY = `
  query EngineerRepairRequests($scope: String!, $pagination: PaginationArgs!) {
    engineerRepairRequests(scope: $scope, pagination: $pagination) {
      items { id latestResolutionStatus }
      total
    }
  }
`;

const OFFSET_PAGINATION = { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true };

/** 型号自然键；ID 由数据库生成后登记到本轮账本。 */
const MODEL_CODE = 'E2E-RESP';
const MODEL_NAME = '回复型号';

type RequestKey =
  | 'acceptedByEngineer'
  | 'notAccepted'
  | 'deleted'
  | 'acceptedByOther'
  | 'forbiddenTarget'
  | 'invalidInputTarget'
  | 'concurrentAccept'
  | 'concurrentAppend'
  | 'hybridAccepted'
  | 'whitelistTarget'
  | 'appendSemantic'
  | 'readSync'
  | 'capacityOk'
  | 'capacityOver';

interface RequestSeed {
  readonly key: RequestKey;
  readonly requestNo: string;
  readonly scene: string;
  readonly acceptedBy: 'engineer' | 'other' | 'hybrid' | null;
  readonly deprecated?: boolean;
}

const REQUEST_SEEDS: readonly RequestSeed[] = [
  {
    key: 'acceptedByEngineer',
    requestNo: 'E2E-RS-141',
    scene: '本人已接单回复成功',
    acceptedBy: 'engineer',
  },
  { key: 'notAccepted', requestNo: 'E2E-RS-142', scene: '未接单状态冲突', acceptedBy: null },
  {
    key: 'deleted',
    requestNo: 'E2E-RS-143',
    scene: '已删除防探测',
    acceptedBy: null,
    deprecated: true,
  },
  { key: 'acceptedByOther', requestNo: 'E2E-RS-145', scene: '他人接单防探测', acceptedBy: 'other' },
  { key: 'forbiddenTarget', requestNo: 'E2E-RS-146', scene: '权限拒绝', acceptedBy: null },
  { key: 'invalidInputTarget', requestNo: 'E2E-RS-147', scene: '输入非法', acceptedBy: 'engineer' },
  { key: 'concurrentAccept', requestNo: 'E2E-RS-148', scene: '接单与回复并发', acceptedBy: null },
  {
    key: 'concurrentAppend',
    requestNo: 'E2E-RS-149',
    scene: '同人并发追加',
    acceptedBy: 'engineer',
  },
  {
    key: 'hybridAccepted',
    requestNo: 'E2E-RS-150',
    scene: '混合角色回复成功',
    acceptedBy: 'hybrid',
  },
  {
    key: 'whitelistTarget',
    requestNo: 'E2E-RS-151',
    scene: '客户端传入归属账号被拒',
    acceptedBy: 'engineer',
  },
  { key: 'appendSemantic', requestNo: 'E2E-RS-152', scene: '追加语义专用', acceptedBy: 'engineer' },
  {
    key: 'readSync',
    requestNo: 'E2E-RS-153',
    scene: '客户详情与 MINE 列表同步专用',
    acceptedBy: 'engineer',
  },
  { key: 'capacityOk', requestNo: 'E2E-RS-154', scene: '容量合法写入专用', acceptedBy: 'engineer' },
  {
    key: 'capacityOver',
    requestNo: 'E2E-RS-155',
    scene: '容量超限拒绝专用',
    acceptedBy: 'engineer',
  },
];

const NON_EXISTENT_REQUEST_ID = 999999;

/**
 * 工程师追加处理回复写链路回归（core 组）
 *
 * 与 accept/read/flow spec 分工：本文件只覆盖 createEngineerResponse Mutation 及其
 * 与既有读模型（详情 responses 时间线、latestResolutionStatus）的贯通事实：
 * - 成功闭环：DTO 只含本次新建回复（不重查整份详情）、正文 trim 落库、
 *   engineerNickname 取事务前读取的当前安全昵称、createdAt 由数据库生成；
 *   归属派生（engineerAccountId 来自可信 Session、customerAccountId 来自目标申请）
 *   以数据库为准，且不进入对外 DTO（契约防泄漏）
 * - 追加语义：多次回复不更新历史回复，详情 responses 按 createdAt ASC + id ASC，
 *   latestResolutionStatus 取末条状态；客户详情与 MINE 列表同步反映
 * - 权限矩阵：CUSTOMER / SUPER_ADMIN / 未登录被守卫拒绝（写入口精确 ENGINEER）；
 *   混合角色（accessGroup=[SUPER_ADMIN, ENGINEER]）以 activeRole=SUPER_ADMIN 进入时
 *   被用例内的精确写权限拒绝，activeRole=ENGINEER 时可回复；
 *   合法签名但无 activeRole 的兼容性 Token 失败关闭；所有拒绝路径均不产生写入
 * - 状态与防探测：不存在 / 已删除 / 他人已接单统一 NOT_FOUND 且文案完全一致；
 *   存在但未接单为 CONFLICT（NOT_ACCEPTED），details 只含 requestId；
 *   已删除申请必然未被接单（数据库 chk_repair_request_deletion_consistency 强制），
 *   因此三类不可访问来源互斥，造数不得构造「已接单且已删除」的不可能状态
 * - 输入错误：空与纯空白正文、requestId 非正整数、客户端试图传入归属账号 ID
 *   （契约层无此字段，GraphQL 变量校验直接拒绝）、非法处理状态；均拒绝且不落库；
 *   输入校验先于目标查询，因此非法输入不会泄露申请是否存在
 * - 并发：同一工程师两条回复并发均成功（追加由目标行锁串行化，不覆盖历史）；
 *   未接单申请上「接单 + 回复」真实并发时接单必成功，回复只可能成功或
 *   CONFLICT(NOT_ACCEPTED)，数据库终态与响应一致
 *
 * 注：requestId 非正整数与非法处理状态在真实链路上分别由装配层 @ValidateInput
 * 与 GraphQL 运行时 enum 校验拦截，usecase 内的 assertRepairRequestId /
 * normalizeEnumValue 是第二道防线（已由单测覆盖），此处按真实链路断言。
 *
 * 造数固定主键，依赖 global-setup-e2e 的全表 TRUNCATE 保证无冲突；
 * 清理顺序遵守外键 RESTRICT：engineer_response → repair_request → account → 型号。
 */
describe('工程师追加处理回复写链路 (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let modelRepository: Repository<EquipmentModelEntity>;
  let requestRepository: Repository<RepairRequestEntity>;
  let responseRepository: Repository<EngineerResponseEntity>;
  let engineerToken: string;
  let otherEngineerToken: string;
  let customerToken: string;
  let adminToken: string;
  let hybridTokenSuperAdmin: string;
  let hybridTokenEngineer: string;
  let noActiveRoleToken: string;
  let engineerAccountId: number;
  let otherEngineerAccountId: number;
  let customerAccountId: number;
  let hybridAccountId: number;
  let engineerNickname: string;

  const ownership = createOwnedResourceLedger();
  const requestIdByKey: Record<RequestKey, number> = Object.fromEntries(
    REQUEST_SEEDS.map((seed) => [seed.key, 0]),
  ) as Record<RequestKey, number>;
  const residueAccounts = buildTestAccountResidue([
    'staff',
    'staffSecondary',
    'guestPrimary',
    'admin',
    'hybridStaff',
  ]);
  const residueModel: ResidueEquipmentModelFingerprint = {
    modelCode: MODEL_CODE,
    modelName: MODEL_NAME,
    enabled: true,
    sortOrder: 1,
  };
  const residueRequests: ResidueRepairRequestFingerprint[] = REQUEST_SEEDS.map((seed) => ({
    requestNo: seed.requestNo,
    customerAccountLoginName: testAccountsConfig.guestPrimary.loginName,
    equipmentModelCode: MODEL_CODE,
    errorCode: `E-4${seed.requestNo.split('-').pop()}`,
    faultDescription: `${seed.scene}场景`,
    contentMd: `# E2E-${seed.requestNo.split('-').pop()}`,
  }));

  /**
   * R01：回复成功后立即登记真实回复 ID 与预期事实，清理不再按父申请自动扩图。
   * 工程师账号由受控登录 Token 推导，客户取自本轮受控申请，正文/状态取自创建返回值。
   */
  const registerCreatedResponse = (
    token: string | undefined,
    input: Record<string, unknown>,
    response: SupertestResponse,
  ): void => {
    const created = (
      response.body as {
        data?: {
          createEngineerResponse?: {
            id?: number;
            responseText?: string;
            resolutionStatus?: string;
          };
        };
      }
    )?.data?.createEngineerResponse;
    if (!created || created.id === undefined || created.id === null) {
      return;
    }
    const responseId = Number(created.id);
    if (!Number.isInteger(responseId) || responseId <= 0) {
      throw new Error(`回复登记失败：创建返回的回复 ID 非法（${String(created.id)}）`);
    }
    const engineerAccountIdByToken = new Map<string, number>([
      [engineerToken, engineerAccountId],
      [hybridTokenEngineer, hybridAccountId],
    ]);
    const engineerId = token === undefined ? undefined : engineerAccountIdByToken.get(token);
    if (engineerId === undefined) {
      throw new Error('回复登记失败：无法从受控登录 Token 解析本轮工程师账号');
    }
    recordOwnedResource(ownership, 'engineerResponse', responseId, {
      requestId: Number(input.requestId),
      engineerAccountId: engineerId,
      customerAccountId,
      responseText: String(created.responseText ?? input.responseText),
      resolutionStatus: String(created.resolutionStatus ?? 'PENDING'),
    });
  };

  const createResponse = (token: string | undefined, input: Record<string, unknown>) => {
    const execute = async (status = 200): Promise<SupertestResponse> => {
      const response = await postGql({
        app,
        query: CREATE_RESPONSE_MUTATION,
        variables: { input },
        token,
      }).expect(status);
      registerCreatedResponse(token, input, response);
      return response;
    };
    return {
      expect: (status: number) => execute(status),
      then: <TResult1 = SupertestResponse, TResult2 = never>(
        onfulfilled?: ((value: SupertestResponse) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> => execute().then(onfulfilled, onrejected),
    };
  };

  const validInput = (requestId: number, overrides: Record<string, unknown> = {}) => ({
    requestId,
    responseText: '已更换备件并复测通过',
    resolutionStatus: 'PENDING',
    ...overrides,
  });

  const countResponses = (requestId: number): Promise<number> =>
    responseRepository.count({ where: { requestId } });

  const expectForbidden = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('FORBIDDEN');
    expect(err.extensions.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  };

  const expectUnauthenticated = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('UNAUTHENTICATED');
    expect(err.extensions.errorCode).toBe('JWT_AUTHENTICATION_FAILED');
  };

  const expectNotFound = (error: unknown): void => {
    const err = error as { extensions: Record<string, unknown> };
    expect(err.extensions.code).toBe('NOT_FOUND');
    expect(err.extensions.errorCode).toBe('REPAIR_REQUEST_NOT_FOUND');
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    modelRepository = dataSource.getRepository(EquipmentModelEntity);
    requestRepository = dataSource.getRepository(RepairRequestEntity);
    responseRepository = dataSource.getRepository(EngineerResponseEntity);

    await app.init();
    await runGuardedSpecCleanup({
      dataSource,
      helper: 'repair-request-response.e2e beforeAll',
      residue: {
        accounts: residueAccounts,
        equipmentModels: [residueModel],
        repairRequests: residueRequests,
      },
    });

    await seedTestAccounts({
      dataSource,
      createAccountUsecase: app.get(CreateAccountUsecase),
      includeKeys: ['staff', 'staffSecondary', 'guestPrimary', 'admin', 'hybridStaff'],
      ownership,
    });
    engineerToken = await login({
      app,
      loginName: testAccountsConfig.staff.loginName,
      loginPassword: testAccountsConfig.staff.loginPassword,
    });
    otherEngineerToken = await login({
      app,
      loginName: testAccountsConfig.staffSecondary.loginName,
      loginPassword: testAccountsConfig.staffSecondary.loginPassword,
    });
    customerToken = await login({
      app,
      loginName: testAccountsConfig.guestPrimary.loginName,
      loginPassword: testAccountsConfig.guestPrimary.loginPassword,
    });
    adminToken = await login({
      app,
      loginName: testAccountsConfig.admin.loginName,
      loginPassword: testAccountsConfig.admin.loginPassword,
    });
    engineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staff.loginName,
    );
    otherEngineerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.staffSecondary.loginName,
    );
    customerAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.guestPrimary.loginName,
    );
    engineerNickname = (
      await dataSource
        .getRepository(UserInfoEntity)
        .findOneByOrFail({ accountId: engineerAccountId })
    ).nickname;

    // 混合角色账号：先以造数 identityHint=ENGINEER 登录得到 activeRole=ENGINEER 的 Token，
    // 再切换 identityHint=SUPER_ADMIN 后重新登录得到 activeRole=SUPER_ADMIN 的 Token
    hybridTokenEngineer = await login({
      app,
      loginName: testAccountsConfig.hybridStaff.loginName,
      loginPassword: testAccountsConfig.hybridStaff.loginPassword,
    });
    hybridAccountId = await getAccountIdByLoginName(
      dataSource,
      testAccountsConfig.hybridStaff.loginName,
    );
    await dataSource
      .getRepository(AccountEntity)
      .update({ id: hybridAccountId }, { identityHint: IdentityTypeEnum.SUPER_ADMIN });
    // 受控变更成功后才更新台账预期，不得在写入前预置期望值
    updateOwnedExpectation(ownership, 'account', hybridAccountId, {
      identityHint: IdentityTypeEnum.SUPER_ADMIN,
    });
    hybridTokenSuperAdmin = await login({
      app,
      loginName: testAccountsConfig.hybridStaff.loginName,
      loginPassword: testAccountsConfig.hybridStaff.loginPassword,
    });

    // 合法签名但无 activeRole 的兼容性 Token：使用项目真实签发入口 TokenHelper（不伪造签名），
    // 模拟旧 Token 场景以验证失败关闭
    const hybridNickname = (
      await dataSource.getRepository(UserInfoEntity).findOneByOrFail({ accountId: hybridAccountId })
    ).nickname;
    noActiveRoleToken = app.get(TokenHelper).generateAccessToken({
      payload: {
        sub: hybridAccountId,
        username: hybridNickname,
        email: testAccountsConfig.hybridStaff.loginEmail,
        accessGroup: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
      },
      audience: AudienceTypeEnum.DESKTOP,
    });

    const model = await modelRepository.save(
      modelRepository.create({
        modelCode: MODEL_CODE,
        modelName: MODEL_NAME,
        enabled: true,
        sortOrder: 1,
      }),
    );
    recordOwnedResource(ownership, 'equipmentModel', model.id, {
      modelCode: MODEL_CODE,
      modelName: MODEL_NAME,
      enabled: true,
      sortOrder: 1,
    });

    const buildRequest = (seed: RequestSeed) => {
      const suffix = seed.requestNo.split('-').pop();
      const acceptedByEngineerAccountId =
        seed.acceptedBy === 'engineer'
          ? engineerAccountId
          : seed.acceptedBy === 'other'
            ? otherEngineerAccountId
            : seed.acceptedBy === 'hybrid'
              ? hybridAccountId
              : null;
      return {
        requestNo: seed.requestNo,
        customerAccountId,
        equipmentModelId: model.id,
        errorCode: `E-4${suffix}`,
        faultDescription: `${seed.scene}场景`,
        contentMd: `# E2E-${suffix}`,
        createdAt: new Date('2026-09-01T01:00:00.000Z'),
        isAccepted: acceptedByEngineerAccountId !== null,
        acceptedByEngineerAccountId,
        acceptedAt:
          acceptedByEngineerAccountId === null ? null : new Date('2026-09-01T02:00:00.000Z'),
        deprecated: seed.deprecated ?? false,
        deletedAt: seed.deprecated ? new Date('2026-09-01T03:00:00.000Z') : null,
      };
    };

    const savedRequests = await requestRepository.save(
      requestRepository.create(REQUEST_SEEDS.map(buildRequest)),
    );
    for (const request of savedRequests) {
      const seed = REQUEST_SEEDS.find((candidate) => candidate.requestNo === request.requestNo);
      if (seed) {
        requestIdByKey[seed.key] = request.id;
        recordOwnedResource(ownership, 'repairRequest', request.id, {
          requestNo: seed.requestNo,
          customerAccountId,
          equipmentModelId: model.id,
          errorCode: `E-4${seed.requestNo.split('-').pop()}`,
          faultDescription: `${seed.scene}场景`,
        });
      }
    }
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'repair-request-response.e2e afterAll',
          owned: ownership,
          residue: {
            accounts: residueAccounts,
            equipmentModels: [residueModel],
            repairRequests: residueRequests,
          },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  describe('权限矩阵（拒绝路径全程不产生写入）', () => {
    const forbiddenCases = [
      ['CUSTOMER', () => customerToken],
      ['SUPER_ADMIN', () => adminToken],
      ['混合角色 activeRole=SUPER_ADMIN', () => hybridTokenSuperAdmin],
      ['合法签名但无 activeRole 的兼容性 Token', () => noActiveRoleToken],
    ] as const;

    it.each(forbiddenCases)(
      '%s 调回复被拒绝（写入口精确 ENGINEER，读权限继承不等于写权限继承）',
      async (_label, token) => {
        const response = await createResponse(
          token(),
          validInput(requestIdByKey.forbiddenTarget),
        ).expect(200);

        expect(response.body.errors).toHaveLength(1);
        expectForbidden(response.body.errors[0]);
        // 拒绝路径不启动写事务：目标申请无任何回复行
        expect(await countResponses(requestIdByKey.forbiddenTarget)).toBe(0);
      },
    );

    it('未登录调回复返回 UNAUTHENTICATED', async () => {
      const response = await createResponse(
        undefined,
        validInput(requestIdByKey.forbiddenTarget),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectUnauthenticated(response.body.errors[0]);
      expect(await countResponses(requestIdByKey.forbiddenTarget)).toBe(0);
    });

    it('非接单人工程师调回复统一 NOT_FOUND（不泄露他人接单状态）', async () => {
      const response = await createResponse(
        otherEngineerToken,
        validInput(requestIdByKey.acceptedByEngineer),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectNotFound(response.body.errors[0]);
      // 拒绝路径不以非接单工程师身份产生回复行；按归属计数，
      // 与后续成功闭环用例向同一申请追加回复的执行顺序无关
      expect(
        await responseRepository.count({
          where: {
            requestId: requestIdByKey.acceptedByEngineer,
            engineerAccountId: otherEngineerAccountId,
          },
        }),
      ).toBe(0);
    });
  });

  describe('混合角色 activeRole=ENGINEER 精确准入', () => {
    it('activeRole=ENGINEER 的合法 Token 可回复自己接单的申请', async () => {
      const response = await createResponse(
        hybridTokenEngineer,
        validInput(requestIdByKey.hybridAccepted, { responseText: '混合角色工程师回复' }),
      ).expect(200);

      expect(response.body.errors).toBeUndefined();
      const hybridNickname = (
        await dataSource
          .getRepository(UserInfoEntity)
          .findOneByOrFail({ accountId: hybridAccountId })
      ).nickname;
      expect(response.body.data.createEngineerResponse).toMatchObject({
        responseText: '混合角色工程师回复',
        resolutionStatus: 'PENDING',
        engineerNickname: hybridNickname,
      });

      const rows = await responseRepository.findBy({ requestId: requestIdByKey.hybridAccepted });
      expect(rows).toHaveLength(1);
      // 回复人取自可信 Session（混合账号本身），接收人取自目标申请
      expect(rows[0].engineerAccountId).toBe(hybridAccountId);
      expect(rows[0].customerAccountId).toBe(customerAccountId);
    });
  });

  describe('状态裁决与防探测', () => {
    it('回复不存在的申请返回 NOT_FOUND', async () => {
      const response = await createResponse(
        engineerToken,
        validInput(NON_EXISTENT_REQUEST_ID),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expectNotFound(response.body.errors[0]);
      // 前端契约依赖点：业务消息只读 extensions.errorMessage
      expect(typeof response.body.errors[0].extensions.errorMessage).toBe('string');
      expect(response.body.errors[0].extensions.errorMessage.length).toBeGreaterThan(0);
    });

    it('不存在 / 已删除 / 他人已接单三类不可访问文案完全一致（防探测）', async () => {
      const nonExistent = await createResponse(
        engineerToken,
        validInput(NON_EXISTENT_REQUEST_ID),
      ).expect(200);
      const deleted = await createResponse(
        engineerToken,
        validInput(requestIdByKey.deleted),
      ).expect(200);
      const acceptedByOther = await createResponse(
        engineerToken,
        validInput(requestIdByKey.acceptedByOther),
      ).expect(200);

      const messages = [nonExistent, deleted, acceptedByOther].map(
        (response) => response.body.errors[0].extensions.errorMessage,
      );
      expect(new Set(messages).size).toBe(1);
      [deleted, acceptedByOther].forEach((response) => expectNotFound(response.body.errors[0]));

      // 两类不可访问均不产生写入，已删除申请保持未接单的软删除终态
      expect(await countResponses(requestIdByKey.deleted)).toBe(0);
      expect(await countResponses(requestIdByKey.acceptedByOther)).toBe(0);
      const deletedRow = await requestRepository.findOneOrFail({
        where: { id: requestIdByKey.deleted },
      });
      expect(deletedRow).toMatchObject({
        deprecated: true,
        isAccepted: false,
        acceptedByEngineerAccountId: null,
      });
    });

    it('回复未接单的申请返回 CONFLICT(NOT_ACCEPTED)，details 只含 requestId', async () => {
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.notAccepted),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      const error = response.body.errors[0];
      expect(error.extensions.code).toBe('CONFLICT');
      expect(error.extensions.errorCode).toBe('REPAIR_REQUEST_NOT_ACCEPTED');
      expect(error.extensions.errorMessage).toBe('维修申请尚未接单，请先接单后回复');
      expect(error.extensions.details).toEqual({ requestId: requestIdByKey.notAccepted });
      // 错误响应不含归属类身份字段
      expect(JSON.stringify(error)).not.toContain('engineerAccountId');
      expect(JSON.stringify(error)).not.toContain('customerAccountId');
      expect(await countResponses(requestIdByKey.notAccepted)).toBe(0);
    });
  });

  describe('输入错误（拒绝且不落库）', () => {
    it.each([
      ['空字符串', ''],
      ['纯空白字符', '  \n\t  '],
    ])('回复正文为%s时返回 BAD_USER_INPUT', async (_label, responseText) => {
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.invalidInputTarget, { responseText }),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
      );
      expect(await countResponses(requestIdByKey.invalidInputTarget)).toBe(0);
    });

    it.each([0, -1])('requestId=%i 在装配层被拒（正整数约束）', async (requestId) => {
      const response = await createResponse(engineerToken, validInput(requestId)).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].message).toContain('维修申请 ID 必须大于 0');
      // 处理状态是契约内的合法字段，不得被装配层当作未知属性拒绝
      expect(response.body.errors[0].message).not.toContain('should not exist');
    });

    it('客户端试图传入归属账号 ID 在契约层被拒绝（归属不可由客户端指定）', async () => {
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.whitelistTarget, {
          engineerAccountId: otherEngineerAccountId,
          customerAccountId: hybridAccountId,
        }),
      ).expect(400);

      // 归属账号 ID 在 GraphQL 输入类型中根本不存在，变量校验阶段即拒绝（早于装配层与业务层）
      expect(response.body.errors).toHaveLength(2);
      response.body.errors.forEach((error: { extensions: Record<string, unknown> }) => {
        expect(error.extensions.code).toBe('BAD_USER_INPUT');
      });
      const messages = response.body.errors
        .map((error: { message: string }) => error.message)
        .join(' | ');
      expect(messages).toContain(
        'Field "engineerAccountId" is not defined by type "CreateEngineerResponseInput"',
      );
      expect(messages).toContain(
        'Field "customerAccountId" is not defined by type "CreateEngineerResponseInput"',
      );
      // 目标申请不因被构造的越权输入产生任何回复
      expect(await countResponses(requestIdByKey.whitelistTarget)).toBe(0);
    });

    it('输入校验先于目标查询：非法正文 + 不存在的申请仍是 BAD_USER_INPUT（不泄露存在性）', async () => {
      const response = await createResponse(
        engineerToken,
        validInput(NON_EXISTENT_REQUEST_ID, { responseText: '   ' }),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(response.body.errors[0].extensions.errorCode).toBe(
        'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
      );
    });

    it('非法处理状态被 GraphQL 运行时 enum 校验拦截，不产生写入', async () => {
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.invalidInputTarget, { resolutionStatus: 'DONE' }),
      ).expect(400);

      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
      expect(JSON.stringify(response.body.errors)).toContain('resolutionStatus');
      // 值域拦截发生在执行之前，不得误报为系统故障
      expect(response.body.errors[0].extensions.code).not.toBe('INTERNAL_SERVER_ERROR');
      expect(await countResponses(requestIdByKey.invalidInputTarget)).toBe(0);
    });
  });

  describe('回复正文容量（MySQL TEXT UTF-8 字节上限 65,535）', () => {
    // 成功与超限使用相互隔离的专用 fixture，且超限用例均不写入（count 恒为 0），
    // 因此不依赖同文件其他 it 的执行结果，支持 -t 单独运行与任意声明顺序。
    it('65,535 ASCII bytes 成功写入，数据库实际存储正文字节数正确', async () => {
      const text = 'a'.repeat(65535);
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.capacityOk, { responseText: text }),
      ).expect(200);

      expect(response.body.errors).toBeUndefined();
      expect(
        Buffer.byteLength(response.body.data.createEngineerResponse.responseText, 'utf8'),
      ).toBe(65535);

      const rows = await responseRepository.findBy({ requestId: requestIdByKey.capacityOk });
      expect(rows).toHaveLength(1);
      expect(rows[0].responseText).toBe(text);
      // 数据库真实落库的正文字节数恰为 65,535（MySQL TEXT 上限）
      expect(Buffer.byteLength(rows[0].responseText, 'utf8')).toBe(65535);
    });

    const expectOverCapacityRejected = async (responseText: string) => {
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.capacityOver, { responseText }),
      ).expect(200);

      expect(response.body.errors).toHaveLength(1);
      const error = response.body.errors[0];
      // 稳定大类必须是 BAD_USER_INPUT，不得映射为 INTERNAL_SERVER_ERROR
      expect(error.extensions.code).toBe('BAD_USER_INPUT');
      expect(error.extensions.code).not.toBe('INTERNAL_SERVER_ERROR');
      // 输入容量错误码，而非系统侧「回复落库失败」的 response-failed 语义
      expect(error.extensions.errorCode).toBe('INPUT_NORMALIZE_INVALID_TEXT');
      expect(error.extensions.errorCode).not.toBe('REPAIR_REQUEST_RESPONSE_FAILED');
      expect(error.extensions.errorMessage).toBe('回复正文不能超过 65,535 字节（按 UTF-8 计算）');
      // 超限在写服务之前被拒绝：目标申请无任何回复行
      expect(await countResponses(requestIdByKey.capacityOver)).toBe(0);
    };

    it('65,536 ASCII bytes 返回 BAD_USER_INPUT 且不产生回复记录', async () => {
      await expectOverCapacityRejected('a'.repeat(65536));
    });

    it('中文超限（21,846 字 = 65,538 bytes）返回 BAD_USER_INPUT 且不产生回复记录', async () => {
      await expectOverCapacityRejected('中'.repeat(21846));
    });

    it('emoji 超限（16,384 个 = 65,536 bytes）返回 BAD_USER_INPUT 且不产生回复记录', async () => {
      await expectOverCapacityRejected('😀'.repeat(16384));
    });
  });

  describe('成功闭环与追加语义', () => {
    // 三个用例各自使用独立的目标申请 fixture（141 / 152 / 153），
    // 并在自身内部造所需的前置回复，不依赖同文件其他 it 的执行结果，
    // 支持 -t 单独运行与任意声明顺序。
    it('回复成功：DTO 只含本次新建回复，正文 trim 落库，归属由会话与目标申请派生', async () => {
      const response = await createResponse(
        engineerToken,
        validInput(requestIdByKey.acceptedByEngineer, { responseText: '  已更换备件并复测通过  ' }),
      ).expect(200);

      expect(response.body.errors).toBeUndefined();
      const created = response.body.data.createEngineerResponse;
      expect(created).toMatchObject({
        resolutionStatus: 'PENDING',
        responseText: '已更换备件并复测通过',
        engineerNickname,
      });
      expect(typeof created.id).toBe('number');
      expect(created.createdAt).not.toBeNull();
      // 契约防泄漏：对外 DTO 不含归属账号 ID
      expect(JSON.stringify(created)).not.toContain('engineerAccountId');
      expect(JSON.stringify(created)).not.toContain('customerAccountId');

      const rows = await responseRepository.findBy({
        requestId: requestIdByKey.acceptedByEngineer,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: created.id,
        requestId: requestIdByKey.acceptedByEngineer,
        engineerAccountId,
        customerAccountId,
        resolutionStatus: 'PENDING',
        responseText: '已更换备件并复测通过',
      });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
      // 回复不改变申请自身的接单事实
      const requestRow = await requestRepository.findOneOrFail({
        where: { id: requestIdByKey.acceptedByEngineer },
      });
      expect(requestRow).toMatchObject({
        isAccepted: true,
        acceptedByEngineerAccountId: engineerAccountId,
        deprecated: false,
        deletedAt: null,
      });
    });

    it('追加回复不更新历史回复：详情时间线正序、latestResolutionStatus 取末条', async () => {
      // 本用例使用专用申请 fixture，在内部造前置回复（不依赖上一个 it 的写入）
      const first = await createResponse(
        engineerToken,
        validInput(requestIdByKey.appendSemantic, { responseText: '已更换备件并复测通过' }),
      ).expect(200);
      expect(first.body.errors).toBeUndefined();

      const second = await createResponse(
        engineerToken,
        validInput(requestIdByKey.appendSemantic, {
          responseText: '设备已恢复正常，结案',
          resolutionStatus: 'RESOLVED',
        }),
      ).expect(200);
      expect(second.body.errors).toBeUndefined();

      const detail = await postGql({
        app,
        query: ENGINEER_DETAIL_QUERY,
        variables: { id: requestIdByKey.appendSemantic },
        token: engineerToken,
      }).expect(200);
      expect(detail.body.errors).toBeUndefined();

      const responses = detail.body.data.engineerRepairRequest.responses;
      expect(responses).toHaveLength(2);
      // 历史回复未被覆盖，时间线按 createdAt ASC + id ASC
      expect(responses[0]).toMatchObject({
        id: first.body.data.createEngineerResponse.id,
        responseText: '已更换备件并复测通过',
        resolutionStatus: 'PENDING',
        engineerNickname,
      });
      expect(responses[1]).toMatchObject({
        id: second.body.data.createEngineerResponse.id,
        responseText: '设备已恢复正常，结案',
        resolutionStatus: 'RESOLVED',
      });
      expect(responses[0].id).toBeLessThan(responses[1].id);
      expect(new Date(responses[0].createdAt).getTime()).toBeLessThanOrEqual(
        new Date(responses[1].createdAt).getTime(),
      );
      expect(detail.body.data.engineerRepairRequest.latestResolutionStatus).toBe('RESOLVED');
    });

    it('客户详情与工程师 MINE 列表同步反映最新回复状态', async () => {
      // 本用例使用专用申请 fixture，在内部造两条回复（不依赖前两个 it）
      await createResponse(
        engineerToken,
        validInput(requestIdByKey.readSync, { responseText: '已初步处理' }),
      ).expect(200);
      await createResponse(
        engineerToken,
        validInput(requestIdByKey.readSync, {
          responseText: '已结案',
          resolutionStatus: 'RESOLVED',
        }),
      ).expect(200);

      const customerDetail = await postGql({
        app,
        query: MY_DETAIL_QUERY,
        variables: { id: requestIdByKey.readSync },
        token: customerToken,
      }).expect(200);
      expect(customerDetail.body.errors).toBeUndefined();
      expect(customerDetail.body.data.myRepairRequest.latestResolutionStatus).toBe('RESOLVED');
      expect(customerDetail.body.data.myRepairRequest.responses).toHaveLength(2);
      // 客户侧只看到安全昵称，不暴露工程师账号 ID
      expect(customerDetail.body.data.myRepairRequest.responses[0].engineerNickname).toBe(
        engineerNickname,
      );
      expect(JSON.stringify(customerDetail.body.data)).not.toContain('engineerAccountId');

      const mine = await postGql({
        app,
        query: ENGINEER_LIST_QUERY,
        variables: { scope: 'MINE', pagination: OFFSET_PAGINATION },
        token: engineerToken,
      }).expect(200);
      expect(mine.body.errors).toBeUndefined();
      const mineItem = mine.body.data.engineerRepairRequests.items.find(
        (item: { id: number }) => item.id === requestIdByKey.readSync,
      );
      expect(mineItem).toBeDefined();
      expect(mineItem.latestResolutionStatus).toBe('RESOLVED');
    });
  });

  describe('并发', () => {
    it('同一工程师两条回复真实并发：均成功追加，历史不被覆盖', async () => {
      // 同一事件循环真实并发发出两个 Mutation，不做任何先后编排
      const [first, second] = await Promise.all([
        createResponse(
          engineerToken,
          validInput(requestIdByKey.concurrentAppend, { responseText: '并发回复 A' }),
        ),
        createResponse(
          engineerToken,
          validInput(requestIdByKey.concurrentAppend, {
            responseText: '并发回复 B',
            resolutionStatus: 'RESOLVED',
          }),
        ),
      ]);

      expect(first.body.errors).toBeUndefined();
      expect(second.body.errors).toBeUndefined();

      const rows = await responseRepository.findBy({ requestId: requestIdByKey.concurrentAppend });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
      expect(rows.map((row) => row.responseText).sort()).toEqual(['并发回复 A', '并发回复 B']);
      expect(rows.every((row) => row.engineerAccountId === engineerAccountId)).toBe(true);
      expect(rows.every((row) => row.customerAccountId === customerAccountId)).toBe(true);
    });

    it('未接单申请上「接单 + 回复」真实并发：接单必成功，回复只可能成功或 NOT_ACCEPTED', async () => {
      const [acceptResponse, responseResponse] = await Promise.all([
        postGql({
          app,
          query: ACCEPT_MUTATION,
          variables: { id: requestIdByKey.concurrentAccept },
          token: engineerToken,
        }),
        createResponse(
          engineerToken,
          validInput(requestIdByKey.concurrentAccept, { responseText: '接单与回复并发' }),
        ),
      ]);

      expect(acceptResponse.body.errors).toBeUndefined();
      expect(acceptResponse.body.data.acceptRepairRequest.isAccepted).toBe(true);

      const requestRow = await requestRepository.findOneOrFail({
        where: { id: requestIdByKey.concurrentAccept },
      });
      expect(requestRow).toMatchObject({
        isAccepted: true,
        acceptedByEngineerAccountId: engineerAccountId,
      });

      const rows = await responseRepository.findBy({ requestId: requestIdByKey.concurrentAccept });
      if (responseResponse.body.errors) {
        // 回复先拿到行锁：此刻尚未接单，只能是业务状态冲突，且不产生写入
        expect(responseResponse.body.errors).toHaveLength(1);
        expect(responseResponse.body.errors[0].extensions.code).toBe('CONFLICT');
        expect(responseResponse.body.errors[0].extensions.errorCode).toBe(
          'REPAIR_REQUEST_NOT_ACCEPTED',
        );
        expect(rows).toHaveLength(0);
      } else {
        // 接单先提交：回复在行锁之后看到已接单事实，成功追加恰好一条
        expect(responseResponse.body.data.createEngineerResponse).toMatchObject({
          responseText: '接单与回复并发',
          engineerNickname,
        });
        expect(rows).toHaveLength(1);
      }
      // 终态自洽：不存在「回复行归属他人」或「无接单却有回复」的状态
      expect(rows.every((row) => row.engineerAccountId === engineerAccountId)).toBe(true);
      expect(rows.length === 0 || requestRow.isAccepted).toBe(true);
    });
  });
});
