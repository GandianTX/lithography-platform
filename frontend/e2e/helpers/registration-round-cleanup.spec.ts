// e2e/helpers/registration-round-cleanup.spec.ts
// @vitest-environment node
// 注册手填公司名规格「按实际 ID 台账」清理 helper 的反向单测（B 复审 P1 第 2 项）。
//
// 覆盖的安全边界：
// - 空台账完全 no-op：不读环境、不启动 mysql、不执行任何写入；
// - 登记只接受真实生成 ID / 受控枚举；重复登记与非法输入直接拒绝；
// - 公司插入只有回读核验通过后入账；写入被拒或回读不符时台账保持为空；
// - 账号由注册响应 ID 定位，核验通过即入账（后续核验失败也不会丢失真实 ID）；
// - 清理脚本只按真实 ID + 绑定事实删除，不含 LIKE / 名称 / 邮箱条件；
// - setup 中断（只有部分公司）、注册失败（只有公司）、部分创建（缺资料/成员）
//   都能生成正确脚本；台账内部引用不闭合时拒绝清理；
// - 后序删除故障与收尾失败都必须上抛，不得静默；
// - 未入账的同名/同前缀哨兵 ID 永不出现在脚本中。

import { describe, expect, it, vi } from 'vitest';

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import {
  buildRegistrationRoundCleanupScript,
  cleanupRegistrationRound,
  createRegistrationRoundLedger,
  discoverRegistrationRoundReferences,
  insertRegistrationRoundOrganization,
  isRegistrationRoundLedgerEmpty,
  locateRegistrationRoundAccount,
  readRegistrationRoundOrganization,
  registerRegistrationRoundAccount,
  registerRegistrationRoundApplication,
  registerRegistrationRoundMembership,
  registerRegistrationRoundOrganization,
  registerRegistrationRoundUserInfo,
  type RegistrationRoundCleanupDeps,
  type RegistrationRoundLedger,
  retainRegistrationRoundOrganization,
} from './registration-round-cleanup';

const utf8Hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex').toUpperCase();

const NO_REFERENCES: RegistrationRoundCleanupDeps['discoverReferences'] = () => ({
  account: [],
  organization: [],
});

/** 只读断言用的依赖：任何一次读取/写入都视为实现违约 */
function forbiddenDeps(): RegistrationRoundCleanupDeps {
  return {
    discoverReferences: () => {
      throw new Error('空台账不得发现引用');
    },
    query: () => {
      throw new Error('空台账不得查询数据库');
    },
    readEnv: () => {
      throw new Error('空台账不得读取环境');
    },
    write: () => {
      throw new Error('空台账不得写入数据库');
    },
  };
}

function seededLedger(): RegistrationRoundLedger {
  const ledger = createRegistrationRoundLedger();
  registerRegistrationRoundOrganization(ledger, {
    id: 77,
    isManagedCompany: true,
    isServiceProvider: false,
    kind: 'CLIENT',
    name: 'E2E-NM-ROUND-01',
    organizationCode: 'E2E_NM_ROUND_F01',
    status: 'ACTIVE',
  });
  registerRegistrationRoundAccount(ledger, {
    id: 501,
    loginEmail: 'e2e.name.round@example.com',
    loginName: 'e2e_name_round',
  });
  registerRegistrationRoundUserInfo(ledger, {
    accountId: 501,
    customerOrganizationId: 900,
    email: 'e2e.name.round@example.com',
    id: 601,
  });
  registerRegistrationRoundMembership(ledger, {
    accountId: 501,
    id: 701,
    organizationId: 900,
  });
  registerRegistrationRoundOrganization(ledger, {
    id: 900,
    isManagedCompany: false,
    isServiceProvider: false,
    kind: 'CLIENT',
    name: 'E2E-NM-ROUND-99',
    organizationCode: 'E2E_NM_ROUND_SELF',
    status: 'ACTIVE',
  });

  return ledger;
}

const expectScriptHasNoNameBasedDeletion = (script: string): void => {
  expect(script).not.toMatch(/\bLIKE\b/i);
  expect(script).not.toMatch(/login_email = '/);
  expect(script).not.toMatch(/name = '/);
  expect(script).not.toMatch(/organization_code = '/);
};

describe('registration-round-cleanup：空台账与登记校验', () => {
  it('空台账清理完全 no-op（不读环境、不启动 mysql）', () => {
    const ledger = createRegistrationRoundLedger();
    expect(isRegistrationRoundLedgerEmpty(ledger)).toBe(true);

    expect(() => cleanupRegistrationRound(ledger, forbiddenDeps())).not.toThrow();
    expect(
      buildRegistrationRoundCleanupScript(ledger, { account: [], organization: [] }, 'x'),
    ).toBe('');
  });

  it('同 ID 重复登记被拒绝，且不改动已有台账项', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundAccount(ledger, {
      id: 501,
      loginEmail: 'a@example.com',
      loginName: 'a',
    });

    expect(() =>
      registerRegistrationRoundAccount(ledger, {
        id: 501,
        loginEmail: 'b@example.com',
        loginName: 'b',
      }),
    ).toThrow(/ID 501 重复登记/);
    expect(ledger.accounts).toHaveLength(1);
    expect(ledger.accounts[0].loginEmail).toBe('a@example.com');
  });

  it('非法 ID / 空名称 / 非受控枚举被拒绝', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      registerRegistrationRoundOrganization(ledger, {
        id: 0,
        isManagedCompany: true,
        isServiceProvider: false,
        kind: 'CLIENT',
        name: 'X',
        organizationCode: 'C',
        status: 'ACTIVE',
      }),
    ).toThrow(/正整数校验/);
    expect(() =>
      registerRegistrationRoundOrganization(ledger, {
        id: 1,
        isManagedCompany: true,
        isServiceProvider: false,
        kind: 'CLIENT',
        name: '   ',
        organizationCode: 'C',
        status: 'ACTIVE',
      }),
    ).toThrow(/公司名称.*为空/);
    expect(() =>
      registerRegistrationRoundOrganization(ledger, {
        id: 1,
        isManagedCompany: true,
        isServiceProvider: false,
        kind: "CLIENT' OR 1=1" as never,
        name: 'X',
        organizationCode: 'C',
        status: 'ACTIVE',
      }),
    ).toThrow(/不是受控枚举/);
    expect(ledger.organizations).toHaveLength(0);
  });
});

describe('registration-round-cleanup：公司夹具即时登记', () => {
  const input = {
    isManagedCompany: true,
    kind: 'CLIENT' as const,
    name: 'E2E-NM-ROUND-01',
    organizationCode: 'E2E_NM_ROUND_F01',
  };

  it('插入成功即按已知预期登记真实 ID，回读核验通过后返回 ID；SQL 文本经 HEX 绑定', () => {
    const ledger = createRegistrationRoundLedger();
    const write = vi.fn((env: Record<string, string>, sql: string) => {
      expect(env.DB_NAME).toBe(DEDICATED_E2E_DB_NAME);
      expect(sql).toContain('INSERT INTO organization');
      return '77\n';
    });
    const query = vi.fn(() => '77\tE2E_NM_ROUND_F01\tE2E-NM-ROUND-01\tCLIENT\tACTIVE\t1\t0');

    const id = insertRegistrationRoundOrganization(ledger, input, {
      query,
      readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
      write,
    });

    expect(id).toBe(77);
    expect(ledger.organizations).toEqual([
      {
        id: 77,
        isManagedCompany: true,
        isServiceProvider: false,
        kind: 'CLIENT',
        name: 'E2E-NM-ROUND-01',
        organizationCode: 'E2E_NM_ROUND_F01',
        status: 'ACTIVE',
      },
    ]);
    const sql = write.mock.calls[0][1];
    expect(sql).toContain(`UNHEX('${utf8Hex(input.name)}')`);
    expect(sql).not.toContain(input.name);
  });

  it('写入被拒（许可/库名不符）时直接上抛且台账保持为空', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      insertRegistrationRoundOrganization(ledger, input, {
        query: () => {
          throw new Error('不得在写入失败后查询');
        },
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write: () => {
          throw new Error('真实 E2E 夹具写入被拒绝');
        },
      }),
    ).toThrow(/夹具写入被拒绝/);
    expect(isRegistrationRoundLedgerEmpty(ledger)).toBe(true);
  });

  it('回读核验不符（命中多行/字段漂移）时上抛，但真实 ID 保留在台账（不丢已创建行）', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      insertRegistrationRoundOrganization(ledger, input, {
        query: () => '77\ta\tb\n78\tc\td',
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write: () => '77\n',
      }),
    ).toThrow(/应恰好命中 1 行/);
    // P2-01：ID 一旦生成就必须在账上，否则回读失败会让该行永久残留
    expect(ledger.organizations.map((item) => item.id)).toEqual([77]);
  });

  it('回读字段漂移时上抛；已登记事实保留，删除侧会按绑定事实拒绝', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      insertRegistrationRoundOrganization(ledger, input, {
        // ID 一致但名称漂移
        query: () => '77\tE2E_NM_ROUND_F01\t其他公司\tCLIENT\tACTIVE\t1\t0',
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write: () => '77\n',
      }),
    ).toThrow(/公司回读核验不符（ID 77）/);
    expect(ledger.organizations[0].name).toBe(input.name);
  });
});

describe('registration-round-cleanup：注册响应定位账号与归属', () => {
  const selfFilledName = 'E2E-NM-ROUND-99';
  const loginEmail = 'e2e.name.round@example.com';

  type ResponseOptions = {
    readonly loginName?: string;
    readonly userInfoCustomerOrganizationId?: string;
    readonly membershipOrganizationId?: string;
    readonly organizationName?: string;
  };

  function router(options: ResponseOptions = {}) {
    return (sql: string): string => {
      if (sql.includes('FROM base_user_account')) {
        return `501\t${options.loginName ?? 'e2e_name_round'}\t${loginEmail}`;
      }
      if (sql.includes('FROM base_user_info')) {
        return `601\t${loginEmail}\t${options.userInfoCustomerOrganizationId ?? '900'}`;
      }
      if (sql.includes('FROM organization_membership')) {
        return `701\t${options.membershipOrganizationId ?? '900'}`;
      }
      if (sql.includes('FROM organization')) {
        if (options.organizationName !== undefined && options.organizationName !== selfFilledName) {
          // 模拟按 HEX(name) 条件查不到行：同名哨兵不会被当作本轮手填公司
          return '';
        }
        return `900\tE2E_NM_ROUND_SELF\t${selfFilledName}\tCLIENT\tACTIVE\t0\t0`;
      }
      throw new Error(`未预期的查询：${sql}`);
    };
  }

  it('账号/资料/成员/手填公司全部按真实 ID 核验后登记', () => {
    const ledger = createRegistrationRoundLedger();

    const located = locateRegistrationRoundAccount(
      ledger,
      { accountId: 501, expectedSelfFilledName: selfFilledName, loginEmail },
      { query: router() },
    );

    expect(located).toEqual({ accountId: 501, selfFilledOrganizationId: 900 });
    expect(ledger.accounts).toHaveLength(1);
    expect(ledger.userInfos).toEqual([
      { accountId: 501, customerOrganizationId: 900, email: loginEmail, id: 601 },
    ]);
    expect(ledger.memberships).toEqual([{ accountId: 501, id: 701, organizationId: 900 }]);
    expect(ledger.organizations.map((item) => item.id)).toEqual([900]);
  });

  it('客户自助注册登录名为 NULL 时按 IS NULL 绑定与删除（不误判为漂移）', () => {
    const ledger = createRegistrationRoundLedger();

    locateRegistrationRoundAccount(
      ledger,
      { accountId: 501, expectedSelfFilledName: selfFilledName, loginEmail },
      { query: router({ loginName: 'NULL' }) },
    );
    expect(ledger.accounts[0].loginName).toBeNull();

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );
    expect(script).toContain('login_name IS NULL');
    expect(script).not.toContain(`HEX(login_name) = '${utf8Hex('NULL')}'`);
  });

  it('资料与成员归属不一致时拒绝登记，但已核验账号 ID 保留在台账', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      locateRegistrationRoundAccount(
        ledger,
        { accountId: 501, expectedSelfFilledName: selfFilledName, loginEmail },
        { query: router({ membershipOrganizationId: '901' }) },
      ),
    ).toThrow(/资料归属 900 与成员关系公司 901 不一致/);
    expect(ledger.accounts.map((item) => item.id)).toEqual([501]);
    expect(ledger.userInfos).toHaveLength(0);
    expect(ledger.memberships).toHaveLength(0);
  });

  it('资料归属为空时拒绝登记（无法定位手填公司）', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      locateRegistrationRoundAccount(
        ledger,
        { accountId: 501, expectedSelfFilledName: selfFilledName, loginEmail },
        { query: router({ userInfoCustomerOrganizationId: 'NULL' }) },
      ),
    ).toThrow(/customer_organization_id 为空/);
    expect(ledger.accounts.map((item) => item.id)).toEqual([501]);
    expect(ledger.organizations).toHaveLength(0);
  });

  it('手填公司名称不符（同名未受管哨兵不会被误认）时拒绝登记', () => {
    const ledger = createRegistrationRoundLedger();

    expect(() =>
      locateRegistrationRoundAccount(
        ledger,
        { accountId: 501, expectedSelfFilledName: selfFilledName, loginEmail },
        { query: router({ organizationName: '其他公司' }) },
      ),
    ).toThrow(/应恰好命中 1 行/);
    expect(ledger.organizations).toHaveLength(0);
  });
});

describe('registration-round-cleanup：脚本生成（含部分台账）', () => {
  it('完整台账：只按真实 ID 删除，顺序为成员 → 资料 → 账号 → 公司，残留断言先于 COMMIT', () => {
    const ledger = seededLedger();
    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );

    expectScriptHasNoNameBasedDeletion(script);
    expect(script).toContain(`@rc_database = '${DEDICATED_E2E_DB_NAME}'`);
    expect(script).toContain('rc_database_must_equal_strict_dedicated_e2e');
    expect(script).toContain('DELETE FROM organization_membership WHERE id = 701');
    expect(script).toContain('DELETE FROM base_user_info WHERE id = 601');
    expect(script).toContain('DELETE FROM base_user_account WHERE id = 501');
    expect(script).toContain('DELETE FROM organization WHERE id = 900');
    expect(script).toContain('DELETE FROM organization WHERE id = 77');
    expect(script).toContain('rc_residue_must_be_zero');

    const order = [
      'DELETE FROM organization_membership WHERE id = 701',
      'DELETE FROM base_user_info WHERE id = 601',
      'DELETE FROM base_user_account WHERE id = 501',
      'DELETE FROM organization WHERE id = 900',
      'DELETE FROM organization WHERE id = 77',
      'rc_residue_must_be_zero',
      'COMMIT',
    ].map((token) => script.indexOf(token));
    expect(
      order.every(
        (index, position) => index > 0 && (position === 0 || index > order[position - 1]),
      ),
    ).toBe(true);
  });

  it('申请台账：按真实主键绑定与删除，账外申请在首删前拒绝', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundAccount(ledger, {
      id: 501,
      loginEmail: 'e2e.application.round@example.com',
      loginName: 'e2e_application_round',
    });
    registerRegistrationRoundApplication(ledger, { accountId: 501, id: 801 });

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      {
        account: [],
        inSet: [
          { column: 'account_id', table: 'engineer_registration_application', target: 'account' },
        ],
        organization: [],
      },
      DEDICATED_E2E_DB_NAME,
    );

    expectScriptHasNoNameBasedDeletion(script);
    expect(script).toContain(
      'SELECT id INTO @rc_app_801_row FROM engineer_registration_application WHERE id = 801 AND account_id = 501 FOR UPDATE',
    );
    expect(script).toContain('rc_app_801_binding_mismatch');
    expect(script).toContain(
      '(SELECT COUNT(*) FROM `engineer_registration_application` WHERE `account_id` = 501 AND id NOT IN (801))',
    );
    expect(script).toContain('rc_unregistered_in_set_engineer_registration_application_account_id');
    expect(script).toContain(
      'DELETE FROM engineer_registration_application WHERE id = 801 AND account_id = 501',
    );
    expect(script).toContain('rc_app_801_delete_rows_mismatch');
    expect(script).toContain(
      '(SELECT COUNT(*) FROM engineer_registration_application WHERE id = 801)',
    );
    // 申请必须先于账号删除，预检必须先于任何 DELETE
    expect(script.indexOf('DELETE FROM engineer_registration_application')).toBeLessThan(
      script.indexOf('DELETE FROM base_user_account'),
    );
    expect(
      script.indexOf('rc_unregistered_in_set_engineer_registration_application_account_id'),
    ).toBeLessThan(script.indexOf('DELETE FROM engineer_registration_application'));
    expect(script.indexOf('rc_residue_must_be_zero')).toBeGreaterThan(
      script.indexOf('DELETE FROM engineer_registration_application'),
    );
  });

  it('用户变量名与预处理语句名都不超过 MySQL 64 字符上限（长表名/长列名边）', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundAccount(ledger, {
      id: 501,
      loginEmail: 'e2e.long.edge@example.com',
      loginName: 'e2e_long_edge',
    });
    registerRegistrationRoundApplication(ledger, { accountId: 501, id: 801 });

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      {
        account: [],
        inSet: [
          {
            column: 'pending_account_id',
            table: 'engineer_registration_application',
            target: 'account',
          },
        ],
        organization: [],
      },
      DEDICATED_E2E_DB_NAME,
    );

    // MySQL 对用户变量名与 PREPARE 名称都有 64 字符上限（超限为 ERROR 3061），
    // 旧实现用 `rc_inset_<table>_<column>` 命名，长边会直接让整批清理失败。
    const variableNames = [...script.matchAll(/@([A-Za-z0-9_]+)/gu)].map((match) => match[1]);
    const statementNames = [...script.matchAll(/PREPARE ([A-Za-z0-9_]+) FROM/gu)].map(
      (match) => match[1],
    );
    expect(variableNames.length).toBeGreaterThan(0);
    expect(statementNames.length).toBeGreaterThan(0);
    expect(variableNames.filter((name) => name.length > 64)).toEqual([]);
    expect(statementNames.filter((name) => name.length > 64)).toEqual([]);
    // 短变量名不影响拒绝标记的可读性：标记仍保留完整边名
    expect(script).toContain(
      'rc_unregistered_in_set_engineer_registration_application_pending_account_id',
    );
  });

  it('申请指向未登记账号时拒绝清理', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundApplication(ledger, { accountId: 999, id: 801 });

    expect(() =>
      buildRegistrationRoundCleanupScript(ledger, { account: [], organization: [] }, 'db'),
    ).toThrow(/申请 801 的账号 999 未登记/);
  });

  it('保留公司只放行子行归属事实，永不出现在删除脚本', () => {
    const ledger = createRegistrationRoundLedger();
    retainRegistrationRoundOrganization(ledger, 900);
    registerRegistrationRoundAccount(ledger, {
      id: 501,
      loginEmail: 'e2e.retained.round@example.com',
      loginName: 'e2e_retained_round',
    });
    registerRegistrationRoundUserInfo(ledger, {
      accountId: 501,
      customerOrganizationId: 900,
      email: 'e2e.retained.round@example.com',
      id: 601,
    });
    registerRegistrationRoundMembership(ledger, {
      accountId: 501,
      id: 701,
      organizationId: 900,
    });

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );

    expect(script).toContain('DELETE FROM base_user_account WHERE id = 501');
    expect(script).toContain('DELETE FROM organization_membership WHERE id = 701');
    expect(script).toContain('DELETE FROM base_user_info WHERE id = 601');
    // 保留公司既不加锁也不删除，且不进入残留断言
    expect(script).not.toContain('rc_org_900');
    expect(script).not.toContain('DELETE FROM organization WHERE');
    expect(script).not.toContain('organization WHERE id = 900)');
  });

  it('未登记的归属公司仍然拒绝清理，已登记为可删除公司不得再声明保留', () => {
    const missing = createRegistrationRoundLedger();
    registerRegistrationRoundAccount(missing, {
      id: 501,
      loginEmail: 'e2e.missing.org@example.com',
      loginName: 'e2e_missing_org',
    });
    registerRegistrationRoundUserInfo(missing, {
      accountId: 501,
      customerOrganizationId: 902,
      email: 'e2e.missing.org@example.com',
      id: 601,
    });

    expect(() =>
      buildRegistrationRoundCleanupScript(missing, { account: [], organization: [] }, 'db'),
    ).toThrow(/资料 601 的归属公司 902 未登记/);

    expect(() => retainRegistrationRoundOrganization(seededLedger(), 77)).toThrow(
      /已登记为本轮可删除公司/,
    );
  });

  it('setup 中断（只有部分公司）：脚本只删这些公司，不触碰账号/资料/成员', () => {
    const ledger = createRegistrationRoundLedger();
    const insertAt = (id: number, code: string, name: string) =>
      registerRegistrationRoundOrganization(ledger, {
        id,
        isManagedCompany: true,
        isServiceProvider: false,
        kind: 'CLIENT',
        name,
        organizationCode: code,
        status: 'ACTIVE',
      });
    insertAt(11, 'E2E_NM_ROUND_F01', 'E2E-NM-ROUND-01');
    insertAt(12, 'E2E_NM_ROUND_F02', 'E2E-NM-ROUND-02');

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );
    expect(script).toContain('DELETE FROM organization WHERE id = 11');
    expect(script).toContain('DELETE FROM organization WHERE id = 12');
    expect(script).not.toContain('DELETE FROM base_user_account');
    expect(script).not.toContain('DELETE FROM base_user_info');
    expect(script).not.toContain('DELETE FROM organization_membership');
  });

  it('注册失败（只有公司台账）时同样只删公司', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundOrganization(ledger, {
      id: 11,
      isManagedCompany: true,
      isServiceProvider: false,
      kind: 'CLIENT',
      name: 'E2E-NM-ROUND-01',
      organizationCode: 'E2E_NM_ROUND_F01',
      status: 'ACTIVE',
    });

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );
    expect(script).toContain('DELETE FROM organization WHERE id = 11');
    expect(script).not.toContain('base_user_account');
  });

  it('部分创建（账号已登记、资料/成员未登记）仍可清理账号', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundAccount(ledger, {
      id: 501,
      loginEmail: 'e2e.name.round@example.com',
      loginName: 'e2e_name_round',
    });

    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );
    expect(script).toContain('DELETE FROM base_user_account WHERE id = 501');
    expect(script).not.toContain('DELETE FROM base_user_info');
  });

  it('台账引用不闭合（成员关系指向未登记账号/公司）时拒绝清理', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundMembership(ledger, { accountId: 501, id: 701, organizationId: 900 });

    expect(() =>
      buildRegistrationRoundCleanupScript(ledger, { account: [], organization: [] }, 'db'),
    ).toThrow(/未登记，拒绝清理/);
  });

  it('目标库名非法时拒绝生成脚本', () => {
    const ledger = seededLedger();
    expect(() =>
      buildRegistrationRoundCleanupScript(ledger, { account: [], organization: [] }, "db'--"),
    ).toThrow(/目标库名未通过标识符校验/);
  });

  it('台账内子表账外子行在首删前被独立 guard 拒绝，已登记子行被排除（P2-02）', () => {
    const ledger = seededLedger();
    const script = buildRegistrationRoundCleanupScript(
      ledger,
      {
        account: [],
        inSet: [
          { column: 'customer_organization_id', table: 'base_user_info', target: 'organization' },
          { column: 'account_id', table: 'organization_membership', target: 'account' },
        ],
        organization: [],
      },
      DEDICATED_E2E_DB_NAME,
    );

    expect(script).toContain('rc_unregistered_in_set_base_user_info_customer_organization_id');
    expect(script).toContain('rc_unregistered_in_set_organization_membership_account_id');
    // 只放行已登记子行：登记的资料 601 / 成员 701 必须出现在 NOT IN 排除列表
    expect(script).toContain(
      '(SELECT COUNT(*) FROM `base_user_info` WHERE `customer_organization_id` = 900 AND id NOT IN (601))',
    );
    expect(script).toContain(
      '(SELECT COUNT(*) FROM `organization_membership` WHERE `account_id` = 501 AND id NOT IN (701))',
    );
    // 预检必须先于任何 DELETE，不能靠外键在删除途中兜底
    const guardIndex = script.indexOf('rc_unregistered_in_set_organization_membership_account_id');
    expect(guardIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeLessThan(script.indexOf('DELETE FROM organization_membership'));
  });

  it('台账未登记子行时该边仍需为 0（不存在「无子行即跳过」的空洞）', () => {
    const ledger = createRegistrationRoundLedger();
    registerRegistrationRoundOrganization(ledger, {
      id: 900,
      isManagedCompany: false,
      isServiceProvider: false,
      kind: 'CLIENT',
      name: 'E2E-NM-ROUND-99',
      organizationCode: 'E2E_NM_ROUND_SELF',
      status: 'ACTIVE',
    });
    const script = buildRegistrationRoundCleanupScript(
      ledger,
      {
        account: [],
        inSet: [
          { column: 'customer_organization_id', table: 'base_user_info', target: 'organization' },
        ],
        organization: [],
      },
      DEDICATED_E2E_DB_NAME,
    );

    expect(script).toContain(
      '(SELECT COUNT(*) FROM `base_user_info` WHERE `customer_organization_id` = 900)',
    );
    expect(script).not.toContain('id NOT IN');
  });

  it('集合外引用计入断言，且引用表名出现在脚本中', () => {
    const ledger = seededLedger();
    const references = {
      account: [{ column: 'customer_account_id', table: 'repair_request' }],
      organization: [{ column: 'owner_organization_id', table: 'reference_document' }],
    };
    const script = buildRegistrationRoundCleanupScript(ledger, references, DEDICATED_E2E_DB_NAME);

    expect(script).toContain('repair_request');
    expect(script).toContain('reference_document');
    expect(script).toContain('rc_unregistered_external_references');
  });
});

describe('registration-round-cleanup：清理执行与错误上抛', () => {
  it('后序删除故障（write 抛错）整批失败并原样上抛', () => {
    const ledger = seededLedger();
    const write = vi.fn(() => {
      throw new Error('ERROR 1451: Cannot delete or update a parent row（DELETE 后序失败）');
    });

    expect(() =>
      cleanupRegistrationRound(ledger, {
        discoverReferences: NO_REFERENCES,
        query: () => '',
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write,
      }),
    ).toThrow(/DELETE 后序失败/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('收尾失败（许可缺失/库名不符）错误可见且不吞掉', () => {
    const ledger = seededLedger();

    expect(() =>
      cleanupRegistrationRound(ledger, {
        discoverReferences: NO_REFERENCES,
        query: () => '',
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write: () => {
          throw new Error('真实 E2E 夹具写入被拒绝：不是专用隔离库');
        },
      }),
    ).toThrow(/不是专用隔离库/);
  });

  it('使用注入的引用发现结果，且发现失败时拒绝清理', () => {
    const ledger = seededLedger();
    const discoverReferences = vi.fn(() => {
      throw new Error('引用闭包不可用');
    });

    expect(() =>
      cleanupRegistrationRound(ledger, {
        discoverReferences,
        query: () => '',
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write: () => 'ok',
      }),
    ).toThrow(/引用闭包不可用/);
    expect(discoverReferences).toHaveBeenCalledTimes(1);
  });

  it('清理成功即释放台账：第二次调用完全 no-op（不重复删除）', () => {
    const ledger = seededLedger();
    const write = vi.fn(() => 'ok');
    const deps: RegistrationRoundCleanupDeps = {
      discoverReferences: NO_REFERENCES,
      query: () => '',
      readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
      write,
    };

    cleanupRegistrationRound(ledger, deps);
    expect(isRegistrationRoundLedgerEmpty(ledger)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);

    // 已释放：第二次调用连环境都不读、不启动 mysql
    cleanupRegistrationRound(ledger, forbiddenDeps());
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('清理失败（后序删除故障）时不释放台账，afterAll 仍可重试', () => {
    const ledger = seededLedger();

    expect(() =>
      cleanupRegistrationRound(ledger, {
        discoverReferences: NO_REFERENCES,
        query: () => '',
        readEnv: () => ({ DB_NAME: DEDICATED_E2E_DB_NAME }),
        write: () => {
          throw new Error('ERROR 1451（整批回滚）');
        },
      }),
    ).toThrow(/整批回滚/);
    expect(ledger.organizations).toHaveLength(2);
    expect(ledger.accounts).toHaveLength(1);
    expect(ledger.userInfos).toHaveLength(1);
    expect(ledger.memberships).toHaveLength(1);
  });

  it('未入账的哨兵 ID 永不出现在清理脚本中', () => {
    const ledger = seededLedger();
    const script = buildRegistrationRoundCleanupScript(
      ledger,
      { account: [], organization: [] },
      DEDICATED_E2E_DB_NAME,
    );

    expect(script).not.toContain('WHERE id = 910');
    expect(script).not.toContain('WHERE id = 911');
  });
});

describe('registration-round-cleanup：引用闭包发现与哨兵核验', () => {
  it('外部 FK 与逻辑列都计入引用；台账内子表的边收敛为受管子行约束（不再整体跳过）', () => {
    const query = (sql: string): string => {
      if (sql.includes('KEY_COLUMN_USAGE')) {
        return [
          'repair_request\tcustomer_account_id\tbase_user_account',
          'base_user_info\taccount_id\tbase_user_account',
          'organization_membership\taccount_id\tbase_user_account',
        ].join('\n');
      }
      return [
        'repair_request\tcustomer_account_id',
        'base_user_account\tid',
        'engineer_response\taccepted_by_engineer_account_id',
        'base_user_info\tcustomer_organization_id',
        'organization_membership\torganization_id',
      ].join('\n');
    };

    const references = discoverRegistrationRoundReferences(query);
    expect(references.account).toEqual([
      { column: 'accepted_by_engineer_account_id', table: 'engineer_response' },
      { column: 'customer_account_id', table: 'repair_request' },
    ]);
    expect(references.organization).toEqual([]);
    // P2-02：台账内子表的边不再被丢弃，而是按父行类型记录，供首删前精确预检
    expect(references.inSet).toEqual([
      { column: 'account_id', table: 'base_user_info', target: 'account' },
      {
        column: 'customer_organization_id',
        table: 'base_user_info',
        target: 'organization',
      },
      { column: 'account_id', table: 'organization_membership', target: 'account' },
      { column: 'organization_id', table: 'organization_membership', target: 'organization' },
    ]);
  });

  it('集合外指向 base_user_info / organization_membership 的 FK 失败关闭', () => {
    const query = (sql: string): string =>
      sql.includes('KEY_COLUMN_USAGE') ? 'audit_log\tuser_info_id\tbase_user_info' : '';

    expect(() => discoverRegistrationRoundReferences(query)).toThrow(
      /未受支持的引用目标 "base_user_info"/,
    );
  });

  it('非法标识符失败关闭', () => {
    const query = (sql: string): string =>
      sql.includes('KEY_COLUMN_USAGE') ? 'bad-table\tcol\tbase_user_account' : '';

    expect(() => discoverRegistrationRoundReferences(query)).toThrow(/非法标识符/);
  });

  it('哨兵事实回读失败关闭（行数不符 / 表已被删）', () => {
    expect(() => readRegistrationRoundOrganization(910, { query: () => '' })).toThrow(
      /应恰好命中 1 行/,
    );
  });
});
