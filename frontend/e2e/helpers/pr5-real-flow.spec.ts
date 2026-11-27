// e2e/helpers/pr5-real-flow.spec.ts
// @vitest-environment node
// PR5 helper 的负例单测（vitest 运行；Playwright 的专用配置只收集 e2e-real 下的真实用例）。
//
// 覆盖目标（对齐 S5 评审 P3-2）：
// 1. 非法参数必须在**任何 SQL 组装/数据库进程启动之前**被拒绝（expect 断言不是安全边界）；
// 2. 归属绑定必须「三因子齐全 + 子行集合精确」，缺任一因子或扩大到父 ID 无差别删除都要变红
//    ——故此处以生成 SQL 的结构断言作为变异探针（改/删任一绑定因子即失配）；
// 3. 失败关闭路径（绑定不唯一、引用非法）必须抛错，绝不静默跳过删除。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertPr5GeneratedId,
  buildPr5DocKeyword,
  buildPr5RowConditions,
  countPr5ReferenceDocumentsByTitlePrefix,
  createPr5RowSnapshot,
  deletePr5ReferenceDocumentBound,
  deletePr5RepairRequestBound,
  diffPr5ColumnSets,
  encodePr5SqlStringLiteral,
  findPr5ReferenceDocumentIdsByKeyword,
  PR5_DOC_KEYWORD_PATTERN,
  type Pr5EngineerResponseBinding,
  type Pr5RowSnapshot,
  readPr5CanonicalColumns,
  readPr5PrimaryKeySnapshot,
  readPr5ReferenceDocumentDeprecatedById,
  readPr5ReferenceDocumentSnapshot,
  readPr5ReferenceDocumentStorageReferenceBound,
  readPr5RepairRequestState,
} from './pr5-real-flow';

const { execFileSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

// mysql 进程与后端 env 文件替换为 mock：本文件不访问真实数据库、不依赖本地 env 文件
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}));

const OPT_IN_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';
const originalOptIn = process.env[OPT_IN_ENV];
const originalBackendOrigin = process.env.E2E_BACKEND_ORIGIN;

const VALID_REQUEST_NO = 'RR20260902000000AB12CD';
const VALID_KEYWORD = buildPr5DocKeyword('abcdefgh');
const VALID_REFERENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.pdf';

/**
 * canonical 完整行快照基线（unit 专用）：取值形态与数据库读回一致
 * （nullable 为字面量 `NULL`，`timestamp(3)` 为毫秒精度字符串，tinyint 为 `0/1`）。
 * 用例改任一非三因子字段都会改变 WHERE——这正是「三因子不变即可删」的封堵点。
 */
const RR_SNAPSHOT_BASE: Readonly<Record<string, string>> = {
  accepted_at: 'NULL',
  accepted_by_engineer_account_id: 'NULL',
  content_md: '正文',
  created_at: '2026-01-01 00:00:00.000',
  customer_account_id: '42',
  deleted_at: 'NULL',
  deprecated: '0',
  equipment_model_id: '7',
  error_code: 'E2E-PR5',
  fault_description: '故障描述',
  id: '970100',
  is_accepted: '0',
  request_no: VALID_REQUEST_NO,
};

const RD_SNAPSHOT_BASE: Readonly<Record<string, string>> = {
  content_text: 'run-id',
  created_at: '2026-01-01 00:00:00.000',
  created_by_account_id: '7',
  deleted_at: 'NULL',
  deprecated: '0',
  description: 'NULL',
  document_type: 'CHECKLIST',
  equipment_model_id: 'NULL',
  id: '970100',
  mime_type: 'NULL',
  original_filename: 'NULL',
  storage_backend: 'NULL',
  storage_reference: 'NULL',
  title: `${VALID_KEYWORD}（单元）`,
  updated_at: '2026-01-01 00:00:00.000',
};

function repairRequestSnapshot(overrides: Readonly<Record<string, string>> = {}): Pr5RowSnapshot {
  return createPr5RowSnapshot('repair_request', { ...RR_SNAPSHOT_BASE, ...overrides });
}

function referenceDocumentSnapshot(
  overrides: Readonly<Record<string, string>> = {},
): Pr5RowSnapshot {
  return createPr5RowSnapshot('reference_document', { ...RD_SNAPSHOT_BASE, ...overrides });
}

/** 工程师回复 7/7 canonical 快照基线（unit 专用；非五因子字段如 resolution_status 参与 WHERE） */
const ER_SNAPSHOT_BASE: Readonly<Record<string, string>> = {
  created_at: '2026-01-01 00:00:00.000',
  customer_account_id: '42',
  engineer_account_id: '7',
  id: '11',
  request_id: '970100',
  resolution_status: 'PENDING',
  response_text: '回复正文',
};

function engineerResponseBinding(
  id: number,
  overrides: Readonly<Record<string, string>> = {},
): Pr5EngineerResponseBinding {
  return {
    customerAccountId: 42,
    engineerAccountId: 7,
    id,
    requestId: 970100,
    responseText: '回复正文',
    snapshot: createPr5RowSnapshot('engineer_response', {
      ...ER_SNAPSHOT_BASE,
      id: String(id),
      ...overrides,
    }),
  };
}

/** 期望的回复整行 WHERE（独立 oracle：任何列增删/漏拼都会让断言变红，含 resolution_status） */
function expectedEngineerResponseWhere(id: number): string {
  return (
    `id = ${id} AND request_id = 970100 AND engineer_account_id = 7 AND customer_account_id = 42` +
    " AND resolution_status = 'PENDING' AND response_text = '回复正文'" +
    " AND created_at = '2026-01-01 00:00:00.000'"
  );
}

/** 期望的整行 WHERE（独立 oracle：与 canonical 列清单手工对照，任何列增删/漏拼都会让断言变红） */
const RR_ROW_WHERE =
  `id = 970100 AND request_no = '${VALID_REQUEST_NO}' AND customer_account_id = 42` +
  " AND equipment_model_id = 7 AND error_code = 'E2E-PR5' AND fault_description = '故障描述'" +
  " AND content_md = '正文' AND created_at = '2026-01-01 00:00:00.000' AND is_accepted = 0" +
  ' AND accepted_by_engineer_account_id IS NULL AND accepted_at IS NULL AND deprecated = 0' +
  ' AND deleted_at IS NULL';

const RD_ROW_WHERE =
  `id = 970100 AND title = '${VALID_KEYWORD}（单元）' AND document_type = 'CHECKLIST'` +
  ' AND equipment_model_id IS NULL AND description IS NULL AND original_filename IS NULL' +
  " AND mime_type IS NULL AND content_text = 'run-id' AND storage_backend IS NULL" +
  ' AND storage_reference IS NULL AND created_by_account_id = 7 AND deprecated = 0' +
  " AND deleted_at IS NULL AND created_at = '2026-01-01 00:00:00.000'" +
  " AND updated_at = '2026-01-01 00:00:00.000'";

/** 取最近一次 mysql 调用的 SQL 字面量 */
function executedSql(): string {
  const lastCallArgs = execFileSyncMock.mock.lastCall?.[1] as string[] | undefined;
  const flagIndex = lastCallArgs?.indexOf('-e') ?? -1;

  return (flagIndex >= 0 ? lastCallArgs?.[flagIndex + 1] : undefined) ?? '';
}

describe('pr5-real-flow 参数白名单（非法参数绝不启动 mysql 进程）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
      );
    // 安全门与代号一致性门全部放行：让「非法参数」成为唯一可能的失败原因
    process.env[OPT_IN_ENV] = '1';
    delete process.env.E2E_BACKEND_ORIGIN;
  });

  afterAll(() => {
    if (originalOptIn === undefined) {
      delete process.env[OPT_IN_ENV];
    } else {
      process.env[OPT_IN_ENV] = originalOptIn;
    }

    if (originalBackendOrigin === undefined) {
      delete process.env.E2E_BACKEND_ORIGIN;
    } else {
      process.env.E2E_BACKEND_ORIGIN = originalBackendOrigin;
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    '维修申请清理：非法 ID（%p）直接抛错',
    (invalidId) => {
      expect(() =>
        deletePr5RepairRequestBound({
          customerAccountId: 2,
          id: invalidId,
          requestNo: VALID_REQUEST_NO,
          responses: [],
          snapshot: repairRequestSnapshot(),
        }),
      ).toThrow('未通过正整数校验');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['注入引号', `RR20260902000000AB12CD' OR '1'='1`],
    ['分号拼接', 'RR20260902000000AB12CD; DROP TABLE repair_request;--'],
    ['大写前缀以外的任意内容', 'NOT-A-REQUEST-NO'],
  ])('维修申请清理：非法编号（%s）直接抛错', (_label, invalidRequestNo) => {
    expect(() =>
      deletePr5RepairRequestBound({
        customerAccountId: 2,
        id: 1,
        requestNo: invalidRequestNo,
        responses: [],
        snapshot: repairRequestSnapshot(),
      }),
    ).toThrow('未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([0, -3, 2.5])('维修申请清理：非法客户账号（%p）直接抛错', (invalidAccountId) => {
    expect(() =>
      deletePr5RepairRequestBound({
        customerAccountId: invalidAccountId,
        id: 1,
        requestNo: VALID_REQUEST_NO,
        responses: [],
        snapshot: repairRequestSnapshot(),
      }),
    ).toThrow('未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([0, -3, 4.5])('维修申请清理：非法回复 ID（%p）直接抛错', (invalidResponseId) => {
    expect(() =>
      deletePr5RepairRequestBound({
        customerAccountId: 2,
        id: 1,
        requestNo: VALID_REQUEST_NO,
        // 回复绑定 ID 非法（快照仍合法）：必须在任何 SQL 组装之前被回复参数白名单拒绝
        responses: [{ ...engineerResponseBinding(11), id: invalidResponseId }],
        snapshot: repairRequestSnapshot(),
      }),
    ).toThrow('未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('维修申请清理：回复绑定的父申请 ID 与父绑定不一致直接抛错', () => {
    // 绑定自身自洽（requestId 与快照的 request_id 一致），但挂到了别的父申请上
    const otherParentBinding: Pr5EngineerResponseBinding = {
      ...engineerResponseBinding(11, { request_id: '999999' }),
      requestId: 999999,
    };

    expect(() =>
      deletePr5RepairRequestBound({
        customerAccountId: 42,
        id: 970100,
        requestNo: VALID_REQUEST_NO,
        responses: [otherParentBinding],
        snapshot: repairRequestSnapshot(),
      }),
    ).toThrow('父申请 ID 与绑定不一致');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['关键词含 LIKE 通配符', 'PR5真实链路验收行·abc%def'],
    ['关键词含引号', "PR5真实链路验收行·abc'def"],
    ['关键词缺前缀', 'abcdefgh'],
    ['关键词以中文括号收尾（越权前缀专用形态）', 'PR5真实链路验收行·abcdefgh（'],
  ])('资料清理：非法标题关键字（%s）直接抛错', (_label, invalidKeyword) => {
    const binding = {
      createdByAccountId: 2,
      id: 1,
      snapshot: referenceDocumentSnapshot(),
      titleKeyword: invalidKeyword,
    };

    expect(() => deletePr5ReferenceDocumentBound(binding)).toThrow('未通过白名单校验');
    expect(() => readPr5ReferenceDocumentStorageReferenceBound(binding)).toThrow(
      '未通过白名单校验',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([0, -3, 1.5])('资料清理：非法创建人账号（%p）直接抛错', (invalidAccountId) => {
    expect(() =>
      deletePr5ReferenceDocumentBound({
        createdByAccountId: invalidAccountId,
        id: 1,
        snapshot: referenceDocumentSnapshot(),
        titleKeyword: VALID_KEYWORD,
      }),
    ).toThrow('未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['关键词直接拼 LIKE 通配符 %', `${VALID_KEYWORD}%`],
    ['关键词含下划线 _', `${VALID_KEYWORD}_x`],
    ['关键词含单引号', `${VALID_KEYWORD}' OR '1'='1`],
    ['关键词含反斜杠', `${VALID_KEYWORD}\\`],
    ['关键词含空白', `${VALID_KEYWORD} x`],
  ])('资料反查：非法关键字（%s）直接抛错', (_label, invalidKeyword) => {
    expect(() => findPr5ReferenceDocumentIdsByKeyword(invalidKeyword)).toThrow('未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([1.5, 0, -1])('资料快照：非法 ID（%p）直接抛错', (invalidId) => {
    expect(() => readPr5ReferenceDocumentSnapshot(invalidId)).toThrow('未通过正整数校验');
    expect(() => readPr5ReferenceDocumentDeprecatedById(invalidId)).toThrow('未通过正整数校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each([1.5, 0])('维修申请状态读取：非法客户账号（%p）直接抛错', (invalidAccountId) => {
    expect(() => readPr5RepairRequestState(VALID_REQUEST_NO, invalidAccountId)).toThrow(
      '未通过正整数校验',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('维修申请状态读取：非法编号直接抛错', () => {
    expect(() => readPr5RepairRequestState("RR20260902000000AB12C'", 2)).toThrow(
      '未通过白名单校验',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('主键快照：非白名单表名直接抛错', () => {
    expect(() =>
      readPr5PrimaryKeySnapshot('base_user_account' as unknown as 'repair_request'),
    ).toThrow('未通过白名单校验');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('deletePr5RepairRequestBound 子行集合精确绑定（P1-3）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
      );
    process.env[OPT_IN_ENV] = '1';
  });

  it('SQL 同时携带父行完整行快照、子行闭包断言与逐条回复 7/7 完整快照复核', () => {
    deletePr5RepairRequestBound({
      customerAccountId: 42,
      id: 970100,
      requestNo: VALID_REQUEST_NO,
      responses: [engineerResponseBinding(11), engineerResponseBinding(22)],
      snapshot: repairRequestSnapshot(),
    });

    const sql = executedSql();

    // 父行完整行快照：canonical 13/13 列（不再只绑三因子）
    expect(sql).toContain(`FROM repair_request WHERE ${RR_ROW_WHERE}`);
    expect(sql).toContain(
      'pr5_repair_request_binding_id_request_no_customer_must_match_exactly_one',
    );
    // 子行闭包：总数与实际回复集合都必须精确等于本轮回复集合
    expect(sql).toContain(
      'SET @pr5_rr_child_total = (SELECT COUNT(*) FROM engineer_response WHERE request_id = 970100)',
    );
    expect(sql).toContain(
      'SET @pr5_rr_child_matched = (SELECT COUNT(*) FROM engineer_response WHERE request_id = 970100 AND id IN (11, 22))',
    );
    expect(sql).toContain(
      "IF(@pr5_rr_child_total = 2 AND @pr5_rr_child_matched = 2, 'SELECT 1', 'SELECT pr5_engineer_response_child_binding_must_match_this_run')",
    );
    // 逐条回复 7/7 完整快照复核：按各自整行 WHERE 精确命中 1 行，否则哨兵（含回复 ID）失败关闭
    expect(sql).toContain(
      `SET @pr5_rr_child_full_11 = (SELECT COUNT(*) FROM engineer_response WHERE ${expectedEngineerResponseWhere(11)})`,
    );
    expect(sql).toContain(
      `SET @pr5_rr_child_full_22 = (SELECT COUNT(*) FROM engineer_response WHERE ${expectedEngineerResponseWhere(22)})`,
    );
    expect(sql).toContain('pr5_engineer_response_child_pk_11_full_snapshot_must_match_exactly_one');
    expect(sql).toContain('pr5_engineer_response_child_pk_22_full_snapshot_must_match_exactly_one');
    // 逐条按完整 7/7 WHERE 删除（含 resolution_status，任一字段被改写即失配），并核对精确影响行数为 1
    expect(sql).toContain(
      `DELETE FROM engineer_response WHERE ${expectedEngineerResponseWhere(11)}`,
    );
    expect(sql).toContain(
      `DELETE FROM engineer_response WHERE ${expectedEngineerResponseWhere(22)}`,
    );
    expect(sql).toContain(
      "IF(@pr5_rr_child_deleted_11 = 1, 'SELECT 1', 'SELECT pr5_engineer_response_child_delete_must_affect_exactly_one_row')",
    );
    expect(sql).toContain(
      "IF(@pr5_rr_child_deleted_22 = 1, 'SELECT 1', 'SELECT pr5_engineer_response_child_delete_must_affect_exactly_one_row')",
    );
    // 绝不按父 ID 无差别删除子行
    expect(sql).not.toContain('DELETE FROM engineer_response WHERE request_id = 970100;');
    // 残留核对为 0 后才提交
    expect(sql).toContain('pr5_repair_request_residue_must_be_zero');
    expect(sql).toContain('COMMIT');
  });

  it('子回复非五因子字段（resolution_status）进入父事务 WHERE：改这里会让删除失配', () => {
    // 变异探针：把 resolution_status 改成 RESOLVED 后，父事务内的完整 WHERE 必须随之改变
    deletePr5RepairRequestBound({
      customerAccountId: 42,
      id: 970100,
      requestNo: VALID_REQUEST_NO,
      responses: [engineerResponseBinding(11, { resolution_status: 'RESOLVED' })],
      snapshot: repairRequestSnapshot(),
    });

    const sql = executedSql();

    expect(sql).toContain("AND resolution_status = 'RESOLVED'");
    expect(sql).not.toContain(
      `DELETE FROM engineer_response WHERE ${expectedEngineerResponseWhere(11)}`,
    );
  });

  it('无回复时以 IN (0) 占位，等价于「本轮允许的回复集合为空」', () => {
    deletePr5RepairRequestBound({
      customerAccountId: 42,
      id: 970100,
      requestNo: VALID_REQUEST_NO,
      responses: [],
      snapshot: repairRequestSnapshot(),
    });

    const sql = executedSql();

    expect(sql).toContain('AND id IN (0))');
    expect(sql).toContain("IF(@pr5_rr_child_total = 0 AND @pr5_rr_child_matched = 0, 'SELECT 1'");
    // 无回复时不得出现任何逐条回复删除语句
    expect(sql).not.toContain('DELETE FROM engineer_response WHERE id =');
  });

  it('绑定断言失败（哨兵）会让 mysql 客户端在 DELETE 之前报错退出：异常必须上抛', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error(
        'ERROR 1054 (42S22): Unknown column pr5_engineer_response_child_binding_must_match_this_run',
      );
    });

    expect(() =>
      deletePr5RepairRequestBound({
        customerAccountId: 42,
        id: 970100,
        requestNo: VALID_REQUEST_NO,
        responses: [engineerResponseBinding(11)],
        snapshot: repairRequestSnapshot(),
      }),
    ).toThrow('pr5_engineer_response_child_binding_must_match_this_run');
  });
});

describe('readPr5RepairRequestState 客户绑定（D4-3）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
      );
    process.env[OPT_IN_ENV] = '1';
  });

  it('只读 SQL 按编号 + 客户双重绑定（与清理路径口径一致）', () => {
    execFileSyncMock.mockReturnValue('1\t0\t0');

    const state = readPr5RepairRequestState(VALID_REQUEST_NO, 42);

    expect(executedSql()).toBe(
      `SELECT is_accepted, deprecated, deleted_at IS NOT NULL FROM repair_request WHERE request_no = '${VALID_REQUEST_NO}' AND customer_account_id = 42`,
    );
    expect(state).toEqual({ deletedAtIsNotNull: '0', deprecated: '0', isAccepted: '1' });
  });

  it('列数异常时抛错，不返回半残结果', () => {
    execFileSyncMock.mockReturnValue('1\t0');

    expect(() => readPr5RepairRequestState(VALID_REQUEST_NO, 42)).toThrow('读取结果异常');
  });
});

describe('历史维修记录归属核验与精确引用（P1-2 / D4-1）', () => {
  const validBinding = {
    createdByAccountId: 7,
    id: 970100,
    snapshot: referenceDocumentSnapshot(),
    titleKeyword: VALID_KEYWORD,
  };

  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('');
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
      );
    process.env[OPT_IN_ENV] = '1';
  });

  it('核验 SQL 走完整行快照（不再是 id + 创建人 + 标题关键字子集）', () => {
    execFileSyncMock.mockReturnValue(`1|${VALID_REFERENCE}`);

    expect(readPr5ReferenceDocumentStorageReferenceBound(validBinding)).toBe(VALID_REFERENCE);
    expect(executedSql()).toBe(
      `SELECT CONCAT(COUNT(*), '|', IFNULL(MAX(storage_reference), '')) FROM reference_document WHERE ${RD_ROW_WHERE}`,
    );
  });

  it.each([['0'], ['2'], ['abc']])('绑定未精确命中 1 行（%s）时失败关闭', (boundCount) => {
    execFileSyncMock.mockReturnValue(`${boundCount}|${VALID_REFERENCE}`);

    expect(() => readPr5ReferenceDocumentStorageReferenceBound(validBinding)).toThrow(
      '归属核验未精确命中 1 行',
    );
  });

  it.each([[''], ['NULL']])('无存储引用（%p）返回 null，不误删文件', (emptyReference) => {
    execFileSyncMock.mockReturnValue(`1|${emptyReference}`);

    expect(readPr5ReferenceDocumentStorageReferenceBound(validBinding)).toBeNull();
  });

  it.each([
    ['路径穿越', '../../../etc/passwd'],
    ['非白名单格式', 'short-name.pdf'],
  ])('白名单外引用（%s）拒绝返回，绝不落到删除路径', (_label, reference) => {
    execFileSyncMock.mockReturnValue(`1|${reference}`);

    expect(() => readPr5ReferenceDocumentStorageReferenceBound(validBinding)).toThrow(
      '未通过白名单校验',
    );
  });

  it('读取结果缺列异常时抛错（不把解析异常当成「无引用」放行）', () => {
    execFileSyncMock.mockReturnValue('1');

    expect(() => readPr5ReferenceDocumentStorageReferenceBound(validBinding)).toThrow(
      '读取结果异常',
    );
  });

  it('反查兜底不按 deprecated 过滤（软删行同样属于本轮自建行，必须可回收）', () => {
    execFileSyncMock.mockReturnValue('970100\n970101');

    expect(findPr5ReferenceDocumentIdsByKeyword(VALID_KEYWORD)).toEqual([970100, 970101]);
    expect(executedSql()).toBe(
      `SELECT id FROM reference_document WHERE title LIKE '%${VALID_KEYWORD}%'`,
    );
    expect(executedSql()).not.toContain('deprecated');
  });

  it('反查结果过滤非法数值，不把 NaN 带入后续删除路径', () => {
    execFileSyncMock.mockReturnValue('970100\n\nabc\n-1\n970101');

    expect(findPr5ReferenceDocumentIdsByKeyword(VALID_KEYWORD)).toEqual([970100, 970101]);
  });

  it('越权前缀计数走白名单函数，SQL 使用前缀 LIKE 且不含关键字通配符', () => {
    execFileSyncMock.mockReturnValue('0');

    const prefix = `${VALID_KEYWORD}（工程师越权`;

    expect(countPr5ReferenceDocumentsByTitlePrefix(prefix)).toBe(0);
    expect(executedSql()).toBe(
      `SELECT COUNT(*) FROM reference_document WHERE title LIKE '${prefix}%'`,
    );
  });

  it.each([
    [`${VALID_KEYWORD}（工程师越权%`],
    [`${VALID_KEYWORD}（越权_`],
    [`${VALID_KEYWORD}（引号'`],
  ])('越权前缀计数：白名单外前缀（%s）直接抛错', (invalidPrefix) => {
    expect(() => countPr5ReferenceDocumentsByTitlePrefix(invalidPrefix)).toThrow(
      '未通过白名单校验',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('删除 SQL 携带完整行快照绑定断言 + 残留核对 + COMMIT', () => {
    deletePr5ReferenceDocumentBound(validBinding);

    const sql = executedSql();

    expect(sql).toContain(`FROM reference_document WHERE ${RD_ROW_WHERE}`);
    expect(sql).toContain(
      'pr5_reference_document_binding_id_creator_keyword_must_match_exactly_one',
    );
    expect(sql).toContain('pr5_reference_document_residue_must_be_zero');
    expect(sql).toContain('COMMIT');
  });

  it('快照读取使用静态列白名单与本表 canonical 全列（不拼接外部输入）', () => {
    const row =
      '1\tt\tCHECKLIST\tNULL\tNULL\tdesc\tfile.md\ttext\tlocal\ta1b2c3d4e5f60718293a4b5c6d7e8f90.pdf\t7\t0\tNULL\t2026-01-01 00:00:00.000\t2026-01-01 00:00:00.000';

    execFileSyncMock.mockReturnValue(row);

    expect(readPr5ReferenceDocumentSnapshot(970100)).toBe(row);
    expect(executedSql()).toBe(
      `SELECT ${readPr5CanonicalColumns('reference_document').join(', ')} FROM reference_document WHERE id = 970100`,
    );
  });
});

describe('主键快照与「DB 生成 ID」证据', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    readFileSyncMock
      .mockReset()
      .mockReturnValue(
        'DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASS=secret\nDB_NAME=app_e2e\n',
      );
    process.env[OPT_IN_ENV] = '1';
  });

  it('快照解析正整数集合；命中快照即证明「复用了既有主键」并抛错', () => {
    execFileSyncMock.mockReturnValue('970001\n970002\n');

    const snapshot = readPr5PrimaryKeySnapshot('reference_document');

    expect(snapshot).toEqual(new Set([970001, 970002]));
    expect(() => assertPr5GeneratedId(970001, snapshot, '本轮资料')).toThrow('复用了既有主键');
    expect(() => assertPr5GeneratedId(970100, snapshot, '本轮资料')).not.toThrow();
  });

  it('快照含非法数值时抛错，不静默丢弃', () => {
    execFileSyncMock.mockReturnValue('970001\nnot-a-number\n');

    expect(() => readPr5PrimaryKeySnapshot('repair_request')).toThrow('主键快照解析异常');
  });

  it('本轮 ID 未通过正整数校验时抛错', () => {
    expect(() => assertPr5GeneratedId(0, new Set<number>(), '本轮资料')).toThrow(
      '未通过正整数校验',
    );
  });
});

describe('运行级关键字形态', () => {
  it('buildPr5DocKeyword 产出的关键字必须过白名单', () => {
    expect(PR5_DOC_KEYWORD_PATTERN.test(buildPr5DocKeyword('abcdefgh'))).toBe(true);
    expect(buildPr5DocKeyword('abcdefgh')).toBe('PR5真实链路验收行·abcdefgh');
  });
});

describe('canonical 列清单与 schema 双向差集（S0：删一个 canonical 字段必红）', () => {
  it('三张表 canonical 列数分别为 13 / 7 / 15', () => {
    expect(readPr5CanonicalColumns('repair_request')).toHaveLength(13);
    expect(readPr5CanonicalColumns('engineer_response')).toHaveLength(7);
    expect(readPr5CanonicalColumns('reference_document')).toHaveLength(15);
  });

  it.each(['repair_request', 'engineer_response', 'reference_document'] as const)(
    '库 schema 与 canonical 完全一致（%s）时双向差集为空',
    (table) => {
      const canonical = readPr5CanonicalColumns(table);

      expect(diffPr5ColumnSets(canonical, canonical)).toEqual({
        duplicatesInCanonical: [],
        missingInActual: [],
        unexpectedInActual: [],
      });
    },
  );

  it('红：实际少一个 canonical 字段（库缺列）必被识别', () => {
    const canonical = [...readPr5CanonicalColumns('reference_document')];
    const actual = canonical.filter((column) => column !== 'updated_at');

    expect(diffPr5ColumnSets(actual, canonical)).toEqual({
      duplicatesInCanonical: [],
      missingInActual: ['updated_at'],
      unexpectedInActual: [],
    });
  });

  it('红：实际多一个非 canonical 字段（库新增列未纳入清单）必被识别', () => {
    const canonical = [...readPr5CanonicalColumns('repair_request')];
    const actual = [...canonical, 'external_note'];

    expect(diffPr5ColumnSets(actual, canonical)).toEqual({
      duplicatesInCanonical: [],
      missingInActual: [],
      unexpectedInActual: ['external_note'],
    });
  });

  it('红：canonical 自身出现重复列必被识别', () => {
    const canonical = [...readPr5CanonicalColumns('engineer_response'), 'response_text'];

    expect(diffPr5ColumnSets([...new Set(canonical)], canonical)).toEqual({
      duplicatesInCanonical: ['response_text'],
      missingInActual: [],
      unexpectedInActual: [],
    });
  });
});

describe('整行快照构造与 WHERE 口径（S0：缺列 / 非 canonical / 非三因子变更必红）', () => {
  it('缺任一 canonical 列时拒绝构造（禁止只绑定字段子集）', () => {
    const partial: Record<string, string> = {};

    for (const [column, value] of Object.entries(RR_SNAPSHOT_BASE)) {
      if (column !== 'content_md') {
        partial[column] = value;
      }
    }

    expect(() => createPr5RowSnapshot('repair_request', partial)).toThrow(
      '完整行快照缺少 canonical 字段 repair_request.content_md',
    );
  });

  it('含非 canonical 列时拒绝构造', () => {
    expect(() =>
      createPr5RowSnapshot('repair_request', { ...RR_SNAPSHOT_BASE, extra_column: 'x' }),
    ).toThrow('完整行快照含非 canonical 字段 repair_request.extra_column');
  });

  it('维修申请 WHERE 覆盖 canonical 全部 13 列，nullable 用 IS NULL', () => {
    const condition = buildPr5RowConditions(repairRequestSnapshot());

    expect(condition).toBe(RR_ROW_WHERE);

    for (const column of readPr5CanonicalColumns('repair_request')) {
      expect(condition).toContain(column);
    }

    expect(condition).toContain('accepted_by_engineer_account_id IS NULL');
    expect(condition).toContain('accepted_at IS NULL');
    expect(condition).toContain('deleted_at IS NULL');
  });

  it('历史维修记录 WHERE 覆盖 canonical 全部 15 列', () => {
    const condition = buildPr5RowConditions(referenceDocumentSnapshot());

    expect(condition).toBe(RD_ROW_WHERE);

    for (const column of readPr5CanonicalColumns('reference_document')) {
      expect(condition).toContain(column);
    }
  });

  it('改动任一非三因子字段都会改变 WHERE（消灭「三因子不变即可删」的路径）', () => {
    const baseline = buildPr5RowConditions(repairRequestSnapshot());
    const mutated = buildPr5RowConditions(repairRequestSnapshot({ content_md: '被外部改写' }));

    expect(mutated).not.toBe(baseline);
    expect(mutated).toContain("content_md = '被外部改写'");
    expect(baseline).toContain("content_md = '正文'");
  });

  // 真实业务正文是多行 Markdown、含单引号与反斜杠：旧窄白名单会在真实库回读时误判非法
  // （unit 造数用的是短安全值，故必须专门补这条，避免「单测绿、真实库红」的验证不封闭）。
  it('真实业务文本形态（batch 转义 / 单引号 / 反斜杠）不再被误判非法，且安全编码不二次转义', () => {
    // 含原始换行的值不是规范回读形态（batch 模式会把 LF 转为字面量 \n）→ 拒绝，防止静默破坏行解析
    const rawNewlineValue = "第一行\n第二行'带引号'\\反斜杠";

    expect(() =>
      createPr5RowSnapshot('repair_request', {
        ...RR_SNAPSHOT_BASE,
        content_md: rawNewlineValue,
      }),
    ).toThrow('取值非法');

    // mysql -B 的真实回读形态（\n 与 \\ 为字面量，单引号原样）→ 接受
    const batchValue = "第一行\\n第二行'带引号'\\\\反斜杠";

    expect(() =>
      createPr5RowSnapshot('repair_request', { ...RR_SNAPSHOT_BASE, content_md: batchValue }),
    ).not.toThrow();

    // 仅单引号转义为 \'；既有 \n / \\ 保持原样（否则会二次转义导致 WHERE 失配）
    expect(encodePr5SqlStringLiteral(batchValue)).toBe("'第一行\\n第二行\\'带引号\\'\\\\反斜杠'");
  });
});
