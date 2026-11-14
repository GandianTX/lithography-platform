// e2e/helpers/real-backend.spec.ts
// @vitest-environment node
// real-backend 白名单 helper 的单元测试（vitest 运行；Playwright 经 testIgnore 排除本文件）。
// node 环境：helper 内部依赖 import.meta.url 解析 env 文件路径，须在 node 环境下运行；
// 关键安全断言：非法 requestNo 必须在任何 SQL 组装/数据库进程启动之前被拒绝——
// expect 断言不是安全边界，finally 兜底清理路径同样只能走受保护 helper。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertE2EReferenceDocumentOwnershipBeforeCleanup,
  assertPhysicalCleanupAllowed,
  cleanupE2ERepairRequest,
  deleteE2EReferenceDocumentRowsByIds,
  deleteE2EReferenceDocumentStorageFiles,
  deleteRepairRequestRowsByIds,
  findRepairRequestByRequestNo,
  hasFrontendGraphQLEndpoint,
  mysqlQuery,
  planReferenceDocumentSoftDelete,
  readBackendEnv,
  type ReferenceDocumentCleanupTarget,
  type ReferenceDocumentFixtureColumn,
  type ReferenceDocumentFixtureRestoreTarget,
  type ReferenceDocumentStorageFileCleanupTarget,
  type RegisteredReferenceDocument,
  registerUploadedReferenceDocument,
  type RepairRequestCleanupResponseTarget,
  type RepairRequestCleanupTarget,
  requirePositiveReferenceDocumentId,
  requireResolvedStorageReference,
  restoreMutatedReferenceDocumentFixtureRow,
  runGuardedFixtureWrite,
} from './real-backend';

const { execFileSyncMock, existsSyncMock, readFileSyncMock, rmSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
}));

// execFileSync（mysql 进程）与 readFileSync（后端 env 文件）替换为 mock：
// 本文件不访问真实数据库、不依赖本地 env 文件；保留其余具名导出避免破坏模块默认导出面。
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock,
}));

const VALID_REQUEST_NO = 'RR20260902000000AB12CD';

// 与 helper 内部调用形态对齐：从 execFileSync 入参中提取 -e 后的 SQL 字面量（取最近一次调用）
function executedSql(): string | undefined {
  const lastCallArgs = execFileSyncMock.mock.lastCall?.[1] as string[] | undefined;
  const flagIndex = lastCallArgs?.indexOf('-e') ?? -1;

  return flagIndex >= 0 ? lastCallArgs?.[flagIndex + 1] : undefined;
}

// 同上，取全部调用：物理清理在一个 mysql 进程内跑完整事务脚本，据此可断言「单次调用」
function executedSqls(): string[] {
  return execFileSyncMock.mock.calls.map((call) => {
    const args = call[1] as string[];
    const flagIndex = args.indexOf('-e');

    return args[flagIndex + 1] as string;
  });
}

describe('real-backend 受保护 requestNo helper', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReturnValue(
      'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app\n',
    );
  });

  it('合法编号形成预期 SELECT 调用（清理路径已收口到统一安全入口，不再有按编号 DELETE）', () => {
    expect(findRepairRequestByRequestNo(VALID_REQUEST_NO, 'id')).toBe('');

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(executedSql()).toBe(
      `SELECT id FROM repair_request WHERE request_no = '${VALID_REQUEST_NO}'`,
    );
  });

  it.each([
    ['注入引号', `RR20260902000000AB12CD' OR '1'='1`],
    ['分号拼接', 'RR20260902000000AB12CD; DROP TABLE repair_request;--'],
    ['空白字符', ' RR20260902000000AB12CD'],
    ['非白名单任意内容', "page-text-undefined'"],
    ['小写前缀', 'rr20260902000000ab12cd'],
    ['长度不足', 'RR20260901AB12CD'],
  ])('非法 requestNo（%s）直接抛错且绝不启动 mysql 进程', (_label, invalidRequestNo) => {
    expect(() => findRepairRequestByRequestNo(invalidRequestNo, 'id')).toThrow('未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('real-backend 参考资料物理清理安全门（收紧为精确 ID + 预期事实事务核验）', () => {
  const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
  const originalOptIn = process.env[OPT_IN_ENV];
  const TEST_DB_ENV =
    'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n';
  const CREATED_BY_ACCOUNT_ID = 9001;
  const TITLE = 'E2E 参考资料验收行·run1（光闸维护·已改）';
  const STORAGE_REFERENCE = `${'a'.repeat(32)}.md`;

  // 本轮预期事实由测试自身掌握；不得用「从目标行反读回来的值」充当预期（否则核验自证）
  const VALID_TARGET: ReferenceDocumentCleanupTarget = {
    id: 970100,
    expected: {
      title: TITLE,
      createdByAccountId: CREATED_BY_ACCOUNT_ID,
      storageReference: null,
    },
  };
  const FILE_TARGET: ReferenceDocumentCleanupTarget = {
    id: 970101,
    expected: {
      title: TITLE,
      createdByAccountId: CREATED_BY_ACCOUNT_ID,
      storageReference: STORAGE_REFERENCE,
    },
  };

  function targetWith(
    id: number,
    expected: Partial<ReferenceDocumentCleanupTarget['expected']> = {},
  ): ReferenceDocumentCleanupTarget {
    return { id, expected: { ...VALID_TARGET.expected, ...expected } };
  }

  /** CLI 回读的核验诊断行（helper 逐项复查后才允许声称清理成功） */
  function cleanupDiagnostics(overrides: Record<string, string> = {}, expectedRows = 1): string {
    const fields: Record<string, string> = {
      database: 'lithography_e2e',
      expected_rows: String(expectedRows),
      existing_rows: String(expectedRows),
      field_mismatch_rows: '0',
      external_ref_rows: '0',
      residue_rows: '0',
      ...overrides,
    };

    return Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(TEST_DB_ENV);
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('空目标列表是 no-op，不启动 mysql 进程', () => {
    expect(() => deleteE2EReferenceDocumentRowsByIds([])).not.toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    '非法 ID（%p）直接抛错且绝不启动 mysql 进程',
    (invalidId) => {
      process.env[OPT_IN_ENV] = '1';

      expect(() => deleteE2EReferenceDocumentRowsByIds([targetWith(invalidId)])).toThrow(
        '未通过正整数校验',
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it('同一批出现重复 ID 时整批拒绝，不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET, VALID_TARGET])).toThrow(
      '物理清理目标 ID 重复',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      '标题注入引号',
      { title: "标题'; DROP TABLE reference_document;--" },
      '预期标题未通过白名单校验',
    ],
    ['标题含反斜杠（MySQL 转义符）', { title: '标题\\1' }, '预期标题未通过白名单校验'],
    ['标题超长', { title: 'x'.repeat(256) }, '预期标题未通过白名单校验'],
    ['创建人账号非正整数', { createdByAccountId: 0 }, '预期创建人账号未通过正整数校验'],
    [
      '存储引用非法形态',
      { storageReference: 'not-a-generated-reference' },
      '预期存储引用未通过白名单校验',
    ],
  ])('目标事实非法（%s）在任何 SQL 组装/数据库进程之前被拒绝', (_label, broken, message) => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => deleteE2EReferenceDocumentRowsByIds([targetWith(970100, broken)])).toThrow(
      message,
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('共享开发库（无 opt-in）物理清理被拒绝且 mysql 进程未被调用', () => {
    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).toThrow(
      '缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('opt-in 但库名非测试库命名（app）物理清理被拒绝且 mysql 进程未被调用', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(
      'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app\n',
    );

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).toThrow('不属于测试库命名');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['共享开发库 lithography_drill', 'lithography_drill', '不属于测试库命名'],
    ['非测试库 app', 'app', '不属于测试库命名'],
    ['其他测试库 lithography_platform_e2e', 'lithography_platform_e2e', '不是专用隔离库'],
  ])('opt-in 但 DB_NAME=%s 时失败关闭且 mysql 进程未被调用', (_label, dbName, message) => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(
      `DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=${dbName}\n`,
    );

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).toThrow(message);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('安全门函数独立可校验：非测试库命名抛错（不触碰数据库）', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => assertPhysicalCleanupAllowed({ DB_NAME: 'lithography_platform' })).toThrow(
      '不属于测试库命名',
    );
    expect(() => assertPhysicalCleanupAllowed({})).toThrow('不属于测试库命名');
    expect(() =>
      assertPhysicalCleanupAllowed({ DB_NAME: 'lithography_platform_e2e' }),
    ).not.toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('通过核验时：单次 mysql 调用（同一连接同一事务）只删本轮精确 ID，提交前核验残留为零', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics());

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).not.toThrow();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    const sql = executedSqls()[0] as string;

    expect(sql).toContain('START TRANSACTION');
    expect(sql.match(/\bCOMMIT\b/g)).toHaveLength(1);
    // 连接内自查实际 DATABASE()，并 FOR UPDATE 锁定目标行后才核对
    expect(sql).toContain("(DATABASE() <> 'lithography_e2e')");
    expect(sql).toContain('FOR UPDATE');
    // 守卫表以 CHECK 约束强制「核验不达标即中止批处理」
    expect(sql.toLowerCase()).toContain('check (violations = 0)');
    // 预期事实（标题 / 归属 / 存储引用）逐项绑定进核验门
    expect(sql).toContain(`title = '${TITLE}'`);
    expect(sql).toContain(`created_by_account_id = ${CREATED_BY_ACCOUNT_ID}`);
    expect(sql).toContain('storage_reference IS NULL');

    // DELETE 语句只按本轮精确 ID：不按标题/前缀/行数匹配
    expect(
      sql.split(';\n').filter((statement) => statement.includes('DELETE FROM reference_document')),
    ).toEqual(['DELETE FROM reference_document WHERE id IN (970100)']);
    expect(sql).not.toContain('LIKE');
    expect(sql).not.toContain('970101');

    // 顺序：核验门（库名/行数/字段/外部引用）→ DELETE → 残留门 → COMMIT
    const verificationIndex = sql.indexOf('INSERT INTO e2e_reference_document_cleanup_guard');
    const deleteIndex = sql.indexOf('DELETE FROM reference_document');
    const residueIndex = sql.indexOf("SELECT CONCAT('residue_rows='");
    const residueGuardIndex = sql.lastIndexOf('INSERT INTO e2e_reference_document_cleanup_guard');
    const commitIndex = sql.indexOf('COMMIT');

    expect(verificationIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(verificationIndex);
    expect(residueIndex).toBeGreaterThan(deleteIndex);
    expect(residueGuardIndex).toBeGreaterThan(residueIndex);
    expect(commitIndex).toBeGreaterThan(residueGuardIndex);
  });

  it('多目标全部通过核验时同一次调用内删除，且只包含本轮精确 ID', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics({}, 2));

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET, FILE_TARGET])).not.toThrow();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    const sql = executedSqls()[0] as string;

    expect(sql).toContain('DELETE FROM reference_document WHERE id IN (970100,970101)');
    // 可空字段用 NULL 安全比较（<=>）：非空预期引用绝不能退化为 `=`，否则实际被改成 NULL 时漏计
    expect(sql).toContain(`storage_reference <=> '${STORAGE_REFERENCE}'`);
    expect(sql).not.toContain(`storage_reference = '${STORAGE_REFERENCE}'`);
    expect(sql).not.toContain('970102');
  });

  // 反例 1（同标题异主）：helper 从不按标题认领删除目标；核验门把 title 与 created_by_account_id
  // 绑定在**同一条** AND 事实里，同标题异主的行必然让 field_mismatch_rows 命中，事务在 DELETE 前中止。
  it('同标题异主被捕获：标题与创建人账号绑定在同一条 AND 事实中，字段不符即零删除', () => {
    process.env[OPT_IN_ENV] = '1';
    // CLI 报告：目标行存在，但字段（归属/标题）与预期不符 → 违例非零
    execFileSyncMock.mockReturnValue(cleanupDiagnostics({ field_mismatch_rows: '1' }));

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).toThrow(
      'field_mismatch_rows 期望 0 实际 "1"',
    );

    const sql = executedSqls()[0] as string;
    const expectedFacts = sql.split('AND NOT (')[1] ?? '';

    expect(expectedFacts).toContain(`title = '${TITLE}'`);
    expect(expectedFacts).toContain(`created_by_account_id = ${CREATED_BY_ACCOUNT_ID}`);
    // 同一条事实内 AND 绑定：不能拆成两个独立 OR 分支（否则同标题异主会被误判通过）
    expect(expectedFacts).toMatch(/title = '[^']*' AND created_by_account_id = \d+/);
  });

  // 反例 2（归属不符）：归属事实不符同样让核验失败，绝不因「标题相同」而放行。
  it('归属不符被捕获：核验诊断 field_mismatch_rows 非零时抛错，拒绝声称清理完成', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics({ field_mismatch_rows: '1' }));

    expect(() => deleteE2EReferenceDocumentRowsByIds([FILE_TARGET])).toThrow(
      '参考资料物理清理核验失败',
    );
  });

  // 反例 3（外部引用）：出现引用 reference_document 的外键即失败关闭，绝不带子记录删除。
  it('外部引用非零时失败关闭：external_ref_rows 非零即抛错', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics({ external_ref_rows: '1' }));

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).toThrow(
      'external_ref_rows 期望 0 实际 "1"',
    );
  });

  // 反例 4（删除失败）：CLI 中止（CHECK 违例 / SQL 错误）时抛出携带诊断的错误，且不回读为成功。
  it('删除失败（CLI 中止）时抛出携带诊断的错误，拒绝声称清理完成', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('mysql exited with code 1'), {
        stdout: 'database=lithography_e2e expected_rows=1 existing_rows=1\n',
        stderr: 'ERROR 3819 (HY000) at line 5: Check constraint violated',
      });
    });

    expect(() => deleteE2EReferenceDocumentRowsByIds([VALID_TARGET])).toThrow(
      '参考资料物理清理事务中止',
    );
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('real-backend 维修申请按精确 ID 物理清理（本轮收口新增 helper）', () => {
  const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
  const originalOptIn = process.env[OPT_IN_ENV];
  const TEST_DB_ENV =
    'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n';
  const REQUEST_NO_A = 'RR20260902000000AB12CD';
  const REQUEST_NO_B = 'RR20260902000001CD34EF';
  const FAULT_DESCRIPTION = '阶段五真实后端 e2e 用例';

  // 本轮预期事实由测试自身掌握；不得用「从目标行反读回来的值」充当预期（否则核验自证）
  const VALID_TARGET: RepairRequestCleanupTarget = {
    id: 920006,
    expected: {
      requestNo: REQUEST_NO_A,
      customerAccountId: 9001,
      errorCode: 'E2E-REAL',
      equipmentModelId: 8101,
      faultDescription: FAULT_DESCRIPTION,
    },
  };
  const SECOND_TARGET: RepairRequestCleanupTarget = {
    id: 920007,
    expected: {
      requestNo: REQUEST_NO_B,
      customerAccountId: 9001,
      errorCode: 'E2E-REAL',
      equipmentModelId: 8101,
      faultDescription: FAULT_DESCRIPTION,
    },
  };

  function targetWith(
    id: number,
    expected: Partial<RepairRequestCleanupTarget['expected']> = {},
  ): RepairRequestCleanupTarget {
    return { id, expected: { ...VALID_TARGET.expected, ...expected } };
  }

  /** CLI 回读的核验诊断行（helper 逐项复查后才允许声称清理成功） */
  function cleanupDiagnostics(overrides: Record<string, string> = {}, expectedRows = 1): string {
    const fields: Record<string, string> = {
      database: 'lithography_e2e',
      expected_response_rows: '0',
      expected_rows: String(expectedRows),
      existing_rows: String(expectedRows),
      field_mismatch_rows: '0',
      child_rows: '0',
      response_residue_rows: '0',
      residue_rows: '0',
      ...overrides,
    };

    return Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }

  // helper 每次调用起一个 mysql 进程；同一进程 = 同一连接 = 同一事务
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(TEST_DB_ENV);
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('空目标列表是 no-op，不启动 mysql 进程', () => {
    expect(() => deleteRepairRequestRowsByIds([])).not.toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    '非法 ID（%p）直接抛错且绝不启动 mysql 进程',
    (invalidId) => {
      process.env[OPT_IN_ENV] = '1';

      expect(() => deleteRepairRequestRowsByIds([targetWith(invalidId)])).toThrow(
        '未通过正整数校验',
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it('同一批出现重复 ID 时整批拒绝，不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET, VALID_TARGET])).toThrow(
      '物理清理目标 ID 重复',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<RepairRequestCleanupTarget['expected']>, string]>([
    [
      '申请编号注入引号',
      { requestNo: `${REQUEST_NO_A}' OR '1'='1` },
      '预期申请编号未通过白名单校验',
    ],
    ['申请编号小写形态', { requestNo: REQUEST_NO_A.toLowerCase() }, '预期申请编号未通过白名单校验'],
    ['客户账号非正整数', { customerAccountId: 0 }, '预期客户账号未通过正整数校验'],
    [
      '故障码注入引号',
      { errorCode: "E2E'; DROP TABLE repair_request;--" },
      '预期故障码未通过白名单校验',
    ],
    ['设备型号非正整数', { equipmentModelId: -1 }, '预期设备型号未通过正整数校验'],
    ['设备型号零值', { equipmentModelId: 0 }, '预期设备型号未通过正整数校验'],
    [
      '故障描述注入引号',
      { faultDescription: "诊断'; DROP TABLE repair_request;--" },
      '预期故障描述未通过白名单校验',
    ],
    [
      '故障描述含反斜杠（MySQL 转义符）',
      { faultDescription: '诊断\\1' },
      '预期故障描述未通过白名单校验',
    ],
    ['故障描述超长', { faultDescription: 'x'.repeat(256) }, '预期故障描述未通过白名单校验'],
  ])('目标事实非法（%s）在任何 SQL 组装/数据库进程之前被拒绝', (_label, broken, message) => {
    process.env[OPT_IN_ENV] = '1';

    expect(() => deleteRepairRequestRowsByIds([targetWith(920006, broken)])).toThrow(message);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('无显式授权（缺 E2E_ALLOW_PHYSICAL_CLEANUP=1）物理清理被拒绝且 mysql 进程未被调用', () => {
    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET])).toThrow(
      '缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['共享开发库 lithography_drill', 'lithography_drill', '不属于测试库命名'],
    ['非测试库 app', 'app', '不属于测试库命名'],
    ['其他测试库 lithography_platform_e2e', 'lithography_platform_e2e', '不是专用隔离库'],
  ])('opt-in 但 DB_NAME=%s 时失败关闭且 mysql 进程未被调用', (_label, dbName, message) => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(
      `DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=${dbName}\n`,
    );

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET])).toThrow(message);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('通过核验时：单次 mysql 调用（同一连接同一事务）只删本轮精确 ID，提交前核验残留为零', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics());

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET])).not.toThrow();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    const sql = executedSqls()[0] as string;

    expect(sql).toContain('START TRANSACTION');
    expect(sql.match(/\bCOMMIT\b/g)).toHaveLength(1);
    // 连接内自查实际 DATABASE()，并 FOR UPDATE 锁定目标行后才核对
    expect(sql).toContain("(DATABASE() <> 'lithography_e2e')");
    expect(sql).toContain('FOR UPDATE');
    // 守卫表以 CHECK 约束强制「核验不达标即中止批处理」
    expect(sql.toLowerCase()).toContain('check (violations = 0)');

    // DELETE 语句只按本轮精确 ID：不按编号/前缀/行数匹配
    expect(
      sql.split(';\n').filter((statement) => statement.includes('DELETE FROM repair_request')),
    ).toEqual(['DELETE FROM repair_request WHERE id IN (920006)']);
    expect(sql).not.toContain('LIKE');
    expect(sql).not.toContain('920007');

    // 顺序：核验门（库名/行数/字段/子记录）→ DELETE → 残留门 → COMMIT
    const verificationIndex = sql.indexOf('INSERT INTO e2e_repair_request_cleanup_guard');
    const deleteIndex = sql.indexOf('DELETE FROM repair_request');
    const residueIndex = sql.indexOf("SELECT CONCAT('residue_rows='");
    const residueGuardIndex = sql.lastIndexOf('INSERT INTO e2e_repair_request_cleanup_guard');
    const commitIndex = sql.indexOf('COMMIT');

    expect(verificationIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(verificationIndex);
    expect(residueIndex).toBeGreaterThan(deleteIndex);
    expect(residueGuardIndex).toBeGreaterThan(residueIndex);
    expect(commitIndex).toBeGreaterThan(residueGuardIndex);
  });

  it('多 ID 全部通过核验时同一次调用内删除，且只包含本轮精确 ID', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics({}, 2));

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET, SECOND_TARGET])).not.toThrow();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    const sql = executedSqls()[0] as string;

    expect(sql).toContain('DELETE FROM repair_request WHERE id IN (920006,920007)');
    expect(sql).not.toContain('920008');
  });

  // 负责人最小修复计划 P3：型号 / 描述 / 编号任一与目标行不符都必须能被事务内核验捕获。
  // 逐 ID 绑定的预期事实必须真的进 SQL（而不是只挂在 Node 侧对象上），否则核验形同虚设。
  it.each([
    ['设备型号', 'equipment_model_id = 8101'],
    ['故障描述', `fault_description = '${FAULT_DESCRIPTION}'`],
    ['申请编号', `request_no = '${REQUEST_NO_A}'`],
  ])(
    '%s不匹配可在事务内被发现：该事实逐项绑定在核验门中，且核验门先于 DELETE / COMMIT',
    (_label, predicate) => {
      process.env[OPT_IN_ENV] = '1';
      execFileSyncMock.mockReturnValue(cleanupDiagnostics());

      deleteRepairRequestRowsByIds([VALID_TARGET]);

      const sql = executedSqls()[0] as string;

      // 五项预期事实全部逐项绑定在同一个 field_mismatch_rows 计数里
      expect(sql).toContain(predicate);
      expect(sql).toContain(`id = 920006 AND request_no = '${REQUEST_NO_A}'`);
      expect(sql).toContain('customer_account_id = 9001');
      expect(sql).toContain("error_code = 'E2E-REAL'");

      // 失败关闭顺序：核验门（含 field_mismatch_rows）→ DELETE → 残留门 → COMMIT
      const mismatchIndex = sql.indexOf('field_mismatch_rows=');
      const deleteIndex = sql.indexOf('DELETE FROM repair_request');
      const commitIndex = sql.indexOf('COMMIT');

      expect(mismatchIndex).toBeGreaterThan(-1);
      expect(deleteIndex).toBeGreaterThan(mismatchIndex);
      expect(commitIndex).toBeGreaterThan(deleteIndex);
    },
  );

  it.each([
    ['设备型号与创建记录不符', `920006\t${REQUEST_NO_A}\t9001\t9999\t${FAULT_DESCRIPTION}`],
    ['故障描述与创建记录不符', `920006\t${REQUEST_NO_A}\t9001\t8101\t另一条描述`],
    ['反查编号与创建记录不符', `920006\t${REQUEST_NO_B}\t9001\t8101\t${FAULT_DESCRIPTION}`],
  ])('%s：事务在 DELETE 之前由核验门中止（回滚，不提交删除）', (_label, lockedRow) => {
    process.env[OPT_IN_ENV] = '1';
    const aborted = Object.assign(new Error('Command failed: mysql'), {
      stderr:
        "ERROR 3819 (HY000) at line 5: Check constraint 'e2e_repair_request_cleanup_must_be_zero' is violated.",
      stdout: [lockedRow, cleanupDiagnostics({ field_mismatch_rows: '1' })].join('\n'),
    });

    execFileSyncMock.mockImplementation(() => {
      throw aborted;
    });

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET])).toThrow(
      '维修申请物理清理事务中止（已回滚，未执行删除）',
    );

    // 整批只在同一个 mysql 进程（同一连接同一事务）内：核验门中止即回滚，DELETE 未提交
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    const sql = executedSqls()[0] as string;

    expect(sql.indexOf('DELETE FROM repair_request')).toBeGreaterThan(
      sql.indexOf('field_mismatch_rows='),
    );
  });

  it.each([
    ['实际 DATABASE() 不是专用隔离库', { database: 'lithography_drill' }, 'database'],
    ['目标行不存在（existing_rows 与期望不符）', { existing_rows: '0' }, 'existing_rows'],
    ['目标字段与本轮预期事实不匹配', { field_mismatch_rows: '1' }, 'field_mismatch_rows'],
    ['存在阻碍删除的子记录引用', { child_rows: '1' }, 'child_rows'],
    ['删除后仍残留目标行', { residue_rows: '1' }, 'residue_rows'],
  ])('核验诊断不达标（%s）即抛错，且核验门始终在 DELETE 之前', (_label, overrides, key) => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(cleanupDiagnostics(overrides));

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET])).toThrow(key);

    const sql = executedSqls()[0] as string;

    expect(sql.indexOf('INSERT INTO e2e_repair_request_cleanup_guard')).toBeLessThan(
      sql.indexOf('DELETE FROM repair_request'),
    );
  });

  it('拿不到或读不懂核验诊断时同样失败关闭（不把未知当成功）', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('');

    expect(() => deleteRepairRequestRowsByIds([VALID_TARGET])).toThrow('维修申请物理清理核验失败');
  });

  it('多 ID 批中任一条核验失败：CLI 中止整批（单次进程、未提交即回滚）并失败关闭', () => {
    process.env[OPT_IN_ENV] = '1';
    const aborted = Object.assign(new Error('Command failed: mysql'), {
      stderr:
        "ERROR 3819 (HY000) at line 5: Check constraint 'e2e_repair_request_cleanup_must_be_zero' is violated.",
      stdout: [
        `920006\t${REQUEST_NO_A}\t9001\t8101\tE2E-REAL`,
        `920007\t${REQUEST_NO_B}\t9001\t8101\tE2E-REAL`,
        cleanupDiagnostics({ child_rows: '1' }, 2),
      ].join('\n'),
    });

    execFileSyncMock.mockImplementation(() => {
      throw aborted;
    });

    let thrown: Error | null = null;

    try {
      deleteRepairRequestRowsByIds([VALID_TARGET, SECOND_TARGET]);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain('维修申请物理清理事务中止（已回滚，未执行删除）');
    expect(thrown?.message).toContain('child_rows=1');
    // 整批在同一个 mysql 进程（同一连接同一事务）内完成，不拆成多次独立调用
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // 密码只经 MYSQL_PWD 注入：既不在进程参数列表，也不进入错误文本与异常链
    expect((execFileSyncMock.mock.calls[0]?.[1] as string[]).join(' ')).not.toContain('secret');
    expect(thrown?.message).not.toContain('secret');
    expect(String(thrown?.cause)).not.toContain('secret');
  });
});

describe('real-backend 已回复维修申请的精确清理（负责人单卡片计划 P3）', () => {
  const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
  const originalOptIn = process.env[OPT_IN_ENV];
  const TEST_DB_ENV =
    'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n';
  const REQUEST_NO = 'RR20260902000002AB12CD';
  const FAULT_DESCRIPTION = '工程师回复链路真实 e2e 用例';
  const RESPONSE_TEXT = '已更换备件，待观察';

  // 已接单申请的本轮事实：五项既有事实 + 接单工程师归属
  const ACCEPTED_EXPECTED: RepairRequestCleanupTarget['expected'] = {
    acceptedEngineerAccountId: 9201,
    customerAccountId: 9001,
    equipmentModelId: 8101,
    errorCode: 'E2E-REAL',
    faultDescription: FAULT_DESCRIPTION,
    requestNo: REQUEST_NO,
  };
  const RESPONSE_TARGET: RepairRequestCleanupResponseTarget = {
    expected: {
      customerAccountId: 9001,
      engineerAccountId: 9201,
      requestId: 920006,
      resolutionStatus: 'RESOLVED',
      responseText: RESPONSE_TEXT,
    },
    id: 930001,
  };

  function diagnostics(overrides: Record<string, string> = {}): string {
    const fields: Record<string, string> = {
      database: 'lithography_e2e',
      expected_response_rows: '0',
      expected_rows: '1',
      existing_rows: '1',
      field_mismatch_rows: '0',
      child_rows: '0',
      response_residue_rows: '0',
      residue_rows: '0',
      ...overrides,
    };

    return Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }

  function acceptedTarget(
    overrides: Partial<RepairRequestCleanupTarget> = {},
  ): RepairRequestCleanupTarget {
    return { expected: ACCEPTED_EXPECTED, id: 920006, ...overrides };
  }

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(TEST_DB_ENV);
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('缺省 expectedResponses 时脚本里没有任何回复删除语句：零子记录守卫不被放宽', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(diagnostics());

    expect(() => deleteRepairRequestRowsByIds([acceptedTarget()])).not.toThrow();

    const sql = executedSqls()[0] as string;

    // 既有守卫：该申请下「任意回复子记录数 - 0」必须为零，出现任何回复即整批中止；
    // GREATEST 兜底保证该违例项恒为非负，不会抵消其他正向违例
    expect(sql).toContain(
      'GREATEST((SELECT COUNT(*) FROM engineer_response WHERE request_id IN (920006)) - 0, 0)',
    );
    expect(sql).not.toContain('DELETE FROM engineer_response');
    // 已接单目标追加归属核对（is_accepted + 接单工程师账号）
    expect(sql).toContain('is_accepted = 1');
    expect(sql).toContain('accepted_by_engineer_account_id = 9201');
  });

  it('声明本轮回复时：先删本轮精确回复行、再删申请行，且回复行只按本轮 ID 删除', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(diagnostics({ expected_response_rows: '1' }));

    expect(() =>
      deleteRepairRequestRowsByIds([acceptedTarget({ expectedResponses: [RESPONSE_TARGET] })]),
    ).not.toThrow();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    const sql = executedSqls()[0] as string;
    const responseDeleteIndex = sql.indexOf('DELETE FROM engineer_response WHERE id IN (930001)');
    const requestDeleteIndex = sql.indexOf('DELETE FROM repair_request WHERE id IN (920006)');

    // 本项目 engineer_response 外键为 ON DELETE RESTRICT：顺序不可颠倒
    expect(responseDeleteIndex).toBeGreaterThan(-1);
    expect(requestDeleteIndex).toBeGreaterThan(responseDeleteIndex);
    // 回复行只按本轮记录的精确 ID 删除，绝不按申请批量删回复，也不删未记录的回复 ID
    expect(sql).not.toContain('DELETE FROM engineer_response WHERE request_id');
    expect(sql).not.toContain('930002');
    // 回复事实逐项绑定在核验门中（归属 / 工程师 / 客户 / 状态 / 正文）
    expect(sql).toContain(
      `id = 930001 AND request_id = 920006 AND engineer_account_id = 9201 AND customer_account_id = 9001 AND resolution_status = 'RESOLVED' AND response_text = '${RESPONSE_TEXT}'`,
    );
    // 多余回复子记录 = GREATEST(该申请下回复行数 - 本轮预期条数, 0)，必须为零且恒为非负
    expect(sql).toContain(
      'GREATEST((SELECT COUNT(*) FROM engineer_response WHERE request_id IN (920006)) - 1, 0)',
    );
    // 提交前同时核验申请残留与回复残留
    expect(sql).toContain("SELECT CONCAT('residue_rows='");
    expect(sql).toContain('response_residue_rows=');
    expect(sql.match(/\bCOMMIT\b/g)).toHaveLength(1);
  });

  it('回复核验的数量违例恒为非负：缺失项独立成项，多余项被 GREATEST 兜底，child_rows 纳入四项', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(diagnostics({ expected_response_rows: '1' }));

    expect(() =>
      deleteRepairRequestRowsByIds([acceptedTarget({ expectedResponses: [RESPONSE_TARGET] })]),
    ).not.toThrow();

    const sql = executedSqls()[0] as string;

    // 预期回复 ID 缺失独立成项（预期条数 - 实际命中条数），实际命中恒不超过预期条数，故非负
    expect(sql).toContain('(1 - (SELECT COUNT(*) FROM engineer_response WHERE id IN (930001)))');
    // 旧实现里可为负的裸减法（实际回复数 - 预期回复数）不再作为违例项出现
    expect(sql).not.toContain('WHERE request_id IN (920006)) - 1)');

    // child_rows 为该四项之和：缺失 + 多余 + 字段不符 + 其他子表引用
    const childRowsExpression = sql
      .split("' child_rows=', ")[1]
      ?.split(", ' expected_response_rows")[0];

    expect(childRowsExpression).toContain(
      '(1 - (SELECT COUNT(*) FROM engineer_response WHERE id IN (930001)))',
    );
    expect(childRowsExpression).toContain(
      'GREATEST((SELECT COUNT(*) FROM engineer_response WHERE request_id IN (920006)) - 1, 0)',
    );
    expect(childRowsExpression).toContain('AND NOT (');
    expect(childRowsExpression).toContain('FROM ai_conversation WHERE request_id IN (920006)');
    expect(childRowsExpression).toContain('FROM ai_report WHERE request_id IN (920006)');
  });

  it.each<[string, RepairRequestCleanupResponseTarget['expected'], string]>([
    [
      '回复归属申请与目标不一致',
      { ...RESPONSE_TARGET.expected, requestId: 920007 },
      '物理清理回复归属申请与清理目标不一致',
    ],
    [
      '回复工程师账号非正整数',
      { ...RESPONSE_TARGET.expected, engineerAccountId: 0 },
      '预期回复工程师账号未通过正整数校验',
    ],
    [
      '回复客户账号非正整数',
      { ...RESPONSE_TARGET.expected, customerAccountId: -1 },
      '预期回复客户账号未通过正整数校验',
    ],
    [
      '处理状态不在枚举值域内',
      { ...RESPONSE_TARGET.expected, resolutionStatus: 'DONE' as 'RESOLVED' },
      '预期处理状态不在枚举值域内',
    ],
    [
      '回复正文注入引号',
      { ...RESPONSE_TARGET.expected, responseText: "回复'; DROP TABLE engineer_response;--" },
      '预期回复正文未通过白名单校验',
    ],
    [
      '回复正文含反斜杠（MySQL 转义符）',
      { ...RESPONSE_TARGET.expected, responseText: '回复\\1' },
      '预期回复正文未通过白名单校验',
    ],
    [
      '回复正文超长',
      { ...RESPONSE_TARGET.expected, responseText: 'x'.repeat(256) },
      '预期回复正文未通过白名单校验',
    ],
  ])('回复事实非法（%s）在任何 SQL 组装之前被拒绝', (_label, broken, message) => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      deleteRepairRequestRowsByIds([
        acceptedTarget({
          expectedResponses: [{ expected: broken, id: 930001 }],
        }),
      ]),
    ).toThrow(message);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('回复 ID 非正整数时在任何 SQL 组装之前被拒绝', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      deleteRepairRequestRowsByIds([
        acceptedTarget({ expectedResponses: [{ ...RESPONSE_TARGET, id: 0 }] }),
      ]),
    ).toThrow('物理清理回复 ID 未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      '接单工程师账号非正整数',
      { expected: { ...ACCEPTED_EXPECTED, acceptedEngineerAccountId: 0 } },
      '预期接单工程师账号未通过正整数校验',
    ],
  ])('目标结构非法（%s）在任何 SQL 组装之前被拒绝', (_label, overrides, message) => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      deleteRepairRequestRowsByIds([
        acceptedTarget({
          ...(overrides as Partial<RepairRequestCleanupTarget>),
          expectedResponses: [RESPONSE_TARGET],
        }),
      ]),
    ).toThrow(message);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('同一条回复 ID 重复出现时整批拒绝，不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      deleteRepairRequestRowsByIds([
        acceptedTarget({ expectedResponses: [RESPONSE_TARGET, RESPONSE_TARGET] }),
      ]),
    ).toThrow('物理清理回复 ID 重复');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['本轮回复条数与脚本核验不符', { expected_response_rows: '0' }, 'expected_response_rows'],
    ['删除后仍残留回复行', { response_residue_rows: '1' }, 'response_residue_rows'],
    ['仍有本轮之外的回复子记录', { child_rows: '1' }, 'child_rows'],
  ])('核验诊断不达标（%s）即抛错，不把未知或残留当成功', (_label, overrides, key) => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(diagnostics(overrides));

    expect(() =>
      deleteRepairRequestRowsByIds([acceptedTarget({ expectedResponses: [RESPONSE_TARGET] })]),
    ).toThrow(key);
  });

  it('回复核验诊断缺失（CLI 无输出）时失败关闭，不声称清理成功', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('');

    expect(() =>
      deleteRepairRequestRowsByIds([acceptedTarget({ expectedResponses: [RESPONSE_TARGET] })]),
    ).toThrow('维修申请物理清理核验失败');
  });
});

describe('real-backend 统一清理入口 cleanupE2ERepairRequest（创建 / 管理 spec 共用）', () => {
  const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
  const originalOptIn = process.env[OPT_IN_ENV];
  const CLEANUP_REQUEST_NO = 'RR20260902000009EF56GH';
  const CLEANUP_ERROR_CODE = 'E2E-REAL';
  const DEDICATED_ENV = {
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_USER: 'root',
    DB_PASS: 'secret',
    DB_NAME: 'lithography_e2e',
  };
  const SHARED_ENV = { ...DEDICATED_ENV, DB_NAME: 'lithography_drill' };
  const SHARED_DB_FILE =
    'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_drill\n';
  const DEDICATED_DB_FILE =
    'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n';
  const SOFT_DELETE_OK = {
    data: { deleteMyRepairRequest: { id: 920006, requestNo: CLEANUP_REQUEST_NO } },
  };

  const fetchMock = vi.fn();

  /** 真实通道 stub：登录换取 token，软删 mutation 返回指定结果 */
  function stubGraphqlFetch(deleteResult: unknown): void {
    fetchMock.mockImplementation(async (_url: string, init: { body?: string }) => {
      const payload = JSON.parse(init.body ?? '{}') as { query?: string };
      const body = payload.query?.includes('login(input:')
        ? { data: { login: { accessToken: 'e2e-token', accountId: 9001 } } }
        : deleteResult;

      return { json: async () => body, status: 200 };
    });
  }

  const cleanupOptions = {
    requestNo: CLEANUP_REQUEST_NO,
    customerAccountId: 9001,
    errorCode: CLEANUP_ERROR_CODE,
    equipmentModelId: 8101,
    faultDescription: '阶段五真实后端 e2e 用例',
  };

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(DEDICATED_DB_FILE);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    vi.unstubAllGlobals();

    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('非法申请编号在任何数据库 / 网络访问之前被拒绝', async () => {
    await expect(
      cleanupE2ERepairRequest({
        ...cleanupOptions,
        env: DEDICATED_ENV,
        requestNo: `${CLEANUP_REQUEST_NO}' OR '1'='1`,
      }),
    ).rejects.toThrow('未通过白名单校验');

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-5', '1.5'])('按编号解析出的 ID（%s）非法时拒绝清理', async (rawId) => {
    execFileSyncMock.mockReturnValue(rawId);

    await expect(
      cleanupE2ERepairRequest({ ...cleanupOptions, env: DEDICATED_ENV }),
    ).rejects.toThrow('自建维修申请 ID 解析失败');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('自建行已不存在时是 no-op（幂等）：不发软删请求、不物理清理', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('');

    await expect(
      cleanupE2ERepairRequest({ ...cleanupOptions, env: DEDICATED_ENV }),
    ).resolves.toBeUndefined();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('共享开发库 lithography_drill：即使显式授权也只走软删，不进入物理删除', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('920006');
    readFileSyncMock.mockReturnValue(SHARED_DB_FILE);
    stubGraphqlFetch(SOFT_DELETE_OK);

    await expect(
      cleanupE2ERepairRequest({ ...cleanupOptions, env: SHARED_ENV }),
    ).resolves.toBeUndefined();

    // 只有一次 mysql 进程（按编号解析 ID 的 SELECT），没有 DELETE / 事务脚本
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(executedSqls().join('\n')).not.toContain('DELETE');
  });

  it('专用隔离库但无显式授权：同样只软删，不物理删除', async () => {
    execFileSyncMock.mockReturnValue('920006');
    stubGraphqlFetch(SOFT_DELETE_OK);

    await expect(
      cleanupE2ERepairRequest({ ...cleanupOptions, env: DEDICATED_ENV }),
    ).resolves.toBeUndefined();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(executedSqls().join('\n')).not.toContain('DELETE');
  });

  it('软删返回 GraphQL 错误时抛错，不声称清理完成、不进入物理删除', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('920006');
    stubGraphqlFetch({ errors: [{ message: 'forbidden' }] });

    await expect(
      cleanupE2ERepairRequest({ ...cleanupOptions, env: DEDICATED_ENV }),
    ).rejects.toThrow('软删失败，拒绝声称清理完成');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('专用隔离库 + 显式授权：先软删，再按精确 ID 走受保护物理清理', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock
      .mockReset()
      .mockReturnValueOnce('920006')
      .mockReturnValue(
        'database=lithography_e2e expected_response_rows=0 expected_rows=1 existing_rows=1 field_mismatch_rows=0 child_rows=0 response_residue_rows=0 residue_rows=0',
      );
    stubGraphqlFetch(SOFT_DELETE_OK);

    await expect(
      cleanupE2ERepairRequest({ ...cleanupOptions, env: DEDICATED_ENV }),
    ).resolves.toBeUndefined();

    const sqls = executedSqls();

    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toBe(
      `SELECT id FROM repair_request WHERE request_no = '${CLEANUP_REQUEST_NO}'`,
    );
    expect(sqls[1]).toContain('DELETE FROM repair_request WHERE id IN (920006)');
    expect(sqls[1]).toContain("(DATABASE() <> 'lithography_e2e')");
  });

  it('已接单并含本轮回复：条件软删不可行，跳过软删直接走受保护物理清理（先删回复再删申请）', async () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock
      .mockReset()
      .mockReturnValueOnce('920006')
      .mockReturnValue(
        'database=lithography_e2e expected_response_rows=1 expected_rows=1 existing_rows=1 field_mismatch_rows=0 child_rows=0 response_residue_rows=0 residue_rows=0',
      );

    await expect(
      cleanupE2ERepairRequest({
        ...cleanupOptions,
        acceptedEngineerAccountId: 9201,
        env: DEDICATED_ENV,
        expectedResponses: [
          {
            expected: {
              customerAccountId: 9001,
              engineerAccountId: 9201,
              requestId: 920006,
              resolutionStatus: 'RESOLVED',
              responseText: '已更换备件，待观察',
            },
            id: 930001,
          },
        ],
      }),
    ).resolves.toBeUndefined();

    // 已接单申请在业务上不可被客户软删：绝不发起登录与软删请求
    expect(fetchMock).not.toHaveBeenCalled();

    const sqls = executedSqls();

    expect(sqls).toHaveLength(2);
    expect(sqls[1]).toContain('DELETE FROM engineer_response WHERE id IN (930001)');
    expect(sqls[1]).toContain('DELETE FROM repair_request WHERE id IN (920006)');
    expect(sqls[1].indexOf('DELETE FROM engineer_response')).toBeLessThan(
      sqls[1].indexOf('DELETE FROM repair_request'),
    );
  });

  it('已接单并含本轮回复但未显式授权：拒绝清理（既不软删也不物理删除，不静默留下自建数据）', async () => {
    execFileSyncMock.mockReturnValue('920006');

    await expect(
      cleanupE2ERepairRequest({
        ...cleanupOptions,
        acceptedEngineerAccountId: 9201,
        env: DEDICATED_ENV,
        expectedResponses: [
          {
            expected: {
              customerAccountId: 9001,
              engineerAccountId: 9201,
              requestId: 920006,
              resolutionStatus: 'RESOLVED',
              responseText: '已更换备件，待观察',
            },
            id: 930001,
          },
        ],
      }),
    ).rejects.toThrow('物理清理未启用');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(executedSqls().join('\n')).not.toContain('DELETE');
  });
});

describe('真实 E2E 清理路径统一收口（不再有仅凭编号的直接删除入口）', () => {
  const CLEANUP_CALL_SITES = [
    'repair-request-create-real.spec.ts',
    'repair-request-manage-real.spec.ts',
    'engineer-repair-request-real.spec.ts',
  ] as const;

  // 本文件 mock 了 node:fs，读仓库源码必须取真实实现
  async function readSource(relativePath: string): Promise<string> {
    const { readFileSync: readRealFileSync } =
      await vi.importActual<typeof import('node:fs')>('node:fs');

    return readRealFileSync(new URL(relativePath, import.meta.url), 'utf-8');
  }

  it.each(CLEANUP_CALL_SITES)('%s 只经统一安全入口清理，不再有按编号删除', async (specFile) => {
    const source = await readSource(`../${specFile}`);

    expect(source).toContain('cleanupE2ERepairRequest');
    expect(source).not.toContain('deleteRepairRequestByRequestNo');
    expect(source).not.toMatch(/DELETE\s+FROM\s+repair_request/i);
  });

  it('helper 自身不再导出按编号删除入口，维修申请 DELETE 只在受保护事务脚本内按 ID 精确执行', async () => {
    const source = await readSource('./real-backend.ts');

    expect(source).not.toMatch(/export\s+(async\s+)?function\s+deleteRepairRequestByRequestNo/);
    expect(source).toMatch(/DELETE FROM repair_request WHERE \$\{idPredicate\}/);
  });

  // 负责人最小修复计划 P2/P3：清理目标必须是「创建时的本轮事实」，不能退回反查自证。
  it.each(CLEANUP_CALL_SITES)('%s 向统一入口传入型号与描述两项本轮事实', async (specFile) => {
    const source = await readSource(`../${specFile}`);

    expect(source).toContain('equipmentModelId: createdEquipmentModelId');
    expect(source).toMatch(/faultDescription: \w+_FAULT_DESCRIPTION/);
  });

  it('分页夹具的物理清理预期编号取创建响应记录值，不把反查所得编号当预期值', async () => {
    const source = await readSource('../admin-document-database-real.spec.ts');

    // 创建成功即把 id 与 requestNo 一并记入目标记录，清理时预期值来自该记录
    expect(source).toContain('createdRecord?.requestNo');
    expect(source).toContain('requestNo: row.requestNo');
    // 不再有「反查编号充当预期值」的写法（核验退化为自证的旧路径）
    expect(source).not.toContain('verifiedRequestNos');
    expect(source).toMatch(/faultDescription: row\.faultDescription/);
  });

  // 评审 P2：归属预检必须在软删 Mutation 之前调用（不能先软删、再等物理删除时报错），
  // 且物理删除复用同一份已预检目标，不再另行构造。
  it('参考资料真实用例在软删除之前先做只读归属预检，物理清理复用同一份目标', async () => {
    const source = await readSource('../reference-document-real.spec.ts');
    const precheckIndex = source.indexOf(
      'assertE2EReferenceDocumentOwnershipBeforeCleanup(targets)',
    );
    const softDeleteIndex = source.indexOf('realGraphqlCall(env, SOFT_DELETE_MUTATION');

    expect(precheckIndex).toBeGreaterThan(-1);
    expect(softDeleteIndex).toBeGreaterThan(-1);
    expect(precheckIndex).toBeLessThan(softDeleteIndex);
    expect(source).toContain('deleteE2EReferenceDocumentRowsByIds(targets)');
  });
});

describe('real-backend 前端真实通道探测（负责人 0909 必须修复 3）', () => {
  function mockFiles(options: { localEnv: string | null; viteConfig: string | null }): void {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path.includes('.env.development.local')) {
        if (options.localEnv === null) {
          throw new Error(`ENOENT: ${path}`);
        }

        return options.localEnv;
      }

      if (path.includes('vite.config')) {
        if (options.viteConfig === null) {
          throw new Error(`ENOENT: ${path}`);
        }

        return options.viteConfig;
      }

      return 'DB_NAME=app\n';
    });
  }

  it('本地 env 缺失但 vite proxy 存在 /graphql → true（不短路）', () => {
    mockFiles({
      localEnv: null,
      viteConfig: "proxy: { '/graphql': { target: 'http://127.0.0.1:3000' } }",
    });

    expect(hasFrontendGraphQLEndpoint()).toBe(true);
  });

  it('本地 env 有 VITE_GRAPHQL_ENDPOINT 但 vite proxy 缺失 → true', () => {
    mockFiles({
      localEnv: 'VITE_GRAPHQL_ENDPOINT=http://127.0.0.1:3000/graphql\n',
      viteConfig: 'export default {}',
    });

    expect(hasFrontendGraphQLEndpoint()).toBe(true);
  });

  it('两者都不存在 → false', () => {
    mockFiles({ localEnv: 'OTHER_KEY=1\n', viteConfig: 'export default {}' });

    expect(hasFrontendGraphQLEndpoint()).toBe(false);
  });

  it('本地 env 读取抛错不能掩盖 vite proxy 通道；vite 读取抛错不能掩盖直连通道', () => {
    mockFiles({ localEnv: null, viteConfig: null });

    expect(hasFrontendGraphQLEndpoint()).toBe(false);

    mockFiles({
      localEnv: 'VITE_GRAPHQL_ENDPOINT=http://127.0.0.1:3000/graphql\n',
      viteConfig: null,
    });

    expect(hasFrontendGraphQLEndpoint()).toBe(true);
  });
});

describe('real-backend 存储物理文件清理（入口自证失败关闭 + 先核验目标行与引用唯一性，再删记录引用）', () => {
  const VALID_REFERENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.pdf';
  const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
  const originalOptIn = process.env[OPT_IN_ENV];

  /** 专用隔离库配置文件：入口授权门通过后，配置库名门必须命中该库 */
  function dedicatedDbEnv(): string {
    return 'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n';
  }

  function storageFileTarget(
    overrides: Partial<ReferenceDocumentStorageFileCleanupTarget['expected']> = {},
    id = 970100,
  ): ReferenceDocumentStorageFileCleanupTarget {
    return {
      id,
      expected: {
        title: 'E2E 参考资料验收行·run1（文件上传）',
        createdByAccountId: 42,
        storageReference: VALID_REFERENCE,
        originalFilename: 'optics-check-run1.md',
        mimeType: 'text/markdown',
        ...overrides,
      },
    };
  }

  function verificationDiagnostics(overrides: Record<string, string> = {}): string {
    return Object.entries({
      database: 'lithography_e2e',
      expected_files: '1',
      existing_rows: '1',
      field_mismatch_rows: '0',
      shared_reference_rows: '0',
      ...overrides,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    existsSyncMock.mockReset().mockReturnValue(false);
    rmSyncMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue(dedicatedDbEnv());
    delete process.env[OPT_IN_ENV];
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  it('空目标列表是 no-op，不启动 mysql 进程', () => {
    expect(() => deleteE2EReferenceDocumentStorageFiles([])).not.toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN])('非安全正整数 ID（%p）直接抛错且不访问数据库', (invalidId) => {
    expect(() =>
      deleteE2EReferenceDocumentStorageFiles([storageFileTarget({}, invalidId)]),
    ).toThrow('未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['路径穿越', '../../../etc/passwd'],
    ['非白名单格式', 'short-name.pdf'],
    ['目录拼接引用', `${VALID_REFERENCE}/../../evil.pdf`],
  ])('白名单外引用（%s）在访问数据库前拒绝删除', (_label, reference) => {
    expect(() =>
      deleteE2EReferenceDocumentStorageFiles([storageFileTarget({ storageReference: reference })]),
    ).toThrow('预期引用未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  // 评审 P1：入口自证失败关闭——授权门 / 配置库名门 / 实际 DATABASE() 门任一不通过，
  // 都不得启动 mysql 进程、更不得删除文件。
  it('缺显式授权（未设 E2E_ALLOW_PHYSICAL_CLEANUP=1）：入口自行拒绝，不启动 mysql、不删文件', () => {
    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('配置库名非专用隔离库（app）：入口自行拒绝，不启动 mysql、不删文件', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(
      'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app\n',
    );

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '物理清理被拒绝',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('配置库名是测试库但非专用隔离库（app_e2e）：严格库名门拒绝，不启动 mysql、不删文件', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(
      'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
    );

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '不是专用隔离库',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('实际 DATABASE() 与专用隔离库不符：只查进程 env 的 DB_NAME 不够，核验失败并保留文件', () => {
    process.env[OPT_IN_ENV] = '1';
    // 配置指向专用库，但同一核验连接回读的实际库不是专用库
    execFileSyncMock.mockReturnValue(verificationDiagnostics({ database: 'lithography_drill' }));

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '存储文件删除前核验失败',
    );
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('核验通过：按记录引用删除存储目录内解析后的精确路径（不反查当前行引用）', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(verificationDiagnostics());
    // 删除前存在、删除后复核不存在：删除后零残留复核通过
    existsSyncMock.mockReturnValueOnce(true).mockReturnValue(false);

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).not.toThrow();

    // 删除前只读核验：核对行字段（含文件元数据）与引用唯一性；三个可空字段一律 NULL 安全比较
    expect(executedSql()).toContain(`storage_reference <=> '${VALID_REFERENCE}'`);
    expect(executedSql()).toContain(`original_filename <=> 'optics-check-run1.md'`);
    expect(executedSql()).toContain(`mime_type <=> 'text/markdown'`);
    expect(executedSql()).not.toContain(`original_filename = '`);
    expect(executedSql()).not.toContain(`mime_type = '`);
    expect(executedSql()).toContain('shared_reference_rows');
    // 核验先于删除：核验是单条只读 SELECT，绝不携带 DELETE / UPDATE；文件删除在其之后
    expect(executedSql()).toMatch(/^SELECT /);
    expect(executedSql()).not.toMatch(/\b(DELETE|UPDATE)\b/i);
    expect(rmSyncMock).toHaveBeenCalledTimes(1);

    const removedPath = rmSyncMock.mock.calls[0]?.[0] as string;

    // 路径由 path.resolve 构造：Windows 产出 `\` 分隔符，断言需同时接受两种分隔符（跨平台）
    expect(removedPath).toMatch(/var[\\/]reference-documents/);
    expect(removedPath.endsWith(VALID_REFERENCE)).toBe(true);
    expect(removedPath).not.toContain('..');
  });

  it('删除后文件仍存在（残留）：抛错拒绝声称清理完成', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(verificationDiagnostics());
    // 删除前存在、删除后复核仍存在：残留必须暴露为失败，不得以警告吞掉
    existsSyncMock.mockReturnValue(true);

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '存储物理文件清理后仍存在残留',
    );
    expect(rmSyncMock).toHaveBeenCalledTimes(1);
  });

  it('存储引用被改写（行字段与记录不符）：保留文件、不执行删除，用例失败', () => {
    process.env[OPT_IN_ENV] = '1';
    // 行被改写：核验计数 field_mismatch_rows=1，记录引用已不再指向该行当前值
    execFileSyncMock.mockReturnValue(verificationDiagnostics({ field_mismatch_rows: '1' }));

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '存储文件删除前核验失败',
    );
    // 核验失败即保留文件：绝不删除他人文件（也不删被改写引用指向的文件）
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('记录引用被其他行占用（shared_reference_rows>0）：保留文件、不执行删除', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(verificationDiagnostics({ shared_reference_rows: '1' }));

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '存储文件删除前核验失败',
    );
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('目标行缺失（existing_rows 不符）：保留文件、不执行删除', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue(
      verificationDiagnostics({ existing_rows: '0', field_mismatch_rows: '0' }),
    );

    expect(() => deleteE2EReferenceDocumentStorageFiles([storageFileTarget()])).toThrow(
      '存储文件删除前核验失败',
    );
    expect(rmSyncMock).not.toHaveBeenCalled();
  });
});

describe('real-backend 参考资料软删前归属预检（只读，失败即停止清理流程）', () => {
  const TITLE = 'E2E 参考资料验收行·run1（光闸维护·已改）';

  function cleanupTarget(
    overrides: Partial<ReferenceDocumentCleanupTarget['expected']> = {},
    id = 970100,
  ): ReferenceDocumentCleanupTarget {
    return {
      id,
      expected: { title: TITLE, createdByAccountId: 42, storageReference: null, ...overrides },
    };
  }

  function ownershipDiagnostics(overrides: Record<string, string> = {}): string {
    return Object.entries({
      database: 'lithography_e2e',
      expected_rows: '1',
      existing_rows: '1',
      field_mismatch_rows: '0',
      ...overrides,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    existsSyncMock.mockReset();
    rmSyncMock.mockReset();
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n',
      );
  });

  it('空目标列表是 no-op，不启动 mysql 进程', () => {
    expect(() => assertE2EReferenceDocumentOwnershipBeforeCleanup([])).not.toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('预检通过：只执行一次只读 SELECT，绝不 UPDATE / DELETE，也不删文件', () => {
    execFileSyncMock.mockReturnValue(ownershipDiagnostics());

    expect(() => assertE2EReferenceDocumentOwnershipBeforeCleanup([cleanupTarget()])).not.toThrow();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(executedSql()).toMatch(/^SELECT /);
    expect(executedSql()).not.toMatch(/\b(DELETE|UPDATE)\b/i);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('目标行被改写（字段不符）：抛错停止清理，且未执行任何 DELETE / 文件删除', () => {
    execFileSyncMock.mockReturnValue(ownershipDiagnostics({ field_mismatch_rows: '1' }));

    expect(() => assertE2EReferenceDocumentOwnershipBeforeCleanup([cleanupTarget()])).toThrow(
      '参考资料归属预检失败',
    );
    expect(executedSql()).not.toMatch(/\b(DELETE|UPDATE)\b/i);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('目标行缺失（existing_rows 不符）：抛错停止清理，且未执行任何 DELETE / 文件删除', () => {
    execFileSyncMock.mockReturnValue(ownershipDiagnostics({ existing_rows: '0' }));

    expect(() => assertE2EReferenceDocumentOwnershipBeforeCleanup([cleanupTarget()])).toThrow(
      '参考资料归属预检失败',
    );
    expect(executedSql()).not.toMatch(/\b(DELETE|UPDATE)\b/i);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('可空存储引用用 NULL 安全比较：非空预期生成 <=>，实际被改成 NULL 时会计入不符', () => {
    execFileSyncMock.mockReturnValue(ownershipDiagnostics());
    const reference = `${'a'.repeat(32)}.md`;

    expect(() =>
      assertE2EReferenceDocumentOwnershipBeforeCleanup([
        cleanupTarget({ storageReference: reference }),
      ]),
    ).not.toThrow();

    expect(executedSql()).toContain(`storage_reference <=> '${reference}'`);
    expect(executedSql()).not.toContain(`storage_reference = '${reference}'`);
    // 预检仍是只读 SELECT：绝不携带 DELETE / UPDATE
    expect(executedSql()).toMatch(/^SELECT /);
    expect(executedSql()).not.toMatch(/\b(DELETE|UPDATE)\b/i);
  });
});

describe('real-backend 上传存储引用登记（登记先于解析，未知引用不降级为无引用）', () => {
  const VALID_REFERENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.md';

  function facts(id = 970100): Omit<RegisteredReferenceDocument, 'storageReference'> {
    return {
      id,
      title: 'E2E 参考资料验收行·run1（文件上传）',
      createdByAccountId: 42,
      originalFilename: 'optics-check-run1.md',
      mimeType: 'text/markdown',
    };
  }

  it('查询抛错：精确 ID 已登记且引用状态为 pending（未知），绝不误记为无引用', () => {
    const registry: RegisteredReferenceDocument[] = [];

    const record = registerUploadedReferenceDocument(registry, facts(), () => {
      throw new Error('存储引用查询失败');
    });

    expect(registry).toHaveLength(1);
    expect(registry[0]).toBe(record);
    expect(record.id).toBe(970100);
    expect(record.storageReference).toEqual({ status: 'pending' });
  });

  it('返回非法引用：同样保持 pending（未知），登记不回退', () => {
    const registry: RegisteredReferenceDocument[] = [];

    const record = registerUploadedReferenceDocument(registry, facts(), () => 'short-name.md');

    expect(registry).toHaveLength(1);
    expect(record.storageReference).toEqual({ status: 'pending' });
  });

  it('返回 null：登记为 none（确认无引用），区别于 pending', () => {
    const registry: RegisteredReferenceDocument[] = [];

    const record = registerUploadedReferenceDocument(registry, facts(), () => null);

    expect(record.storageReference).toEqual({ status: 'none' });
  });

  it('返回合法引用：登记为 resolved 并保留引用值', () => {
    const registry: RegisteredReferenceDocument[] = [];

    const record = registerUploadedReferenceDocument(registry, facts(), () => VALID_REFERENCE);

    expect(record.storageReference).toEqual({ status: 'resolved', reference: VALID_REFERENCE });
  });

  it('pending 引用被清理侧拒绝并报告精确 ID（不当作无引用跳过）', () => {
    expect(() => requireResolvedStorageReference({ status: 'pending' }, 970100)).toThrow('970100');
    expect(() => requireResolvedStorageReference({ status: 'pending' }, 970100)).toThrow(
      '无法证明归属',
    );
  });

  it('none → null（确实无引用），resolved → 引用值', () => {
    expect(requireResolvedStorageReference({ status: 'none' }, 970100)).toBeNull();
    expect(
      requireResolvedStorageReference({ status: 'resolved', reference: VALID_REFERENCE }, 970100),
    ).toBe(VALID_REFERENCE);
  });
});

describe('real-backend 参考资料软删计划（反查仅报告遗漏，不并入删除目标）', () => {
  it('同标题异主的反查 ID 不进入软删目标，只作为遗漏行报告', () => {
    const { softDeleteIds, unexpectedIds } = planReferenceDocumentSoftDelete(
      [970100],
      [970100, 970999],
    );

    // 软删只处理本轮记录的精确 ID；反查所得他人行保持原样
    expect(softDeleteIds).toEqual([970100]);
    expect(unexpectedIds).toEqual([970999]);
  });

  it('反查为空时只软删本轮记录 ID，无遗漏行', () => {
    const { softDeleteIds, unexpectedIds } = planReferenceDocumentSoftDelete([970100, 970101], []);

    expect(softDeleteIds).toEqual([970100, 970101]);
    expect(unexpectedIds).toEqual([]);
  });
});

describe('real-backend 创建响应 ID 解析（缺失即失败并提示残留）', () => {
  it.each([undefined, null, 0, -1, 1.5, Number.NaN, '970100'])(
    '缺失 / 非法 ID（%p）抛错并提示可能残留，不按标题猜测归属',
    (invalidId) => {
      expect(() => requirePositiveReferenceDocumentId(invalidId, '创建响应')).toThrow(
        '未返回精确资料 ID',
      );
      expect(() => requirePositiveReferenceDocumentId(invalidId, '创建响应')).toThrow('核对残留');
    },
  );

  it('正整数 ID 原样返回（创建已落库但后续断言 / 跳转失败仍以此建立清理边界）', () => {
    expect(requirePositiveReferenceDocumentId(970100, '创建响应')).toBe(970100);
  });
});

describe('real-backend 数据库连接键运行时覆盖（R3：不改 .env 切换独立测试库）', () => {
  const DB_ENV_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME'] as const;
  const FILE_ENV =
    'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app\nOTHER_KEY=file-value\n';
  const originalValues: Partial<Record<(typeof DB_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(FILE_ENV);
    for (const key of DB_ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of DB_ENV_KEYS) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
  });

  it('无运行时覆盖时保持文件值', () => {
    expect(readBackendEnv()).toMatchObject({
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASS: 'secret',
      DB_NAME: 'app',
      OTHER_KEY: 'file-value',
    });
  });

  it('DB_NAME=lithography_e2e 运行时覆盖生效', () => {
    process.env.DB_NAME = 'lithography_e2e';

    expect(readBackendEnv().DB_NAME).toBe('lithography_e2e');
  });

  it.each([[''], ['   '], ['\t']])('空白 DB_NAME 覆盖值（%p）不覆盖文件值', (blank) => {
    process.env.DB_NAME = blank;

    expect(readBackendEnv().DB_NAME).toBe('app');
  });

  it('mysqlQuery 与安全门使用同一个覆盖后的 DB_NAME（覆盖前拒绝、覆盖后放行且 SQL 连同一库）', () => {
    const optInKey = 'E2E_ALLOW_PHYSICAL_CLEANUP';
    const originalOptIn = process.env[optInKey];

    process.env[optInKey] = '1';
    try {
      // 未覆盖时：文件库名 app 不是测试库命名，安全门拒绝
      expect(() => assertPhysicalCleanupAllowed(readBackendEnv())).toThrow('不属于测试库命名');

      process.env.DB_NAME = 'lithography_e2e';

      // 覆盖后：安全门放行，且 mysqlQuery 实际连接的库名与安全门读到的是同一个值
      expect(() => assertPhysicalCleanupAllowed(readBackendEnv())).not.toThrow();
      mysqlQuery('SELECT 1');

      const args = execFileSyncMock.mock.lastCall?.[1] as string[];

      expect(args).toContain('lithography_e2e');
      expect(readBackendEnv().DB_NAME).toBe('lithography_e2e');
    } finally {
      if (originalOptIn === undefined) {
        delete process.env[optInKey];
      } else {
        process.env[optInKey] = originalOptIn;
      }
    }
  });

  it('非 DB 连接键不接受运行时覆盖（其他环境变量读取行为不变）', () => {
    process.env.OTHER_KEY = 'runtime-should-be-ignored';

    expect(readBackendEnv().OTHER_KEY).toBe('file-value');
  });
});

describe('real-backend 真实 E2E 夹具写入与「先核验后恢复」安全入口', () => {
  const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
  const originalOptIn = process.env[OPT_IN_ENV];
  const CREATED_BY_ACCOUNT_ID = 9001;
  const TITLE = 'E2E 参考资料SQL回归·run1·ref-null';

  function dedicatedDbEnv(): string {
    return 'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=lithography_e2e\n';
  }

  /** ref-null 案夹具：引用与后端被故意改成 NULL、并补了正文以满足表 CHECK */
  function restoreTarget(
    overrides: Partial<ReferenceDocumentFixtureRestoreTarget> = {},
  ): ReferenceDocumentFixtureRestoreTarget {
    return {
      id: 980001,
      title: TITLE,
      createdByAccountId: CREATED_BY_ACCOUNT_ID,
      mutations: [
        {
          column: 'storage_reference',
          manufacturedValue: null,
          originalValue: `${'a'.repeat(32)}.md`,
        },
        { column: 'storage_backend', manufacturedValue: null, originalValue: 'local' },
        { column: 'content_text', manufacturedValue: 'mutated', originalValue: null },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock.mockReset().mockReturnValue(dedicatedDbEnv());
    delete process.env[OPT_IN_ENV];
    // 其他 describe 可能残留 DB_NAME 运行时覆盖，这里显式清掉，保证夹具入口读到文件库名
    delete process.env.DB_NAME;
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }
  });

  // ---- runGuardedFixtureWrite：授权门 + 严格库名门 + 实际 DATABASE() 复查 ----

  it('缺显式授权：夹具写入在任何 mysql 进程之前被拒绝', () => {
    expect(() =>
      runGuardedFixtureWrite(
        readBackendEnv(),
        'UPDATE reference_document SET content_text = NULL WHERE id = 980001',
      ),
    ).toThrow('缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('配置库名非专用隔离库（app_e2e）：夹具写入被严格库名门拒绝，不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';
    readFileSyncMock.mockReturnValue(
      'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
    );

    expect(() => runGuardedFixtureWrite(readBackendEnv(), 'SELECT 1')).toThrow('不是专用隔离库');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('执行连接实际 DATABASE() 非专用隔离库：只查配置库名不够，拒绝执行写入', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValue('lithography_drill');

    const writeSql = 'UPDATE reference_document SET content_text = NULL WHERE id = 980001';

    expect(() => runGuardedFixtureWrite(readBackendEnv(), writeSql)).toThrow(
      /实际 DATABASE\(\)="lithography_drill"/,
    );
    // 只发起 DATABASE() 探测，未执行写入 SQL
    expect(executedSqls()).toEqual(['SELECT DATABASE()']);
  });

  it('实际 DATABASE() 命中专用隔离库：先探测库名，再执行写入（同一入口）', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValueOnce('lithography_e2e').mockReturnValueOnce('1');

    const writeSql = 'UPDATE reference_document SET content_text = NULL WHERE id = 980001';

    expect(runGuardedFixtureWrite(readBackendEnv(), writeSql)).toBe('1');
    expect(executedSqls()).toEqual(['SELECT DATABASE()', writeSql]);
  });

  // ---- restoreMutatedReferenceDocumentFixtureRow：组装前校验 ----

  it.each([0, -1, 1.5, Number.NaN])(
    '夹具恢复目标 ID 非正整数（%p）直接拒绝且不启动 mysql 进程',
    (invalidId) => {
      process.env[OPT_IN_ENV] = '1';

      expect(() =>
        restoreMutatedReferenceDocumentFixtureRow(
          readBackendEnv(),
          restoreTarget({ id: invalidId }),
        ),
      ).toThrow('夹具恢复目标非法');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it('夹具恢复未登记任何制造状态列时拒绝执行且不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      restoreMutatedReferenceDocumentFixtureRow(readBackendEnv(), restoreTarget({ mutations: [] })),
    ).toThrow('夹具恢复目标非法');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('夹具恢复列名不在白名单时拒绝拼接且不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';
    const target = restoreTarget({
      mutations: [
        {
          column: 'title' as unknown as ReferenceDocumentFixtureColumn,
          manufacturedValue: 'x',
          originalValue: 'y',
        },
      ],
    });

    expect(() => restoreMutatedReferenceDocumentFixtureRow(readBackendEnv(), target)).toThrow(
      '列名未通过白名单校验',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('夹具恢复预期标题未通过白名单时拒绝访问数据库且不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      restoreMutatedReferenceDocumentFixtureRow(
        readBackendEnv(),
        restoreTarget({ title: "E2E 参考资料SQL回归·run1·bad'quote" }),
      ),
    ).toThrow('标题未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('夹具恢复预期创建人账号非正整数时拒绝执行且不启动 mysql 进程', () => {
    process.env[OPT_IN_ENV] = '1';

    expect(() =>
      restoreMutatedReferenceDocumentFixtureRow(
        readBackendEnv(),
        restoreTarget({ createdByAccountId: 0 }),
      ),
    ).toThrow('创建人账号未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  // ---- restoreMutatedReferenceDocumentFixtureRow：事务内「锁行 → 写前核验 → 更新 → 影响行数守卫」----

  it('恢复脚本先锁行、写前核验、更新后核对影响行数，全部在同一 mysql 事务内', () => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock
      .mockReturnValueOnce('lithography_e2e')
      .mockReturnValueOnce('database=lithography_e2e existing_rows=1 restored_rows=1');

    restoreMutatedReferenceDocumentFixtureRow(readBackendEnv(), restoreTarget());

    const sqls = executedSqls();

    expect(sqls).toHaveLength(2);

    const restoreSql = sqls[1] ?? '';

    // 同一事务：锁行、写前核验、恢复、提交都在一个 mysql 进程的连接里
    expect(restoreSql).toContain('START TRANSACTION');
    expect(restoreSql.trimEnd().endsWith('COMMIT')).toBe(true);

    // 按精确 ID 锁定现有行
    expect(restoreSql).toContain(
      'SELECT id FROM reference_document WHERE id = 980001 LIMIT 1 FOR UPDATE',
    );

    // 逐列恢复为登记原值
    expect(restoreSql).toContain(`storage_reference = '${'a'.repeat(32)}.md'`);
    expect(restoreSql).toContain("storage_backend = 'local'");
    expect(restoreSql).toContain('content_text = NULL');

    // 身份绑定：精确 ID + 标题 + 创建人，绝不按标题前缀认领
    expect(restoreSql).toContain('id = 980001');
    expect(restoreSql).toContain(`title = '${TITLE}'`);
    expect(restoreSql).toContain(`created_by_account_id = ${CREATED_BY_ACCOUNT_ID}`);

    // UPDATE 的 WHERE 同时含身份与逐列「当前值仍是本轮制造状态」（NULL 安全）条件
    expect(restoreSql).toContain(
      `UPDATE reference_document SET storage_reference = '${'a'.repeat(32)}.md', storage_backend = 'local', content_text = NULL WHERE id = 980001 AND title = '${TITLE}' AND created_by_account_id = ${CREATED_BY_ACCOUNT_ID} AND (storage_reference <=> NULL AND storage_backend <=> NULL AND content_text <=> 'mutated')`,
    );

    const lockIndex = restoreSql.indexOf('FOR UPDATE');
    const firstGuardIndex = restoreSql.indexOf(
      'INSERT INTO e2e_reference_document_fixture_restore_guard',
    );
    const updateIndex = restoreSql.indexOf('UPDATE reference_document SET');
    const captureIndex = restoreSql.indexOf('SET @restored_rows = ROW_COUNT()');
    const secondGuardIndex = restoreSql.lastIndexOf(
      'INSERT INTO e2e_reference_document_fixture_restore_guard',
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    // 写前核验守卫先于 UPDATE（锁行亦先于 UPDATE）：不符时绝不执行 UPDATE
    expect(firstGuardIndex).toBeGreaterThan(lockIndex);
    expect(firstGuardIndex).toBeLessThan(updateIndex);
    // 更新后立即捕获影响行数，并在 COMMIT 前经第二道守卫
    expect(captureIndex).toBeGreaterThan(updateIndex);
    expect(secondGuardIndex).toBeGreaterThan(captureIndex);
    expect(restoreSql).toContain('CHECK (violations = 0)');
    // 写前守卫含库名 + 身份/逐列制造值核验
    expect(restoreSql).toContain("(DATABASE() <> 'lithography_e2e')");
    expect(restoreSql).toContain('(1 - (SELECT COUNT(*) FROM reference_document WHERE id = 980001');
    // 更新后守卫要求影响行数恰好 1
    expect(restoreSql).toContain('(1 - @restored_rows)');
  });

  it.each([
    ['制造状态已被意外改动', 'database=lithography_e2e existing_rows=1 restored_rows=0'],
    ['目标行缺失', 'database=lithography_e2e existing_rows=0 restored_rows=0'],
    ['实际库名非专用隔离库', 'database=lithography_drill existing_rows=1 restored_rows=1'],
  ])('恢复诊断不达标（%s）时抛错并保留行与文件', (_label, diagnosticOutput) => {
    process.env[OPT_IN_ENV] = '1';
    execFileSyncMock.mockReturnValueOnce('lithography_e2e').mockReturnValueOnce(diagnosticOutput);

    expect(() =>
      restoreMutatedReferenceDocumentFixtureRow(readBackendEnv(), restoreTarget()),
    ).toThrow('夹具恢复核验失败（保留行与文件）');
  });
});
