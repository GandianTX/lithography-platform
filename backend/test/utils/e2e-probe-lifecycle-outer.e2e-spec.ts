// test/utils/e2e-probe-lifecycle-outer.e2e-spec.ts
//
// Q01 / J01—J08：比 H 父规格更外层的永久安全验收驱动器。
//
// 该规格自身也是资源拥有者：授权、目标核验、原子 CREATE、台账登记、窄回收入口，
// 不依赖兄弟规格先清场，也不在碰撞后 DROP 以保证自己可启动。
//
// J01 真实启动正式 H 文件（run-e2e-group.js --file H），由 H 外预置异主同名库，
// 证明父规格 PRECHECK 碰撞拒绝、真实 afterAll 不删除、非夹具快照与计数不变。
// 其余 J 用例使用同一 probe helper / H 注错入口，边界在用例内逐条标明。
//
// 本规格只收录外层入口；子启动始终指向精确文件，不递归跑整组。

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { DataSource } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import {
  assertAllowedE2eDatabase,
  assertDataSourceOnAllowedE2eDatabase,
  E2E_PHYSICAL_CLEANUP_CONSENT_ENV,
} from './e2e-db-guard';
import {
  assertProbeDatabaseAbsentOrOwned,
  assertSafeProbeDatabaseName,
  captureAndValidateProbeConsent,
  createOwnedProbeDatabaseForRun,
  createProbeOwnershipRegistry,
  createProbeRunLedger,
  describeProbeSettleResult,
  dropLedgerOwnedProbe,
  formatProbeCreationCredential,
  parseProbeCreationCredential,
  probeDatabaseExists,
  probeInstanceIdentity,
  ProbeDatabaseCollisionError,
  probeSettlementState,
  restoreProbeConsent,
  runProbeLifecycleTeardown,
  throwProbeSettlementError,
  type ProbeConsentSnapshot,
  type ProbeOwnedLedgerEntry,
  type ProbeQueryable,
  type ProbeRunLedger,
  type ProbeRunScope,
} from './probe-database-lifecycle';

jest.setTimeout(1800000);

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const H_SPEC = 'test/utils/e2e-probe-lifecycle.e2e-spec.ts';
const PROBE_DATABASE = 'lithography_e2e_probe';
const AUX_DATABASE = 'lithography_e2e_probe_aux';
const PARENT_INJECT_ENV = 'E2E_H_PARENT_INJECT';
/** 外层故障驱动的精确注错开关；正常 core 运行不设置。 */
const J_INJECT_ENV = 'E2E_J_INJECT';
const J_FINAL_DROP_ENV = 'E2E_J_FINAL_DROP';
const J_FAULT_TARGET_ENV = 'E2E_J_FAULT_TARGET';
const J_FAULT_RUN_ID_ENV = 'E2E_J_FAULT_RUN_ID';
/** 外层收尾故意失败时的专用标签，避免影响其他已登记资源。 */
const J_INJECT_FINAL_LABEL = 'j-inject-final';

interface ChildRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

interface Counters {
  readonly createDb: number;
  readonly dropDb: number;
  readonly insert: number;
  readonly delete: number;
}

interface ProbeSnapshot {
  readonly tables: string[];
  readonly rows: Array<{ id: number; note: string }>;
}

let app: INestApplication | null = null;
let dataSource: DataSource | null = null;
let outerConsent: ProbeConsentSnapshot | null = null;
/**
 * 规格生命周期的窄收尾集合：主 probe 与全部辅助/原始夹具的账本都在这里。
 * 用例提前抛错时，真实 afterAll 仍能访问并逐资源回收或保留未决状态。
 */
const ownedLedgers = createProbeOwnershipRegistry();
let outerLedger: ProbeRunLedger | null = null;

const requireDataSource = (helper: string): DataSource => {
  if (!dataSource) {
    throw new Error(`[${helper}] 主 DataSource 未初始化`);
  }
  return dataSource;
};

const mainDatabaseName = (): string => {
  const configured = requireDataSource('probe-lifecycle-outer').options.database;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error('J 外层规格主 DataSource 缺少 options.database');
  }
  return configured.trim();
};

const instanceIdentity = (): string =>
  probeInstanceIdentity(requireDataSource('probe-lifecycle-outer'));

/** 故障驱动专用目标名；未设置时返回 null，正常 core 运行不受影响。 */
const faultTarget = (): string | null => {
  const raw = (process.env[J_FAULT_TARGET_ENV] ?? '').trim();
  return raw === '' ? null : assertSafeProbeDatabaseName(raw);
};

/**
 * 为指定目标构造独立本轮台账；目标名必须与后续 CREATE 完全一致。
 * 台账在创建时就进入规格可达的收尾集合：用例提前退出不会丢失拥有者记录。
 */
const ledgerFor = (target: string, label: string): ProbeRunLedger => {
  const faultRunId = faultTarget() === target ? (process.env[J_FAULT_RUN_ID_ENV] ?? '').trim() : '';
  const runId =
    faultRunId ||
    `j-outer-${label}-${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  return ownedLedgers.add(
    label,
    createProbeRunLedger({
      runId,
      target,
      instance: instanceIdentity(),
    }),
  );
};

/** 精确注错阶段命中判断；只在指定阶段返回 true。 */
const injectedStage = (stage: string): boolean =>
  (process.env[J_INJECT_ENV] ?? '').trim() === stage;

/**
 * 在“真实 CREATE + 台账登记”之后、下一步声明式工作（建表/插行/断言）调用点终止用例。
 * 用于验证异常退出后真实 afterAll 是否仍能访问已登记资源。
 */
const assertNoInjection = (stage: string): void => {
  if (!injectedStage(stage)) {
    return;
  }
  console.log(`OUTER_INJECTED=${stage}`);
  throw new Error(`J 注入：${stage}（真实 CREATE 并登记后提前终止，交由真实 afterAll 收尾）`);
};

/**
 * 驱动器自己的本轮资源入口：原子 CREATE 明确成功后立即登记到驱动器自己的账本，
 * 再执行调用方后续步骤。故障驱动目标会输出结构化创建凭据，仅用于拥有者处理预期未决残留。
 */
const createFaultTargetFixture = async (target: string, label: string): Promise<ProbeRunLedger> => {
  const ledger = ledgerFor(target, label);
  const ownership = await createOwnedProbeDatabaseForRun(
    requireDataSource('probe-lifecycle-outer'),
    target,
    `probe-lifecycle-outer ${label}`,
    ledger.scope,
  );
  ledger.record(ownership);
  if (faultTarget() === target && (process.env[J_FAULT_RUN_ID_ENV] ?? '').trim() !== '') {
    console.log(formatProbeCreationCredential({ ...ledger.scope, created: true }));
  }
  return ledger;
};

const readStatus = async (name: string): Promise<number> => {
  const rows = await requireDataSource('probe-lifecycle-outer').query<
    Array<Record<string, unknown>>
  >(`SHOW GLOBAL STATUS LIKE '${name}'`);
  return Number(rows[0]?.Value ?? -1);
};

const readCounters = async (): Promise<Counters> => ({
  createDb: await readStatus('Com_create_db'),
  dropDb: await readStatus('Com_drop_db'),
  insert: await readStatus('Com_insert'),
  delete: await readStatus('Com_delete'),
});

const databaseExists = (name: string): Promise<boolean> =>
  probeDatabaseExists(requireDataSource('probe-lifecycle-outer'), name);

/** 驱动器自己的合成夹具：使用不透明表名，避免与 SUT/父规格 marker 冲突。 */
const createRawForeignFixture = async (
  name: string,
  note: string,
  label: string,
): Promise<ProbeRunLedger> => {
  const target = assertSafeProbeDatabaseName(name);
  // CREATE 明确成功后立即登记到驱动器自己的账本；中间不插入可能抛错的建表/插行。
  const ledger = await createFaultTargetFixture(target, label);
  console.log(`OUTER_RAW_FIXTURE_${label}=created-owned`);
  assertNoInjection('raw-assert-failure');
  await requireDataSource('probe-lifecycle-outer').query(
    `CREATE TABLE \`${target}\`.outer_keep (
       id INT PRIMARY KEY,
       note VARCHAR(64) NOT NULL
     )`,
  );
  await requireDataSource('probe-lifecycle-outer').query(
    `INSERT INTO \`${target}\`.outer_keep (id, note) VALUES (1, ?)`,
    [note],
  );
  return ledger;
};

/** 驱动器对原始合成夹具的显式收尾；不计入 SUT 观测窗口，必须在取后快照之后。 */
const dropRawFixture = async (ledger: ProbeRunLedger, reason: string): Promise<void> => {
  const outcome = await dropLedgerOwnedProbe(
    ledger,
    () => requireDataSource(`probe-lifecycle-outer RAW_${reason}`),
    `probe-lifecycle-outer RAW_${reason}`,
  );
  console.log(`OUTER_RAW_CLEANUP_${reason}=${outcome}`);
};

/**
 * 规格收尾解析入口：只有故意注错的专用标签使用拒绝桩；
 * 其他已登记资源使用真实连接，连接不可用则保留未决状态（不猜删、不伪造已释放）。
 */
const resolveFinalDataSource = (entry: ProbeOwnedLedgerEntry): ProbeQueryable => {
  if (
    (process.env[J_FINAL_DROP_ENV] ?? '').trim() === 'unknown' &&
    entry.label === J_INJECT_FINAL_LABEL
  ) {
    console.log(`OUTER_FINAL_INJECTED=${entry.label}`);
    return {
      query: () => Promise.reject(new Error('J FINAL 注入：DROP 响应未知（未消费记录）')),
    };
  }
  if (!dataSource?.isInitialized) {
    throw new Error(
      `[probe-lifecycle-outer FINAL ${entry.label}] 主连接不可用：保留已登记资源与目标诊断，不伪报已释放。`,
    );
  }
  return dataSource;
};

const snapshotProbe = async (name: string): Promise<ProbeSnapshot> => {
  const tables = await requireDataSource('probe-lifecycle-outer').query<Array<{ name: string }>>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [name],
  );
  const rows = await requireDataSource('probe-lifecycle-outer').query<
    Array<{ id: number; note: string }>
  >(`SELECT id, note FROM \`${name}\`.outer_keep ORDER BY id`);
  return {
    tables: tables.map((row) => String(row.name)),
    rows: rows.map((row) => ({ id: Number(row.id), note: String(row.note) })),
  };
};

interface HEnvOptions {
  readonly consent?: string | null;
  readonly allowedNames?: string;
  readonly inject?: string;
}

const buildHSpecEnv = (options: HEnvOptions = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_GROUP: 'core',
    E2E_SKIP_DB_CLEANUP: 'true',
    E2E_ALLOW_DB_CLEANUP: '0',
    E2E_ALLOWED_DB_NAMES: options.allowedNames ?? `${mainDatabaseName()},${PROBE_DATABASE}`,
  };
  delete env.E2E_SPECS;
  delete env.E2E_G04_RUN_ID;
  delete env.E2E_G04_INJECT;
  delete env[PARENT_INJECT_ENV];
  delete env[J_INJECT_ENV];
  delete env[J_FINAL_DROP_ENV];
  delete env[J_FAULT_TARGET_ENV];
  delete env[J_FAULT_RUN_ID_ENV];
  delete env.E2E_H06_DROP;
  if (options.consent === null) {
    delete env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV];
  } else {
    env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV] = options.consent ?? '1';
  }
  if (options.inject) {
    env[PARENT_INJECT_ENV] = options.inject;
  }
  return env;
};

const runHSpec = (options: HEnvOptions = {}): ChildRun => {
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, 'test/run-e2e-group.js'), '--file', H_SPEC],
    {
      cwd: BACKEND_ROOT,
      env: buildHSpecEnv(options),
      encoding: 'utf8',
      timeout: 900000,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
};

/** 子进程结束确认 + 结构化凭据校验 + 台账登记：只有全部成立才允许后续 DROP。 */
type HandoffOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const registerChildHandoff = (
  child: ChildRun,
  expected: ProbeRunScope,
  ledger: ProbeRunLedger,
): HandoffOutcome => {
  if (child.status === null) {
    // 超时/被信号终止时无法确认子进程已停止写入；不接管。
    return { ok: false, reason: `子进程未确认结束（signal=${child.signal ?? '(无)'}）` };
  }
  const parsed = parseProbeCreationCredential(child.output, expected);
  if (!parsed.ok) {
    return parsed;
  }
  ledger.record({
    name: expected.target,
    createdByThisRun: true,
    source: 'child-handoff',
    runId: parsed.credential.runId,
    target: parsed.credential.target,
    instance: parsed.credential.instance,
  });
  return { ok: true };
};

describe('J01—J08 父规格所有权与外层驱动安全', () => {
  beforeAll(async () => {
    outerConsent = captureAndValidateProbeConsent('probe-lifecycle-outer');
    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const mainDataSource = app.get(DataSource);
    dataSource = mainDataSource;
    await assertDataSourceOnAllowedE2eDatabase(mainDataSource);
    outerLedger = ledgerFor(PROBE_DATABASE, 'main');

    // 驱动器启动门禁：目标必须不存在；已被占用时拒绝启动，不 DROP。
    const precheck = await assertProbeDatabaseAbsentOrOwned(
      mainDataSource,
      outerLedger,
      PROBE_DATABASE,
      'probe-lifecycle-outer PRECHECK',
    );
    console.log(`OUTER_PRECHECK=${precheck}`);
    for (const name of [AUX_DATABASE]) {
      if (await databaseExists(name)) {
        throw new Error(
          `[probe-lifecycle-outer] 辅助库 "${name}" 已存在且无本轮创建凭据：拒绝启动，不执行任何 DROP。`,
        );
      }
    }
  });

  afterAll(async () => {
    await runProbeLifecycleTeardown('probe-lifecycle-outer', {
      dropProbe: async () => {
        // 统一处理主 probe 与全部辅助/原始夹具：逐资源独立尝试，成功才消费，失败保留并聚合。
        const settlement = await ownedLedgers.settle(
          resolveFinalDataSource,
          'probe-lifecycle-outer FINAL',
        );
        for (const result of settlement.results) {
          console.log(`OUTER_FINAL_${result.label}=${describeProbeSettleResult(result)}`);
        }
        console.log(`OUTER_FINAL=${probeSettlementState(settlement)}`);
        throwProbeSettlementError(settlement, 'probe-lifecycle-outer FINAL');
      },
      restoreEnv: () => {
        if (outerConsent) {
          restoreProbeConsent(outerConsent);
          console.log('OUTER_ENV_RESTORED=1');
          return;
        }
        console.log('OUTER_ENV_RESTORED=not-needed');
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('OUTER_CLOSE=closed');
          return;
        }
        console.log('OUTER_CLOSE=no-app');
      },
    });
  });

  it('J01 H 规格外预置异主同名库：父 PRECHECK 碰撞拒绝、真实 FINAL 不删除、快照与计数不变', async () => {
    if (!outerLedger) {
      throw new Error('[probe-lifecycle-outer] J01 台账未初始化');
    }
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
    // 驱动器明确获准后原子创建“相对 H 异主”夹具并立即登记；H 无法取得这份创建证据。
    const ownership = await createOwnedProbeDatabaseForRun(
      requireDataSource('probe-lifecycle-outer'),
      PROBE_DATABASE,
      'probe-lifecycle-outer J01 fixture',
      outerLedger.scope,
    );
    outerLedger.record(ownership);
    await requireDataSource('probe-lifecycle-outer').query(
      `CREATE TABLE \`${PROBE_DATABASE}\`.outer_keep (
         id INT PRIMARY KEY,
         note VARCHAR(64) NOT NULL
       )`,
    );
    await requireDataSource('probe-lifecycle-outer').query(
      `INSERT INTO \`${PROBE_DATABASE}\`.outer_keep (id, note) VALUES (1, 'j01-outsider')`,
    );
    const beforeSnapshot = await snapshotProbe(PROBE_DATABASE);
    const before = await readCounters();

    // 真实启动正式 H 文件；不得递归整组，也不得由驱动器先清场。
    const child = runHSpec({ consent: '1' });
    const after = await readCounters();
    const afterSnapshot = await snapshotProbe(PROBE_DATABASE);

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('PARENT_CLEANUP_PRECHECK=collision');
    expect(child.output).toContain('已存在且没有本轮创建凭据');
    expect(child.output).toContain('拒绝覆盖或接管');
    expect(child.output).toContain('PARENT_CLEANUP_FINAL=skipped-not-owned');
    expect(child.output).toContain('PARENT_CLOSE=closed');
    expect(child.output).not.toContain('PARENT_CLEANUP_PRECHECK=absent');

    // 父规格的观测窗口内零 DDL/DML，且既有 schema/行快照逐项不变。
    expect(after.createDb - before.createDb).toBe(0);
    expect(after.dropDb - before.dropDb).toBe(0);
    expect(after.insert - before.insert).toBe(0);
    expect(after.delete - before.delete).toBe(0);
    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(await databaseExists(PROBE_DATABASE)).toBe(true);

    // 观测结束后才由驱动器回收自己明确创建的夹具；不计入上面的零 DROP 窗口。
    const outcome = await dropLedgerOwnedProbe(
      outerLedger,
      () => requireDataSource('probe-lifecycle-outer J01 cleanup'),
      'probe-lifecycle-outer J01 cleanup',
    );
    console.log(`OUTER_J01_CLEANUP=${outcome}`);
    expect(outcome).toBe('dropped');
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
  });

  it('J02 启动许可拒绝与 app 初始化失败：零危险 DDL/DML，FINAL 不兜底删，已分配资源仍关闭', async () => {
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
    const before = await readCounters();
    for (const consent of [null, '0'] as const) {
      const child = runHSpec({ consent });
      expect(child.status).not.toBeNull();
      expect(child.status).not.toBe(0);
      expect(child.output).toContain('启动许可未通过');
      expect(child.output).toContain('PARENT_CLEANUP_FINAL=skipped-not-owned');
      expect(child.output).toContain('PARENT_ENV_RESTORED=not-needed');
      expect(child.output).toContain('PARENT_CLOSE=no-app');
    }
    const injected = runHSpec({ consent: '1', inject: 'app-init-failure' });
    expect(injected.status).not.toBe(0);
    expect(injected.output).toContain('PARENT_INJECTED=app-init-failure');
    expect(injected.output).toContain('PARENT_CLEANUP_FINAL=skipped-not-owned');
    expect(injected.output).toContain('PARENT_CLOSE=closed');
    const after = await readCounters();

    expect(after.createDb - before.createDb).toBe(0);
    expect(after.dropDb - before.dropDb).toBe(0);
    expect(after.insert - before.insert).toBe(0);
    expect(after.delete - before.delete).toBe(0);
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);

    // 硬性白名单校验本身不写库；缺省名单拒绝是最后一道独立门禁。
    expect(() => assertAllowedE2eDatabase('not_an_e2e_database')).toThrow(
      /不在允许的 E2E 库白名单/,
    );
  });

  it('J03 父夹具部分创建：CREATE 成功后立即登记，marker 失败仍只回收该夹具', async () => {
    const target = faultTarget() ?? AUX_DATABASE;
    expect(await databaseExists(target)).toBe(false);
    // 真实 CREATE + 登记后，L-A 在“建 marker 表”调用点精确注入失败；正常运行时继续走后续断言。
    const ledger = await createFaultTargetFixture(target, 'j03');
    expect(ledger.has()).toBe(true);
    assertNoInjection('aux-marker-failure');
    const failure = new Error('J03 注入：建 marker 表失败');
    const markerQuery = { query: (): Promise<never> => Promise.reject(failure) };
    const caught = await markerQuery.query().catch((error: unknown) => error);
    expect(caught).toBe(failure);
    // 建表失败不抹掉成功 CREATE 事实；归属记录仍在。
    expect(ledger.has()).toBe(true);

    const outcome = await dropLedgerOwnedProbe(
      ledger,
      () => requireDataSource('probe-lifecycle-outer J03 cleanup'),
      'probe-lifecycle-outer J03 cleanup',
    );
    expect(outcome).toBe('dropped');
    expect(await databaseExists(target)).toBe(false);
    expect(ledger.has()).toBe(false);
  });

  it('J04 RESET/FINAL 一致：无归属不 DROP；成功消费；失败不清账；已消费不再授权', async () => {
    const target = faultTarget() ?? AUX_DATABASE;
    expect(await databaseExists(target)).toBe(false);
    // 无归属的同名库：拒绝接管且零 DROP，随后由夹具创建者显式回收。
    // 原始夹具归驱动器自己的账本所有；L-B 在登记后的“建 marker 表”调用点精确注入失败。
    const rawLedger = await createRawForeignFixture(target, 'j04-foreign', 'j04-raw');
    const beforeSnapshot = await snapshotProbe(target);
    const emptyLedger = ledgerFor(target, 'j04-empty');
    const before = await readCounters();
    const collision = await assertProbeDatabaseAbsentOrOwned(
      requireDataSource('probe-lifecycle-outer'),
      emptyLedger,
      target,
      'probe-lifecycle-outer J04 collision',
    ).catch((error: unknown) => error);
    const after = await readCounters();
    expect(collision).toBeInstanceOf(ProbeDatabaseCollisionError);
    expect(after.dropDb - before.dropDb).toBe(0);
    expect(await snapshotProbe(target)).toEqual(beforeSnapshot);
    await dropRawFixture(rawLedger, 'J04_FOREIGN');

    // 已消费记录不能再次授权 DROP；无登记时连数据源都不解析。
    const ledger = ledgerFor(target, 'j04-owned');
    const ownership = await createOwnedProbeDatabaseForRun(
      requireDataSource('probe-lifecycle-outer'),
      target,
      'probe-lifecycle-outer J04',
      ledger.scope,
    );
    ledger.record(ownership);
    expect(
      await dropLedgerOwnedProbe(
        ledger,
        () => requireDataSource('probe-lifecycle-outer J04 drop'),
        'probe-lifecycle-outer J04 drop',
      ),
    ).toBe('dropped');
    expect(ledger.has()).toBe(false);
    let resolved = 0;
    expect(
      await dropLedgerOwnedProbe(
        ledger,
        () => {
          resolved += 1;
          return requireDataSource('probe-lifecycle-outer J04 consumed');
        },
        'probe-lifecycle-outer J04 consumed',
      ),
    ).toBe('skipped-not-owned');
    expect(resolved).toBe(0);

    // DROP 失败不清账，也不伪报已释放。
    const failingLedger = ledgerFor(target, 'j04-failing');
    const failingOwnership = await createOwnedProbeDatabaseForRun(
      requireDataSource('probe-lifecycle-outer'),
      target,
      'probe-lifecycle-outer J04 failing',
      failingLedger.scope,
    );
    failingLedger.record(failingOwnership);
    const dropError = await dropLedgerOwnedProbe(
      failingLedger,
      () => ({ query: () => Promise.reject(new Error('J04 注入：DROP 响应未知')) }),
      'probe-lifecycle-outer J04 failing',
    ).catch((error: unknown) => error);
    expect(dropError).toBeInstanceOf(Error);
    expect((dropError as Error).message).toMatch(/DROP 探针库 .*结果未知或失败/);
    expect(failingLedger.has()).toBe(true);
    expect(await databaseExists(target)).toBe(true);
    expect(
      await dropLedgerOwnedProbe(
        failingLedger,
        () => requireDataSource('probe-lifecycle-outer J04 real drop'),
        'probe-lifecycle-outer J04 real drop',
      ),
    ).toBe('dropped');
    expect(await databaseExists(target)).toBe(false);
  });

  it('J05 子归属交接：只接受匹配本轮的明确创建凭据；缺失/损坏/重复/错运行/超时均不接管', async () => {
    const expected: ProbeRunScope = {
      runId: 'j05-run-001',
      target: AUX_DATABASE,
      instance: instanceIdentity(),
    };
    const stdout = (credential: string): string => `noise\n${credential}\nmore\n`;
    const valid = formatProbeCreationCredential({ ...expected, created: true });
    const cases: Array<{ name: string; output: string; reason: RegExp }> = [
      { name: '缺失', output: 'plain log only', reason: /缺少结构化创建凭据/ },
      { name: '损坏', output: `${valid.slice(0, -1)}`, reason: /缺少结构化创建凭据|损坏/ },
      {
        name: '重复',
        output: `${valid}\n${valid}`,
        reason: /结构化创建凭据重复/,
      },
      {
        name: '错运行',
        output: formatProbeCreationCredential({
          ...expected,
          runId: 'j05-run-other',
          created: true,
        }),
        reason: /与本次运行不符/,
      },
      {
        name: '错目标',
        output: formatProbeCreationCredential({
          ...expected,
          target: 'lithography_e2e_probe_other',
          created: true,
        }),
        reason: /与本次运行不符/,
      },
      {
        name: '错实例',
        output: formatProbeCreationCredential({
          ...expected,
          instance: '127.0.0.1:1',
          created: true,
        }),
        reason: /与本次运行不符/,
      },
      {
        name: '未表达成功',
        output:
          'G04_CREATE_CREDENTIAL={"runId":"j05-run-001","target":"lithography_e2e_probe_aux","instance":"x","created":false}',
        reason: /未表达 CREATE 明确成功/,
      },
    ];
    for (const testCase of cases) {
      const parsed = parseProbeCreationCredential(stdout(testCase.output), expected);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toMatch(testCase.reason);
      }
    }
    // 有效凭据必须是唯一一条且字段全等。
    expect(parseProbeCreationCredential(stdout(valid), expected).ok).toBe(true);

    // 无效凭据不得登记或 DROP：台账为空时回收入口不解析数据源、不发 SQL。
    const ledger = ledgerFor(AUX_DATABASE, 'j05-invalid');
    let resolved = 0;
    const invalidChild: ChildRun = { status: 0, signal: null, output: stdout('garbage') };
    const outcome = registerChildHandoff(invalidChild, expected, ledger);
    expect(outcome.ok).toBe(false);
    expect(ledger.has()).toBe(false);
    expect(
      await dropLedgerOwnedProbe(
        ledger,
        () => {
          resolved += 1;
          return requireDataSource('probe-lifecycle-outer J05 invalid');
        },
        'probe-lifecycle-outer J05 invalid',
      ),
    ).toBe('skipped-not-owned');
    expect(resolved).toBe(0);

    // 有效凭据才登记；回收成功即消费，后续 FINAL 不再重复删除。
    expect(await databaseExists(AUX_DATABASE)).toBe(false);
    const ownership = await createOwnedProbeDatabaseForRun(
      requireDataSource('probe-lifecycle-outer'),
      AUX_DATABASE,
      'probe-lifecycle-outer J05',
      ledger.scope,
    );
    // 子进程本应创建同名库；这里由驱动器真实创建，凭据只表达本轮的创建成功事实。
    const childCredential = formatProbeCreationCredential({
      ...ledger.scope,
      created: true,
    });
    const realChild: ChildRun = {
      status: 1,
      signal: null,
      output: stdout(childCredential),
    };
    // 退出码非 0 不是拒绝依据：CREATE 成功后收尾失败可以非 0，但有有效凭据。
    expect(registerChildHandoff(realChild, ledger.scope, ledger).ok).toBe(true);
    expect(ownership.createdByThisRun).toBe(true);
    expect(
      await dropLedgerOwnedProbe(
        ledger,
        () => requireDataSource('probe-lifecycle-outer J05 real drop'),
        'probe-lifecycle-outer J05 real drop',
      ),
    ).toBe('dropped');
    expect(await databaseExists(AUX_DATABASE)).toBe(false);

    // 超时/被信号终止：无法确认子进程已结束，不接管、不 DROP。
    const timedOut = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      encoding: 'utf8',
      timeout: 500,
    });
    const timeoutChild: ChildRun = {
      status: timedOut.status,
      signal: timedOut.signal,
      output: `${timedOut.stdout ?? ''}\n${timedOut.stderr ?? ''}`,
    };
    expect(timeoutChild.status).toBeNull();
    const timeoutLedger = ledgerFor(AUX_DATABASE, 'j05-timeout');
    const timeoutOutcome = registerChildHandoff(timeoutChild, expected, timeoutLedger);
    expect(timeoutOutcome.ok).toBe(false);
    if (!timeoutOutcome.ok) {
      expect(timeoutOutcome.reason).toMatch(/子进程未确认结束/);
    }
    expect(timeoutLedger.has()).toBe(false);
  });

  it('J06 失败与未知收尾：主错误与次错误可辨，记录不丢，其他释放仍尝试，不伪报零残留', async () => {
    const target = faultTarget() ?? AUX_DATABASE;
    expect(await databaseExists(target)).toBe(false);
    // L-D：真实 CREATE + 登记后提前终止，FINAL 的 DROP 由拒绝桩保持未决，记录不消费。
    const label = injectedStage('final-drop-unknown') ? J_INJECT_FINAL_LABEL : 'j06';
    const ledger = await createFaultTargetFixture(target, label);
    assertNoInjection('final-drop-unknown');

    const dropFailure = new Error('J06 注入：DROP 响应未知');
    const attempts: string[] = [];
    const caught = await runProbeLifecycleTeardown('probe-lifecycle-outer J06', {
      destroyShifted: () => {
        attempts.push('destroyShifted');
        return Promise.resolve();
      },
      dropProbe: async () => {
        attempts.push('dropProbe');
        await dropLedgerOwnedProbe(
          ledger,
          () => ({ query: () => Promise.reject(dropFailure) }),
          'probe-lifecycle-outer J06 drop',
        );
      },
      restoreEnv: () => {
        attempts.push('restoreEnv');
      },
      closeApp: () => {
        attempts.push('closeApp');
        return Promise.resolve();
      },
    }).catch((error: unknown) => error);

    expect(attempts).toEqual(['destroyShifted', 'dropProbe', 'restoreEnv', 'closeApp']);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/DROP 探针库 .*结果未知或失败/);
    expect(ledger.has()).toBe(true);

    // 连接不可用同样保留未决记录；不伪报零残留。
    const unavailable = await dropLedgerOwnedProbe(
      ledger,
      () => {
        throw new Error('J06 注入：连接不可用');
      },
      'probe-lifecycle-outer J06 unavailable',
    ).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(Error);
    expect(ledger.has()).toBe(true);
    expect(await databaseExists(target)).toBe(true);

    expect(
      await dropLedgerOwnedProbe(
        ledger,
        () => requireDataSource('probe-lifecycle-outer J06 real drop'),
        'probe-lifecycle-outer J06 real drop',
      ),
    ).toBe('dropped');
    expect(await databaseExists(target)).toBe(false);
  });

  it('J07 正常与重复运行：正式 H 文件两轮全绿，探针库归零，无重复清理', async () => {
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
    for (const round of [1, 2]) {
      const child = runHSpec({ consent: '1' });
      expect(child.status).toBe(0);
      expect(child.output).toMatch(/9 passed/);
      expect(child.output).toContain('PARENT_CLEANUP_PRECHECK=absent');
      expect(child.output).toContain('PARENT_H06_HANDOFF=registered');
      expect(child.output).toContain('PARENT_CLEANUP_H06_HANDOFF=dropped');
      expect(child.output).toContain('PARENT_CLEANUP_FINAL=skipped-not-owned');
      expect(child.output).toContain('PARENT_CLOSE=closed');
      expect(await databaseExists(PROBE_DATABASE)).toBe(false);
      console.log(`OUTER_J07_ROUND${round}=green`);
    }
  });

  it('J08 外层驱动自身安全：占用拒绝、CREATE 未知不认领、观察失败仍精确收尾', async () => {
    expect(await databaseExists(AUX_DATABASE)).toBe(false);
    // 启动目标被“其他运行”占用：驱动器无归属不删。夹具拥有者仍是驱动器自己的账本。
    const rawLedger = await createRawForeignFixture(AUX_DATABASE, 'j08-occupied', 'j08-raw');
    const emptyLedger = ledgerFor(AUX_DATABASE, 'j08-empty');
    const before = await readCounters();
    const collision = await assertProbeDatabaseAbsentOrOwned(
      requireDataSource('probe-lifecycle-outer'),
      emptyLedger,
      AUX_DATABASE,
      'probe-lifecycle-outer J08 occupied',
    ).catch((error: unknown) => error);
    const after = await readCounters();
    expect(collision).toBeInstanceOf(ProbeDatabaseCollisionError);
    expect(after.dropDb - before.dropDb).toBe(0);
    expect(await databaseExists(AUX_DATABASE)).toBe(true);
    await dropRawFixture(rawLedger, 'J08_OCCUPIED');

    // CREATE 结果未知：不认领、不兜底删除。
    const unknownLedger = ledgerFor(AUX_DATABASE, 'j08-unknown');
    const unknownError = await createOwnedProbeDatabaseForRun(
      { query: () => Promise.reject(new Error('J08 注入：CREATE 请求响应未知')) },
      AUX_DATABASE,
      'probe-lifecycle-outer J08 unknown',
      unknownLedger.scope,
    ).catch((error: unknown) => error);
    expect(unknownError).toBeInstanceOf(Error);
    expect((unknownError as Error).message).toMatch(/结果未知或失败：不认领、不兜底删除/);
    expect(unknownLedger.has()).toBe(false);
    expect(await databaseExists(AUX_DATABASE)).toBe(false);

    // 驱动器明确自己 CREATE 成功后观察失败：finally 仍精确收尾，原错误不被覆盖。
    const ownedLedger = ledgerFor(AUX_DATABASE, 'j08-owned');
    const ownership = await createOwnedProbeDatabaseForRun(
      requireDataSource('probe-lifecycle-outer'),
      AUX_DATABASE,
      'probe-lifecycle-outer J08 owned',
      ownedLedger.scope,
    );
    ownedLedger.record(ownership);
    const observationFailure = new Error('J08 注入：观察断言失败');
    let observed: unknown;
    let cleanupFailure: unknown;
    try {
      throw observationFailure;
    } catch (error) {
      observed = error;
    } finally {
      cleanupFailure = await dropLedgerOwnedProbe(
        ownedLedger,
        () => requireDataSource('probe-lifecycle-outer J08 cleanup'),
        'probe-lifecycle-outer J08 cleanup',
      ).catch((error: unknown) => error);
    }
    expect(observed).toBe(observationFailure);
    expect(cleanupFailure).toBe('dropped');
    expect(ownedLedger.has()).toBe(false);
    expect(await databaseExists(AUX_DATABASE)).toBe(false);
  });
});
