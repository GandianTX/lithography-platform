import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAdminBootstrapConfig } from './admin-bootstrap';
import {
  assertInitializationEmailConflicts,
  parseDeployCliArgs,
  runInitializationDataTransaction,
  type InitializationQueryRunner,
} from './database-deploy';
import {
  assertDevAccountTargetDatabase,
  parseDevAccountBootstrapConfig,
} from './dev-account-bootstrap';
import { parseDevDataConfig } from './dev-data-bootstrap';
import {
  claimDevSampleFilesDirectory,
  deleteDevSampleFile,
  sha256Of,
  writeDevSampleFile,
  type DevSampleFileClaim,
} from './dev-sample-files';
import { parseOrganizationBootstrapConfig } from './organization-bootstrap';

const DOCS_DIR = join(__dirname, '../../../../docs/database/v13-deployment');

const validAdminFile = JSON.stringify({
  schema_version: 1,
  accounts: [
    {
      login_name: 'admin01',
      login_email: 'admin01@example.com',
      password: 'valid-password-01',
      admin_level: 1,
      organization_code: 'ORG-001',
      nickname: '管理员一',
      real_name: '张三',
    },
  ],
});

describe('database:deploy 参数（不连接实库）', () => {
  it('init 必须显式给出模式、配置文件、库名与一致确认', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
      ]),
    ).not.toThrow();
  });

  it('库名确认不一致时失败关闭', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=other',
      ]),
    ).toThrow(/confirm-database/);
  });

  it('upgrade 拒绝管理员初始化参数，避免每次部署重建账号', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--admin-bootstrap-file=admins.json',
        '--confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP',
      ]),
    ).toThrow(/只允许在 init/);
  });

  it('init 启用管理员初始化时必须给出显式确认口令', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--admin-bootstrap-file=admins.json',
      ]),
    ).toThrow(/confirm-admin-bootstrap/);
  });

  it('缺少模式、配置文件或库名时失败关闭', () => {
    expect(() => parseDeployCliArgs([])).toThrow(/mode/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--database=lithography',
        '--confirm-database=lithography',
      ]),
    ).toThrow(/config-file/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--confirm-database=lithography',
      ]),
    ).toThrow(/database/);
  });

  it('init 允许组织、管理员与开发账号在同一条命令中显式启用', () => {
    const options = parseDeployCliArgs([
      '--mode=init',
      '--config-file=.env.deploy',
      '--database=lithography_dev',
      '--confirm-database=lithography_dev',
      '--environment=development',
      '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      '--confirm-dev-target=lithography_dev',
      '--organization-bootstrap-file=organizations.json',
      '--confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP',
      '--admin-bootstrap-file=admins.json',
      '--confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP',
      '--dev-accounts-file=dev-accounts.json',
      '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
    ]);
    expect(options.environment).toBe('development');
    expect(options.expectServerUuid).toBe('6ccd2f7e-1b0f-11ee-be56-0242ac120002');
    expect(options.confirmDevTarget).toBe('lithography_dev');
    expect(options.organizationBootstrapFile).toBe('organizations.json');
    expect(options.adminBootstrapFile).toBe('admins.json');
    expect(options.devAccountsFile).toBe('dev-accounts.json');
  });

  it('组织初始化缺少确认口令或单独使用确认口令时失败关闭', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--organization-bootstrap-file=organizations.json',
      ]),
    ).toThrow(/confirm-organization-bootstrap/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP',
      ]),
    ).toThrow(/organization-bootstrap-file/);
  });

  it('开发账号初始化缺少确认口令时失败关闭', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--environment=development',
        '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
        '--confirm-dev-target=lithography_dev',
        '--dev-accounts-file=dev-accounts.json',
      ]),
    ).toThrow(/confirm-dev-accounts/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--environment=development',
        '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
        '--confirm-dev-target=lithography_dev',
        '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
      ]),
    ).toThrow(/dev-accounts-file/);
  });

  it('开发账号初始化拒绝看起来像正式库的目标库名', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_prod',
        '--confirm-database=lithography_prod',
        '--environment=development',
        '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
        '--confirm-dev-target=lithography_prod',
        '--dev-accounts-file=dev-accounts.json',
        '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
      ]),
    ).toThrow(/开发或测试库/);
  });

  it('开发账号与联调样例必须显式选择开发环境并独立核对实例与目标库', () => {
    const base = [
      '--mode=init',
      '--config-file=.env.deploy',
      '--database=lithography_dev',
      '--confirm-database=lithography_dev',
      '--dev-data-file=dev-data.json',
      '--confirm-dev-data=APPLY-DEV-DATA',
    ];
    expect(() => parseDeployCliArgs(base)).toThrow(/environment=development/);
    expect(() =>
      parseDeployCliArgs([
        ...base,
        '--environment=production',
        '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
        '--confirm-dev-target=lithography_dev',
      ]),
    ).toThrow(/production/);
    expect(() =>
      parseDeployCliArgs([
        ...base,
        '--environment=development',
        '--confirm-dev-target=lithography_dev',
      ]),
    ).toThrow(/expect-server-uuid/);
    expect(() =>
      parseDeployCliArgs([
        ...base,
        '--environment=development',
        '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
        '--confirm-dev-target=other_dev',
      ]),
    ).toThrow(/confirm-dev-target=lithography_dev/);
  });

  it('开发联调样例必须给出独立确认口令', () => {
    const args = [
      '--mode=init',
      '--config-file=.env.deploy',
      '--database=lithography_dev',
      '--confirm-database=lithography_dev',
      '--environment=development',
      '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      '--confirm-dev-target=lithography_dev',
      '--dev-data-file=dev-data.json',
    ];
    expect(() => parseDeployCliArgs(args)).toThrow(/confirm-dev-data/);
    expect(() => parseDeployCliArgs([...args, '--confirm-dev-data=YES'])).toThrow(
      /confirm-dev-data/,
    );
    expect(() => parseDeployCliArgs([...args, '--confirm-dev-data=APPLY-DEV-DATA'])).not.toThrow();
  });

  it('开发样例原件目录必须与开发样例同时启用并重复确认', () => {
    const base = [
      '--mode=init',
      '--config-file=.env.deploy',
      '--database=lithography_dev_v13_accept',
      '--confirm-database=lithography_dev_v13_accept',
      '--environment=development',
      '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      '--confirm-dev-target=lithography_dev_v13_accept',
      '--dev-data-file=dev-data.json',
      '--confirm-dev-data=APPLY-DEV-DATA',
    ];
    const dir = '/srv/lithography/reference-documents/lithography_dev_v13_accept';
    expect(() => parseDeployCliArgs([...base, `--dev-sample-files-dir=${dir}`])).toThrow(
      /confirm-dev-sample-files/,
    );
    expect(() =>
      parseDeployCliArgs([
        ...base,
        `--dev-sample-files-dir=${dir}`,
        '--confirm-dev-sample-files=/other/path',
      ]),
    ).toThrow(/confirm-dev-sample-files/);
    expect(() =>
      parseDeployCliArgs([
        ...base,
        `--dev-sample-files-dir=${dir}`,
        `--confirm-dev-sample-files=${dir}`,
      ]),
    ).not.toThrow();
  });

  it('生产与升级入口拒绝开发样例原件目录参数', () => {
    const dir = '/srv/lithography/reference-documents/lithography_dev_v13_accept';
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--environment=production',
        '--dev-sample-files-dir=' + dir,
        '--confirm-dev-sample-files=' + dir,
      ]),
    ).toThrow(/production/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev_v13_accept',
        '--confirm-database=lithography_dev_v13_accept',
        '--dev-sample-files-dir=' + dir,
        '--confirm-dev-sample-files=' + dir,
      ]),
    ).toThrow(/只允许在 init/);
  });

  it('拟定开发验收库名通过目标守卫，共享验收库继续被拒绝', () => {
    expect(() => assertDevAccountTargetDatabase('lithography_dev_v13_accept')).not.toThrow();
    expect(() => assertDevAccountTargetDatabase('lithography_drill')).toThrow(/共享库/);
    expect(() => assertDevAccountTargetDatabase('lithography_e2e')).toThrow(/共享库/);
  });

  it('开发样例拒绝现有共享验收库与非法实例 UUID', () => {
    for (const database of ['lithography_drill', 'lithography_e2e']) {
      expect(() =>
        parseDeployCliArgs([
          '--mode=init',
          '--config-file=.env.deploy',
          `--database=${database}`,
          `--confirm-database=${database}`,
          '--environment=development',
          '--expect-server-uuid=6ccd2f7e-1b0f-11ee-be56-0242ac120002',
          `--confirm-dev-target=${database}`,
          '--dev-data-file=dev-data.json',
          '--confirm-dev-data=APPLY-DEV-DATA',
        ]),
      ).toThrow(/共享库/);
    }
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--expect-server-uuid=not-a-uuid',
      ]),
    ).toThrow(/server_uuid|UUID/);
  });

  it('upgrade 拒绝开发联调样例与开发目标确认', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--dev-data-file=dev-data.json',
        '--confirm-dev-data=APPLY-DEV-DATA',
      ]),
    ).toThrow(/只允许在 init/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--confirm-dev-target=lithography_dev',
      ]),
    ).toThrow(/只允许在 init/);
  });

  it('upgrade 拒绝组织与开发账号初始化参数', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--organization-bootstrap-file=organizations.json',
        '--confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP',
      ]),
    ).toThrow(/只允许在 init/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--dev-accounts-file=dev-accounts.json',
        '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
      ]),
    ).toThrow(/只允许在 init/);
  });
});

describe('初始化事务终局与原件补偿（替身，不连接实库）', () => {
  function makeClaim(reference: string): DevSampleFileClaim {
    return {
      storageReference: reference,
      filePath: `/tmp/lithography_dev_v13_accept/${reference}`,
      stagingPath: `/tmp/lithography_dev_v13_accept/${reference}`,
      finalPath: `/tmp/lithography_dev_v13_accept/${reference}`,
      published: true,
      identity: { device: BigInt(1), inode: BigInt(2) },
      ownership: {
        directory: '/tmp/lithography_dev_v13_accept',
        database: 'lithography_dev_v13_accept',
        serverUuid: '6ccd2f7e-1b0f-11ee-be56-0242ac120002',
        markerPath: '/tmp/lithography_dev_v13_accept/.owner.json',
        markerIdentity: { device: BigInt(1), inode: BigInt(1) },
      },
      currentIdentity: async () => ({ device: BigInt(1), inode: BigInt(2) }),
      close: async () => undefined,
    } as unknown as DevSampleFileClaim;
  }

  function makeRunner(): {
    readonly runner: InitializationQueryRunner;
    readonly connect: jest.Mock;
    readonly start: jest.Mock;
    readonly commit: jest.Mock;
    readonly rollback: jest.Mock;
    readonly release: jest.Mock;
    readonly destroy: jest.Mock;
    readonly query: jest.Mock;
  } {
    const connect = jest.fn(async () => undefined);
    const start = jest.fn(async () => undefined);
    const commit = jest.fn(async () => undefined);
    const rollback = jest.fn(async () => undefined);
    const release = jest.fn(async () => undefined);
    const destroy = jest.fn(async () => undefined);
    const query = jest.fn(async () => []);
    const runner = {
      manager: { query } as unknown as InitializationQueryRunner['manager'],
      connect,
      startTransaction: start,
      commitTransaction: commit,
      rollbackTransaction: rollback,
      release,
      destroy,
    };
    return { runner, connect, start, commit, rollback, release, destroy, query };
  }

  const claims = [makeClaim(`${'a'.repeat(32)}.txt`), makeClaim(`${'b'.repeat(32)}.txt`)];
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  function options(
    runner: InitializationQueryRunner,
    overrides: {
      readonly run: () => Promise<unknown>;
      readonly probeReference?: () => Promise<boolean>;
      readonly removeSampleFile?: () => Promise<'DELETED' | 'RETAINED'>;
    },
  ): Parameters<typeof runInitializationDataTransaction>[0] {
    return {
      dataSource: { createQueryRunner: () => runner } as never,
      database: 'lithography_dev_v13_accept',
      logger,
      sampleFilesDir: '/tmp/lithography_dev_v13_accept',
      claims,
      run: overrides.run,
      probeReference: overrides.probeReference ?? (async () => false),
      removeSampleFile: overrides.removeSampleFile ?? (async () => 'DELETED'),
    };
  }

  type CapturedError = Error & { cleanupErrors?: ReadonlyArray<string> };

  async function captureError(promise: Promise<unknown>): Promise<CapturedError> {
    try {
      await promise;
    } catch (error) {
      return error as CapturedError;
    }
    throw new Error('期望失败但调用成功');
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([true, false])('部分写入后无论回滚回执是否确认都不自动删除残件（确认=%s）', async (confirmed) => {
    const root = mkdtempSync(join(tmpdir(), 'dev-deploy-partial-'));
    try {
      const database = 'lithography_dev_v13_accept';
      const directory = join(root, database);
      mkdirSync(directory);
      const ownership = await claimDevSampleFilesDirectory(
        directory,
        database,
        '6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      );
      const storageReference = `${'a'.repeat(32)}.txt`;
      const partial = join(directory, storageReference);
      const existing = join(directory, `${'b'.repeat(32)}.txt`);
      writeFileSync(existing, '预存文件');
      const content = Buffer.from('sample');
      const main = new Error('partial write');
      const pending: DevSampleFileClaim[] = [];
      const { runner, rollback, release, destroy } = makeRunner();
      rollback.mockImplementationOnce(async () => {
        const staged = (pending[0] as unknown as { stagingPath: string }).stagingPath;
        expect(staged).not.toBe(partial);
        expect(readFileSync(staged)).toEqual(content.subarray(0, 2));
        if (!confirmed) throw new Error('rollback lost');
      });

      const error = await captureError(
        runInitializationDataTransaction({
          ...options(runner, { run: async () => undefined }),
          sampleFilesDir: directory,
          claims: pending,
          removeSampleFile: deleteDevSampleFile,
          run: async () =>
            writeDevSampleFile(
              directory,
              {
                originalFilename: 'sample.txt',
                mimeType: 'text/plain',
                byteSize: content.length,
                sha256: sha256Of(content),
                content,
              },
              {
                storageReference,
                ownership,
                onClaim: (claim) => pending.push(claim),
                writeContent: async (handle) => {
                  await handle.write(content.subarray(0, 2));
                  throw main;
                },
              },
            ),
        }),
      );

      expect(error).toBe(main);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(destroy).toHaveBeenCalledTimes(confirmed ? 0 : 1);
      expect(pending).toHaveLength(1);
      const claimView = pending[0] as unknown as {
        stagingPath: string;
        finalPath: string;
        published: boolean;
      };
      expect(claimView.published).toBe(false);
      expect(claimView.finalPath).toBe(partial);
      expect(existsSync(partial)).toBe(false);
      expect(readFileSync(existing, 'utf8')).toBe('预存文件');
      expect(readFileSync(claimView.stagingPath)).toEqual(content.subarray(0, 2));
      const notes = error.cleanupErrors?.join(' | ') ?? '';
      if (confirmed) {
        expect(notes).toContain(claimView.stagingPath);
        expect(notes).toContain('state=ROLLBACK_CONFIRMED');
        expect(notes).toContain('共享原件目录无独占删除边界');
      } else {
        expect(notes).toContain(claimView.stagingPath);
        expect(notes).toContain('rollback lost');
        expect(notes).toContain('state=UNKNOWN');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('确认回滚后只探测本轮已登记原件的引用，不再自动删除并关闭句柄', async () => {
    const { runner, release } = makeRunner();
    const main = new Error('样例插入失败');
    const removeSampleFile = jest.fn(async () => 'RETAINED' as const);
    const probeReference = jest.fn(async () => false);
    const closeSpies = claims.map((claim) => jest.spyOn(claim, 'close'));

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => {
            throw main;
          },
          removeSampleFile,
          probeReference,
        }),
      ),
    );

    expect(error).toBe(main);
    expect(removeSampleFile).toHaveBeenCalledTimes(2);
    expect(
      removeSampleFile.mock.calls.map(
        (call) => (call as unknown as [DevSampleFileClaim])[0].storageReference,
      ),
    ).toEqual(claims.map((claim) => claim.storageReference));
    expect(probeReference).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    for (const spy of closeSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    const notes = error.cleanupErrors?.join(' | ') ?? '';
    for (const claim of claims) {
      expect(notes).toContain(claim.filePath);
    }
    expect(notes).toContain('state=ROLLBACK_CONFIRMED');
    expect(notes).toContain('共享原件目录无独占删除边界');
    expect(logger.error.mock.calls.map((call) => String(call[0])).join(' | ')).toContain(
      '待人工处置',
    );
  });

  it('回滚失败但别处查不到引用时仍保留原件，且不归还连接', async () => {
    const { runner, rollback, release } = makeRunner();
    rollback.mockRejectedValueOnce(new Error('rollback lost'));
    const main = new Error('样例插入失败');
    const removeSampleFile = jest.fn(async () => 'DELETED' as const);
    const probeReference = jest.fn(async () => false);

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => {
            throw main;
          },
          removeSampleFile,
          probeReference,
        }),
      ),
    );

    expect(error).toBe(main);
    expect(removeSampleFile).not.toHaveBeenCalled();
    expect(probeReference).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(error.cleanupErrors?.join(' | ')).toContain('ROLLBACK 未取得成功回执');
    expect(logger.error.mock.calls.map((call) => String(call[0])).join(' | ')).toContain(
      'state=UNKNOWN',
    );
  });

  it('成功发布后 COMMIT 回执丢失时保留最终路径与预存文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-deploy-commit-unknown-'));
    try {
      const database = 'lithography_dev_v13_accept';
      const directory = join(root, database);
      mkdirSync(directory);
      const ownership = await claimDevSampleFilesDirectory(
        directory,
        database,
        '6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      );
      const storageReference = `${'c'.repeat(32)}.txt`;
      const target = join(directory, storageReference);
      const existing = join(directory, `${'d'.repeat(32)}.txt`);
      writeFileSync(existing, '预存文件');
      const content = Buffer.from('committed sample');
      const pending: DevSampleFileClaim[] = [];
      const { runner, commit, release, destroy } = makeRunner();
      commit.mockRejectedValueOnce(new Error('commit acknowledgement lost'));

      const error = await captureError(
        runInitializationDataTransaction({
          ...options(runner, { run: async () => undefined }),
          sampleFilesDir: directory,
          claims: pending,
          removeSampleFile: deleteDevSampleFile,
          probeReference: async () => false,
          run: async () =>
            writeDevSampleFile(
              directory,
              {
                originalFilename: 'sample.txt',
                mimeType: 'text/plain',
                byteSize: content.length,
                sha256: sha256Of(content),
                content,
              },
              { storageReference, ownership, onClaim: (claim) => pending.push(claim) },
            ),
        }),
      );

      expect(error.message).toBe('commit acknowledgement lost');
      expect(release).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(pending).toHaveLength(1);
      const claimView = pending[0] as unknown as {
        stagingPath: string;
        finalPath: string;
        published: boolean;
      };
      expect(claimView.published).toBe(true);
      expect(claimView.finalPath).toBe(target);
      expect(readFileSync(target)).toEqual(content);
      // 成功发布后的暂存硬链接同样按安全策略保留，不再自动 unlink。
      expect(readFileSync(claimView.stagingPath)).toEqual(content);
      expect(readFileSync(existing, 'utf8')).toBe('预存文件');
      expect(error.cleanupErrors?.join(' | ')).toContain(target);
      expect(error.cleanupErrors?.join(' | ')).toContain('state=UNKNOWN');
      expect(error.cleanupErrors?.join(' | ')).toContain('phase=COMMIT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('COMMIT 已发出但回执丢失时保留原件，不用 ROLLBACK 反推未提交', async () => {
    const { runner, commit, rollback, release, destroy } = makeRunner();
    const commitError = new Error('commit acknowledgement lost');
    commit.mockRejectedValueOnce(commitError);
    const removeSampleFile = jest.fn(async () => 'DELETED' as const);

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => ({ ok: true }),
          removeSampleFile,
        }),
      ),
    );

    expect(error).toBe(commitError);
    expect(removeSampleFile).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(error.cleanupErrors?.join(' | ')).toContain('COMMIT 已发出但结果未知');
  });

  it('确认回滚后引用探测失败仍保留原件', async () => {
    const { runner, release } = makeRunner();
    const main = new Error('样例插入失败');
    const removeSampleFile = jest.fn(async () => 'DELETED' as const);
    const probeReference = jest.fn(async () => {
      throw new Error('probe failed');
    });

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => {
            throw main;
          },
          removeSampleFile,
          probeReference,
        }),
      ),
    );

    expect(error).toBe(main);
    expect(removeSampleFile).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(error.cleanupErrors?.join(' | ')).toContain('原件引用探测失败');
  });

  it('确认回滚但原件仍被引用时保留现场', async () => {
    const { runner } = makeRunner();
    const main = new Error('样例插入失败');
    const removeSampleFile = jest.fn(async () => 'DELETED' as const);
    const probeReference = jest.fn(async () => true);

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => {
            throw main;
          },
          removeSampleFile,
          probeReference,
        }),
      ),
    );

    expect(error).toBe(main);
    expect(removeSampleFile).not.toHaveBeenCalled();
    expect(error.cleanupErrors?.join(' | ')).toContain('仍被正式资料引用');
  });

  it('确认回滚但已发布原件仍被正式引用时保留最终路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-deploy-referenced-'));
    try {
      const database = 'lithography_dev_v13_accept';
      const directory = join(root, database);
      mkdirSync(directory);
      const ownership = await claimDevSampleFilesDirectory(
        directory,
        database,
        '6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      );
      const storageReference = `${'e'.repeat(32)}.txt`;
      const target = join(directory, storageReference);
      const existing = join(directory, `${'f'.repeat(32)}.txt`);
      writeFileSync(existing, '预存文件');
      const content = Buffer.from('referenced sample');
      const main = new Error('样例插入失败');
      const pending: DevSampleFileClaim[] = [];
      const { runner, release } = makeRunner();

      const error = await captureError(
        runInitializationDataTransaction({
          ...options(runner, { run: async () => undefined }),
          sampleFilesDir: directory,
          claims: pending,
          removeSampleFile: deleteDevSampleFile,
          probeReference: async () => true,
          run: async () => {
            await writeDevSampleFile(
              directory,
              {
                originalFilename: 'sample.txt',
                mimeType: 'text/plain',
                byteSize: content.length,
                sha256: sha256Of(content),
                content,
              },
              { storageReference, ownership, onClaim: (claim) => pending.push(claim) },
            );
            throw main;
          },
        }),
      );

      expect(error).toBe(main);
      expect(release).toHaveBeenCalledTimes(1);
      expect(readFileSync(target)).toEqual(content);
      expect(readFileSync(existing, 'utf8')).toBe('预存文件');
      const claimView = pending[0] as unknown as { stagingPath: string };
      expect(readFileSync(claimView.stagingPath)).toEqual(content);
      expect(error.cleanupErrors?.join(' | ')).toContain('仍被正式资料引用');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('确认回滚且无引用时也不删除已发布原件，路径替换物保持原字节', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-deploy-retain-'));
    try {
      const database = 'lithography_dev_v13_accept';
      const directory = join(root, database);
      mkdirSync(directory);
      const ownership = await claimDevSampleFilesDirectory(
        directory,
        database,
        '6ccd2f7e-1b0f-11ee-be56-0242ac120002',
      );
      const storageReference = `${'a'.repeat(32)}.txt`;
      const target = join(directory, storageReference);
      const content = Buffer.from('published sample');
      const replacement = Buffer.from('核对后替换的最终路径内容\n', 'utf8');
      const main = new Error('样例插入失败');
      const pending: DevSampleFileClaim[] = [];
      const { runner, release } = makeRunner();

      const error = await captureError(
        runInitializationDataTransaction({
          ...options(runner, { run: async () => undefined }),
          sampleFilesDir: directory,
          claims: pending,
          removeSampleFile: deleteDevSampleFile,
          probeReference: async () => false,
          run: async () => {
            await writeDevSampleFile(
              directory,
              {
                originalFilename: 'sample.txt',
                mimeType: 'text/plain',
                byteSize: content.length,
                sha256: sha256Of(content),
                content,
              },
              { storageReference, ownership, onClaim: (claim) => pending.push(claim) },
            );
            // 发布后、事务收尾之前替换最终路径：数据库虽已确认回滚且无引用，
            // 也不能按路径删除当前目录项。
            unlinkSync(target);
            writeFileSync(target, replacement);
            throw main;
          },
        }),
      );

      expect(error).toBe(main);
      expect(release).toHaveBeenCalledTimes(1);
      expect(readFileSync(target)).toEqual(replacement);
      expect(sha256Of(readFileSync(target))).toBe(sha256Of(replacement));
      const claimView = pending[0] as unknown as { stagingPath: string };
      expect(readFileSync(claimView.stagingPath)).toEqual(content);
      const notes = error.cleanupErrors?.join(' | ') ?? '';
      expect(notes).toContain(target);
      expect(notes).toContain('state=ROLLBACK_CONFIRMED');
      expect(notes).toContain('共享原件目录无独占删除边界');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('清理与连接收尾失败单独诊断，不覆盖主错误', async () => {
    const { runner, release } = makeRunner();
    const main = new Error('样例插入失败');
    const cleanupError = new Error('unlink failed');
    const releaseError = new Error('release failed');
    release.mockRejectedValueOnce(releaseError);
    const removeSampleFile = jest.fn(async () => {
      throw cleanupError;
    });

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => {
            throw main;
          },
          removeSampleFile,
          probeReference: async () => false,
        }),
      ),
    );

    expect(error).toBe(main);
    expect(error.message).toBe('样例插入失败');
    const notes = error.cleanupErrors?.join(' | ') ?? '';
    expect(notes).toContain('原件收尾处置失败');
    expect(notes).toContain('释放初始化查询连接失败');
  });

  it('BEGIN 尝试抛错时进入未确认状态：不执行回调、不普通释放', async () => {
    const { runner, start, rollback, release, destroy } = makeRunner();
    const startError = new Error('begin receipt lost');
    start.mockRejectedValueOnce(startError);
    const removeSampleFile = jest.fn(async () => 'DELETED' as const);
    const run = jest.fn(async () => ({ ok: true }));

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run,
          removeSampleFile,
        }),
      ),
    );

    expect(error).toBe(startError);
    expect(run).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(removeSampleFile).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    const notes = error.cleanupErrors?.join(' | ') ?? '';
    expect(notes).toContain('begin=ATTEMPTED_UNCONFIRMED');
    expect(notes).toContain('state=UNKNOWN phase=BEGIN');
  });

  it('BEGIN 未确认时专用连接关闭失败仍保留主错误', async () => {
    const { runner, start, release, destroy } = makeRunner();
    const startError = new Error('begin receipt lost');
    const destroyError = new Error('connection destroy failed');
    start.mockRejectedValueOnce(startError);
    destroy.mockRejectedValueOnce(destroyError);

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => ({ ok: true }),
        }),
      ),
    );

    expect(error).toBe(startError);
    expect(error.message).toBe('begin receipt lost');
    expect(release).not.toHaveBeenCalled();
    const notes = error.cleanupErrors?.join(' | ') ?? '';
    expect(notes).toContain('begin=ATTEMPTED_UNCONFIRMED');
    expect(notes).toContain('connection destroy failed');
  });

  it('确认提交后返回结果并正常释放连接', async () => {
    const { runner, commit, release } = makeRunner();
    const result = await runInitializationDataTransaction(
      options(runner, { run: async () => ({ ok: true }) }),
    );
    expect(result).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('确认提交后报告按安全策略保留的暂存硬链接，且不当作清理失败', async () => {
    const { runner } = makeRunner();
    const result = await runInitializationDataTransaction(
      options(runner, { run: async () => ({ ok: true }) }),
    );

    expect(result).toEqual({ ok: true });
    const messages = logger.info.mock.calls.map((call) => String(call[0])).join(' | ');
    expect(messages).toContain('暂存硬链接按安全策略保留');
    expect(messages).toContain('state=COMMIT_CONFIRMED');
    for (const claim of claims) {
      expect(messages).toContain(claim.stagingPath);
    }
  });

  it('确认提交后释放失败必须单独诊断，不静默当作成功', async () => {
    const { runner, release } = makeRunner();
    release.mockRejectedValueOnce(new Error('pool release failed'));
    const removeSampleFile = jest.fn(async () => 'DELETED' as const);

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => ({ ok: true }),
          removeSampleFile,
        }),
      ),
    );

    expect(error.message).toContain('初始化数据已确认提交，但连接收尾失败');
    expect(error.cleanupErrors?.join(' | ')).toContain('释放初始化查询连接失败');
    expect(removeSampleFile).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.map((call) => String(call[0])).join(' | ')).toContain(
      '初始化数据已确认提交，但连接收尾失败',
    );
  });

  it('主错误上已登记的原件保留说明不会被事务收尾错误覆盖', async () => {
    const { runner } = makeRunner();
    const retainedPath = '/tmp/lithography_dev_v13_accept/0123456789abcdef0123456789abcdef.txt';
    const main = Object.assign(new Error('样例原件写入失败'), {
      cleanupErrors: [`未登记本轮原件归属，已保留现场：${retainedPath}`],
    });

    const error = await captureError(
      runInitializationDataTransaction(
        options(runner, {
          run: async () => {
            throw main;
          },
          removeSampleFile: async () => {
            throw new Error('unlink denied');
          },
          probeReference: async () => false,
        }),
      ),
    );

    expect(error).toBe(main);
    const notes = error.cleanupErrors ?? [];
    expect(notes[0]).toContain(retainedPath);
    expect(notes.join(' | ')).toContain('原件收尾处置失败');
  });
});

describe('仓库无密值模板（不连接实库）', () => {
  it('开发组织、管理员、账号与业务样例模板均可被当前解析器接受', () => {
    const organizations = parseOrganizationBootstrapConfig(
      readFileSync(join(DOCS_DIR, 'dev-organizations.example.json'), 'utf8'),
    );
    expect(organizations.organizations).toHaveLength(2);

    const admins = parseAdminBootstrapConfig(
      readFileSync(join(DOCS_DIR, 'dev-admin.example.json'), 'utf8'),
    );
    expect(admins.accounts.filter((entry) => entry.adminLevel === 1)).toHaveLength(3);
    expect(admins.accounts.filter((entry) => entry.adminLevel === 2)).toHaveLength(3);

    const accounts = parseDevAccountBootstrapConfig(
      readFileSync(join(DOCS_DIR, 'dev-accounts.example.json'), 'utf8'),
    );
    expect(accounts.customers).toHaveLength(3);
    expect(accounts.engineers).toHaveLength(2);

    const business = parseDevDataConfig(
      readFileSync(join(DOCS_DIR, 'dev-data.example.json'), 'utf8'),
    );
    expect(business.repairRequests).toHaveLength(3);
    expect(business.maintenanceReports).toHaveLength(2);
    expect(business.referenceDocuments).toHaveLength(2);
    expect(new Set(business.referenceDocuments.map((entry) => entry.seedKey)).size).toBe(2);
    for (const document of business.referenceDocuments) {
      expect(document.seedKey).toMatch(/^[a-z0-9][a-z0-9._-]{2,99}$/);
      expect(document.file).not.toBeNull();
      expect(document.file?.mimeType).toBe('text/plain');
      expect(document.file?.originalFilename.endsWith('.txt')).toBe(true);
      expect(document.file?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(document.file?.byteSize).toBeGreaterThan(0);
    }
  });
});

describe('管理员映射文件（不连接实库）', () => {
  it('合法映射可解析且保留等级与公司', () => {
    const config = parseAdminBootstrapConfig(validAdminFile);
    expect(config.schemaVersion).toBe(1);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]).toMatchObject({
      loginName: 'admin01',
      adminLevel: 1,
      organizationCode: 'ORG-001',
    });
  });

  it('schema_version 不匹配、等级越界、重复账号与未知字段均失败关闭', () => {
    expect(() =>
      parseAdminBootstrapConfig(JSON.stringify({ schema_version: 2, accounts: [] })),
    ).toThrow(/schema_version/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 3,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
          ],
        }),
      ),
    ).toThrow(/admin_level/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
            {
              login_name: 'admin01',
              password: 'valid-password-02',
              admin_level: 1,
              organization_code: 'ORG-002',
              nickname: '管理员二',
            },
          ],
        }),
      ),
    ).toThrow(/重复账号/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
              secret_token: 'x',
            },
          ],
        }),
      ),
    ).toThrow(/不支持的字段/);
  });

  it('管理员映射内重复邮箱时失败关闭', () => {
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              login_email: 'shared@example.com',
              password: 'valid-password-01',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
            {
              login_name: 'admin02',
              login_email: 'SHARED@example.com',
              password: 'valid-password-02',
              admin_level: 1,
              organization_code: 'ORG-002',
              nickname: '管理员二',
            },
          ],
        }),
      ),
    ).toThrow(/重复邮箱/);
  });

  it('密码过短或缺失公司编码时失败关闭', () => {
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'short',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
          ],
        }),
      ),
    ).toThrow(/password/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 1,
              nickname: '管理员一',
            },
          ],
        }),
      ),
    ).toThrow(/organization_code/);
  });
});

describe('初始化映射邮箱冲突（不连接实库）', () => {
  const adminConfig = (email: string) =>
    parseAdminBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        accounts: [
          {
            login_name: 'admin01',
            login_email: email,
            password: 'valid-password-01',
            admin_level: 1,
            organization_code: 'ORG-001',
            nickname: '管理员一',
          },
        ],
      }),
    );

  const devConfig = (email: string) =>
    parseDevAccountBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        customers: [
          {
            login_name: 'dev-customer-01',
            login_email: email,
            password: 'Xk7#mQ2!vR9',
            nickname: '开发客户一',
            organization_code: 'ORG-CLIENT-A',
          },
        ],
        engineers: [],
      }),
    );

  it('管理员与开发客户邮箱冲突时拒绝', () => {
    expect(() =>
      assertInitializationEmailConflicts(
        adminConfig('same@example.com'),
        devConfig('SAME@example.com'),
      ),
    ).toThrow(/初始化映射邮箱冲突/);
  });

  it('管理员与开发工程师邮箱冲突时拒绝', () => {
    const dev = parseDevAccountBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        customers: [],
        engineers: [
          {
            login_name: 'dev-engineer-01',
            login_email: 'same@example.com',
            password: 'Hj4%kL6^bN2',
            nickname: '开发工程师一',
            organization_code: 'ORG-PEER-A',
          },
        ],
      }),
    );
    expect(() => assertInitializationEmailConflicts(adminConfig('same@example.com'), dev)).toThrow(
      /初始化映射邮箱冲突/,
    );
  });

  it('合法配置复跑保持幂等校验通过', () => {
    const admin = adminConfig('admin01@example.com');
    const dev = devConfig('dev-customer-01@example.com');
    expect(() => assertInitializationEmailConflicts(admin, dev)).not.toThrow();
    expect(() => assertInitializationEmailConflicts(admin, dev)).not.toThrow();
  });
});
