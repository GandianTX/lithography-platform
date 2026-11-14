import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// 默认全部委托真实实现，仅让 `lstat`/`open` 可在确定性替换时插入检查点。
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, lstat: jest.fn(actual.lstat), open: jest.fn(actual.open) };
});

import {
  assertDevSampleFilesDirectory,
  claimDevSampleFilesDirectory,
  deleteDevSampleFile,
  deriveDevSampleStorageReference,
  sha256Of,
  verifyDevSampleFile,
  writeDevSampleFile,
  type DevSampleDirectoryOwnership,
  type DevSampleFileSpec,
  type DevSampleFileClaim,
} from './dev-sample-files';

const DATABASE = 'lithography_dev_v13_accept';
const SERVER_UUID = '6ccd2f7e-1b0f-11ee-be56-0242ac120002';
const CONTENT = Buffer.from('开发联调样例原件\n，仅用于本地验收。\n', 'utf8');
const SEED_KEY = 'dev-reference-document-a';

type RuntimeClaim = DevSampleFileClaim & {
  readonly published: boolean;
  close(): Promise<void>;
};

function runtimeClaim(claim: DevSampleFileClaim | null): RuntimeClaim {
  return claim as unknown as RuntimeClaim;
}

function makeSpec(): DevSampleFileSpec {
  return {
    originalFilename: 'dev-sample.txt',
    mimeType: 'text/plain',
    byteSize: CONTENT.byteLength,
    sha256: createHash('sha256').update(CONTENT).digest('hex'),
    content: CONTENT,
  };
}

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sample-files-'));
}

function makeTargetDir(): { root: string; dir: string } {
  const root = makeRoot();
  const dir = path.join(root, DATABASE);
  fs.mkdirSync(dir);
  return { root, dir };
}

const openedOwnerships: DevSampleDirectoryOwnership[] = [];

async function claimOwned(dir: string): Promise<DevSampleDirectoryOwnership> {
  const owner = await claimDevSampleFilesDirectory(dir, DATABASE, SERVER_UUID);
  openedOwnerships.push(owner);
  return owner;
}

afterEach(async () => {
  while (openedOwnerships.length > 0) {
    const owner = openedOwnerships.pop();
    if (owner) {
      try {
        await owner.close();
      } catch {
        // 句柄可能已在用例内关闭；这里只做兜底收尾。
      }
    }
  }
});

describe('开发样例原件目录守卫（不连接实库）', () => {
  it('接受以目标库名命名的专属真实目录', () => {
    const { dir } = makeTargetDir();
    expect(() => assertDevSampleFilesDirectory(dir, DATABASE)).not.toThrow();
  });

  it('拒绝相对路径、非目标库目录与共享根', () => {
    const { root } = makeTargetDir();
    expect(() => assertDevSampleFilesDirectory(`./${DATABASE}`, DATABASE)).toThrow(/绝对路径/);
    expect(() => assertDevSampleFilesDirectory(root, DATABASE)).toThrow(/专属目录/);
    expect(() => assertDevSampleFilesDirectory(os.tmpdir(), DATABASE)).toThrow(/专属目录|共享根/);
  });

  it('拒绝不存在的目录，要求与目标库一起预建', () => {
    expect(() => assertDevSampleFilesDirectory(path.join(makeRoot(), DATABASE), DATABASE)).toThrow(
      /不存在/,
    );
  });

  it('拒绝符号链接目录', () => {
    const root = makeRoot();
    const real = path.join(root, 'real-storage');
    fs.mkdirSync(real);
    const link = path.join(root, DATABASE);
    fs.symlinkSync(real, link);
    expect(() => assertDevSampleFilesDirectory(link, DATABASE)).toThrow(/符号链接/);
  });
});

describe('开发样例原件目录归属（不连接实库）', () => {
  it('首次排他认领后写入实例 UUID 与精确库名，并允许同实例同库重跑', async () => {
    const { dir } = makeTargetDir();
    const first = await claimOwned(dir);
    expect(first.database).toBe(DATABASE);
    expect(first.serverUuid).toBe(SERVER_UUID);
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, '.lithography-dev-sample-owner.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      format_version: 1,
      database: DATABASE,
      server_uuid: SERVER_UUID,
    });
    const second = await claimOwned(dir);
    expect(second.markerIdentity).toEqual(first.markerIdentity);
  });

  it('另一实例的同名库不得复用目录，且保留现场', async () => {
    const { dir } = makeTargetDir();
    await claimOwned(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep', 'utf8');
    await expect(
      claimDevSampleFilesDirectory(dir, DATABASE, '11111111-2222-3333-4444-555555555555'),
    ).rejects.toThrow(/归属不匹配/);
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('非空且无可信归属标记的旧目录拒绝认领，不自动补标记也不清理', async () => {
    const { dir } = makeTargetDir();
    fs.writeFileSync(path.join(dir, 'legacy.txt'), 'legacy', 'utf8');
    await expect(claimDevSampleFilesDirectory(dir, DATABASE, SERVER_UUID)).rejects.toThrow(
      /非空且无可信归属标记/,
    );
    expect(fs.readdirSync(dir)).toEqual(['legacy.txt']);
  });
});

describe('开发样例原件写入与核对（不连接实库）', () => {
  async function ownership(dir: string): Promise<DevSampleDirectoryOwnership> {
    return claimOwned(dir);
  }

  it('句柄写入后暂存路径被替换时拒绝发布且保留替换物', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    let recorded: DevSampleFileClaim | null = null;
    const sentinel = path.join(dir, 'keep.txt');
    fs.writeFileSync(sentinel, '预存文件');
    try {
      await expect(
        writeDevSampleFile(dir, makeSpec(), {
          storageReference: reference,
          ownership: owner,
          onClaim: (claim) => {
            recorded = claim;
          },
          writeContent: async (handle, content) => {
            await handle.writeFile(content);
            const staging = runtimeClaim(recorded).stagingPath;
            fs.renameSync(staging, `${staging}.original`);
            fs.writeFileSync(staging, '替换物');
          },
        }),
      ).rejects.toThrow(/暂存路径已被替换/);
      expect(runtimeClaim(recorded).published).toBe(false);
      expect(fs.existsSync(path.join(dir, reference))).toBe(false);
      expect(fs.readFileSync(runtimeClaim(recorded).stagingPath, 'utf8')).toBe('替换物');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('预存文件');
    } finally {
      await runtimeClaim(recorded).close();
    }
  });

  it('同 seed_key 派生稳定引用，写入后回读通过且不自动删除', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const spec = makeSpec();
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    expect(reference).toMatch(/^[0-9a-f]{32}\.txt$/);
    expect(deriveDevSampleStorageReference(SEED_KEY)).toBe(reference);

    const { storageReference, claim } = await writeDevSampleFile(dir, spec, {
      storageReference: reference,
      ownership: owner,
    });
    expect(storageReference).toBe(reference);
    expect(claim).not.toBeNull();
    expect(runtimeClaim(claim).published).toBe(true);
    expect(await verifyDevSampleFile(dir, reference, spec)).toBe('VERIFIED');
    const stagingPath = runtimeClaim(claim).stagingPath;
    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(await verifyDevSampleFile(dir, reference, spec)).toBe('VERIFIED');
    expect(fs.readFileSync(stagingPath)).toEqual(CONTENT);
    await runtimeClaim(claim).close();
    // 句柄关闭也不改变“共享目录不自动删除”的结论。
    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(await verifyDevSampleFile(dir, reference, spec)).toBe('VERIFIED');
  });

  it('排他创建遇到 EEXIST 时保留既有文件且字节不变', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const target = path.join(dir, reference);
    fs.writeFileSync(target, '原有字节', 'utf8');

    await expect(
      writeDevSampleFile(dir, makeSpec(), { storageReference: reference, ownership: owner }),
    ).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(target, 'utf8')).toBe('原有字节');
  });

  it('部分写入失败时最终路径不得出现半截文件，暂存残件供事务收尾', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const target = path.join(dir, reference);
    let claimed: DevSampleFileClaim | null = null;

    await expect(
      writeDevSampleFile(dir, makeSpec(), {
        storageReference: reference,
        ownership: owner,
        onClaim: (claim) => {
          claimed = claim;
        },
        writeContent: async (handle) => {
          await handle.write(CONTENT.subarray(0, 2));
          throw new Error('partial write');
        },
      }),
    ).rejects.toThrow(/partial write/);
    expect(claimed).not.toBeNull();
    const claim = runtimeClaim(claimed);
    expect(claim.published).toBe(false);
    expect(claim.filePath).not.toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(claim.filePath)).toEqual(CONTENT.subarray(0, 2));
    await claim.close();
  });

  it('关闭句柄后的身份快照不能单独授权删除（替身反例）', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const { claim } = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
    });
    const target = path.join(dir, reference);
    // 先关闭句柄，旧实现仅凭关闭前保存的 dev+ino 仍会删除；新实现必须保留。
    await runtimeClaim(claim).close();
    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(fs.readFileSync(target)).toEqual(CONTENT);
  });

  it('取得句柄后身份登记失败时保留现场并报告路径', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    let claimed: DevSampleFileClaim | null = null;

    let error: unknown;
    try {
      await writeDevSampleFile(dir, makeSpec(), {
        storageReference: reference,
        ownership: owner,
        onClaim: (claim) => {
          claimed = claim;
        },
        readIdentity: async () => {
          throw new Error('identity unavailable');
        },
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(claimed).toBeNull();
    expect(fs.existsSync(path.join(dir, reference))).toBe(false);
    const notes = (error as Error & { cleanupErrors?: ReadonlyArray<string> }).cleanupErrors ?? [];
    expect(notes.join(' | ')).toContain('未登记本轮原件归属');
  });

  it('删除原对象后立即同路径重建时不得删除替换物（文件系统实测）', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const { claim } = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
    });
    const target = path.join(dir, reference);
    fs.unlinkSync(target);
    fs.writeFileSync(target, '同路径重建物', 'utf8');

    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(fs.readFileSync(target, 'utf8')).toBe('同路径重建物');
    await runtimeClaim(claim).close();
  });

  it('目标被替换后拒绝删除替换物', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const { claim } = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
    });
    const target = path.join(dir, reference);
    const replacement = Buffer.from('替换物', 'utf8');
    fs.renameSync(target, `${target}.orig`);
    fs.writeFileSync(target, replacement);

    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(fs.readFileSync(target)).toEqual(replacement);
    expect(sha256Of(fs.readFileSync(target))).toBe(sha256Of(replacement));
    await runtimeClaim(claim).close();
  });

  it('最终路径在核对之后、删除之前被替换时，替换物字节与哈希不变', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const { claim } = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
    });
    const target = path.join(dir, reference);
    const stagingPath = runtimeClaim(claim).stagingPath;
    const replacement = Buffer.from('核对后替换的最终路径内容\n', 'utf8');
    fs.unlinkSync(target);
    fs.writeFileSync(target, replacement);

    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(fs.readFileSync(target)).toEqual(replacement);
    expect(sha256Of(fs.readFileSync(target))).toBe(sha256Of(replacement));
    expect(fs.readFileSync(stagingPath)).toEqual(CONTENT);
    await runtimeClaim(claim).close();
  });

  it('暂存路径在核对之后、删除之前被替换时，替换物字节与哈希不变', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    let claimed: DevSampleFileClaim | null = null;
    await expect(
      writeDevSampleFile(dir, makeSpec(), {
        storageReference: reference,
        ownership: owner,
        onClaim: (claim) => {
          claimed = claim;
        },
        writeContent: async (handle) => {
          await handle.write(CONTENT.subarray(0, 2));
          throw new Error('partial write');
        },
      }),
    ).rejects.toThrow(/partial write/);
    const claim = runtimeClaim(claimed);
    expect(claim.published).toBe(false);
    const stagingPath = claim.stagingPath;
    const replacement = Buffer.from('核对后替换的暂存路径内容\n', 'utf8');
    fs.unlinkSync(stagingPath);
    fs.writeFileSync(stagingPath, replacement);

    await expect(deleteDevSampleFile(claim)).resolves.toBe('RETAINED');
    expect(fs.readFileSync(stagingPath)).toEqual(replacement);
    expect(sha256Of(fs.readFileSync(stagingPath))).toBe(sha256Of(replacement));
    await claim.close();
  });

  it('同目标同目录重跑不覆盖、不新增文件', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const first = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
    });
    await runtimeClaim(first.claim).close();
    const before = fs.readdirSync(dir).sort();

    await expect(
      writeDevSampleFile(dir, makeSpec(), { storageReference: reference, ownership: owner }),
    ).rejects.toThrow(/EEXIST/);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(await verifyDevSampleFile(dir, reference, makeSpec())).toBe('VERIFIED');
  });

  it('暂存路径在核对后、发布前被替换时只发布已校验的原对象', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const target = path.join(dir, reference);
    let recorded: DevSampleFileClaim | null = null;
    const replacement = Buffer.from('核对后替换的暂存内容\n', 'utf8');

    const { claim } = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
      onClaim: (value) => {
        recorded = value;
      },
      beforePublish: () => {
        const stagingPath = runtimeClaim(recorded).stagingPath;
        fs.renameSync(stagingPath, `${stagingPath}.original`);
        fs.writeFileSync(stagingPath, replacement);
      },
    });

    const view = runtimeClaim(claim);
    expect(view.published).toBe(true);
    expect(fs.readFileSync(target)).toEqual(CONTENT);
    expect(sha256Of(fs.readFileSync(target))).toBe(makeSpec().sha256);
    expect(fs.readFileSync(view.stagingPath)).toEqual(replacement);
    expect(fs.readFileSync(`${view.stagingPath}.original`)).toEqual(CONTENT);
    expect(sha256Of(fs.readFileSync(view.stagingPath))).toBe(sha256Of(replacement));
    await view.close();
    await owner.close();
  });

  it('发布前目标目录被替换时仍写入已认领目录，未认领目录零新增', async () => {
    const { root, dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const claimedSentinel = path.join(dir, 'claimed.txt');
    fs.writeFileSync(claimedSentinel, '已认领目录预存文件');
    const detour = path.join(root, 'detour');
    fs.mkdirSync(detour);
    fs.writeFileSync(path.join(detour, 'unclaimed.txt'), '未认领目录预存文件');
    let recorded: DevSampleFileClaim | null = null;
    let error: unknown;
    try {
      await writeDevSampleFile(dir, makeSpec(), {
        storageReference: reference,
        ownership: owner,
        onClaim: (value) => {
          recorded = value;
        },
        beforePublish: () => {
          // 最后一次目录核对通过之后、实际发布之前，把配置路径换成另一个目录。
          fs.renameSync(dir, `${dir}.claimed`);
          fs.renameSync(detour, dir);
        },
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/配置路径已指向其他目录/);
    // 未认领目录（当前配置路径）只保留自己的预存文件，零新增。
    expect(fs.readdirSync(dir)).toEqual(['unclaimed.txt']);
    expect(fs.readFileSync(path.join(dir, 'unclaimed.txt'), 'utf8')).toBe('未认领目录预存文件');
    expect(fs.existsSync(path.join(dir, reference))).toBe(false);
    // 已认领目录（原 inode，已被改名）收到发布文件；预存文件不变。
    const claimedDir = `${dir}.claimed`;
    expect(fs.readFileSync(path.join(claimedDir, reference))).toEqual(CONTENT);
    expect(fs.readFileSync(path.join(claimedDir, 'claimed.txt'), 'utf8')).toBe(
      '已认领目录预存文件',
    );
    const view = runtimeClaim(recorded);
    expect(view.published).toBe(true);
    // 收尾存在性判断也必须经已认领目录句柄，不能因配置路径被替换而误报已清理。
    await expect(deleteDevSampleFile(view)).resolves.toBe('RETAINED');
    const notes = (error as Error & { cleanupErrors?: ReadonlyArray<string> }).cleanupErrors ?? [];
    expect(notes.join(' | ')).toContain('最终路径已发布');
    expect(notes.join(' | ')).toContain('已发布文件身份 dev=');
    expect(notes.join(' | ')).toContain(`dev=${String(owner.directoryIdentity.device)}`);
    await view.close();
    await owner.close();
  });

  it('预检通过后配置路径被替换时暂存仍写入已认领目录，未认领目录零新增', async () => {
    const { root, dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const claimedSentinel = path.join(dir, 'claimed.txt');
    fs.writeFileSync(claimedSentinel, '已认领目录预存文件');
    const detour = path.join(root, 'detour');
    fs.mkdirSync(detour);
    fs.writeFileSync(path.join(detour, 'unclaimed.txt'), '未认领目录预存文件');
    const realBind = owner.assertPathBinding.bind(owner);
    let swapped = false;
    const bindSpy = jest.spyOn(owner, 'assertPathBinding').mockImplementation(async () => {
      await realBind();
      if (!swapped) {
        // 认领后、暂存创建前把配置路径换成另一个目录。
        swapped = true;
        fs.renameSync(dir, `${dir}.claimed`);
        fs.renameSync(detour, dir);
      }
    });

    let error: unknown;
    try {
      await writeDevSampleFile(dir, makeSpec(), {
        storageReference: reference,
        ownership: owner,
      });
    } catch (thrown) {
      error = thrown;
    } finally {
      bindSpy.mockRestore();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/配置路径已指向其他目录/);
    // 未认领目录（当前配置路径）只保留自己的预存文件，零新增。
    expect(fs.readdirSync(dir)).toEqual(['unclaimed.txt']);
    expect(fs.readFileSync(path.join(dir, 'unclaimed.txt'), 'utf8')).toBe('未认领目录预存文件');
    expect(fs.existsSync(path.join(dir, reference))).toBe(false);
    // 已认领目录（原 inode）收到归属标记、暂存对象与发布文件；预存文件不变。
    const claimedDir = `${dir}.claimed`;
    const entries = fs.readdirSync(claimedDir);
    expect(entries).toContain('.lithography-dev-sample-owner.json');
    expect(entries.some((name) => name.startsWith('.dev-sample-staging-'))).toBe(true);
    expect(fs.readFileSync(path.join(claimedDir, reference))).toEqual(CONTENT);
    expect(fs.readFileSync(path.join(claimedDir, 'claimed.txt'), 'utf8')).toBe(
      '已认领目录预存文件',
    );
    await owner.close();
  });

  it('认领打开前任一上级目录被换成符号链接时拒绝且零写入', async () => {
    const root = makeRoot();
    const container = path.join(root, 'container');
    const dir = path.join(container, DATABASE);
    fs.mkdirSync(dir, { recursive: true });
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, DATABASE), { recursive: true });
    fs.writeFileSync(path.join(other, DATABASE, 'sentinel.txt'), '未认领目录预存文件');

    const openMock = fsp.open as jest.MockedFunction<typeof fsp.open>;
    const realOpen = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises').open;
    let swapped = false;
    openMock.mockImplementation(((target: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      if (!swapped && String(target) === dir) {
        // 守卫通过之后、真正打开目录之前，把上级目录换成指向另存目录的符号链接。
        swapped = true;
        fs.renameSync(container, `${container}.real`);
        fs.symlinkSync(other, container);
      }
      return realOpen(target, flags, mode);
    }) as typeof fsp.open);

    try {
      await expect(claimOwned(dir)).rejects.toThrow(/句柄指向的路径与配置不一致/);
    } finally {
      openMock.mockImplementation(realOpen);
    }

    expect(swapped).toBe(true);
    // 未认领目录零新增：没有归属标记，只保留预存文件。
    expect(fs.readdirSync(path.join(other, DATABASE))).toEqual(['sentinel.txt']);
    expect(fs.readdirSync(path.join(`${container}.real`, DATABASE))).toEqual([]);
  });

  it('认领后配置路径被替换时不创建暂存对象或归属标记', async () => {
    const { root, dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const detour = path.join(root, 'detour');
    fs.mkdirSync(detour);
    fs.writeFileSync(path.join(detour, 'unclaimed.txt'), '未认领目录预存文件');
    fs.renameSync(dir, `${dir}.claimed`);
    fs.renameSync(detour, dir);
    const onClaim = jest.fn();

    await expect(
      writeDevSampleFile(dir, makeSpec(), {
        storageReference: reference,
        ownership: owner,
        onClaim,
      }),
    ).rejects.toThrow(/配置路径已指向其他目录/);

    expect(onClaim).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(['unclaimed.txt']);
    expect(fs.readFileSync(path.join(dir, 'unclaimed.txt'), 'utf8')).toBe('未认领目录预存文件');
    expect(fs.readdirSync(`${dir}.claimed`)).toContain('.lithography-dev-sample-owner.json');
    await owner.close();
  });

  it('内容被改动后核对为不一致且不覆盖', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    const { claim } = await writeDevSampleFile(dir, makeSpec(), {
      storageReference: reference,
      ownership: owner,
    });
    await runtimeClaim(claim).close();
    fs.writeFileSync(path.join(dir, reference), 'tampered', 'utf8');
    expect(await verifyDevSampleFile(dir, reference, makeSpec())).toBe('MISMATCH');
  });

  it('拒绝越界或格式非法的存储引用', async () => {
    const { dir } = makeTargetDir();
    const spec = makeSpec();
    for (const reference of [
      '../escape.txt',
      'not-a-reference',
      'A'.repeat(32) + '.txt',
      'a'.repeat(31) + '.txt',
    ]) {
      await expect(verifyDevSampleFile(dir, reference, spec)).rejects.toThrow();
    }
  });

  it('哈希工具输出稳定小写十六进制', () => {
    expect(sha256Of(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
