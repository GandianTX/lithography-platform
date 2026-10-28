// test/fixtures/cleanup-faults-child.e2e-spec.ts
//
// 永久反例子规格（F07 / F08 / F09 的真实进程证据）。
// 该文件由 test/utils/e2e-scoped-cleanup-faults.e2e-spec.ts 以真实 Jest 子进程运行，
// **不加入 jest-e2e.js 的 core 列表**，避免正常回归被“故意失败”的用例干扰。
//
// 三个用例的共同契约：
// - 造数与清理都走共享实现（special-status-account / owned-ledger-lifecycle）；
// - 故障注入只存在于测试侧，不向 src 增加生产开关。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../utils/e2e-scoped-cleanup';
import { runE2eTeardown } from '../utils/e2e-teardown';
import { createOwnedLedgerLifecycle } from '../utils/owned-ledger-lifecycle';
import {
  seedSpecialStatusAccount,
  type SpecialStatusAccountFaultPoint,
  type SpecialStatusAccountSpec,
} from '../utils/special-status-account';

jest.setTimeout(90000);

const RUN_TAG = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const loginFor = (label: string): string => `f${label}_${RUN_TAG}`.toLowerCase();
const emailFor = (label: string): string => `f${label}.${RUN_TAG}@example.com`.toLowerCase();

const specialSpec = (label: string): SpecialStatusAccountSpec => ({
  loginName: loginFor(label),
  loginEmail: emailFor(label),
  loginPassword: 'ChildFault@2026',
  status: AccountStatus.PENDING,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  identityType: IdentityTypeEnum.CUSTOMER,
});

let app: INestApplication | null = null;
let dataSource: DataSource;
let ownership: OwnedResourceLedger = createOwnedResourceLedger();

/** F09：第一用例故意让 afterEach 清理失败。 */
let denyCleanupConsent = false;
/** 启动时捕获的原始许可值；只有通过启动校验后才允许在 afterAll 恢复它。 */
let startupConsentOriginal: string | undefined;
/** 是否已在造数前独立校验启动许可恰为 '1'（N05）。 */
let startupConsentValidated = false;
/** 子夹具启动状态，用于区分许可拒绝、正常就绪与应用初始化失败。 */
type ChildStartupState = 'starting' | 'consent-rejected' | 'ready' | 'init-failed';
let startupState: ChildStartupState = 'starting';

const lifecycle = createOwnedLedgerLifecycle({
  helper: 'cleanup-faults-child',
  getDataSource: () => dataSource,
  getOwned: () => ownership,
  resetOwned: () => {
    ownership = createOwnedResourceLedger();
  },
});

const countAccounts = async (loginName: string): Promise<number> => {
  const rows = await dataSource.query(
    'SELECT COUNT(*) AS n FROM base_user_account WHERE login_name = ?',
    [loginName],
  );
  return Number(rows[0]?.n ?? 0);
};

const countUserInfoByEmail = async (loginEmail: string): Promise<number> => {
  const rows = await dataSource.query('SELECT COUNT(*) AS n FROM base_user_info WHERE email = ?', [
    loginEmail,
  ]);
  return Number(rows[0]?.n ?? 0);
};

/**
 * 仅恢复启动时已校验通过的原值（N05）。
 *
 * 该函数不是“授予许可”：只有 startupConsentValidated=true（即启动前原值恰为 '1'）时才可能写入，
 * 且写回的就是已捕获的原始值。启动许可未通过时，afterAll 不得自行写入 '1'。
 */
const restoreValidatedConsent = (): void => {
  if (!startupConsentValidated) {
    return;
  }
  if (startupConsentOriginal === undefined) {
    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
  } else {
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = startupConsentOriginal;
  }
};

describe('cleanup 故障生命周期（子规格）', () => {
  beforeAll(async () => {
    console.log(`CHILD_TAG=${RUN_TAG}`);
    // N05：在任何初始化/造数/清理之前独立校验启动许可必须恰为 '1'。
    startupConsentOriginal = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    if (startupConsentOriginal !== '1') {
      startupState = 'consent-rejected';
      throw new Error(
        `启动许可未通过：E2E_ALLOW_PHYSICAL_CLEANUP=${startupConsentOriginal === undefined ? '(未设置)' : JSON.stringify(startupConsentOriginal)}，` +
          "必须恰为 '1' 才允许启动故障夹具；未创建任何数据，也未执行任何 DELETE。",
      );
    }
    startupConsentValidated = true;
    try {
      initGraphQLSchema();
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [ApiModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      dataSource = app.get(DataSource);
      await assertDataSourceOnAllowedE2eDatabase(dataSource);
      startupState = 'ready';
    } catch (error) {
      startupState = 'init-failed';
      throw error;
    }
  });

  afterEach(async () => {
    if (denyCleanupConsent) {
      delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    }
    await lifecycle.afterTestCleanup();
  });

  beforeEach(() => {
    lifecycle.assertReadyForNextTest();
  });

  afterAll(async () => {
    console.log(`F09_AFTERALL_STATE=${startupState}`);
    if (startupState !== 'ready') {
      // 启动许可失败/初始化失败：没有经过校验的清理前提，禁止授予许可或执行 DELETE。
      console.log(`F09_AFTERALL_NO_CLEANUP=${startupState}`);
      await runE2eTeardown({
        finalize: null,
        closeApp: async () => {
          if (app) {
            await app.close();
            console.log('F09_CLOSE=closed');
          } else {
            console.log('F09_CLOSE=no-app');
          }
        },
      });
      return;
    }

    // F09 的 afterAll 证据：先恢复已校验原值（测试曾主动撤销）再诊断，随后兜底回收；
    // 无论 cleanup/finalize/close 哪一步失败，资源都要关闭，且最早错误不被覆盖。
    await runE2eTeardown({
      cleanup: async () => {
        restoreValidatedConsent();
        console.error(lifecycle.diagnose());
        try {
          await lifecycle.cleanupRetainedForAfterAll();
        } finally {
          const residual = await dataSource.query(
            `SELECT COUNT(*) AS n FROM base_user_account WHERE login_name LIKE ?`,
            [`f%_${RUN_TAG}`],
          );
          console.log(
            `F09_RESIDUE=${Number((residual as Array<{ n: number | string }>)[0]?.n ?? -1)}`,
          );
        }
      },
      finalize: () => {
        restoreValidatedConsent();
        console.log(
          `F09_ENV_RESTORED=${process.env.E2E_ALLOW_PHYSICAL_CLEANUP === undefined ? '(未设置)' : process.env.E2E_ALLOW_PHYSICAL_CLEANUP}`,
        );
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('F09_CLOSE=closed');
        } else {
          console.log('F09_CLOSE=no-app');
        }
      },
    });
  });

  it('F07 三个提交点注入失败均无半账号；提交成功立即登记并可回收', async () => {
    const faultPoints: SpecialStatusAccountFaultPoint[] = [
      'afterInsert',
      'afterHashUpdate',
      'beforeUserInfo',
    ];

    for (const [index, point] of faultPoints.entries()) {
      const spec = specialSpec(`07${index + 1}`);
      const ownedBefore = ownership.accountIds.length;
      await expect(
        seedSpecialStatusAccount({
          dataSource,
          account: spec,
          ownership,
          injectFaultAt: point,
        }),
      ).rejects.toThrow(`注入故障：${point}`);

      if (ownership.accountIds.length !== ownedBefore) {
        throw new Error(`F07 注入失败却登记了账号：${point}`);
      }
      if ((await countAccounts(spec.loginName)) !== 0) {
        throw new Error(`F07 注入失败仍留下半账号：${point}`);
      }
      if ((await countUserInfoByEmail(spec.loginEmail)) !== 0) {
        throw new Error(`F07 注入失败仍留下 user_info：${point}`);
      }
    }

    // 同名重跑可恢复：故障解除后用同一 login/email 重新提交并登记
    const retrySpec = specialSpec('071');
    const retryId = await seedSpecialStatusAccount({
      dataSource,
      account: retrySpec,
      ownership,
    });
    if (!ownership.accountIds.includes(retryId)) {
      throw new Error('F07 同名重跑成功后未登记真实 ID');
    }
    if ((await countAccounts(retrySpec.loginName)) !== 1) {
      throw new Error('F07 同名重跑未恢复账号');
    }

    const committed = specialSpec('07ok');
    const accountId = await seedSpecialStatusAccount({
      dataSource,
      account: committed,
      ownership,
    });
    if (!ownership.accountIds.includes(accountId)) {
      throw new Error('F07 提交成功后未立即登记真实 ID');
    }
    const facts = ownership.facts.account.get(accountId);
    if (
      !facts ||
      facts.loginName !== committed.loginName ||
      String(facts.status) !== String(committed.status)
    ) {
      throw new Error('F07 提交成功后未登记最小预期事实');
    }
    if ((await countAccounts(committed.loginName)) !== 1) {
      throw new Error('F07 提交成功后账号不存在');
    }
    if ((await countUserInfoByEmail(committed.loginEmail)) !== 1) {
      throw new Error('F07 提交成功后 user_info 不存在');
    }

    // 显式回收本用例提交的成功账号，证明“提交即登记、可回收”
    await runGuardedSpecCleanup({
      dataSource,
      owned: ownership,
      helper: 'F07 提交成功后回收',
    });
    if ((await countAccounts(committed.loginName)) !== 0) {
      throw new Error('F07 已登记账号未能回收');
    }
    if ((await countAccounts(retrySpec.loginName)) !== 0) {
      throw new Error('F07 同名重跑账号未能回收');
    }
    ownership = createOwnedResourceLedger();
    console.log('F07_OK');
  });

  it('F08 并行造数 Promise.allSettled：失败不外溢、迟到成功也被等待，收尾无迟到写入', async () => {
    const failing = specialSpec('08fail');
    const delayed = specialSpec('08late');

    const results = await Promise.allSettled([
      seedSpecialStatusAccount({
        dataSource,
        account: failing,
        ownership,
        injectFaultAt: 'afterInsert',
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 150)).then(() =>
        seedSpecialStatusAccount({ dataSource, account: delayed, ownership }),
      ),
    ]);

    if (results[0].status !== 'rejected') {
      throw new Error('F08 注入失败的造数未 reject');
    }
    const reason = results[0].reason;
    if (!(reason instanceof Error) || !reason.message.includes('注入故障：afterInsert')) {
      throw new Error(`F08 主因不可辨：${String(reason)}`);
    }
    if (results[1].status !== 'fulfilled') {
      throw new Error(`F08 延迟成功任务未 settled：${JSON.stringify(results[1])}`);
    }
    if ((await countAccounts(failing.loginName)) !== 0) {
      throw new Error('F08 失败任务留下半账号');
    }
    const lateId = ownership.accountIds[ownership.accountIds.length - 1];
    if (lateId === undefined) {
      throw new Error('F08 成功任务未登记真实 ID');
    }
    if ((await countAccounts(delayed.loginName)) !== 1) {
      throw new Error('F08 成功任务账号不存在（可能存在迟到写入丢失）');
    }

    // 收尾后再等待一段时间，确认没有迟到写入
    await runGuardedSpecCleanup({
      dataSource,
      owned: ownership,
      helper: 'F08 并行造数回收',
    });
    ownership = createOwnedResourceLedger();
    await new Promise((resolve) => setTimeout(resolve, 200));
    if ((await countAccounts(delayed.loginName)) !== 0) {
      throw new Error('F08 收尾后出现迟到写入');
    }
    console.log('F08_OK');
  });

  it('F09 第一用例 afterEach 清理失败：台账保留、下一用例失败关闭', async () => {
    const spec = specialSpec('09hold');
    const accountId = await seedSpecialStatusAccount({ dataSource, account: spec, ownership });
    if (!ownership.accountIds.includes(accountId)) {
      throw new Error('F09 未登记待清理账号');
    }
    // 故意在 afterEach 之前撤掉清理许可，让共享收尾实现真实失败
    denyCleanupConsent = true;
    console.log('F09_AFTEREACH_FAIL_SET');
    // 该用例会因 afterEach 失败而被判定失败；runner 必须因此非 0
    expect(await countAccounts(spec.loginName)).toBe(1);
  });

  it('F09 下一用例：上一用例清理失败时拒绝继续造数', () => {
    // beforeEach 已失败关闭；若此处被执行说明契约被破坏
    throw new Error('F09 不应在清理失败后继续执行造数用例');
  });
});
