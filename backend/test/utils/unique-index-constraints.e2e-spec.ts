// test/utils/unique-index-constraints.e2e-spec.ts
//
// 本次新增 RQ（三个 Entity 唯一索引）回归固化：
// 1. Entity 元数据：索引名称、唯一性、属性列序；
// 2. 隔离库物理索引：名称、唯一性、物理列序（只读 information_schema）；
// 3. 六个唯一约束场景：重复 ACTIVE / CURRENT 槽位 / RUNNING 备份被拒绝，历史记录共存。
//
// 边界：
// - 直连隔离库（默认 lithography_e2e），只读结构与事务内写入，不执行 synchronize；
// - 场景 3 在事务内造数并统一回滚，天然零残留；回滚后核对表级行数与标签残留；
// - 不依赖临时脚本，上述断言随规格长期保留。

import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { LocalBackupRunEntity } from '@src/modules/lithography/entities/local-backup-run.entity';
import { MaintenanceReportAttachmentEntity } from '@src/modules/lithography/entities/maintenance-report-attachment.entity';
import { join } from 'path';
import { DataSource, type QueryRunner } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase } from './e2e-db-guard';
import { loadExplicitEnvConfig } from '../../src/infrastructure/database/incremental-migration';

jest.setTimeout(120_000);

const ENV_FILE = 'env/.env.e2e';
const EXPECTED_DATABASE = 'lithography_e2e';
const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const TAG = `UKC_${RUN_TAG}`;

const INDEX_TARGETS = [
  {
    entity: OrganizationMembershipEntity,
    table: 'organization_membership',
    index: 'uk_organization_membership_active_account',
    properties: ['activeAccountId'],
    physicalColumns: ['active_account_id'],
  },
  {
    entity: MaintenanceReportAttachmentEntity,
    table: 'maintenance_report_attachment',
    index: 'uk_maintenance_report_attachment_active_slot',
    properties: ['reportId', 'activeSortOrder'],
    physicalColumns: ['report_id', 'active_sort_order'],
  },
  {
    entity: LocalBackupRunEntity,
    table: 'local_backup_run',
    index: 'uk_local_backup_run_active',
    properties: ['activeInstallationId'],
    physicalColumns: ['active_installation_id'],
  },
] as const;

const COUNTED_TABLES = [
  'organization',
  'base_user_account',
  'organization_membership',
  'maintenance_report',
  'maintenance_report_attachment',
  'local_installation',
  'local_backup_run',
] as const;

describe('唯一索引：元数据、物理结构与六场景约束（e2e）', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const config = loadExplicitEnvConfig(ENV_FILE, EXPECTED_DATABASE);
    dataSource = new DataSource({
      type: 'mysql',
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      timezone: config.timezone,
      charset: config.charset,
      synchronize: false,
      logging: false,
      entities: [join(__dirname, '../../src/modules/**/*.entity.ts')],
    });
    await dataSource.initialize();
    await assertDataSourceOnAllowedE2eDatabase(dataSource, EXPECTED_DATABASE);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('Entity 元数据：三个唯一索引的名称、唯一性与属性列序一致', () => {
    for (const target of INDEX_TARGETS) {
      const metadata = dataSource.getMetadata(target.entity);
      const index = metadata.indices.find((item) => item.name === target.index);
      expect(index).toBeDefined();
      expect(index?.isUnique).toBe(true);
      expect(index?.givenColumnNames).toEqual([...target.properties]);
    }
  });

  it('隔离库物理索引：三个唯一索引的名称、唯一性与物理列序一致', async () => {
    for (const target of INDEX_TARGETS) {
      const rows = await dataSource.query<
        Array<{ INDEX_NAME: string; NON_UNIQUE: number | string; COLUMN_NAME: string }>
      >(
        `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
           FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
          ORDER BY SEQ_IN_INDEX`,
        [target.table, target.index],
      );
      expect(rows).toHaveLength(target.physicalColumns.length);
      expect(rows.every((row) => Number(row.NON_UNIQUE) === 0)).toBe(true);
      expect(rows.every((row) => row.INDEX_NAME === target.index)).toBe(true);
      expect(rows.map((row) => row.COLUMN_NAME)).toEqual([...target.physicalColumns]);
    }
  });

  it('六个唯一约束场景：重复 ACTIVE / CURRENT / RUNNING 拒绝，历史记录按设计共存', async () => {
    const countsBefore = await readTableCounts(dataSource);

    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      try {
        await runMembershipScenario(runner);
        await runAttachmentScenario(runner);
        await runBackupScenario(runner);
      } finally {
        await runner.rollbackTransaction();
      }
    } finally {
      await runner.release();
    }

    const countsAfter = await readTableCounts(dataSource);
    expect(countsAfter).toEqual(countsBefore);

    const residues = await dataSource.query<
      Array<{ organizations: number | string; accounts: number | string }>
    >(
      `SELECT
         (SELECT COUNT(*) FROM organization WHERE organization_code LIKE ?) AS organizations,
         (SELECT COUNT(*) FROM base_user_account WHERE login_name LIKE ?) AS accounts`,
      [`${TAG}%`, `${TAG}%`],
    );
    expect(Number(residues[0]?.organizations)).toBe(0);
    expect(Number(residues[0]?.accounts)).toBe(0);
  });
});

const readTableCounts = async (dataSource: DataSource): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const rows = await dataSource.query<Array<{ total: number | string }>>(
      `SELECT COUNT(*) AS total FROM \`${table}\``,
    );
    counts[table] = Number(rows[0]?.total ?? 0);
  }
  return counts;
};

const expectDuplicateKey = async (
  runner: QueryRunner,
  label: string,
  indexName: string,
  sql: string,
  parameters: unknown[],
): Promise<void> => {
  let caught: { code?: string; sqlMessage?: string } | null = null;
  try {
    await runner.query(sql, parameters);
  } catch (error) {
    caught = error as { code?: string; sqlMessage?: string };
  }
  if (caught === null) {
    throw new Error(`${label} 预期被 ${indexName} 拒绝，但写入成功`);
  }
  expect(caught.code).toBe('ER_DUP_ENTRY');
  expect(caught.sqlMessage).toContain(indexName);
};

const insertOrganization = async (runner: QueryRunner, suffix: string): Promise<number> => {
  const result = (await runner.query(
    'INSERT INTO organization (organization_code, name, kind) VALUES (?, ?, ?)',
    [`${TAG}_${suffix}`, `${TAG} ${suffix}`, 'CLIENT'],
  )) as { insertId: number };
  return result.insertId;
};

const insertAccount = async (runner: QueryRunner, suffix: string): Promise<number> => {
  const result = (await runner.query(
    'INSERT INTO base_user_account (login_name, login_password, status) VALUES (?, ?, ?)',
    [`${TAG}_${suffix}`, 'ukc-fixture', 'ACTIVE'],
  )) as { insertId: number };
  return result.insertId;
};

/** 场景 A：同账号重复 ACTIVE 归属拒绝；LEFT 历史归属共存。 */
const runMembershipScenario = async (runner: QueryRunner): Promise<void> => {
  const organizationA = await insertOrganization(runner, 'ORGA');
  const organizationB = await insertOrganization(runner, 'ORGB');
  const account = await insertAccount(runner, 'ACC');

  await runner.query(
    `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
     VALUES (?, ?, 'ENGINEER', 'ACTIVE')`,
    [organizationA, account],
  );

  await expectDuplicateKey(
    runner,
    '同账号重复 ACTIVE 组织归属',
    'uk_organization_membership_active_account',
    `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
     VALUES (?, ?, 'ENGINEER', 'ACTIVE')`,
    [organizationB, account],
  );

  await runner.query(
    `INSERT INTO organization_membership (organization_id, account_id, member_role, status, left_at)
     VALUES (?, ?, 'ENGINEER', 'LEFT', ?)`,
    [organizationB, account, new Date()],
  );
};

/** 场景 B：同报告重复 CURRENT 槽位拒绝；RETIRED 历史附件与同槽位 CURRENT 共存。 */
const runAttachmentScenario = async (runner: QueryRunner): Promise<void> => {
  const organization = await insertOrganization(runner, 'ORGC');
  const account = await insertAccount(runner, 'ACCC');
  const report = (
    (await runner.query(
      `INSERT INTO maintenance_report
         (owner_organization_id, source_type, maintenance_engineer_account_id,
          maintenance_engineer_name_snapshot, created_by_account_id, updated_by_account_id)
       VALUES (?, 'HISTORICAL_CASE', ?, ?, ?, ?)`,
      [organization, account, TAG, account, account],
    )) as { insertId: number }
  ).insertId;

  const insertAttachment = (sortOrder: number, status: string, retiredAt: Date | null) =>
    runner.query(
      `INSERT INTO maintenance_report_attachment
         (report_id, original_filename, mime_type, byte_size, storage_backend,
          storage_reference, sort_order, status, uploaded_by_account_id, retired_at)
       VALUES (?, ?, 'text/plain', 1, 'LOCAL', ?, ?, ?, ?, ?)`,
      [
        report,
        `${TAG}.txt`,
        `${TAG}/${sortOrder}-${status}`,
        sortOrder,
        status,
        account,
        retiredAt,
      ],
    );

  const current = ((await insertAttachment(1, 'CURRENT', null)) as { insertId: number }).insertId;

  await expectDuplicateKey(
    runner,
    '同报告重复 CURRENT 附件槽位',
    'uk_maintenance_report_attachment_active_slot',
    `INSERT INTO maintenance_report_attachment
       (report_id, original_filename, mime_type, byte_size, storage_backend,
        storage_reference, sort_order, status, uploaded_by_account_id, retired_at)
     VALUES (?, ?, 'text/plain', 1, 'LOCAL', ?, ?, ?, ?, NULL)`,
    [report, `${TAG}-dup.txt`, `${TAG}/dup`, 1, 'CURRENT', account],
  );

  await runner.query(
    "UPDATE maintenance_report_attachment SET status = 'RETIRED', retired_at = ? WHERE id = ?",
    [new Date(), current],
  );
  await insertAttachment(1, 'CURRENT', null);
};

/** 场景 C：同安装实例重复 RUNNING 备份拒绝；终态历史与新一轮 RUNNING 共存。 */
const runBackupScenario = async (runner: QueryRunner): Promise<void> => {
  const installationRows = (await runner.query(
    'SELECT installation_id FROM local_installation WHERE id = 1',
  )) as Array<{ installation_id: string }>;
  let installationId = installationRows[0]?.installation_id;
  if (!installationId) {
    // 共享单行 local_installation 缺失时临时建立，随事务一并回滚。
    installationId = `${TAG}-INSTALLATION`.padEnd(36, '0').slice(0, 36);
    await runner.query(
      'INSERT INTO local_installation (id, installation_id, local_site_name) VALUES (1, ?, ?)',
      [installationId, TAG],
    );
  }
  const installationKey = installationId;

  const insertRun = () =>
    runner.query(
      `INSERT INTO local_backup_run (installation_id, trigger_type, status, started_at, finished_at)
       VALUES (?, 'MANUAL', 'RUNNING', ?, NULL)`,
      [installationKey, new Date()],
    );

  const running = ((await insertRun()) as { insertId: number }).insertId;

  await expectDuplicateKey(
    runner,
    '同安装实例重复 RUNNING 备份',
    'uk_local_backup_run_active',
    `INSERT INTO local_backup_run (installation_id, trigger_type, status, started_at, finished_at)
     VALUES (?, 'MANUAL', 'RUNNING', ?, NULL)`,
    [installationKey, new Date()],
  );

  await runner.query(
    "UPDATE local_backup_run SET status = 'INTERRUPTED', finished_at = ? WHERE id = ?",
    [new Date(), running],
  );
  await insertRun();
};
