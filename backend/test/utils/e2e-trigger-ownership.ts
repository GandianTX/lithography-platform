// test/utils/e2e-trigger-ownership.ts

/**
 * E2E 故障注入触发器的**对象所有权**工具（第五轮 Review P3；第十五轮 P1 修订；
 * 第十六轮 P1：追踪器改为强制前提，移除无登记创建 / 盲删回退通道）。
 *
 * 背景：为了证明「后序删除失败时整批回滚」，测试会在隔离库创建触发器注入确定性失败。
 * 但 MySQL 的触发器是**库级对象**，DDL 还会隐式提交当前事务——如果测试使用固定名称并
 * 无条件 `DROP TRIGGER`，就可能删掉别人的同名对象，或让本轮对象在失败路径残留。
 *
 * 本工具的边界：
 * - 名称必须由调用方提供**本轮唯一**且格式受控（`[A-Za-z0-9_]`，≤64）的名称；
 * - **必须提供 `createTriggerOwnershipTracker()` 创建的本轮登记 tracker**；缺失即
 *   在任何 DDL（含同名预检查询）之前拒绝。工具内不存在“无 tracker 时按名称 DROP”的回退；
 * - 创建前先在 `information_schema.TRIGGERS` 检查同名对象，已存在即失败关闭（绝不覆盖）；
 * - `CREATE TRIGGER` 明确成功的**下一行同步登记**本轮创建事实（名称 / 表 / 注入体），
 *   **不等待元数据回读成功，也不等待创建函数返回**；回读抛错时登记记录仍然存在，
 *   由统一收尾入口处理；
 * - 收尾只删除「本轮登记且当前定义仍可核实匹配」的对象，且一律使用 `DROP TRIGGER IF EXISTS`
 *   （对象已消失时是无害 no-op，不会掩盖真实错误）；
 * - 回读失败导致定义未知时，用调用方注入的触发器体核验当前定义（MySQL 原样保存单语句体）；
 *   仍无法匹配即视为「无法完成安全核验」，保留待收尾记录并报告，绝不盲删；
 * - DDL 只在「显式清理许可 + 实际库名白名单」双门禁通过后执行。
 */

import type { DataSource } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase, assertPhysicalCleanupConsent } from './e2e-db-guard';

/** 创建后回读成功的触发器对象事实 */
export type OwnedTriggerFact = {
  readonly name: string;
  readonly tableName: string;
  readonly definition: string;
};

/** 本轮登记记录：CREATE 成功后立即登记，`fact` 在回读成功后才补齐 */
export type OwnedTriggerRecord = {
  readonly name: string;
  readonly tableName: string;
  /** 调用方注入的触发器体：回读失败时用于核验当前对象归属 */
  readonly body: string;
  /** 创建后回读成功的事实；null = 待核验（不得视为已确认归属） */
  fact: OwnedTriggerFact | null;
};

/** 本轮触发器登记表：记录创建事实，并追踪尚未完成安全收尾的记录 */
export type TriggerOwnershipTracker = {
  /** 本轮登记的全部记录（含待核验） */
  records(): readonly OwnedTriggerRecord[];
  /** 仍未完成安全收尾的记录（销毁失败 / 无法核验） */
  remaining(): readonly OwnedTriggerRecord[];
  /** 内部：CREATE 成功后同步登记 */
  register(record: OwnedTriggerRecord): void;
  /** 内部：收尾成功标记 */
  settle(name: string): void;
};

export const createTriggerOwnershipTracker = (): TriggerOwnershipTracker => {
  const registered: OwnedTriggerRecord[] = [];
  const pending = new Set<string>();

  return {
    records: () => registered,
    remaining: () => registered.filter((record) => pending.has(record.name)),
    register: (record: OwnedTriggerRecord): void => {
      if (!registered.some((entry) => entry.name === record.name)) {
        registered.push(record);
        pending.add(record.name);
      }
    },
    settle: (name: string): void => {
      pending.delete(name);
    },
  };
};

const TRIGGER_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** 名称格式受控：只允许安全字符且长度不超 MySQL 标识符上限。 */
export const assertTriggerNameFormat = (name: string): void => {
  if (!TRIGGER_NAME_PATTERN.test(name)) {
    throw new Error(
      `[e2e-trigger] 拒绝使用不合规的触发器名称：${JSON.stringify(name)}（仅允许 [A-Za-z0-9_]，长度 1-64）`,
    );
  }
};

/**
 * 追踪器运行时校验：在任何 DDL 之前执行。
 * 缺少 tracker（含被 `undefined` 传入）即失败关闭，不存在“无登记创建 / 按名称盲删”的通道。
 */
const assertTriggerOwnershipTracker = (
  tracker: TriggerOwnershipTracker | undefined,
  helper: string,
): TriggerOwnershipTracker => {
  if (
    tracker === undefined ||
    tracker === null ||
    typeof tracker.register !== 'function' ||
    typeof tracker.settle !== 'function' ||
    typeof tracker.records !== 'function' ||
    typeof tracker.remaining !== 'function'
  ) {
    throw new Error(
      `[${helper}] 阶段=追踪器校验 拒绝执行：必须提供 createTriggerOwnershipTracker() 创建的本轮登记 tracker；` +
        '工具不提供无登记创建或按名称盲删的回退通道。',
    );
  }
  return tracker;
};

const normalizeDefinition = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** 双门禁：显式清理许可 + 实际库名白名单（DDL 只在明确授权的独占隔离库执行） */
const assertTriggerTarget = async (ds: DataSource, helper: string): Promise<string> => {
  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=DDL 许可门禁 拒绝执行触发器 DDL：${detail}`, {
      cause: error,
    });
  }
  try {
    return await assertDataSourceOnAllowedE2eDatabase(ds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=目标库守卫 拒绝执行触发器 DDL：${detail}`, { cause: error });
  }
};

/** 只读：读取库内同名触发器事实（不存在返回 null）。 */
export const readOwnedTriggerFact = async (
  ds: DataSource,
  name: string,
): Promise<OwnedTriggerFact | null> => {
  assertTriggerNameFormat(name);
  const rows = await ds.query<Array<{ name: string; tableName: string; definition: string }>>(
    'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName, ACTION_STATEMENT AS definition ' +
      'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
    [name],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    name: row.name,
    tableName: row.tableName,
    definition: row.definition,
  };
};

/**
 * 创建本轮专属触发器：校验 tracker → 查同名（存在即拒绝）→ CREATE → **立即登记** → 回读补齐事实。
 *
 * `tracker` 是**必需参数**：缺少时在任何 DDL 之前失败关闭。CREATE 明确成功后立刻登记本轮
 * 创建事实（在回读之前），因此回读抛错时记录仍保留，由统一收尾入口按注入体核验后精确删除；
 * 工具内不存在“无 tracker 时按名称 DROP”的回退分支。
 */
export const createOwnedTrigger = async (params: {
  dataSource: DataSource;
  name: string;
  tableName: string;
  /** 触发器体（调用方负责只做故障注入，不含业务写） */
  body: string;
  tracker: TriggerOwnershipTracker;
}): Promise<OwnedTriggerFact> => {
  const helper = 'createOwnedTrigger';
  const tracker = assertTriggerOwnershipTracker(params.tracker, helper);
  assertTriggerNameFormat(params.name);
  await assertTriggerTarget(params.dataSource, helper);

  const existing = await readOwnedTriggerFact(params.dataSource, params.name);
  if (existing !== null) {
    throw new Error(
      `[${helper}] 阶段=同名预检 拒绝创建：触发器 ${params.name} 已存在` +
        `（表 ${existing.tableName}），归属不明确`,
    );
  }

  await params.dataSource.query(
    `CREATE TRIGGER \`${params.name}\` BEFORE DELETE ON \`${params.tableName}\` ` +
      `FOR EACH ROW ${params.body}`,
  );

  // CREATE 明确成功后立即登记本轮创建事实（同步执行，不等待回读/函数返回）
  const record: OwnedTriggerRecord = {
    name: params.name,
    tableName: params.tableName,
    body: params.body,
    fact: null,
  };
  tracker.register(record);

  const recorded = await readOwnedTriggerFact(params.dataSource, params.name);
  // 回读成功也必须证明「当前对象仍是本次 CREATE 的对象」：名称 / 表 / 注入体三项匹配
  // 才可补齐事实；否则视为同名替换，保留待核验登记并由收尾阶段拒绝删除。
  if (
    recorded === null ||
    recorded.name !== params.name ||
    recorded.tableName !== params.tableName ||
    normalizeDefinition(recorded.definition) !== normalizeDefinition(params.body)
  ) {
    throw new Error(
      `[${helper}] 阶段=创建核验 拒绝继续：创建后回读的触发器 ${params.name} 与登记事实不匹配` +
        `（当前表 ${recorded?.tableName ?? '(缺失)'}，登记表 ${params.tableName}）`,
    );
  }
  // 只补齐事实，record.body 保留原始创建预期，后续定义比较不以当前定义回填预期
  record.fact = recorded;
  return recorded;
};

/** 收尾前核验：名称 / 目标表 / 可核实的定义事实（回读失败时用注入体核验） */
const disposeRecord = async (
  ds: DataSource,
  record: OwnedTriggerRecord,
  helper: string,
): Promise<void> => {
  assertTriggerNameFormat(record.name);
  await assertTriggerTarget(ds, helper);

  const current = await readOwnedTriggerFact(ds, record.name);
  if (current !== null) {
    const expectedDefinition = record.fact?.definition ?? record.body;
    if (
      current.tableName !== record.tableName ||
      normalizeDefinition(current.definition) !== normalizeDefinition(expectedDefinition)
    ) {
      throw new Error(
        `[${helper}] 阶段=归属校验 拒绝删除：触发器 ${record.name} 的当前定义与本轮记录不一致` +
          `（当前表 ${current.tableName}，本轮表 ${record.tableName}）`,
      );
    }
  }
  // 无条件 IF EXISTS：本轮对象已消失时仍是 no-op，不会掩盖主错误
  await ds.query(`DROP TRIGGER IF EXISTS \`${record.name}\``);
};

/**
 * 收尾：只删除「本轮确认创建且定义仍匹配」的对象。
 * 当前同名对象定义不同 → 视为被外部替换，拒绝删除并抛出可观察错误。
 * `tracker` 为必需参数（与创建一致），收尾成功后在 tracker 上落账。
 */
export const disposeOwnedTrigger = async (
  ds: DataSource,
  owned: OwnedTriggerFact,
  tracker: TriggerOwnershipTracker,
): Promise<void> => {
  const validated = assertTriggerOwnershipTracker(tracker, 'disposeOwnedTrigger');
  await disposeRecord(
    ds,
    {
      name: owned.name,
      tableName: owned.tableName,
      body: owned.definition,
      fact: owned,
    },
    'disposeOwnedTrigger',
  );
  validated.settle(owned.name);
};

/** 收尾一条本轮登记记录（含回读失败的待核验记录）；tracker 为必需参数。 */
export const disposeOwnedTriggerRecord = async (
  ds: DataSource,
  record: OwnedTriggerRecord,
  tracker: TriggerOwnershipTracker,
): Promise<void> => {
  const validated = assertTriggerOwnershipTracker(tracker, 'disposeOwnedTriggerRecord');
  await disposeRecord(ds, record, 'disposeOwnedTriggerRecord');
  validated.settle(record.name);
};

/** 故障用例的失败阶段：不同阶段错误分别保留，不互相覆盖 */
export type TriggerCaseFailure = { readonly stage: string; readonly error: unknown };

/**
 * 统一保护一个「故障注入 + 断言 + 收尾」用例：
 * 夹具造数 / 触发器创建 / 主断言 / 触发器收尾 / 夹具清理各自执行，错误**分别保留**并返回。
 *
 * 触发器收尾总是执行（DDL 隐式提交，不能依赖事务回滚删除触发器），且以**登记记录**为单位：
 * 即使 `createOwnedTrigger` 在回读阶段抛错（未返回事实），登记事实仍会被收尾；
 * 无法完成安全核验的记录保留在 tracker 中，并显式报告「待收尾残留」，不返回假零残留。
 */
export const runWithOwnedTrigger = async (opts: {
  dataSource: DataSource;
  triggerName: string;
  tableName: string;
  body: string;
  setup: () => Promise<void>;
  run: () => Promise<void>;
  cleanupFixture: () => Promise<void>;
  dispose?: (owned: OwnedTriggerFact) => Promise<void>;
  tracker: TriggerOwnershipTracker;
}): Promise<TriggerCaseFailure[]> => {
  const failures: TriggerCaseFailure[] = [];
  const collect = (stage: string, error: unknown): void => {
    failures.push({ stage, error });
  };
  // 包装入口与直接入口一致：tracker 必需，缺失时在任何 DDL 之前失败关闭。
  const tracker = assertTriggerOwnershipTracker(opts.tracker, 'runWithOwnedTrigger');

  try {
    await opts.setup();
  } catch (error) {
    collect('夹具造数错误', error);
  }

  let owned: OwnedTriggerFact | null = null;
  let created = false;
  if (failures.length === 0) {
    try {
      owned = await createOwnedTrigger({
        dataSource: opts.dataSource,
        name: opts.triggerName,
        tableName: opts.tableName,
        body: opts.body,
        tracker,
      });
      created = true;
    } catch (error) {
      collect('触发器创建错误', error);
    }
  }

  if (created && owned !== null) {
    try {
      await opts.run();
    } catch (error) {
      collect('主错误', error);
    }
  }

  // 统一收尾：以登记记录为准（回读失败时 owned 为 null，登记记录仍在）
  for (const record of tracker.remaining()) {
    try {
      if (opts.dispose && record.fact) {
        await opts.dispose(record.fact);
        tracker.settle(record.name);
      } else {
        await disposeOwnedTriggerRecord(opts.dataSource, record, tracker);
      }
    } catch (error) {
      collect('触发器收尾错误', error);
    }
  }

  const remaining = tracker.remaining();
  if (remaining.length > 0) {
    collect(
      '触发器待收尾残留',
      new Error(`本轮触发器未完成安全收尾：${remaining.map((record) => record.name).join(', ')}`),
    );
  }

  try {
    await opts.cleanupFixture();
  } catch (error) {
    collect('夹具清理错误', error);
  }

  return failures;
};

/** 断言失败阶段为空；有失败时以 AggregateError 汇总各阶段错误，互不吞没。 */
export const assertNoTriggerCaseFailures = (
  failures: readonly TriggerCaseFailure[],
  label: string,
): void => {
  if (failures.length === 0) {
    return;
  }
  const detail = failures
    .map(
      (failure) =>
        `${failure.stage}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
    )
    .join(' | ');
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `${label}存在 ${failures.length} 个失败阶段：${detail}`,
  );
};
