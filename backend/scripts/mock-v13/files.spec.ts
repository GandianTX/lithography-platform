// scripts/mock-v13/files.spec.ts

/**
 * 离线文件测试：记录包校验和、文件复用/异主冲突、失败回收范围、凭据文件不覆盖。
 * 全部使用系统临时目录，不接触仓库与真实参考资料目录。
 */

/// <reference types="jest" />

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GuardViolationError, MockConflictError, MockWriteError } from './errors';
import {
  FileRegistry,
  FileWriteHooks,
  MOCK_ROOT_OWNER_FILE,
  claimMockRoots,
  buildMockPackage,
  canonicalJson,
  corruptMockPackage,
  mockPng,
  mockTextDocument,
  sha256Hex,
  verifyMockPackageContent,
  writeCredentialsFile,
  writeJsonFileExclusive,
} from './files';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-files-'));
}

describe('canonicalJson', () => {
  it('键顺序不影响结果', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('嵌套对象与数组保持稳定序列化', () => {
    expect(canonicalJson({ a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}]}');
  });
});

describe('记录包', () => {
  const build = () =>
    buildMockPackage({
      packageId: 'MOCK-V13-PKG-1',
      organizationCode: 'MOCK-V13-A',
      generatedAt: '2026-11-06T00:00:00.000Z',
      items: [
        {
          record_uuid: 'a1',
          resource_type: 'REPAIR_REQUEST',
          version_no: 1,
          payload: { requestNo: 'MOCK-V13-REQ-A-001' },
        },
      ],
    });

  it('合法包内容校验通过', () => {
    const result = verifyMockPackageContent(JSON.stringify(build()));
    expect(result.ok).toBe(true);
    expect(result.computed).toBe(result.expected);
  });

  it('篡改内容但保留旧校验和时校验失败', () => {
    const corrupted = corruptMockPackage(build());
    const result = verifyMockPackageContent(JSON.stringify(corrupted));
    expect(result.ok).toBe(false);
    expect(result.computed).not.toBe(result.expected);
  });

  it('缺少校验字段时拒绝解析', () => {
    expect(() => verifyMockPackageContent(JSON.stringify({ items: [] }))).toThrow(
      MockConflictError,
    );
  });
});

describe('FileRegistry', () => {
  let tempDir: string;
  let registry: FileRegistry;

  beforeEach(() => {
    tempDir = createTempDir();
    registry = new FileRegistry([tempDir]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('首次写入返回 CREATED，同内容重跑返回 REUSED', () => {
    const target = path.join(tempDir, 'a.png');
    const content = mockPng();
    expect(registry.ensure(target, content)).toBe('CREATED');
    expect(registry.ensure(target, content)).toBe('REUSED');
    expect(registry.createdCount()).toBe(1);
  });

  it('同路径不同内容视为异主文件，拒绝覆盖', () => {
    const target = path.join(tempDir, 'a.txt');
    registry.ensure(target, mockTextDocument('标题', '原始内容'));
    expect(() => registry.ensure(target, mockTextDocument('标题', '被篡改内容'))).toThrow(
      MockConflictError,
    );
  });

  it('受控目录之外直接拒绝', () => {
    expect(() =>
      registry.ensure(path.join(os.tmpdir(), 'mock-v13-outside.png'), mockPng()),
    ).toThrow(MockConflictError);
  });

  it('回收只删除本次创建的文件，不动既有文件', () => {
    const existing = path.join(tempDir, 'existing.txt');
    fs.writeFileSync(existing, '人工放置', 'utf8');
    const created = path.join(tempDir, 'created.png');
    registry.ensure(created, mockPng());
    const cleanup = registry.cleanupCreated();

    expect(fs.existsSync(created)).toBe(false);
    expect(fs.existsSync(existing)).toBe(true);
    expect(cleanup.removed).toEqual([created]);
    expect(cleanup.retained).toEqual([]);
    expect(registry.createdCount()).toBe(0);
  });

  it('回收前文件被替换时保留替换物并报告', () => {
    const created = path.join(tempDir, 'created.png');
    registry.ensure(created, mockPng());
    fs.unlinkSync(created);
    fs.writeFileSync(created, '替换物', 'utf8');

    const cleanup = registry.cleanupCreated();

    expect(fs.existsSync(created)).toBe(true);
    expect(fs.readFileSync(created, 'utf8')).toBe('替换物');
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.retained.join('\n')).toMatch(/对象身份已变化|内容已变化/);
  });

  it('回收前文件被替换为链接时保留链接，不跟随删除目标', () => {
    const created = path.join(tempDir, 'created.png');
    const outside = path.join(tempDir, 'outside.txt');
    fs.writeFileSync(outside, '边界外哨兵', 'utf8');
    registry.ensure(created, mockPng());
    fs.unlinkSync(created);
    fs.symlinkSync(outside, created);

    const cleanup = registry.cleanupCreated();

    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('边界外哨兵');
    expect(fs.lstatSync(created).isSymbolicLink()).toBe(true);
    expect(cleanup.retained.join('\n')).toContain('已不是本轮创建的普通文件');
  });

  it('已存在的符号链接路径组件在写入前拒绝', () => {
    const outside = createTempDir();
    const linked = path.join(tempDir, 'linked-root');
    fs.symlinkSync(outside, linked);
    try {
      expect(() => registry.ensure(path.join(linked, 'a.png'), mockPng())).toThrow(/符号链接/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('claimMockRoots', () => {
  const ownerA = {
    instanceUuid: '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42',
    database: 'lithography_v13_a',
  };
  const ownerB = {
    instanceUuid: '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42',
    database: 'lithography_v13_b',
  };
  const otherInstance = {
    instanceUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    database: 'lithography_v13_a',
  };
  let base: string;

  const targets = (mock: string, reference: string) => [
    { flag: '--mock-file-dir' as const, dir: mock },
    { flag: '--reference-storage-dir' as const, dir: reference },
  ];

  beforeEach(() => {
    base = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('首次为两个根排他建立归属标记，同库同目录重跑成功', () => {
    const mock = path.join(base, 'mock');
    const reference = path.join(base, 'reference');
    const first = claimMockRoots(targets(mock, reference), ownerA);
    expect(first).toHaveLength(2);
    expect(fs.existsSync(path.join(mock, MOCK_ROOT_OWNER_FILE))).toBe(true);
    expect(fs.existsSync(path.join(reference, MOCK_ROOT_OWNER_FILE))).toBe(true);
    const marker = JSON.parse(
      fs.readFileSync(path.join(mock, MOCK_ROOT_OWNER_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(marker.instance_uuid).toBe(ownerA.instanceUuid);
    expect(marker.database).toBe(ownerA.database);
    expect(marker.role).toBe('mock-file-dir');
    expect(() => claimMockRoots(targets(mock, reference), ownerA)).not.toThrow();
  });

  it('同一根被另一库或另一实例认领后拒绝', () => {
    const mock = path.join(base, 'mock');
    const reference = path.join(base, 'reference');
    claimMockRoots(targets(mock, reference), ownerA);
    expect(() => claimMockRoots(targets(mock, reference), ownerB)).toThrow(GuardViolationError);
    expect(() => claimMockRoots(targets(mock, reference), otherInstance)).toThrow(/其它实例或库/u);
  });

  it('只共享一个已认领根时，B 在写入前拒绝', () => {
    const mock = path.join(base, 'mock');
    const referenceA = path.join(base, 'reference-a');
    claimMockRoots(targets(mock, referenceA), ownerA);
    const referenceB = path.join(base, 'reference-b');
    expect(() => claimMockRoots(targets(mock, referenceB), ownerB)).toThrow(/其它实例或库/u);
    expect(fs.existsSync(referenceB)).toBe(false);
  });

  it('无标记的旧目录已有内容时拒绝，不自动认领或清理', () => {
    const mock = path.join(base, 'mock');
    const reference = path.join(base, 'reference');
    fs.mkdirSync(mock, { recursive: true });
    fs.writeFileSync(path.join(mock, 'legacy.txt'), '旧内容', 'utf8');
    expect(() => claimMockRoots(targets(mock, reference), ownerA)).toThrow(/没有可信归属标记/u);
    expect(fs.readFileSync(path.join(mock, 'legacy.txt'), 'utf8')).toBe('旧内容');
    expect(fs.existsSync(path.join(mock, MOCK_ROOT_OWNER_FILE))).toBe(false);
  });

  it('不同库使用各自独立目录时均可认领', () => {
    const mockA = path.join(base, 'mock-a');
    const referenceA = path.join(base, 'reference-a');
    const mockB = path.join(base, 'mock-b');
    const referenceB = path.join(base, 'reference-b');
    claimMockRoots(targets(mockA, referenceA), ownerA);
    claimMockRoots(targets(mockB, referenceB), ownerB);
    expect(fs.existsSync(path.join(mockA, MOCK_ROOT_OWNER_FILE))).toBe(true);
    expect(fs.existsSync(path.join(mockB, MOCK_ROOT_OWNER_FILE))).toBe(true);
  });

  it('A 写出文件并暂停后，B 在业务写入前拒绝；回滚只回收本轮文件，标记保留', () => {
    const mock = path.join(base, 'mock');
    const reference = path.join(base, 'reference');
    claimMockRoots(targets(mock, reference), ownerA);
    const filesA = new FileRegistry([mock, reference]);
    const fileA = path.join(mock, 'files', 'a.png');
    expect(filesA.ensure(fileA, Buffer.from('A 已提交内容'))).toBe('CREATED');

    expect(() => claimMockRoots(targets(mock, reference), ownerB)).toThrow(/其它实例或库/u);
    expect(fs.readFileSync(fileA, 'utf8')).toBe('A 已提交内容');

    const cleanup = filesA.cleanupCreated();
    expect(cleanup.removed).toEqual([fileA]);
    expect(fs.existsSync(fileA)).toBe(false);
    expect(fs.existsSync(path.join(mock, MOCK_ROOT_OWNER_FILE))).toBe(true);
  });

  it('A/B 并发认领同一空根：恰好一方成功，另一方在写入前被拒', async () => {
    const mock = path.join(base, 'race-mock');
    const reference = path.join(base, 'race-reference');
    const modulePath = path.resolve(__dirname, 'files');
    const script = [
      'const { claimMockRoots } = require(process.env.MOCK_V13_FILES_MODULE);',
      'try {',
      '  claimMockRoots([',
      "    { flag: '--mock-file-dir', dir: process.env.MOCK_V13_MOCK_ROOT },",
      "    { flag: '--reference-storage-dir', dir: process.env.MOCK_V13_REF_ROOT },",
      '  ], {',
      '    instanceUuid: process.env.MOCK_V13_UUID,',
      '    database: process.env.MOCK_V13_DB,',
      '  });',
      "  process.stdout.write('OK');",
      '} catch (error) {',
      '  process.stderr.write(String(error instanceof Error ? error.message : error));',
      '  process.exit(3);',
      '}',
    ].join('\n');
    const run = (database: string): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', 'ts-node/register', '-e', script], {
          cwd: path.resolve(__dirname, '..', '..'),
          env: {
            ...process.env,
            TS_NODE_TRANSPILE_ONLY: '1',
            TS_NODE_COMPILER_OPTIONS:
              '{"module":"commonjs","moduleResolution":"node","rootDir":".","ignoreDeprecations":"6.0"}',
            MOCK_V13_FILES_MODULE: modulePath,
            MOCK_V13_MOCK_ROOT: mock,
            MOCK_V13_REF_ROOT: reference,
            MOCK_V13_UUID: ownerA.instanceUuid,
            MOCK_V13_DB: database,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const [first, second] = await Promise.all([run(ownerA.database), run(ownerB.database)]);
    expect([first.code, second.code].sort((a, b) => Number(a) - Number(b))).toEqual([0, 3]);
    const [winner, loser] = first.code === 0 ? [ownerA, second] : [ownerB, first];
    // 竞争方的三种合法安全拒绝：看到无标记旧内容、看到对方正式标记、第一次检查后才发现内容。
    expect(loser.stderr).toMatch(
      /已有内容但没有可信归属标记|已被其它实例或库认领|在认领前出现内容/u,
    );
    for (const [root, role] of [
      [mock, 'mock-file-dir'],
      [reference, 'reference-storage-dir'],
    ] as const) {
      const marker: unknown = JSON.parse(
        fs.readFileSync(path.join(root, MOCK_ROOT_OWNER_FILE), 'utf8'),
      );
      expect(marker).toMatchObject({
        instance_uuid: winner.instanceUuid,
        database: winner.database,
        role,
      });
    }
  }, 30000);

  it('第一次检查为空、第二次检查前出现内容时拒绝，不发布标记也不改动新内容', () => {
    const mock = path.join(base, 'late-mock');
    const reference = path.join(base, 'late-reference');
    // 预建空目录让第一次检查通过；随后在首根发布钩子里写入内容，稳定制造两次检查之间的差异。
    fs.mkdirSync(reference, { recursive: true });
    const lateContent = path.join(reference, 'late-arrival.txt');
    let message = '';
    try {
      claimMockRoots(targets(mock, reference), ownerA, {
        beforePublish: (_claim, index) => {
          if (index === 0) {
            fs.writeFileSync(lateContent, '认领前出现的内容', 'utf8');
          }
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('在认领前出现内容');
    expect(fs.existsSync(path.join(reference, MOCK_ROOT_OWNER_FILE))).toBe(false);
    expect(fs.readFileSync(lateContent, 'utf8')).toBe('认领前出现的内容');
    expect(
      fs.readdirSync(reference).filter((name) => name.startsWith(`${MOCK_ROOT_OWNER_FILE}.tmp-`)),
    ).toEqual([]);
  });

  it('两个根相同或互相嵌套时拒绝', () => {
    const root = path.join(base, 'root');
    expect(() => claimMockRoots(targets(root, root), ownerA)).toThrow(/不同目录/u);
    expect(() => claimMockRoots(targets(root, path.join(root, 'nested')), ownerA)).toThrow(
      /不能相互嵌套/u,
    );
  });
});

describe('部分写入的残件回收', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function enospcAfterPartialWrite(): FileWriteHooks {
    return {
      beforeWriteContent: (fd) => {
        fs.writeSync(fd, Buffer.from('部分'));
        const error = new Error('ENOSPC: no space left on device');
        (error as NodeJS.ErrnoException).code = 'ENOSPC';
        throw error;
      },
    };
  }

  it('真实写入部分字节后报 ENOSPC：残件可回收，预存哨兵不变，关闭注入后重跑成功', () => {
    const sentinel = path.join(tempDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, '预存哨兵', 'utf8');
    const target = path.join(tempDir, 'files', 'partial.png');
    const content = Buffer.from('完整原件内容');

    const failing = new FileRegistry([tempDir], enospcAfterPartialWrite());
    expect(() => failing.ensure(target, content)).toThrow(MockWriteError);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).size).toBeGreaterThan(0);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('预存哨兵');

    const cleanup = failing.cleanupCreated();
    expect(cleanup.retained).toEqual([]);
    expect(cleanup.removed).toEqual([target]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('预存哨兵');

    const healthy = new FileRegistry([tempDir]);
    expect(healthy.ensure(target, content)).toBe('CREATED');
    expect(healthy.cleanupCreated().removed).toEqual([target]);
  });

  it('部分写入后被替换的身份不明对象保留并报告', () => {
    const target = path.join(tempDir, 'files', 'partial.png');
    const failing = new FileRegistry([tempDir], enospcAfterPartialWrite());
    expect(() => failing.ensure(target, Buffer.from('完整原件内容'))).toThrow(MockWriteError);
    fs.rmSync(target);
    fs.writeFileSync(target, '替换物', 'utf8');

    const cleanup = failing.cleanupCreated();
    expect(cleanup.removed).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('替换物');
    expect(cleanup.retained.join('\n')).toMatch(/对象身份已变化/u);
  });
});

describe('排他打开后的身份登记失败', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('原件 fstat 失败：句柄关闭，空原件保留并报告准确路径', () => {
    const sentinel = path.join(tempDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, '预存哨兵', 'utf8');
    const target = path.join(tempDir, 'files', 'identity.png');
    let capturedFd = -1;
    const registry = new FileRegistry([tempDir], {
      beforeReadFileIdentity: (fd) => {
        capturedFd = fd;
        throw new Error('注入：fstat 不可用');
      },
    });

    expect(() => registry.ensure(target, Buffer.from('完整原件内容'))).toThrow(MockWriteError);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).size).toBe(0);
    expect(() => fs.fstatSync(capturedFd)).toThrow(/EBADF/u);

    const cleanup = registry.cleanupCreated();
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.retained.join('\n')).toContain('身份未能登记');
    expect(cleanup.retained.join('\n')).toContain(target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('预存哨兵');
  });

  it('归属标记 fstat 失败：句柄关闭，正式标记不存在，临时文件无法证明归属时保留并诊断', () => {
    const mock = path.join(tempDir, 'mock');
    const reference = path.join(tempDir, 'reference');
    let capturedFd = -1;
    let tempPath = '';
    let message = '';
    try {
      claimMockRoots(
        [
          { flag: '--mock-file-dir', dir: mock },
          { flag: '--reference-storage-dir', dir: reference },
        ],
        { instanceUuid: '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42', database: 'lithography_v13_a' },
        {
          beforeReadIdentity: (fd, target) => {
            capturedFd = fd;
            tempPath = target;
            throw new Error('注入：标记 fstat 不可用');
          },
        },
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('归属标记失败');
    expect(message).toContain('已保留');
    expect(() => fs.fstatSync(capturedFd)).toThrow(/EBADF/u);
    expect(fs.existsSync(path.join(mock, MOCK_ROOT_OWNER_FILE))).toBe(false);
    expect(tempPath.startsWith(mock)).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(true);
    const entries = fs
      .readdirSync(mock)
      .filter((name) => name.startsWith(`${MOCK_ROOT_OWNER_FILE}.tmp-`));
    expect(entries).toHaveLength(1);
  });

  it('第二根发布失败：第一根标记保留，第二根无正式标记且临时文件不残留', () => {
    const mock = path.join(tempDir, 'mock');
    const reference = path.join(tempDir, 'reference');
    let message = '';
    try {
      claimMockRoots(
        [
          { flag: '--mock-file-dir', dir: mock },
          { flag: '--reference-storage-dir', dir: reference },
        ],
        { instanceUuid: '3f2b6c1e-9a4d-4c8b-8f2e-1c7d5a9b0e42', database: 'lithography_v13_a' },
        {
          beforePublish: (_claim, index) => {
            if (index === 1) {
              throw new MockWriteError('注入：第二根发布失败');
            }
          },
        },
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('第二根发布失败');
    const marker = JSON.parse(
      fs.readFileSync(path.join(mock, MOCK_ROOT_OWNER_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(marker.database).toBe('lithography_v13_a');
    expect(fs.existsSync(path.join(reference, MOCK_ROOT_OWNER_FILE))).toBe(false);
    const leftovers = fs
      .readdirSync(reference)
      .filter((name) => name.startsWith(`${MOCK_ROOT_OWNER_FILE}.tmp-`));
    expect(leftovers).toEqual([]);
  });
});

describe('writeCredentialsFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const content = {
    generated_at: '2026-11-06T00:00:00.000Z',
    mock: true as const,
    warning: '仅限开发联调；请通过受控渠道交付，不得提交到 Git。',
    password: 'MockV13#Passw0rd',
    accounts: [],
  };

  it('首次写入成功后权限为 0600', () => {
    const target = path.join(tempDir, 'credentials.json');
    writeCredentialsFile(target, content);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(sha256Hex(fs.readFileSync(target))).toBe(sha256Hex(fs.readFileSync(target)));
  });

  it('已存在时拒绝覆盖并保留原内容', () => {
    const target = path.join(tempDir, 'credentials.json');
    writeCredentialsFile(target, content);
    expect(() =>
      writeCredentialsFile(target, { ...content, password: 'DifferentPassword#1' }),
    ).toThrow(/已存在，拒绝覆盖/u);
    expect(fs.readFileSync(target, 'utf8')).toContain('MockV13#Passw0rd');
  });
});

describe('writeJsonFileExclusive', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('首次写入创建，重复使用同一路径直接拒绝（同内容也不复用）', () => {
    const target = path.join(tempDir, 'stats.json');
    writeJsonFileExclusive(target, { total: 1 });
    expect(() => writeJsonFileExclusive(target, { total: 1 })).toThrow(/已存在/u);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ total: 1 });
  });

  it('内容不同拒绝覆盖，保留原统计', () => {
    const target = path.join(tempDir, 'stats.json');
    writeJsonFileExclusive(target, { total: 1 });
    expect(() => writeJsonFileExclusive(target, { total: 2 })).toThrow(/已存在/u);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ total: 1 });
  });
});
