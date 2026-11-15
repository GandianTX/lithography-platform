// test/fixtures/session-status-combination-teardown-child.e2e-spec.ts
//
// P1 反例子规格：双状态门禁规格「断言中断」与「hook 失败」两种真实进程证据。
// 由 test/utils/e2e-scoped-cleanup-faults.e2e-spec.ts 以真实 Jest 子进程运行，
// **不加入 jest-e2e.js 的 core 列表**，避免正常回归被“故意失败”的用例干扰。
//
// 模式（环境变量 SESSION_TEARDOWN_MODE）：
// - interrupt：用例内受控改写账号状态（同步 updateOwnedExpectation）后立即中断断言；
//   afterAll 的 runE2eTeardown 必须仍按台账精确回收并零残留；
// - hook-failure：用例造成**未登记漂移**（直接改库、不更新预期），afterAll 首次清理
//   必须在首删前拒绝；runE2eTeardown 记录该错误后继续 finalize —— 在守护下补登记
//   最后一次已知写入并二次清理、零残留，随后仍执行 closeApp，并把最早错误抛回。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { DataSource } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  updateOwnedExpectation,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { seedSpecialStatusAccount } from '../utils/special-status-account';

jest.setTimeout(120000);

type TeardownMode = 'interrupt' | 'hook-failure';

const mode = (process.env.SESSION_TEARDOWN_MODE ?? '').trim() as TeardownMode;
const RUN_TAG = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const LOGIN_NAME = `st${mode === 'hook-failure' ? 'h' : 'i'}_${RUN_TAG}`.toLowerCase();
const LOGIN_EMAIL = `st.${RUN_TAG}@example.com`.toLowerCase();

let app: INestApplication | null = null;
let dataSource: DataSource;
const ownership: OwnedResourceLedger = createOwnedResourceLedger();
let accountId: number | null = null;
let startupConsentOriginal: string | undefined;
let startupReady = false;

const restoreValidatedConsent = (): void => {
  if (startupConsentOriginal === undefined) {
    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
  } else {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = startupConsentOriginal;
  }
};

const countResidue = async (): Promise<number> => {
  const rows = await dataSource.query<Array<{ n: number | string }>>(
    'SELECT COUNT(*) AS n FROM base_user_account WHERE login_name = ? OR login_email = ?',
    [LOGIN_NAME, LOGIN_EMAIL],
  );
  const userInfoRows = await dataSource.query<Array<{ n: number | string }>>(
    'SELECT COUNT(*) AS n FROM base_user_info WHERE email = ?',
    [LOGIN_EMAIL],
  );
  return Number(rows[0]?.n ?? -1) + Number(userInfoRows[0]?.n ?? -1);
};

describe('双状态门禁规格的收尾反例（子规格）', () => {
  beforeAll(async () => {
    console.log(`CHILD_TAG=${RUN_TAG}`);
    console.log(`ST_MODE=${mode}`);

    startupConsentOriginal = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    if (startupConsentOriginal !== '1') {
      throw new Error(
        "启动许可未通过：双状态收尾反例要求 E2E_ALLOW_PHYSICAL_CLEANUP 恰为 '1'；未创建任何数据。",
      );
    }
    if (mode !== 'interrupt' && mode !== 'hook-failure') {
      throw new Error(`SESSION_TEARDOWN_MODE 非法：${JSON.stringify(mode)}`);
    }

    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource);

    accountId = await seedSpecialStatusAccount({
      dataSource,
      account: {
        loginName: LOGIN_NAME,
        loginEmail: LOGIN_EMAIL,
        loginPassword: 'StTeardown@2026',
        status: AccountStatus.PENDING,
        accessGroup: [IdentityTypeEnum.ENGINEER],
        identityType: IdentityTypeEnum.ENGINEER,
      },
      ownership,
    });
    startupReady = true;
  });

  afterAll(async () => {
    if (!startupReady) {
      await runE2eTeardown({
        closeApp: async () => {
          if (app) {
            await app.close();
            console.log('ST_CLOSE=closed');
          } else {
            console.log('ST_CLOSE=no-app');
          }
        },
      });
      return;
    }

    await runE2eTeardown({
      cleanup: async () => {
        try {
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'session-status-combination-teardown-child afterAll 首次清理',
          });
          console.log('ST_CLEANUP_REFUSED=0');
        } catch (error) {
          console.log('ST_CLEANUP_REFUSED=1');
          console.log(`ST_CLEANUP_ERROR=${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
      finalize: async () => {
        if (!dataSource?.isInitialized) {
          return;
        }
        restoreValidatedConsent();
        if (mode === 'hook-failure' && accountId !== null) {
          // 守护下补登记用例已经写入的真实事实，然后二次清理（预期是首次清理被拒绝）。
          updateOwnedExpectation(ownership, 'account', accountId, {
            status: AccountStatus.ACTIVE,
          });
          console.log('ST_FINALIZE_REPAIR=1');
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'session-status-combination-teardown-child finalize 二次清理',
          });
        }
        console.log(`ST_FINALIZE_AFTER_FAILURE=${mode === 'hook-failure' ? 1 : 0}`);
        console.log(`ST_RESIDUE=${await countResidue()}`);
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('ST_CLOSE_AFTER_FAILURE=closed');
        } else {
          console.log('ST_CLOSE=no-app');
        }
      },
    });
  });

  it('受控改写后中断断言：账号状态已写入但用例立即失败', async () => {
    const targetId = accountId as number;

    if (mode === 'interrupt') {
      // 与正式规格同口径：受控写入成功后立即同步台账预期。
      await dataSource
        .getRepository(AccountEntity)
        .update(targetId, { status: AccountStatus.ACTIVE });
      updateOwnedExpectation(ownership, 'account', targetId, { status: AccountStatus.ACTIVE });

      // 断言中断：失败发生在用例体内，afterAll 仍须按最后一次已知写入完成回收。
      throw new Error('ST 注入：受控改写后的断言中断');
    }

    // hook-failure：直接改库但不更新预期，制造未登记漂移。
    await dataSource
      .getRepository(AccountEntity)
      .update(targetId, { status: AccountStatus.ACTIVE });
    console.log('ST_DRIFT_WITHOUT_EXPECTATION=1');
  });
});
