// backend/scripts/task09-forensics-cleanup.safety.ts

/**
 * 任务 09 取证脚本的**收尾纪律**（纯逻辑层，可定向单测）。
 *
 * ## 为什么单列一层
 *
 * 两条取证脚本（原件上传×恢复冻结互斥、恢复故障现场受控解冻）此前都存在同一种收尾缺陷：
 *
 * - `finally` 里 `catch {}` **吞掉**清理异常 ⇒ 清理失败与"业务断言失败"无法区分，
 *   脚本仍可能以 0 退出 ⇒ **执行结果不能真实反映收尾状态**；
 * - 删除前**没有一次性预检** ⇒ 归属不符／被外部引用的对象也会被删；
 * - 数据库删除**不在同一事务** ⇒ 中途失败会留下"删一半"的现场；
 * - 非目标哨兵只比**数量** ⇒ 内容被改写而数量不变时照样通过。
 *
 * 本模块把这四件事收敛成**可单测的纯逻辑**：
 *
 * 1. `CleanupIssueLog`：收尾问题**逐条留痕**，不允许被吞掉；
 * 2. `runAtomicForensicsCleanup`：数据库删除在**同一个事务**里按"精确 ID ＋ 归属条件"执行，
 *    任一步失败 ⇒ 整体回滚（**无部分提交**）；
 * 3. `planForensicsCleanupSteps`：删除计划只允许**受控表**，并按"先子后父"排序；
 * 4. `collectResidue` / `buildSentinelEntries`：本轮零残留与非目标不变的核对口径。
 *
 * ## 边界
 *
 * - 本模块**不做** I/O：数据库与文件系统的实际操作由各脚本注入（便于用替身做反例测试）；
 * - 文件删除复用 `task09-restore-selfcheck.safety` 的受控根／符号链接／真实字节指纹能力，
 *   本模块不重复实现安全边界。
 */

import { DELETION_ORDER, SelfcheckSafetyError } from './task09-restore-selfcheck.safety';

/** 收尾问题的收集器：任何一条都**不许**被吞掉。 */
export class CleanupIssueLog {
  private readonly issues: string[] = [];

  /** 记录一条收尾问题 */
  record(issue: string): void {
    this.issues.push(issue);
  }

  /** 记录一条"带异常"的收尾问题（异常文本进问题清单，不进普通日志） */
  recordError(scope: string, error: unknown): void {
    this.issues.push(`${scope}：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 收尾问题清单（副本） */
  get list(): readonly string[] {
    return [...this.issues];
  }

  /** 是否存在收尾问题 */
  get hasIssues(): boolean {
    return this.issues.length > 0;
  }
}

/** 一次数据库删除步骤（主键 ＋ 归属条件 ⇒ 精确到"本轮创建的那一行"） */
export type ForensicsCleanupStep = {
  /** 受控表名（必须在受控顺序表内） */
  readonly table: string;
  /** 主键列名 */
  readonly idColumn: string;
  /** 主键值 */
  readonly id: string | number;
  /** 归属说明（写进回执，便于人工复核） */
  readonly ownership: string;
  /** 附加的精确条件（与主键一起构成 WHERE） */
  readonly conditions?: Readonly<Record<string, string | number | null>>;
  /** 附加的 LIKE 条件（与主键一起构成 WHERE；值只作**参数**传入，不拼进 SQL） */
  readonly likeConditions?: Readonly<Record<string, string>>;
};

/** 标识符白名单（表名／列名只允许字母、数字、下划线） */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * 生成删除计划：**只允许受控表**、只允许安全标识符、去重、按"先子后父"排序。
 *
 * 表不在受控顺序表内 ⇒ 直接拒绝（不进入删除路径）。
 */
export function planForensicsCleanupSteps(
  steps: ReadonlyArray<ForensicsCleanupStep>,
): ReadonlyArray<ForensicsCleanupStep> {
  for (const step of steps) {
    if (!DELETION_ORDER.includes(step.table)) {
      throw new SelfcheckSafetyError(
        'UNMANAGED_DELETION_TABLE',
        `拒绝删除不在受控顺序表内的对象：${step.table}`,
      );
    }
    if (!IDENTIFIER_PATTERN.test(step.idColumn)) {
      throw new SelfcheckSafetyError('UNSAFE_IDENTIFIER', `拒绝使用不合法的列名：${step.idColumn}`);
    }
    for (const column of Object.keys(step.conditions ?? {})) {
      if (!IDENTIFIER_PATTERN.test(column)) {
        throw new SelfcheckSafetyError('UNSAFE_IDENTIFIER', `拒绝使用不合法的条件列名：${column}`);
      }
    }
    for (const column of Object.keys(step.likeConditions ?? {})) {
      if (!IDENTIFIER_PATTERN.test(column)) {
        throw new SelfcheckSafetyError('UNSAFE_IDENTIFIER', `拒绝使用不合法的条件列名：${column}`);
      }
    }
  }
  const seen = new Set<string>();
  const unique: ForensicsCleanupStep[] = [];
  for (const step of steps) {
    const key = `${step.table}::${step.idColumn}::${String(step.id)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(step);
  }
  const orderIndex = new Map(DELETION_ORDER.map((table, index) => [table, index]));
  return unique.sort((left, right) => {
    const leftIndex = orderIndex.get(left.table) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.table) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

/**
 * 判定一个审计事件是否**可证明**属于本轮。
 *
 * 复核意见（任务 09 剩余问题 P2-2）：按"恢复 ID ＋ 事件类型"**批量**删除审计，
 * 会把同一恢复 ID 上**非本轮生成**的同类型事件一起删掉。
 * 因此删除必须落到**事件级**：只有能**逐条证明**属于本轮的事件才可删。
 *
 * 判定口径（**全部**满足才算本轮，缺一即视为外来 ⇒ 失败关闭）：
 * 1. 操作人是**本轮登记的账号**（别的账号写的事件不可证明属于本轮）；
 * 2. 事件类型与本轮一致（operation ＋ target_type）；
 * 3. 事件产生时间**不早于**本轮开始时刻（基线取数据库侧时间，避免时区口径漂移）。
 */
export function decideAuditEventOwnership(params: {
  readonly actorAccountId: number;
  readonly operation: string;
  readonly targetType: string;
  readonly createdAt: Date | string | null;
  readonly expectedActorAccountId: number;
  readonly expectedOperation: string;
  readonly expectedTargetType: string;
  readonly notBefore: Date;
}): 'OWNED' | 'FOREIGN' {
  if (params.actorAccountId !== params.expectedActorAccountId) {
    return 'FOREIGN';
  }
  if (params.operation !== params.expectedOperation) {
    return 'FOREIGN';
  }
  if (params.targetType !== params.expectedTargetType) {
    return 'FOREIGN';
  }
  if (params.createdAt === null) {
    return 'FOREIGN';
  }
  const createdAt =
    params.createdAt instanceof Date
      ? params.createdAt.getTime()
      : new Date(params.createdAt).getTime();
  if (Number.isNaN(createdAt) || createdAt < params.notBefore.getTime()) {
    return 'FOREIGN';
  }
  return 'OWNED';
}

/** 事务句柄（只需要能执行参数化 SQL） */
export type ForensicsCleanupTransaction = {
  query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
};
/** 事务执行器（由脚本注入真实 DataSource，或由测试注入替身） */
export type ForensicsCleanupExecutor = {
  transaction: <T>(run: (tx: ForensicsCleanupTransaction) => Promise<T>) => Promise<T>;
};

/** 文件清理裁决结果 */
export type ForensicsFileCleanupDecision = {
  /** 允许删除的存储引用 */
  readonly deletable: readonly string[];
  /** **保留**的存储引用（不删字节） */
  readonly kept: readonly string[];
  /** 裁决理由（供收尾问题留痕，不含敏感内容） */
  readonly reason: string;
};

/**
 * 裁决"数据库清理之后能不能删字节"。
 *
 * **文件清理与数据库删除无法同事务**，因此二者之间存在一个**不可原子**的窗口：
 * 数据库事务失败并回滚 ⇒ `stored_file` 行**仍在**⇒ 若此时把字节删掉，
 * 就留下"**行在、字节丢**"的部分清理（登记指向不存在的字节）。
 *
 * 规则（保守、失败关闭）：
 * 1. `databaseCleanupOk = false`（删除失败或**提交结果未知**）⇒ **一个字节都不删**；
 * 2. 某个引用在数据库里**仍有登记行** ⇒ 该引用**不删**（行还在就仍可能被引用）；
 * 3. 其余引用才允许删除。
 */
export function decideForensicsFileCleanup(params: {
  readonly databaseCleanupOk: boolean;
  readonly references: readonly string[];
  /** 数据库里仍有登记行的存储引用 */
  readonly referencedByLiveRow?: readonly string[];
}): ForensicsFileCleanupDecision {
  const references = [...new Set(params.references)];
  if (!params.databaseCleanupOk) {
    return {
      deletable: [],
      kept: references,
      reason:
        '数据库清理失败或提交结果未知 ⇒ 登记行可能仍在，保留全部字节（不做"行在、字节丢"的部分清理）',
    };
  }
  const live = new Set(params.referencedByLiveRow ?? []);
  const deletable: string[] = [];
  const kept: string[] = [];
  for (const reference of references) {
    if (live.has(reference)) {
      kept.push(reference);
      continue;
    }
    deletable.push(reference);
  }
  return {
    deletable,
    kept,
    reason:
      kept.length > 0
        ? '数据库清理成功，但部分引用仍有登记行 ⇒ 保留这些字节'
        : '数据库清理成功且无登记行残留 ⇒ 允许精确回收本轮字节',
  };
}

/** 删除结果 */
export type ForensicsCleanupResult =
  | { readonly ok: true; readonly deleted: readonly string[] }
  | {
      readonly ok: false;
      /** 失败的那一步（事务本身失败时为 null） */
      readonly failedStep: ForensicsCleanupStep | null;
      readonly error: unknown;
    };

/**
 * 在**同一个事务**里按顺序执行删除步骤。
 *
 * - 每一步都是"精确主键 ＋ 归属条件"⇒ 不会误删同表其它行；
 * - 任一步失败 ⇒ 事务**整体回滚** ⇒ **无部分提交**（不会留下"删一半"的现场）；
 * - 失败时返回失败步骤与原始异常（**不吞掉**），由调用方决定退出码。
 */
export async function runAtomicForensicsCleanup(
  steps: ReadonlyArray<ForensicsCleanupStep>,
  executor: ForensicsCleanupExecutor,
): Promise<ForensicsCleanupResult> {
  const deleted: string[] = [];
  let failedStep: ForensicsCleanupStep | null = null;
  try {
    await executor.transaction(async (tx) => {
      for (const step of steps) {
        failedStep = step;
        const conditions = Object.entries(step.conditions ?? {});
        const likeConditions = Object.entries(step.likeConditions ?? {});
        const where = [
          `${step.idColumn} = ?`,
          ...conditions.map(([column]) => `${column} = ?`),
          ...likeConditions.map(([column]) => `${column} LIKE ?`),
        ].join(' AND ');
        const params: unknown[] = [
          step.id,
          ...conditions.map(([, value]) => value),
          ...likeConditions.map(([, value]) => value),
        ];
        await tx.query(`DELETE FROM ${step.table} WHERE ${where}`, params);
        deleted.push(`${step.table}#${step.id}`);
      }
    });
  } catch (error: unknown) {
    return { ok: false, failedStep, error };
  }
  return { ok: true, deleted };
}

/** 残留事实（期望本轮清干净的对象） */
export type ResidueFact = {
  readonly label: string;
  /** 仍然存在的行数／文件数 */
  readonly rows: number;
};

/**
 * 收集"本轮对象未清干净"的残留问题。
 *
 * 本轮零残留与"非目标不变"是**两件独立的事**：前者证明"我造的都收干净了"，
 * 后者证明"我没碰到别人的"。两者必须各自成立。
 */
export function collectResidue(facts: ReadonlyArray<ResidueFact>): readonly string[] {
  return facts
    .filter((fact) => fact.rows > 0)
    .map((fact) => `${fact.label} 仍有 ${String(fact.rows)} 行／项残留`);
}

/** 哨兵条目（稳定标识 ＋ 指纹） */
export type SentinelEntry = {
  readonly label: string;
  readonly fingerprint: string;
};

/** 由行数据生成哨兵条目（标签取稳定标识，指纹由调用方给） */
export function buildSentinelEntries(
  rows: ReadonlyArray<{ readonly label: string; readonly fingerprint: string }>,
): readonly SentinelEntry[] {
  return rows.map((row) => ({ label: row.label, fingerprint: row.fingerprint }));
}

/** 哨兵比对结果 */
export type SentinelComparison = {
  /** before 有、after 没有（非目标对象**消失**） */
  readonly missing: readonly string[];
  /** 前后都在，但指纹变了（非目标对象**被改写**） */
  readonly changed: readonly string[];
  /** after 有、before 没有（**新出现**的对象） */
  readonly added: readonly string[];
};

/**
 * 比对两组哨兵（按**稳定标识**逐条比，不比数量）。
 *
 * 三个维度必须**分开看**，因为它们含义不同：
 * - `missing`／`changed`：**非目标对象被动了** ⇒ 一律是失败；
 * - `added`：新出现的对象。
 *   - 对"其它公司范围的冻结"这类非目标 ⇒ 新出现也是失败（说明越界写了别人的范围）；
 *   - 对"本轮自己产生的文件" ⇒ **运行中**出现是正常的，
 *     但**收尾后**必须消失（由"本轮零残留"单独核对）。
 */
export function compareSentinelEntries(
  before: ReadonlyArray<{ readonly label: string; readonly fingerprint: string }>,
  after: ReadonlyArray<{ readonly label: string; readonly fingerprint: string }>,
): SentinelComparison {
  const beforeMap = new Map(before.map((item) => [item.label, item.fingerprint]));
  const afterMap = new Map(after.map((item) => [item.label, item.fingerprint]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [label, fingerprint] of beforeMap) {
    const current = afterMap.get(label);
    if (current === undefined) {
      missing.push(label);
      continue;
    }
    if (current !== fingerprint) {
      changed.push(label);
    }
  }
  const added: string[] = [];
  for (const label of afterMap.keys()) {
    if (!beforeMap.has(label)) {
      added.push(label);
    }
  }
  return { missing, changed, added };
}
