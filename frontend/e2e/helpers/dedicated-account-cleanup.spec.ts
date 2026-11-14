// e2e/helpers/dedicated-account-cleanup.spec.ts
// @vitest-environment node
// 专用账号物理清理 helper 的单元测试（R2 修正轮第 4 项；R4 修正轮扩展；vitest 运行，
// Playwright 经 testIgnore 排除 helpers 目录）。node 环境：helper 内部依赖 import.meta.url
// 解析 env 文件路径，须在 node 环境下运行。
//
// 关键安全断言：
// - 非安全正整数 ID、非专用白名单登录名、缺少 opt-in、库名授权不等值，都必须在任何 SQL
//   组装 / 数据库进程启动之前被拒绝；
// - 清理目标绑定 accountId + dedicatedLoginName 双因子：事务内绑定断言先于任何 DELETE，
//   绑定不匹配时 mysql 中止退出、事务自动回滚，目标账号保持存在；
// - API/SQL 同库探针：SQL 实际连接库 ≠ 配置库、API 读回 ≠ 哨兵、GraphQL errors，任何一种
//   情况都必须在业务写入（adminCreateUser）之前失败，且哨兵无论成败都精确恢复；
// - 负例全部经 mock 表达，不触真实数据库。

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertApiSqlSameDatabase,
  cleanupRegisteredDedicatedAccounts,
  DEDICATED_LOGIN_NAME_PATTERN,
  deleteE2EDedicatedAccountById,
  preflightDedicatedAccountCleanup,
  readAccountCountByLoginName,
  readDedicatedAccountCleanupResidue,
  registerCreatedDedicatedAccount,
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

/** 从 execFileSync 入参中提取 -e 后的 SQL 字面量（取最近一次调用） */
function executedSql(): string | undefined {
  const lastCallArgs = execFileSyncMock.mock.lastCall?.[1] as string[] | undefined;
  const flagIndex = lastCallArgs?.indexOf('-e') ?? -1;

  return flagIndex >= 0 ? lastCallArgs?.[flagIndex + 1] : undefined;
}

/** 提取全部已执行 SQL（按调用顺序），用于断言 UPDATE 恢复序列 */
function executedSqlList(): string[] {
  return execFileSyncMock.mock.calls.map((call) => {
    const args = call[1] as string[];
    const flagIndex = args.indexOf('-e');

    return flagIndex >= 0 ? args[flagIndex + 1] : '';
  });
}

describe('real-backend 专用账号物理清理（R2 修正轮第 4 项 / R4 修正轮）', () => {
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

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    '非安全正整数账号 ID（%p）直接抛错且绝不启动 mysql 进程',
    (invalidId) => {
      expect(() => deleteE2EDedicatedAccountById(invalidId, DEDICATED_LOGIN_NAME)).toThrow(
        '未通过正整数校验',
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each(['e2e_pw_1758000000000', 'mock_customer_alpha', 'e2e-pw-abc', ''])(
    '登录名（%p）未通过专用账号白名单校验时直接抛错且绝不启动 mysql 进程',
    (invalidLoginName) => {
      expect(() => deleteE2EDedicatedAccountById(970100, invalidLoginName)).toThrow(
        '未通过专用账号白名单校验',
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
    expect(() => deleteE2EDedicatedAccountById(970100, DEDICATED_LOGIN_NAME)).toThrow(
      '缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('opt-in 但目标库不是 e2e/test 时在连接前被拒绝', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue('DB_NAME=app\n');

    expect(() => preflightDedicatedAccountCleanup()).toThrow('不属于测试库命名');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('ID 与登录名唯一匹配：一个事务内先断言绑定，再按子表到主表精确 DELETE，COMMIT 前核对残留', () => {
    process.env[OPT_IN_ENV] = '1';

    deleteE2EDedicatedAccountById(970100, DEDICATED_LOGIN_NAME);

    const sql = executedSql() ?? '';
    expect(sql).toContain('START TRANSACTION');
    expect(sql).toContain(
      `SELECT COUNT(*) FROM base_user_account WHERE id = 970100 AND login_name = '${DEDICATED_LOGIN_NAME}'`,
    );
    // 绑定断言必须先于任何 DELETE：同 ID 异名的账号不得被按 ID 继续删除
    expect(sql.indexOf("login_name = '")).toBeLessThan(
      sql.indexOf('DELETE FROM engineer_response'),
    );
    expect(sql.indexOf('DELETE FROM engineer_response')).toBeLessThan(
      sql.indexOf('DELETE FROM base_user_account'),
    );
    // 组织成员关系对主记录是 ON DELETE RESTRICT：必须先于 base_user_account 删除
    // 且位于 base_user_info 之前，否则清理事务会被外键整体回滚（真实改密轮回归）
    expect(sql.indexOf('DELETE FROM organization_membership')).toBeLessThan(
      sql.indexOf('DELETE FROM base_user_info'),
    );
    expect(sql.indexOf('DELETE FROM organization_membership')).toBeLessThan(
      sql.indexOf('DELETE FROM base_user_account'),
    );
    expect(sql).toContain('SET ');
    expect(sql).toContain('PREPARE dedicated_cleanup_check');
    expect(sql).toContain('COMMIT');
  });

  it('同 ID 但登录名不匹配：绑定断言在 DELETE 前中止，mysql 抛错退出、事务回滚，目标账号保持存在', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockImplementation(() => {
      throw new Error(
        'ERROR 1064 dedicated_account_binding_id_and_login_name_must_match_exactly_one',
      );
    });

    expect(() => deleteE2EDedicatedAccountById(970100, DEDICATED_LOGIN_NAME)).toThrow(
      'dedicated_account_binding_id_and_login_name_must_match_exactly_one',
    );

    const sql = executedSql() ?? '';
    expect(sql).toContain('START TRANSACTION');
    expect(sql).toContain(`WHERE id = 970100 AND login_name = '${DEDICATED_LOGIN_NAME}'`);
    // 绑定断言先于任何 DELETE：一旦断言失败，DELETE 语句永远不会被执行
    expect(
      sql.indexOf('dedicated_account_binding_id_and_login_name_must_match_exactly_one'),
    ).toBeLessThan(sql.indexOf('DELETE FROM engineer_response'));
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
    expect(executedSql()).toBe(
      "SELECT COUNT(*) FROM base_user_account WHERE login_name = 'mock_customer_alpha'",
    );
  });

  // 防回退（R3 真实改密轮 ERROR 1064）：第三条业务表残留统计必须是**一条完整** SELECT，
  // 加法项之间绝不允许被分号截断；前两条单值 SELECT 仍保持独立语句。
  it('残留核对 SQL 防回退：不含 `+;` 截断、恰为 3 条完整 SELECT、第三条含全部业务表计数', () => {
    execFileSyncMock.mockReturnValue('0\n0\n0');

    readDedicatedAccountCleanupResidue(970100);

    const sql = executedSql() ?? '';

    // 加法表达式不得被分号截断（`+;` 及其任意空白变体均拒绝）
    expect(sql).not.toMatch(/\+\s*;/);

    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement.startsWith('SELECT')).toBe(true);
    }

    // 第三条是连续加法，同时覆盖全部 7 张关联表（含组织成员关系）
    const thirdStatement = statements[2];
    expect(thirdStatement).toContain('FROM organization_membership');
    expect(thirdStatement).toContain('FROM engineer_response');
    expect(thirdStatement).toContain('FROM ai_message');
    expect(thirdStatement).toContain('FROM ai_report');
    expect(thirdStatement).toContain('FROM ai_conversation');
    expect(thirdStatement).toContain('FROM repair_request');
    expect(thirdStatement).toContain('FROM reference_document');
    expect((thirdStatement.match(/\+\s*\(/g) ?? []).length).toBe(6);
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
    // 写哨兵 + 精确恢复，恰好两次，且恢复值是读到的原昵称
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
    // 写哨兵 + 精确恢复，恰好两次，且恢复值是读到的原昵称
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
  // 读取走 IS NULL 标志 + HEX 编码，恢复经 UNHEX 字节级还原——单引号、反斜杠、
  // 前后空白、内部换行与 NULL / 空串都必须保真。
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
    // 引号 / 反斜杠 / 原始多字节字符不得以字面量形式出现在恢复 SQL 中
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
    // 前后空白不得被 trim 丢失：恢复语句按字节还原完整原值
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
    // NULL 不得被改写为空串字面量
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

    // 数据一致性守卫：IS NULL=1 但 HEX 非 NULL（或反向）属于读取异常，直接失败
    mockSqlResponses({ isNull: '1', hex: 'ABCDEF' });
    await expect(assertApiSqlSameDatabase()).rejects.toThrow('同库探针账号数据异常');
    mockSqlResponses({ isNull: '0', hex: 'NULL' });
    await expect(assertApiSqlSameDatabase()).rejects.toThrow('同库探针账号数据异常');
  });
});

// 最小修复计划 P1/P2：创建响应登记 + 逐账号清理编排 + 主流程/清理双错报告。
// 全部为纯逻辑负例（不启动 mysql、不触真实数据库），只验证编排与错误聚合语义。
describe('专用账号创建登记与逐账号清理编排（最小修复计划 P1/P2）', () => {
  /** adminCreateUser 成功响应体（数据库生成 ID） */
  function createResponseBody(id: number): unknown {
    return { data: { adminCreateUser: { id } } };
  }

  function registeredAccount(id: number): { id: number; loginName: string } {
    return { id, loginName: `e2e-pw-175800000${id}` };
  }

  function zeroResidue(): { account: number; relatedBusiness: number; userInfo: number } {
    return { account: 0, relatedBusiness: 0, userInfo: 0 };
  }

  it('登记必须早于后续步骤：登记后即使后续查询抛错，精确 ID 仍在清理清单（P1）', async () => {
    const registry: Array<{ id: number; loginName: string }> = [];

    await expect(
      runWithCleanup(
        async () => {
          // 模拟：创建响应成功 → 立即登记 → 随后的列表 / 字段查询失败
          registerCreatedDedicatedAccount(
            registry,
            createResponseBody(970100),
            'e2e-pw-1758000000100',
          );
          throw new Error('后续 adminUsers 查询失败');
        },
        () => {
          /* 清理语义由后续用例覆盖，这里只验证登记未被后续失败回滚 */
        },
      ),
    ).rejects.toThrow('后续 adminUsers 查询失败');

    expect(registry).toEqual([{ id: 970100, loginName: 'e2e-pw-1758000000100' }]);
  });

  it('登记从创建响应解析精确 ID：无效响应抛错且不登记（P1）', () => {
    const registry: Array<{ id: number; loginName: string }> = [];

    expect(() =>
      registerCreatedDedicatedAccount(
        registry,
        { data: { adminCreateUser: null } },
        'e2e-pw-1758000000101',
      ),
    ).toThrow('专用账号创建失败');
    expect(registry).toEqual([]);

    // 登录名未通过专用白名单：拒绝登记，且不登记任何条目
    expect(() =>
      registerCreatedDedicatedAccount(registry, createResponseBody(970100), 'mock_customer_alpha'),
    ).toThrow('未通过白名单校验');
    expect(registry).toEqual([]);
  });

  it('首个账号删除失败不阻断后续账号，删除错误被聚合报告（P2）', () => {
    const attempted: number[] = [];
    const deleteFn = (id: number) => {
      attempted.push(id);

      if (id === 101) {
        throw new Error('账号 101 删除被拒');
      }
    };

    let thrown: unknown;
    try {
      cleanupRegisteredDedicatedAccounts(
        [registeredAccount(101), registeredAccount(102)],
        deleteFn,
        zeroResidue,
      );
    } catch (error) {
      thrown = error;
    }

    // 后续账号仍被尝试清理
    expect(attempted).toEqual([101, 102]);
    expect(toErrorMessage(thrown)).toContain('账号 101（e2e-pw-175800000101）物理删除失败');
    expect(toErrorMessage(thrown)).toContain('账号 101 删除被拒');
  });

  it('残留非零与残留核对失败分别记录，且不阻断后续账号（P2）', () => {
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
        [registeredAccount(101), registeredAccount(102), registeredAccount(103)],
        () => {},
        residueFn,
      );
    } catch (error) {
      thrown = error;
    }

    expect(checked).toEqual([101, 102, 103]);
    expect(toErrorMessage(thrown)).toContain('账号 102（e2e-pw-175800000102）残留核对失败');
    expect(toErrorMessage(thrown)).toContain('残留核对 SQL 失败');
    expect(toErrorMessage(thrown)).toContain('账号 103（e2e-pw-175800000103）清理后仍有残留');
  });

  it('正常路径：全部本轮账号被清理且逐账号残留为零，不抛错（P2）', () => {
    const deleted: number[] = [];
    const checked: number[] = [];

    expect(() =>
      cleanupRegisteredDedicatedAccounts(
        [registeredAccount(101), registeredAccount(102)],
        (id) => deleted.push(id),
        (id) => {
          checked.push(id);

          return zeroResidue();
        },
      ),
    ).not.toThrow();

    expect(deleted).toEqual([101, 102]);
    expect(checked).toEqual([101, 102]);
  });

  it('空清单为 no-op：不执行任何删除 / 残留核对（P2）', () => {
    const deleteFn = vi.fn();
    const residueFn = vi.fn();

    expect(() => cleanupRegisteredDedicatedAccounts([], deleteFn, residueFn)).not.toThrow();
    expect(deleteFn).not.toHaveBeenCalled();
    expect(residueFn).not.toHaveBeenCalled();
  });

  it('主流程与清理同时失败：两类错误都被报告（P2）', async () => {
    let thrown: unknown;
    try {
      await runWithCleanup(
        async () => {
          throw new Error('主断言失败：角色字段不符');
        },
        () => {
          throw new Error('专用账号清理失败——账号 101（e2e-pw-175800000101）物理删除失败：x');
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(toErrorMessage(thrown)).toContain('主断言失败：角色字段不符');
    expect(toErrorMessage(thrown)).toContain('专用账号清理失败——账号 101');
    expect(toErrorMessage(thrown)).toContain('此外清理失败');
  });

  it('主流程成功但清理失败：清理错误被抛出（不被 finally 之后的断言吞掉）（P2）', async () => {
    await expect(
      runWithCleanup(
        async () => {},
        () => {
          throw new Error('清理失败：账号 101 残留非零');
        },
      ),
    ).rejects.toThrow('清理失败：账号 101 残留非零');
  });

  it('主流程失败但清理成功：主流程错误被保留（P2）', async () => {
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

// 最小修复计划：账号清理与 context.close() 共用的收尾路径——两者独立执行、错误互不覆盖。
// 全部为纯逻辑负例（mock 步骤函数，不启动 mysql、不触真实数据库）。
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
