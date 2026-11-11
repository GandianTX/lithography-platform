/**
 * D3 实库约束与事务专项（默认跳过）。
 *
 * 启用条件（缺一不可）：
 * - D3_CONSTRAINT_SPECS=1
 * - D3_CONFIG_FILE 指向库外 0600 部署配置，且其中 DB_NAME 与目标库一致
 * - D3_ALLOWED_DB_NAMES 必须是单一目标库名（不允许逗号多目标）
 * - D3_EXPECTED_SERVER_UUID 等于授权实例
 * - D3_ALLOW_PHYSICAL_CLEANUP=1（仅用于夹具防御性回收）
 * - 若回滚失败产生兜底账本，还需 E2E_ALLOW_PHYSICAL_CLEANUP=1 才允许受保护账本删除
 *
 * 所有夹具写入都在单个事务内完成，结束后统一回滚，因此正常情况下零残留；
 * 夹具 INSERT 成功后立即按真实自增 ID 登记归属事实；碰撞失败不登记、不认领既有行。
 * 只有回滚失败且无法确认连接已销毁时，才把本轮账本合并到套件兜底账本，
 * 由受保护账本入口按 ID 与事实核验删除，绝不按登录名/公司编码直接删除。
 * 交付账号不会被读取或修改。
 */
import * as fs from 'fs';

import type { DataSource, EntityManager } from 'typeorm';

import { hashPasswordWithTimestamp } from '../../core/account/policy/password-hashing.policy';
import {
  createOwnedResourceLedger,
  mergeOwnedResourceLedger,
  recordOwnedResource,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
} from '../../../test/utils/e2e-scoped-cleanup';
import { runGuardedQueryRunnerTransaction } from '../../../test/utils/e2e-owned-fixture';
import { createFieldCipher } from '../field-encryption/field-encryption.cipher';
import { applyAdminBootstrap, parseAdminBootstrapConfig } from './admin-bootstrap';
import { assertBootstrapPassword } from './bootstrap-password';
import { parseDeployCliArgs } from './database-deploy';
import {
  applyDevAccountBootstrap,
  assertDevAccountTargetDatabase,
  parseDevAccountBootstrapConfig,
} from './dev-account-bootstrap';
import {
  type MigrationDbConfig,
  createMigrationDataSource,
  loadExplicitEnvConfig,
} from './incremental-migration';
import {
  applyOrganizationBootstrap,
  parseOrganizationBootstrapConfig,
} from './organization-bootstrap';

const ENABLED = process.env.D3_CONSTRAINT_SPECS === '1';
const FIXTURE_PASSWORD = 'D3c!Fixture9Pass';
const MARKER = 'd3c-fixture';

export interface D3Target {
  readonly configFile: string;
  readonly database: string;
  readonly serverUuid: string;
}

/**
 * 解析 D3 显式目标参数；缺任一参数或多目标白名单时直接拒绝，不回退默认库。
 */
export const resolveD3Target = (env: NodeJS.ProcessEnv): D3Target => {
  if (env.D3_CONSTRAINT_SPECS !== '1') {
    throw new Error('D3 拒绝执行：缺少 D3_CONSTRAINT_SPECS=1');
  }
  const configFile = (env.D3_CONFIG_FILE ?? '').trim();
  if (configFile.length === 0) {
    throw new Error('D3 拒绝执行：缺少 D3_CONFIG_FILE');
  }
  const database = (env.D3_ALLOWED_DB_NAMES ?? '').trim().toLowerCase();
  if (database.length === 0) {
    throw new Error('D3 拒绝执行：缺少 D3_ALLOWED_DB_NAMES');
  }
  if (database.includes(',')) {
    throw new Error('D3 拒绝执行：D3_ALLOWED_DB_NAMES 必须是单一目标库');
  }
  const serverUuid = (env.D3_EXPECTED_SERVER_UUID ?? '').trim();
  if (serverUuid.length === 0) {
    throw new Error('D3 拒绝执行：缺少 D3_EXPECTED_SERVER_UUID');
  }
  if (env.D3_ALLOW_PHYSICAL_CLEANUP !== '1') {
    throw new Error('D3 拒绝执行：缺少 D3_ALLOW_PHYSICAL_CLEANUP=1');
  }
  return { configFile, database, serverUuid };
};

/** 写入前核验实际 DATABASE() 与实例 UUID；任一不一致即拒绝。 */
export const assertD3ActualTarget = (
  target: D3Target,
  actual: { readonly database: string; readonly serverUuid: string },
): void => {
  if (actual.database.trim().toLowerCase() !== target.database) {
    throw new Error(
      `D3 拒绝执行：实际 DATABASE()=${actual.database}，与单目标白名单 ${target.database} 不一致`,
    );
  }
  if (actual.serverUuid.trim() !== target.serverUuid) {
    throw new Error(
      `D3 拒绝执行：实际 server_uuid=${actual.serverUuid}，与 D3_EXPECTED_SERVER_UUID=${target.serverUuid} 不一致`,
    );
  }
};

const TARGET = ENABLED ? resolveD3Target(process.env) : null;

const requireTarget = (): D3Target => {
  if (!TARGET) {
    throw new Error('D3 未启用，拒绝读取目标参数');
  }
  return TARGET;
};

const describeDb = ENABLED ? describe : describe.skip;

interface SeededAccount {
  readonly accountId: number;
  readonly organizationId: number;
}

describeDb('D3 实库约束与事务专项', () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let cipher: ReturnType<typeof createFieldCipher>;
  let encryption: { fieldEncryptionKey: string; fieldEncryptionIv: string };
  let raw: import('mysql2/promise').Connection;
  let baselineInstallationId: string;

  // 用例账本：INSERT 成功后立即按真实 ID 登记；回滚成功即丢弃。
  let testLedger: OwnedResourceLedger = createOwnedResourceLedger();
  // 兜底账本：只在回滚失败且无法确认事务已结束时合并，供受保护清理入口使用。
  const cleanupLedger: OwnedResourceLedger = createOwnedResourceLedger();

  const readInsertId = (result: unknown): number => {
    const header = Array.isArray(result) ? result[0] : result;
    const insertId = Number((header as { insertId?: unknown } | null)?.insertId);
    if (!Number.isInteger(insertId) || insertId <= 0) {
      throw new Error('INSERT 未返回真实自增 ID，拒绝登记或认领既有记录');
    }
    return insertId;
  };

  const orgConfig = (input: ReadonlyArray<Record<string, unknown>>): string =>
    JSON.stringify({ schema_version: 1, organizations: input });

  const adminConfig = (accounts: ReadonlyArray<Record<string, unknown>>): string =>
    JSON.stringify({ schema_version: 1, accounts });

  const devConfig = (
    customers: ReadonlyArray<Record<string, unknown>>,
    engineers: ReadonlyArray<Record<string, unknown>>,
  ): string => JSON.stringify({ schema_version: 1, customers, engineers });

  const clientOrg = {
    organization_code: 'D3C-FIXTURE-CLIENT',
    name: 'D3 专项客户公司',
    short_name: 'D3C-CLIENT',
    kind: 'CLIENT',
    is_managed_company: false,
    is_service_provider: false,
    status: 'ACTIVE',
  };
  const peerOrg = {
    organization_code: 'D3C-FIXTURE-PEER',
    name: 'D3 专项受管公司',
    short_name: 'D3C-PEER',
    kind: 'PEER',
    is_managed_company: true,
    is_service_provider: true,
    status: 'ACTIVE',
  };

  async function withTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    let value: T | undefined;
    const outcome = await runGuardedQueryRunnerTransaction({
      createRunner: () => dataSource.createQueryRunner(),
      label: 'D3 事务',
      outcome: 'rollback',
      work: async (runner) => {
        value = await work(runner.manager);
      },
    });
    if (outcome.errors.length > 0) {
      // 只有仍可能残留未回滚写入时才合并兜底账本；已销毁连接时服务端会终止事务。
      if (outcome.residualPossible) {
        mergeOwnedResourceLedger(cleanupLedger, testLedger);
      }
      testLedger = createOwnedResourceLedger();
      throw new Error(outcome.errors.join('；'));
    }
    // 回滚成功：夹具行已不存在，账本不进入物理清理。
    testLedger = createOwnedResourceLedger();
    return value as T;
  }

  async function seedOrganization(
    manager: EntityManager,
    entry: Record<string, unknown>,
  ): Promise<number> {
    const code = String(entry.organization_code);
    const result = await manager.query(
      `INSERT INTO organization
         (organization_code, name, short_name, is_service_provider, is_managed_company, kind, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        code,
        String(entry.name),
        entry.short_name === null ? null : (entry.short_name as string),
        entry.is_service_provider === true ? 1 : 0,
        entry.is_managed_company === true ? 1 : 0,
        String(entry.kind),
      ],
    );
    // INSERT 成功后才登记真实 ID 与创建事实；碰撞抛错时不登记、不认领既有行。
    const organizationId = readInsertId(result);
    recordOwnedResource(testLedger, 'organization', organizationId, {
      organizationCode: code,
      name: String(entry.name),
      kind: String(entry.kind),
      status: 'ACTIVE',
    });
    return organizationId;
  }

  async function seedAccount(
    manager: EntityManager,
    input: {
      readonly login: string;
      readonly email: string;
      readonly role: 'SUPER_ADMIN' | 'CUSTOMER' | 'ENGINEER';
      readonly organizationId: number;
      readonly adminLevel: number | null;
      readonly mustChangePassword: 0 | 1;
    },
  ): Promise<SeededAccount> {
    const accountResult = await manager.query(
      `INSERT INTO base_user_account
         (login_name, login_email, login_password, status, identity_hint,
          admin_level, must_change_password)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [
        input.login,
        input.email,
        hashPasswordWithTimestamp(FIXTURE_PASSWORD, new Date()),
        input.role,
        input.adminLevel,
        input.mustChangePassword,
      ],
    );
    const accountId = readInsertId(accountResult);
    recordOwnedResource(testLedger, 'account', accountId, {
      loginName: input.login,
      loginEmail: input.email,
      status: 'ACTIVE',
      identityHint: input.role,
      accessGroup: [input.role],
      nickname: input.login,
      userInfoEmail: null,
      userState: 'ACTIVE',
    });
    const roles = JSON.stringify([input.role]);
    await manager.query(
      `INSERT INTO base_user_info
         (account_id, nickname, user_state, customer_organization_id, access_group, meta_digest)
       VALUES (?, ?, 'ACTIVE', ?, CAST(? AS JSON), ?)`,
      [
        accountId,
        input.login,
        input.role === 'ENGINEER' ? null : input.organizationId,
        roles,
        cipher.encrypt(roles),
      ],
    );
    const membershipResult = await manager.query(
      `INSERT INTO organization_membership
         (organization_id, account_id, member_role, status, left_at)
       VALUES (?, ?, ?, 'ACTIVE', NULL)`,
      [input.organizationId, accountId, input.role],
    );
    recordOwnedResource(testLedger, 'membership', readInsertId(membershipResult), {
      organizationId: input.organizationId,
      accountId,
      memberRole: input.role,
      status: 'ACTIVE',
    });
    return { accountId, organizationId: input.organizationId };
  }

  async function seedBase(manager: EntityManager): Promise<{
    readonly clientId: number;
    readonly peerId: number;
    readonly admin: SeededAccount;
    readonly engineer: SeededAccount;
    readonly customer: SeededAccount;
  }> {
    const clientId = await seedOrganization(manager, clientOrg);
    const peerId = await seedOrganization(manager, peerOrg);
    const admin = await seedAccount(manager, {
      login: `${MARKER}-admin`,
      email: `${MARKER}-admin@example.test`,
      role: 'SUPER_ADMIN',
      organizationId: clientId,
      adminLevel: 1,
      mustChangePassword: 1,
    });
    const engineer = await seedAccount(manager, {
      login: `${MARKER}-engineer`,
      email: `${MARKER}-engineer@example.test`,
      role: 'ENGINEER',
      organizationId: peerId,
      adminLevel: null,
      mustChangePassword: 0,
    });
    const customer = await seedAccount(manager, {
      login: `${MARKER}-customer`,
      email: `${MARKER}-customer@example.test`,
      role: 'CUSTOMER',
      organizationId: clientId,
      adminLevel: null,
      mustChangePassword: 0,
    });
    return { clientId, peerId, admin, engineer, customer };
  }

  beforeAll(async () => {
    if (!ENABLED) return;
    const target = requireTarget();
    expect(fs.existsSync(target.configFile)).toBe(true);
    // 配置内 DB_NAME 必须与单目标白名单一致，否则 loadExplicitEnvConfig 直接拒绝。
    const config: MigrationDbConfig = loadExplicitEnvConfig(target.configFile, target.database);
    expect(config.database).toBe(target.database);

    dataSource = createMigrationDataSource(config);
    await dataSource.initialize();
    const key = config.fieldEncryptionKey;
    const iv = config.fieldEncryptionIv;
    expect(key).toBeTruthy();
    expect(iv).toBeTruthy();
    encryption = { fieldEncryptionKey: String(key), fieldEncryptionIv: String(iv) };
    cipher = createFieldCipher(encryption.fieldEncryptionKey, encryption.fieldEncryptionIv);

    const [uuid] = (await dataSource.query(
      'SELECT @@server_uuid AS server_uuid, DATABASE() AS db',
    )) as unknown as Array<{ server_uuid: string; db: string }>;
    assertD3ActualTarget(target, { database: uuid.db, serverUuid: uuid.server_uuid });

    const mysql = await import('mysql2/promise');
    raw = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
    });
    const [installation] = (await raw.query(
      'SELECT installation_id FROM local_installation ORDER BY id LIMIT 1',
    )) as unknown as Array<Array<{ installation_id: string }>>;
    baselineInstallationId = installation[0].installation_id;
  });

  afterAll(async () => {
    if (!ENABLED) return;
    const diagnostics: Error[] = [];

    // 正常路径全部事务回滚，兜底账本为空，零 DELETE。
    // 只有回滚失败且连接销毁无法确认时才可能非空，此时走受保护账本入口：
    // 先核验真实 ID 与归属事实，再按子表→父表删除，任一失败整批回滚。
    const hasCleanupLedgerEntries =
      cleanupLedger.organizationIds.length > 0 ||
      cleanupLedger.accountIds.length > 0 ||
      cleanupLedger.membershipIds.length > 0 ||
      cleanupLedger.engineerRegistrationApplicationIds.length > 0;
    if (hasCleanupLedgerEntries) {
      try {
        await runGuardedSpecCleanup({
          dataSource,
          helper: 'v13-d3-constraint-suite',
          owned: cleanupLedger,
          expectedDatabase: requireTarget().database,
        });
      } catch (error) {
        diagnostics.push(new Error('D3 兜底账本回收失败', { cause: error }));
      }
    }

    if (raw) {
      try {
        const [residue] = (await raw.query(
          `SELECT
             (SELECT COUNT(*) FROM base_user_account WHERE login_name LIKE 'd3c-%') AS accounts,
             (SELECT COUNT(*) FROM organization WHERE organization_code LIKE 'D3C-%') AS organizations`,
        )) as unknown as Array<Array<{ accounts: number; organizations: number }>>;
        if (Number(residue[0].accounts) > 0 || Number(residue[0].organizations) > 0) {
          diagnostics.push(
            new Error(
              `D3 只读残留核对失败：accounts=${residue[0].accounts}, organizations=${residue[0].organizations}`,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(new Error('D3 只读残留核对失败', { cause: error }));
      }
      try {
        await raw.end();
      } catch (error) {
        diagnostics.push(new Error('D3 只读连接关闭失败', { cause: error }));
      }
    }

    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy();
      } catch (error) {
        diagnostics.push(new Error('D3 DataSource 关闭失败', { cause: error }));
      }
    }

    if (diagnostics.length > 0) {
      throw new AggregateError(diagnostics, 'D3 收尾存在未关闭错误');
    }
  });

  it('生成列实际表达式与四类计算语义', async () => {
    await withTransaction(async (manager) => {
      const { clientId, peerId, admin, engineer } = await seedBase(manager);

      const columns = (await manager.query(
        `SELECT table_name AS t, column_name AS c, generation_expression AS gen, extra AS ex
           FROM information_schema.columns
          WHERE table_schema = ? AND generation_expression <> ''
          ORDER BY table_name, column_name`,
        [requireTarget().database],
      )) as unknown as Array<{ t: string; c: string; gen: string; ex: string }>;
      expect(columns).toHaveLength(4);
      const expression = (table: string, column: string): string =>
        columns.find((row) => row.t === table && row.c === column)?.gen ?? '';
      expect(expression('organization_membership', 'active_account_id')).toContain('ACTIVE');
      expect(expression('maintenance_report_attachment', 'active_sort_order')).toContain('CURRENT');
      expect(expression('local_backup_run', 'active_installation_id')).toContain('RUNNING');
      expect(expression('engineer_registration_application', 'pending_account_id')).toContain(
        'PENDING',
      );
      for (const row of columns) {
        expect(row.ex).toContain('STORED GENERATED');
      }

      const [membership] = (await manager.query(
        'SELECT active_account_id FROM organization_membership WHERE account_id = ?',
        [engineer.accountId],
      )) as unknown as Array<{ active_account_id: number }>;
      expect(Number(membership.active_account_id)).toBe(engineer.accountId);
      await expect(
        manager.query(
          `INSERT INTO organization_membership
             (organization_id, account_id, member_role, status, left_at)
           VALUES (?, ?, 'ENGINEER', 'ACTIVE', NULL)`,
          [clientId, engineer.accountId],
        ),
      ).rejects.toThrow(/ER_DUP_ENTRY|Duplicate entry/);
      await manager.query(
        `UPDATE organization_membership SET status = 'LEFT', left_at = NOW(3)
          WHERE account_id = ? AND organization_id = ?`,
        [engineer.accountId, peerId],
      );
      const [left] = (await manager.query(
        'SELECT active_account_id FROM organization_membership WHERE account_id = ?',
        [engineer.accountId],
      )) as unknown as Array<{ active_account_id: number | null }>;
      expect(left.active_account_id).toBeNull();
      await manager.query(
        `INSERT INTO organization_membership
           (organization_id, account_id, member_role, status, left_at)
         VALUES (?, ?, 'ENGINEER', 'ACTIVE', NULL)`,
        [clientId, engineer.accountId],
      );

      await manager.query(
        `INSERT INTO maintenance_report
           (owner_organization_id, source_type, maintenance_engineer_account_id,
            maintenance_engineer_name_snapshot, created_by_account_id, updated_by_account_id)
         VALUES (?, 'HISTORICAL_CASE', ?, 'fixture', ?, ?)`,
        [clientId, admin.accountId, admin.accountId, admin.accountId],
      );
      // maintenance_report / maintenance_report_attachment / local_backup_run 不在受保护
      // 账本支持范围；它们只存在于本用例同一未提交事务，回滚失败时独占连接会被销毁，
      // 服务端随连接终止回滚，不提供按名称删除路径。
      const [report] = (await manager.query(
        'SELECT id FROM maintenance_report WHERE created_by_account_id = ? ORDER BY id DESC LIMIT 1',
        [admin.accountId],
      )) as unknown as Array<{ id: number }>;
      const attachment = [
        report.id,
        `${MARKER}.txt`,
        'text/plain',
        3,
        'LOCAL',
        `fixture/${MARKER}.txt`,
        1,
        admin.accountId,
      ];
      await manager.query(
        `INSERT INTO maintenance_report_attachment
           (report_id, original_filename, mime_type, byte_size, storage_backend,
            storage_reference, sort_order, status, uploaded_by_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)`,
        attachment,
      );
      const [slot] = (await manager.query(
        'SELECT active_sort_order FROM maintenance_report_attachment WHERE report_id = ?',
        [report.id],
      )) as unknown as Array<{ active_sort_order: number }>;
      expect(Number(slot.active_sort_order)).toBe(1);
      await expect(
        manager.query(
          `INSERT INTO maintenance_report_attachment
             (report_id, original_filename, mime_type, byte_size, storage_backend,
              storage_reference, sort_order, status, uploaded_by_account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)`,
          attachment,
        ),
      ).rejects.toThrow(/ER_DUP_ENTRY|Duplicate entry/);
      await manager.query(
        `UPDATE maintenance_report_attachment SET status = 'RETIRED', retired_at = NOW(3)
          WHERE report_id = ?`,
        [report.id],
      );
      await manager.query(
        `INSERT INTO maintenance_report_attachment
           (report_id, original_filename, mime_type, byte_size, storage_backend,
            storage_reference, sort_order, status, uploaded_by_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)`,
        attachment,
      );

      await manager.query(
        `INSERT INTO local_backup_run
           (installation_id, trigger_type, status, started_at, organization_id)
         VALUES (?, 'MANUAL', 'RUNNING', NOW(3), ?)`,
        [baselineInstallationId, clientId],
      );
      const [run] = (await manager.query(
        'SELECT active_installation_id FROM local_backup_run WHERE organization_id = ?',
        [clientId],
      )) as unknown as Array<{ active_installation_id: string }>;
      expect(run.active_installation_id).toBe(baselineInstallationId);
      await expect(
        manager.query(
          `INSERT INTO local_backup_run
             (installation_id, trigger_type, status, started_at, organization_id)
           VALUES (?, 'MANUAL', 'RUNNING', NOW(3), ?)`,
          [baselineInstallationId, clientId],
        ),
      ).rejects.toThrow(/ER_DUP_ENTRY|Duplicate entry/);
      await manager.query(
        `UPDATE local_backup_run SET status = 'SUCCEEDED', finished_at = NOW(3)
          WHERE organization_id = ?`,
        [clientId],
      );
      await manager.query(
        `INSERT INTO local_backup_run
           (installation_id, trigger_type, status, started_at, organization_id)
         VALUES (?, 'MANUAL', 'RUNNING', NOW(3), ?)`,
        [baselineInstallationId, clientId],
      );

      const applicationResult = await manager.query(
        `INSERT INTO engineer_registration_application
           (account_id, organization_id, status, submitted_at)
         VALUES (?, ?, 'PENDING', NOW(3))`,
        [engineer.accountId, peerId],
      );
      recordOwnedResource(
        testLedger,
        'engineerRegistrationApplication',
        readInsertId(applicationResult),
        { accountId: engineer.accountId, organizationId: peerId, applicationNote: null },
      );
      const [application] = (await manager.query(
        'SELECT pending_account_id FROM engineer_registration_application WHERE account_id = ?',
        [engineer.accountId],
      )) as unknown as Array<{ pending_account_id: number }>;
      expect(Number(application.pending_account_id)).toBe(engineer.accountId);
      await expect(
        manager.query(
          `INSERT INTO engineer_registration_application
             (account_id, organization_id, status, submitted_at)
           VALUES (?, ?, 'PENDING', NOW(3))`,
          [engineer.accountId, clientId],
        ),
      ).rejects.toThrow(/ER_DUP_ENTRY|Duplicate entry/);
      await manager.query(
        `UPDATE engineer_registration_application
            SET status = 'APPROVED', reviewed_by_account_id = ?, reviewed_at = NOW(3)
          WHERE account_id = ?`,
        [admin.accountId, engineer.accountId],
      );
      const [notPending] = (await manager.query(
        'SELECT pending_account_id FROM engineer_registration_application WHERE account_id = ?',
        [engineer.accountId],
      )) as unknown as Array<{ pending_account_id: number | null }>;
      expect(notPending.pending_account_id).toBeNull();
      const finalApplicationResult = await manager.query(
        `INSERT INTO engineer_registration_application
           (account_id, organization_id, status, submitted_at)
         VALUES (?, ?, 'PENDING', NOW(3))`,
        [engineer.accountId, clientId],
      );
      recordOwnedResource(
        testLedger,
        'engineerRegistrationApplication',
        readInsertId(finalApplicationResult),
        { accountId: engineer.accountId, organizationId: clientId, applicationNote: null },
      );
    });
  });

  it('SQL NULL 与 JSON null、非法枚举/状态/等级、唯一与外键/RESTRICT', async () => {
    await withTransaction(async (manager) => {
      const { clientId, admin, customer } = await seedBase(manager);

      const [sqlNull] = (await manager.query(
        `SELECT tags IS NULL AS is_null, JSON_TYPE(tags) AS json_type
           FROM base_user_info WHERE account_id = ?`,
        [customer.accountId],
      )) as unknown as Array<{ is_null: number; json_type: string | null }>;
      expect(Number(sqlNull.is_null)).toBe(1);
      expect(sqlNull.json_type).toBeNull();
      await manager.query(
        "UPDATE base_user_info SET tags = CAST('null' AS JSON) WHERE account_id = ?",
        [customer.accountId],
      );
      const [tagNull] = (await manager.query(
        `SELECT tags IS NULL AS is_null, JSON_TYPE(tags) AS json_type
           FROM base_user_info WHERE account_id = ?`,
        [customer.accountId],
      )) as unknown as Array<{ is_null: number; json_type: string | null }>;
      expect(Number(tagNull.is_null)).toBe(0);
      expect(String(tagNull.json_type).toUpperCase()).toBe('NULL');
      await manager.query(
        `UPDATE base_user_info SET access_group = CAST('null' AS JSON)
                            WHERE account_id = ?`,
        [customer.accountId],
      );
      const [jsonNull] = (await manager.query(
        `SELECT access_group IS NULL AS is_null, JSON_TYPE(access_group) AS json_type
           FROM base_user_info WHERE account_id = ?`,
        [customer.accountId],
      )) as unknown as Array<{ is_null: number; json_type: string | null }>;
      expect(Number(jsonNull.is_null)).toBe(0);
      expect(String(jsonNull.json_type).toUpperCase()).toBe('NULL');

      await expect(
        manager.query(
          `INSERT INTO base_user_account
             (login_name, login_email, login_password, status, must_change_password)
           VALUES (?, ?, 'x', 'NOT_A_STATUS', 0)`,
          [`${MARKER}-bad-status`, `${MARKER}-bad-status@example.test`],
        ),
      ).rejects.toThrow(/Data truncated|ER_|WARN/);
      await expect(
        manager.query(
          `INSERT INTO base_user_account
             (login_name, login_email, login_password, status, admin_level, must_change_password)
           VALUES (?, ?, 'x', 'ACTIVE', 3, 0)`,
          [`${MARKER}-bad-level`, `${MARKER}-bad-level@example.test`],
        ),
      ).rejects.toThrow(/ER_CHECK_CONSTRAINT|Check constraint|3819/);
      await expect(
        manager.query(
          `INSERT INTO organization_membership
             (organization_id, account_id, member_role, status, left_at)
           VALUES (?, ?, 'ENGINEER', 'ACTIVE', NOW(3))`,
          [clientId, admin.accountId],
        ),
      ).rejects.toThrow(/ER_CHECK_CONSTRAINT|Check constraint|3819/);
      await expect(
        manager.query(
          `INSERT INTO organization_membership
             (organization_id, account_id, member_role, status, left_at)
           VALUES (?, ?, 'OWNER', 'ACTIVE', NULL)`,
          [clientId, admin.accountId],
        ),
      ).rejects.toThrow(/ER_CHECK_CONSTRAINT|Check constraint|3819/);

      await expect(
        manager.query(
          `INSERT INTO base_user_account
             (login_name, login_email, login_password, status, must_change_password)
           VALUES (?, ?, 'x', 'ACTIVE', 0)`,
          [`${MARKER}-customer`, `${MARKER}-dup-login@example.test`],
        ),
      ).rejects.toThrow(/ER_DUP_ENTRY|Duplicate entry/);
      await expect(
        manager.query(
          `INSERT INTO base_user_account
             (login_name, login_email, login_password, status, must_change_password)
           VALUES (?, ?, 'x', 'ACTIVE', 0)`,
          [`${MARKER}-dup-email`, `${MARKER}-customer@example.test`],
        ),
      ).rejects.toThrow(/ER_DUP_ENTRY|Duplicate entry/);

      await expect(
        manager.query(
          `INSERT INTO organization_membership
             (organization_id, account_id, member_role, status, left_at)
           VALUES (999999, ?, 'CUSTOMER', 'ACTIVE', NULL)`,
          [admin.accountId],
        ),
      ).rejects.toThrow(/ER_NO_REFERENCED_ROW_2|foreign key constraint|1452/);
      await expect(
        manager.query(
          'UPDATE base_user_info SET customer_organization_id = 999999 WHERE account_id = ?',
          [customer.accountId],
        ),
      ).rejects.toThrow(/ER_NO_REFERENCED_ROW_2|foreign key constraint|1452/);

      await expect(
        manager.query('DELETE FROM organization WHERE id = ?', [clientId]),
      ).rejects.toThrow(/ER_ROW_IS_REFERENCED_2|foreign key constraint|1451/);
      await expect(
        manager.query('DELETE FROM base_user_account WHERE id = ?', [admin.accountId]),
      ).rejects.toThrow(/ER_ROW_IS_REFERENCED_2|foreign key constraint|1451/);
    });
  });

  it('初始化事务失败不留部分新增，密码与目标库在写入前拒绝', async () => {
    // 纯解析/守卫：不连接任何数据库。
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=/tmp/d3.env',
        '--database=lithography_v13_delivery_dev',
        '--confirm-database=lithography_v13_delivery_dev',
        '--admin-bootstrap-file=/tmp/admin.json',
      ]),
    ).toThrow(/APPLY-ADMIN-BOOTSTRAP/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=/tmp/d3.env',
        '--database=lithography_v13_delivery_dev',
        '--confirm-database=lithography_v13_delivery_dev',
        '--dev-accounts-file=/tmp/dev.json',
      ]),
    ).toThrow(/APPLY-DEV-ACCOUNTS/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=/tmp/d3.env',
        '--database=lithography_v13_delivery_dev',
        '--confirm-database=lithography_v13_delivery_dev',
        '--organization-bootstrap-file=/tmp/org.json',
      ]),
    ).toThrow(/APPLY-ORGANIZATION-BOOTSTRAP/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=/tmp/d3.env',
        '--database=lithography_v13_delivery_dev',
        '--confirm-database=lithography_v13_delivery_dev',
        '--admin-bootstrap-file=/tmp/admin.json',
        '--confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP',
      ]),
    ).toThrow(/只允许在 init 模式/);
    expect(() => assertDevAccountTargetDatabase('lithography_production')).toThrow(
      /test|dev|local|drill/,
    );
    // 交付目标库名必须含 test/dev/local/drill，才能通过开发账号安全门（门本身不改）。
    expect(() => assertDevAccountTargetDatabase(requireTarget().database)).not.toThrow();
    expect(() => assertBootstrapPassword('fixture', 'password123')).toThrow(/策略|密码/);

    const rollbackLogin = `${MARKER}-rollback-admin`;
    const badConfig = adminConfig([
      {
        login_name: rollbackLogin,
        login_email: `${MARKER}-rollback@example.test`,
        password: 'Zq4!Rt8#Wm2pX',
        admin_level: 1,
        organization_code: String(clientOrg.organization_code),
        nickname: 'rollback',
      },
      {
        login_name: `${MARKER}-rollback-admin-2`,
        login_email: `${MARKER}-rollback-2@example.test`,
        password: 'Zq4!Rt8#Wm2pX',
        admin_level: 1,
        organization_code: 'D3C-MISSING-ORGANIZATION',
        nickname: 'rollback2',
      },
    ]);
    await expect(
      withTransaction(async (manager) => {
        await applyOrganizationBootstrap(
          manager,
          parseOrganizationBootstrapConfig(orgConfig([clientOrg])),
        );
        await applyAdminBootstrap(
          dataSource,
          parseAdminBootstrapConfig(badConfig),
          encryption,
          manager,
        );
      }),
    ).rejects.toThrow();
    const [partial] = (await raw.query(
      'SELECT COUNT(*) AS c FROM base_user_account WHERE login_name = ?',
      [rollbackLogin],
    )) as unknown as Array<Array<{ c: number }>>;
    expect(Number(partial[0].c)).toBe(0);

    // 弱密码在事务写入前拒绝，不产生账号。
    const weakLogin = `${MARKER}-weak`;
    await expect(
      withTransaction(async (manager) => {
        await applyOrganizationBootstrap(
          manager,
          parseOrganizationBootstrapConfig(orgConfig([clientOrg])),
        );
        await applyAdminBootstrap(
          dataSource,
          parseAdminBootstrapConfig(
            adminConfig([
              {
                login_name: weakLogin,
                login_email: `${MARKER}-weak@example.test`,
                password: 'password123',
                admin_level: 1,
                organization_code: String(clientOrg.organization_code),
                nickname: 'weak',
              },
            ]),
          ),
          encryption,
          manager,
        );
      }),
    ).rejects.toThrow(/策略|密码/);

    // 等级冲突：已有 1 级账号不能被映射为 2 级。
    await expect(
      withTransaction(async (manager) => {
        const clientId = await seedOrganization(manager, clientOrg);
        await seedOrganization(manager, peerOrg);
        await seedAccount(manager, {
          login: `${MARKER}-level`,
          email: `${MARKER}-level@example.test`,
          role: 'SUPER_ADMIN',
          organizationId: clientId,
          adminLevel: 1,
          mustChangePassword: 1,
        });
        await applyAdminBootstrap(
          dataSource,
          parseAdminBootstrapConfig(
            adminConfig([
              {
                login_name: `${MARKER}-level`,
                login_email: `${MARKER}-level@example.test`,
                password: 'Zq4!Rt8#Wm2pX',
                admin_level: 2,
                organization_code: String(peerOrg.organization_code),
                nickname: 'level',
              },
            ]),
          ),
          encryption,
          manager,
        );
      }),
    ).rejects.toThrow(/等级|admin_level/);

    // 组织类别冲突：编码相同但 kind 不同，失败关闭且不覆盖。
    await expect(
      withTransaction(async (manager) => {
        await applyOrganizationBootstrap(
          manager,
          parseOrganizationBootstrapConfig(orgConfig([clientOrg])),
        );
        await applyOrganizationBootstrap(
          manager,
          parseOrganizationBootstrapConfig(
            orgConfig([
              {
                ...clientOrg,
                kind: 'PEER',
                is_managed_company: true,
                is_service_provider: true,
              },
            ]),
          ),
        );
      }),
    ).rejects.toThrow(/kind=CLIENT/);

    // 错误公司：1 级管理员不能绑定受管 PEER 公司。
    await expect(
      withTransaction(async (manager) => {
        await seedOrganization(manager, peerOrg);
        await applyAdminBootstrap(
          dataSource,
          parseAdminBootstrapConfig(
            adminConfig([
              {
                login_name: `${MARKER}-wrong-org`,
                login_email: `${MARKER}-wrong-org@example.test`,
                password: 'Zq4!Rt8#Wm2pX',
                admin_level: 1,
                organization_code: String(peerOrg.organization_code),
                nickname: 'wrong',
              },
            ]),
          ),
          encryption,
          manager,
        );
      }),
    ).rejects.toThrow(/CLIENT|is_managed_company|受管/);

    // 邮箱碰撞：开发账号映射复用一个已存在邮箱，在写入前拒绝。
    await expect(
      withTransaction(async (manager) => {
        const clientId = await seedOrganization(manager, clientOrg);
        await seedAccount(manager, {
          login: `${MARKER}-email-owner`,
          email: `${MARKER}-email-owner@example.test`,
          role: 'CUSTOMER',
          organizationId: clientId,
          adminLevel: null,
          mustChangePassword: 0,
        });
        await applyDevAccountBootstrap(
          manager,
          parseDevAccountBootstrapConfig(
            devConfig(
              [
                {
                  login_name: `${MARKER}-email-new`,
                  login_email: `${MARKER}-email-owner@example.test`,
                  password: 'Zq4!Rt8#Wm2pX',
                  organization_code: String(clientOrg.organization_code),
                  nickname: 'email-new',
                },
              ],
              [],
            ),
          ),
          encryption,
        );
      }),
    ).rejects.toThrow(/邮箱|email|已存在/);
  });

  it('开发账号原子创建：成员资格与改密标志一致', async () => {
    await withTransaction(async (manager) => {
      const clientId = await seedOrganization(manager, clientOrg);
      const peerId = await seedOrganization(manager, peerOrg);
      const results = await applyDevAccountBootstrap(
        manager,
        parseDevAccountBootstrapConfig(
          devConfig(
            [
              {
                login_name: `${MARKER}-dev-customer`,
                login_email: `${MARKER}-dev-customer@example.test`,
                password: 'Zq4!Rt8#Wm2pX',
                organization_code: String(clientOrg.organization_code),
                nickname: 'dev-customer',
              },
            ],
            [
              {
                login_name: `${MARKER}-dev-engineer`,
                login_email: `${MARKER}-dev-engineer@example.test`,
                password: 'Zq4!Rt8#Wm2pX',
                organization_code: String(peerOrg.organization_code),
                nickname: 'dev-engineer',
              },
            ],
          ),
        ),
        encryption,
      );
      expect(results.map((row) => row.outcome)).toEqual(['CREATED', 'CREATED']);
      const rows = (await manager.query(
        `SELECT a.login_name, a.must_change_password, a.admin_level, i.customer_organization_id,
                m.member_role, m.status AS membership_status, m.organization_id
           FROM base_user_account a
           JOIN base_user_info i ON i.account_id = a.id
           JOIN organization_membership m ON m.account_id = a.id
          WHERE a.login_name LIKE 'd3c-fixture-dev-%'
          ORDER BY a.login_name`,
      )) as unknown as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Number(row.must_change_password)).toBe(0);
        expect(row.admin_level).toBeNull();
        expect(row.membership_status).toBe('ACTIVE');
      }
      const customer = rows.find((row) => row.login_name === `${MARKER}-dev-customer`);
      expect(Number(customer?.customer_organization_id)).toBe(clientId);
      expect(customer?.member_role).toBe('CUSTOMER');
      const engineer = rows.find((row) => row.login_name === `${MARKER}-dev-engineer`);
      expect(engineer?.customer_organization_id).toBeNull();
      expect(engineer?.member_role).toBe('ENGINEER');
      expect(Number(engineer?.organization_id)).toBe(peerId);
    });
  });
});

// ---------------------------------------------------------------------------
// 离线目标校验回归（无需数据库 / 不依赖 D3_CONSTRAINT_SPECS）
// ---------------------------------------------------------------------------

describe('D3 目标参数校验（离线）', () => {
  const baseEnv = (): NodeJS.ProcessEnv => ({
    D3_CONSTRAINT_SPECS: '1',
    D3_CONFIG_FILE: '/secure/deploy/d3-delivery.env',
    D3_ALLOWED_DB_NAMES: 'lithography_v13_delivery_dev43',
    D3_EXPECTED_SERVER_UUID: '909f9587-9fce-11f1-a353-00e0709ef3a9',
    D3_ALLOW_PHYSICAL_CLEANUP: '1',
  });

  it('合法显式配置解析为单一目标', () => {
    const target = resolveD3Target(baseEnv());
    expect(target).toEqual({
      configFile: '/secure/deploy/d3-delivery.env',
      database: 'lithography_v13_delivery_dev43',
      serverUuid: '909f9587-9fce-11f1-a353-00e0709ef3a9',
    });
  });

  it('缺少显式许可、配置文件、目标库、实例 UUID 或清理许可时拒绝', () => {
    const cases: Array<[keyof NodeJS.ProcessEnv, string]> = [
      ['D3_CONSTRAINT_SPECS', '缺少 D3_CONSTRAINT_SPECS=1'],
      ['D3_CONFIG_FILE', '缺少 D3_CONFIG_FILE'],
      ['D3_ALLOWED_DB_NAMES', '缺少 D3_ALLOWED_DB_NAMES'],
      ['D3_EXPECTED_SERVER_UUID', '缺少 D3_EXPECTED_SERVER_UUID'],
      ['D3_ALLOW_PHYSICAL_CLEANUP', '缺少 D3_ALLOW_PHYSICAL_CLEANUP=1'],
    ];
    for (const [key, message] of cases) {
      const env = baseEnv();
      delete env[key];
      expect(() => resolveD3Target(env)).toThrow(message);
    }
  });

  it('多目标白名单视为白名单不符并拒绝', () => {
    const env = baseEnv();
    env.D3_ALLOWED_DB_NAMES = 'lithography_v13_delivery_dev43,lithography_e2e';
    expect(() => resolveD3Target(env)).toThrow(/单一目标库/);
  });

  it('实际 DATABASE() 或实例 UUID 不一致时拒绝', () => {
    const target = resolveD3Target(baseEnv());
    expect(() =>
      assertD3ActualTarget(target, {
        database: 'lithography_e2e',
        serverUuid: target.serverUuid,
      }),
    ).toThrow(/实际 DATABASE\(\)/);
    expect(() =>
      assertD3ActualTarget(target, {
        database: target.database,
        serverUuid: '00000000-0000-0000-0000-000000000000',
      }),
    ).toThrow(/实际 server_uuid/);
  });

  it('实际目标与显式配置一致时通过校验', () => {
    const target = resolveD3Target(baseEnv());
    expect(() =>
      assertD3ActualTarget(target, {
        database: target.database.toUpperCase(),
        serverUuid: target.serverUuid,
      }),
    ).not.toThrow();
  });
});
