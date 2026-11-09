// test/jest-v13-authoritative.config.js
//
// 本轮 V13 实库专项的专用 Jest 配置。
//
// 与 test/jest-e2e.js 的关键差异：
// - 不注册 globalSetup / globalTeardown，因此不会连接默认库、不会全库清理、不会 FLUSHDB；
// - 不加载任何 env 文件，也不回退 .env.e2e / .env.development；
// - 必须显式设置 V13_AUTHORITATIVE_SPECS=1 才允许加载；
// - 拒绝 NODE_ENV=e2e 与 E2E_DOTENV，避免误用 e2e 回退入口；
// - 测试文件集合由 test/run-v13-authoritative-spec.ts 先用 --listTests 机器核对。

const path = require('path');

if (process.env.V13_AUTHORITATIVE_SPECS !== '1') {
  throw new Error('拒绝加载 V13 专用配置：缺少 V13_AUTHORITATIVE_SPECS=1');
}
if ((process.env.NODE_ENV || '').trim().toLowerCase() === 'e2e') {
  throw new Error('拒绝加载 V13 专用配置：不得使用 NODE_ENV=e2e');
}
if ((process.env.E2E_DOTENV || '').trim().length > 0) {
  throw new Error('拒绝加载 V13 专用配置：不得设置 E2E_DOTENV');
}

module.exports = {
  preset: 'ts-jest',
  rootDir: path.resolve(__dirname, '..'),
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  setupFiles: ['tsconfig-paths/register'],
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@interfaces/(.*)$': '<rootDir>/src/interfaces/$1',
    '^@usecases/(.*)$': '<rootDir>/src/usecases/$1',
    '^@adapters/(.*)$': '<rootDir>/src/adapters/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@app-types/(.*)$': '<rootDir>/src/types/$1',
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 180000,
  forceExit: true,
  detectOpenHandles: true,
};
