// src/infrastructure/database/test-support/inject-cleanup-failure.js
// 仅测试侧预加载工具：通过显式环境变量在子进程 CLI 中注入收尾/锁释放失败。
// 生产代码不会引用本文件，也不提供任何 CLI 绕过参数。
const { DataSource } = require('typeorm');

const CLOSE_FAILURE = process.env.MIGRATION_TEST_INJECT_CLOSE_FAILURE === '1';
const RELEASE_FAILURE = process.env.MIGRATION_TEST_INJECT_RELEASE_FAILURE === '1';

if (CLOSE_FAILURE) {
  const originalDestroy = DataSource.prototype.destroy;
  DataSource.prototype.destroy = async function destroyWithInjectedFailure() {
    await originalDestroy.call(this);
    throw new Error('injected-destroy-failure-after-real-close');
  };
}

if (RELEASE_FAILURE) {
  const originalCreate = DataSource.prototype.createQueryRunner;
  DataSource.prototype.createQueryRunner = function createQueryRunnerWithInjectedRelease() {
    const runner = originalCreate.call(this);
    const originalQuery = runner.query.bind(runner);
    runner.query = async (sql, parameters, useStructuredResult) => {
      const result = await originalQuery(sql, parameters, useStructuredResult);
      if (typeof sql === 'string' && sql.includes('RELEASE_LOCK')) {
        throw new Error('injected-release-lock-failure-after-real-release');
      }
      return result;
    };
    return runner;
  };
}
