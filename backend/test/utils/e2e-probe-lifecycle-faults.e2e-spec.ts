// test/utils/e2e-probe-lifecycle-faults.e2e-spec.ts
//
// L01 / L-A—L-G：异常资源台账与真实最终收尾的永久验收驱动器。
//
// 该规格自身不制造“故意失败的 core 用例”，而是：
// - 用正式 runner 精确选择 J03/J04/J06/H06，注入“真实 CREATE 成功后、下一步调用点失败”；
// - 由子规格真实 beforeAll/afterAll 处理异常退出后的资源，外层独立查库核验目标与残留；
// - L-E/L-F 直接调用共享台账与收尾入口，验证多资源聚合、空账本/已消费保护；
// - V-LD/V-PENDING 用正式 runner 启动“L-D 拥有者子规格”：该子规格接收资源后
//   必须立即进入自己的规格级集合；其拥有者回收失败/最终收尾未知时，真实 afterAll
//   仍能访问并安全处理或保留准确未决状态；
// - L-G 的源码副本负对照在独立源码副本中执行（见执行回执，不在此规格内改写源码）。
//
// 边界：只处理本规格明确创建/接收的资源；无证据残留只诊断，不冒充 SUT 成功。
// 故意失败的子规格不进入正常 core 直接收录，但本外层验收规格属于 core 常驻门禁。

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
  captureAndValidateProbeConsent,
  createOwnedProbeDatabaseForRun,
  createProbeOwnershipRegistry,
  createProbeRunLedger,
  describeProbeSettleResult,
  dropLedgerOwnedProbe,
  parseProbeCreationCredential,
  probeDatabaseExists,
  probeInstanceIdentity,
  probeSettlementState,
  restoreProbeConsent,
  runProbeLifecycleTeardown,
  throwProbeSettlementError,
  type ProbeConsentSnapshot,
  type ProbeLedgerSettlement,
  type ProbeOwnedLedgerEntry,
  type ProbeQueryable,
  type ProbeRunLedger,
} from './probe-database-lifecycle';

jest.setTimeout(1800000);

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const J_SPEC = 'test/utils/e2e-probe-lifecycle-outer.e2e-spec.ts';
const H_SPEC = 'test/utils/e2e-probe-lifecycle.e2e-spec.ts';
/** L-D 拥有者子规格：故意失败/未决，仅由本外层驱动精确选择，不进入 core。 */
const LD_SPEC = 'test/utils/e2e-probe-lifecycle-ld-owner.e2e-spec.ts';
const PROBE_DATABASE = 'lithography_e2e_probe';
const AUX_DATABASE = 'lithography_e2e_probe_aux';
/** 故障驱动的独占目标：不与正常 J/H 的 probe/aux 复用，避免预期未决残留污染常规门禁。 */
const FAULT_TARGET = 'lithography_e2e_probe_fault';
const LE_FAIL_TARGET = 'lithography_e2e_probe_le1';
const LE_OK_TARGET = 'lithography_e2e_probe_le2';
const LF_CONSUMED_TARGET = 'lithography_e2e_probe_le3';
/** 只用于“空账本无删除资格”的目标名；本规格从不创建它。 */
const LF_EMPTY_TARGET = 'lithography_e2e_probe_le4';

const J_INJECT_ENV = 'E2E_J_INJECT';
const J_FINAL_DROP_ENV = 'E2E_J_FINAL_DROP';
const J_FAULT_TARGET_ENV = 'E2E_J_FAULT_TARGET';
const J_FAULT_RUN_ID_ENV = 'E2E_J_FAULT_RUN_ID';
const H06_DROP_ENV = 'E2E_H06_DROP';
/** 子规格的拥有者回收/最终收尾注错开关；正常 core 运行不设置。 */
const LD_OWNER_FAIL_ENV = 'E2E_LD_OWNER_FAIL';
const LD_OWNER_FINAL_ENV = 'E2E_LD_OWNER_FINAL';
const LD_OWNER_RUN_ID_ENV = 'E2E_LD_OWNER_RUN_ID';

interface ChildRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

let app: INestApplication | null = null;
let dataSource: DataSource | null = null;
let consent: ProbeConsentSnapshot | null = null;
/** 本规格自己创建的资源账本；测试中途失败时 afterAll 仍可访问。 */
const ownedLedgers = createProbeOwnershipRegistry();

const requireDataSource = (helper: string): DataSource => {
  if (!dataSource) {
    throw new Error(`[${helper}] 主 DataSource 未初始化`);
  }
  return dataSource;
};

const instanceIdentity = (): string =>
  probeInstanceIdentity(requireDataSource('probe-lifecycle-faults'));

const mainDatabaseName = (): string => {
  const configured = requireDataSource('probe-lifecycle-faults').options.database;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error('L 故障规格主 DataSource 缺少 options.database');
  }
  return configured.trim();
};

const databaseExists = (name: string): Promise<boolean> =>
  probeDatabaseExists(requireDataSource('probe-lifecycle-faults'), name);

const currentRunId = (label: string): string =>
  `l-${label}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const ledgerFor = (target: string, label: string): ProbeRunLedger =>
  ownedLedgers.add(
    label,
    createProbeRunLedger({
      runId: currentRunId(label),
      target,
      instance: instanceIdentity(),
    }),
  );

/** 子进程环境：清除父规格的全部注错开关，只透传本阶段的精确开关。 */
const baseChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_GROUP: 'core',
    E2E_SKIP_DB_CLEANUP: 'true',
    E2E_ALLOW_DB_CLEANUP: '0',
    E2E_ALLOWED_DB_NAMES: [
      mainDatabaseName(),
      PROBE_DATABASE,
      AUX_DATABASE,
      FAULT_TARGET,
      LE_FAIL_TARGET,
      LE_OK_TARGET,
      LF_CONSUMED_TARGET,
    ].join(','),
  };
  delete env.E2E_SPECS;
  delete env.E2E_G04_RUN_ID;
  delete env.E2E_G04_INJECT;
  delete env.E2E_H_PARENT_INJECT;
  delete env[H06_DROP_ENV];
  delete env[J_INJECT_ENV];
  delete env[J_FINAL_DROP_ENV];
  delete env[J_FAULT_TARGET_ENV];
  delete env[J_FAULT_RUN_ID_ENV];
  delete env[LD_OWNER_FAIL_ENV];
  delete env[LD_OWNER_FINAL_ENV];
  delete env[LD_OWNER_RUN_ID_ENV];
  if (!env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV]) {
    env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV] = '1';
  }
  return env;
};

const runSpec = (
  spec: string,
  testNamePattern: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildRun => {
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, 'test/run-e2e-group.js'), '--file', spec, '-t', testNamePattern],
    {
      cwd: BACKEND_ROOT,
      env: { ...baseChildEnv(), ...extraEnv },
      encoding: 'utf8',
      timeout: 1200000,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
};

describe('L-A—L-G 异常资源台账与真实最终收尾', () => {
  beforeAll(async () => {
    consent = captureAndValidateProbeConsent('probe-lifecycle-faults');
    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const mainDataSource = app.get(DataSource);
    dataSource = mainDataSource;
    await assertDataSourceOnAllowedE2eDatabase(mainDataSource);
    // 启动门禁：故障目标与常规 probe/aux 均须不存在；无归属存在时拒绝启动、不 DROP。
    for (const name of [
      PROBE_DATABASE,
      AUX_DATABASE,
      FAULT_TARGET,
      LE_FAIL_TARGET,
      LE_OK_TARGET,
      LF_CONSUMED_TARGET,
    ]) {
      if (await databaseExists(name)) {
        throw new Error(
          `[probe-lifecycle-faults] 目标库 "${name}" 已存在且无本轮创建凭据：拒绝启动，不执行任何 DROP。`,
        );
      }
    }
    console.log('FAULTS_PRECHECK=absent');
  });

  afterAll(async () => {
    await runProbeLifecycleTeardown('probe-lifecycle-faults', {
      dropProbe: async () => {
        const settlement = await ownedLedgers.settle((entry: ProbeOwnedLedgerEntry) => {
          if (!dataSource?.isInitialized) {
            throw new Error(
              `[probe-lifecycle-faults FINAL ${entry.label}] 主连接不可用：保留已登记资源与目标诊断，不伪报已释放。`,
            );
          }
          return dataSource;
        }, 'probe-lifecycle-faults FINAL');
        for (const result of settlement.results) {
          console.log(`FAULTS_FINAL_${result.label}=${describeProbeSettleResult(result)}`);
        }
        console.log(`FAULTS_FINAL=${probeSettlementState(settlement)}`);
        throwProbeSettlementError(settlement, 'probe-lifecycle-faults FINAL');
      },
      restoreEnv: () => {
        if (consent) {
          restoreProbeConsent(consent);
          console.log('FAULTS_ENV_RESTORED=1');
          return;
        }
        console.log('FAULTS_ENV_RESTORED=not-needed');
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('FAULTS_CLOSE=closed');
          return;
        }
        console.log('FAULTS_CLOSE=no-app');
      },
    });
  });

  it('L-A 辅助库部分创建：CREATE+登记后建表点失败，真实 afterAll 精确回收且原错误保留', async () => {
    const runId = currentRunId('la');
    const child = runSpec(J_SPEC, 'J03', {
      [J_INJECT_ENV]: 'aux-marker-failure',
      [J_FAULT_TARGET_ENV]: FAULT_TARGET,
      [J_FAULT_RUN_ID_ENV]: runId,
    });

    // 子进程非零是预期的“用例提前终止”；缺陷依据是 afterAll 对已创建资源是否仍可达。
    expect(child.status).not.toBe(0);
    expect(child.output).toContain('OUTER_INJECTED=aux-marker-failure');
    expect(child.output).toContain('J 注入：aux-marker-failure');
    expect(child.output).toContain('G04_CREATE_CREDENTIAL=');
    expect(child.output).toContain('OUTER_FINAL_main=skipped');
    expect(child.output).toContain('OUTER_FINAL_j03=dropped');
    expect(child.output).toContain('OUTER_FINAL=settled');
    expect(child.output).toContain('OUTER_ENV_RESTORED=1');
    expect(child.output).toContain('OUTER_CLOSE=closed');

    // 外层独立查库：故障目标已被回收，其他本轮/非本轮库未被误动。
    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    expect(await databaseExists(AUX_DATABASE)).toBe(false);
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
    console.log('L_A=green');
  });

  it('L-B 提前断言失败：原始夹具登记后退出，真实 afterAll 仍访问账本并精确回收', async () => {
    const runId = currentRunId('lb');
    const child = runSpec(J_SPEC, 'J04', {
      [J_INJECT_ENV]: 'raw-assert-failure',
      [J_FAULT_TARGET_ENV]: FAULT_TARGET,
      [J_FAULT_RUN_ID_ENV]: runId,
    });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('OUTER_INJECTED=raw-assert-failure');
    expect(child.output).toContain('J 注入：raw-assert-failure');
    expect(child.output).toContain('OUTER_RAW_FIXTURE_j04-raw=created-owned');
    expect(child.output).toContain('OUTER_FINAL_j04-raw=dropped');
    expect(child.output).toContain('OUTER_FINAL=settled');
    expect(child.output).toContain('OUTER_ENV_RESTORED=1');
    expect(child.output).toContain('OUTER_CLOSE=closed');

    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    expect(await databaseExists(AUX_DATABASE)).toBe(false);
    console.log('L_B=green');
  });

  it('L-C H06 父回收暂时失败：用例报原错误，真实 FINAL 发现子账本并有界回收', async () => {
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
    const child = runSpec(H_SPEC, 'H06', { [H06_DROP_ENV]: 'once-fail' });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('PARENT_H06_HANDOFF=registered');
    expect(child.output).toContain('PARENT_H06_INJECTED=drop-before-send');
    expect(child.output).toContain('PARENT_CLEANUP_H06_HANDOFF=unknown');
    expect(child.output).toContain('H06 注入：父侧 DROP 在发送前失败一次');
    // 真实 FINAL 仍能看到 H06 交接台账，首次未发送的失败不导致记录丢失。
    expect(child.output).toContain('PARENT_FINAL_h06-handoff=dropped');
    expect(child.output).toContain('PARENT_FINAL_parent=skipped');
    expect(child.output).toContain('PARENT_CLEANUP_FINAL=settled');
    expect(child.output).not.toContain('PARENT_CLEANUP_FINAL=skipped-not-owned');
    expect(child.output).toContain('PARENT_ENV_RESTORED=1');
    expect(child.output).toContain('PARENT_CLOSE=closed');

    // 父进程独立查库：子 G04 的未知 DROP 残留已由真实 FINAL 回收。
    expect(await databaseExists(PROBE_DATABASE)).toBe(false);
    console.log('L_C=green');
  });

  it('L-D 持续失败/结果未知：记录与诊断保留、非零退出、恢复与关闭仍执行；随后由拥有者按凭证处理', async () => {
    const runId = currentRunId('ld');
    const child = runSpec(J_SPEC, 'J06', {
      [J_INJECT_ENV]: 'final-drop-unknown',
      [J_FINAL_DROP_ENV]: 'unknown',
      [J_FAULT_TARGET_ENV]: FAULT_TARGET,
      [J_FAULT_RUN_ID_ENV]: runId,
    });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('OUTER_INJECTED=final-drop-unknown');
    expect(child.output).toContain('OUTER_FINAL_INJECTED=j-inject-final');
    expect(child.output).toMatch(/OUTER_FINAL_j-inject-final=failed:/);
    expect(child.output).toContain('OUTER_FINAL=partial');
    expect(child.output).not.toContain('OUTER_FINAL=skipped-not-owned');
    expect(child.output).toContain('OUTER_ENV_RESTORED=1');
    expect(child.output).toContain('OUTER_CLOSE=closed');

    // 未决状态必须真实保留：记录未消费、库仍存在，不伪造零残留。
    expect(await databaseExists(FAULT_TARGET)).toBe(true);
    console.log('L_D_PENDING_CONFIRMED=1');

    // 预期未决残留由拥有者按“结构化创建凭据”在隔离可丢弃实例中有界处理，单列记录。
    const parsed = parseProbeCreationCredential(child.output, {
      runId,
      target: FAULT_TARGET,
      instance: instanceIdentity(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(`[L-D] 缺少可用于拥有者处理残留的创建凭据：${parsed.reason}`);
    }
    // 有效凭据接收后立即进入规格可达的收尾集合：本用例后续回收失败也不会丢账。
    const cleanupLedger = ownedLedgers.add(
      'ld-owner',
      createProbeRunLedger({
        runId: parsed.credential.runId,
        target: parsed.credential.target,
        instance: parsed.credential.instance,
      }),
    );
    cleanupLedger.record({
      name: FAULT_TARGET,
      createdByThisRun: true,
      source: 'child-handoff',
      runId: parsed.credential.runId,
      target: parsed.credential.target,
      instance: parsed.credential.instance,
    });
    const outcome = await dropLedgerOwnedProbe(
      cleanupLedger,
      () => requireDataSource('L-D owner cleanup'),
      'L-D owner cleanup',
    );
    expect(outcome).toBe('dropped');
    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    console.log('L_D_OWNER_CLEANUP=dropped');
  });

  it('V-LD 拥有者回收发送前失败：登记后异常退出，真实 FINAL 发现账本并安全回收', async () => {
    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    const runId = currentRunId('vld');
    const child = runSpec(LD_SPEC, 'V-LD', {
      [LD_OWNER_FAIL_ENV]: 'once-fail',
      [LD_OWNER_RUN_ID_ENV]: runId,
    });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('LD_OWNER_PRECHECK=absent');
    expect(child.output).toContain('LD_PENDING_CONFIRMED=1');
    expect(child.output).toContain('LD_OWNER_REGISTERED=1');
    expect(child.output).toContain('LD_OWNER_INJECTED=drop-before-send');
    expect(child.output).toContain('L-D 拥有者回收注入：DROP 在发送前失败一次');
    // 真实 FINAL 仍能看到已登记拥有者账本；发送前失败不等于无归属。
    expect(child.output).toContain('LD_OWNER_FINAL_ld-owner=dropped');
    expect(child.output).toContain('LD_OWNER_FINAL=settled');
    expect(child.output).not.toContain('LD_OWNER_FINAL=skipped-not-owned');
    expect(child.output).toContain('LD_OWNER_ENV_RESTORED=1');
    expect(child.output).toContain('LD_OWNER_CLOSE=closed');

    // 父进程独立查库：子规格真实 afterAll 已回收本轮故障目标。
    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    console.log('V_LD=green');
  });

  it('V-PENDING 拥有者最终收尾结果未知：记录保留、非零、恢复/关闭仍执行；随后拥有者按凭据处理', async () => {
    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    const runId = currentRunId('vpending');
    const child = runSpec(LD_SPEC, 'V-PENDING', {
      [LD_OWNER_FINAL_ENV]: 'unknown',
      [LD_OWNER_RUN_ID_ENV]: runId,
    });

    expect(child.status).not.toBe(0);
    expect(child.output).toContain('LD_OWNER_REGISTERED=1');
    expect(child.output).toContain('LD_OWNER_FINAL_INJECTED=ld-owner');
    expect(child.output).toMatch(/LD_OWNER_FINAL_ld-owner=failed:/);
    expect(child.output).toContain('LD_OWNER_FINAL=partial');
    expect(child.output).not.toContain('LD_OWNER_FINAL=skipped-not-owned');
    expect(child.output).toContain('LD_OWNER_ENV_RESTORED=1');
    expect(child.output).toContain('LD_OWNER_CLOSE=closed');

    // 未决状态必须真实保留：记录未消费、库仍存在，不伪造零残留。
    expect(await databaseExists(FAULT_TARGET)).toBe(true);
    console.log('V_PENDING_CONFIRMED=1');

    // 预期未决残留由拥有者按“结构化创建凭据”在隔离可丢弃实例中有界处理，单列记录。
    const parsed = parseProbeCreationCredential(child.output, {
      runId,
      target: FAULT_TARGET,
      instance: instanceIdentity(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(`[V-PENDING] 缺少可用于拥有者处理残留的创建凭据：${parsed.reason}`);
    }
    const ownerLedger = ownedLedgers.add(
      'vpending-owner',
      createProbeRunLedger({
        runId: parsed.credential.runId,
        target: parsed.credential.target,
        instance: parsed.credential.instance,
      }),
    );
    ownerLedger.record({
      name: FAULT_TARGET,
      createdByThisRun: true,
      source: 'child-handoff',
      runId: parsed.credential.runId,
      target: parsed.credential.target,
      instance: parsed.credential.instance,
    });
    const outcome = await dropLedgerOwnedProbe(
      ownerLedger,
      () => requireDataSource('V-PENDING owner cleanup'),
      'V-PENDING owner cleanup',
    );
    expect(outcome).toBe('dropped');
    expect(await databaseExists(FAULT_TARGET)).toBe(false);
    console.log('V_PENDING_OWNER_CLEANUP=dropped');
  });

  it('L-E 多资源与错误聚合：一个失败一个成功，逐资源独立尝试，关闭不被首错阻断', async () => {
    const failLedger = ledgerFor(LE_FAIL_TARGET, 'le-fail');
    const okLedger = ledgerFor(LE_OK_TARGET, 'le-ok');
    for (const [ledger, target] of [
      [failLedger, LE_FAIL_TARGET],
      [okLedger, LE_OK_TARGET],
    ] as const) {
      const ownership = await createOwnedProbeDatabaseForRun(
        requireDataSource('probe-lifecycle-faults L-E'),
        target,
        'probe-lifecycle-faults L-E',
        ledger.scope,
      );
      ledger.record(ownership);
    }

    const attempts: string[] = [];
    let settlement: ProbeLedgerSettlement | null = null;
    const caught = await runProbeLifecycleTeardown('probe-lifecycle-faults L-E', {
      dropProbe: async () => {
        attempts.push('dropProbe');
        settlement = await ownedLedgers.settle(
          (entry: ProbeOwnedLedgerEntry): ProbeQueryable =>
            entry.label === 'le-fail'
              ? { query: () => Promise.reject(new Error('L-E 注入：DROP 响应未知')) }
              : requireDataSource('probe-lifecycle-faults L-E FINAL'),
          'probe-lifecycle-faults L-E FINAL',
        );
        console.log(
          `L_E_SETTLEMENT=dropped:${settlement.dropped},skipped:${settlement.skipped},failed:${settlement.failures.length}`,
        );
        throwProbeSettlementError(settlement, 'probe-lifecycle-faults L-E FINAL');
      },
      restoreEnv: () => {
        attempts.push('restoreEnv');
      },
      closeApp: () => {
        attempts.push('closeApp');
        return Promise.resolve();
      },
    }).catch((error: unknown) => error);

    // 一个资源失败不阻断其余收尾步骤；主错误保留，后续失败不覆盖。
    expect(attempts).toEqual(['dropProbe', 'restoreEnv', 'closeApp']);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(settlement).not.toBeNull();
    if (!settlement) {
      throw new Error('[L-E] 收尾集合未执行');
    }
    const recorded: ProbeLedgerSettlement = settlement;
    expect(recorded.dropped).toBe(1);
    expect(recorded.failures.map((failure) => failure.label)).toEqual(['le-fail']);
    expect(failLedger.has()).toBe(true);
    expect(okLedger.has()).toBe(false);
    expect(await databaseExists(LE_FAIL_TARGET)).toBe(true);
    expect(await databaseExists(LE_OK_TARGET)).toBe(false);

    // 同一拥有者对已证实本轮目标做一次有界真实回收；成功后才消费记录。
    const real = await ownedLedgers.settle(
      () => requireDataSource('probe-lifecycle-faults L-E real'),
      'probe-lifecycle-faults L-E real',
    );
    expect(real.failures).toHaveLength(0);
    expect(real.dropped).toBe(1);
    expect(failLedger.has()).toBe(false);
    expect(await databaseExists(LE_FAIL_TARGET)).toBe(false);
    console.log('L_E=green');
  });

  it('L-F 已消费/无归属保护：空账本无删除资格，已消费不重复 DROP，无效凭据不接管', async () => {
    // 空账本：无登记时连解析都不发生，不产生删除资格。
    const emptyLedger = ledgerFor(LF_EMPTY_TARGET, 'lf-empty');
    let resolvedForEmpty = 0;
    const emptySettlement = await ownedLedgers.settle(() => {
      resolvedForEmpty += 1;
      return requireDataSource('probe-lifecycle-faults L-F empty');
    }, 'probe-lifecycle-faults L-F empty');
    const emptyResult = emptySettlement.results.find((result) => result.label === 'lf-empty');
    expect(emptyResult?.outcome).toBe('skipped');
    expect(resolvedForEmpty).toBe(0);
    expect(emptyLedger.has()).toBe(false);

    // 已消费：成功 DROP 后再次收尾不再重复 DROP。
    const consumedLedger = ledgerFor(LF_CONSUMED_TARGET, 'lf-consumed');
    const ownership = await createOwnedProbeDatabaseForRun(
      requireDataSource('probe-lifecycle-faults L-F'),
      LF_CONSUMED_TARGET,
      'probe-lifecycle-faults L-F consumed',
      consumedLedger.scope,
    );
    consumedLedger.record(ownership);
    expect(
      await dropLedgerOwnedProbe(
        consumedLedger,
        () => requireDataSource('probe-lifecycle-faults L-F drop'),
        'probe-lifecycle-faults L-F drop',
      ),
    ).toBe('dropped');
    let resolvedForConsumed = 0;
    const afterConsume = await ownedLedgers.settle(
      (entry: ProbeOwnedLedgerEntry): ProbeQueryable => {
        if (entry.label === 'lf-consumed') {
          resolvedForConsumed += 1;
        }
        return requireDataSource('probe-lifecycle-faults L-F second');
      },
      'probe-lifecycle-faults L-F second',
    );
    expect(afterConsume.results.find((result) => result.label === 'lf-consumed')?.outcome).toBe(
      'skipped',
    );
    expect(resolvedForConsumed).toBe(0);
    expect(await databaseExists(LF_CONSUMED_TARGET)).toBe(false);

    // 无效交接凭据不产生登记；J05 的完整拒绝矩阵由正式 runner 实际执行。
    const invalid = parseProbeCreationCredential('plain log only', {
      runId: 'lf-run',
      target: LF_CONSUMED_TARGET,
      instance: instanceIdentity(),
    });
    expect(invalid.ok).toBe(false);
    const child = runSpec(J_SPEC, 'J05');
    expect(child.status).toBe(0);
    expect(child.output).toContain('OUTER_FINAL=skipped-not-owned');
    expect(child.output).toContain('OUTER_CLOSE=closed');
    console.log('L_F=green');
  });
});
