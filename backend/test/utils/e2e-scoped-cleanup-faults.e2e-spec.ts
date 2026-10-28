// test/utils/e2e-scoped-cleanup-faults.e2e-spec.ts
//
// F07/F08/F09 的父规格：以真实 Jest 子进程运行 test/fixtures/cleanup-faults-child.e2e-spec.ts，
// 断言 runner 非 0、诊断/失败消息可见、afterAll 真实回收后零残留。
//
// 子进程故意失败，父规格只验证“失败是否被如实传播 + 是否仍能安全回收”。

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { DataSource } from 'typeorm';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { ApiModule } from '../../src/bootstraps/api/api.module';
import { assertDataSourceOnAllowedE2eDatabase } from './e2e-db-guard';

jest.setTimeout(300000);

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const CHILD_SPEC = 'test/fixtures/cleanup-faults-child.e2e-spec.ts';
const D1_CHILD_SPEC = 'test/fixtures/cleanup-beforeall-failure-child.e2e-spec.ts';

interface ChildRun {
  readonly status: number | null;
  readonly output: string;
  readonly tag: string | null;
}

let app: INestApplication | null = null;
let dataSource: DataSource;
let run: ChildRun;
/** G01：启动许可缺失 / 显式为 0 的两个真实子进程。 */
let consentMissingRun: ChildRun;
let consentZeroRun: ChildRun;
/** D1：真实 beforeAll 失败后由 afterAll 收尾的子进程。 */
let d1Run: ChildRun;
/** G01：两次被拒绝启动期间实例级 DELETE 语句增量（必须为 0）。 */
let rejectedRunsDeleteDelta = -1;

const matchTag = (output: string): string | null => {
  const matched = /CHILD_TAG=([a-z0-9]+)/i.exec(output);
  return matched ? matched[1] : null;
};

const runChild = (spec: string, consentOverride?: { readonly value?: string }): ChildRun => {
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_GROUP: 'core' };
  if (consentOverride) {
    if (consentOverride.value === undefined) {
      delete env.E2E_ALLOW_PHYSICAL_CLEANUP;
    } else {
      env.E2E_ALLOW_PHYSICAL_CLEANUP = consentOverride.value;
    }
  }
  const result = spawnSync(
    process.execPath,
    [path.join(BACKEND_ROOT, 'test/run-e2e-group.js'), '--file', spec],
    {
      cwd: BACKEND_ROOT,
      env,
      encoding: 'utf8',
      timeout: 240000,
    },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { status: result.status, output, tag: matchTag(output) };
};

const readGlobalDeleteCount = async (): Promise<number> => {
  const rows = await dataSource.query<Array<Record<string, unknown>>>(
    "SHOW GLOBAL STATUS LIKE 'Com_delete'",
  );
  return Number(rows[0]?.Value ?? -1);
};

const expectNoChildRows = async (tag: string | null): Promise<void> => {
  expect(tag).not.toBeNull();
  const pattern = `%${String(tag)}`;
  const accounts = await dataSource.query(
    'SELECT id FROM base_user_account WHERE login_name LIKE ?',
    [pattern],
  );
  const userInfos = await dataSource.query('SELECT id FROM base_user_info WHERE email LIKE ?', [
    pattern,
  ]);
  expect(accounts).toHaveLength(0);
  expect(userInfos).toHaveLength(0);
};

describe('cleanup 故障生命周期（真实 Jest 子进程）', () => {
  beforeAll(async () => {
    initGraphQLSchema();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    await assertDataSourceOnAllowedE2eDatabase(dataSource);

    // F07/F08/F09：正常许可下的永久反例（子进程故意失败）。
    run = runChild(CHILD_SPEC);

    // G01：许可缺失与显式 0 都必须在造数前失败关闭，且不执行任何 DELETE。
    const deleteBefore = await readGlobalDeleteCount();
    consentMissingRun = runChild(CHILD_SPEC, { value: undefined });
    consentZeroRun = runChild(CHILD_SPEC, { value: '0' });
    const deleteAfter = await readGlobalDeleteCount();
    rejectedRunsDeleteDelta = deleteAfter - deleteBefore;

    // G11：真实 beforeAll 在登记后失败，afterAll 必须真实收尾并零残留。
    d1Run = runChild(D1_CHILD_SPEC);

    // 把子进程的判定证据落到父规格输出，便于回执/日志复核（不打印整段噪声）。
    const evidence =
      `${run.output}\n${consentMissingRun.output}\n${consentZeroRun.output}\n${d1Run.output}`
        .split(/\r?\n/)
        .filter((line) =>
          /CHILD_TAG=|F07_OK|F08_OK|F09_|D1_|启动许可未通过|台账保留|上一用例清理失败|拒绝在未恢复前继续造数/.test(
            line,
          ),
        )
        .map((line) => line.replace(/^.*?(?=\[|F|D|CHILD_TAG|启动许可)/, ''));
    console.log(
      `CHILD_EXIT=${String(run.status)}\nCONSENT_MISSING_EXIT=${String(consentMissingRun.status)}\n` +
        `CONSENT_ZERO_EXIT=${String(consentZeroRun.status)}\nCONSENT_DELETE_DELTA=${rejectedRunsDeleteDelta}\n` +
        `D1_EXIT=${String(d1Run.status)}\n${evidence.join('\n')}`,
    );
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('F09 runner 非 0，且诊断/失败关闭/afterAll 回收证据都在子进程输出中', () => {
    expect(run.tag).not.toBeNull();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('F07_OK');
    expect(run.output).toContain('F08_OK');
    expect(run.output).toContain('F09_AFTEREACH_FAIL_SET');
    expect(run.output).toContain('上一用例清理失败');
    expect(run.output).toContain('台账保留');
    expect(run.output).toContain('F09_RESIDUE=0');
  });

  it('F09 子进程退出后父规格直连数据库核对零残留（无迟到写入）', async () => {
    expect(run.tag).not.toBeNull();
    await expectNoChildRows(run.tag);
  });

  it('G01 许可缺失/为 0 时启动即失败关闭：零造数、零 DELETE、错误可辨、资源已关闭', async () => {
    expect(rejectedRunsDeleteDelta).toBe(0);
    const cases: Array<{ label: string; child: ChildRun }> = [
      { label: '缺失', child: consentMissingRun },
      { label: '为 0', child: consentZeroRun },
    ];
    for (const { label, child } of cases) {
      expect(child.status).not.toBe(0);
      expect(child.tag).not.toBeNull();
      expect(child.output).toContain('启动许可未通过');
      expect(child.output).toContain('E2E_ALLOW_PHYSICAL_CLEANUP');
      expect(child.output).toContain('F09_AFTERALL_STATE=consent-rejected');
      expect(child.output).toContain('F09_AFTERALL_NO_CLEANUP=consent-rejected');
      expect(child.output).toContain('F09_CLOSE=no-app');
      // 不得出现任何“已造数/已回收/零残留”的成功证据
      expect(child.output).not.toContain('F07_OK');
      expect(child.output).not.toContain('F08_OK');
      expect(child.output).not.toContain('F09_RESIDUE=0');
      await expectNoChildRows(child.tag);
      console.log(`G01_${label}_OK`);
    }
  });

  it('G02 原始许可 1 → 测试主动撤销 → afterAll 只恢复已校验原值且仍完成回收/关闭', () => {
    expect(process.env.E2E_ALLOW_PHYSICAL_CLEANUP).toBe('1');
    expect(run.output).toContain('F09_AFTERALL_STATE=ready');
    expect(run.output).toContain('F09_ENV_RESTORED=1');
    expect(run.output).toContain('F09_CLOSE=closed');
    expect(run.output).toContain('F09_RESIDUE=0');
    console.log('G02_OK');
  });

  it('G11 D1 真实 beforeAll 失败 → 真实 afterAll 收尾：runner 非 0 且父进程核对零残留', async () => {
    expect(d1Run.status).not.toBe(0);
    expect(d1Run.tag).not.toBeNull();
    expect(d1Run.output).toContain('D1_AFTERALL_STATE=ready');
    expect(d1Run.output).toContain('D1_SECOND_FAILED=1');
    expect(d1Run.output).toContain('D1_SECOND_RESIDUE=0');
    expect(d1Run.output).toContain('D1_RESIDUE=0');
    expect(d1Run.output).toContain('D1_CLOSE=closed');
    expect(d1Run.output).toContain('D1 注入：第二笔真实事务失败后终止 beforeAll');
    await expectNoChildRows(d1Run.tag);
    console.log('G11_OK');
  });
});
