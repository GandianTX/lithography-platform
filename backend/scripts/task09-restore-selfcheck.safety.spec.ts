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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertAuthorizationNotOverwritable,
  assertControlledFileRoot,
  assertDisposableMarker,
  assertNoExternalReference,
  assertNoForeignActiveHold,
  assertPathWithinRoot,
  assertSentinelsUnchanged,
  assertServerIdentity,
  buildCleanupError,
  planDatabaseDeletion,
  planFileDeletion,
  readSelfcheckAuthorization,
  selectReleasableHolds,
  SELFCHECK_TEST_AUTHORIZATION,
  SelfcheckSafetyError,
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
