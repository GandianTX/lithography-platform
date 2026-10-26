// scripts/migration.ts
import 'reflect-metadata';
import 'tsconfig-paths/register';

import {
  getCleanupErrors,
  parseMigrationCliArgs,
  runIncrementalMigration,
  runStatusCommand,
  runVerifyCommand,
  type MigrationLogger,
} from '@src/infrastructure/database/incremental-migration';

/**
 * 输出到 stdout；只打印脱敏后的目标信息，不输出密码。
 */
function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * 输出到 stderr。
 */
function error(message: string): void {
  process.stderr.write(`${message}\n`);
}

const logger: MigrationLogger = {
  info,
  warn: (message: string): void => {
    process.stderr.write(`⚠️ ${message}\n`);
  },
  error: (message: string): void => {
    error(`❌ ${message}`);
  },
};

/**
 * CLI 入口：status/verify 只读；run 只执行 pending，失败不自动补偿。
 */
async function main(): Promise<void> {
  try {
    const options = parseMigrationCliArgs(process.argv.slice(2));
    switch (options.command) {
      case 'status': {
        const state = await runStatusCommand(options, logger);
        if (state.issues.length > 0) {
          process.exitCode = 1;
        }
        break;
      }
      case 'verify': {
        const report = await runVerifyCommand(options, logger);
        if (report.issues.length > 0) {
          process.exitCode = 1;
        }
        break;
      }
      case 'run': {
        await runIncrementalMigration(options, logger);
        break;
      }
      default:
        throw new Error(`不支持的命令: ${String(options.command)}`);
    }
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error(`迁移命令失败: ${message}`);
    for (const cleanupError of getCleanupErrors(caught)) {
      error(`收尾错误: ${cleanupError}`);
    }
    process.exitCode = 1;
  }
}

void main();
