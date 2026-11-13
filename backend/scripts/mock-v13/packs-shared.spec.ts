// scripts/mock-v13/packs-shared.spec.ts

/**
 * 离线补测：正式迁移生成的 local_installation 单例（随机 UUID、organization_id 为空）
 * 必须按实际 installation_id 复用，且整行不被修改。
 */

/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockConflictError, MockVerificationError, MockWriteError } from './errors';
import { FileRegistry } from './files';
import { MockQueryRunner, Row } from './db';
import { ACCOUNTS, mockEmail, mockUuid } from './manifest';
import {
  PackContext,
  StoredFileExpectation,
  assertAccountsEligible,
  assertStoredFileMatches,
  bindStoredFile,
  readInstallationIdentity,
  resolveInstallationIdentity,
} from './packs-shared';
import { runBackupPack } from './packs-p1';
import { runDocumentsPack, runRepairPack, runReportsPack } from './packs-p0';
import { RunReport } from './report';

class InstallationQueryRunner implements MockQueryRunner {
  readonly calls: { sql: string; parameters?: readonly unknown[] }[] = [];

  constructor(private readonly rows: Row[]) {}

  query(sql: string, parameters?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ sql, parameters });
    return Promise.resolve(this.rows);
  }
}

describe('local_installation 单例复用', () => {
  const formalInstallationId = 'c4634e24-de81-11f1-bea8-00e0709ef3a9';

  function formalRow(): Row {
    return {
      id: 1,
      installation_id: formalInstallationId,
      organization_id: null,
      organization_code_snapshot: null,
      local_site_name: null,
      auto_upload_enabled: 1,
      backup_interval_days: 7,
      last_backup_completed_at: null,
      created_at: new Date('2026-11-12T10:13:55.000Z'),
      updated_at: new Date('2026-11-12T10:13:55.000Z'),
    };
  }

  it('随机 UUID、组织为空的正式单例按实际 UUID 复用，整行不变', async () => {
    const row = formalRow();
    const snapshot = { ...row };
    const queryRunner = new InstallationQueryRunner([row]);

    const identity = await readInstallationIdentity(queryRunner);

    expect(identity).toEqual({ installationId: formalInstallationId, organizationId: null });
    expect(row).toEqual(snapshot);
    expect(
      queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
    ).toBe(false);
  });

  it('resolveInstallationIdentity 复用单例并记录未映射组织，不写库', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-installation-'));
    const queryRunner = new InstallationQueryRunner([formalRow()]);
    const context: PackContext = {
      qr: queryRunner,
      report: new RunReport(),
      files: new FileRegistry([tempDir]),
      mockFileDir: tempDir,
      referenceStorageDir: tempDir,
      passwordHash: 'unused-in-offline-test',
      encryption: { encrypt: (plain: string) => plain, decrypt: (cipher: string) => cipher },
    };
    context.report.startPack('p1-local');

    try {
      const identity = await resolveInstallationIdentity(context);

      expect(identity.installationId).toBe(formalInstallationId);
      expect(identity.organizationId).toBeNull();
      expect(context.report.packStats()[0]?.notes.join('')).toContain('organization_id=未映射');
      expect(
        queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installation_id 非 36 位 UUID 时按异主冲突拒绝', async () => {
    const queryRunner = new InstallationQueryRunner([
      { ...formalRow(), installation_id: 'not-a-uuid' },
    ]);

    await expect(readInstallationIdentity(queryRunner)).rejects.toBeInstanceOf(MockConflictError);
  });

  it('缺少正式单例行时拒绝自行创建', async () => {
    const queryRunner = new InstallationQueryRunner([]);

    await expect(readInstallationIdentity(queryRunner)).rejects.toBeInstanceOf(MockWriteError);
  });
});

/** 按表名返回固定行的离线查询器；只实现本测试所需的 SELECT/UPDATE。 */
class TableQueryRunner implements MockQueryRunner {
  readonly calls: { sql: string; parameters?: readonly unknown[] }[] = [];
  updateAffected = 1;
  private nextId = 900;

  constructor(readonly tables: Record<string, Row[]>) {}

  query(sql: string, parameters?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ sql, parameters });
    const trimmed = sql.trim();
    if (/^SELECT\b/iu.test(trimmed)) {
      const match = /\bFROM\s+`?([A-Za-z_]+)`?/iu.exec(trimmed);
      const table = match?.[1] ?? '';
      if (table === 'organization_membership') {
        return Promise.resolve(this.tables.membership ?? []);
      }
      return Promise.resolve(this.tables[table] ?? []);
    }
    if (/^INSERT\b/iu.test(trimmed)) {
      return Promise.resolve({ insertId: this.nextId++, affectedRows: 1 });
    }
    if (/^UPDATE\s+`?stored_file`?/iu.test(trimmed)) {
      if (this.updateAffected === 1 && this.tables.stored_file?.[0]) {
        const row = this.tables.stored_file[0];
        row.business_id = parameters?.[0] ?? null;
        row.binding_status = parameters?.[1] ?? row.binding_status;
      }
      return Promise.resolve({ affectedRows: this.updateAffected });
    }
    throw new Error(`未支持的离线 SQL: ${trimmed}`);
  }
}

function createContext(queryRunner: MockQueryRunner, root: string): PackContext {
  return {
    qr: queryRunner,
    report: new RunReport(),
    files: new FileRegistry([root]),
    mockFileDir: root,
    referenceStorageDir: path.join(root, 'reference'),
    passwordHash: 'unused-in-offline-test',
    encryption: { encrypt: (plain: string) => plain, decrypt: (cipher: string) => cipher },
  };
}

describe('分包复用前的账号事实校验', () => {
  const customer = ACCOUNTS.find((account) => account.key === 'customer-a');
  if (!customer) throw new Error('清单缺少 customer-a');
  const customerSpec = customer;

  function tables(userState: string, organizationStatus = 'ACTIVE'): Record<string, Row[]> {
    return {
      base_user_account: [
        {
          id: 200,
          login_name: customerSpec.loginName,
          login_email: mockEmail(customerSpec.loginName),
          nickname: '原昵称不可覆盖',
          status: customerSpec.accountStatus,
          identity_hint: customerSpec.role,
          admin_level: null,
        },
      ],
      base_user_info: [
        {
          account_id: 200,
          user_state: userState,
          access_group: '["CUSTOMER"]',
          meta_digest: '["CUSTOMER"]',
          customer_organization_id: 10,
        },
      ],
      organization: [
        {
          id: 10,
          organization_code: 'MOCK-V13-A',
          is_managed_company: 1,
          status: organizationStatus,
        },
      ],
      membership: [
        {
          organization_code: 'MOCK-V13-A',
          is_managed_company: 1,
          organization_status: organizationStatus,
          member_role: 'CUSTOMER',
          status: 'ACTIVE',
        },
      ],
    };
  }

  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-accounts-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('实际引用账号事实一致时通过，且不写库、不改昵称', async () => {
    const queryRunner = new TableQueryRunner(tables('ACTIVE'));
    const context = createContext(queryRunner, root);
    context.report.startPack('p0-repair');

    await expect(
      assertAccountsEligible(context, ['customer-a'], 'p0-repair'),
    ).resolves.toBeUndefined();
    expect(
      queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
    ).toBe(false);
    expect(queryRunner.tables.base_user_account[0]?.nickname).toBe('原昵称不可覆盖');
  });

  it('固定客户资料 INACTIVE 时在写行前拒绝', async () => {
    const queryRunner = new TableQueryRunner(tables('INACTIVE'));
    const context = createContext(queryRunner, root);
    context.report.startPack('p0-repair');

    await expect(
      assertAccountsEligible(context, ['customer-a'], 'p0-repair'),
    ).rejects.toBeInstanceOf(MockVerificationError);
    expect(
      queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
    ).toBe(false);
    expect(queryRunner.tables.base_user_account[0]?.nickname).toBe('原昵称不可覆盖');
  });

  it('仅组织停用而账号/资料/角色/成员行合法时仍拒绝，且不写库', async () => {
    const queryRunner = new TableQueryRunner(tables('ACTIVE', 'INACTIVE'));
    const membershipSnapshot = { ...queryRunner.tables.membership[0] };
    const context = createContext(queryRunner, root);
    context.report.startPack('p0-repair');

    await expect(
      assertAccountsEligible(context, ['customer-a'], 'p0-repair'),
    ).rejects.toBeInstanceOf(MockVerificationError);
    expect(
      queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
    ).toBe(false);
    expect(queryRunner.tables.base_user_account[0]?.nickname).toBe('原昵称不可覆盖');
    expect(queryRunner.tables.membership[0]).toEqual(membershipSnapshot);
  });
});

describe('停用组织不得通过 p1-backup 资格检查', () => {
  const admin = ACCOUNTS.find((account) => account.key === 'admin-l2-a');
  if (!admin) throw new Error('清单缺少 admin-l2-a');
  const adminSpec = admin;
  const installationId = 'c4634e24-de81-11f1-bea8-00e0709ef3a9';

  function backupTables(organizationStatus: string): Record<string, Row[]> {
    return {
      base_user_account: [
        {
          id: 300,
          login_name: adminSpec.loginName,
          login_email: mockEmail(adminSpec.loginName),
          nickname: '管理员原昵称',
          status: adminSpec.accountStatus,
          identity_hint: adminSpec.role,
          admin_level: adminSpec.adminLevel,
        },
      ],
      base_user_info: [
        {
          account_id: 300,
          user_state: adminSpec.userState,
          access_group: JSON.stringify([adminSpec.role]),
          meta_digest: JSON.stringify([adminSpec.role]),
          customer_organization_id: null,
        },
      ],
      organization: [
        {
          id: 10,
          organization_code: 'MOCK-V13-A',
          name: '[MOCK-V13] 星港光电（测试 A）',
          kind: 'PEER',
          is_managed_company: 1,
          status: organizationStatus,
        },
      ],
      membership: [
        {
          account_id: 300,
          organization_code: 'MOCK-V13-A',
          is_managed_company: 1,
          organization_status: organizationStatus,
          member_role: adminSpec.role,
          status: 'ACTIVE',
        },
      ],
      local_installation: [
        {
          id: 1,
          installation_id: installationId,
          organization_id: 10,
          organization_code_snapshot: 'MOCK-V13-A',
          local_site_name: null,
          auto_upload_enabled: 1,
          backup_interval_days: 7,
          last_backup_completed_at: null,
          created_at: new Date('2026-11-12T10:13:55.000Z'),
          updated_at: new Date('2026-11-12T10:13:55.000Z'),
        },
      ],
    };
  }

  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-backup-eligibility-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('仅 A 公司停用时单跑 p1-backup 在业务行或原件写入前拒绝', async () => {
    const queryRunner = new TableQueryRunner(backupTables('INACTIVE'));
    const context = createContext(queryRunner, root);
    context.report.startPack('p1-backup');

    await expect(runBackupPack(context)).rejects.toBeInstanceOf(MockVerificationError);
    expect(
      queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
    ).toBe(false);
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
    expect(queryRunner.tables.base_user_account[0]?.nickname).toBe('管理员原昵称');
  });

  it('恢复组织 ACTIVE 后同一单包命令成功，昵称与归属不被改写', async () => {
    const queryRunner = new TableQueryRunner(backupTables('ACTIVE'));
    const membershipSnapshot = { ...queryRunner.tables.membership[0] };
    const context = createContext(queryRunner, root);
    context.report.startPack('p1-backup');

    await expect(runBackupPack(context)).resolves.toBeUndefined();
    expect(queryRunner.calls.some((call) => /^INSERT\b/iu.test(call.sql))).toBe(true);
    expect(queryRunner.tables.base_user_account[0]?.nickname).toBe('管理员原昵称');
    expect(queryRunner.tables.membership[0]).toEqual(membershipSnapshot);
  });
});

describe('原件复用与绑定', () => {
  const expected: StoredFileExpectation = {
    fileId: 'file-uuid',
    storageReference: 'files/intake.png',
    originalFilename: 'intake.png',
    mimeType: 'image/png',
    byteSize: 4,
    checksumSha256: 'a'.repeat(64),
    businessType: 'REPAIR_REQUEST_INTAKE',
    uploaderAccountId: 200,
    ownerOrganizationId: 10,
  };

  function storedFileRow(overrides: Partial<Row> = {}): Row {
    return {
      file_id: expected.fileId,
      storage_reference: expected.storageReference,
      original_filename: expected.originalFilename,
      mime_type: expected.mimeType,
      byte_size: expected.byteSize,
      checksum_sha256: expected.checksumSha256,
      status: 'VALID',
      business_type: expected.businessType,
      business_id: null,
      binding_status: 'TEMPORARY',
      uploaded_by_account_id: expected.uploaderAccountId,
      owner_organization_id: expected.ownerOrganizationId,
      ...overrides,
    };
  }

  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-stored-file-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('库内 SHA-256 漂移时拒绝并保留原值', () => {
    expect(() =>
      assertStoredFileMatches(storedFileRow({ checksum_sha256: 'b'.repeat(64) }), expected),
    ).toThrow(MockConflictError);
    expect(() => assertStoredFileMatches(storedFileRow(), expected)).not.toThrow();
  });

  it('已绑定到其它报修 ID 时拒绝改绑', async () => {
    const queryRunner = new TableQueryRunner({
      stored_file: [storedFileRow({ binding_status: 'BOUND', business_id: '999' })],
    });
    const context = createContext(queryRunner, root);

    await expect(
      bindStoredFile(context, {
        fileId: expected.fileId,
        businessType: expected.businessType,
        businessId: '100',
        checksumSha256: expected.checksumSha256,
        createdInThisRun: false,
      }),
    ).rejects.toBeInstanceOf(MockConflictError);
    expect(queryRunner.tables.stored_file[0]?.business_id).toBe('999');
  });

  it('跨事务的未绑定行拒绝补绑', async () => {
    const queryRunner = new TableQueryRunner({ stored_file: [storedFileRow()] });
    const context = createContext(queryRunner, root);

    await expect(
      bindStoredFile(context, {
        fileId: expected.fileId,
        businessType: expected.businessType,
        businessId: '100',
        checksumSha256: expected.checksumSha256,
        createdInThisRun: false,
      }),
    ).rejects.toBeInstanceOf(MockConflictError);
  });

  it('本事务新建的未绑定行条件绑定成功', async () => {
    const queryRunner = new TableQueryRunner({ stored_file: [storedFileRow()] });
    const context = createContext(queryRunner, root);

    await expect(
      bindStoredFile(context, {
        fileId: expected.fileId,
        businessType: expected.businessType,
        businessId: '100',
        checksumSha256: expected.checksumSha256,
        createdInThisRun: true,
      }),
    ).resolves.toBe('BOUND');
    expect(queryRunner.tables.stored_file[0]?.binding_status).toBe('BOUND');
    expect(queryRunner.tables.stored_file[0]?.business_id).toBe('100');
    const updateSql = queryRunner.calls.find((call) => /^UPDATE\b/iu.test(call.sql));
    expect(updateSql?.sql).toContain('binding_status');
  });

  it('已正确绑定的行只读复用，不执行更新', async () => {
    const queryRunner = new TableQueryRunner({
      stored_file: [storedFileRow({ binding_status: 'BOUND', business_id: '100' })],
    });
    const context = createContext(queryRunner, root);

    await expect(
      bindStoredFile(context, {
        fileId: expected.fileId,
        businessType: expected.businessType,
        businessId: '100',
        checksumSha256: expected.checksumSha256,
        createdInThisRun: false,
      }),
    ).resolves.toBe('REUSED');
    expect(queryRunner.calls.some((call) => /^UPDATE\b/iu.test(call.sql))).toBe(false);
  });
});

/** 带 WHERE 过滤的内存查询器：用于离线跑完整 p0 链路并核对业务引用漂移。 */
class MemoryQueryRunner implements MockQueryRunner {
  readonly calls: { sql: string; parameters?: readonly unknown[] }[] = [];
  private readonly store = new Map<string, Row[]>();
  private nextId = 5000;

  constructor(seed: Record<string, Row[]>) {
    for (const [table, rows] of Object.entries(seed)) {
      this.store.set(
        table,
        rows.map((row) => ({ ...row })),
      );
    }
  }

  rows(table: string): Row[] {
    let rows = this.store.get(table);
    if (!rows) {
      rows = [];
      this.store.set(table, rows);
    }
    return rows;
  }

  query(sql: string, parameters: readonly unknown[] = []): Promise<unknown> {
    this.calls.push({ sql, parameters });
    const text = sql.trim();
    if (/^INSERT\b/iu.test(text)) return Promise.resolve(this.insert(text, parameters));
    if (/^UPDATE\b/iu.test(text)) return Promise.resolve(this.update(text, parameters));
    if (/^SELECT\b/iu.test(text)) return Promise.resolve(this.select(text, parameters));
    throw new Error(`未支持的离线 SQL: ${text}`);
  }

  private insert(sql: string, parameters: readonly unknown[]): unknown {
    const match = /^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s*\(([^)]*)\)/iu.exec(sql);
    if (!match) throw new Error(`未解析 INSERT: ${sql}`);
    const id = this.nextId++;
    const row: Row = { id };
    match[2]
      .split(',')
      .map((column) => column.trim().replace(/`/gu, ''))
      .forEach((column, index) => {
        row[column] = parameters[index] ?? null;
      });
    this.rows(match[1]).push(row);
    return { insertId: id, affectedRows: 1 };
  }

  private update(sql: string, parameters: readonly unknown[]): unknown {
    const match = /^UPDATE\s+`?([A-Za-z0-9_]+)`?\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/iu.exec(
      sql,
    );
    if (!match) throw new Error(`未解析 UPDATE: ${sql}`);
    const setColumns = match[2]
      .split(',')
      .map((part) => /`?([A-Za-z0-9_]+)`?\s*=/u.exec(part.trim())?.[1] ?? '');
    const setValues = parameters.slice(0, setColumns.length);
    const clauses = this.parseWhere(match[3], parameters.slice(setColumns.length));
    const matched = this.rows(match[1]).filter((row) => this.matches(row, clauses));
    for (const row of matched) {
      setColumns.forEach((column, index) => {
        row[column] = setValues[index] ?? null;
      });
    }
    return { affectedRows: matched.length };
  }

  private select(sql: string, parameters: readonly unknown[]): unknown {
    if (/\bFROM\s+organization_membership\b/iu.test(sql)) {
      const accountId = parameters[0];
      return this.rows('organization_membership').filter(
        (row) => Number(row.account_id) === Number(accountId) && row.status === 'ACTIVE',
      );
    }
    const match = /^SELECT\s+[\s\S]*?\bFROM\s+`?([A-Za-z0-9_]+)`?/iu.exec(sql);
    if (!match) throw new Error(`未解析 SELECT: ${sql}`);
    const where = /\bWHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY\b|\s+LIMIT\b|$)/iu.exec(sql)?.[1];
    let rows = this.rows(match[1]).filter((row) =>
      this.matches(row, where ? this.parseWhere(where, parameters) : []),
    );
    const limit = /\bLIMIT\s+(\d+)/iu.exec(sql)?.[1];
    if (limit) rows = rows.slice(0, Number(limit));
    return rows;
  }

  private parseWhere(
    where: string,
    parameters: readonly unknown[],
  ): { column: string; value: unknown; isNull: boolean }[] {
    let parameterIndex = 0;
    return where.split(/\s+AND\s+/iu).map((raw) => {
      const clause = raw.trim();
      const nullMatch = /^`?([A-Za-z0-9_]+)`?\s+IS\s+NULL$/iu.exec(clause);
      if (nullMatch) return { column: nullMatch[1], value: null, isNull: true };
      const equalMatch = /^`?([A-Za-z0-9_]+)`?\s*=\s*\?$/u.exec(clause);
      if (!equalMatch) throw new Error(`未解析 WHERE 子句: ${clause}`);
      const value = parameters[parameterIndex];
      parameterIndex += 1;
      return { column: equalMatch[1], value, isNull: false };
    });
  }

  private matches(
    row: Row,
    clauses: readonly { column: string; value: unknown; isNull: boolean }[],
  ): boolean {
    return clauses.every((clause) =>
      clause.isNull
        ? row[clause.column] === null || row[clause.column] === undefined
        : row[clause.column] === clause.value,
    );
  }
}

const PACK_ACCOUNT_KEYS = [
  'customer-a',
  'customer-a2',
  'customer-b',
  'engineer-a',
  'engineer-b',
  'admin-l1-a',
  'admin-l2-a',
  'admin-l2-b',
] as const;

function packSeeds(): Record<string, Row[]> {
  const organizationIds: Record<string, number> = { A: 10, B: 11, PLATFORM: 12 };
  const accounts: Row[] = [];
  const infos: Row[] = [];
  const memberships: Row[] = [];
  PACK_ACCOUNT_KEYS.forEach((key, index) => {
    const spec = ACCOUNTS.find((account) => account.key === key);
    if (!spec) throw new Error(`清单缺少 ${key}`);
    const accountId = 100 + index;
    accounts.push({
      id: accountId,
      login_name: spec.loginName,
      login_email: mockEmail(spec.loginName),
      nickname: `${spec.nickname}（预存，不得改写）`,
      status: spec.accountStatus,
      identity_hint: spec.role,
      admin_level: spec.adminLevel,
    });
    infos.push({
      account_id: accountId,
      user_state: spec.userState,
      access_group: JSON.stringify([spec.role]),
      meta_digest: JSON.stringify([spec.role]),
      customer_organization_id:
        spec.profileOrganization === null ? null : organizationIds[spec.profileOrganization],
    });
    if (spec.organization !== null) {
      memberships.push({
        account_id: accountId,
        organization_code:
          spec.organization === 'PLATFORM' ? 'MOCK-V13-PLATFORM' : `MOCK-V13-${spec.organization}`,
        is_managed_company: spec.organization === 'PLATFORM' ? 0 : 1,
        organization_status: 'ACTIVE',
        member_role: spec.role,
        status: 'ACTIVE',
      });
    }
  });
  return {
    base_user_account: accounts,
    base_user_info: infos,
    organization_membership: memberships,
    organization: [
      {
        id: 10,
        organization_code: 'MOCK-V13-A',
        name: '[MOCK-V13] 星港光电（测试 A）',
        kind: 'PEER',
        is_managed_company: 1,
        status: 'ACTIVE',
      },
      {
        id: 11,
        organization_code: 'MOCK-V13-B',
        name: '[MOCK-V13] 远岚微纳（测试 B）',
        kind: 'PEER',
        is_managed_company: 1,
        status: 'ACTIVE',
      },
    ],
    equipment_model: [
      { id: 1, model_code: 'MOCK-V13-MODEL-1', model_name: '机型一', enabled: 1, sort_order: 1 },
      { id: 2, model_code: 'MOCK-V13-MODEL-2', model_name: '机型二', enabled: 1, sort_order: 2 },
    ],
  };
}

function rowText(row: Row | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : '';
}

describe('已有原件的业务引用校验（p0 完整链路离线复验）', () => {
  let root: string;
  let runner: MemoryQueryRunner;
  let context: PackContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-reference-binding-'));
    runner = new MemoryQueryRunner(packSeeds());
    context = createContext(runner, root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function runRepair(): Promise<void> {
    context.report.startPack('p0-repair');
    await runRepairPack(context);
  }

  async function runReports(): Promise<void> {
    context.report.startPack('p0-reports');
    await runReportsPack(context);
  }

  async function runDocuments(): Promise<void> {
    context.report.startPack('p0-documents');
    await runDocumentsPack(context);
  }

  async function runAll(): Promise<void> {
    await runRepair();
    await runReports();
    await runDocuments();
  }

  function writesSince(index: number): { sql: string }[] {
    return runner.calls
      .slice(index)
      .filter((call) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(call.sql));
  }

  it('报修采集 file_id 正向漂移：拒绝复用，异常行与磁盘文件不变', async () => {
    await runRepair();
    const intake = runner
      .rows('repair_request_intake')
      .find((row) => row.record_uuid === mockUuid('intake:a-in-progress'));
    expect(intake).toBeDefined();
    const reference = rowText(intake, 'file_id');
    expect(reference).not.toBe('');
    const diskPath = path.join(root, 'files', 'intake-a-in-progress.png');
    const diskBefore = fs.readFileSync(diskPath);
    intake!.file_id = 'drifted-file-id';
    const snapshot = { ...intake };

    const index = runner.calls.length;
    context.report.startPack('p0-repair');
    await expect(runRepairPack(context)).rejects.toBeInstanceOf(MockConflictError);

    expect(intake).toEqual(snapshot);
    expect(writesSince(index)).toEqual([]);
    expect(fs.readFileSync(diskPath)).toEqual(diskBefore);
  });

  it('stored_file 反向绑定漂移：拒绝复用，绑定值与磁盘文件不变', async () => {
    await runRepair();
    const stored = runner
      .rows('stored_file')
      .find((row) => row.file_id === mockUuid('stored-file:intake:a-in-progress'));
    expect(stored).toBeDefined();
    expect(stored?.binding_status).toBe('BOUND');
    stored!.business_id = 'drifted-business-id';
    const snapshot = { ...stored };
    const diskPath = path.join(root, 'files', 'intake-a-in-progress.png');
    const diskBefore = fs.readFileSync(diskPath);

    const index = runner.calls.length;
    context.report.startPack('p0-repair');
    await expect(runRepairPack(context)).rejects.toBeInstanceOf(MockConflictError);

    expect(stored).toEqual(snapshot);
    expect(writesSince(index)).toEqual([]);
    expect(fs.readFileSync(diskPath)).toEqual(diskBefore);
  });

  it('报告附件 storage_reference 漂移到另一个存在文件：拒绝覆盖，业务行与磁盘不变', async () => {
    await runRepair();
    await runReports();
    const attachment = runner.rows('maintenance_report_attachment')[0];
    expect(attachment).toBeDefined();
    const expectedPath = path.join(root, 'report-attachments', 'draft-b.png');
    const otherPath = path.join(root, 'report-attachments', 'other-existing.png');
    const expectedBefore = fs.readFileSync(expectedPath);
    fs.writeFileSync(otherPath, expectedBefore);
    attachment.storage_reference = 'report-attachments/other-existing.png';
    const snapshot = { ...attachment };

    const index = runner.calls.length;
    context.report.startPack('p0-reports');
    await expect(runReportsPack(context)).rejects.toBeInstanceOf(MockConflictError);

    expect(attachment).toEqual(snapshot);
    expect(writesSince(index)).toEqual([]);
    expect(fs.readFileSync(expectedPath)).toEqual(expectedBefore);
    expect(fs.readFileSync(otherPath)).toEqual(expectedBefore);
  });

  it('参考资料业务引用漂移到另一个存在文件：拒绝复用，业务行与磁盘不变', async () => {
    await runAll();
    const document = runner
      .rows('reference_document')
      .find((row) => row.storage_backend === 'LOCAL');
    expect(document).toBeDefined();
    const expectedReference = rowText(document, 'storage_reference');
    const expectedPath = path.join(root, 'reference', expectedReference);
    const otherPath = path.join(root, 'reference', 'other-existing.txt');
    const expectedBefore = fs.readFileSync(expectedPath);
    fs.writeFileSync(otherPath, expectedBefore);
    document!.storage_reference = 'other-existing.txt';
    const snapshot = { ...document };

    const index = runner.calls.length;
    context.report.startPack('p0-documents');
    await expect(runDocumentsPack(context)).rejects.toBeInstanceOf(MockConflictError);

    expect(document).toEqual(snapshot);
    expect(writesSince(index)).toEqual([]);
    expect(fs.readFileSync(expectedPath)).toEqual(expectedBefore);
    expect(fs.readFileSync(otherPath)).toEqual(expectedBefore);
  });

  it('首次生成正常，健康重跑只读复用（p0-repair/p0-reports/p0-documents）', async () => {
    await runAll();
    const firstRunWrites = writesSince(0);
    expect(firstRunWrites.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'files', 'intake-a-in-progress.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'report-attachments', 'draft-b.png'))).toBe(true);
    const material = runner
      .rows('reference_document')
      .find((row) => row.storage_backend === 'LOCAL');
    expect(material).toBeDefined();
    expect(
      fs.existsSync(path.join(root, 'reference', rowText(material, 'storage_reference'))),
    ).toBe(true);

    for (const [pack, run] of [
      ['p0-repair', runRepair],
      ['p0-reports', runReports],
      ['p0-documents', runDocuments],
    ] as const) {
      const index = runner.calls.length;
      context.report.startPack(pack);
      await run();
      expect(writesSince(index)).toEqual([]);
    }
  });
});
