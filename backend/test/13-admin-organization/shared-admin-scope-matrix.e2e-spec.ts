// test/13-admin-organization/shared-admin-scope-matrix.e2e-spec.ts
//
// E1 · 一级管理员 + A/B 两个二级管理员的当前共享权限矩阵（真实 GraphQL + REST + MySQL）。
//
// 目标（只补证据，不改业务）：
// 1. 一级、A 二级、B 二级都在请求期查库口径下真实登录，并能读取首页/本人设置；
// 2. 公司档案：一级完整名单可用，二级完整名单/详情一律拒绝，名称名单两类均可读；
// 3. 用户管理：一级全平台、A 只见本公司、B 只见本公司；A 以 B 的用户 ID 直调被拒；
// 4. 原件：一级可跨公司读/下载；A 只能读/下载本公司工单原件，B 的原件返回 NOT_FOUND；
//    SUPER_ADMIN 无上传能力（写入不适用，上传入口只对 ENGINEER 开放）；
// 5. 文档数据库/工单：一级管理员全公司，二级管理员仅本公司（列表与详情同口径）；跨公司详情
//    统一 NOT_FOUND，不泄露存在性。工单组织范围与原件授权是两条独立事实，不互相推导。
//
// 造数纪律：组织/账号/成员/设备型号/报修原始输入/工单/原件/过程关联都按本轮真实主键
// 登记到归属台账；afterAll 在单事务内预检后按精确 ID 删除，外部哨兵（B 公司数据）只读比对。
// 本规格不打印、不落盘任何口令、哈希或 Token；只断言布尔、数量与业务字段。

import {
  AccountStatus,
  AudienceTypeEnum,
  IdentityTypeEnum,
  LoginTypeEnum,
} from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { AccountEntity } from '../../src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '../../src/modules/account/base/entities/user-info.entity';
import { EquipmentModelEntity } from '../../src/modules/lithography/entities/equipment-model.entity';
import { RepairProcessEntryEntity } from '../../src/modules/lithography/entities/repair-process-entry.entity';
import { RepairRequestEntity } from '../../src/modules/lithography/entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../../src/modules/lithography/entities/repair-request-intake.entity';
import { StoredFileEntity } from '../../src/modules/lithography/entities/stored-file.entity';
import { CreateAccountUsecase } from '../../src/usecases/account/create-account.usecase';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '../../src/usecases/common/ports/stored-file-storage.contract';
import { getAccountIdByLoginName, postGql } from '../utils/e2e-graphql-utils';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { createTestAccount, type TestAccountConfig } from '../utils/test-accounts';
import {
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

type GqlError = { message: string; extensions?: { code?: string } };
type GqlBody<T> = { data?: T; errors?: GqlError[] };

const RUN_TAG = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
const ORGANIZATION_CODES = {
  primary: `E2E_SHARED_A_${RUN_TAG}`.toUpperCase(),
  peer: `E2E_SHARED_B_${RUN_TAG}`.toUpperCase(),
};

const PASSWORD_PREFIX = 'ShareScope#2026';

const accountProfiles = {
  levelOne: {
    loginName: `e2esharelv1_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}a`,
    role: IdentityTypeEnum.SUPER_ADMIN,
  },
  levelTwoA: {
    loginName: `e2esharelv2a_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}b`,
    role: IdentityTypeEnum.SUPER_ADMIN,
  },
  levelTwoB: {
    loginName: `e2esharelv2b_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}c`,
    role: IdentityTypeEnum.SUPER_ADMIN,
  },
  engineerA: {
    loginName: `e2eshareenga_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}d`,
    role: IdentityTypeEnum.ENGINEER,
  },
  engineerB: {
    loginName: `e2eshareengb_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}e`,
    role: IdentityTypeEnum.ENGINEER,
  },
  customerA: {
    loginName: `e2esharecusta_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}f`,
    role: IdentityTypeEnum.CUSTOMER,
  },
  customerB: {
    loginName: `e2esharecustb_${RUN_TAG}`,
    password: `${PASSWORD_PREFIX}g`,
    role: IdentityTypeEnum.CUSTOMER,
  },
} as const;

const buildAccountConfig = (profile: {
  loginName: string;
  password: string;
  role: IdentityTypeEnum;
}): TestAccountConfig => ({
  loginName: profile.loginName,
  loginEmail: `${profile.loginName}@e2e.example.com`,
  loginPassword: profile.password,
  status: AccountStatus.ACTIVE,
  accessGroup: [profile.role],
  identityType: profile.role,
});

const LOGIN_MUTATION = `
  mutation SharedScopeLogin($input: AuthLoginInput!) {
    login(input: $input) { accessToken }
  }
`;

const MY_ACCOUNT_SETTINGS_QUERY = `
  query SharedScopeMyAccountSettings {
    myAccountSettings { loginName nickname role status }
  }
`;

const ADMIN_ORGANIZATION_LIST_QUERY = `
  query SharedScopeOrganizationList($pagination: PaginationArgs!) {
    adminOrganizationList(pagination: $pagination) {
      items { id name organizationCode }
      total
    }
  }
`;

const ADMIN_ORGANIZATION_DETAIL_QUERY = `
  query SharedScopeOrganizationDetail($organizationId: Int!) {
    adminOrganizationDetail(organizationId: $organizationId) { id name }
  }
`;

const ADMIN_ORGANIZATION_NAME_LIST_QUERY = `
  query SharedScopeOrganizationNameList($keyword: String, $pagination: PaginationArgs!) {
    adminOrganizationNameList(keyword: $keyword, pagination: $pagination) {
      items { id name }
      total
    }
  }
`;

const ADMIN_USERS_QUERY = `
  query SharedScopeAdminUsers($pagination: PaginationArgs!, $keyword: String) {
    adminUsers(pagination: $pagination, keyword: $keyword) {
      items { id loginName }
      total
    }
  }
`;

const ADMIN_SET_USER_STATUS_MUTATION = `
  mutation SharedScopeSetUserStatus($input: AdminSetUserStatusInput!) {
    adminSetUserStatus(input: $input) { id status }
  }
`;

const ADMIN_REPAIR_REQUESTS_QUERY = `
  query SharedScopeAdminRepairRequests($pagination: PaginationArgs!, $filter: AdminRepairRequestFilterInput) {
    adminRepairRequests(pagination: $pagination, filter: $filter) {
      items { id requestNo }
      total
    }
  }
`;

const ADMIN_REPAIR_REQUEST_SUMMARY_QUERY = `
  query SharedScopeAdminRepairRequestSummary($id: Int!) {
    adminRepairRequestSummary(id: $id) { id requestNo faultDescription }
  }
`;

describe('E1 一级/二级管理员共享权限矩阵 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let storage: StoredFileStorage;
  const ownership: OwnedResourceLedger = createOwnedResourceLedger();
  const physicalStorageReferences: string[] = [];

  let primaryOrganizationId = 0;
  let peerOrganizationId = 0;
  let levelOneToken = '';
  let levelTwoAToken = '';
  let levelTwoBToken = '';
  let customerAAccountId = 0;
  let customerBAccountId = 0;
  let requestAId = 0;
  let requestBId = 0;
  let fileAId = '';
  let fileBId = '';
  const fileABytes = Buffer.from(`shared-scope-original-A-${RUN_TAG}`, 'utf8');
  const fileBBytes = Buffer.from(`shared-scope-original-B-${RUN_TAG}`, 'utf8');

  const gql = async <T>(
    query: string,
    variables: Record<string, unknown>,
    token?: string,
  ): Promise<GqlBody<T>> => {
    const response = await postGql({ app, query, variables, token });
    return response.body as GqlBody<T>;
  };

  const loginAs = async (profile: { loginName: string; password: string }): Promise<string> => {
    const response = await postGql({
      app,
      query: LOGIN_MUTATION,
      variables: {
        input: {
          loginName: profile.loginName,
          loginPassword: profile.password,
          type: LoginTypeEnum.PASSWORD,
          audience: AudienceTypeEnum.DESKTOP,
        },
      },
    });
    const token = (response.body as GqlBody<{ login?: { accessToken?: string } }>).data?.login
      ?.accessToken;
    if (!token) throw new Error('共享权限矩阵登录失败');
    return token;
  };

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);
    storage = moduleFixture.get<StoredFileStorage>(STORED_FILE_STORAGE);

    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: ORGANIZATION_CODES.primary,
          name: `E1 甲公司 ${RUN_TAG}`,
          kind: 'CLIENT',
        },
        {
          organizationCode: ORGANIZATION_CODES.peer,
          name: `E1 乙公司 ${RUN_TAG}`,
          kind: 'PEER',
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, ORGANIZATION_CODES.primary);
    peerOrganizationId = requireOrganizationId(organizationIds, ORGANIZATION_CODES.peer);

    const createAccountUsecase = app.get(CreateAccountUsecase);
    for (const profile of Object.values(accountProfiles)) {
      await createTestAccount(
        dataSource,
        createAccountUsecase,
        buildAccountConfig(profile),
        ownership,
      );
    }

    await seedTestMemberships({
      dataSource,
      organizationIdsByCode: organizationIds,
      ownership,
      memberships: [
        {
          accountLoginName: accountProfiles.levelOne.loginName,
          organizationCode: ORGANIZATION_CODES.primary,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: accountProfiles.levelTwoA.loginName,
          organizationCode: ORGANIZATION_CODES.primary,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: accountProfiles.levelTwoB.loginName,
          organizationCode: ORGANIZATION_CODES.peer,
          memberRole: 'SUPER_ADMIN',
        },
        {
          accountLoginName: accountProfiles.engineerA.loginName,
          organizationCode: ORGANIZATION_CODES.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: accountProfiles.engineerB.loginName,
          organizationCode: ORGANIZATION_CODES.peer,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: accountProfiles.customerA.loginName,
          organizationCode: ORGANIZATION_CODES.primary,
          memberRole: 'CUSTOMER',
        },
        {
          accountLoginName: accountProfiles.customerB.loginName,
          organizationCode: ORGANIZATION_CODES.peer,
          memberRole: 'CUSTOMER',
        },
      ],
    });

    const accountRepo = dataSource.getRepository(AccountEntity);
    const userInfoRepo = dataSource.getRepository(UserInfoEntity);
    const levelOne = await accountRepo.findOneOrFail({
      where: { loginName: accountProfiles.levelOne.loginName },
    });
    const levelTwoA = await accountRepo.findOneOrFail({
      where: { loginName: accountProfiles.levelTwoA.loginName },
    });
    const levelTwoB = await accountRepo.findOneOrFail({
      where: { loginName: accountProfiles.levelTwoB.loginName },
    });
    // 等级只由请求期查库决定：不写 JWT 字段
    await accountRepo.update(levelOne.id, { adminLevel: 1 });
    await accountRepo.update(levelTwoA.id, { adminLevel: 2 });
    await accountRepo.update(levelTwoB.id, { adminLevel: 2 });

    customerAAccountId = await getAccountIdByLoginName(
      dataSource,
      accountProfiles.customerA.loginName,
    );
    customerBAccountId = await getAccountIdByLoginName(
      dataSource,
      accountProfiles.customerB.loginName,
    );
    // 客户资料归属列决定二级管理员用户列表的可见范围
    await userInfoRepo.update(
      { accountId: customerAAccountId },
      {
        customerOrganizationId: primaryOrganizationId,
      },
    );
    await userInfoRepo.update(
      { accountId: customerBAccountId },
      {
        customerOrganizationId: peerOrganizationId,
      },
    );
    updateOwnedExpectation(ownership, 'account', customerAAccountId, {
      customerOrganizationId: primaryOrganizationId,
    });
    updateOwnedExpectation(ownership, 'account', customerBAccountId, {
      customerOrganizationId: peerOrganizationId,
    });

    levelOneToken = await loginAs(accountProfiles.levelOne);
    levelTwoAToken = await loginAs(accountProfiles.levelTwoA);
    levelTwoBToken = await loginAs(accountProfiles.levelTwoB);

    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    const model = await modelRepo.save(
      modelRepo.create({
        modelCode: `E1_SHARED_${RUN_TAG}`.toUpperCase(),
        modelName: `E1 共享矩阵机型 ${RUN_TAG}`,
        sortOrder: 0,
        enabled: true,
      }),
    );
    recordOwnedResource(ownership, 'equipmentModel', model.id, {
      modelCode: model.modelCode,
      modelName: model.modelName,
      enabled: model.enabled,
      sortOrder: model.sortOrder,
    });

    const createBoundRequest = async (params: {
      label: 'A' | 'B';
      customerAccountId: number;
      customerOrganizationId: number;
      engineerAccountId: number;
      serviceOrganizationId: number;
      fileBytes: Buffer;
    }): Promise<{ requestId: number; fileId: string }> => {
      const intakeRepo = dataSource.getRepository(RepairRequestIntakeEntity);
      const intake = await intakeRepo.save(
        intakeRepo.create({
          recordUuid: randomUUID(),
          customerAccountId: params.customerAccountId,
          customerOrganizationId: params.customerOrganizationId,
          serviceOrganizationId: params.serviceOrganizationId,
          equipmentModelId: model.id,
          errorCode: `E1-${params.label}-001`,
          faultDescription: `E1 共享矩阵 ${params.label} 公司故障`,
          fileId: null,
          analysisStatus: 'SUCCEEDED',
          analysisGeneration: 0,
          convertedRequestId: null,
          deletedAt: null,
        }),
      );
      recordOwnedResource(ownership, 'repairRequestIntake', intake.id, {
        recordUuid: intake.recordUuid,
        customerAccountId: intake.customerAccountId,
        customerOrganizationId: intake.customerOrganizationId,
        serviceOrganizationId: intake.serviceOrganizationId,
        equipmentModelId: intake.equipmentModelId,
        errorCode: intake.errorCode,
        faultDescription: intake.faultDescription,
        fileId: null,
      });

      const requestRepo = dataSource.getRepository(RepairRequestEntity);
      const request = await requestRepo.save(
        requestRepo.create({
          requestNo: `E1-SHARED-${params.label}-${RUN_TAG}`.toUpperCase(),
          intakeId: intake.id,
          customerOrganizationId: params.customerOrganizationId,
          serviceOrganizationId: params.serviceOrganizationId,
          closureStatus: null,
          closedAt: null,
          closureReason: null,
          currentRevisionNo: 0,
          customerAccountId: params.customerAccountId,
          equipmentModelId: model.id,
          errorCode: `E1-${params.label}-001`,
          faultDescription: `E1 共享矩阵 ${params.label} 公司故障`,
          contentMd: `# E1 共享矩阵 ${params.label}`,
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          ownerOrganizationId: params.serviceOrganizationId,
          handlingResult: null,
          handlingStatus: null,
          handlingRecordedAt: null,
          handlingRecordedByAccountId: null,
          handlingEndedAt: null,
          deprecated: false,
          deletedAt: null,
        }),
      );
      recordOwnedResource(ownership, 'repairRequest', request.id, {
        requestNo: request.requestNo,
        customerAccountId: request.customerAccountId,
        equipmentModelId: request.equipmentModelId,
        errorCode: request.errorCode,
        faultDescription: request.faultDescription,
      });
      await intakeRepo.update(intake.id, { convertedRequestId: request.id });

      const storageReference = await storage.save(params.fileBytes, 'txt');
      physicalStorageReferences.push(storageReference);
      const fileId = randomUUID();
      const uploadContextId = randomUUID();
      const checksumSha256 = createHash('sha256').update(params.fileBytes).digest('hex');
      const storedFileRepo = dataSource.getRepository(StoredFileEntity);
      await storedFileRepo.save(
        storedFileRepo.create({
          fileId,
          uploadedByAccountId: params.engineerAccountId,
          ownerOrganizationId: params.serviceOrganizationId,
          storageReference,
          originalFilename: `e1-shared-${params.label.toLowerCase()}.txt`,
          mimeType: 'text/plain',
          byteSize: String(params.fileBytes.byteLength),
          checksumSha256,
          status: 'VALID',
          businessType: 'REPAIR_PROCESS',
          businessId: String(request.id),
          uploadContextId,
          bindingStatus: 'BOUND',
          verifiedAt: new Date(),
        }),
      );
      recordOwnedResource(ownership, 'storedFile', fileId, {
        uploadedByAccountId: params.engineerAccountId,
        ownerOrganizationId: params.serviceOrganizationId,
        storageReference,
        originalFilename: `e1-shared-${params.label.toLowerCase()}.txt`,
        checksumSha256,
        uploadContextId,
      });

      const entryRepo = dataSource.getRepository(RepairProcessEntryEntity);
      const entry = await entryRepo.save(
        entryRepo.create({
          entryUuid: randomUUID(),
          requestId: request.id,
          authorAccountId: params.engineerAccountId,
          operationText: `E1 共享矩阵 ${params.label} 过程记录`,
          testResult: null,
          occurredAt: null,
          timeSource: 'SYSTEM',
          fileId,
          versionNo: 1,
        }),
      );
      recordOwnedResource(ownership, 'repairProcessEntry', Number(entry.id), {
        entryUuid: entry.entryUuid,
        requestId: entry.requestId,
        authorAccountId: entry.authorAccountId,
        fileId: entry.fileId,
      });

      return { requestId: request.id, fileId };
    };

    const engineerAAccountId = await getAccountIdByLoginName(
      dataSource,
      accountProfiles.engineerA.loginName,
    );
    const engineerBAccountId = await getAccountIdByLoginName(
      dataSource,
      accountProfiles.engineerB.loginName,
    );

    const requestA = await createBoundRequest({
      label: 'A',
      customerAccountId: customerAAccountId,
      customerOrganizationId: primaryOrganizationId,
      engineerAccountId: engineerAAccountId,
      serviceOrganizationId: primaryOrganizationId,
      fileBytes: fileABytes,
    });
    requestAId = requestA.requestId;
    fileAId = requestA.fileId;

    const requestB = await createBoundRequest({
      label: 'B',
      customerAccountId: customerBAccountId,
      customerOrganizationId: peerOrganizationId,
      engineerAccountId: engineerBAccountId,
      serviceOrganizationId: peerOrganizationId,
      fileBytes: fileBBytes,
    });
    requestBId = requestB.requestId;
    fileBId = requestB.fileId;
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (!dataSource?.isInitialized) return;

        for (const reference of physicalStorageReferences) {
          try {
            await storage.delete(reference);
          } catch {
            // 物理对象删除是尽力而为；数据库行仍由下面的精确台账回收
          }
        }

        await runGuardedSpecCleanup({
          dataSource,
          owned: ownership,
          helper: 'shared-admin-scope-matrix.e2e-spec afterAll 收尾',
        });

        const residue: Array<[string, number]> = [];
        const count = async (sql: string, params: unknown[]): Promise<number> => {
          const rows: Array<{ total: number | string }> = await dataSource.query(sql, params);
          return Number(rows[0]?.total ?? 0);
        };
        const inClause = (values: Array<number | string>): string =>
          values.map(() => '?').join(', ');

        const organizationIds = ownership.organizationIds;
        if (organizationIds.length > 0) {
          residue.push([
            'organization',
            await count(
              `SELECT COUNT(*) AS total FROM organization WHERE id IN (${inClause(organizationIds)})`,
              organizationIds,
            ),
          ]);
        }
        const accountIds = ownership.accountIds;
        if (accountIds.length > 0) {
          residue.push([
            'account',
            await count(
              `SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (${inClause(accountIds)})`,
              accountIds,
            ),
          ]);
          residue.push([
            'userInfo',
            await count(
              `SELECT COUNT(*) AS total FROM base_user_info WHERE account_id IN (${inClause(accountIds)})`,
              accountIds,
            ),
          ]);
        }
        const requestIds = ownership.repairRequestIds;
        if (requestIds.length > 0) {
          residue.push([
            'repairRequest',
            await count(
              `SELECT COUNT(*) AS total FROM repair_request WHERE id IN (${inClause(requestIds)})`,
              requestIds,
            ),
          ]);
        }
        const storedFileIds = ownership.storedFileIds;
        if (storedFileIds.length > 0) {
          residue.push([
            'storedFile',
            await count(
              `SELECT COUNT(*) AS total FROM stored_file WHERE file_id IN (${inClause(storedFileIds)})`,
              storedFileIds,
            ),
          ]);
        }
        const entryIds = ownership.repairProcessEntryIds;
        if (entryIds.length > 0) {
          residue.push([
            'repairProcessEntry',
            await count(
              `SELECT COUNT(*) AS total FROM repair_process_entry WHERE id IN (${inClause(entryIds)})`,
              entryIds,
            ),
          ]);
        }

        expect(residue.every(([, total]) => total === 0)).toBe(true);
      },
      closeApp: app
        ? async () => {
            await app.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  it('一级、A 二级、B 二级都真实登录并可读取本人设置', async () => {
    for (const token of [levelOneToken, levelTwoAToken, levelTwoBToken]) {
      const body = await gql<{
        myAccountSettings: { loginName: string; role: IdentityTypeEnum; status: AccountStatus };
      }>(MY_ACCOUNT_SETTINGS_QUERY, {}, token);
      expect(body.errors).toBeUndefined();
      expect(body.data?.myAccountSettings.role).toBe(IdentityTypeEnum.SUPER_ADMIN);
      expect(body.data?.myAccountSettings.status).toBe(AccountStatus.ACTIVE);
    }
  });

  it('公司档案：一级完整名单可用，A 二级被拒，名称名单两级均可读', async () => {
    const levelOneList = await gql<{
      adminOrganizationList: { items: Array<{ id: number; name: string }>; total: number };
    }>(
      ADMIN_ORGANIZATION_LIST_QUERY,
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100 },
      },
      levelOneToken,
    );
    expect(levelOneList.errors).toBeUndefined();
    const observedIds = (levelOneList.data?.adminOrganizationList.items ?? []).map(
      (item) => item.id,
    );
    expect(observedIds).toEqual(
      expect.arrayContaining([primaryOrganizationId, peerOrganizationId]),
    );

    const levelTwoList = await gql<{
      adminOrganizationList: { items: Array<{ id: number; name: string }>; total: number };
    }>(
      ADMIN_ORGANIZATION_LIST_QUERY,
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      },
      levelTwoAToken,
    );
    expect(levelTwoList.data?.adminOrganizationList).toBeUndefined();
    expect(levelTwoList.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    const levelTwoDetail = await gql<{
      adminOrganizationDetail: { id: number; name: string };
    }>(
      ADMIN_ORGANIZATION_DETAIL_QUERY,
      {
        organizationId: peerOrganizationId,
      },
      levelTwoAToken,
    );
    expect(levelTwoDetail.data?.adminOrganizationDetail).toBeUndefined();
    expect(levelTwoDetail.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    for (const token of [levelOneToken, levelTwoAToken, levelTwoBToken]) {
      const nameList = await gql<{
        adminOrganizationNameList: { items: Array<{ id: number; name: string }>; total: number };
      }>(
        ADMIN_ORGANIZATION_NAME_LIST_QUERY,
        {
          keyword: 'E1 ',
          pagination: { mode: 'OFFSET', page: 1, pageSize: 50 },
        },
        token,
      );
      expect(nameList.errors).toBeUndefined();
      const ids = (nameList.data?.adminOrganizationNameList.items ?? []).map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([primaryOrganizationId, peerOrganizationId]));
    }
  });

  it('用户管理：一级全平台，A/B 各自只见本公司，A 以 B 的用户 ID 直调被拒', async () => {
    const levelOne = await gql<{
      adminUsers: { items: Array<{ id: number; loginName: string }>; total: number };
    }>(
      ADMIN_USERS_QUERY,
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100 },
      },
      levelOneToken,
    );
    expect(levelOne.errors).toBeUndefined();
    const levelOneIds = (levelOne.data?.adminUsers.items ?? []).map((item) => item.id);
    expect(levelOneIds).toEqual(expect.arrayContaining([customerAAccountId, customerBAccountId]));

    const levelTwoA = await gql<{
      adminUsers: { items: Array<{ id: number; loginName: string }>; total: number };
    }>(
      ADMIN_USERS_QUERY,
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100 },
      },
      levelTwoAToken,
    );
    expect(levelTwoA.errors).toBeUndefined();
    const aIds = (levelTwoA.data?.adminUsers.items ?? []).map((item) => item.id);
    expect(aIds).toContain(customerAAccountId);
    expect(aIds).not.toContain(customerBAccountId);

    const levelTwoB = await gql<{
      adminUsers: { items: Array<{ id: number; loginName: string }>; total: number };
    }>(
      ADMIN_USERS_QUERY,
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100 },
      },
      levelTwoBToken,
    );
    expect(levelTwoB.errors).toBeUndefined();
    const bIds = (levelTwoB.data?.adminUsers.items ?? []).map((item) => item.id);
    expect(bIds).toContain(customerBAccountId);
    expect(bIds).not.toContain(customerAAccountId);

    const crossWrite = await gql<{
      adminSetUserStatus: { id: number; status: AccountStatus };
    }>(
      ADMIN_SET_USER_STATUS_MUTATION,
      {
        input: { accountId: customerBAccountId, status: AccountStatus.INACTIVE },
      },
      levelTwoAToken,
    );
    expect(crossWrite.data?.adminSetUserStatus).toBeUndefined();
    expect(crossWrite.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');

    // B 的账号事实只读比对：A 的越权尝试后仍为 ACTIVE
    const customerB = await dataSource
      .getRepository(AccountEntity)
      .findOneByOrFail({ id: customerBAccountId });
    expect(customerB.status).toBe(AccountStatus.ACTIVE);
  });

  it('原件读/下载：一级跨公司可读，二级仅本公司，跨公司返回 NOT_FOUND；上传写入不适用', async () => {
    const metadata = (token: string, fileId: string) =>
      request(app.getHttpServer())
        .get(`/api/stored-files/${fileId}`)
        .set('Authorization', `Bearer ${token}`);
    const download = (token: string, fileId: string) =>
      request(app.getHttpServer())
        .get(`/api/stored-files/${fileId}/download`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

    for (const token of [levelOneToken, levelTwoAToken]) {
      await metadata(token, fileAId).expect(200);
      const downloadedA = await download(token, fileAId).expect(200);
      expect(Buffer.compare(downloadedA.body as Buffer, fileABytes)).toBe(0);
    }
    for (const token of [levelOneToken, levelTwoBToken]) {
      await metadata(token, fileBId).expect(200);
      const downloadedB = await download(token, fileBId).expect(200);
      expect(Buffer.compare(downloadedB.body as Buffer, fileBBytes)).toBe(0);
    }

    await metadata(levelTwoAToken, fileBId).expect(404);
    await download(levelTwoAToken, fileBId).expect(404);
    await metadata(levelTwoBToken, fileAId).expect(404);
    await download(levelTwoBToken, fileAId).expect(404);

    // SUPER_ADMIN 只读：上传入口 @Roles(ENGINEER)，二级/一级上传均不适用
    const uploadAttempt = await request(app.getHttpServer())
      .post('/api/stored-files')
      .set('Authorization', `Bearer ${levelTwoAToken}`)
      .field('businessType', 'REPAIR_PROCESS')
      .attach('file', Buffer.from('admin-should-not-upload', 'utf8'), 'admin.txt');
    expect(uploadAttempt.status).toBe(403);
  });

  /**
   * 管理员工单列表：一级全公司、二级仅本公司（main 任务04 的 `admin_level` + 可信公司范围）。
   * 查询未显式要求 total 时不追加「total 等于行数」断言，只核对业务 ID 集合。
   */
  const expectAdminRepairRequestIds = async (
    token: string,
    expectedIds: readonly number[],
  ): Promise<void> => {
    const list = await gql<{
      adminRepairRequests: { items: Array<{ id: number; requestNo: string }> };
    }>(
      ADMIN_REPAIR_REQUESTS_QUERY,
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 100 },
        filter: { requestNo: 'E1-SHARED-' },
      },
      token,
    );

    expect(list.errors).toBeUndefined();
    const ids = (list.data?.adminRepairRequests.items ?? [])
      .map((item) => item.id)
      .sort((left, right) => left - right);

    expect(ids).toEqual([...expectedIds].sort((left, right) => left - right));
  };

  /** 管理员工单详情：一级可读两家公司，二级只能读本公司，跨公司统一 NOT_FOUND（不泄露存在性）。 */
  const expectAdminRepairRequestDetail = async (
    token: string,
    requestId: number,
    expectation: 'visible' | 'not-found',
  ): Promise<void> => {
    const summary = await gql<{
      adminRepairRequestSummary: { id: number; requestNo: string };
    }>(ADMIN_REPAIR_REQUEST_SUMMARY_QUERY, { id: requestId }, token);

    if (expectation === 'visible') {
      expect(summary.errors).toBeUndefined();
      expect(summary.data?.adminRepairRequestSummary.id).toBe(requestId);
      return;
    }

    expect(summary.data?.adminRepairRequestSummary).toBeUndefined();
    expect(summary.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  };

  it('文档数据库/工单：一级全公司、二级仅本公司，跨公司详情统一 NOT_FOUND', async () => {
    // 列表：一级同时可见 A/B；A 只有 A、B 只有 B（互不串号）
    await expectAdminRepairRequestIds(levelOneToken, [requestAId, requestBId]);
    await expectAdminRepairRequestIds(levelTwoAToken, [requestAId]);
    await expectAdminRepairRequestIds(levelTwoBToken, [requestBId]);

    // 详情：一级可读两家；A 读 A、B 读 B 成功；A 读 B、B 读 A 均 NOT_FOUND
    await expectAdminRepairRequestDetail(levelOneToken, requestAId, 'visible');
    await expectAdminRepairRequestDetail(levelOneToken, requestBId, 'visible');
    await expectAdminRepairRequestDetail(levelTwoAToken, requestAId, 'visible');
    await expectAdminRepairRequestDetail(levelTwoBToken, requestBId, 'visible');
    await expectAdminRepairRequestDetail(levelTwoAToken, requestBId, 'not-found');
    await expectAdminRepairRequestDetail(levelTwoBToken, requestAId, 'not-found');
  });
});
