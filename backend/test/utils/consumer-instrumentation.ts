import { classifyThreadInstrumentationWrite } from './e2e-scoped-cleanup';

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
    const recovery = classifyThreadInstrumentationWrite(await write('NO', original));
    if (!recovery.shouldRestore) {
      throw new Error(`consumer 恢复未确认：${facts} outcome=${recovery.outcome}；保留现场`);
    }
    const current = await read();
    if (current !== original) {
      throw new Error(`consumer 恢复读回不一致：${facts} current=${current}；保留现场`);
    }
  };
}
