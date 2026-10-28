// test/99-third-party-live-smoke/weapp-qrcode-real.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { postGql as postGqlUtils } from '../utils/e2e-graphql-utils';

import { TokenHelper } from '@modules/auth/token.helper';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { CreateAccountUsecase } from '@usecases/account/create-account.usecase';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type ResidueVerificationRecordFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import {
  buildTestAccountResidue,
  seedTestAccounts,
  testAccountsConfig,
} from '../utils/test-accounts';

/**
 * GraphQL 请求辅助函数
 */
async function postGql(app: INestApplication, query: string, variables: unknown, bearer?: string) {
  return await postGqlUtils({ app, query, variables, token: bearer });
}

/**
 * 获取访问令牌
 */
async function getAccessToken(
  app: INestApplication,
  loginName: string,
  password: string,
): Promise<string> {
  const response = await request(app.getHttpServer() as App)
    .post('/graphql')
    .send({
      query: `
        mutation Login($input: AuthLoginInput!) {
          login(input: $input) {
            accessToken
          }
        }
      `,
      variables: {
        input: {
          loginName,
          loginPassword: password,
          type: 'PASSWORD',
          audience: 'DESKTOP',
        },
      },
    });

  if (response.status !== 200) {
    throw new Error(
      `登录请求失败，状态码: ${response.status}, 响应: ${JSON.stringify(response.body)}`,
    );
  }

  const accessToken = response.body.data?.login?.accessToken;
  if (!accessToken) {
    throw new Error(`登录失败: ${JSON.stringify(response.body)}`);
  }

  return accessToken as string;
}

/**
 * 获取当前账户 ID
 */
function getMyAccountId(app: INestApplication, bearer: string): number {
  const tokenHelper = app.get(TokenHelper);
  const payload = tokenHelper.decodeToken({ token: bearer });
  if (!payload || !payload.sub) {
    throw new Error('无法从 token 中获取账户 ID');
  }
  return parseInt(String(payload.sub), 10);
}

/**
 * 创建验证记录
 */
async function createVerificationRecord(
  app: INestApplication,
  type: 'PASSWORD_RESET',
  payload: Record<string, unknown>,
  bearer: string,
  options: {
    targetAccountId: number;
    returnToken?: boolean;
  },
) {
  return await postGql(
    app,
    `
      mutation CreateVerificationRecord($input: CreateVerificationRecordInput!) {
        createVerificationRecord(input: $input) {
          success
          data {
            id
            type
            status
          }
          token
          message
        }
      }
    `,
    {
      input: {
        type,
        payload,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        targetAccountId: options.targetAccountId,
        subjectType: 'ACCOUNT',
        subjectId: options.targetAccountId,
        returnToken: options.returnToken ?? true,
      },
    },
    bearer,
  );
}

/**
 * 调用 GraphQL 生成微信小程序二维码
 */
async function generateWeappQrcode(
  app: INestApplication,
  input: {
    audience: string;
    scene: string;
    page?: string;
    width?: number;
    checkPath?: boolean;
    envVersion?: 'develop' | 'trial' | 'release';
    isHyaline?: boolean;
    encodeBase64?: boolean;
  },
) {
  return await postGql(
    app,
    `
      mutation GenerateWeappQrcode($input: GenerateWeappQrcodeInput!) {
        generateWeappQrcode(input: $input) {
          contentType
          imageBase64
          imageBufferBase64
        }
      }
    `,
    { input },
  );
}

describe('WeApp 二维码 Smoke（真实第三方）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  let staffAccessToken: string;
  let guestAccountId: number;

  const audience = (process.env.WEAPP_QRCODE_SMOKE_AUDIENCE ?? 'SSTSWEAPP').trim();
  const ownership = createOwnedResourceLedger();
  const residueAccounts = buildTestAccountResidue([
    'staff',
    'staffPrimary',
    'staffSecondary',
    'admin',
    'guestPrimary',
    'guestSecondary',
    'guest',
    'emptyRoles',
    'staffGuest',
    'hybridStaff',
    'peerAdmin',
    'noOrgEngineer',
    'ambiguousEngineer',
  ]);
  const residueVerificationRecords: ResidueVerificationRecordFingerprint[] = [
    {
      type: 'PASSWORD_RESET',
      targetAccountLoginName: testAccountsConfig.guest.loginName,
      payload: {
        title: '密码重置二维码',
        resetUrl: 'https://example.com/reset-password',
        email: 'reset-qrcode@example.com',
      },
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
      helper: 'weapp-qrcode-real.e2e beforeAll',
      residue: {
        accounts: residueAccounts,
        verificationRecords: residueVerificationRecords,
      },
    });
    await seedTestAccounts({ dataSource, createAccountUsecase, ownership });

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
  }, 60000);

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: () =>
        runGuardedSpecCleanup({
          dataSource,
          helper: 'weapp-qrcode-real.e2e afterAll',
          owned: ownership,
          residue: {
            accounts: residueAccounts,
            verificationRecords: residueVerificationRecords,
          },
        }),
      closeApp: app ? () => app.close() : null,
    });
  });

  it('应该生成指向链接的微信小程序二维码', async () => {
    const resp = await generateWeappQrcode(app, {
      audience,
      scene: `invite_link_${Date.now()}`,
      encodeBase64: true,
    });

    if (resp.body.errors) {
      throw new Error(`GraphQL 错误: ${JSON.stringify(resp.body.errors)}`);
    }

    const result = resp.body.data.generateWeappQrcode;
    expect(result).toBeDefined();
    expect(['image/png', 'image/jpeg']).toContain(result.contentType);
    expect(typeof result.imageBase64).toBe('string');
    expect(result.imageBase64.length).toBeGreaterThan(0);
  }, 90000);

  it('应该为 PASSWORD_RESET 记录生成二维码', async () => {
    const createResp = await createVerificationRecord(
      app,
      'PASSWORD_RESET',
      {
        title: '密码重置二维码',
        resetUrl: 'https://example.com/reset-password',
        email: 'reset-qrcode@example.com',
      },
      staffAccessToken,
      {
        targetAccountId: guestAccountId,
        returnToken: true,
      },
    );

    if (createResp.body.errors) {
      throw new Error(`GraphQL 错误: ${JSON.stringify(createResp.body.errors)}`);
    }

    const token = createResp.body.data.createVerificationRecord.token as string;
    const createdRecordId = createResp.body.data.createVerificationRecord.data?.id;
    if (createdRecordId !== undefined) {
      recordOwnedResource(ownership, 'verificationRecord', createdRecordId, {
        type: 'PASSWORD_RESET',
        targetAccountId: guestAccountId,
        subjectType: 'ACCOUNT',
        subjectId: guestAccountId,
        issuedByAccountId: getMyAccountId(app, staffAccessToken),
        payload: {
          title: '密码重置二维码',
          resetUrl: 'https://example.com/reset-password',
          email: 'reset-qrcode@example.com',
        },
      });
    }
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const qrcodeResp = await generateWeappQrcode(app, {
      audience,
      scene: token,
      encodeBase64: true,
    });

    if (qrcodeResp.body.errors) {
      throw new Error(`GraphQL 错误: ${JSON.stringify(qrcodeResp.body.errors)}`);
    }

    const qrcodeResult = qrcodeResp.body.data.generateWeappQrcode;
    expect(['image/png', 'image/jpeg']).toContain(qrcodeResult.contentType);
    expect(typeof qrcodeResult.imageBase64).toBe('string');
    expect(qrcodeResult.imageBase64.length).toBeGreaterThan(0);
  }, 90000);
});
