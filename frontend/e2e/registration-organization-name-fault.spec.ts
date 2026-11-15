// e2e/registration-organization-name-fault.spec.ts
// B 复审第二轮 P2-01 / P2-02 的**故意失败**反例（真实 MySQL + 真实浏览器）。
//
// 只在显式开关下运行（正常入口通过 testIgnore 排除，不会污染常规回归）：
//   E2E_REG_NM_FAULT=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 E2E_DEDICATED_DB_NAME=lithography_work_e2e \
//     npm run test:e2e:real-backend-dedicated -- registration-organization-name-fault
//
// 覆盖：
// - A（红测）：注册已成功返回账号 ID、在 UI 确认前中断——修复前账号/资料/成员/手填公司
//   全部在账外；修复后响应一到即入账，afterAll 收尾后本轮零残留、哨兵不变、原故障可见。
// - B：公司插入拿到 LAST_INSERT_ID() 后回读失败——真实 ID 不丢，可按台账精确回收。
// - C：账外 base_user_info 指向本轮公司——必须在首删前被 guard 拒绝，实际 DELETE 为 0。
// - D：账外 organization_membership 指向本轮账号——同样首删前拒绝，DELETE 为 0。
// - E：合法完整台账 + 后序删除失败——事务内探针证明前序 DELETE 已执行，且整批回滚。

import { expect, test } from '@playwright/test';

import {
  mysqlQuery,
  readBackendEnv,
  resolveRealBackendPrerequisite,
  runGuardedFixtureWrite,
} from './helpers/real-backend';
import {
  buildRegistrationAttemptProbeSql,
  describeCaptureDiagnosis,
  type RegistrationCapture,
  startRegistrationCapture,
} from './helpers/registration-response-capture';
import {
  cleanupRegistrationRound,
  createRegistrationRoundLedger,
  discoverRegistrationRoundReferences,
  insertRegistrationRoundOrganization,
  isRegistrationRoundLedgerEmpty,
  readRegistrationRoundOrganization,
  registerRegistrationRoundAccount,
  registerRegistrationRoundMembership,
  registerRegistrationRoundUserInfo,
  type RegistrationRoundOrganizationFacts,
} from './helpers/registration-round-cleanup';

const FAULT_ENABLED = process.env.E2E_REG_NM_FAULT === '1';
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const NAME_PREFIX = `E2E-FAULT-${RUN_TAG}-`;
const CODE_PREFIX = `E2E_FAULT_${RUN_TAG}_`;
const TARGET_NAME = `${NAME_PREFIX}TARGET`;
const LOGIN_PASSWORD = 'Str0ng!Passw0rd';
const HINT = '发现同名公司，可从名单选择；手填名称不会自动合并。';
const SUCCESS = '账号已开通，请使用登录邮箱与密码登录。';

const faultEmail = (suffix: string): string => `e2e.fault.${RUN_TAG}.${suffix}@example.com`;
const LOGIN_EMAIL = faultEmail('a');

const utf8Hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex').toUpperCase();

const guardedWrite = (sql: string): string => runGuardedFixtureWrite(readBackendEnv(), sql);

const readRow = (output: string): string[] => {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error(`夹具写入未返回结果：${JSON.stringify(output)}`);
  }
  return last.split('\t');
};

const countById = (table: string, id: number): number =>
  Number(mysqlQuery(`SELECT COUNT(*) FROM ${table} WHERE id = ${id}`));

/** 服务器侧 DELETE 计数：用于证明「guard 拒绝时实际 DELETE 为 0」 */
const readDeleteCounter = (): number => {
  const [, value] = mysqlQuery("SHOW GLOBAL STATUS LIKE 'Com_delete'").split('\t');
  return Number(value);
};

const readErrorField = (error: unknown, field: 'stdout' | 'stderr'): string => {
  if (!(error instanceof Error)) {
    return '';
  }
  const value = (error as unknown as Record<string, unknown>)[field];
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
};

const readMysqlErrorText = (error: unknown): string =>
  error instanceof Error ? `${error.message}\n${readErrorField(error, 'stderr')}` : String(error);

interface AccountFixture {
  readonly accountId: number;
  readonly userInfoId: number | null;
}

/** 直接建一条外部合成账号（可带资料），不经注册用例 */
function insertAccountFixture(input: {
  readonly loginEmail: string;
  readonly nickname: string;
  readonly customerOrganizationId: number | null;
  readonly withUserInfo: boolean;
}): AccountFixture {
  const statements = [
    `INSERT INTO base_user_account (login_name, login_email, login_password, status, identity_hint) VALUES (NULL, CONVERT(UNHEX('${utf8Hex(input.loginEmail)}') USING utf8mb4), 'e2e-fault-not-used', 'ACTIVE', 'CUSTOMER')`,
    'SET @fault_account = LAST_INSERT_ID()',
  ];

  if (input.withUserInfo) {
    const organizationValue =
      input.customerOrganizationId === null ? 'NULL' : String(input.customerOrganizationId);
    statements.push(
      `INSERT INTO base_user_info (account_id, nickname, email, customer_organization_id, access_group, user_state) VALUES (@fault_account, CONVERT(UNHEX('${utf8Hex(input.nickname)}') USING utf8mb4), CONVERT(UNHEX('${utf8Hex(input.loginEmail)}') USING utf8mb4), ${organizationValue}, JSON_ARRAY('guest'), 'ACTIVE')`,
      'SET @fault_user_info = LAST_INSERT_ID()',
    );
  }

  statements.push(
    input.withUserInfo ? 'SELECT @fault_account, @fault_user_info' : 'SELECT @fault_account',
  );

  const row = readRow(guardedWrite(statements.join('; ')));
  return {
    accountId: Number(row[0]),
    userInfoId: input.withUserInfo ? Number(row[1]) : null,
  };
}

function deleteAccountFixture(fixture: AccountFixture): void {
  const statements = [
    ...(fixture.userInfoId === null
      ? []
      : [`DELETE FROM base_user_info WHERE id = ${fixture.userInfoId}`]),
    `DELETE FROM base_user_account WHERE id = ${fixture.accountId}`,
  ];
  guardedWrite(statements.join('; '));
}

const insertMembershipRow = (accountId: number, organizationId: number): number =>
  Number(
    readRow(
      guardedWrite(
        [
          `INSERT INTO organization_membership (organization_id, account_id, member_role, status) VALUES (${organizationId}, ${accountId}, 'CUSTOMER', 'ACTIVE')`,
          'SELECT LAST_INSERT_ID()',
        ].join('; '),
      ),
    )[0],
  );

const deleteMembershipRow = (membershipId: number): void => {
  guardedWrite(`DELETE FROM organization_membership WHERE id = ${membershipId}`);
};

/** 用例 A 的本轮台账与外部哨兵（afterAll 统一收尾） */
const roundLedger = createRegistrationRoundLedger();
const sentinelLedger = createRegistrationRoundLedger();
let sentinelFacts: Array<{ id: number; facts: RegistrationRoundOrganizationFacts }> = [];
let registrationCapture: RegistrationCapture | null = null;
/** 主用例 UI 断言失败（第三轮 P2：必须在收尾报告里与响应诊断聚合） */
let uiFailure: unknown = null;
/** F：成功响应在客户端边界丢失时，代理侧看到的真实账号 ID 与合成邮箱 */
let lostAttempt: { readonly loginEmail: string; readonly accountId: number } | null = null;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

test.describe('注册清理故障反例（真实库，故意失败）', () => {
  // 故意不加 serial：A 必然失败（注入异常），但 B–E 仍必须执行并给出独立证据
  test.beforeAll(async () => {
    test.skip(!FAULT_ENABLED, '故障反例仅在 E2E_REG_NM_FAULT=1 时运行');
    const skipReason = await resolveRealBackendPrerequisite();
    test.skip(skipReason !== null, skipReason ?? '');
  });

  test.afterAll(async () => {
    // 已返回的成功响应必须先入账，再清理；失败结论必须显式进入报告（第三轮 P2）
    if (registrationCapture) {
      await registrationCapture.settled;
    }
    const organizationIds = roundLedger.organizations.map((item) => item.id);
    const accountIds = roundLedger.accounts.map((item) => item.id);

    const diagnostics: string[] = [];
    if (uiFailure !== null) {
      diagnostics.push(`原 UI 断言失败：${describeError(uiFailure)}`);
    }

    const diagnosis = describeCaptureDiagnosis(registrationCapture, {
      loginEmail: lostAttempt?.loginEmail ?? LOGIN_EMAIL,
    });
    if (diagnosis !== null) {
      diagnostics.push(diagnosis);
    }

    // F：响应丢失时只做只读核查，用代理侧看到的账号 ID 与库内实际行互相印证
    let pendingAccountFound = 0;
    if (lostAttempt !== null) {
      const probe = mysqlQuery(buildRegistrationAttemptProbeSql(lostAttempt.loginEmail)).trim();
      console.log(`FAULT_F_PENDING_PROBE=${probe.replace(/\n/g, ' | ') || '(none)'}`);
      if (probe.length > 0) {
        const [table, id] = probe.split('\n')[0].split('\t');
        expect(table).toBe('account');
        expect(Number(id)).toBe(lostAttempt.accountId);
        pendingAccountFound = 1;
      }
    }

    const failures: unknown[] = [];
    const steps: Array<() => void | Promise<void>> = [
      () => cleanupRegistrationRound(roundLedger),
      () => {
        for (const { facts, id } of sentinelFacts) {
          expect(readRegistrationRoundOrganization(id)).toEqual(facts);
        }
      },
      () => cleanupRegistrationRound(sentinelLedger),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }

    // 台账内资源必须零残留（按实际 ID 与唯一名称前缀双向核对）
    const residue = {
      accountIds: accountIds.filter((id) => countById('base_user_account', id) !== 0).length,
      organizationIds: organizationIds.filter((id) => countById('organization', id) !== 0).length,
      organizations: Number(
        mysqlQuery(`SELECT COUNT(*) FROM organization WHERE name LIKE '${NAME_PREFIX}%'`),
      ),
    };
    console.log(`FAULT_KNOWN_RESIDUE=${JSON.stringify(residue)}`);

    // 台账外账号单独登记：未知提交结果不得并入「零残留」
    const outsideLedger = Number(
      mysqlQuery(
        `SELECT COUNT(*) FROM base_user_account WHERE login_email LIKE 'e2e.fault.${RUN_TAG}%'`,
      ),
    );
    console.log(
      `FAULT_OUTSIDE_LEDGER_ACCOUNTS=${outsideLedger} PENDING_F_ACCOUNTS=${pendingAccountFound}`,
    );

    if (residue.accountIds !== 0 || residue.organizationIds !== 0 || residue.organizations !== 0) {
      failures.push(new Error(`台账内仍有残留：${JSON.stringify(residue)}`));
    }
    if (outsideLedger !== pendingAccountFound) {
      failures.push(
        new Error(
          `台账外账号数 ${outsideLedger} 与待确认核查 ${pendingAccountFound} 不一致（无台账不得计为零残留）`,
        ),
      );
    }

    if (diagnostics.length > 0 || failures.length > 0) {
      throw new Error(
        `故障反例收尾发现 ${diagnostics.length + failures.length} 项问题：${[
          ...diagnostics,
          ...failures.map(describeError),
        ].join('；')}`,
      );
    }
  });

  test('A. 注册成功后、UI 确认前中断：响应先入账，收尾后零残留', async ({ page }) => {
    test.setTimeout(120_000);

    insertRegistrationRoundOrganization(roundLedger, {
      isManagedCompany: true,
      kind: 'CLIENT',
      name: TARGET_NAME,
      organizationCode: `${CODE_PREFIX}TARGET`,
    });
    for (const sentinel of [
      {
        isManagedCompany: false,
        kind: 'CLIENT' as const,
        name: TARGET_NAME,
        organizationCode: `${CODE_PREFIX}SENTINEL_NAME`,
        status: 'ACTIVE',
      },
      {
        isManagedCompany: false,
        kind: 'CLIENT' as const,
        name: `${NAME_PREFIX}SENTINEL`,
        organizationCode: `${CODE_PREFIX}SENTINEL_CODE`,
        status: 'ACTIVE',
      },
    ]) {
      const id = insertRegistrationRoundOrganization(sentinelLedger, sentinel);
      sentinelFacts = [...sentinelFacts, { facts: readRegistrationRoundOrganization(id), id }];
    }

    await page.goto('/register/customer');
    await page.getByLabel('登录邮箱').fill(LOGIN_EMAIL);
    await page.getByLabel('密码').fill(LOGIN_PASSWORD);
    await page.getByLabel('自家公司名称').fill(TARGET_NAME);
    await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });

    registrationCapture = startRegistrationCapture(page, roundLedger, {
      expectedSelfFilledName: TARGET_NAME,
      loginEmail: LOGIN_EMAIL,
    });
    await page.getByRole('button', { name: '注册并开通' }).click();

    // 不等待成功文案：先等真实响应接管收敛
    await registrationCapture.settled;
    if (registrationCapture.error) {
      throw registrationCapture.error;
    }

    // 修复前：此处账号/资料/成员/手填公司全部在账外（红测的核心断言）
    expect(registrationCapture.located).not.toBeNull();
    expect(roundLedger.accounts).toHaveLength(1);
    expect(roundLedger.userInfos).toHaveLength(1);
    expect(roundLedger.memberships).toHaveLength(1);
    console.log(
      `FAULT_A_LEDGER=${JSON.stringify({
        accounts: roundLedger.accounts.map((item) => item.id),
        memberships: roundLedger.memberships.map((item) => item.id),
        organizations: roundLedger.organizations.map((item) => item.id),
        userInfos: roundLedger.userInfos.map((item) => item.id),
      })}`,
    );

    throw new Error('注入：注册成功后、UI 确认前中断');
  });

  test('B. 公司插入返回 ID 后回读失败：真实 ID 保留并可按台账回收', () => {
    const ledger = createRegistrationRoundLedger();
    const input = {
      isManagedCompany: false,
      kind: 'CLIENT' as const,
      name: `${NAME_PREFIX}B`,
      organizationCode: `${CODE_PREFIX}B`,
    };

    expect(() =>
      insertRegistrationRoundOrganization(ledger, input, {
        query: () => {
          throw new Error('注入：公司插入返回 ID 后读回失败');
        },
        readEnv: readBackendEnv,
        write: runGuardedFixtureWrite,
      }),
    ).toThrow(/读回失败/);

    expect(ledger.organizations).toHaveLength(1);
    const organizationId = ledger.organizations[0].id;
    console.log(`FAULT_B_RETAINED_ORGANIZATION_ID=${organizationId}`);
    expect(countById('organization', organizationId)).toBe(1);

    cleanupRegistrationRound(ledger);

    expect(isRegistrationRoundLedgerEmpty(ledger)).toBe(true);
    expect(countById('organization', organizationId)).toBe(0);
  });

  test('C. 账外资料指向本轮公司：首删前 guard 拒绝，实际 DELETE 为 0', () => {
    const ledger = createRegistrationRoundLedger();
    const organizationId = insertRegistrationRoundOrganization(ledger, {
      isManagedCompany: false,
      kind: 'CLIENT',
      name: `${NAME_PREFIX}C`,
      organizationCode: `${CODE_PREFIX}C`,
    });
    const external = insertAccountFixture({
      customerOrganizationId: organizationId,
      loginEmail: faultEmail('c'),
      nickname: 'E2E 账外资料',
      withUserInfo: true,
    });
    const deleteBefore = readDeleteCounter();

    try {
      let error: unknown = null;
      try {
        cleanupRegistrationRound(ledger);
      } catch (caught) {
        error = caught;
      }

      const text = readMysqlErrorText(error);
      expect(text).toContain('rc_unregistered_in_set_base_user_info_customer_organization_id');
      const deleteDelta = readDeleteCounter() - deleteBefore;
      expect(deleteDelta).toBe(0);
      console.log(
        `FAULT_C_GUARD=rc_unregistered_in_set_base_user_info_customer_organization_id DELETE_DELTA=${deleteDelta}`,
      );
      // 未释放、双方行保持：拒绝发生在首删之前
      expect(ledger.organizations).toHaveLength(1);
      expect(countById('organization', organizationId)).toBe(1);
      expect(countById('base_user_info', external.userInfoId ?? 0)).toBe(1);
      expect(countById('base_user_account', external.accountId)).toBe(1);
    } finally {
      deleteAccountFixture(external);
      cleanupRegistrationRound(ledger);
    }

    expect(countById('organization', organizationId)).toBe(0);
  });

  test('D. 账外成员指向本轮账号：首删前 guard 拒绝，实际 DELETE 为 0', () => {
    const ledger = createRegistrationRoundLedger();
    const externalLedger = createRegistrationRoundLedger();
    const roundOrganizationId = insertRegistrationRoundOrganization(ledger, {
      isManagedCompany: false,
      kind: 'CLIENT',
      name: `${NAME_PREFIX}D`,
      organizationCode: `${CODE_PREFIX}D`,
    });
    const externalOrganizationId = insertRegistrationRoundOrganization(externalLedger, {
      isManagedCompany: false,
      kind: 'CLIENT',
      name: `${NAME_PREFIX}D-EXTERNAL`,
      organizationCode: `${CODE_PREFIX}D_EXTERNAL`,
    });
    const loginEmail = faultEmail('d');
    // 本轮账号：无资料行，确保只有「账外成员」这一条边触发
    const account = insertAccountFixture({
      customerOrganizationId: null,
      loginEmail,
      nickname: 'E2E 账外成员',
      withUserInfo: false,
    });
    registerRegistrationRoundAccount(ledger, {
      id: account.accountId,
      loginEmail,
      loginName: null,
    });
    const membershipId = insertMembershipRow(account.accountId, externalOrganizationId);
    const deleteBefore = readDeleteCounter();

    try {
      let error: unknown = null;
      try {
        cleanupRegistrationRound(ledger);
      } catch (caught) {
        error = caught;
      }

      expect(readMysqlErrorText(error)).toContain(
        'rc_unregistered_in_set_organization_membership_account_id',
      );
      const deleteDelta = readDeleteCounter() - deleteBefore;
      expect(deleteDelta).toBe(0);
      console.log(
        `FAULT_D_GUARD=rc_unregistered_in_set_organization_membership_account_id DELETE_DELTA=${deleteDelta}`,
      );
      expect(ledger.accounts).toHaveLength(1);
      expect(countById('base_user_account', account.accountId)).toBe(1);
      expect(countById('organization_membership', membershipId)).toBe(1);
      expect(countById('organization', roundOrganizationId)).toBe(1);
    } finally {
      deleteMembershipRow(membershipId);
      cleanupRegistrationRound(ledger);
      cleanupRegistrationRound(externalLedger);
    }

    expect(countById('base_user_account', account.accountId)).toBe(0);
    expect(countById('organization', roundOrganizationId)).toBe(0);
  });

  test('E. 后序删除失败：事务内探针证明前序 DELETE 已执行且整批回滚', () => {
    const ledger = createRegistrationRoundLedger();
    const loginEmail = faultEmail('e');
    const organizationId = insertRegistrationRoundOrganization(ledger, {
      isManagedCompany: false,
      kind: 'CLIENT',
      name: `${NAME_PREFIX}E`,
      organizationCode: `${CODE_PREFIX}E`,
    });
    const account = insertAccountFixture({
      customerOrganizationId: organizationId,
      loginEmail,
      nickname: 'E2E 完整登记',
      withUserInfo: true,
    });
    const userInfoId = account.userInfoId ?? 0;
    const membershipId = insertMembershipRow(account.accountId, organizationId);

    registerRegistrationRoundAccount(ledger, {
      id: account.accountId,
      loginEmail,
      loginName: null,
    });
    registerRegistrationRoundUserInfo(ledger, {
      accountId: account.accountId,
      customerOrganizationId: organizationId,
      email: loginEmail,
      id: userInfoId,
    });
    registerRegistrationRoundMembership(ledger, {
      accountId: account.accountId,
      id: membershipId,
      organizationId,
    });

    let error: unknown = null;
    try {
      cleanupRegistrationRound(ledger, {
        discoverReferences: discoverRegistrationRoundReferences,
        query: mysqlQuery,
        readEnv: readBackendEnv,
        write: (env, script) => {
          // 保留首删前的全部校验与删除，去掉 COMMIT，在事务内插入探针后失败
          const head = script.split('; COMMIT')[0];
          const probe = `SELECT 'RC_IN_TX', (SELECT COUNT(*) FROM base_user_account WHERE id = ${account.accountId}), (SELECT COUNT(*) FROM organization_membership WHERE id = ${membershipId}), (SELECT COUNT(*) FROM organization WHERE id = ${organizationId})`;
          return runGuardedFixtureWrite(
            env,
            `${head}; ${probe}; SELECT rc_injected_rollback_probe`,
          );
        },
      });
    } catch (caught) {
      error = caught;
    }

    const text = readMysqlErrorText(error);
    expect(text).toContain('rc_injected_rollback_probe');
    // 事务内可见：账号 / 成员 / 公司均已被前序 DELETE 删除
    const inTxLine = readErrorField(error, 'stdout')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('RC_IN_TX'));
    expect(inTxLine).toBe('RC_IN_TX\t0\t0\t0');
    console.log(`FAULT_E_IN_TX=${inTxLine ?? '(missing)'}`);

    // 未 COMMIT 且连接关闭 → 整批回滚：行全部还在
    expect(countById('base_user_account', account.accountId)).toBe(1);
    expect(countById('base_user_info', userInfoId)).toBe(1);
    expect(countById('organization_membership', membershipId)).toBe(1);
    expect(countById('organization', organizationId)).toBe(1);
    expect(ledger.accounts).toHaveLength(1);

    // 台账未释放，真实收尾仍可完成
    cleanupRegistrationRound(ledger);
    expect(isRegistrationRoundLedgerEmpty(ledger)).toBe(true);
    expect(countById('base_user_account', account.accountId)).toBe(0);
    expect(countById('organization', organizationId)).toBe(0);
  });

  test('F. 成功响应在客户端边界丢失：UI 先失败仍保留提交结果待确认诊断', async ({ page }) => {
    test.setTimeout(150_000);

    const loginEmail = faultEmail('f');
    // 不落在 NAME_PREFIX 内：本轮台账零残留断言只针对登记过的事实
    const selfFilledName = `E2E-FAULTF-${RUN_TAG}-TARGET`;
    const captureLedger = createRegistrationRoundLedger();

    // 真实执行 registerWeb：代理收到服务端成功响应与账号 ID 后终止向浏览器转发
    await page.route('**/graphql', async (route) => {
      if (!(route.request().postData() ?? '').includes('RegisterCustomer')) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        data?: { registerWeb?: { accountId?: number | null } | null };
      };
      const accountId = body.data?.registerWeb?.accountId ?? 0;
      if (typeof accountId !== 'number' || accountId <= 0) {
        throw new Error(`代理未取到服务端成功响应与账号 ID：${JSON.stringify(body)}`);
      }
      lostAttempt = { accountId, loginEmail };
      await route.abort('failed');
    });

    await page.goto('/register/customer');
    await page.getByLabel('登录邮箱').fill(loginEmail);
    await page.getByLabel('密码').fill(LOGIN_PASSWORD);
    await page.getByLabel('自家公司名称').fill(selfFilledName);

    registrationCapture = startRegistrationCapture(page, captureLedger, {
      expectedSelfFilledName: selfFilledName,
      loginEmail,
      timeoutMs: 5_000,
    });
    await page.getByRole('button', { name: '注册并开通' }).click();

    // 响应被丢弃 → 成功文案永不出现；主因原样上抛，诊断由 afterAll 聚合
    try {
      await expect(page.getByText(SUCCESS)).toBeVisible({ timeout: 8_000 });
    } catch (error) {
      uiFailure = error;
      throw error;
    }

    throw new Error('响应丢失反例未按预期失败：成功文案出现了');
  });

  test('G. 明确注册拒绝：无新增写入，结论标记为明确拒绝', async ({ page }) => {
    test.setTimeout(90_000);

    const loginEmail = faultEmail('g');
    const existing = insertAccountFixture({
      customerOrganizationId: null,
      loginEmail,
      nickname: 'E2E 已存在账号',
      withUserInfo: false,
    });
    const ledger = createRegistrationRoundLedger();
    // 拒绝是预期结果，用局部 capture：不把「明确拒绝」带进主流程收尾
    const capture = startRegistrationCapture(page, ledger, {
      expectedSelfFilledName: `${NAME_PREFIX}G-TARGET`,
      loginEmail,
      timeoutMs: 20_000,
    });

    try {
      await page.goto('/register/customer');
      await page.getByLabel('登录邮箱').fill(loginEmail);
      await page.getByLabel('密码').fill(LOGIN_PASSWORD);
      await page.getByLabel('自家公司名称').fill(`${NAME_PREFIX}G-TARGET`);
      await page.getByRole('button', { name: '注册并开通' }).click();

      await capture.settled;
      expect(capture.outcome?.kind).toBe('rejected');
      console.log(
        `FAULT_G_DIAGNOSIS=${describeCaptureDiagnosis(capture, { loginEmail }) ?? '(none)'}`,
      );

      // 明确拒绝 = 无新增写入：该邮箱仍只有夹具这一行，本轮台账为空
      expect(
        Number(
          mysqlQuery(`SELECT COUNT(*) FROM base_user_account WHERE login_email = '${loginEmail}'`),
        ),
      ).toBe(1);
      expect(isRegistrationRoundLedgerEmpty(ledger)).toBe(true);
    } finally {
      deleteAccountFixture(existing);
    }
  });
});
