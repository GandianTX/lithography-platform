// test/utils/probe-database-lifecycle.ts
//
// M01—M03：探针库生命周期的窄共享实现。
//
// 不变量：
// - K1/M02：任何 DDL/DML 前必须由执行者提供 E2E_ALLOW_PHYSICAL_CLEANUP=1；
//   测试只能恢复已校验的原值，不能自行授权。
// - K2/M01：固定探针名不构成归属证据。只有 CREATE DATABASE 明确成功后才登记本轮所有权；
//   碰撞、明确失败或结果未知都不得认领、不得兜底 DROP。
// - K5/M03：收尾各步骤（shifted 连接、本轮探针、环境恢复、app 关闭）独立尝试；
//   最早错误为主因，后续错误不覆盖。
//
// 该文件是 G04 规格实际使用的实现；永久反例必须调用同一实现，不能复制“测试专用算法”。

import { E2E_PHYSICAL_CLEANUP_CONSENT_ENV } from './e2e-db-guard';
import { captureEnvValue, restoreEnvValue } from './e2e-teardown';

const ALLOWED_DB_NAMES_ENV = 'E2E_ALLOWED_DB_NAMES';
const PROBE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

/** 启动时捕获的执行者许可快照；afterAll 只允许恢复这份原值。 */
export interface ProbeConsentSnapshot {
  readonly consent: string | undefined;
  readonly allowedDbNames: string | undefined;
}

export const describeConsentValue = (value: string | undefined): string =>
  value === undefined ? '(未设置)' : `"${value}"`;

/**
 * M02：在应用初始化、探针库 DDL 和造数之前校验执行者许可。
 * 缺失、'0' 或任何非 '1' 值都失败关闭；本函数不写环境变量。
 */
export const captureAndValidateProbeConsent = (helper: string): ProbeConsentSnapshot => {
  const consent = captureEnvValue(E2E_PHYSICAL_CLEANUP_CONSENT_ENV);
  if (consent !== '1') {
    throw new Error(
      `[${helper}] 启动许可未通过：要求 ${E2E_PHYSICAL_CLEANUP_CONSENT_ENV}=1（实际=${describeConsentValue(
        consent,
      )}）。未创建/删除任何探针库，也未执行任何造数或 DDL。`,
    );
  }
  return {
    consent,
    allowedDbNames: captureEnvValue(ALLOWED_DB_NAMES_ENV),
  };
};

/** 恢复启动时捕获的许可与名单原值（undefined 与 '0' 的原始区别也保留）。 */
export const restoreProbeConsent = (snapshot: ProbeConsentSnapshot): void => {
  restoreEnvValue(E2E_PHYSICAL_CLEANUP_CONSENT_ENV, snapshot.consent);
  restoreEnvValue(ALLOWED_DB_NAMES_ENV, snapshot.allowedDbNames);
};

/** 探针库名只接受确定的测试命名，拒绝把任意字符串拼入 SQL。 */
export const assertSafeProbeDatabaseName = (name: string): string => {
  const normalized = (name ?? '').trim();
  if (!PROBE_IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`探针库名不合法："${normalized}"；只允许小写字母、数字和下划线。`);
  }
  return normalized;
};

/** 窄查询接口：只要求执行参数化 SQL，便于精确注入失败/未知结果。 */
export interface ProbeQueryable {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** 本轮运行的窄身份：具体运行标识、允许目标与实际实例范围。 */
export interface ProbeRunScope {
  readonly runId: string;
  readonly target: string;
  readonly instance: string;
}

/**
 * 实例范围的可比对描述：只读取连接配置的 host/port，不发起查询。
 * 父子进程使用同一份环境时得到相同值，用于拒绝跨实例的归属交接。
 */
export const probeInstanceIdentity = (source: { readonly options?: unknown }): string => {
  const options = source.options as
    { readonly host?: unknown; readonly port?: unknown } | undefined;
  const host =
    typeof options?.host === 'string' && options.host.trim() !== ''
      ? options.host.trim()
      : 'localhost';
  const rawPort = Number(options?.port);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3306;
  return `${host}:${port}`;
};

/** CREATE 明确成功后才有资格销毁的本轮所有权。 */
export interface ProbeDatabaseOwnership {
  readonly name: string;
  readonly createdByThisRun: true;
  /** created = 本进程 CREATE；child-handoff = 子进程结构化创建凭据。 */
  readonly source?: 'created' | 'child-handoff';
  readonly runId?: string;
  readonly target?: string;
  readonly instance?: string;
}

export class ProbeDatabaseCollisionError extends Error {
  constructor(
    readonly probeName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProbeDatabaseCollisionError';
  }
}

const isDatabaseExistsError = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const errno = Number(candidate?.errno ?? NaN);
  if (code === 'ER_DB_CREATE_EXISTS' || errno === 1007) {
    return true;
  }
  const message =
    typeof candidate?.message === 'string'
      ? candidate.message
      : error instanceof Error
        ? error.message
        : '';
  return /database exists|already exists|ER_DB_CREATE_EXISTS/i.test(message);
};

/**
 * M01：使用不带 IF NOT EXISTS 的 CREATE，让 MySQL 原子拒绝已存在的库。
 * 只有明确成功才返回所有权；碰撞与结果未知都抛错且不产生所有权。
 */
export const createOwnedProbeDatabase = async (
  dataSource: ProbeQueryable,
  probeName: string,
  helper: string,
  scope?: ProbeRunScope,
): Promise<ProbeDatabaseOwnership> => {
  const name = assertSafeProbeDatabaseName(probeName);
  try {
    await dataSource.query(`CREATE DATABASE \`${name}\``);
  } catch (error) {
    if (isDatabaseExistsError(error)) {
      throw new ProbeDatabaseCollisionError(
        name,
        `[${helper}] 探针库 "${name}" 已存在：拒绝覆盖或接管既有库；未执行任何 DROP，也未造数。`,
        { cause: error },
      );
    }
    throw new Error(
      `[${helper}] 创建探针库 "${name}" 结果未知或失败：不认领、不兜底删除，保留目标与阶段诊断。`,
      { cause: error },
    );
  }
  return {
    name,
    createdByThisRun: true,
    source: 'created',
    ...(scope ? { runId: scope.runId, target: scope.target, instance: scope.instance } : {}),
  };
};

/** 父/外层驱动专用的带运行身份创建入口；语义与 createOwnedProbeDatabase 相同。 */
export const createOwnedProbeDatabaseForRun = (
  dataSource: ProbeQueryable,
  probeName: string,
  helper: string,
  scope: ProbeRunScope,
): Promise<ProbeDatabaseOwnership> =>
  createOwnedProbeDatabase(dataSource, probeName, helper, scope);

/** 只读检查目标库是否存在；不做任何 DDL/DML，也不构成归属证据。 */
export const probeDatabaseExists = async (
  dataSource: ProbeQueryable,
  probeName: string,
): Promise<boolean> => {
  const name = assertSafeProbeDatabaseName(probeName);
  const rows = await dataSource.query(
    'SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [name],
  );
  const first = Array.isArray(rows) ? (rows[0] as { n?: unknown } | undefined) : undefined;
  return Number(first?.n ?? 0) > 0;
};

export type ProbeDropOutcome = 'dropped' | 'skipped-not-owned';

/**
 * M01：只销毁本轮 CREATE 确认为成功的库；无所有权时连 DROP 语句都不执行。
 * DROP 失败/结果未知由调用方记录，不能伪造为已删除。
 */
export const dropOwnedProbeDatabase = async (
  dataSource: ProbeQueryable,
  ownership: ProbeDatabaseOwnership | null | undefined,
  helper: string,
  expectedScope?: ProbeRunScope,
): Promise<ProbeDropOutcome> => {
  if (!ownership?.createdByThisRun) {
    return 'skipped-not-owned';
  }
  if (expectedScope) {
    const matches =
      ownership.runId === expectedScope.runId &&
      ownership.target === expectedScope.target &&
      ownership.instance === expectedScope.instance;
    if (!matches) {
      throw new Error(
        `[${helper}] 归属记录与当前运行不符（记录 run=${ownership.runId ?? '(缺失)'} target=${
          ownership.target ?? '(缺失)'
        } instance=${ownership.instance ?? '(缺失)'}；期望 run=${expectedScope.runId} target=${
          expectedScope.target
        } instance=${expectedScope.instance}）：拒绝 DROP，未执行任何 SQL。`,
      );
    }
  }
  try {
    await dataSource.query(`DROP DATABASE \`${ownership.name}\``);
  } catch (error) {
    throw new Error(
      `[${helper}] DROP 探针库 "${ownership.name}" 结果未知或失败：不伪造已删除，保留目标与未决状态诊断。`,
      { cause: error },
    );
  }
  return 'dropped';
};

/** 本轮运行的窄归属台账：只接受匹配 run/target/instance 的创建记录。 */
export interface ProbeRunLedger {
  readonly scope: ProbeRunScope;
  record(ownership: ProbeDatabaseOwnership): ProbeDatabaseOwnership;
  current(): ProbeDatabaseOwnership | null;
  has(): boolean;
  consume(): ProbeDatabaseOwnership | null;
}

export const createProbeRunLedger = (scope: ProbeRunScope): ProbeRunLedger => {
  let record: ProbeDatabaseOwnership | null = null;
  const assertMatches = (ownership: ProbeDatabaseOwnership): void => {
    if (
      ownership.runId !== scope.runId ||
      ownership.target !== scope.target ||
      ownership.instance !== scope.instance
    ) {
      throw new Error(
        `[探针台账] 创建记录与当前运行不符（记录 run=${ownership.runId ?? '(缺失)'} target=${
          ownership.target ?? '(缺失)'
        } instance=${ownership.instance ?? '(缺失)'}；期望 run=${scope.runId} target=${scope.target} instance=${
          scope.instance
        }）：不登记、不 DROP。`,
      );
    }
  };
  return {
    scope,
    record: (ownership) => {
      assertMatches(ownership);
      if (record) {
        throw new Error(
          `[探针台账] run=${scope.runId} 已登记 "${record.name}"，拒绝重复/冲突登记 "${ownership.name}"；未执行任何 DROP。`,
        );
      }
      record = ownership;
      return ownership;
    },
    current: () => record,
    has: () => record !== null,
    consume: () => {
      const consumed = record;
      record = null;
      return consumed;
    },
  };
};

export type ProbePresenceOutcome = 'absent' | 'dropped-owned';

/**
 * 父/外层驱动的准备入口：只接受“不存在”或“本轮已登记归属”。
 * 无归属却发现同名库时碰撞拒绝，不执行任何 DROP；有归属时按台账精确回收。
 */
export const assertProbeDatabaseAbsentOrOwned = async (
  dataSource: ProbeQueryable,
  ledger: ProbeRunLedger,
  probeName: string,
  helper: string,
): Promise<ProbePresenceOutcome> => {
  if (ledger.has()) {
    await dropLedgerOwnedProbe(ledger, () => dataSource, helper);
    return 'dropped-owned';
  }
  if (await probeDatabaseExists(dataSource, probeName)) {
    throw new ProbeDatabaseCollisionError(
      probeName,
      `[${helper}] 探针库 "${probeName}" 已存在且没有本轮创建凭据：拒绝覆盖或接管；未执行任何 DROP，也未造数。`,
    );
  }
  return 'absent';
};

/**
 * 统一回收入口：无登记时连数据源都不解析、不发任何 SQL；
 * 有登记但数据源不可用或 DROP 失败时保留记录为未决，不伪报已清理。
 */
export const dropLedgerOwnedProbe = async (
  ledger: ProbeRunLedger,
  resolveDataSource: () => ProbeQueryable,
  helper: string,
): Promise<ProbeDropOutcome> => {
  if (!ledger.has()) {
    return 'skipped-not-owned';
  }
  const dataSource = resolveDataSource();
  const outcome = await dropOwnedProbeDatabase(dataSource, ledger.current(), helper, ledger.scope);
  ledger.consume();
  return outcome;
};

/**
 * 规格生命周期的窄收尾集合：登记的是带 run/target/instance 的账本，
 * 不是库名字符串或布尔状态。用例提前退出时，真实 afterAll 仍能访问这些账本。
 */
export interface ProbeOwnedLedgerEntry {
  readonly label: string;
  readonly ledger: ProbeRunLedger;
}

export type ProbeLedgerSettleOutcome = 'dropped' | 'skipped' | 'failed';

export interface ProbeLedgerSettleResult {
  readonly label: string;
  readonly outcome: ProbeLedgerSettleOutcome;
  readonly error?: unknown;
}

export interface ProbeLedgerSettlement {
  readonly attempted: number;
  readonly dropped: number;
  readonly skipped: number;
  readonly results: readonly ProbeLedgerSettleResult[];
  readonly failures: readonly { readonly label: string; readonly error: unknown }[];
}

export interface ProbeOwnershipRegistry {
  /** 登记已有账本；标签冲突或重复登记不覆盖。纯空账本只占位，不产生删除资格。 */
  add(label: string, ledger: ProbeRunLedger): ProbeRunLedger;
  entries(): ReadonlyArray<ProbeOwnedLedgerEntry>;
  /** 逐资源独立回收：单个失败不跳过其他记录，成功才消费。 */
  settle(
    resolve: (entry: ProbeOwnedLedgerEntry) => ProbeQueryable,
    helper: string,
  ): Promise<ProbeLedgerSettlement>;
}

export const createProbeOwnershipRegistry = (): ProbeOwnershipRegistry => {
  const entries: ProbeOwnedLedgerEntry[] = [];
  return {
    add: (label, ledger) => {
      if (entries.some((entry) => entry.ledger === ledger)) {
        return ledger;
      }
      if (entries.some((entry) => entry.label === label)) {
        throw new Error(
          `[探针收尾集合] 标签 "${label}" 已登记到其他账本：拒绝覆盖或合并删除授权；未执行任何 DROP。`,
        );
      }
      entries.push({ label, ledger });
      return ledger;
    },
    entries: () => [...entries],
    settle: async (resolve, helper) => {
      const results: ProbeLedgerSettleResult[] = [];
      let dropped = 0;
      let skipped = 0;
      for (const entry of [...entries]) {
        if (!entry.ledger.has()) {
          skipped += 1;
          results.push({ label: entry.label, outcome: 'skipped' });
          continue;
        }
        try {
          const outcome = await dropLedgerOwnedProbe(
            entry.ledger,
            () => resolve(entry),
            `${helper} ${entry.label}`,
          );
          if (outcome === 'dropped') {
            dropped += 1;
            results.push({ label: entry.label, outcome: 'dropped' });
          } else {
            skipped += 1;
            results.push({ label: entry.label, outcome: 'skipped' });
          }
        } catch (error) {
          results.push({ label: entry.label, outcome: 'failed', error });
        }
      }
      const failures = results
        .filter((result) => result.outcome === 'failed')
        .map((result) => ({ label: result.label, error: result.error }));
      return {
        attempted: dropped + failures.length,
        dropped,
        skipped,
        results,
        failures,
      };
    },
  };
};

/** 收尾集合的总体状态：无待处理记录时才是 skipped-not-owned。 */
export type ProbeSettlementState = 'skipped-not-owned' | 'settled' | 'partial';

/**
 * 只有“没有任何待处理记录”才允许输出 skipped-not-owned；
 * 已成功回收记为 settled，任一资源未决/失败记为 partial（不得伪报无归属）。
 */
export const probeSettlementState = (settlement: ProbeLedgerSettlement): ProbeSettlementState => {
  if (settlement.failures.length > 0) {
    return 'partial';
  }
  return settlement.dropped > 0 ? 'settled' : 'skipped-not-owned';
};

/** 单资源收尾结果的可回读文本；错误信息压成单行，不伪造已释放。 */
export const describeProbeSettleResult = (result: ProbeLedgerSettleResult): string => {
  if (result.outcome !== 'failed') {
    return result.outcome;
  }
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  return `failed:${message.replace(/\s+/g, ' ').trim()}`;
};

/** 有未决失败时抛出聚合错误；调用方应在此之前逐资源记录实际状态。 */
export const throwProbeSettlementError = (
  settlement: ProbeLedgerSettlement,
  helper: string,
): void => {
  if (settlement.failures.length === 0) {
    return;
  }
  const details = settlement.failures
    .map(({ label, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return `${label}: ${message}`;
    })
    .join('；');
  throw new Error(
    `[${helper}] 已登记本轮资源收尾失败 ${settlement.failures.length} 个（成功 ${settlement.dropped}、跳过 ${settlement.skipped}）：${details}`,
    { cause: settlement.failures[0]?.error },
  );
};

/** 子进程结构化创建凭据的前缀；仅 CREATE 明确成功的分支才允许输出。 */
export const PROBE_CREDENTIAL_PREFIX = 'G04_CREATE_CREDENTIAL=';
export interface ProbeCreationCredential extends ProbeRunScope {
  readonly created: true;
}

export interface ProbeCredentialValid {
  readonly ok: true;
  readonly credential: ProbeCreationCredential;
}

export interface ProbeCredentialInvalid {
  readonly ok: false;
  readonly reason: string;
}

export const formatProbeCreationCredential = (credential: ProbeCreationCredential): string =>
  `${PROBE_CREDENTIAL_PREFIX}${JSON.stringify(credential)}`;

/**
 * 只解析专用的结构化创建凭据；普通日志文本、退出码和库存在性都不能授权 DROP。
 * 缺失、损坏、重复、错 run/target/instance 一律不登记。
 */
export const parseProbeCreationCredential = (
  output: string,
  expected: ProbeRunScope,
): ProbeCredentialValid | ProbeCredentialInvalid => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(PROBE_CREDENTIAL_PREFIX));
  if (lines.length === 0) {
    return { ok: false, reason: '缺少结构化创建凭据' };
  }
  if (lines.length > 1) {
    return { ok: false, reason: `结构化创建凭据重复（${lines.length} 条）` };
  }
  const raw = lines[0].slice(PROBE_CREDENTIAL_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '结构化创建凭据损坏（非 JSON）' };
  }
  const candidate = parsed as Record<string, unknown> | null;
  if (!candidate || candidate.created !== true) {
    return { ok: false, reason: '结构化创建凭据未表达 CREATE 明确成功' };
  }
  const runId = typeof candidate.runId === 'string' ? candidate.runId : '';
  const target = typeof candidate.target === 'string' ? candidate.target : '';
  const instance = typeof candidate.instance === 'string' ? candidate.instance : '';
  if (!runId || !target || !instance) {
    return { ok: false, reason: '结构化创建凭据缺少 runId/target/instance' };
  }
  if (runId !== expected.runId || target !== expected.target || instance !== expected.instance) {
    return {
      ok: false,
      reason: `结构化创建凭据与本次运行不符（run=${runId} target=${target} instance=${instance}；期望 run=${
        expected.runId
      } target=${expected.target} instance=${expected.instance}）`,
    };
  }
  return { ok: true, credential: { runId, target, instance, created: true } };
};

export interface ProbeLifecycleTeardownSteps {
  /** shifted 连接释放：应在销毁探针前尽力执行。 */
  readonly destroyShifted?: (() => Promise<void>) | null;
  /** 本轮探针库清理：只有确认所有权且已授权时内部才执行 DROP。 */
  readonly dropProbe?: (() => Promise<void>) | null;
  /** 环境变量恢复：即使前面失败也必须尝试。 */
  readonly restoreEnv?: (() => void | Promise<void>) | null;
  /** app 关闭：执行 DROP 的主连接应在 DROP 尝试之后关闭。 */
  readonly closeApp?: (() => Promise<void>) | null;
}

/**
 * M03：逐步收尾，任一步失败都不阻止后续步骤。
 * 最早错误为主因（cause），其余错误按发生顺序并入消息，不静默吞掉。
 */
export const runProbeLifecycleTeardown = async (
  helper: string,
  steps: ProbeLifecycleTeardownSteps,
): Promise<void> => {
  const failures: Error[] = [];
  const record = (error: unknown): void => {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  };

  if (steps.destroyShifted) {
    try {
      await steps.destroyShifted();
    } catch (error) {
      record(error);
    }
  }
  if (steps.dropProbe) {
    try {
      await steps.dropProbe();
    } catch (error) {
      record(error);
    }
  }
  if (steps.restoreEnv) {
    try {
      await steps.restoreEnv();
    } catch (error) {
      record(error);
    }
  }
  if (steps.closeApp) {
    try {
      await steps.closeApp();
    } catch (error) {
      record(error);
    }
  }

  if (failures.length === 0) {
    return;
  }
  const [first, ...rest] = failures;
  if (rest.length === 0) {
    throw first;
  }
  throw new Error(
    `[${helper}] 探针库收尾出现 ${failures.length} 个失败；按发生顺序保留最初错误为主因：${first.message}；` +
      `其余失败（不得覆盖最初错误）：${rest.map((error) => error.message).join('；')}`,
    { cause: first },
  );
};
