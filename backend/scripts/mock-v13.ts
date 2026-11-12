// scripts/mock-v13.ts

/**
 * V13 开发 Mock 数据入口（独立于正式部署与旧 seed:mock）。
 *
 * 唯一写入路径：`npm run mock:v13 -- --env-file ... --write`。
 * 未带 `--write` 时只做守卫与目标库结构核对，不写数据库、不写文件。
 */

import 'reflect-metadata';
import 'tsconfig-paths/register';

import { main } from './mock-v13/runner';

void main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(`[mock:v13] 未捕获异常: ${(error as Error).message}\n`);
    process.exitCode = 4;
  });
