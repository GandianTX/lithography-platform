// scripts/admin-binding-inventory.ts
import 'reflect-metadata';
import 'tsconfig-paths/register';

import * as fs from 'fs';

import {
  applyAdminBindingInventoryWithDataSource,
  inspectAdminBindingInventory,
} from '@src/infrastructure/database/admin-binding-inventory';
import { parseAdminBootstrapConfig } from '@src/infrastructure/database/admin-bootstrap';
import {
  createMigrationDataSource,
  loadExplicitEnvConfig,
  readAndAssertTarget,
  type MigrationLogger,
} from '@src/infrastructure/database/incremental-migration';
import { createFieldCipher } from '@src/infrastructure/field-encryption/field-encryption.cipher';

type InventoryMode = 'report' | 'apply';

interface InventoryCliOptions {
  readonly mode: InventoryMode;
  readonly envFile: string;
  readonly database: string;
  readonly confirmDatabase: string;
  readonly expectServerUuid?: string;
  readonly adminBootstrapFile?: string;
  readonly approvedPlanIds: ReadonlyArray<string>;
  readonly confirmApply?: string;
}

const SERVER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

function error(message: string): void {
  process.stderr.write(`${message}\n`);
}

const logger: MigrationLogger = {
  info,
  warn: (message: string): void => {
    error(`⚠️ ${message}`);
  },
  error: (message: string): void => {
    error(`❌ ${message}`);
  },
};

function parseArgs(argv: ReadonlyArray<string>): InventoryCliOptions {
  const args = [...argv];
  let mode: InventoryMode = 'report';
  let envFile: string | undefined;
  let database: string | undefined;
  let confirmDatabase: string | undefined;
  let expectServerUuid: string | undefined;
  let adminBootstrapFile: string | undefined;
  let approvedPlanIds: ReadonlyArray<string> = [];
  let confirmApply: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    if (typeof token !== 'string') {
      throw new Error('参数解析异常');
    }
    if (!token.startsWith('--')) {
      throw new Error(`不支持的位置参数: ${token}`);
    }
    const separatorIndex = token.indexOf('=');
    const option = separatorIndex >= 0 ? token.slice(0, separatorIndex) : token;
    const value = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : args.shift();
    if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
      throw new Error(`参数 ${option} 缺少有效值`);
    }

    switch (option) {
      case '--mode':
        if (value !== 'report' && value !== 'apply') {
          throw new Error('--mode 只接受 report 或 apply');
        }
        mode = value;
        break;
      case '--config-file':
        envFile = value;
        break;
      case '--database':
        database = value;
        break;
      case '--confirm-database':
        confirmDatabase = value;
        break;
      case '--expect-server-uuid':
        if (!SERVER_UUID_PATTERN.test(value.trim())) {
          throw new Error('--expect-server-uuid 必须是 MySQL @@server_uuid 格式的 UUID');
        }
        expectServerUuid = value.trim().toLowerCase();
        break;
      case '--admin-bootstrap-file':
        adminBootstrapFile = value;
        break;
      case '--approve':
        approvedPlanIds = value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        break;
      case '--confirm-apply':
        confirmApply = value;
        break;
      default:
        throw new Error(`不支持的参数: ${option}`);
    }
  }

  if (!envFile) {
    throw new Error('必须显式指定 --config-file，不会自动回落其他环境文件');
  }
  if (!database) {
    throw new Error('必须显式指定 --database');
  }
  if (!confirmDatabase || confirmDatabase !== database) {
    throw new Error('必须提供一致的 --confirm-database 再次确认目标库');
  }
  if (mode === 'apply') {
    if (!adminBootstrapFile) {
      throw new Error('apply 模式必须提供 --admin-bootstrap-file（schema_version=2 映射）');
    }
    if (approvedPlanIds.length === 0) {
      throw new Error('apply 模式必须提供已审查的 --approve=<待处理 ID,...>');
    }
    if (!confirmApply || confirmApply !== database) {
      throw new Error(`apply 模式必须提供与目标库一致的 --confirm-apply=${database}`);
    }
  } else if (confirmApply || adminBootstrapFile || approvedPlanIds.length > 0) {
    throw new Error('report 模式不接受 --confirm-apply、--admin-bootstrap-file 或 --approve');
  }

  return {
    mode,
    envFile,
    database,
    confirmDatabase,
    approvedPlanIds,
    ...(expectServerUuid ? { expectServerUuid } : {}),
    ...(adminBootstrapFile ? { adminBootstrapFile } : {}),
    ...(confirmApply ? { confirmApply } : {}),
  };
}

function printReport(
  database: string,
  report: Awaited<ReturnType<typeof inspectAdminBindingInventory>>,
): void {
  const { summary, items } = report;
  info(
    `盘点库：${database}；受管公司 ${String(summary.total)}；已绑定 ${String(summary.bound)}；` +
      `未配置 ${String(summary.unconfigured)}；冲突 ${String(summary.conflict)}；` +
      `公司停用 ${String(summary.companyDisabled)}；待人工 ${String(summary.manual)}`,
  );
  for (const item of items) {
    const binding =
      item.boundLoginNameMasked === null
        ? ''
        : `；绑定账号 account_id=${String(item.boundAccountId)} login=${item.boundLoginNameMasked}`;
    const reason = item.reason === null ? '' : `；原因=${item.reason}`;
    const disabled = item.accountDisabled ? '；账号或资料非 ACTIVE' : '';
    const candidates =
      item.candidates.length > 1
        ? `；候选=[${item.candidates
            .map(
              (candidate) =>
                `account_id=${String(candidate.accountId)} ${candidate.loginNameMasked}`,
            )
            .join(', ')}]`
        : '';
    info(
      `[${item.planId}] 公司 ${item.organizationCode}：${item.status}；动作=${item.action}` +
        `${reason}${binding}${disabled}${candidates}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadExplicitEnvConfig(options.envFile, options.database);

  const key = config.fieldEncryptionKey?.trim();
  const iv = config.fieldEncryptionIv?.trim();
  if (!key || !iv) {
    throw new Error(
      '盘点需要 FIELD_ENCRYPTION_KEY 与 FIELD_ENCRYPTION_IV 校验三源角色事实；缺失时拒绝继续',
    );
  }
  const cipher = createFieldCipher(key, iv);

  const dataSource = createMigrationDataSource(config);
  try {
    await dataSource.initialize();
    const target = await readAndAssertTarget(dataSource, config.database);
    info(`目标：${target.host}:${target.port}/${target.database}（MySQL ${target.serverVersion}）`);

    if (options.expectServerUuid) {
      const rows: unknown = await dataSource.query('SELECT @@server_uuid AS server_uuid');
      const actual =
        Array.isArray(rows) && rows.length > 0
          ? (rows[0] as { readonly server_uuid?: unknown }).server_uuid
          : null;
      if (typeof actual !== 'string' || actual.toLowerCase() !== options.expectServerUuid) {
        throw new Error('目标实例 UUID 不一致，已在任何写入前停止');
      }
    }

    const report = await inspectAdminBindingInventory(dataSource.manager, cipher);
    printReport(config.database, report);

    if (options.mode === 'report') {
      info('只读盘点完成；未执行任何写入');
      return;
    }

    const bootstrapFile = options.adminBootstrapFile;
    if (!bootstrapFile) {
      throw new Error('apply 模式缺少 --admin-bootstrap-file');
    }
    const raw = fs.readFileSync(bootstrapFile, 'utf8');
    const adminConfig = parseAdminBootstrapConfig(raw);
    if (adminConfig.schemaVersion !== 2) {
      throw new Error('apply 模式只接受 schema_version=2 的正式初始化映射');
    }

    const applied = await applyAdminBindingInventoryWithDataSource(dataSource, {
      approvedPlanIds: options.approvedPlanIds,
      managedCompanyEntries: adminConfig.defaultManagedCompanies,
      cipher,
    });

    info(`受控应用完成：本次新建 ${String(applied.length)} 个二级账号`);
    for (const item of applied) {
      info(
        ` - [${item.planId}] 公司 ${item.organizationCode} 账号 ${item.loginName}：${item.outcome}` +
          '（首次临时密码须通过受控渠道单独交付）',
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  logger.error(`存量二级管理员盘点/应用失败: ${message}`);
  process.exitCode = 1;
});
