// test/utils/e2e-probe-lifecycle.e2e-spec.ts
//
// H01—H09：探针库生命周期的永久反例/正例门禁。
//
// 真实子进程运行 test/utils/e2e-db-target-consistency.e2e-spec.ts（G04），
// 覆盖：异主同名库、缺失/0 许可、正常创建与清理、CREATE 结果未知、
//       CREATE 后克隆失败、DROP 结果未知、单步/多步收尾失败、清理后重跑。
//
// Q01：父规格自己也是资源拥有者，不再按固定库名“存在即 DROP”：
// - PRECHECK 只做只读检查；无本轮创建事实的同名库碰撞拒绝且不删除；
// - 父夹具 CREATE 明确成功后立即登记本轮所有权，建表/插行失败不抹掉创建事实；
// - 全部 RESET/FINAL/H06 回收统一走窄台账入口；无登记时连数据源都不解析、不发 SQL；
// - H06 只接受子进程输出的结构化创建凭据（runId/target/instance 全等）才登记，
//   普通日志文本、退出码和库存在性都不是删除授权。
//
// 父规格只做“执行者授权 + 观测 + 自己创建的夹具回收”，不代替 G04 认领或删除 SUT 探针库。

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { DataSource } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import {
  assertDataSourceOnAllowedE2eDatabase,
  E2E_PHYSICAL_CLEANUP_CONSENT_ENV,
} from './e2e-db-guard';
import {
  assertProbeDatabaseAbsentOrOwned,
  captureAndValidateProbeConsent,
  createOwnedProbeDatabaseForRun,
  createProbeOwnershipRegistry,
  createProbeRunLedger,
  describeProbeSettleResult,
  dropLedgerOwnedProbe,
  dropOwnedProbeDatabase,
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

jest.setTimeout(600000);

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const G04_SPEC = 'test/utils/e2e-db-target-consistency.e2e-spec.ts';
const PROBE_DATABASE = 'lithography_e2e_probe';
const CHILD_RUN_ID_ENV = 'E2E_G04_RUN_ID';
const PARENT_INJECT_ENV = 'E2E_H_PARENT_INJECT';
/** L-C：父侧第一次 DROP 在发送前失败一次，用例异常退出后由真实 afterAll 重试。 */
const H06_DROP_ENV = 'E2E_H06_DROP';
const H06_DROP_FAIL_ONCE = 'once-fail';

interface ChildRun {
  readonly status: number | null;
  readonly output: string;
}

interface Counters {
  readonly createDb: number;
  readonly dropDb: number;
  readonly insert: number;
  readonly delete: number;
}

let app: INestApplication | null = null;
let dataSource: DataSource | null = null;
let parentConsent: ProbeConsentSnapshot | null = null;
/**
 * 规格生命周期的窄收尾集合：登记的是带 run/target/instance 的账本。
 * 用例提前抛错时，真实 afterAll 仍能访问父夹具与 H06 子运行交接记录。
 */
const ownedLedgers = createProbeOwnershipRegistry();
let parentLedger: ProbeRunLedger | null = null;

const requireDataSource = (helper: string): DataSource => {
  if (!dataSource) {
    throw new Error(`[${helper}] 主 DataSource 未初始化`);
  }
  return dataSource;
};

const parentScope = (): ProbeRunScope => {
  if (!parentLedger) {
    throw new Error('[probe-lifecycle-parent] 父台账未初始化');
  }
  return parentLedger.scope;
};

const mainDatabaseName = (): string => {
  const configured = requireDataSource('probe-lifecycle-parent').options.database;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error('H 父规格主 DataSource 缺少 options.database');
  }
  return configured.trim();
};

const readStatus = async (name: string): Promise<number> => {
  const rows = await requireDataSource('probe-lifecycle-parent').query<
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

const probeExists = async (): Promise<boolean> =>
  probeDatabaseExists(requireDataSource('probe-lifecycle-parent'), PROBE_DATABASE);

/**
 * H06 父侧回收的数据源解析入口。
 * L-C 注错只在第一次 DROP 发送前失败一次（不发出 SQL），记录继续留在交接台账中，
 * 用例因此按原错误失败；真实 afterAll 再对同一已证实归属做一次有界回收。
 */
const h06DropResolver = (): ProbeQueryable => {
  const real = requireDataSource('probe-lifecycle-parent H06_HANDOFF');
  if ((process.env[H06_DROP_ENV] ?? '').trim() !== H06_DROP_FAIL_ONCE) {
    return real;
  }
  let injected = false;
  return {
    query: (sql: string, parameters?: unknown[]) => {
      if (!injected && /^\s*DROP\s+DATABASE\b/i.test(sql)) {
        injected = true;
        console.log('PARENT_H06_INJECTED=drop-before-send');
        return Promise.reject(new Error('H06 注入：父侧 DROP 在发送前失败一次（未发送）'));
      }
      return real.query(sql, parameters);
    },
  };
};

/**
 * 规格收尾的统一解析入口：无待处理记录时不解析数据源（也不发 SQL）；
 * 已登记但连接不可用则抛错，由集合逐资源保留未决状态并聚合。
 */
const resolveFinalDataSource = (entry: ProbeOwnedLedgerEntry): ProbeQueryable => {
  if (!dataSource?.isInitialized) {
    throw new Error(
      `[probe-lifecycle-parent FINAL ${entry.label}] 主连接不可用：保留已登记资源与目标诊断，不伪报已释放。`,
    );
  }
  return dataSource;
};

/**
 * Q01 统一准备入口：只接受“不存在”或“本轮已登记归属”。
 * 无归属却存在同名库时碰撞拒绝，不执行任何 DROP，也不继续造数。
 */
const ensureProbeAvailable = async (reason: string): Promise<void> => {
  if (!parentLedger) {
    throw new Error(`[probe-lifecycle-parent] ${reason}：父台账未初始化`);
  }
  try {
    const outcome = await assertProbeDatabaseAbsentOrOwned(
      requireDataSource('probe-lifecycle-parent'),
      parentLedger,
      PROBE_DATABASE,
      `probe-lifecycle-parent ${reason}`,
    );
    console.log(`PARENT_CLEANUP_${reason}=${outcome}`);
  } catch (error) {
    console.log(
      `PARENT_CLEANUP_${reason}=${
        error instanceof ProbeDatabaseCollisionError ? 'collision' : 'error'
      }`,
    );
    throw error;
  }
};

/** 统一父层回收入口；无登记时连数据源都不解析，不发任何 SQL。 */
const dropParentOwned = async (reason: string): Promise<void> => {
  if (!parentLedger) {
    console.log(`PARENT_CLEANUP_${reason}=skipped-not-owned`);
    return;
  }
  try {
    const outcome = await dropLedgerOwnedProbe(
      parentLedger,
      () => requireDataSource(`probe-lifecycle-parent ${reason}`),
      `probe-lifecycle-parent ${reason}`,
    );
    console.log(`PARENT_CLEANUP_${reason}=${outcome}`);
  } catch (error) {
    console.log(`PARENT_CLEANUP_${reason}=unknown`);
    throw error;
  }
};

const createForeignProbeFixture = async (): Promise<void> => {
  if (!parentLedger) {
    throw new Error('[probe-lifecycle-parent] 父台账未初始化');
  }
  // 原子 CREATE 明确成功后才登记；登记与后续建表之间不插入其他异步操作。
  const ownership = await createOwnedProbeDatabaseForRun(
    requireDataSource('probe-lifecycle-parent'),
    PROBE_DATABASE,
    'probe-lifecycle-parent H01 fixture',
    parentLedger.scope,
  );
  parentLedger.record(ownership);
  console.log('PARENT_FIXTURE=created-owned');
  // 建表/插行失败不抹掉成功 CREATE 事实；FINAL 仍可按台账精确回收。
  await requireDataSource('probe-lifecycle-parent').query(
    `CREATE TABLE \`${PROBE_DATABASE}\`.foreign_marker (
       id INT PRIMARY KEY,
       note VARCHAR(32) NOT NULL
     )`,
  );
  await requireDataSource('probe-lifecycle-parent').query(
    `INSERT INTO \`${PROBE_DATABASE}\`.foreign_marker (id, note) VALUES (1, 'keep-me')`,
  );
};

const foreignMarkerIntact = async (): Promise<boolean> => {
  const rows = await requireDataSource('probe-lifecycle-parent').query<
    Array<{ id: number; note: string }>
  >(`SELECT id, note FROM \`${PROBE_DATABASE}\`.foreign_marker WHERE id = 1`);
  return rows.length === 1 && rows[0].note === 'keep-me';
};

interface ChildEnvOptions {
  readonly consent?: string | null;
  readonly inject?: string;
  readonly runId?: string;
}

const buildChildEnv = (options: ChildEnvOptions = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_GROUP: 'core',
    E2E_SKIP_DB_CLEANUP: 'true',
    E2E_ALLOW_DB_CLEANUP: '0',
    E2E_ALLOWED_DB_NAMES: `${mainDatabaseName()},${PROBE_DATABASE}`,
  };
  if (options.consent === null) {
    delete env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV];
  } else {
    env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV] = options.consent ?? '1';
  }
  if (options.inject) {
    env.E2E_G04_INJECT = options.inject;
  } else {
    delete env.E2E_G04_INJECT;
  }
  if (options.runId) {
    env[CHILD_RUN_ID_ENV] = options.runId;
  } else {
    delete env[CHILD_RUN_ID_ENV];
  }
  // 父规格自身的注错开关不能泄漏给子进程。
  delete env[PARENT_INJECT_ENV];
  delete env[H06_DROP_ENV];
  return env;
};

const newChildRunId = (label: string): string =>
  `${label}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const runG04Child = (options: ChildEnvOptions = {}): ChildRun => {
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, 'test/run-e2e-group.js'), '--file', G04_SPEC],
    {
      cwd: BACKEND_ROOT,
      env: buildChildEnv(options),
      encoding: 'utf8',
      timeout: 240000,
    },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { status: result.status, output };
};

describe('H01—H09 探针库生命周期永久反例/正例', () => {
  beforeAll(async () => {
    // 父规格自身也必须有执行者许可，才允许创建/删除自己登记的夹具库。
    parentConsent = captureAndValidateProbeConsent('probe-lifecycle-parent');
    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // J02 精确初始化注错：app 已分配但尚无任何本轮探针库归属；
    // FINAL 不得据未初始化的数据源做破坏性查询，关闭步骤仍须尝试。
    if (process.env[PARENT_INJECT_ENV] === 'app-init-failure') {
      console.log('PARENT_INJECTED=app-init-failure');
      throw new Error('H 父规格注入：应用初始化后、目标核验与建库前失败');
    }
    const mainDataSource = app.get(DataSource);
    dataSource = mainDataSource;
    await assertDataSourceOnAllowedE2eDatabase(mainDataSource);
    parentLedger = ownedLedgers.add(
      'parent',
      createProbeRunLedger({
        runId: newChildRunId('h-parent'),
        target: PROBE_DATABASE,
        instance: probeInstanceIdentity(mainDataSource),
      }),
    );
    // Q01：PRECHECK 只读检查；无归属的同名库碰撞拒绝，不删除。
    await ensureProbeAvailable('PRECHECK');
  });

  afterAll(async () => {
    await runProbeLifecycleTeardown('probe-lifecycle-parent', {
      dropProbe: async () => {
        // 逐资源独立尝试：空账本跳过，已登记资源成功才消费，失败保留并聚合。
        const settlement = await ownedLedgers.settle(
          resolveFinalDataSource,
          'probe-lifecycle-parent FINAL',
        );
        for (const result of settlement.results) {
          console.log(`PARENT_FINAL_${result.label}=${describeProbeSettleResult(result)}`);
        }
        console.log(`PARENT_CLEANUP_FINAL=${probeSettlementState(settlement)}`);
        throwProbeSettlementError(settlement, 'probe-lifecycle-parent FINAL');
      },
      restoreEnv: () => {
        if (parentConsent) {
          restoreProbeConsent(parentConsent);
          console.log('PARENT_ENV_RESTORED=1');
          return;
        }
        console.log('PARENT_ENV_RESTORED=not-needed');
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('PARENT_CLOSE=closed');
          return;
        }
        console.log('PARENT_CLOSE=no-app');
      },
    });
  });

  it('H01 异主同名探针库已存在：CREATE 碰撞拒绝，库与标记行完整保留，零 DROP/INSERT/DELETE', async () => {
    await ensureProbeAvailable('H01_RESET');
    await createForeignProbeFixture();
    const before = await readCounters();
    const child = runG04Child({ consent: '1' });
    const after = await readCounters();

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('G04_OWNERSHIP=collision');
    expect(child.output).toContain('已存在：拒绝覆盖或接管既有库');
    expect(child.output).toContain('G04_DROP=skipped-not-owned');
    expect(child.output).toContain('G04_AFTERALL_STATE=create-failed');
    expect(child.output).toContain('G04_CLOSE=closed');
    // MySQL 的 Com_create_db 在“已存在”失败语句上也会 +1，因此不能用它证明未尝试 CREATE；
    // H01 的关键不变量是既有库无 DROP/INSERT/DELETE、库与标记行完整保留。
    expect(after.dropDb - before.dropDb).toBe(0);
    expect(after.insert - before.insert).toBe(0);
    expect(after.delete - before.delete).toBe(0);
    expect(await probeExists()).toBe(true);
    expect(await foreignMarkerIntact()).toBe(true);

    await dropParentOwned('H01');
    expect(await probeExists()).toBe(false);
  });

  it('H02 许可缺失与为 0：应用初始化前失败关闭，零 CREATE/DROP/INSERT/DELETE，资源未误开', async () => {
    await ensureProbeAvailable('H02_RESET');
    const before = await readCounters();
    const missing = runG04Child({ consent: null });
    const zero = runG04Child({ consent: '0' });
    const after = await readCounters();

    for (const child of [missing, zero]) {
      expect(child.status).not.toBeNull();
      expect(child.status).not.toBe(0);
      expect(child.output).toContain('启动许可未通过');
      expect(child.output).toContain('G04_AFTERALL_STATE=consent-rejected');
      expect(child.output).toContain('G04_DROP=skipped-not-owned');
      expect(child.output).toContain('G04_CLOSE=no-app');
      expect(child.output).toContain('G04_ENV_RESTORED=not-needed');
    }
    expect(after.createDb - before.createDb).toBe(0);
    expect(after.dropDb - before.dropDb).toBe(0);
    expect(after.insert - before.insert).toBe(0);
    expect(after.delete - before.delete).toBe(0);
    expect(await probeExists()).toBe(false);
  });

  it('H03 正常许可且无同名库：CREATE 成功→登记所有权→清理→环境恢复/app 关闭，探针库归零', async () => {
    await ensureProbeAvailable('H03_RESET');
    const child = runG04Child({ consent: '1' });

    expect(child.status).toBe(0);
    expect(child.output).toContain('G04_OWNERSHIP=acquired');
    expect(child.output).toContain('G04_DROP=dropped');
    expect(child.output).toContain('G04_ENV_RESTORED=1');
    expect(child.output).toContain('G04_AFTERALL_STATE=ready');
    expect(child.output).toContain('G04_CLOSE=closed');
    expect(child.output).toMatch(/2 passed/);
    expect(await probeExists()).toBe(false);
  });

  it('H04 CREATE 明确失败/结果未知：不认领、不 DROP、仍关闭已分配资源；权限拒绝同样不认领', async () => {
    await ensureProbeAvailable('H04_RESET');
    const child = runG04Child({ consent: '1', inject: 'create-unknown' });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('G04_OWNERSHIP=unknown');
    expect(child.output).toContain('结果未知或失败：不认领、不兜底删除');
    expect(child.output).toContain('G04_DROP=skipped-not-owned');
    expect(child.output).toContain('G04_CLOSE=closed');
    expect(await probeExists()).toBe(false);

    // 权限拒绝分支使用同一 helper 的窄接口注入，避免依赖真实降权账号。
    let dropQueries = 0;
    const denied = {
      query: (): Promise<never> =>
        Promise.reject(
          Object.assign(new Error('Access denied'), { code: 'ER_DBACCESS_DENIED_ERROR' }),
        ),
    };
    await expect(
      createOwnedProbeDatabaseForRun(denied, PROBE_DATABASE, 'H04 权限拒绝', parentScope()),
    ).rejects.toThrow(/结果未知或失败：不认领、不兜底删除/);
    await dropOwnedProbeDatabase(
      {
        query: () => {
          dropQueries += 1;
          return Promise.resolve([]);
        },
      },
      null,
      'H04 权限拒绝',
    );
    expect(dropQueries).toBe(0);
  });

  it('H05 CREATE 成功后克隆/造数前失败：按已知归属精确 DROP，环境恢复与 app 关闭仍执行', async () => {
    await ensureProbeAvailable('H05_RESET');
    const child = runG04Child({ consent: '1', inject: 'clone-failure' });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('G04_OWNERSHIP=acquired');
    expect(child.output).toContain('G04_INJECTED=clone-failure');
    expect(child.output).toContain('G04_DROP=dropped');
    expect(child.output).toContain('G04_ENV_RESTORED=1');
    expect(child.output).toContain('G04_CLOSE=closed');
    expect(await probeExists()).toBe(false);
  });

  it('H06 DROP 结果未知：不伪造已删除、保留目标与阶段诊断、仍关闭资源；父侧仅按结构化凭据受控回收', async () => {
    await ensureProbeAvailable('H06_RESET');
    const childRunId = newChildRunId('h06');
    const child = runG04Child({ consent: '1', inject: 'drop-unknown', runId: childRunId });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('G04_OWNERSHIP=acquired');
    expect(child.output).toContain('G04_DROP=unknown');
    expect(child.output).toMatch(/G04_DROP_ERROR=.*DROP 请求响应未知/);
    expect(child.output).toContain('G04_CLOSE=closed');
    expect(await probeExists()).toBe(true);

    // Q01：父侧额外卫生清理必须持有与具体子运行/目标/实例绑定的结构化创建凭据；
    // 普通日志文本、退出码和库存在性都不构成删除授权。子进程已结束（spawnSync 返回）。
    const expected = {
      runId: childRunId,
      target: PROBE_DATABASE,
      instance: probeInstanceIdentity(requireDataSource('probe-lifecycle-parent')),
    };
    const handoff = parseProbeCreationCredential(child.output, expected);
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) {
      console.log('PARENT_H06_HANDOFF=rejected');
      return;
    }
    // 交接记录绑定具体子运行（不是父运行）：父台账只登记自己 CREATE 的夹具。
    // 立即进入规格生命周期的收尾集合：后续父侧回收失败或用例提前抛错，真实 afterAll 仍可访问。
    const handoffLedger = ownedLedgers.add(
      'h06-handoff',
      createProbeRunLedger({
        runId: handoff.credential.runId,
        target: handoff.credential.target,
        instance: handoff.credential.instance,
      }),
    );
    handoffLedger.record({
      name: PROBE_DATABASE,
      createdByThisRun: true,
      source: 'child-handoff',
      runId: handoff.credential.runId,
      target: handoff.credential.target,
      instance: handoff.credential.instance,
    });
    console.log('PARENT_H06_HANDOFF=registered');
    let outcome: 'dropped' | 'skipped-not-owned';
    try {
      outcome = await dropLedgerOwnedProbe(
        handoffLedger,
        h06DropResolver,
        'probe-lifecycle-parent H06_HANDOFF',
      );
    } catch (error) {
      // 失败不代表可以丢弃归属；记录仍留在交接台账，由真实 afterAll 做一次有界回收。
      console.log('PARENT_CLEANUP_H06_HANDOFF=unknown');
      throw error;
    }
    console.log(`PARENT_CLEANUP_H06_HANDOFF=${outcome}`);
    expect(outcome).toBe('dropped');
    expect(await probeExists()).toBe(false);
  });

  it('H07 单步失败：其余收尾步骤仍按顺序尝试，原错误不被覆盖', async () => {
    const stepNames = ['destroyShifted', 'dropProbe', 'restoreEnv', 'closeApp'] as const;
    type StepName = (typeof stepNames)[number];
    const buildSteps = (failing: StepName, failure: Error, attempts: string[]) => ({
      destroyShifted: () => {
        attempts.push('destroyShifted');
        return failing === 'destroyShifted' ? Promise.reject(failure) : Promise.resolve();
      },
      dropProbe: () => {
        attempts.push('dropProbe');
        return failing === 'dropProbe' ? Promise.reject(failure) : Promise.resolve();
      },
      restoreEnv: () => {
        attempts.push('restoreEnv');
        return failing === 'restoreEnv' ? Promise.reject(failure) : Promise.resolve();
      },
      closeApp: () => {
        attempts.push('closeApp');
        return failing === 'closeApp' ? Promise.reject(failure) : Promise.resolve();
      },
    });

    for (const failing of stepNames) {
      const failure = new Error(`H07 ${failing} 失败`);
      const attempts: string[] = [];
      const caught = await runProbeLifecycleTeardown(
        'H07',
        buildSteps(failing, failure, attempts),
      ).catch((error: unknown) => error);
      expect(caught).toBe(failure);
      expect(attempts).toEqual([...stepNames]);
    }
  });

  it('H08 多步失败：全部尝试、按发生顺序报告、最早错误为主因', async () => {
    const failures: Error[] = [];
    const attempts: string[] = [];
    const steps = {
      destroyShifted: () => {
        attempts.push('destroyShifted');
        const error = new Error('H08 destroyShifted 失败');
        failures.push(error);
        return Promise.reject(error);
      },
      dropProbe: () => {
        attempts.push('dropProbe');
        const error = new Error('H08 dropProbe 失败');
        failures.push(error);
        return Promise.reject(error);
      },
      restoreEnv: () => {
        attempts.push('restoreEnv');
        const error = new Error('H08 restoreEnv 失败');
        failures.push(error);
        return Promise.reject(error);
      },
      closeApp: () => {
        attempts.push('closeApp');
        const error = new Error('H08 closeApp 失败');
        failures.push(error);
        return Promise.reject(error);
      },
    };
    const caught = await runProbeLifecycleTeardown('H08', steps).catch((error: unknown) => error);

    expect(attempts).toEqual(['destroyShifted', 'dropProbe', 'restoreEnv', 'closeApp']);
    expect(caught).toBeInstanceOf(Error);
    const aggregate = caught as Error;
    expect(aggregate.cause).toBe(failures[0]);
    for (const failure of failures) {
      expect(aggregate.message).toContain(failure.message);
    }
    expect(aggregate.message).toContain('4 个失败');
    expect(aggregate.message).toContain('最初错误为主因');
  });

  it('H09 本轮清理后重跑安全；另一运行占用固定名时拒绝接管', async () => {
    await ensureProbeAvailable('H09_RESET');
    const first = runG04Child({ consent: '1' });
    expect(first.status).toBe(0);
    expect(first.output).toContain('G04_DROP=dropped');
    expect(await probeExists()).toBe(false);

    const second = runG04Child({ consent: '1' });
    expect(second.status).toBe(0);
    expect(second.output).toContain('G04_OWNERSHIP=acquired');
    expect(second.output).toContain('G04_DROP=dropped');
    expect(await probeExists()).toBe(false);

    // 占用保护由 H01 的真实异主库覆盖；此处只复核重跑不会伪造“已清理”。
    expect(second.output).not.toContain('G04_DROP=skipped-not-owned');
  });
});
