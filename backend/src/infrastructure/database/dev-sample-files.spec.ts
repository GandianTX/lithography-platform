import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    const first = await claimDevSampleFilesDirectory(dir, DATABASE, SERVER_UUID);
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
    const second = await claimDevSampleFilesDirectory(dir, DATABASE, SERVER_UUID);
    expect(second.markerIdentity).toEqual(first.markerIdentity);
  });

  it('另一实例的同名库不得复用目录，且保留现场', async () => {
    const { dir } = makeTargetDir();
    await claimDevSampleFilesDirectory(dir, DATABASE, SERVER_UUID);
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
    return claimDevSampleFilesDirectory(dir, DATABASE, SERVER_UUID);
  }

  it('同 seed_key 派生稳定引用，写入后回读通过并可精确回收', async () => {
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
    expect(await verifyDevSampleFile(dir, reference, spec)).toBe('VERIFIED');
    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('DELETED');
    expect(await verifyDevSampleFile(dir, reference, spec)).toBe('MISSING');
    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('DELETED');
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

  it('部分写入失败时关闭句柄并保留已登记的残件供事务收尾', async () => {
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
    expect(claimed).not.toBeNull();
    expect(fs.readFileSync(path.join(dir, reference))).toEqual(CONTENT.subarray(0, 2));
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
    expect(fs.existsSync(path.join(dir, reference))).toBe(true);
    const notes = (error as Error & { cleanupErrors?: ReadonlyArray<string> }).cleanupErrors ?? [];
    expect(notes.join(' | ')).toContain(path.join(dir, reference));
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
    fs.renameSync(target, `${target}.orig`);
    fs.writeFileSync(target, '替换物', 'utf8');

    await expect(deleteDevSampleFile(claim as DevSampleFileClaim)).resolves.toBe('RETAINED');
    expect(fs.readFileSync(target, 'utf8')).toBe('替换物');
  });

  it('同目标同目录重跑不覆盖、不新增文件', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    await writeDevSampleFile(dir, makeSpec(), { storageReference: reference, ownership: owner });
    const before = fs.readdirSync(dir).sort();

    await expect(
      writeDevSampleFile(dir, makeSpec(), { storageReference: reference, ownership: owner }),
    ).rejects.toThrow(/EEXIST/);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(await verifyDevSampleFile(dir, reference, makeSpec())).toBe('VERIFIED');
  });

  it('内容被改动后核对为不一致且不覆盖', async () => {
    const { dir } = makeTargetDir();
    const owner = await ownership(dir);
    const reference = deriveDevSampleStorageReference(SEED_KEY);
    await writeDevSampleFile(dir, makeSpec(), { storageReference: reference, ownership: owner });
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
