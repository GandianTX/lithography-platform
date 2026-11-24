// scripts/task09-restore-selfcheck.safety.spec.ts

/**
 * 恢复自检入口安全边界的定向测试（独立验收 P1-3 的回归护栏）。
 *
 * 覆盖计划要求的反例：错误库／实例／根／安装、未显式许可、符号链接与越界、
 * 预存冻结／授权、外部引用、错误 ID、部分失败、后续删除失败、收尾异常。
 *
 * 关键纪律：**每个拦截都必须由预检本身证明**，不能靠"最后外键报错"来冒充安全；
 * 因此这里直接断言抛错码，并断言拦截发生在任何写入／删除动作之前。
 */

/// <reference types="jest" />
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertAuthorizationNotOverwritable,
  assertControlledFileRoot,
  assertDatabaseCleanupAllowed,
  assertDisposableMarker,
  assertForeignSentinelIntact,
  assertHoldReleaseAllowed,
  assertNoExternalReference,
  assertNoForeignActiveHold,
  assertOwnedFieldsMatch,
  assertPathWithinRoot,
  assertSelfCreatedResidueCleared,
  assertSentinelsUnchanged,
  assertServerIdentity,
  authorizationSentinelFingerprint,
  buildCleanupError,
  createCleanupGate,
  fileContentFingerprint,
  holdSentinelFingerprint,
  planDatabaseDeletion,
  planFileDeletion,
  planOwnedDeletion,
  readSelfcheckAuthorization,
  requireCompleteBaseline,
  selectCreatedSentinelIds,
  selectReleasableHolds,
  SELFCHECK_TEST_AUTHORIZATION,
  SelfcheckSafetyError,
  type OwnedObjectRecord,
  type SelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';

const BASE_ENV: Record<string, string> = {
  TASK09_RESTORE_ENV_FILE: '/tmp/task09-iso-a.env',
  TASK09_RESTORE_DATABASE: 'lithography_task09_isolated_a',
  TASK09_RESTORE_EXPECTED_HOST: '127.0.0.1',
  TASK09_RESTORE_EXPECTED_PORT: '33307',
  TASK09_RESTORE_EXPECTED_SERVER_UUID: '0c49b668-e718-11f1-9334-345a604caa06',
  TASK09_RESTORE_DISPOSABLE_MARKER: 'task09-marker-a',
  TASK09_RESTORE_FILE_ROOT: '/tmp/task09-iso-root/a',
  TASK09_RESTORE_INSTALLATION_ID: '11111111-2222-4333-8444-555555555555',
  TASK09_RESTORE_ORGANIZATION_ID: '1',
  TASK09_RESTORE_TEST_AUTHORIZATION: SELFCHECK_TEST_AUTHORIZATION,
};

const expectedAuthorization: SelfcheckAuthorization = {
  envFile: '/tmp/task09-iso-a.env',
  database: 'lithography_task09_isolated_a',
  expectedHost: '127.0.0.1',
  expectedPort: 33307,
  expectedServerUuid: '0c49b668-e718-11f1-9334-345a604caa06',
  disposableMarker: 'task09-marker-a',
  fileRoot: '/tmp/task09-iso-root/a',
  installationId: '11111111-2222-4333-8444-555555555555',
  organizationId: 1,
  testAuthorization: SELFCHECK_TEST_AUTHORIZATION,
};

describe('恢复自检入口 · 默认拒绝与显式授权', () => {
  it('缺少任一必填授权变量：拒绝并一次列全缺失项（不回落默认值）', () => {
    const env = { ...BASE_ENV };
    delete env.TASK09_RESTORE_DATABASE;
    delete env.TASK09_RESTORE_FILE_ROOT;

    expect(() => readSelfcheckAuthorization(env)).toThrow(SelfcheckSafetyError);
    try {
      readSelfcheckAuthorization(env);
      throw new Error('应当拒绝运行');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('MISSING_AUTHORIZATION');
      expect((error as Error).message).toContain('TASK09_RESTORE_DATABASE');
      expect((error as Error).message).toContain('TASK09_RESTORE_FILE_ROOT');
    }
  });

  it('完全没有任何授权变量（原脚本的默认库回落路径）：拒绝运行', () => {
    expect(() => readSelfcheckAuthorization({})).toThrow(/默认拒绝运行/u);
  });

  it('未显式给出测试授权口令：拒绝运行', () => {
    const env = { ...BASE_ENV, TASK09_RESTORE_TEST_AUTHORIZATION: '随便写点什么' };
    try {
      readSelfcheckAuthorization(env);
      throw new Error('应当拒绝运行');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('MISSING_TEST_AUTHORIZATION');
    }
  });

  it('目标库不是一次性库命名：拒绝运行', () => {
    const env = { ...BASE_ENV, TASK09_RESTORE_DATABASE: 'lithography_task09_dev' };
    try {
      readSelfcheckAuthorization(env);
      throw new Error('应当拒绝运行');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('NOT_DISPOSABLE_DATABASE');
    }
  });

  it('一次性库命名但命中明确禁止的库名：拒绝运行', () => {
    const env = { ...BASE_ENV, TASK09_RESTORE_DATABASE: 'lithography_task09_isolated_dev' };
    // 命名合法时不应被命名规则拦下；改用直接命中的禁止库验证兜底规则
    const forbidden = { ...BASE_ENV, TASK09_RESTORE_DATABASE: 'lithography_e2e' };
    expect(() => readSelfcheckAuthorization(env)).not.toThrow();
    try {
      readSelfcheckAuthorization(forbidden);
      throw new Error('应当拒绝运行');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('NOT_DISPOSABLE_DATABASE');
    }
  });

  it('安装标识不是 UUID 形态：拒绝运行', () => {
    const env = { ...BASE_ENV, TASK09_RESTORE_INSTALLATION_ID: '7' };
    try {
      readSelfcheckAuthorization(env);
      throw new Error('应当拒绝运行');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('INVALID_INSTALLATION_ID');
    }
  });

  it('公司数据区不是正整数：拒绝运行', () => {
    const env = { ...BASE_ENV, TASK09_RESTORE_ORGANIZATION_ID: '0' };
    try {
      readSelfcheckAuthorization(env);
      throw new Error('应当拒绝运行');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('INVALID_ORGANIZATION_ID');
    }
  });

  it('全部显式授权齐备：解析成功且字段一一对应', () => {
    expect(readSelfcheckAuthorization(BASE_ENV)).toEqual(expectedAuthorization);
  });
});

describe('恢复自检入口 · 实例身份与一次性库标识核对', () => {
  it('实际连接库不一致：拒绝', () => {
    expect(() =>
      assertServerIdentity(
        {
          database: 'lithography_task09_dev',
          serverUuid: expectedAuthorization.expectedServerUuid,
          host: '127.0.0.1',
          port: 33307,
        },
        expectedAuthorization,
      ),
    ).toThrow(/实际连接库与声明不一致/u);
  });

  it('实际实例 UUID 不一致：拒绝（防止"同名库跑在别的实例上"）', () => {
    try {
      assertServerIdentity(
        {
          database: expectedAuthorization.database,
          serverUuid: '99999999-9999-4999-8999-999999999999',
          host: '127.0.0.1',
          port: 33307,
        },
        expectedAuthorization,
      );
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('SERVER_UUID_MISMATCH');
    }
  });

  it('实际主机或端口不一致：拒绝', () => {
    expect(() =>
      assertServerIdentity(
        {
          database: expectedAuthorization.database,
          serverUuid: expectedAuthorization.expectedServerUuid,
          host: '10.0.0.9',
          port: 33307,
        },
        expectedAuthorization,
      ),
    ).toThrow(/主机与声明不一致/u);
    expect(() =>
      assertServerIdentity(
        {
          database: expectedAuthorization.database,
          serverUuid: expectedAuthorization.expectedServerUuid,
          host: '127.0.0.1',
          port: 3306,
        },
        expectedAuthorization,
      ),
    ).toThrow(/端口与声明不一致/u);
  });

  it('库内缺少一次性标识行：拒绝', () => {
    try {
      assertDisposableMarker([], 'task09-marker-a');
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('MISSING_DISPOSABLE_MARKER');
    }
  });

  it('库内一次性标识值与声明不一致：拒绝', () => {
    try {
      assertDisposableMarker(
        [{ markerKey: 'task09-disposable-database', markerValue: '别的库' }],
        'task09-marker-a',
      );
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('DISPOSABLE_MARKER_MISMATCH');
    }
  });

  it('库内一次性标识与声明一致：通过', () => {
    expect(() =>
      assertDisposableMarker(
        [{ markerKey: 'task09-disposable-database', markerValue: 'task09-marker-a' }],
        'task09-marker-a',
      ),
    ).not.toThrow();
  });
});

describe('恢复自检入口 · 受控文件根与路径越界', () => {
  let root = '';
  let outside = '';

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'task09-safety-'));
    root = join(base, 'controlled');
    outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('受控根不存在：拒绝', () => {
    expect(() => assertControlledFileRoot(join(root, 'missing'))).toThrow(/不存在/u);
  });

  it('受控根本身是符号链接：拒绝', () => {
    const link = join(root, '..', 'link-root');
    symlinkSync(root, link);
    try {
      assertControlledFileRoot(link);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('FILE_ROOT_IS_SYMLINK');
    }
  });

  it('受控根是文件系统根目录或顶层目录：拒绝', () => {
    expect(() => assertControlledFileRoot('/')).toThrow(/根目录/u);
    expect(() => assertControlledFileRoot('/tmp')).toThrow(/顶层目录/u);
  });

  it('受控根是相对路径：拒绝', () => {
    expect(() => assertControlledFileRoot('relative/path')).toThrow(/绝对路径/u);
  });

  it('受控根正常：返回真实路径', () => {
    expect(assertControlledFileRoot(root)).toBe(root);
  });

  it('待删路径越出受控根（同级前缀目录）：拒绝', () => {
    try {
      assertPathWithinRoot(root, join(outside, 'package'));
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('PATH_OUTSIDE_ROOT');
    }
  });

  it('待删路径是符号链接：拒绝（不按路径递归删除）', () => {
    const target = join(outside, 'real');
    mkdirSync(target, { recursive: true });
    const link = join(root, 'linked');
    symlinkSync(target, link);
    try {
      assertPathWithinRoot(root, link);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('PATH_IS_SYMLINK');
    }
  });

  it('文件删除计划：越界路径在生成计划阶段就被拦下', () => {
    expect(() => planFileDeletion([join(outside, 'x')], root)).toThrow(/越出受控根/u);
  });

  it('文件删除计划：受控根内路径去重后保留', () => {
    const inside = join(root, 'pkg');
    mkdirSync(inside, { recursive: true });
    expect(planFileDeletion([inside, inside], root)).toEqual([inside]);
  });
});

describe('恢复自检入口 · 预存冻结与既有授权', () => {
  it('目标范围存在非本轮的活动冻结：拒绝运行（不释放他人现场）', () => {
    try {
      assertNoForeignActiveHold(
        [
          {
            holdId: 'hold-foreign',
            installationId: expectedAuthorization.installationId,
            organizationId: expectedAuthorization.organizationId,
            status: 'ACTIVE',
            restoreId: 'restore-foreign',
          },
        ],
        expectedAuthorization.installationId,
        expectedAuthorization.organizationId,
      );
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('PREEXISTING_ACTIVE_HOLD');
    }
  });

  it('已释放的冻结不构成阻断', () => {
    expect(() =>
      assertNoForeignActiveHold(
        [
          {
            holdId: 'hold-released',
            installationId: expectedAuthorization.installationId,
            organizationId: expectedAuthorization.organizationId,
            status: 'RELEASED',
            restoreId: null,
          },
        ],
        expectedAuthorization.installationId,
        expectedAuthorization.organizationId,
      ),
    ).not.toThrow();
  });

  it('只释放属于本轮的冻结：别人的冻结保持 ACTIVE', () => {
    const holds = [
      {
        holdId: 'hold-mine',
        installationId: expectedAuthorization.installationId,
        organizationId: expectedAuthorization.organizationId,
        status: 'ACTIVE',
        restoreId: 'restore-mine',
      },
      {
        holdId: 'hold-foreign',
        installationId: expectedAuthorization.installationId,
        organizationId: expectedAuthorization.organizationId,
        status: 'ACTIVE',
        restoreId: 'restore-foreign',
      },
    ];
    const releasable = selectReleasableHolds(holds, ['restore-mine']);
    expect(releasable.map((hold) => hold.holdId)).toEqual(['hold-mine']);
  });

  it('既有授权行存在：拒绝覆盖', () => {
    try {
      assertAuthorizationNotOverwritable(
        [
          {
            id: '9',
            installationId: expectedAuthorization.installationId,
            accountId: 7,
            organizationId: expectedAuthorization.organizationId,
            authorizationStatus: 'ACTIVE',
          },
        ],
        expectedAuthorization.installationId,
        expectedAuthorization.organizationId,
        7,
      );
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('PREEXISTING_AUTHORIZATION');
    }
  });

  it('范围不同（别的账号／别的公司）的授权不构成阻断', () => {
    expect(() =>
      assertAuthorizationNotOverwritable(
        [
          {
            id: '9',
            installationId: expectedAuthorization.installationId,
            accountId: 900_101,
            organizationId: expectedAuthorization.organizationId,
            authorizationStatus: 'ACTIVE',
          },
        ],
        expectedAuthorization.installationId,
        expectedAuthorization.organizationId,
        7,
      ),
    ).not.toThrow();
  });
});

describe('恢复自检入口 · 外部引用与删除计划', () => {
  it('对象被本轮之外的引用：拒绝删除', () => {
    try {
      assertNoExternalReference(
        [
          {
            ownerTable: 'backup_restore_run',
            ownerId: 'restore-foreign',
            referencedTable: 'backup_asset',
            referencedId: 'backup-mine',
          },
        ],
        'backup_asset',
        'backup-mine',
        [],
      );
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('EXTERNAL_REFERENCE');
    }
  });

  it('引用方属于本轮：允许删除', () => {
    expect(() =>
      assertNoExternalReference(
        [
          {
            ownerTable: 'backup_restore_run',
            ownerId: 'restore-mine',
            referencedTable: 'backup_asset',
            referencedId: 'backup-mine',
          },
        ],
        'backup_asset',
        'backup-mine',
        ['backup_restore_run::restore-mine'],
      ),
    ).not.toThrow();
  });

  it('删除计划按先子后父排序，且去重', () => {
    const plan = planDatabaseDeletion([
      { table: 'backup_asset', idColumn: 'backup_id', id: 'b1', ownership: '本轮' },
      { table: 'backup_restore_run', idColumn: 'restore_id', id: 'r1', ownership: '本轮' },
      { table: 'backup_asset', idColumn: 'backup_id', id: 'b1', ownership: '本轮' },
      { table: 'local_write_hold', idColumn: 'hold_id', id: 'h1', ownership: '本轮' },
    ]);
    expect(plan.map((item) => item.table)).toEqual([
      'local_write_hold',
      'backup_restore_run',
      'backup_asset',
    ]);
    const positions = [...new Set(plan.map((item) => item.table))].map((table) =>
      plan.findIndex((item) => item.table === table),
    );
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('删除计划含未受控的业务表：拒绝（防止误删业务数据）', () => {
    try {
      planDatabaseDeletion([
        { table: 'repair_request', idColumn: 'id', id: '1', ownership: '本轮' },
      ]);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('UNMANAGED_DELETION_TABLE');
    }
  });
});

describe('恢复自检入口 · 哨兵与收尾异常', () => {
  it('非目标哨兵指纹变化：整轮失败', () => {
    try {
      assertSentinelsUnchanged(
        [{ label: 'foreign-company', fingerprint: '1:2' }],
        [{ label: 'foreign-company', fingerprint: '1:3' }],
      );
      throw new Error('应当失败');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('SENTINEL_CHANGED');
    }
  });

  it('哨兵消失或新增：整轮失败', () => {
    expect(() => assertSentinelsUnchanged([{ label: 'a', fingerprint: 'x' }], [])).toThrow(
      /哨兵消失/u,
    );
    expect(() => assertSentinelsUnchanged([], [{ label: 'b', fingerprint: 'y' }])).toThrow(
      /未登记的哨兵/u,
    );
  });

  it('哨兵一致：通过', () => {
    expect(() =>
      assertSentinelsUnchanged(
        [{ label: 'a', fingerprint: 'x' }],
        [{ label: 'a', fingerprint: 'x' }],
      ),
    ).not.toThrow();
  });

  it('后续删除失败：主因存在时收尾错误附加在主因上，不被吞掉', () => {
    const main = new Error('主因');
    const result = buildCleanupError(main, {
      errors: [],
      deleted: [],
      failed: ['backup_asset#b1'],
    });
    expect(result).toBe(main);
    expect((main as Error & { cleanupErrors?: string[] }).cleanupErrors).toEqual([
      '删除失败: backup_asset#b1',
    ]);
  });

  it('无主因但收尾失败：单独报错，绝不假成功', () => {
    const result = buildCleanupError(null, {
      errors: ['关闭数据库连接失败'],
      deleted: [],
      failed: [],
    });
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('收尾失败');
    expect((result as Error & { cleanupErrors?: string[] }).cleanupErrors).toEqual([
      '关闭数据库连接失败',
    ]);
  });

  it('部分删除成功、后续删除失败：失败清单完整可见', () => {
    const result = buildCleanupError(null, {
      errors: [],
      deleted: ['local_write_hold#h1'],
      failed: ['backup_asset#b2'],
    });
    expect((result as Error & { cleanupErrors?: string[] }).cleanupErrors).toEqual([
      '删除失败: backup_asset#b2',
    ]);
  });
});

/* ────────────────────── 收尾门禁：没通过校验就不许写删 ────────────────────── */

describe('恢复自检入口 · 收尾门禁（失败关闭）', () => {
  it('入口授权后：只允许清理本轮临时文件，数据库删除与冻结释放仍被拒绝', () => {
    const gate = createCleanupGate();
    expect(gate.authorized).toBe(true);
    expect(gate.identityVerified).toBe(false);
    expect(gate.scopeVerified).toBe(false);
    expect(gate.baselineComplete).toBe(false);
    expect(() => assertDatabaseCleanupAllowed(gate)).toThrow(/禁止删除任何数据库对象/u);
    expect(() => assertHoldReleaseAllowed(gate)).toThrow(/禁止释放冻结/u);
  });

  it('身份核对失败：数据库删除与冻结释放都被拒绝（安全拒绝路径零写删）', () => {
    const gate = createCleanupGate();
    gate.identityVerified = false;
    try {
      assertDatabaseCleanupAllowed(gate);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('DATABASE_CLEANUP_NOT_ALLOWED');
    }
    try {
      assertHoldReleaseAllowed(gate);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('HOLD_RELEASE_NOT_ALLOWED');
    }
  });

  it('范围预检失败：数据库删除与冻结释放都被拒绝', () => {
    const gate = createCleanupGate();
    gate.identityVerified = true;
    gate.scopeVerified = false;
    expect(() => assertDatabaseCleanupAllowed(gate)).toThrow(/禁止删除任何数据库对象/u);
    expect(() => assertHoldReleaseAllowed(gate)).toThrow(/禁止释放冻结/u);
  });

  it('基线未完成：允许释放本轮冻结，但**禁止**删除任何数据库对象', () => {
    const gate = createCleanupGate();
    gate.identityVerified = true;
    gate.scopeVerified = true;
    gate.baselineComplete = false;
    expect(() => assertHoldReleaseAllowed(gate)).not.toThrow();
    try {
      assertDatabaseCleanupAllowed(gate);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('DATABASE_CLEANUP_NOT_ALLOWED');
    }
  });

  it('身份、范围、基线全部通过：允许删除本轮数据库对象', () => {
    const gate = createCleanupGate();
    gate.identityVerified = true;
    gate.scopeVerified = true;
    gate.baselineComplete = true;
    expect(() => assertDatabaseCleanupAllowed(gate)).not.toThrow();
    expect(() => assertHoldReleaseAllowed(gate)).not.toThrow();
  });
});

/* ────────────────────── 所有权登记与删除计划 ────────────────────── */

describe('恢复自检入口 · 所有权登记（不再用全表差集推断归属）', () => {
  const ownedBackup: OwnedObjectRecord = {
    table: 'backup_asset',
    idColumn: 'backup_id',
    id: 'backup-mine',
    ownership: '本轮生成的备份资产',
    expectedFields: { installation_id: 'inst-1', organization_id: 1 },
  };

  const baseline = new Map<string, ReadonlySet<string>>([
    ['backup_asset', new Set<string>(['backup-old'])],
    ['local_write_hold', new Set<string>()],
  ]);

  it('基线缺表：失败关闭（不允许用空集合回落成"全部都是新增"）', () => {
    try {
      requireCompleteBaseline(baseline, ['backup_asset', 'local_backup_run']);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('BASELINE_INCOMPLETE');
      expect((error as Error).message).toContain('local_backup_run');
    }
  });

  it('删除计划：基线缺表时直接拒绝，不会按空基线推导删除集合', () => {
    try {
      planOwnedDeletion(
        [{ ...ownedBackup, table: 'local_backup_run', idColumn: 'id', id: '9' }],
        baseline,
      );
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('BASELINE_INCOMPLETE');
    }
  });

  it('删除计划：只包含登记过的本轮主键，未登记的行一律不进计划', () => {
    const plan = planOwnedDeletion([ownedBackup], baseline);
    expect(plan.map((item) => `${item.table}#${item.id}`)).toEqual(['backup_asset#backup-mine']);
  });

  it('并发期间由别人写入的新行（非本轮、未登记）：不进入删除计划', () => {
    const plan = planOwnedDeletion([ownedBackup], baseline);
    const planKeys = plan.map((item) => `${item.table}#${item.id}`);
    expect(planKeys).not.toContain('backup_asset#backup-foreign');
    expect(planKeys).not.toContain('backup_asset#backup-old');
  });

  it('登记错误（把运行前已存在的主键登记为本轮创建）：拒绝删除并显式报错', () => {
    try {
      planOwnedDeletion([{ ...ownedBackup, id: 'backup-old' }], baseline);
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('OWNED_OBJECT_PREEXISTED');
      expect((error as Error).message).toContain('backup-old');
    }
  });

  it('删除计划：先子后父，且同表按主键排序', () => {
    const plan = planOwnedDeletion(
      [
        { table: 'backup_asset', idColumn: 'backup_id', id: 'b2', ownership: '本轮' },
        { table: 'backup_restore_run', idColumn: 'restore_id', id: 'r1', ownership: '本轮' },
        { table: 'local_write_hold', idColumn: 'hold_id', id: 'h1', ownership: '本轮' },
        { table: 'backup_asset', idColumn: 'backup_id', id: 'b1', ownership: '本轮' },
      ],
      new Map<string, ReadonlySet<string>>([
        ['backup_asset', new Set<string>()],
        ['backup_restore_run', new Set<string>()],
        ['local_write_hold', new Set<string>()],
      ]),
    );
    expect(plan.map((item) => `${item.table}#${item.id}`)).toEqual([
      'local_write_hold#h1',
      'backup_restore_run#r1',
      'backup_asset#b1',
      'backup_asset#b2',
    ]);
  });

  it('删除计划：受控顺序表之外的表仍然被拒绝', () => {
    expect(() =>
      planOwnedDeletion(
        [{ table: 'repair_request', idColumn: 'id', id: '1', ownership: '本轮' }],
        new Map<string, ReadonlySet<string>>([['repair_request', new Set<string>()]]),
      ),
    ).toThrow(/不在受控顺序表内/u);
  });
});

/* ────────────────────── 删除前的关键字段核对 ────────────────────── */

describe('恢复自检入口 · 删除前逐条核对关键字段', () => {
  const record: OwnedObjectRecord = {
    table: 'backup_asset',
    idColumn: 'backup_id',
    id: 'backup-mine',
    ownership: '本轮生成的备份资产',
    expectedFields: { installation_id: 'inst-1', organization_id: 1 },
  };

  it('实际行与登记一致：通过', () => {
    expect(() =>
      assertOwnedFieldsMatch(record, { installation_id: 'inst-1', organization_id: 1 }),
    ).not.toThrow();
  });

  it('公司不一致：拒绝删除（不靠外键最后报错兜底）', () => {
    try {
      assertOwnedFieldsMatch(record, { installation_id: 'inst-1', organization_id: 2 });
      throw new Error('应当拒绝');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('OWNED_OBJECT_MISMATCH');
      expect((error as Error).message).toContain('organization_id');
    }
  });

  it('安装标识不一致：拒绝删除', () => {
    expect(() =>
      assertOwnedFieldsMatch(record, { installation_id: 'inst-other', organization_id: 1 }),
    ).toThrow(/OWNED|一致/u);
  });

  it('空值与 null 的判定一致（数据库返回 null 时不误判为不一致）', () => {
    const nullableRecord: OwnedObjectRecord = {
      table: 'management_audit_event',
      idColumn: 'event_id',
      id: 'e1',
      ownership: '本轮恢复的终态审计事件',
      expectedFields: { target_type: 'BACKUP_RESTORE_RUN', target_id: 'r1', detail: null },
    };
    expect(() =>
      assertOwnedFieldsMatch(nullableRecord, {
        target_type: 'BACKUP_RESTORE_RUN',
        target_id: 'r1',
        detail: null,
      }),
    ).not.toThrow();
  });
});

/* ────────────────────── 哨兵回收：只回收本轮创建的 ────────────────────── */

describe('恢复自检入口 · 哨兵回收范围', () => {
  it('本轮创建的哨兵：可精确回收', () => {
    expect(selectCreatedSentinelIds({ authorizationId: 'auth-1', holdId: 'hold-1' })).toEqual({
      authorizationIds: ['auth-1'],
      holdIds: ['hold-1'],
    });
  });

  it('复用到的既有哨兵：不回收（不属于本轮创建）', () => {
    expect(selectCreatedSentinelIds({ authorizationId: null, holdId: null })).toEqual({
      authorizationIds: [],
      holdIds: [],
    });
  });
});

/* ────────────────────── 敏感性验证：绕过预检时目标断言必须失败 ────────────────────── */

describe('恢复自检入口 · 敏感性验证（预检本身必须能拦住）', () => {
  it('若绕过所有权登记、直接按"全表差集"删除非本轮行：关键字段核对必须拦下', () => {
    // 模拟旧实现：并发期间别人写入的行被当成"本轮新建"进入删除集合
    const foreignRow: OwnedObjectRecord = {
      table: 'backup_asset',
      idColumn: 'backup_id',
      id: 'backup-foreign',
      ownership: '（绕过所有权登记）',
      expectedFields: { installation_id: 'inst-foreign', organization_id: 2 },
    };
    try {
      assertOwnedFieldsMatch(foreignRow, {
        installation_id: 'inst-1',
        organization_id: 1,
      });
      throw new Error('应当被关键字段核对拦下');
    } catch (error) {
      expect((error as SelfcheckSafetyError).code).toBe('OWNED_OBJECT_MISMATCH');
    }
  });

  it('若绕过外部引用预检：外部引用检查本身必须报出引用方', () => {
    expect(() =>
      assertNoExternalReference(
        [
          {
            ownerTable: 'backup_restore_run',
            ownerId: 'restore-foreign',
            referencedTable: 'backup_asset',
            referencedId: 'backup-mine',
          },
        ],
        'backup_asset',
        'backup-mine',
        [],
      ),
    ).toThrow(/存在本轮之外的引用/u);
  });
});
/* ────────────────────── 哨兵真实读回与残留核对（P2-1） ────────────────────── */

describe('恢复自检入口 · 哨兵真实读回（不得用内存值拼指纹）', () => {
  it('授权哨兵指纹取自真实行字段：状态被改写即指纹不同', () => {
    const row = {
      id: '7',
      installation_id: 'inst-1',
      account_id: 11,
      organization_id: 1,
      authorization_status: 'ACTIVE',
      permission_version: 1,
      signed_claims: { purpose: ['CLOUD_BACKUP'], issuer: 'task09-sentinel' },
      authorized_at: '2026-11-24T00:00:00.000Z',
      revoked_at: null,
      last_verified_at: '2026-11-24T00:00:00.000Z',
    };
    const before = authorizationSentinelFingerprint(row);
    const after = authorizationSentinelFingerprint({ ...row, authorization_status: 'REVOKED' });
    expect(before).not.toBe(after);
    expect(before).toContain('authorization_status=ACTIVE');
    expect(after).toContain('authorization_status=REVOKED');
  });

  it('授权哨兵行被删除后：指纹不再是"ACTIVE"（真实读回会发现）', () => {
    // 旧实现的 before/after 都是内存拼的 `${id}:ACTIVE` ⇒ 行被删也发现不了
    const oldStyleBefore = '7:ACTIVE';
    const oldStyleAfter = '7:ACTIVE';
    expect(oldStyleBefore).toBe(oldStyleAfter);
    // 新实现：after 走真实读回 ⇒ 行不在时指纹为 missing ⇒ 与 before 不同
    expect(authorizationSentinelFingerprint({})).not.toBe(
      authorizationSentinelFingerprint({
        id: '7',
        installation_id: 'inst-1',
        account_id: 11,
        organization_id: 1,
        authorization_status: 'ACTIVE',
      }),
    );
  });

  it('冻结哨兵指纹取自真实行字段：状态被改写即指纹不同', () => {
    const row = {
      hold_id: 'h-1',
      installation_id: 'inst-1',
      organization_id: 2,
      hold_type: 'RESTORE',
      status: 'ACTIVE',
      restore_id: null,
      reason: '任务09 哨兵冻结（非目标范围）',
      created_at: '2026-11-24T00:00:00.000Z',
      released_at: null,
    };
    const before = holdSentinelFingerprint(row);
    const after = holdSentinelFingerprint({ ...row, status: 'RELEASED' });
    expect(before).not.toBe(after);
    expect(before).toContain('status=ACTIVE');
  });

  it('文件指纹按真实字节：内容被改写（文件仍在）即指纹不同', () => {
    const root = mkdtempSync(join(tmpdir(), 'task09-sentinel-fp-'));
    try {
      const file = join(root, 'sentinel.txt');
      mkdirSync(root, { recursive: true });
      writeFileSync(file, 'task09 sentinel\n', 'utf8');
      const before = fileContentFingerprint(root, file);
      writeFileSync(file, 'task09 sentinel tampered\n', 'utf8');
      const after = fileContentFingerprint(root, file);
      expect(before).not.toBe(after);
      expect(before).toMatch(/^sha256:[0-9a-f]{64};bytes=\d+$/u);
      // 旧实现只看存在性 ⇒ 改内容也发现不了
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('文件不存在：指纹为 missing（不是抛错，由调用方判定是否算失败）', () => {
    const root = mkdtempSync(join(tmpdir(), 'task09-sentinel-fp-'));
    try {
      expect(fileContentFingerprint(root, join(root, 'absent.txt'))).toBe('missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('文件指纹：路径越出受控根或本身是符号链接时拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'task09-sentinel-fp-'));
    const outside = mkdtempSync(join(tmpdir(), 'task09-outside-'));
    try {
      expect(() => fileContentFingerprint(root, join(outside, 'x.txt'))).toThrow(/越出受控根/u);
      symlinkSync(outside, join(root, 'link'));
      expect(() => fileContentFingerprint(root, join(root, 'link'))).toThrow(/符号链接/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('恢复自检入口 · 本轮零残留与非目标未被误删（两者独立）', () => {
  it('本轮自建对象仍有残留：判定失败（不得只记一句"大概没事"）', () => {
    expect(() =>
      assertSelfCreatedResidueCleared({
        authorizationId: '7',
        authorizationRows: 1,
        holdId: 'h-1',
        holdRows: 0,
        filePath: '/tmp/task09/fileroot/sentinels/x.sentinel',
        fileExists: false,
      }),
    ).toThrow(/未清干净/u);
  });

  it('本轮自建对象全部清干净：通过（未创建过的不参与判定）', () => {
    expect(() =>
      assertSelfCreatedResidueCleared({
        authorizationId: '7',
        authorizationRows: 0,
        holdId: 'h-1',
        holdRows: 0,
        filePath: '/tmp/task09/fileroot/sentinels/x.sentinel',
        fileExists: false,
      }),
    ).not.toThrow();
    // 本轮没有创建过 ⇒ 对应计数不参与判定
    expect(() =>
      assertSelfCreatedResidueCleared({
        authorizationId: null,
        authorizationRows: 0,
        holdId: null,
        holdRows: 0,
        filePath: null,
        fileExists: false,
      }),
    ).not.toThrow();
  });

  it('非目标哨兵在收尾后消失：判定失败（本轮误删了他人的数据）', () => {
    expect(() =>
      assertForeignSentinelIntact([
        { label: 'reused-sentinel-authorization', rows: 0 },
        { label: 'reused-sentinel-hold', rows: 1 },
      ]),
    ).toThrow(/误删/u);
  });

  it('非目标哨兵仍然原样存在：通过', () => {
    expect(() =>
      assertForeignSentinelIntact([
        { label: 'reused-sentinel-authorization', rows: 1 },
        { label: 'reused-sentinel-hold', rows: 1 },
      ]),
    ).not.toThrow();
  });
});
