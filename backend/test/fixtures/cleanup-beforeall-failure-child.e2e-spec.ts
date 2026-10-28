// test/fixtures/cleanup-beforeall-failure-child.e2e-spec.ts
//
// D1 / G11：真实 beforeAll 在造数并登记后失败，afterAll 仍必须真实收尾并零残留。
// 该文件只由 test/utils/e2e-scoped-cleanup-faults.e2e-spec.ts 以真实 Jest 子进程运行，
// 不加入 jest-e2e.js 的 core 列表。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import { createOwnedResourceLedger, type OwnedResourceLedger } from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { createOwnedLedgerLifecycle } from '../utils/owned-ledger-lifecycle';
import { seedSpecialStatusAccount } from '../utils/special-status-account';

jest.setTimeout(90000);

const RUN_TAG = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const LOGIN_NAME = `d1_${RUN_TAG}`.toLowerCase();
const LOGIN_EMAIL = `d1.${RUN_TAG}@example.com`.toLowerCase();
const SECOND_LOGIN_NAME = `d1b_${RUN_TAG}`.toLowerCase();
const SECOND_LOGIN_EMAIL = `d1b.${RUN_TAG}@example.com`.toLowerCase();

let app: INestApplication | null = null;
let dataSource: DataSource;
let ownership: OwnedResourceLedger = createOwnedResourceLedger();
let startupConsentValidated = false;
let startupConsentOriginal: string | undefined;
let startupReady = false;

const lifecycle = createOwnedLedgerLifecycle({
  helper: 'cleanup-beforeall-failure-child',
  getDataSource: () => dataSource,
  getOwned: () => ownership,
  resetOwned: () => {
    ownership = createOwnedResourceLedger();
  },
});

describe('D1 beforeAll 真实失败后的 afterAll 收尾（子规格）', () => {
  beforeAll(async () => {
    console.log(`CHILD_TAG=${RUN_TAG}`);
    startupConsentOriginal = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    if (startupConsentOriginal !== '1') {
      throw new Error(
        "启动许可未通过：D1 故障夹具要求 E2E_ALLOW_PHYSICAL_CLEANUP 恰为 '1'；未创建任何数据。",
      );
    }
    startupConsentValidated = true;

    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource);

    await seedSpecialStatusAccount({
      dataSource,
      account: {
        loginName: LOGIN_NAME,
        loginEmail: LOGIN_EMAIL,
        loginPassword: 'D1BeforeAll@2026',
        status: AccountStatus.PENDING,
        accessGroup: [IdentityTypeEnum.CUSTOMER],
        identityType: IdentityTypeEnum.CUSTOMER,
      },
      ownership,
    });
    startupReady = true;

    // D1 精确补证：第二笔真实创建事务在 INSERT 后失败，TypeORM 必须整体回滚；
    // 该失败既不能留下第二笔残留，也不能把未提交资源写入归属台账。
    try {
      await seedSpecialStatusAccount({
        dataSource,
        account: {
          loginName: SECOND_LOGIN_NAME,
          loginEmail: SECOND_LOGIN_EMAIL,
          loginPassword: 'D1SecondTx@2026',
          status: AccountStatus.PENDING,
          accessGroup: [IdentityTypeEnum.CUSTOMER],
          identityType: IdentityTypeEnum.CUSTOMER,
        },
        ownership,
        injectFaultAt: 'afterInsert',
      });
      throw new Error('D1 注入：第二笔事务本应失败，但创建成功了');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/注入故障：afterInsert/.test(message)) {
        throw error;
      }
      console.log('D1_SECOND_FAILED=1');
      console.log(`D1_SECOND_ERROR=${message}`);
    }

    // D1：真实 beforeAll 在“第一笔已造数且已登记、第二笔事务已回滚失败”之后终止。
    console.log('D1_MAIN_ERROR=D1 注入：第二笔真实事务失败后终止 beforeAll');
    throw new Error('D1 注入：第二笔真实事务失败后终止 beforeAll');
  });

  afterAll(async () => {
    console.log(`D1_AFTERALL_STATE=${startupReady ? 'ready' : 'not-ready'}`);
    if (!startupReady) {
      await runE2eTeardown({
        closeApp: async () => {
          if (app) {
            await app.close();
          }
        },
      });
      return;
    }

    await runE2eTeardown({
      cleanup: async () => {
        if (startupConsentValidated) {
          if (startupConsentOriginal === undefined) {
            delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
          } else {
            process.env.E2E_ALLOW_PHYSICAL_CLEANUP = startupConsentOriginal;
          }
        }
        console.error(lifecycle.diagnose());
        await lifecycle.cleanupRetainedForAfterAll();
      },
      finalize: async () => {
        if (!dataSource?.isInitialized) {
          return;
        }
        const residual = await dataSource.query(
          'SELECT COUNT(*) AS n FROM base_user_account WHERE login_name LIKE ?',
          [`d1_%${RUN_TAG}`],
        );
        console.log(
          `D1_RESIDUE=${Number((residual as Array<{ n: number | string }>)[0]?.n ?? -1)}`,
        );
        const secondAccounts = await dataSource.query(
          'SELECT COUNT(*) AS n FROM base_user_account WHERE login_name LIKE ?',
          [`d1b_%${RUN_TAG}`],
        );
        const secondInfos = await dataSource.query(
          `SELECT COUNT(*) AS n FROM base_user_info ui
             JOIN base_user_account a ON a.id = ui.account_id
            WHERE a.login_name LIKE ?`,
          [`d1b_%${RUN_TAG}`],
        );
        const secondTotal =
          Number((secondAccounts as Array<{ n: number | string }>)[0]?.n ?? -1) +
          Number((secondInfos as Array<{ n: number | string }>)[0]?.n ?? -1);
        console.log(`D1_SECOND_RESIDUE=${secondTotal}`);
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('D1_CLOSE=closed');
        } else {
          console.log('D1_CLOSE=no-app');
        }
      },
    });
  });

  it('不会被执行：beforeAll 已失败', () => {
    throw new Error('D1 子规格不应执行到用例体');
  });
});
