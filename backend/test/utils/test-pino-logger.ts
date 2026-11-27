// test/utils/test-pino-logger.ts

/**
 * 单元测试用的 PinoLogger 替身（任务 09）。
 *
 * 为什么需要：任务 09 的备份／清理／上传／预检服务把**底层异常原文**
 * 改为只进服务端日志（对外只给受控原因码），因此这些服务注入了 PinoLogger；
 * 单测需要一份不会写控制台的替身。
 *
 * 口径：只实现被测代码真正调用的方法（error／warn／info／debug／setContext），
 * 全部为 jest.fn()，便于断言"是否记录了原始异常"。
 */
import type { PinoLogger } from 'nestjs-pino';

export type TestPinoLogger = {
  readonly error: jest.Mock;
  readonly warn: jest.Mock;
  readonly info: jest.Mock;
  readonly debug: jest.Mock;
  readonly setContext: jest.Mock;
};

/** 创建一个测试用 PinoLogger 替身 */
export function createTestPinoLogger(): TestPinoLogger {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn(),
  };
}

/** 断言用：把替身当作 PinoLogger 传入被测构造函数 */
export function asPinoLogger(logger: TestPinoLogger): PinoLogger {
  return logger as unknown as PinoLogger;
}
