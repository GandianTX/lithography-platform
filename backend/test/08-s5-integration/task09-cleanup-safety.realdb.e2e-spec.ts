// test/08-s5-integration/task09-cleanup-safety.realdb.e2e-spec.ts

/**
 * 任务 09 实库规格**清理安全**的反向验证（复验 P2）。
 *
 * 在**经核验的一次性隔离库**构造以下失败场景，证明收尾器不会"假装成功"：
 * - 缺物理清理许可 / 错目标库 / 归属事实漂移 ⇒ **第一条 DELETE 前**失败关闭，行不变；
 * - 第二步删除失败（未登记的公司子行 FK RESTRICT）⇒ 第一步删除**整体回滚**；
 * - 文件根归属标记不匹配 / 路径越界 ⇒ 拒绝删除，目标文件不变；
 * - 非目标行与非目标文件逐字段不变。
 *
 * 说明：本规格只验证**清理器自身**，不执行业务恢复；夹具全部自建、按真实 ID 精确回收。
 *
 * 默认跳过；启用：
 *   TASK09_CLEANUP_SAFETY_INTEGRATION=1 E2E_ALLOWED_DB_NAMES=<隔离库> \
 *     E2E_REAL_DB_NAME=<隔离库> E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest --testPathIgnorePatterns "/node_modules/" "/dist/" \
 *     --runTestsByPath test/08-s5-integration/task09-cleanup-safety.realdb.e2e-spec.ts --runInBand
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';

import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import { createOwnedResourceLedger } from '../utils/e2e-scoped-cleanup';
import { seedTestOrganizations } from '../utils/test-organizations';
import {
  cleanupOwnedFileRoot,
  createOwnedFileRoot,
  createTask09OwnedRowRegistry,
  runTask09GuardedCleanup,
  type OwnedFileRoot,
} from '../utils/task09-real-db-cleanup';

jest.setTimeout(180_000);

const ENABLED = process.env.TASK09_CLEANUP_SAFETY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;
const ENV_FILE = 'env/.env.e2e';
const FILE_BASE_DIR = join(__dirname, '../../.local/task09');

describeIntegration('任务 09 清理安全反向验证（隔离库）', () => {
  let dataSource: DataSource;
  let installationId = '';

  /** 夹具外哨兵（本轮绝不触碰） */
  let sentinelOrganization: Record<string, unknown>;
  let sentinelHoldCount = 0;

  beforeAll(async () => {
    const declared = process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);
    dataSource = new DataSource({
      type: 'mysql',
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      timezone: config.timezone,
      charset: config.charset,
      synchronize: false,
      logging: false,
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
    });
    await dataSource.initialize();
    await assertDataSourceOnAllowedE2eDatabase(dataSource, declared);
    const installation = await dataSource.query(
      'SELECT installation_id FROM local_installation LIMIT 1',
    );
    installationId = String(installation[0]?.installation_id ?? '');
    if (installationId === '') {
      throw new Error('隔离库缺少本机安装身份，无法构造冻结行');
    }
    const sentinel = (await dataSource.query('SELECT * FROM organization WHERE id = 1'))[0] as
      Record<string, unknown> | undefined;
    if (sentinel === undefined) {
      throw new Error('隔离库缺少夹具外哨兵公司（id=1）');
    }
    sentinelOrganization = sentinel;
    sentinelHoldCount = Number(
      (
        await dataSource.query(
          'SELECT COUNT(*) AS n FROM local_write_hold WHERE organization_id = 1',
        )
      )[0]?.n ?? -1,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /**
   * 每个场景自建独立公司/冻结行，避免场景之间互相污染。
   * `withUnregisteredLock=true` 时刻意留一条**未登记**的范围锁行，用于制造第二步 FK 失败。
   */
  async function createFixture(input: { withUnregisteredLock?: boolean } = {}): Promise<{
    owned: ReturnType<typeof createOwnedResourceLedger>;
    extraRows: ReturnType<typeof createTask09OwnedRowRegistry>;
    organizationId: number;
    holdId: string;
    lockId: number | null;
    cleanup: () => Promise<void>;
  }> {
    const owned = createOwnedResourceLedger();
    const extraRows = createTask09OwnedRowRegistry();
    const organizationCode = `TASK09-SAFETY-${randomUUID().slice(0, 8)}`;
    const organizationIdsByCode = await seedTestOrganizations({
      dataSource,
      organizations: [{ organizationCode, name: '任务09清理安全验证', kind: 'PEER' }],
      ownership: owned,
    });
    const organizationId = organizationIdsByCode.get(organizationCode) ?? 0;
    if (organizationId <= 0) {
      throw new Error('造数失败：未取得本轮公司 ID');
    }

    const holdId = randomUUID();
    await dataSource.query(
      'INSERT INTO local_write_hold (hold_id, installation_id, organization_id, hold_type, status, ' +
        'restore_id, reason, released_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NOW(3))',
      [holdId, installationId, organizationId, 'RESTORE', 'RELEASED', '清理安全验证夹具'],
    );

    let lockId: number | null = null;
    if (input.withUnregisteredLock === true) {
      await dataSource.query(
        'INSERT INTO local_write_scope_lock (installation_id, organization_id) VALUES (?, ?)',
        [installationId, organizationId],
      );
      lockId = Number((await dataSource.query('SELECT LAST_INSERT_ID() AS id'))[0]?.id ?? 0);
    }

    const cleanup = async (): Promise<void> => {
      // 完整登记后走同一受收尾器；本轮所有行都在清单内 ⇒ 必须成功。
      extraRows.register(
        'local_write_hold',
        { hold_id: holdId },
        {
          installation_id: installationId,
          organization_id: organizationId,
          hold_type: 'RESTORE',
          status: 'RELEASED',
          restore_id: null,
        },
      );
      if (lockId !== null) {
        extraRows.register(
          'local_write_scope_lock',
          { id: lockId },
          { installation_id: installationId, organization_id: organizationId },
        );
      }
      await runTask09GuardedCleanup({
        dataSource,
        owned,
        extraRows,
        helper: '清理安全验证 afterEach 精确回收',
        expectedDatabase: process.env.E2E_REAL_DB_NAME ?? 'lithography_task09_test_e2e',
      });
    };

    return { owned, extraRows, organizationId, holdId, lockId, cleanup };
  }

  const readHold = async (holdId: string): Promise<number> =>
    Number(
      (
        await dataSource.query('SELECT COUNT(*) AS n FROM local_write_hold WHERE hold_id = ?', [
          holdId,
        ])
      )[0]?.n ?? -1,
    );

  it('缺显式清理许可：在第一条 DELETE 前拒绝，登记行不变', async () => {
    const fixture = await createFixture();
    const previous = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    try {
      process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '0';
      await expect(
        runTask09GuardedCleanup({
          dataSource,
          owned: fixture.owned,
          extraRows: fixture.extraRows,
          helper: '无许可拒绝验证',
        }),
      ).rejects.toThrow(/缺少显式清理许可/);
      expect(await readHold(fixture.holdId)).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      } else {
        process.env.E2E_ALLOW_PHYSICAL_CLEANUP = previous;
      }
      await fixture.cleanup();
    }
  });

  it('错目标库：在第一条 DELETE 前拒绝，登记行不变', async () => {
    const fixture = await createFixture();
    await expect(
      runTask09GuardedCleanup({
        dataSource,
        owned: fixture.owned,
        extraRows: fixture.extraRows,
        helper: '错目标库拒绝验证',
        expectedDatabase: '__WRONG_DATABASE__',
      }),
    ).rejects.toThrow();
    expect(await readHold(fixture.holdId)).toBe(1);
    await fixture.cleanup();
  });

  it('归属事实漂移：在第一条 DELETE 前拒绝，本轮登记行全部不变', async () => {
    const fixture = await createFixture();
    const driftedRegistry = createTask09OwnedRowRegistry();
    driftedRegistry.register(
      'local_write_hold',
      { hold_id: fixture.holdId },
      {
        installation_id: installationId,
        organization_id: fixture.organizationId,
        hold_type: 'RESTORE',
        status: 'ACTIVE', // 实际是 RELEASED ⇒ 归属漂移
        restore_id: null,
      },
    );
    await expect(
      runTask09GuardedCleanup({
        dataSource,
        owned: fixture.owned,
        extraRows: driftedRegistry,
        helper: '归属漂移拒绝验证',
      }),
    ).rejects.toThrow(/归属漂移/);
    expect(await readHold(fixture.holdId)).toBe(1);
    await fixture.cleanup();
  });

  it('第二步删除失败：第一步删除整体回滚（不留下半清理现场）', async () => {
    const fixture = await createFixture({ withUnregisteredLock: true });
    // 清单里只有冻结行（第一步删）；未登记的范围锁行引用公司 ⇒ 第二步公司删除撞 FK RESTRICT。
    await expect(
      runTask09GuardedCleanup({
        dataSource,
        owned: fixture.owned,
        extraRows: fixture.extraRows,
        helper: '第二步失败回滚验证',
      }),
    ).rejects.toThrow();
    // 第一步已执行的冻结行删除必须随事务回滚，行仍在。
    expect(await readHold(fixture.holdId)).toBe(1);
    expect(
      Number(
        (
          await dataSource.query('SELECT COUNT(*) AS n FROM local_write_scope_lock WHERE id = ?', [
            fixture.lockId,
          ])
        )[0]?.n ?? -1,
      ),
    ).toBe(1);
    // 完整登记后再收尾，证明回滚后仍可按正确清单清理。
    await fixture.cleanup();
  });

  it('文件根归属标记不匹配：拒绝删除，目标文件不变', () => {
    const root: OwnedFileRoot = createOwnedFileRoot(FILE_BASE_DIR, 'task09-safety-marker-');
    const target = join(root.root, 'keep-me.txt');
    writeFileSync(target, 'sentinel', 'utf8');
    const marker = join(root.root, '.task09-owner.json');
    const original = readFileSync(marker, 'utf8');
    try {
      writeFileSync(marker, JSON.stringify({ token: 'foreign-root' }), 'utf8');
      expect(() => cleanupOwnedFileRoot(root, [target])).toThrow(/归属标记不匹配/);
      expect(readFileSync(target, 'utf8')).toBe('sentinel');
    } finally {
      writeFileSync(marker, original, 'utf8');
      cleanupOwnedFileRoot(root, [target]);
    }
  });

  it('文件根越界路径：拒绝删除，根外文件不变', async () => {
    const root: OwnedFileRoot = createOwnedFileRoot(FILE_BASE_DIR, 'task09-safety-boundary-');
    const outside = join(FILE_BASE_DIR, `task09-safety-outside-${randomUUID()}.txt`);
    writeFileSync(outside, 'outside-sentinel', 'utf8');
    try {
      expect(() => cleanupOwnedFileRoot(root, [outside])).toThrow(/受控根之外/);
      expect(readFileSync(outside, 'utf8')).toBe('outside-sentinel');
    } finally {
      cleanupOwnedFileRoot(root, []);
      const { rmSync } = await import('node:fs');
      rmSync(outside, { force: false });
    }
  });

  it('已登记父目录中的未登记文件：全量预检失败关闭，字节不变（不递归删除）', () => {
    const root: OwnedFileRoot = createOwnedFileRoot(FILE_BASE_DIR, 'task09-safety-unregistered-');
    const packagesDir = join(root.root, 'packages');
    mkdirSync(packagesDir);
    const registeredFile = join(packagesDir, 'manifest.json');
    writeFileSync(registeredFile, 'registered-bytes', 'utf8');
    const unregistered = join(packagesDir, 'UNREGISTERED-sentinel.bin');
    const unregisteredBytes = Buffer.from('未登记哨兵-字节不变', 'utf8');
    writeFileSync(unregistered, unregisteredBytes);
    try {
      expect(() => cleanupOwnedFileRoot(root, [packagesDir, registeredFile])).toThrow(/未登记条目/);
      expect(readFileSync(unregistered)).toEqual(unregisteredBytes);
      // 预检在任何删除之前完成 ⇒ 已登记文件与归属标记同样保留。
      expect(readFileSync(registeredFile, 'utf8')).toBe('registered-bytes');
      expect(readFileSync(join(root.root, '.task09-owner.json'), 'utf8')).toContain(root.token);
    } finally {
      // 显式登记哨兵后精确回收，避免本轮残留。
      cleanupOwnedFileRoot(root, [packagesDir, registeredFile, unregistered]);
    }
  });

  it('登记路径穿过符号链接：拒绝清理，链接目标字节不变', () => {
    const root: OwnedFileRoot = createOwnedFileRoot(FILE_BASE_DIR, 'task09-safety-symlink-');
    const outsideDir = join(FILE_BASE_DIR, `task09-safety-symlink-target-${randomUUID()}`);
    mkdirSync(outsideDir);
    const outsideFile = join(outsideDir, 'keep.bin');
    const bytes = Buffer.from('outside-target-bytes', 'utf8');
    writeFileSync(outsideFile, bytes);
    const link = join(root.root, 'packages');
    symlinkSync(outsideDir, link, 'dir');
    try {
      expect(() => cleanupOwnedFileRoot(root, [link, join(link, 'keep.bin')])).toThrow(/符号链接/);
      expect(readFileSync(outsideFile)).toEqual(bytes);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      unlinkSync(link);
      unlinkSync(outsideFile);
      rmdirSync(outsideDir);
      cleanupOwnedFileRoot(root, []);
    }
  });

  it('正常精确清理：登记文件与目录全部回收，根与标记零残留', () => {
    const root: OwnedFileRoot = createOwnedFileRoot(FILE_BASE_DIR, 'task09-safety-normal-');
    const packagesDir = join(root.root, 'packages');
    mkdirSync(packagesDir);
    const backupDir = join(packagesDir, 'backup');
    mkdirSync(backupDir);
    const file = join(backupDir, 'payload.bin');
    writeFileSync(file, 'payload', 'utf8');
    cleanupOwnedFileRoot(root, [packagesDir, backupDir, file]);
    expect(existsSync(root.root)).toBe(false);
  });

  it('非目标行：夹具外公司与其冻结行计数逐字段不变', async () => {
    expect((await dataSource.query('SELECT * FROM organization WHERE id = 1'))[0]).toEqual(
      sentinelOrganization,
    );
    expect(
      Number(
        (
          await dataSource.query(
            'SELECT COUNT(*) AS n FROM local_write_hold WHERE organization_id = 1',
          )
        )[0]?.n ?? -1,
      ),
    ).toBe(sentinelHoldCount);
  });
});
