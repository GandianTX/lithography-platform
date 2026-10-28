// test/05-verification-record/verification-record-types.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TokenHelper } from '@src/modules/auth/token.helper';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { ApiModule } from '@src/bootstraps/api/api.module';
import { CreateAccountUsecase } from '@usecases/account/create-account.usecase';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
  type ResidueVerificationRecordFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

interface GraphqlBody<TData> {
  readonly data?: TData | null;
  readonly errors?: readonly { readonly message: string }[];
}

interface CreateVerificationRecordData {
  readonly createVerificationRecord?: {
    readonly success: boolean;
    readonly token?: string | null;
    readonly data?: {
      readonly id: number;
      readonly type: string;
      readonly status: string;
      readonly targetAccountId: number | null;
      readonly subjectType: string | null;
      readonly subjectId: number | null;
      readonly payload: Record<string, unknown> | null;
    } | null;
  } | null;
}

interface FindVerificationRecordData {
  readonly findVerificationRecord?: {
    readonly type: string;
    readonly status: string;
    readonly subjectType: string | null;
    readonly subjectId: number | null;
  } | null;
}

interface ResetPasswordData {
  readonly resetPassword?: {
    readonly success: boolean;
    readonly message?: string | null;
    readonly accountId: number;
  } | null;
}

interface LoginData {
  readonly login?: {
    readonly accessToken?: string | null;
    readonly accountId?: number | null;
  } | null;
}

async function postGql<TData>(
  app: INestApplication,
  query: string,
  variables: unknown,
  bearer?: string,
): Promise<request.Response & { body: GraphqlBody<TData> }> {
  const httpRequest = request(app.getHttpServer() as App)
    .post('/graphql')
    .send({
      query,
      variables,
    });
  if (bearer) {
    httpRequest.set('Authorization', `Bearer ${bearer}`);
  }
  return await httpRequest;
}

async function getAccessToken(
  app: INestApplication,
  loginName: string,
  loginPassword: string,
): Promise<string> {
  const response = await postGql<LoginData>(app, LOGIN_MUTATION, {
    input: {
      loginName,
      loginPassword,
      type: 'PASSWORD',
      audience: 'DESKTOP',
    },
  });

  const token = response.body.data?.login?.accessToken;
  if (!token) {
    throw new Error(`登录失败: ${JSON.stringify(response.body)}`);
  }

  return token;
}

function getMyAccountId(app: INestApplication, bearer: string): number {
  const tokenHelper = app.get(TokenHelper);
  const payload = tokenHelper.decodeToken({ token: bearer });
  if (!payload?.sub) {
    throw new Error(`无法从 JWT token 中获取 accountId: ${bearer.substring(0, 20)}...`);
  }
  return payload.sub;
}

async function createVerificationRecord(params: {
  readonly app: INestApplication;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly bearer: string;
  readonly targetAccountId: number;
  readonly returnToken?: boolean;
  readonly ownership: OwnedResourceLedger;
}) {
  const response = await postGql<CreateVerificationRecordData>(
    params.app,
    `
      mutation CreateVerificationRecord($input: CreateVerificationRecordInput!) {
        createVerificationRecord(input: $input) {
          success
          data {
            id
            type
            status
            targetAccountId
            subjectType
            subjectId
            payload
          }
          token
        }
      }
    `,
    {
      input: {
        type: params.type,
        payload: params.payload,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        targetAccountId: params.targetAccountId,
        subjectType: 'ACCOUNT',
        subjectId: params.targetAccountId,
        returnToken: params.returnToken ?? true,
      },
    },
    params.bearer,
  );

  const createdId = response.body.data?.createVerificationRecord?.data?.id;
  if (createdId !== undefined) {
    // R02：登记真实 ID 与最小预期事实（类型/目标/subject/签发者/内容指纹）。
    recordOwnedResource(params.ownership, 'verificationRecord', createdId, {
      type: params.type,
      targetAccountId: params.targetAccountId ?? null,
      subjectType: 'ACCOUNT',
      subjectId: params.targetAccountId ?? null,
      issuedByAccountId: getMyAccountId(params.app, params.bearer),
      payload: params.payload,
    });
  }
  return response;
}

async function createPasswordResetToken(params: {
  readonly app: INestApplication;
  readonly bearer: string;
  readonly targetAccountId: number;
  readonly title: string;
  readonly ownership: OwnedResourceLedger;
}): Promise<string> {
  const createResponse = await createVerificationRecord({
    app: params.app,
    type: 'PASSWORD_RESET',
    payload: { title: params.title },
    bearer: params.bearer,
    targetAccountId: params.targetAccountId,
    ownership: params.ownership,
  });
  const token = createResponse.body.data?.createVerificationRecord?.token;
  if (!token) throw new Error('未获取到密码重置 token');
  return token;
}

async function assertPasswordResetRecordActive(
  app: INestApplication,
  token: string,
): Promise<void> {
  const findResponse = await postGql<FindVerificationRecordData>(
    app,
    `
      query FindVerificationRecord($input: FindVerificationRecordInput!) {
        findVerificationRecord(input: $input) {
          type
          status
        }
      }
    `,
    { input: { token, expectedType: 'PASSWORD_RESET' } },
  );
  expect(findResponse.body.data?.findVerificationRecord?.type).toBe('PASSWORD_RESET');
  expect(findResponse.body.data?.findVerificationRecord?.status).toBe('ACTIVE');
}

async function resetPasswordByToken(params: {
  readonly app: INestApplication;
  readonly token: string;
  readonly newPassword: string;
  readonly accountId: number;
}): Promise<void> {
  const resetResponse = await postGql<ResetPasswordData>(
    params.app,
    `
      mutation ResetPassword($input: ResetPasswordInput!) {
        resetPassword(input: $input) {
          success
          accountId
        }
      }
    `,
    { input: { token: params.token, newPassword: params.newPassword } },
  );
  expect(resetResponse.body.errors).toBeUndefined();
  expect(resetResponse.body.data?.resetPassword?.success).toBe(true);
  expect(resetResponse.body.data?.resetPassword?.accountId).toBe(params.accountId);
}

const LOGIN_MUTATION = `
  mutation Login($input: AuthLoginInput!) {
    login(input: $input) {
      accessToken
      accountId
    }
  }
`;

describe('验证记录类型测试 E2E', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  let staffAccessToken: string;
  let guestAccountId: number;

  const ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue(['staff', 'guest']);
  const residueVerificationRecords: ResidueVerificationRecordFingerprint[] = [
    {
      type: 'PASSWORD_RESET',
      targetAccountLoginName: testAccountsConfig.guest.loginName,
      payload: {
        title: '密码重置',
        resetUrl: 'https://example.com/reset-password',
        email: 'reset@example.com',
      },
    },
    {
      type: 'PASSWORD_RESET',
      targetAccountLoginName: testAccountsConfig.guest.loginName,
      payload: { title: '密码重置消费测试' },
    },
    {
      type: 'PASSWORD_RESET',
      targetAccountLoginName: testAccountsConfig.guest.loginName,
      payload: { title: '密码重置预读测试' },
    },
    {
      type: 'PASSWORD_RESET',
      targetAccountLoginName: testAccountsConfig.guest.loginName,
      payload: { title: '完整密码重置流程测试' },
    },
  ];

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);
    createAccountUsecase = moduleFixture.get<CreateAccountUsecase>(CreateAccountUsecase);

    await runGuardedSpecCleanup({
      dataSource,
      helper: 'verification-record-types.e2e beforeAll',
      residue: {
        accounts: residueAccounts,
        verificationRecords: residueVerificationRecords,
      },
    });
    await seedTestAccounts({
      dataSource,
      createAccountUsecase,
      includeKeys: ['staff', 'guest'],
      ownership,
    });

    staffAccessToken = await getAccessToken(
      app,
      testAccountsConfig.staff.loginName,
      testAccountsConfig.staff.loginPassword,
    );
    const guestAccessToken = await getAccessToken(
      app,
      testAccountsConfig.guest.loginName,
      testAccountsConfig.guest.loginPassword,
    );
    guestAccountId = getMyAccountId(app, guestAccessToken);
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'verification-record-types.e2e afterAll',
          owned: ownership,
          residue: {
            accounts: residueAccounts,
            verificationRecords: residueVerificationRecords,
          },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  it('应该成功创建密码重置类型的验证记录', async () => {
    const payload = {
      title: '密码重置',
      resetUrl: 'https://example.com/reset-password',
      email: 'reset@example.com',
    };

    const response = await createVerificationRecord({
      app,
      type: 'PASSWORD_RESET',
      payload,
      bearer: staffAccessToken,
      targetAccountId: guestAccountId,
      ownership,
    });

    expect(response.body.errors).toBeUndefined();
    const result = response.body.data?.createVerificationRecord;
    expect(result?.success).toBe(true);
    expect(result?.data?.type).toBe('PASSWORD_RESET');
    expect(result?.data?.subjectType).toBe('ACCOUNT');
    expect(result?.data?.subjectId).toBe(guestAccountId);
    expect(result?.data?.payload).toEqual(payload);
    expect(result?.token).toEqual(expect.any(String));
  });

  it('应该能够消费密码重置验证记录', async () => {
    const createResponse = await createVerificationRecord({
      app,
      type: 'PASSWORD_RESET',
      payload: { title: '密码重置消费测试' },
      bearer: staffAccessToken,
      targetAccountId: guestAccountId,
      ownership,
    });

    const token = createResponse.body.data?.createVerificationRecord?.token;
    if (!token) throw new Error('未获取到密码重置 token');

    const resetResponse = await postGql<ResetPasswordData>(
      app,
      `
        mutation ResetPassword($input: ResetPasswordInput!) {
          resetPassword(input: $input) {
            success
            message
            accountId
          }
        }
      `,
      {
        input: {
          token,
          newPassword: 'MyStrong2024!@#',
        },
      },
    );

    expect(resetResponse.body.errors).toBeUndefined();
    expect(resetResponse.body.data?.resetPassword?.success).toBe(true);
    expect(resetResponse.body.data?.resetPassword?.accountId).toBe(guestAccountId);
  });

  it('应该能够通过 findVerificationRecord 预读 PASSWORD_RESET 记录', async () => {
    const createResponse = await createVerificationRecord({
      app,
      type: 'PASSWORD_RESET',
      payload: { title: '密码重置预读测试' },
      bearer: staffAccessToken,
      targetAccountId: guestAccountId,
      ownership,
    });
    const token = createResponse.body.data?.createVerificationRecord?.token;
    if (!token) throw new Error('未获取到密码重置 token');

    const findResponse = await postGql<FindVerificationRecordData>(
      app,
      `
        query FindVerificationRecord($input: FindVerificationRecordInput!) {
          findVerificationRecord(input: $input) {
            type
            status
            subjectType
            subjectId
          }
        }
      `,
      {
        input: {
          token,
          expectedType: 'PASSWORD_RESET',
        },
      },
    );

    expect(findResponse.body.errors).toBeUndefined();
    expect(findResponse.body.data?.findVerificationRecord?.type).toBe('PASSWORD_RESET');
    expect(findResponse.body.data?.findVerificationRecord?.status).toBe('ACTIVE');
    expect(findResponse.body.data?.findVerificationRecord?.subjectType).toBe('ACCOUNT');
    expect(findResponse.body.data?.findVerificationRecord?.subjectId).toBe(guestAccountId);
  });

  it('应该能够完成完整的密码重置流程：预读 + 重置密码', async () => {
    const newPassword = 'MyStrong2025!@#';
    const token = await createPasswordResetToken({
      app,
      bearer: staffAccessToken,
      targetAccountId: guestAccountId,
      title: '完整密码重置流程测试',
      ownership,
    });

    await assertPasswordResetRecordActive(app, token);
    await resetPasswordByToken({
      app,
      token,
      newPassword,
      accountId: guestAccountId,
    });

    const loginResponse = await postGql<LoginData>(app, LOGIN_MUTATION, {
      input: {
        loginName: testAccountsConfig.guest.loginName,
        loginPassword: newPassword,
        type: 'PASSWORD',
        audience: 'DESKTOP',
      },
    });
    expect(loginResponse.body.data?.login?.accessToken).toBeDefined();
    expect(loginResponse.body.data?.login?.accountId).toBe(guestAccountId);

    const oldPasswordLoginResponse = await postGql<LoginData>(app, LOGIN_MUTATION, {
      input: {
        loginName: testAccountsConfig.guest.loginName,
        loginPassword: testAccountsConfig.guest.loginPassword,
        type: 'PASSWORD',
        audience: 'DESKTOP',
      },
    });
    expect(oldPasswordLoginResponse.body.errors?.length).toBeGreaterThan(0);
  });
});
