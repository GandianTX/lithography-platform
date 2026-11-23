// scripts/task09-isolated-fixture.ts

/**
 * 任务 09 · 一次性隔离库的**环境夹具**（恢复自检等实库链路的准备步骤）。
 *
 * 定位：**环境准备**，不是断言替身。
 * - 断言仍然全部落在生产代码路径（预检／受理／执行／冻结守卫）与真实副作用上；
 * - 本脚本只负责让**一次性隔离库**具备"本公司有真实业务数据、外公司也有数据"
 *   的起点，否则恢复链的"逐项恢复计数非空""外公司哨兵"无从取证。
 *
 * 纪律：
 * - **默认拒绝**：复用与恢复自检同一套安全边界（一次性库、预期实例身份、
 *   一次性库标识、受控文件根、安装／公司标识、测试授权），缺一即零写入退出；
 * - **幂等**：可重复执行，不重复堆积业务行；
 * - 只写**本机隔离库**，不触碰任何保留库或真实业务数据。
 *
 * 用法：见文件头（环境变量与恢复自检完全一致）。
 */

import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
  type DisposableMarkerRow,
} from './task09-restore-selfcheck.safety';

/** 确定性夹具编码（保证幂等与可重复核对） */
const TARGET_REPORT_UUIDS = [
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000a2',
];
const FOREIGN_REPORT_UUIDS = [
  '00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-0000000000b2',
];
const TARGET_INTAKE_UUIDS = [
  '00000000-0000-4000-8000-0000000000c1',
  '00000000-0000-4000-8000-0000000000c2',
];
const FIXTURE_MODEL_CODE = 'ASML-TWINSCAN-NXE-3400C';
/** 一次性一级管理员账号（隔离库专用固定主键，便于幂等与核对） */
const ISOLATION_ADMIN_ACCOUNT_ID = 979_101;
const ISOLATION_ADMIN_MEMBERSHIP_ID = 979_101;

async function main(): Promise<void> {
  const authorization = readSelfcheckAuthorization(process.env);
  const parsed = parseDotenv(readFileSync(authorization.envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
  const config = loadExplicitEnvConfig(authorization.envFile, authorization.database);
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      LoggerModule,
      TypeOrmModule.forRoot({
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
        entities: [join(__dirname, '../src/modules/**/*.entity.ts')],
      }),
    ],
  }).compile();
  const dataSource = moduleRef.get(DataSource);

  try {
    // ── 安全边界复核：一次性库 + 实例身份 + 库标识 ──
    const actualRows: unknown = await dataSource.query(
      'SELECT DATABASE() AS current_database, @@server_uuid AS server_uuid',
    );
    const actual = (actualRows as Array<Record<string, unknown>>)[0] ?? {};
    const options = dataSource.options as { host?: string; port?: number };
    assertServerIdentity(
      {
        database: String(actual['current_database'] ?? ''),
        serverUuid: String(actual['server_uuid'] ?? ''),
        host: String(options.host ?? ''),
        port: Number(options.port ?? 0),
      },
      authorization,
    );
    const markerRows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    const markers: DisposableMarkerRow[] = (markerRows as Array<Record<string, unknown>>).map(
      (row) => ({
        markerKey: String(row['marker_key'] ?? ''),
        markerValue: String(row['marker_value'] ?? ''),
      }),
    );
    assertDisposableMarker(markers, authorization.disposableMarker);

    const installation = await dataSource
      .getRepository(LocalInstallationEntity)
      .findOne({ where: {} });
    if (installation === null) {
      throw new Error('隔离库缺少本机安装身份');
    }
    if (installation.installationId.toLowerCase() !== authorization.installationId) {
      throw new Error('安装标识与声明不一致');
    }
    const targetOrganizationId = authorization.organizationId;

    // ── 本机安装身份的公司映射（迁移基线为空时补上）──
    if (installation.organizationId === null) {
      await dataSource.query('UPDATE local_installation SET organization_id = ? WHERE id = 1', [
        targetOrganizationId,
      ]);
      process.stdout.write(`[fixture] 本机安装身份已映射到公司 ${targetOrganizationId}\n`);
    }

    // ── 外公司（哨兵公司）：取另一个真实组织 ──
    const foreignRows: unknown = await dataSource.query(
      "SELECT id FROM organization WHERE id <> ? AND kind = 'PEER' AND status = 'ACTIVE' ORDER BY id LIMIT 1",
      [targetOrganizationId],
    );
    const foreignOrganizationId = Number((foreignRows as Array<{ id: number }>)[0]?.id ?? 0);
    if (!Number.isInteger(foreignOrganizationId) || foreignOrganizationId <= 0) {
      throw new Error('隔离库缺少可用的外公司（哨兵公司）');
    }

    // ── 账号与机型 ──
    const accountRows: unknown = await dataSource.query(
      'SELECT account_id, member_role FROM organization_membership WHERE organization_id = ? AND status = ?',
      [targetOrganizationId, 'ACTIVE'],
    );
    const memberships = accountRows as Array<{ account_id: number; member_role: string }>;
    const engineerAccountId =
      memberships.find((item) => item.member_role === 'ENGINEER')?.account_id ?? 0;
    const superAdminAccountId =
      memberships.find((item) => item.member_role === 'SUPER_ADMIN')?.account_id ?? 0;
    const foreignAccountRows: unknown = await dataSource.query(
      'SELECT account_id FROM organization_membership WHERE organization_id = ? AND status = ? AND member_role = ? LIMIT 1',
      [foreignOrganizationId, 'ACTIVE', 'ENGINEER'],
    );
    const foreignEngineerAccountId = Number(
      (foreignAccountRows as Array<{ account_id: number }>)[0]?.account_id ?? 0,
    );
    if (engineerAccountId <= 0 || superAdminAccountId <= 0 || foreignEngineerAccountId <= 0) {
      throw new Error('隔离库缺少可用的目标／外公司账号');
    }
    const modelRows: unknown = await dataSource.query(
      'SELECT id FROM equipment_model WHERE model_code = ? LIMIT 1',
      [FIXTURE_MODEL_CODE],
    );
    const equipmentModelId = Number((modelRows as Array<{ id: number }>)[0]?.id ?? 0);
    if (equipmentModelId <= 0) {
      throw new Error(`隔离库缺少机型 ${FIXTURE_MODEL_CODE}`);
    }
    // 客户账号（报修单的客户方）：按登录名解析真实账号，不写死 id
    const customerRows: unknown = await dataSource.query(
      'SELECT id FROM base_user_account WHERE login_name = ? AND status = ? LIMIT 1',
      ['mock_customer_alpha', 'ACTIVE'],
    );
    const customerAccountId = Number((customerRows as Array<{ id: number }>)[0]?.id ?? 0);
    if (customerAccountId <= 0) {
      throw new Error('隔离库缺少可用的客户账号');
    }

    // ── 本公司工单：把已种子的无归属工单归到本公司（幂等）──
    await dataSource.query(
      'UPDATE repair_request SET owner_organization_id = ?, customer_organization_id = ?, service_organization_id = ? ' +
        'WHERE owner_organization_id IS NULL',
      [targetOrganizationId, targetOrganizationId, targetOrganizationId],
    );

    // ── 一次性一级管理员账号（**真实创建**，不写死 id、不复用他人账号）──
    //    恢复链的会话等级由请求期数据库复核（`findAdminLevelByAccountId`），
    //    Seed 的 mock 账号 `admin_level` 为空 ⇒ 必须有真实的一级管理员才能取证。
    await dataSource.query(
      'INSERT INTO base_user_account ' +
        '(id, login_name, login_email, login_password, status, identity_hint, admin_level, ' +
        'must_change_password, credential_version, account_uuid) ' +
        'SELECT ?, ?, ?, ?, ?, ?, 1, 0, 1, ? FROM DUAL ' +
        'WHERE NOT EXISTS (SELECT 1 FROM base_user_account WHERE id = ?)',
      [
        ISOLATION_ADMIN_ACCOUNT_ID,
        'task09_iso_admin_l1',
        'task09-iso-admin@lithography.mock',
        'task09-isolated-admin-placeholder',
        'ACTIVE',
        'SUPER_ADMIN',
        '00000000-0000-4000-8000-0000000000e1',
        ISOLATION_ADMIN_ACCOUNT_ID,
      ],
    );
    await dataSource.query(
      'INSERT INTO base_user_info ' +
        '(id, account_id, nickname, company_name, access_group, user_state, customer_organization_id) ' +
        'SELECT ?, ?, ?, ?, JSON_ARRAY(?), ?, NULL FROM DUAL ' +
        'WHERE NOT EXISTS (SELECT 1 FROM base_user_info WHERE account_id = ?)',
      [
        ISOLATION_ADMIN_ACCOUNT_ID,
        ISOLATION_ADMIN_ACCOUNT_ID,
        '任务09 隔离库一级管理员',
        '任务09 隔离环境',
        'guest',
        'ACTIVE',
        ISOLATION_ADMIN_ACCOUNT_ID,
      ],
    );
    await dataSource.query(
      'INSERT INTO organization_membership ' +
        '(id, organization_id, account_id, member_role, status, joined_at, left_at) ' +
        'SELECT ?, ?, ?, ?, ?, NOW(3), NULL FROM DUAL ' +
        'WHERE NOT EXISTS (SELECT 1 FROM organization_membership WHERE organization_id = ? AND account_id = ?)',
      [
        ISOLATION_ADMIN_MEMBERSHIP_ID,
        targetOrganizationId,
        ISOLATION_ADMIN_ACCOUNT_ID,
        'SUPER_ADMIN',
        'ACTIVE',
        targetOrganizationId,
        ISOLATION_ADMIN_ACCOUNT_ID,
      ],
    );

    // ── 外公司工单：哨兵公司也必须有一行，确保"外公司不被触碰"可证伪 ──
    await dataSource.query(
      'INSERT INTO repair_request ' +
      '(id, request_no, customer_account_id, equipment_model_id, error_code, fault_description, ' +
      'content_md, is_accepted, current_revision_no, maintenance_version_no, deprecated, deleted_at, ' +
      'owner_organization_id, customer_organization_id, service_organization_id, record_uuid) ' +
      'SELECT 979001, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, ?, ? FROM DUAL ' +
      'WHERE NOT EXISTS (SELECT 1 FROM repair_request WHERE id = 979001)',
      [
      'TASK09-FOREIGN-RR-0001',
      customerAccountId,
      equipmentModelId,
      'E-TASK09-FOREIGN',
      '外公司哨兵工单',
      '外公司哨兵工单正文',
      foreignOrganizationId,
      foreignOrganizationId,
      foreignOrganizationId,
      '00000000-0000-4000-8000-0000000000d1',
      ],
      );

    // ── 本公司报修原稿（首析状态推进的写入对象）──
    for (const [index, recordUuid] of TARGET_INTAKE_UUIDS.entries()) {
      await dataSource.query(
        'INSERT INTO repair_request_intake ' +
          '(record_uuid, customer_account_id, customer_organization_id, service_organization_id, ' +
          'equipment_model_id, error_code, fault_description, analysis_status, analysis_generation) ' +
          'SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0 FROM DUAL ' +
          'WHERE NOT EXISTS (SELECT 1 FROM repair_request_intake WHERE record_uuid = ?)',
        [
          recordUuid,
          customerAccountId,
          targetOrganizationId,
          targetOrganizationId,
          equipmentModelId,
          `E-TASK09-INTAKE-${index + 1}`,
          `任务09 隔离库报修原稿 ${index + 1}`,
          'WAITING',
          recordUuid,
        ],
      );
    }

    // ── 本公司与外公司的维修报告（外公司报告即"外公司哨兵"数据面）──
    const insertReport = async (
      recordUuid: string,
      ownerOrganizationId: number,
      engineerAccountId: number,
      title: string,
    ): Promise<void> => {
      await dataSource.query(
        'INSERT INTO maintenance_report ' +
          '(record_uuid, owner_organization_id, source_type, title, maintenance_engineer_account_id, ' +
          'maintenance_engineer_name_snapshot, created_by_account_id, updated_by_account_id, ' +
          'status, current_version_no, last_submitted_at, phase_flow_version, ai_usage) ' +
          'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(3), 1, ? FROM DUAL ' +
          'WHERE NOT EXISTS (SELECT 1 FROM maintenance_report WHERE record_uuid = ?)',
        [
          recordUuid,
          ownerOrganizationId,
          'HISTORICAL_CASE',
          title,
          engineerAccountId,
          `任务09 夹具工程师 ${engineerAccountId}`,
          engineerAccountId,
          engineerAccountId,
          'SUBMITTED',
          'NOT_USED',
          recordUuid,
        ],
      );
    };
    for (const [index, recordUuid] of TARGET_REPORT_UUIDS.entries()) {
      await insertReport(
        recordUuid,
        targetOrganizationId,
        engineerAccountId,
        `任务09 本公司报告 ${index + 1}`,
      );
    }
    for (const [index, recordUuid] of FOREIGN_REPORT_UUIDS.entries()) {
      await insertReport(
        recordUuid,
        foreignOrganizationId,
        foreignEngineerAccountId,
        `任务09 外公司哨兵报告 ${index + 1}`,
      );
    }

    // ── 真实业务原件（bytes ＋ 登记事实）──
    //    备份包会把公司数据区的原件**物理复制**进包；读不出字节的原件会被登记
    //    进清单却不在包内 ⇒ 恢复预检拒绝、恢复执行必然失败。
    //    隔离库必须具备**真实原件**（真实字节 ＋ 真实校验值），否则恢复链的
    //    "原件真实传输"无从取证。
    const storageDir = resolve(
      process.cwd(),
      process.env['REFERENCE_DOCUMENT_STORAGE_DIR'] ?? 'var/reference-documents',
    );
    mkdirSync(storageDir, { recursive: true });
    const referenceRows: unknown = await dataSource.query(
      'SELECT id, storage_reference FROM reference_document WHERE owner_organization_id = ?',
      [targetOrganizationId],
    );
    let originalCount = 0;
    for (const row of referenceRows as Array<{ id: number; storage_reference: string | null }>) {
      if (row.storage_reference === null || row.storage_reference.length === 0) {
        continue;
      }
      // 存储引用必须符合本地存储的白名单（32 位 hex ＋ 扩展名）：
      // Seed 里的 'mock/reference/...' 这类引用**永远不可能**被存储实现接受，
      // 只能就地改成合法引用并补上真实字节。
      let reference = row.storage_reference;
      if (!/^[0-9a-f]{32}\.[a-z0-9]{1,8}$/u.test(reference)) {
        reference = `${randomBytes(16).toString('hex')}.pdf`;
        await dataSource.query(
          'UPDATE reference_document SET storage_reference = ? WHERE id = ?',
          [reference, row.id],
        );
      }
      const bytes = Buffer.from(
        `任务09 隔离库真实原件 ${row.id}\n${'A'.repeat(4096)}\n`,
        'utf8',
      );
      writeFileSync(join(storageDir, reference), bytes);
      originalCount += 1;
    }
    // 一条**带校验值**的 stored_file 原件（读侧按附件行的引用取字节）
    const storedFileId = '97900100-0000-4000-8000-000000000001';
    const storedReference = `${randomBytes(16).toString('hex')}.pdf`;
    const storedBytes = Buffer.from(`任务09 隔离库 stored_file 原件\n${'B'.repeat(2048)}\n`, 'utf8');
    writeFileSync(join(storageDir, storedReference), storedBytes);
    await dataSource.query(
      'INSERT INTO stored_file ' +
        '(file_id, owner_organization_id, status, storage_reference, checksum_sha256, byte_size, ' +
        'uploaded_by_account_id, original_filename, mime_type, business_type, upload_context_id, ' +
        'binding_status, business_id, created_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW(3) FROM DUAL ' +
        'WHERE NOT EXISTS (SELECT 1 FROM stored_file WHERE file_id = ?)',
      [
        storedFileId,
        targetOrganizationId,
        'STAGING',
        storedReference,
        createHash('sha256').update(storedBytes).digest('hex'),
        storedBytes.byteLength,
        engineerAccountId,
        'task09-isolated-original.pdf',
        'application/pdf',
        'MAINTENANCE_REPORT',
        'task09-isolated',
        'TEMPORARY',
        storedFileId,
      ],
    );
    originalCount += 1;

    const summaryRows: unknown = await dataSource.query(
      'SELECT ' +
        '(SELECT COUNT(*) FROM repair_request WHERE owner_organization_id = ?) AS target_requests, ' +
        '(SELECT COUNT(*) FROM repair_request WHERE owner_organization_id <> ?) AS foreign_requests, ' +
        '(SELECT COUNT(*) FROM repair_request_intake WHERE service_organization_id = ?) AS target_intakes, ' +
        '(SELECT COUNT(*) FROM maintenance_report WHERE owner_organization_id = ?) AS target_reports, ' +
        '(SELECT COUNT(*) FROM maintenance_report WHERE owner_organization_id <> ?) AS foreign_reports',
      [
        targetOrganizationId,
        targetOrganizationId,
        targetOrganizationId,
        targetOrganizationId,
        targetOrganizationId,
      ],
    );
    process.stdout.write(
      `[fixture] 夹具就绪：${JSON.stringify((summaryRows as Array<Record<string, unknown>>)[0] ?? {})}\n`,
    );
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
