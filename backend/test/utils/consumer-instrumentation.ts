import { classifyThreadInstrumentationWrite } from './e2e-scoped-cleanup';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function readConsumerDiagnostic(read: () => Promise<string>): Promise<string> {
  try {
    const current = await read();
    return current === 'YES' || current === 'NO'
      ? `current=${current}`
      : `current=UNKNOWN（状态未知，返回值=${JSON.stringify(current)}）`;
  } catch (error: unknown) {
    return `current=UNKNOWN（状态未知，读回失败=${errorMessage(error)}）`;
  }
}

/** Keep original error objects and put actionable details in Jest's displayed message. */
export async function createConsumerInjectionFailure(options: {
  readonly serverUuid: string;
  readonly consumer: string;
  readonly original: string;
  readonly primaryError: unknown;
  readonly cleanupErrors: readonly unknown[];
  readonly read: () => Promise<string>;
}): Promise<AggregateError> {
  const { serverUuid, consumer, original, primaryError, cleanupErrors, read } = options;
  const state = await readConsumerDiagnostic(read);
  const errors = primaryError === undefined ? [...cleanupErrors] : [primaryError, ...cleanupErrors];
  return new AggregateError(
    errors,
    `consumer 注入或收尾失败：server_uuid=${serverUuid} consumer=${consumer} original=${original} ${state}\n` +
      `主错误：${primaryError === undefined ? '无' : errorMessage(primaryError)}\n` +
      cleanupErrors
        .map((error, index) => `收尾错误[${index + 1}]：${errorMessage(error)}`)
        .join('\n') +
      '\n停止后续故障注入；保留现场，由隔离实例执行者核对实例、原状态与恢复责任后处置',
  );
}

/** Change one consumer only when its original state is still present. */
export async function disableConsumerWithRecovery(options: {
  readonly serverUuid: string;
  readonly consumer: string;
  readonly original: string;
  readonly write: (from: string, to: string) => Promise<unknown>;
  readonly read: () => Promise<string>;
}): Promise<() => Promise<void>> {
  const { serverUuid, consumer, original, write, read } = options;
  const facts = `server_uuid=${serverUuid} consumer=${consumer} original=${original}`;
  let result: unknown;
  try {
    result = await write(original, 'NO');
  } catch (error: unknown) {
    let current = '不可确认';
    try {
      current = await read();
    } catch {
      // An unavailable read is diagnostic only and cannot establish write ownership.
    }
    throw new Error(
      `consumer 写入结果未知：${facts} current=${current}；` +
        `原始错误=${error instanceof Error ? error.message : String(error)}；` +
        '保留现场，停止后续故障注入，交由隔离实例执行者处置',
      { cause: error },
    );
  }
  const decision = classifyThreadInstrumentationWrite(result);
  if (!decision.shouldRestore) {
    let current = '不可确认';
    try {
      current = await read();
    } catch {
      // Preserve the original classification if the diagnostic read also fails.
    }
    throw new Error(
      `consumer 写入${decision.outcome === 'unknown' ? '结果未知' : '未命中'}：${facts} ` +
        `current=${current} affectedRows=${String(decision.affectedRows)}；` +
        '保留现场，停止后续故障注入，交由隔离实例执行者处置',
    );
  }
  return async () => {
    try {
      const recovery = classifyThreadInstrumentationWrite(await write('NO', original));
      if (!recovery.shouldRestore) {
        throw new Error(`consumer 恢复未确认：outcome=${recovery.outcome}`);
      }
      const current = await read();
      if (current !== original) {
        throw new Error(`consumer 恢复读回不一致：current=${current}`);
      }
    } catch (error: unknown) {
      const state = await readConsumerDiagnostic(read);
      throw new Error(
        `consumer 恢复失败：${facts} ${state}；恢复错误=${errorMessage(error)}；` +
          `本轮停采已明确命中1行，恢复条件=NO→${original}；保留现场，停止注入并交由隔离实例执行者处置`,
        { cause: error },
      );
    }
  };
}
