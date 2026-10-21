// test/utils/e2e-teardown.ts
//
// PR0-S8 全局复查 G4（F06）：spec afterAll 统一收尾器与环境变量捕获/恢复。
//
// 语义（与 10 组成熟模式 runAdminDocFixtureTeardown 对齐，并覆盖 env 恢复）：
// - cleanup → finalize → closeApp 依序执行；任一步失败都不阻止后续步骤（资源必须关闭）；
// - 清理失败必须向 jest 传播，使规格确实失败，绝不 console.error 后仍绿色；
// - 多步同时失败时抛出**最初**的错误为主因，其余失败按序并入消息，不无声覆盖。

/** 捕获环境变量当前值（undefined 表示原本不存在），与 restoreEnvValue 配对使用。 */
export const captureEnvValue = (name: string): string | undefined => process.env[name];

/**
 * 恢复环境变量到捕获时的原值：
 * 原值存在则写回原值，原值不存在才删除；不总是假定原值不存在。
 */
export const restoreEnvValue = (name: string, capturedValue: string | undefined): void => {
  if (capturedValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = capturedValue;
  }
};

export type E2eTeardownParams = {
  /** 库内数据清理（窄范围，内部应已通过 runGuardedScopedCleanup 双门禁）。 */
  cleanup?: (() => Promise<void>) | null;
  /** 同步收尾：临时存储目录精确删除、环境变量恢复等。 */
  finalize?: (() => void) | null;
  /** 关闭 Nest app（含必要的等待释放），必须在 cleanup/finalize 之后执行。 */
  closeApp?: (() => Promise<void>) | null;
};

/**
 * afterAll 统一收尾：依序执行 cleanup → finalize → closeApp。
 *
 * 所有步骤都会执行到位；失败按发生顺序记录，
 * 抛错时以最早发生的错误为主因（保留 cause），其余错误按序附带在消息中。
 */
export const runE2eTeardown = async (params: E2eTeardownParams): Promise<void> => {
  const errors: Error[] = [];
  const record = (error: unknown): void => {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  };

  if (params.cleanup) {
    try {
      await params.cleanup();
    } catch (error) {
      record(error);
    }
  }

  if (params.finalize) {
    try {
      params.finalize();
    } catch (error) {
      record(error);
    }
  }

  if (params.closeApp) {
    try {
      await params.closeApp();
    } catch (error) {
      record(error);
    }
  }

  if (errors.length === 0) {
    return;
  }
  const [first, ...rest] = errors;
  if (rest.length === 0) {
    throw first;
  }
  throw new Error(
    `afterAll 收尾出现 ${errors.length} 个失败；按发生顺序保留最初错误为主因：${first.message}；` +
      `其余失败（不得覆盖最初错误）：${rest.map((error) => error.message).join('；')}`,
    { cause: first },
  );
};
