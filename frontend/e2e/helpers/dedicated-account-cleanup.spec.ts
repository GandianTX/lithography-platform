// e2e/helpers/dedicated-account-cleanup.spec.ts
// @vitest-environment node
// 专用账号物理清理 helper 的单元测试（R2 修正轮第 4 项；R4 修正轮扩展；终审 I3 收紧）。
// vitest 运行，Playwright 经 testIgnore 排除 helpers 目录。node 环境：helper 内部依赖
// import.meta.url 解析 env 文件路径，须在 node 环境下运行。
//
// 关键安全断言（终审 I3）：
// - 入参是本次创建的资源记录；ID、登录名、角色、组织、成员关系与资料主键逐项校验；
// - 清理入口自身要求显式 opt-in + 严格专用库名，拒绝时绝不启动 mysql 进程；
// - 创建响应丢失时登记为空、无删除目标；回读核验不符时登记保留但拒绝删除（失败关闭）；
// - 删除脚本在**同一会话同一事务**内复核 DATABASE()、FOR UPDATE 锁定并核对绑定、
//   检查集合外引用；任一断言失败时 mysql batch 立即中止，DELETE 一条都不会执行；
// - 只按已核验主键删除成员关系 / 资料 / 账号，不再推导式删除 AI、工单、资料等业务表；
// - 残留非零、绑定不符与账外引用分别可诊断，且互不覆盖。

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEDICATED_E2E_DB_NAME } from '../../e2e-real/dedicated-e2e-environment';

import {
  assertApiSqlSameDatabase,
  cleanupRegisteredDedicatedAccounts,
  DEDICATED_LOGIN_NAME_PATTERN,
  type DedicatedAccountExpectation,
  DedicatedCleanupBatchError,
  deleteE2EDedicatedAccount,
  deleteE2EDedicatedAccounts,
  describeDedicatedAccountCleanupTarget,
  preflightDedicatedAccountCleanup,
  readAccountCountByLoginName,
  readActingOrganizationId,
  readDedicatedAccountCleanupResidue,
  readDedicatedAccountCreationFacts,
  readDedicatedCleanupReferenceColumns,
  registerCreatedDedicatedAccount,
  type RegisteredDedicatedAccount,
  runWithCleanup,
  toErrorMessage,
} from './dedicated-account-cleanup';

const { execFileSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}));

const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
const DEDICATED_LOGIN_NAME = 'e2e-pw-1758000000000';
const DEDICATED_NICKNAME = 'E2E 改密专用账号';

function envFile(dbName: string): string {
  return `DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=${dbName}\n`;
}

function utf8Hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex').toUpperCase();
}

const EXPECTATION: DedicatedAccountExpectation = {
  accessGroup: ['ENGINEER'],
  loginName: DEDICATED_LOGIN_NAME,
  nickname: DEDICATED_NICKNAME,
  organizationId: 11,
  role: 'ENGINEER',
  userInfoEmail: null,
  userState: 'ACTIVE',
};

const RECORD: RegisteredDedicatedAccount = {
  ...EXPECTATION,
  facts: { membershipId: 21, userInfoId: 31 },
  id: 41,
};

/** 创建后回读事实的 batch 输出（-N -B：制表符分隔、无表头） */
function creationFactsRows(options?: { memberships?: number }): string {
  const membershipCount = options?.memberships ?? 1;
  const rows = [
    `ACCOUNT\t41\t${DEDICATED_LOGIN_NAME}\tENGINEER\t\t\t`,
    `USER_INFO\t31\t${utf8Hex(DEDICATED_NICKNAME)}\tNULL\tACTIVE\t1\tENGINEER`,
  ];

  for (let index = 0; index < membershipCount; index += 1) {
    rows.push(`MEMBERSHIP\t${21 + index}\t11\tENGINEER\tACTIVE\t\t`);
  }

  return rows.join('\n');
}

/**
 * 模拟 mysql batch 语义：按语句顺序执行，遇到被拒断言（PREPARE 的 SQL 文本命中拒绝标记）
 * 立即中止——返回已执行语句，后续语句（含 DELETE / COMMIT）不会执行。
 */
function simulateMysqlBatch(
  sql: string,
  rejectMarker: string | null,
): { executed: string[]; rejected: boolean } {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  const preparedSql = new Map<string, string>();
  const executed: string[] = [];

  for (const statement of statements) {
    const setMatch = statement.match(/^SET @(\w+)_sql = IF\([^)]*'SELECT 1', 'SELECT ([^']+)'\)$/);

    if (setMatch) {
      preparedSql.set(setMatch[1], setMatch[2]);
    }

    const execMatch = statement.match(/^EXECUTE (\w+)_stmt$/);

    if (execMatch && rejectMarker !== null && preparedSql.get(execMatch[1]) === rejectMarker) {
      return { executed, rejected: true };
    }

    executed.push(statement);
  }

  return { executed, rejected: false };
}

/**
 * 安装 mysql mock：FK 发现返回 discovery 行，清理脚本按 batch 语义模拟。
 * rejectMarker 命中时按真实 mysql 行为抛错（stderr 带 ERROR 标记），事务随连接关闭回滚。
 */
function installDedicatedMysqlMock(options?: {
  database?: string;
  discovery?: string;
  rejectMarker?: string | null;
}): { scripts: string[]; deletedTables: () => string[] } {
  const database = options?.database ?? DEDICATED_E2E_DB_NAME;
  const rejectMarker = options?.rejectMarker ?? null;
  const scripts: string[] = [];
  const executedStatements: string[] = [];

  execFileSyncMock.mockImplementation((_file, args) => {
    const argv = args as string[];
    const flagIndex = argv.indexOf('-e');
    const sql = argv[flagIndex + 1] as string;

    if (sql.startsWith('SELECT kcu.TABLE_NAME')) {
      return options?.discovery ?? '';
    }

    scripts.push(sql);

    const simulation = simulateMysqlBatch(sql, rejectMarker);

    executedStatements.push(...simulation.executed);

    if (simulation.rejected) {
      throw Object.assign(new Error('mysql batch aborted'), {
        stderr: `ERROR 1054 (42S22): Unknown column '${rejectMarker}' in 'field list'`,
      });
    }

    return database;
  });

  return {
    deletedTables: () =>
      executedStatements
        .filter((statement) => statement.startsWith('DELETE FROM'))
        .map((statement) => statement.replace(/^DELETE FROM (\w+).*$/, '$1')),
    scripts,
  };
}

describe('专用账号资源台账与引用闭包清理（终审 I3）', () => {
  const originalOptIn = process.env[OPT_IN_ENV];
  const originalDatabase = process.env.DB_NAME;

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(envFile(DEDICATED_E2E_DB_NAME));
    delete process.env[OPT_IN_ENV];
    delete process.env.DB_NAME;
  });

  afterEach(() => {
    delete process.env[OPT_IN_ENV];
    if (originalDatabase === undefined) {
      delete process.env.DB_NAME;
    } else {
      process.env.DB_NAME = originalDatabase;
    }
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    '非安全正整数账号 ID（%p）直接抛错且绝不启动 mysql 进程',
    (invalidId) => {
      process.env[OPT_IN_ENV] = '1';

      expect(() => deleteE2EDedicatedAccount({ ...RECORD, id: invalidId })).toThrow(
        '未通过正整数校验',
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each(['e2e_pw_1758000000000', 'mock_customer_alpha', 'e2e-pw-abc', ''])(
    '登录名（%p）未通过专用账号白名单校验时直接抛错且绝不启动 mysql 进程',
    (invalidLoginName) => {
      process.env[OPT_IN_ENV] = '1';

      expect(() => deleteE2EDedicatedAccount({ ...RECORD, loginName: invalidLoginName })).toThrow(
        '未通过白名单校验',
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it('专用登录名白名单形如 e2e-pw-<纯数字时间戳>', () => {
    expect(DEDICATED_LOGIN_NAME_PATTERN.test('e2e-pw-1758000000000')).toBe(true);
    expect(DEDICATED_LOGIN_NAME_PATTERN.test('mock_customer_alpha')).toBe(false);
    expect(DEDICATED_LOGIN_NAME_PATTERN.test('e2e-pw-1758000000000; DROP TABLE x')).toBe(false);
  });

  it('缺少 opt-in 时物理清理被拒绝且 mysql 进程未被调用', () => {
    expect(() => deleteE2EDedicatedAccount(RECORD)).toThrow('缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('opt-in 但目标库不含 e2e/test 段时在连接前被拒绝', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(envFile('app'));

    expect(() => deleteE2EDedicatedAccount(RECORD)).toThrow('不属于测试库命名');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('opt-in 且库名含 e2e 但不是严格专用库时仍被拒绝，且 mysql 进程未被调用', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(envFile('app_e2e'));

    expect(() => deleteE2EDedicatedAccount(RECORD)).toThrow('≠ 严格专用库');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('未核验事实（facts 为空）的记录拒绝清理，且不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => deleteE2EDedicatedAccount({ ...RECORD, facts: null })).toThrow(
      '缺少创建后核验事实',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('正常路径：单事务内先核对绑定与闭包，再按成员→资料→账号顺序精确删除并提交', () => {
    process.env[OPT_IN_ENV] = '1';
    const mysql = installDedicatedMysqlMock({
      discovery: [
        'engineer_response\tcustomer_account_id\tbase_user_account\tid',
        'organization_membership\taccount_id\tbase_user_account\tid',
      ].join('\n'),
    });

    deleteE2EDedicatedAccount(RECORD);

    expect(mysql.scripts).toHaveLength(1);

    const sql = mysql.scripts[0];

    // 同一会话：事务 + DATABASE() 复核必须在任何 DELETE 之前
    expect(sql).toContain('START TRANSACTION');
    expect(sql).toContain('SET @dc_database = DATABASE()');
    expect(sql.indexOf('DATABASE()')).toBeLessThan(sql.indexOf('DELETE FROM'));

    // 绑定核对使用 FOR UPDATE 锁定，且先于任何 DELETE；账号锁定同时绑定登录名与身份漂移字段
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain(
      `SELECT id INTO @dc_acct_41_account_row FROM base_user_account WHERE id = 41 AND login_name = '${DEDICATED_LOGIN_NAME}' AND identity_hint = 'ENGINEER' FOR UPDATE`,
    );
    expect(sql.indexOf('FOR UPDATE')).toBeLessThan(sql.indexOf('DELETE FROM'));

    // 集合外引用检查先于任何 DELETE
    expect(sql.indexOf('dc_unregistered_external_references')).toBeLessThan(
      sql.indexOf('DELETE FROM'),
    );

    // 只删三张表，且先删成员关系（FK RESTRICT）再删资料与账号
    expect(mysql.deletedTables()).toEqual([
      'organization_membership',
      'base_user_info',
      'base_user_account',
    ]);
    expect(sql).not.toContain('DELETE FROM engineer_response');
    expect(sql).not.toContain('DELETE FROM ai_message');
    expect(sql).not.toContain('DELETE FROM repair_request');
    expect(sql).not.toContain('DELETE FROM reference_document');

    // 每条删除按已核验主键与归属执行
    expect(sql).toContain(
      'DELETE FROM organization_membership WHERE id = 21 AND account_id = 41 AND organization_id = 11',
    );
    expect(sql).toContain('DELETE FROM base_user_info WHERE id = 31 AND account_id = 41');
    expect(sql).toContain(
      `DELETE FROM base_user_account WHERE id = 41 AND login_name = '${DEDICATED_LOGIN_NAME}'`,
    );

    // 提交前核对本轮残留为零
    expect(sql).toContain('dc_residue_must_be_zero');
    expect(sql.trimEnd().endsWith('COMMIT')).toBe(true);
  });

  it.each([
    'dc_database_must_equal_strict_dedicated_e2e',
    'dc_acct_41_account_binding_mismatch',
    'dc_acct_41_user_info_count_mismatch',
    'dc_acct_41_user_info_binding_mismatch',
    'dc_acct_41_membership_count_mismatch',
    'dc_acct_41_membership_binding_mismatch',
    'dc_unregistered_external_references',
  ])('首删前断言 %s 被拒时 batch 立即中止：一条 DELETE 都不执行', (marker) => {
    process.env[OPT_IN_ENV] = '1';
    const mysql = installDedicatedMysqlMock({ rejectMarker: marker });

    expect(() => deleteE2EDedicatedAccount(RECORD)).toThrow(marker);
    expect(mysql.deletedTables()).toEqual([]);
  });

  it('残留断言在三条删除之后执行：DELETE 已发出但 COMMIT 不会执行（连接关闭回滚）', () => {
    process.env[OPT_IN_ENV] = '1';
    const mysql = installDedicatedMysqlMock({
      rejectMarker: 'dc_residue_must_be_zero',
    });

    expect(() => deleteE2EDedicatedAccount(RECORD)).toThrow('dc_residue_must_be_zero');
    // 残留核对排在三条 DELETE 之后：已执行的 DELETE 由事务回滚撤销
    expect(mysql.deletedTables()).toEqual([
      'organization_membership',
      'base_user_info',
      'base_user_account',
    ]);
    expect(mysql.scripts[0].trimEnd().endsWith('COMMIT')).toBe(true);
  });

  it('删除条数不符时在该条 DELETE 之后立即中止，后续 DELETE 不再执行', () => {
    process.env[OPT_IN_ENV] = '1';
    const deleteCountMock = installDedicatedMysqlMock({
      rejectMarker: 'dc_acct_41_membership_delete_rows_mismatch',
    });

    expect(() => deleteE2EDedicatedAccount(RECORD)).toThrow(
      'dc_acct_41_membership_delete_rows_mismatch',
    );
    // 成员关系已尝试删除，但资料与账号的 DELETE 未被继续执行
    expect(deleteCountMock.deletedTables()).toEqual(['organization_membership']);
  });

  it('创建后回读：成员关系多于预期即拒绝，并保留可诊断信息（不按登录名猜测归属）', () => {
    readFileSyncMock.mockReturnValue(envFile(DEDICATED_E2E_DB_NAME));
    execFileSyncMock.mockReturnValue(creationFactsRows({ memberships: 2 }));

    expect(() => readDedicatedAccountCreationFacts(RECORD)).toThrow(
      '组织成员关系期望恰好 1 行，实际 2 行',
    );
  });

  it('创建后回读：关键字段不符时逐项报出（组织 / 成员角色 / 账号状态 / 资料字段）', () => {
    execFileSyncMock.mockReturnValue(
      [
        `ACCOUNT\t41\t${DEDICATED_LOGIN_NAME}\tCUSTOMER\t\t\t`,
        `USER_INFO\t31\t${utf8Hex('别的昵称')}\tNULL\tPENDING\t2\tADMIN\t`,
        'MEMBERSHIP\t21\t99\tSUPER_ADMIN\tACTIVE\t\t',
      ].join('\n'),
    );

    expect(() => readDedicatedAccountCreationFacts(RECORD)).toThrow('字段不符（identity_hint）');
  });

  it('引用闭包发现：集合内表被排除，外部列按实际 schema 返回，未受支持的引用目标失败关闭', () => {
    execFileSyncMock.mockReturnValue(
      [
        'base_user_info\taccount_id\tbase_user_account\tid',
        'organization_membership\taccount_id\tbase_user_account\tid',
        'repair_request\tcustomer_account_id\tbase_user_account\tid',
      ].join('\n'),
    );

    expect(readDedicatedCleanupReferenceColumns()).toEqual([
      { column: 'customer_account_id', table: 'repair_request' },
    ]);

    execFileSyncMock.mockReturnValue('repair_request\tid\tbase_user_info\tid');

    expect(() => readDedicatedCleanupReferenceColumns()).toThrow('未受支持的引用目标');
  });

  it('管理员有效组织必须唯一，否则拒绝据此核验归属', () => {
    execFileSyncMock.mockReturnValue('11\n12');

    expect(() => readActingOrganizationId('mock_super_admin')).toThrow('有效组织不唯一');
    expect(() => readActingOrganizationId("mock'; DROP TABLE x")).toThrow('未通过格式校验');
  });

  it('清理目标描述包含本轮精确目标与实际连接库，便于接手人一眼确认', () => {
    expect(describeDedicatedAccountCleanupTarget(RECORD, DEDICATED_E2E_DB_NAME)).toContain(
      '账号 41（e2e-pw-1758000000000）',
    );
    expect(describeDedicatedAccountCleanupTarget(RECORD, DEDICATED_E2E_DB_NAME)).toContain(
      '成员 21',
    );
    expect(describeDedicatedAccountCleanupTarget(RECORD, DEDICATED_E2E_DB_NAME)).toContain(
      `目标库 ${DEDICATED_E2E_DB_NAME}`,
    );
  });

  it('残留核对分别返回主记录、userInfo 孤儿和关联业务表数量', () => {
    execFileSyncMock.mockReturnValue('0\n0\n0');

    expect(readDedicatedAccountCleanupResidue(970100)).toEqual({
      account: 0,
      relatedBusiness: 0,
      userInfo: 0,
    });
  });

  it('按登录名统计账号数仅接受安全登录名参数', () => {
    execFileSyncMock.mockReturnValue('1');

    expect(readAccountCountByLoginName('mock_customer_alpha')).toBe(1);
    expect(() => readAccountCountByLoginName("mock'; DROP TABLE x")).toThrow('未通过格式校验');
  });

  // 防回退（R3 真实改密轮 ERROR 1064）：残留统计必须是一条完整 SELECT，不得被分号截断。
  it('残留核对 SQL 防回退：不含 `+;` 截断、恰为 3 条完整 SELECT', () => {
    execFileSyncMock.mockReturnValue('0\n0\n0');

    readDedicatedAccountCleanupResidue(970100);

    const args = execFileSyncMock.mock.lastCall?.[1] as string[];
    const sql = args[args.indexOf('-e') + 1];

    expect(sql).not.toMatch(/\+\s*;/);

    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement.startsWith('SELECT')).toBe(true);
    }
    expect(statements[2]).toContain('FROM organization_membership');
    expect(statements[2]).toContain('FROM engineer_response');
  });
});

// P2-01：同一用例登记的多个账号必须整批预检、单事务删除，不允许部分提交。
describe('整批原子清理（P2-01）', () => {
  const originalOptIn = process.env[OPT_IN_ENV];

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(envFile(DEDICATED_E2E_DB_NAME));
    delete process.env[OPT_IN_ENV];
    delete process.env.DB_NAME;
  });

  afterEach(() => {
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  /** 合法批次目标：登录名命中白名单，成员/资料主键唯一 */
  function batchRecord(id: number): RegisteredDedicatedAccount {
    return {
      accessGroup: ['ENGINEER'],
      facts: { membershipId: 600 + id, userInfoId: 500 + id },
      id,
      loginName: `e2e-pw-175800000${String(id)}`,
      nickname: `E2E 批次账号 ${id}`,
      organizationId: 11,
      role: 'ENGINEER',
      userInfoEmail: null,
      userState: 'ACTIVE',
    };
  }

  it('空批次为 no-op：不要求清理授权，也不启动 mysql', () => {
    expect(() => deleteE2EDedicatedAccounts([])).not.toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['账号 ID', () => [batchRecord(101), batchRecord(101)]],
    [
      '资料主键',
      () => [
        batchRecord(101),
        { ...batchRecord(102), facts: { membershipId: 702, userInfoId: 601 } },
      ],
    ],
    [
      '成员关系主键',
      () => [
        batchRecord(101),
        { ...batchRecord(102), facts: { membershipId: 701, userInfoId: 602 } },
      ],
    ],
  ])('批次内重复%s整体拒绝，且不启动 mysql', (_label, build) => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => deleteE2EDedicatedAccounts(build())).toThrow('重复登记');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('第二个目标校验失败时整批拒绝：连引用闭包读取都不发起', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      deleteE2EDedicatedAccounts([batchRecord(101), { ...batchRecord(102), loginName: 'bad' }]),
    ).toThrow('未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('两个目标正常：单脚本、单事务、单 COMMIT，全部锁定早于首删', () => {
    process.env[OPT_IN_ENV] = '1';
    const mysql = installDedicatedMysqlMock();

    deleteE2EDedicatedAccounts([batchRecord(102), batchRecord(101)]);

    expect(mysql.scripts).toHaveLength(1);

    const sql = mysql.scripts[0];

    expect(sql.match(/START TRANSACTION/g)).toHaveLength(1);
    expect(sql.match(/\bCOMMIT\b/g)).toHaveLength(1);
    expect(sql.lastIndexOf('FOR UPDATE')).toBeLessThan(sql.indexOf('DELETE FROM'));
    expect(sql.lastIndexOf('dc_unregistered_external_references')).toBeLessThan(
      sql.indexOf('DELETE FROM'),
    );

    // 两个目标各自独立命名断言标记，互不覆盖
    expect(sql).toContain('dc_acct_101_user_info_binding_mismatch');
    expect(sql).toContain('dc_acct_102_user_info_binding_mismatch');

    // 按账号 ID 升序删除，每个目标都是成员 → 资料 → 账号
    expect(mysql.deletedTables()).toEqual([
      'organization_membership',
      'base_user_info',
      'base_user_account',
      'organization_membership',
      'base_user_info',
      'base_user_account',
    ]);
    expect(sql.indexOf('id = 101')).toBeLessThan(sql.indexOf('id = 102'));

    // 提交前残留断言在最后一条 DELETE 之后
    expect(sql.lastIndexOf('DELETE FROM base_user_account')).toBeLessThan(
      sql.indexOf('dc_residue_must_be_zero'),
    );
  });

  it('第二个目标预检被拒：第一个目标的 DELETE 也一条都不执行', () => {
    process.env[OPT_IN_ENV] = '1';
    const mysql = installDedicatedMysqlMock({
      rejectMarker: 'dc_acct_102_user_info_binding_mismatch',
    });

    expect(() => deleteE2EDedicatedAccounts([batchRecord(101), batchRecord(102)])).toThrow(
      'dc_acct_102_user_info_binding_mismatch',
    );
    expect(mysql.deletedTables()).toEqual([]);
    expect(mysql.scripts[0].trimEnd().endsWith('COMMIT')).toBe(true);
  });

  it('第二个目标后序 DELETE 失败：第一个目标已发出的 DELETE 不会提交', () => {
    process.env[OPT_IN_ENV] = '1';
    const mysql = installDedicatedMysqlMock({
      rejectMarker: 'dc_acct_102_membership_delete_rows_mismatch',
    });

    expect(() => deleteE2EDedicatedAccounts([batchRecord(101), batchRecord(102)])).toThrow(
      'dc_acct_102_membership_delete_rows_mismatch',
    );
    // 第一个目标三条 DELETE 已发出，第二个目标的成员 DELETE 也已发出，后续 DELETE 与 COMMIT 未执行
    expect(mysql.deletedTables()).toEqual([
      'organization_membership',
      'base_user_info',
      'base_user_account',
      'organization_membership',
    ]);
    expect(mysql.scripts[0].trimEnd().endsWith('COMMIT')).toBe(true);
  });

  it('连接中断时标记提交状态待确认，提示保留台账并停止自动重试', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockImplementation((_file, args) => {
      const argv = args as string[];
      const sql = argv[argv.indexOf('-e') + 1] as string;

      // 引用闭包发现正常返回；清理脚本执行期间连接中断
      if (sql.startsWith('SELECT kcu.TABLE_NAME')) {
        return '';
      }

      throw Object.assign(new Error('mysql lost'), {
        stderr: 'ERROR 2013 (HY000): Lost connection to MySQL server during query',
      });
    });

    expect(() => deleteE2EDedicatedAccounts([batchRecord(101)])).toThrow('提交状态待确认');
  });

  it('COMMIT 已生效但确认丢失（stderr 为空）：不得声称未提交或已回滚', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockImplementation((_file, args) => {
      const argv = args as string[];
      const sql = argv[argv.indexOf('-e') + 1] as string;

      if (sql.startsWith('SELECT kcu.TABLE_NAME')) {
        return '';
      }

      // 客户端在脚本执行完后丢失确认：没有 stderr，无法判断 COMMIT 是否生效
      throw new Error('client lost after executing batch');
    });

    let thrown: unknown;
    try {
      cleanupRegisteredDedicatedAccounts([batchRecord(101), batchRecord(102)]);
    } catch (error) {
      thrown = error;
    }

    const message = toErrorMessage(thrown);

    expect(message).toContain('提交状态待确认');
    expect(message).not.toContain('事务未 COMMIT');
    expect(message).not.toMatch(/个目标.*未提交/);
    expect(message).toContain('(无 stderr)');
    // 结构化字段由执行边界一路传到外层：状态、阶段、实际账号 ID 都不丢失
    expect(thrown).toBeInstanceOf(DedicatedCleanupBatchError);
    expect(thrown).toMatchObject({
      accountIds: [101, 102],
      commitState: '提交状态待确认',
      stage: '清理脚本执行（mysql batch）',
    });
    // 原始诊断与脱敏后的执行边界错误都保留在错误链上
    expect((thrown as Error).cause).toBeInstanceOf(DedicatedCleanupBatchError);
  });

  it('连接中断的待确认诊断经 runWithCleanup 聚合后仍保留，且关闭上下文仍被尝试', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockImplementation((_file, args) => {
      const argv = args as string[];
      const sql = argv[argv.indexOf('-e') + 1] as string;

      if (sql.startsWith('SELECT kcu.TABLE_NAME')) {
        return '';
      }

      throw Object.assign(new Error('mysql lost'), {
        stderr: 'ERROR 2013 (HY000): Lost connection to MySQL server during query',
      });
    });
    const closeSpy = vi.fn(() => {});

    let thrown: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw new Error('业务断言失败：改密后登录返回意外状态');
        },
        {
          label: '账号清理',
          run: () => cleanupRegisteredDedicatedAccounts([batchRecord(101), batchRecord(102)]),
        },
        { label: '关闭浏览器上下文', run: closeSpy },
      );
    } catch (error) {
      thrown = error;
    }

    const message = toErrorMessage(thrown);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(message).toContain('提交状态待确认');
    expect(message).toContain('业务断言失败：改密后登录返回意外状态');
    expect(message).toContain('ERROR 2013 (HY000): Lost connection');
    expect(message).not.toMatch(/个目标.*未提交|事务未 COMMIT/);
  });
});

describe('real-backend 专用账号清理预检（沿用 R2/R4 口径）', () => {
  const originalOptIn = process.env[OPT_IN_ENV];

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
      );
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('opt-in 但目标库不是 e2e/test 时在连接前被拒绝', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue('DB_NAME=app\n');

    expect(() => preflightDedicatedAccountCleanup()).toThrow('不属于测试库命名');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('缺少 opt-in 时预检在连接前失败', () => {
    expect(() => preflightDedicatedAccountCleanup()).toThrow('缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('SQL 实际连接库与配置库不一致时拒绝继续（创建前证据）', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('app_test');

    expect(() => preflightDedicatedAccountCleanup()).toThrow('数据库连接目标不一致');
  });
});

describe('real-backend API/SQL 同库探针（R4 修正轮）', () => {
  const originalOptIn = process.env[OPT_IN_ENV];

  const CONFIGURED_DB = 'app_e2e';

  /** HEX('陈甲')（UTF-8 字节大写十六进制），mock SQL 原值读取用 */
  const CHENJIA_HEX = Buffer.from('陈甲', 'utf8').toString('hex').toUpperCase();

  /** 按 SQL 内容分派 mysql 输出：连接库、探针账号原昵称 NULL 标志与 HEX 值 */
  function mockSqlResponses(options?: { isNull: '0' | '1'; hex: string }): void {
    const isNull = options?.isNull ?? '0';
    const hex = options?.hex ?? CHENJIA_HEX;
    execFileSyncMock.mockImplementation((_file, args) => {
      const argv = args as string[];
      const flagIndex = argv.indexOf('-e');
      const sql = argv[flagIndex + 1] as string;

      if (sql.includes('SELECT DATABASE()')) {
        return CONFIGURED_DB;
      }
      if (sql.startsWith('SELECT nickname IS NULL')) {
        return isNull;
      }
      if (sql.startsWith('SELECT HEX(nickname)')) {
        return hex;
      }

      return '';
    });
  }

  type MockResponse = { body: unknown; status?: number };

  /** 依次返回 fetch 响应：第 1 次为 login，其后为探针 myAccountSettings */
  function stubFetchSequence(responses: MockResponse[]): void {
    let callIndex = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = responses[Math.min(callIndex, responses.length - 1)];
        callIndex += 1;

        return {
          json: async () => response.body,
          status: response.status ?? 200,
        };
      }),
    );
  }

  /**
   * 「哨兵回显」mock：第 1 次 fetch 是 login，第 2 次 fetch 从已执行的 SQL 中提取
   * helper 刚写入的唯一哨兵并原样回显——精确模拟「API 后端与 SQL helper 同库」的世界。
   */
  function stubFetchEchoSentinel(): void {
    let callIndex = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callIndex += 1;

        if (callIndex === 1) {
          return {
            json: async () => ({ data: { login: { accessToken: 'token', accountId: 900202 } } }),
            status: 200,
          };
        }

        const sentinel = executedSqlList()
          .map((sql) => sql.match(/SET nickname = '(e2e-probe-[^']+)'/)?.[1])
          .find(Boolean);

        return {
          json: async () => ({
            data: { myAccountSettings: { loginName: 'mock_customer_alpha', nickname: sentinel } },
          }),
          status: 200,
        };
      }),
    );
  }

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        `DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=${CONFIGURED_DB}\n`,
      );
    delete process.env[OPT_IN_ENV];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('SQL 实际连接库与配置库不一致：在业务写入前失败，且未发生任何哨兵写入', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('app_test');

    await expect(assertApiSqlSameDatabase()).rejects.toThrow('数据库连接目标不一致');

    expect(executedSqlList()).toEqual(['SELECT DATABASE()']);
  });

  it('API 读回值与 SQL 哨兵一致（同库）：探针通过且原昵称被精确恢复', async () => {
    process.env[OPT_IN_ENV] = '1';
    mockSqlResponses();
    stubFetchEchoSentinel();

    await expect(assertApiSqlSameDatabase()).resolves.toBeUndefined();

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[0]).toContain('e2e-probe-');
    expect(updateStatements[1]).toContain(`UNHEX('${CHENJIA_HEX}')`);
  });

  it('API 读回值与 SQL 哨兵不一致：探针在业务写入前失败，且哨兵被精确恢复', async () => {
    process.env[OPT_IN_ENV] = '1';
    mockSqlResponses();
    stubFetchSequence([
      { body: { data: { login: { accessToken: 'token', accountId: 900202 } } } },
      {
        body: {
          data: { myAccountSettings: { loginName: 'mock_customer_alpha', nickname: '陈甲' } },
        },
      },
    ]);

    await expect(assertApiSqlSameDatabase()).rejects.toThrow('API/SQL 未指向同一数据库');

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[0]).toContain('e2e-probe-');
    expect(updateStatements[1]).toContain(`UNHEX('${CHENJIA_HEX}')`);
  });

  it('API 返回 GraphQL errors（HTTP 200）：探针失败且哨兵被精确恢复', async () => {
    process.env[OPT_IN_ENV] = '1';
    mockSqlResponses();
    stubFetchSequence([
      { body: { data: { login: { accessToken: 'token', accountId: 900202 } } } },
      {
        body: {
          data: null,
          errors: [{ extensions: { code: 'FORBIDDEN' }, message: 'forbidden' }],
        },
      },
    ]);

    await expect(assertApiSqlSameDatabase()).rejects.toThrow('同库探针 API 读取失败');

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[1]).toContain(`UNHEX('${CHENJIA_HEX}')`);
  });

  it('缺少 opt-in 时探针在连接前失败', async () => {
    await expect(assertApiSqlSameDatabase()).rejects.toThrow('缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  // 防回退（复核修正轮）：原昵称恢复不得把原始字符直接拼进 SQL 字符串字面量。
  it('防回退：原昵称含单引号与反斜杠时经 UNHEX 恢复，原始字符不进入 SQL 字面量', async () => {
    process.env[OPT_IN_ENV] = '1';
    const tricky = `O'Brien \\ "引号'测试`;
    const trickyHex = Buffer.from(tricky, 'utf8').toString('hex').toUpperCase();
    mockSqlResponses({ isNull: '0', hex: trickyHex });
    stubFetchEchoSentinel();

    await expect(assertApiSqlSameDatabase()).resolves.toBeUndefined();

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[1]).toBe(
      `UPDATE base_user_info SET nickname = UNHEX('${trickyHex}') WHERE account_id = (SELECT id FROM base_user_account WHERE login_name = 'mock_customer_alpha')`,
    );
    expect(updateStatements[1]).not.toContain(tricky);
    expect(updateStatements[1]).not.toContain("\\'");
  });

  it('防回退：原昵称含前后空白与内部换行时字节级精确恢复', async () => {
    process.env[OPT_IN_ENV] = '1';
    const whitespace = '  保留空白  \n内部换行\n';
    const whitespaceHex = Buffer.from(whitespace, 'utf8').toString('hex').toUpperCase();
    mockSqlResponses({ isNull: '0', hex: whitespaceHex });
    stubFetchEchoSentinel();

    await expect(assertApiSqlSameDatabase()).resolves.toBeUndefined();

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements[1]).toBe(
      `UPDATE base_user_info SET nickname = UNHEX('${whitespaceHex}') WHERE account_id = (SELECT id FROM base_user_account WHERE login_name = 'mock_customer_alpha')`,
    );
    expect(updateStatements[1]).toContain(`UNHEX('${whitespaceHex}')`);
  });

  it('防回退：原昵称为 NULL 时恢复为 SET nickname = NULL，不产生 UNHEX 改写', async () => {
    process.env[OPT_IN_ENV] = '1';
    mockSqlResponses({ isNull: '1', hex: 'NULL' });
    stubFetchEchoSentinel();

    await expect(assertApiSqlSameDatabase()).resolves.toBeUndefined();

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[1]).toContain('SET nickname = NULL');
    expect(updateStatements[1]).not.toContain('UNHEX');
    expect(updateStatements[1]).not.toContain("= ''");
  });

  it('防回退：原昵称为空串时恢复为空串字面量，NULL 标志与 HEX 输出矛盾时拒绝探针', async () => {
    process.env[OPT_IN_ENV] = '1';
    mockSqlResponses({ isNull: '0', hex: '' });
    stubFetchEchoSentinel();

    await expect(assertApiSqlSameDatabase()).resolves.toBeUndefined();

    const updateStatements = executedSqlList().filter((sql) =>
      sql.startsWith('UPDATE base_user_info'),
    );
    expect(updateStatements).toHaveLength(2);
    expect(updateStatements[1]).toContain("SET nickname = ''");
    expect(updateStatements[1]).not.toContain('UNHEX');

    mockSqlResponses({ isNull: '1', hex: 'ABCDEF' });
    await expect(assertApiSqlSameDatabase()).rejects.toThrow('同库探针账号数据异常');
    mockSqlResponses({ isNull: '0', hex: 'NULL' });
    await expect(assertApiSqlSameDatabase()).rejects.toThrow('同库探针账号数据异常');
  });
});

// 创建登记 + 逐账号清理编排 + 主流程/清理双错报告。
// 全部为纯逻辑负例（不启动 mysql、不触真实数据库），只验证编排与错误聚合语义。
describe('专用账号创建登记与逐账号清理编排（终审 I3）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(envFile(DEDICATED_E2E_DB_NAME));
  });

  afterEach(() => {
    delete process.env[OPT_IN_ENV];
  });

  /** adminCreateUser 成功响应体（数据库生成 ID） */
  function createResponseBody(id: number): unknown {
    return { data: { adminCreateUser: { id } } };
  }

  function expectationFor(id: number): DedicatedAccountExpectation {
    return {
      ...EXPECTATION,
      loginName: `e2e-pw-17580000${id}`,
    };
  }

  function verifiedAccount(id: number): RegisteredDedicatedAccount {
    return {
      ...expectationFor(id),
      facts: { membershipId: id + 1000, userInfoId: id + 2000 },
      id,
    };
  }

  function zeroResidue(): { account: number; relatedBusiness: number; userInfo: number } {
    return { account: 0, relatedBusiness: 0, userInfo: 0 };
  }

  it('创建响应丢失：不建立任何清理目标（绝不按登录名扫描后删除）', () => {
    const registry: RegisteredDedicatedAccount[] = [];

    expect(() =>
      registerCreatedDedicatedAccount(
        registry,
        { data: { adminCreateUser: null } },
        expectationFor(970100),
      ),
    ).toThrow('专用账号创建失败');
    expect(registry).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('登录名未通过白名单时拒绝登记且不启动任何数据库调用', () => {
    const registry: RegisteredDedicatedAccount[] = [];

    expect(() =>
      registerCreatedDedicatedAccount(registry, createResponseBody(970100), {
        ...expectationFor(970100),
        loginName: 'mock_customer_alpha',
      }),
    ).toThrow('未通过白名单校验');
    expect(registry).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('登记早于核验：回读核验失败时精确 ID 仍留在台账（facts 为空，清理入口会拒绝删除）', async () => {
    const registry: RegisteredDedicatedAccount[] = [];
    execFileSyncMock.mockReturnValue(
      [
        `ACCOUNT\t970100\t${expectationFor(970100).loginName}\tENGINEER\t\t\t`,
        `USER_INFO\t970200\t${utf8Hex(DEDICATED_NICKNAME)}\tNULL\tACTIVE\t1\tENGINEER`,
        'MEMBERSHIP\t970300\t11\tENGINEER\tACTIVE\t\t',
        'MEMBERSHIP\t970301\t99\tENGINEER\tACTIVE\t\t',
      ].join('\n'),
    );

    expect(() =>
      registerCreatedDedicatedAccount(registry, createResponseBody(970100), expectationFor(970100)),
    ).toThrow('组织成员关系期望恰好 1 行，实际 2 行');

    expect(registry).toEqual([{ ...expectationFor(970100), facts: null, id: 970100 }]);
  });

  it('登记成功后从回读结果写入成员关系与资料主键', () => {
    const registry: RegisteredDedicatedAccount[] = [];
    execFileSyncMock.mockReturnValue(
      [
        `ACCOUNT\t970100\t${expectationFor(970100).loginName}\tENGINEER\t\t\t`,
        `USER_INFO\t970200\t${utf8Hex(DEDICATED_NICKNAME)}\tNULL\tACTIVE\t1\tENGINEER`,
        'MEMBERSHIP\t970300\t11\tENGINEER\tACTIVE\t\t',
      ].join('\n'),
    );

    registerCreatedDedicatedAccount(registry, createResponseBody(970100), expectationFor(970100));

    expect(registry).toEqual([
      {
        ...expectationFor(970100),
        facts: { membershipId: 970300, userInfoId: 970200 },
        id: 970100,
      },
    ]);
  });

  it('登记后即使后续业务失败，台账仍保留（登记不依赖后续步骤）', async () => {
    const registry: RegisteredDedicatedAccount[] = [];
    execFileSyncMock.mockReturnValue(
      [
        `ACCOUNT\t970100\t${expectationFor(970100).loginName}\tENGINEER\t\t\t`,
        `USER_INFO\t970200\t${utf8Hex(DEDICATED_NICKNAME)}\tNULL\tACTIVE\t1\tENGINEER`,
        'MEMBERSHIP\t970300\t11\tENGINEER\tACTIVE\t\t',
      ].join('\n'),
    );

    await expect(
      runWithCleanup(
        async () => {
          registerCreatedDedicatedAccount(
            registry,
            createResponseBody(970100),
            expectationFor(970100),
          );
          throw new Error('后续 adminUsers 查询失败');
        },
        () => {
          /* 清理语义由后续用例覆盖，这里只验证登记未被后续失败回滚 */
        },
      ),
    ).rejects.toThrow('后续 adminUsers 查询失败');

    expect(registry).toHaveLength(1);
    expect(registry[0].facts).toEqual({ membershipId: 970300, userInfoId: 970200 });
  });

  it('整批删除失败：整批目标一次提交、不执行事务外残留核对，错误保留批次与原始原因', () => {
    const attempted: number[][] = [];
    const deleteAccounts = (batch: readonly RegisteredDedicatedAccount[]) => {
      attempted.push(batch.map((account) => account.id));

      throw new Error('批次删除被拒');
    };
    const residueFn = vi.fn(zeroResidue);

    let thrown: unknown;
    try {
      cleanupRegisteredDedicatedAccounts(
        [verifiedAccount(101), verifiedAccount(102)],
        deleteAccounts,
        residueFn,
      );
    } catch (error) {
      thrown = error;
    }

    // 批次入口只被调用一次：整批一起提交，不存在逐个账号的重试或部分提交
    expect(attempted).toEqual([[101, 102]]);
    // 事务已回滚，不再做事务外残留回读
    expect(residueFn).not.toHaveBeenCalled();
    expect(toErrorMessage(thrown)).toContain(
      '本批 2 个目标（101（e2e-pw-17580000101）、102（e2e-pw-17580000102）），未提交（失败阶段：批次入口（执行前校验））；台账保留，未执行任何提交',
    );
    expect(toErrorMessage(thrown)).toContain('批次删除被拒');
    expect(thrown).toBeInstanceOf(DedicatedCleanupBatchError);
    expect(thrown).toMatchObject({
      accountIds: [101, 102],
      commitState: '未提交',
      stage: '批次入口（执行前校验）',
    });
  });

  it('残留非零与残留核对失败分别记录，且不阻断后续账号的核对', () => {
    const checked: number[] = [];
    const residueFn = (id: number) => {
      checked.push(id);

      if (id === 102) {
        throw new Error('残留核对 SQL 失败');
      }
      if (id === 103) {
        return { account: 0, relatedBusiness: 0, userInfo: 1 };
      }

      return zeroResidue();
    };

    let thrown: unknown;
    try {
      cleanupRegisteredDedicatedAccounts(
        [verifiedAccount(101), verifiedAccount(102), verifiedAccount(103)],
        () => {},
        residueFn,
      );
    } catch (error) {
      thrown = error;
    }

    expect(checked).toEqual([101, 102, 103]);
    expect(toErrorMessage(thrown)).toContain('账号 102（e2e-pw-17580000102）已提交，残留核验失败');
    expect(toErrorMessage(thrown)).not.toContain('未提交');
    expect(toErrorMessage(thrown)).toContain('残留核对 SQL 失败');
    expect(toErrorMessage(thrown)).toContain('账号 103（e2e-pw-17580000103）清理后仍有残留');
  });

  it('两轮正常清理：每轮各自删除并核对零残留，互不影响', () => {
    const deleted: number[] = [];
    const checked: number[] = [];

    for (const round of [1, 2]) {
      expect(() =>
        cleanupRegisteredDedicatedAccounts(
          [verifiedAccount(100 + round)],
          (batch) => batch.forEach((account) => deleted.push(account.id)),
          (id) => {
            checked.push(id);

            return zeroResidue();
          },
        ),
      ).not.toThrow();
    }

    expect(deleted).toEqual([101, 102]);
    expect(checked).toEqual([101, 102]);
  });

  it('空台账为 no-op：不执行任何删除 / 残留核对', () => {
    const deleteFn = vi.fn();
    const residueFn = vi.fn();

    expect(() => cleanupRegisteredDedicatedAccounts([], deleteFn, residueFn)).not.toThrow();
    expect(deleteFn).not.toHaveBeenCalled();
    expect(residueFn).not.toHaveBeenCalled();
  });

  it('主流程与清理同时失败：两类错误都被报告', async () => {
    let thrown: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw new Error('主断言失败：角色字段不符');
        },
        () => {
          throw new Error('专用账号清理失败——账号 101（e2e-pw-17580000101）物理删除失败：x');
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(toErrorMessage(thrown)).toContain('主断言失败：角色字段不符');
    expect(toErrorMessage(thrown)).toContain('专用账号清理失败——账号 101');
    expect(toErrorMessage(thrown)).toContain('此外清理失败');
  });

  it('主流程成功但清理失败：清理错误被抛出（不被 finally 之后的断言吞掉）', async () => {
    await expect(
      runWithCleanup(
        async () => {},
        () => {
          throw new Error('清理失败：账号 101 残留非零');
        },
      ),
    ).rejects.toThrow('清理失败：账号 101 残留非零');
  });

  it('主流程失败但清理成功：主流程错误被保留', async () => {
    await expect(
      runWithCleanup(
        async () => {
          throw new Error('主断言失败：状态非 ACTIVE');
        },
        () => {},
      ),
    ).rejects.toThrow('主断言失败：状态非 ACTIVE');
  });
});

// 账号清理与 context.close() 共用的收尾路径——两者独立执行、错误互不覆盖。
describe('收尾步骤独立执行与错误合并（最小修复计划）', () => {
  it('账号清理与关闭上下文同时失败：两类错误都被报告，且关闭步骤确实被执行', async () => {
    const closeSpy = vi.fn(() => {
      throw new Error('关闭上下文失败：target closed');
    });

    let thrown: unknown;
    try {
      await runWithCleanup(
        async () => {},
        {
          label: '账号清理',
          run: () => {
            throw new Error('账号清理失败：账号 101 残留非零');
          },
        },
        { label: '关闭浏览器上下文', run: closeSpy },
      );
    } catch (error) {
      thrown = error;
    }

    const message = toErrorMessage(thrown);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(message).toContain('清理步骤 1（账号清理）失败');
    expect(message).toContain('账号清理失败：账号 101 残留非零');
    expect(message).toContain('清理步骤 2（关闭浏览器上下文）失败');
    expect(message).toContain('关闭上下文失败：target closed');
  });

  it('首个收尾步骤失败时仍继续尝试后续步骤（无条件 await）', async () => {
    const order: string[] = [];
    const secondStep = vi.fn(() => {
      order.push('second');
    });

    await expect(
      runWithCleanup(
        async () => {},
        () => {
          order.push('first');
          throw new Error('第一步收尾失败');
        },
        secondStep,
      ),
    ).rejects.toThrow('第一步收尾失败');

    expect(order).toEqual(['first', 'second']);
    expect(secondStep).toHaveBeenCalledTimes(1);
  });

  it('主流程与两个收尾步骤同时失败：三类错误都保留，主错误不被后续错误覆盖', async () => {
    let thrown: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw new Error('主断言失败：角色字段不符');
        },
        () => {
          throw new Error('账号清理失败：删除被拒');
        },
        () => {
          throw new Error('关闭上下文失败：already closed');
        },
      );
    } catch (error) {
      thrown = error;
    }

    const message = toErrorMessage(thrown);

    expect(message).toContain('主流程失败：主断言失败：角色字段不符');
    expect(message).toContain('此外清理失败');
    expect(message).toContain('账号清理失败：删除被拒');
    expect(message).toContain('关闭上下文失败：already closed');
  });

  it('仅关闭上下文一项失败：抛出原始关闭错误（保留原始诊断）', async () => {
    await expect(
      runWithCleanup(
        async () => {},
        () => {},
        () => {
          throw new Error('关闭上下文失败：仅此一步');
        },
      ),
    ).rejects.toThrow('关闭上下文失败：仅此一步');
  });
});

/** 从 execFileSync 入参中提取 -e 后的 SQL 字面量（取最近一次调用） */
function executedSqlList(): string[] {
  return execFileSyncMock.mock.calls.map((call) => {
    const args = call[1] as string[];
    const flagIndex = args.indexOf('-e');

    return flagIndex >= 0 ? args[flagIndex + 1] : '';
  });
}
