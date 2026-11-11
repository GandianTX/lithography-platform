// scripts/database-deploy.ts
import 'reflect-metadata';
import 'tsconfig-paths/register';

import {
  getCleanupErrors,
  parseDeployCliArgs,
  runDatabaseDeploy,
} from '@src/infrastructure/database/database-deploy';
import type { MigrationLogger } from '@src/infrastructure/database/incremental-migration';

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

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
 * 正式部署 CLI：init 初始化空库/复核终态；upgrade 仅运行 pending。
 * 不启动 API/Worker、不安装系统服务、不修改系统权限、不导入演示数据。
 */
async function main(): Promise<void> {
  try {
    const options = parseDeployCliArgs(process.argv.slice(2));
    await runDatabaseDeploy(options, logger);
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error(`数据库部署失败: ${message}`);
    for (const cleanupError of getCleanupErrors(caught)) {
      error(`收尾错误: ${cleanupError}`);
    }
    process.exitCode = 1;
  }
}

void main();
