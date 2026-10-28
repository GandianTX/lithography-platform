// test/utils/e2e-probe-lifecycle-ld-owner.e2e-spec.ts
//
// L01 / V-LD / V-PENDING 子规格：验证“驱动器自己接收并登记的拥有者账本”
// 在用例异常退出后，真实 afterAll 仍能访问。
//
// 该文件是故意失败/故意未决的验收子规格，不进入普通 core 直接收录；
// 由 e2e-probe-lifecycle-faults.e2e-spec.ts（外层永久驱动）通过正式 runner 精确选择。
//
// 边界：只处理本规格明确接收的本轮故障目标；无凭据/错 run/target/instance 不认领。

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
  createProbeOwnershipRegistry,
  createProbeRunLedger,
  describeProbeSettleResult,
  dropLedgerOwnedProbe,
  formatProbeCreationCredential,
  parseProbeCreationCredential,
  probeDatabaseExists,
  probeInstanceIdentity,
  probeSettlementState,
  restoreProbeConsent,
  runProbeLifecycleTeardown,
  throwProbeSettlementError,
  type ProbeConsentSnapshot,
  type ProbeOwnedLedgerEntry,
  type ProbeQueryable,
  type ProbeRunLedger,
} from './probe-database-lifecycle';

jest.setTimeout(1200000);

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const J_SPEC = 'test/utils/e2e-probe-lifecycle-outer.e2e-spec.ts';
const FAULT_TARGET = 'lithography_e2e_probe_fault';
const PROBE_DATABASE = 'lithography_e2e_probe';
const AUX_DATABASE = 'lithography_e2e_probe_aux';

const J_INJECT_ENV = 'E2E_J_INJECT';
const J_FINAL_DROP_ENV = 'E2E_J_FINAL_DROP';
const J_FAULT_TARGET_ENV = 'E2E_J_FAULT_TARGET';
const J_FAULT_RUN_ID_ENV = 'E2E_J_FAULT_RUN_ID';
/** 本规格自己的运行身份；外层可固定，便于凭据解析与独立查库。 */
const LD_OWNER_RUN_ID_ENV = 'E2E_LD_OWNER_RUN_ID';
/** 拥有者第一次回收在发送前失败一次；正常 core 运行不设置。 */
const LD_OWNER_FAIL_ENV = 'E2E_LD_OWNER_FAIL';
/** 真实最终收尾故意“结果未知”；正常 core 运行不设置。 */
const LD_OWNER_FINAL_ENV = 'E2E_LD_OWNER_FINAL';
const LD_OWNER_LABEL = 'ld-owner';

let app: INestApplication | null = null;
let dataSource: DataSource | null = null;
let consent: ProbeConsentSnapshot | null = null;
/** 该规格的窄收尾集合：L-D 接收的拥有者账本在登记时即进入这里。 */
const ownedLedgers = createProbeOwnershipRegistry();

const requireDataSource = (helper: string): DataSource => {
  if (!dataSource) {
    throw new Error(`[${helper}] 主 DataSource 未初始化`);
  }
  return dataSource;
};

const instanceIdentity = (): string =>
  probeInstanceIdentity(requireDataSource('probe-lifecycle-ld-owner'));

const mainDatabaseName = (): string => {
  const configured = requireDataSource('probe-lifecycle-ld-owner').options.database;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error('L-D 拥有者子规格主 DataSource 缺少 options.database');
  }
  return configured.trim();
};

const databaseExists = (name: string): Promise<boolean> =>
  probeDatabaseExists(requireDataSource('probe-lifecycle-ld-owner'), name);

const currentRunId = (): string => {
  const fixed = (process.env[LD_OWNER_RUN_ID_ENV] ?? '').trim();
  if (fixed !== '') {
    return fixed;
  }
  return `l-ld-owner-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

const envFlag = (key: string): string => (process.env[key] ?? '').trim();

/** 子 J06 环境：显式绑定故障目标与本轮 runId，清除其他注错开关。 */
const buildJ06Env = (runId: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_GROUP: 'core',
    E2E_SKIP_DB_CLEANUP: 'true',
    E2E_ALLOW_DB_CLEANUP: '0',
    E2E_ALLOWED_DB_NAMES: [mainDatabaseName(), PROBE_DATABASE, AUX_DATABASE, FAULT_TARGET].join(
      ',',
    ),
    [J_INJECT_ENV]: 'final-drop-unknown',
    [J_FINAL_DROP_ENV]: 'unknown',
    [J_FAULT_TARGET_ENV]: FAULT_TARGET,
    [J_FAULT_RUN_ID_ENV]: runId,
  };
  delete env.E2E_SPECS;
  delete env.E2E_G04_RUN_ID;
  delete env.E2E_G04_INJECT;
  delete env.E2E_H_PARENT_INJECT;
  delete env.E2E_H06_DROP;
  delete env[LD_OWNER_FAIL_ENV];
  delete env[LD_OWNER_FINAL_ENV];
  delete env[LD_OWNER_RUN_ID_ENV];
  if (!env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV]) {
    env[E2E_PHYSICAL_CLEANUP_CONSENT_ENV] = '1';
  }
  return env;
};

interface ChildRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  /** spawnSync 的启动/等待错误（超时、spawn 失败等）；正常结束为 null。 */
  readonly error: Error | null;
}

const runJ06 = (runId: string): ChildRun => {
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, 'test/run-e2e-group.js'), '--file', J_SPEC, '-t', 'J06'],
    {
      cwd: BACKEND_ROOT,
      env: buildJ06Env(runId),
      encoding: 'utf8',
      timeout: 900000,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    error: result.error ?? null,
  };
};

/**
 * A04：凭据只证明创建归属，不能代替“子运行已确认结束”。
 * 未确认结束（启动/等待错误、信号终止、status=null 或非零不一致）一律拒绝，
 * 且必须发生在后台账登记与任何回收之前。
 */
const assertConfirmedChildCompletion = (child: ChildRun): void => {
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    const suffix = code ? `（code=${code}）` : '';
    throw new Error(
      `[L-D] 子 J06 未取得正常结束确认：启动/等待错误 ${child.error.message}${suffix}`,
    );
  }
  if (child.signal !== null) {
    throw new Error(`[L-D] 子 J06 未取得正常结束确认：被信号 ${child.signal} 终止`);
  }
  if (child.status === null) {
    throw new Error('[L-D] 子 J06 未取得正常结束确认：退出状态未知（status=null）');
  }
  if (child.status === 0) {
    throw new Error('[L-D] 子 J06 应因 FINAL 未知而非零退出，实际为 0');
  }
};

/**
 * 接收链的精确外部边界：默认全部使用真实实现；
 * 定向回归只替换子结果/存在性/回收替身，以便证明未确认结束时三者零调用。
 */
interface ReceiveBoundaries {
  readonly child?: (runId: string) => ChildRun;
  readonly databaseExists?: (name: string) => Promise<boolean>;
  readonly cleanupTarget?: () => ProbeQueryable;
}

/**
 * L-D 核心：子 J06 创建并保留一个结果未知的本轮故障库；
 * 本规格严格校验凭据后立即登记到规格可达集合，再执行拥有者回收。
 * @param runId 本轮固定 runId（外层可解析凭据）
 * @param drop 是否立即尝试回收；false 用于“最终收尾未知”分支
 * @param boundaries 精确边界替身；默认使用真实 spawnSync/查库/主连接
 */
const receiveAndOptionallyDrop = async (
  runId: string,
  drop: boolean,
  boundaries: ReceiveBoundaries = {},
): Promise<ProbeRunLedger> => {
  const child = (boundaries.child ?? runJ06)(runId);
  assertConfirmedChildCompletion(child);
  const parsed = parseProbeCreationCredential(child.output, {
    runId,
    target: FAULT_TARGET,
    instance: instanceIdentity(),
  });
  if (!parsed.ok) {
    throw new Error(`[L-D] 缺少可用于拥有者收尾的创建凭据：${parsed.reason}`);
  }
  if (!(await (boundaries.databaseExists ?? databaseExists)(FAULT_TARGET))) {
    throw new Error('[L-D] 子运行声明已创建，但故障目标库不存在：拒绝登记无证据资源。');
  }
  console.log('LD_PENDING_CONFIRMED=1');
  // 真实接收后立即登记；后续任何断言/回收失败都不会丢失拥有者记录。
  const ledger = ownedLedgers.add(
    LD_OWNER_LABEL,
    createProbeRunLedger({
      runId: parsed.credential.runId,
      target: parsed.credential.target,
      instance: parsed.credential.instance,
    }),
  );
  ledger.record({
    name: FAULT_TARGET,
    createdByThisRun: true,
    source: 'child-handoff',
    runId: parsed.credential.runId,
    target: parsed.credential.target,
    instance: parsed.credential.instance,
  });
  console.log('LD_OWNER_REGISTERED=1');
  console.log(
    formatProbeCreationCredential({
      runId: parsed.credential.runId,
      target: parsed.credential.target,
      instance: parsed.credential.instance,
      created: true,
    }),
  );
  if (!drop) {
    return ledger;
  }
  const outcome = await dropLedgerOwnedProbe(
    ledger,
    () => {
      if (boundaries.cleanupTarget) {
        return boundaries.cleanupTarget();
      }
      if (envFlag(LD_OWNER_FAIL_ENV) === 'once-fail') {
        console.log('LD_OWNER_INJECTED=drop-before-send');
        return {
          query: () =>
            Promise.reject(new Error('L-D 拥有者回收注入：DROP 在发送前失败一次（未发送 SQL）')),
        } satisfies ProbeQueryable;
      }
      return requireDataSource('L-D owner cleanup');
    },
    'L-D owner cleanup',
  );
  console.log(`LD_OWNER_CLEANUP=${outcome}`);
  return ledger;
};

describe('L-D 拥有者账本真实收尾验收子规格', () => {
  beforeAll(async () => {
    consent = captureAndValidateProbeConsent('probe-lifecycle-ld-owner');
    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const mainDataSource: DataSource = app.get(DataSource);
    dataSource = mainDataSource;
    await assertDataSourceOnAllowedE2eDatabase(mainDataSource);
    for (const name of [PROBE_DATABASE, AUX_DATABASE, FAULT_TARGET]) {
      if (await databaseExists(name)) {
        throw new Error(
          `[probe-lifecycle-ld-owner] 目标库 "${name}" 已存在且无本轮创建凭据：拒绝启动，不执行任何 DROP。`,
        );
      }
    }
    console.log('LD_OWNER_PRECHECK=absent');
  });

  afterAll(async () => {
    await runProbeLifecycleTeardown('probe-lifecycle-ld-owner', {
      dropProbe: async () => {
        const settlement = await ownedLedgers.settle((entry: ProbeOwnedLedgerEntry) => {
          if (entry.label === LD_OWNER_LABEL && envFlag(LD_OWNER_FINAL_ENV) === 'unknown') {
            console.log(`LD_OWNER_FINAL_INJECTED=${entry.label}`);
            return {
              query: () =>
                Promise.reject(new Error('LD FINAL 注入：DROP 响应未知（记录未消费，保留未决）')),
            } satisfies ProbeQueryable;
          }
          if (!dataSource?.isInitialized) {
            throw new Error(
              `[probe-lifecycle-ld-owner FINAL ${entry.label}] 主连接不可用：保留已登记资源与目标诊断，不伪报已释放。`,
            );
          }
          return dataSource;
        }, 'probe-lifecycle-ld-owner FINAL');
        for (const result of settlement.results) {
          console.log(`LD_OWNER_FINAL_${result.label}=${describeProbeSettleResult(result)}`);
        }
        console.log(`LD_OWNER_FINAL=${probeSettlementState(settlement)}`);
        throwProbeSettlementError(settlement, 'probe-lifecycle-ld-owner FINAL');
      },
      restoreEnv: () => {
        if (consent) {
          restoreProbeConsent(consent);
          console.log('LD_OWNER_ENV_RESTORED=1');
          return;
        }
        console.log('LD_OWNER_ENV_RESTORED=not-needed');
      },
      closeApp: async () => {
        if (app) {
          await app.close();
          console.log('LD_OWNER_CLOSE=closed');
          return;
        }
        console.log('LD_OWNER_CLOSE=no-app');
      },
    });
  });

  const fakeCompletion = (runId: string, overrides: Partial<ChildRun>): ChildRun => ({
    status: 1,
    signal: null,
    output: formatProbeCreationCredential({
      runId,
      target: FAULT_TARGET,
      instance: instanceIdentity(),
      created: true,
    }),
    error: null,
    ...overrides,
  });

  /** 拒绝必须发生在查库/登记/回收之前：计数为零且账本集合不变。 */
  const expectUnconfirmedRefused = async (
    label: string,
    buildChild: (runId: string) => ChildRun,
    pattern: RegExp,
  ): Promise<void> => {
    const runId = currentRunId();
    const before = ownedLedgers.entries().length;
    let existenceChecks = 0;
    let dropAttempts = 0;
    await expect(
      receiveAndOptionallyDrop(runId, true, {
        child: () => buildChild(runId),
        databaseExists: () => {
          existenceChecks += 1;
          return Promise.resolve(true);
        },
        cleanupTarget: () => ({
          query: () => {
            dropAttempts += 1;
            return Promise.resolve([]);
          },
        }),
      }),
    ).rejects.toThrow(pattern);
    expect(ownedLedgers.entries().length).toBe(before);
    expect(existenceChecks).toBe(0);
    expect(dropAttempts).toBe(0);
    console.log(`LD_A04_REFUSED_${label}=1`);
  };

  it('A04 status=null 且带匹配创建凭据：拒绝，零登记/零 DROP', async () => {
    await expectUnconfirmedRefused(
      'null_status',
      (runId) => fakeCompletion(runId, { status: null }),
      /status=null/,
    );
  });

  it('A04 信号终止且带匹配创建凭据：拒绝，零登记/零 DROP', async () => {
    await expectUnconfirmedRefused(
      'signal',
      (runId) => fakeCompletion(runId, { status: null, signal: 'SIGKILL' }),
      /信号 SIGKILL/,
    );
  });

  it('A04 信号与数值状态不一致：拒绝，不因 status 非零放行', async () => {
    await expectUnconfirmedRefused(
      'signal_with_status',
      (runId) => fakeCompletion(runId, { status: 1, signal: 'SIGTERM' }),
      /信号 SIGTERM/,
    );
  });

  it('A04 启动/等待错误且带匹配创建凭据：拒绝，零登记/零 DROP', async () => {
    await expectUnconfirmedRefused(
      'spawn_error',
      (runId) =>
        fakeCompletion(runId, {
          status: null,
          signal: 'SIGTERM',
          error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        }),
      /ETIMEDOUT/,
    );
  });

  it('A04 零退出：继续拒绝，不登记/不删除', async () => {
    await expectUnconfirmedRefused(
      'zero_exit',
      (runId) => fakeCompletion(runId, { status: 0 }),
      /实际为 0/,
    );
  });

  it('V-LD 拥有者回收发送前失败：登记后异常退出，真实 FINAL 发现账本并安全回收', async () => {
    const runId = currentRunId();
    // 注入时 dropLedgerOwnedProbe 会抛错；不许在此 catch 后手工清理——
    // 必须让真实 afterAll 处理已登记账本。未注入时本调用成功并消费记录。
    await receiveAndOptionallyDrop(runId, true);
  });

  it('V-PENDING 拥有者最终收尾结果未知：记录保留、非零退出、恢复与关闭仍执行', async () => {
    const runId = currentRunId();
    await receiveAndOptionallyDrop(runId, false);
    // 记录已登记且未消费；真实 afterAll 将按注入执行“结果未知”，保留未决状态。
    if (!(await databaseExists(FAULT_TARGET))) {
      throw new Error('[V-PENDING] 未决分支要求故障目标库真实存在');
    }
    console.log('LD_OWNER_LEFT_PENDING=1');
  });
});
