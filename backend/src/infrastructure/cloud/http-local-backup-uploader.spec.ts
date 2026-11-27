// src/infrastructure/cloud/http-local-backup-uploader.spec.ts
/**
 * 云备份**上传端**的定向测试（任务 09 第 10 项 D3／D5／D7／D9／D11）。
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { CLOUD_UPLOAD_FAILURE_CODES } from '@core/local-runtime/policy/local-backup-cloud-upload.policy';

import { HttpLocalBackupCloudClient } from './http-local-backup-cloud.client';
import { HttpLocalBackupUploader } from './http-local-backup-uploader';
import type { LocalBackupUploadResult } from '@usecases/common/ports/local-backup-upload.contract';

type HttpStub = { post: jest.Mock };

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 完整回执（可解析为 JSON ＋ 明确成功语义） */
const COMPLETE_RECEIPT = JSON.stringify({ received: true, status: 'SUCCEEDED' });

type PackageFixture = {
  root: string;
  manifestChecksum: string;
  cleanup: () => Promise<void>;
};

/** 造一个真实可读的备份包目录（清单 ＋ 载荷 ＋ 原件） */
async function createPackage(
  originals: Array<{ name: string; bytes: Buffer }> = [],
  options: { declareOriginals?: boolean } = {},
): Promise<PackageFixture> {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'task09-cloud-upload-'));
  const payload = Buffer.from('payload-bytes', 'utf8');
  await writeFile(nodePath.join(root, 'payload.enc'), payload);
  const files = [
    { relative_path: 'payload.enc', sha256: sha256(payload), byte_size: payload.byteLength },
  ];
  if (originals.length > 0) {
    await mkdir(nodePath.join(root, 'files'), { recursive: true });
  }
  for (const original of originals) {
    await writeFile(nodePath.join(root, 'files', original.name), original.bytes);
    files.push({
      relative_path: `files/${original.name}`,
      sha256: sha256(original.bytes),
      byte_size: original.bytes.byteLength,
    });
  }
  const manifest = {
    schema_version: 1,
    backup_id: '90b130fe-5ad7-45a2-aecb-970da4c9d030',
    organization_id: 4,
    installation_id: 'inst-1',
    run_id: null,
    generated_at: '2026-11-24T00:00:00.000Z',
    encryption: {
      algorithm: 'AES-256-GCM',
      key_id: 'task09-test',
      iv: '6bcc449c34609c449840dbfd',
      auth_tag: 'ac29e6970d8fb724492b660b023c536f',
    },
    scope: [{ table: 'repair_request', rowCount: 1, lastUpdatedAt: null }],
    files,
    originals:
      options.declareOriginals === false
        ? []
        : originals.map((original) => ({
            source: `stored_file:${original.name}`,
            storage_reference: original.name,
            sha256: sha256(original.bytes),
          })),
  };
  const raw = JSON.stringify(manifest);
  await writeFile(nodePath.join(root, 'manifest.json'), raw);
  return {
    root,
    manifestChecksum: sha256(Buffer.from(raw, 'utf8')),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

type UploaderFixture = {
  uploader: HttpLocalBackupUploader;
  post: jest.Mock;
};

/** 造一个上传端：内部 HTTP 客户端被替掉（不触网） */
function buildUploader(
  options: {
    configured?: boolean;
    post?: jest.Mock;
    maxUploadFileBytes?: number;
    maxUploadPackageBytes?: number;
  } = {},
): UploaderFixture {
  const client = new HttpLocalBackupCloudClient(
    {
      baseUrl: options.configured === false ? null : 'https://cloud.example.com/api',
      credential: options.configured === false ? null : 'cred-1',
      timeoutMs: 5_000,
      maxUploadFileBytes: options.maxUploadFileBytes ?? 1024 * 1024,
      maxUploadPackageBytes: options.maxUploadPackageBytes ?? 8 * 1024 * 1024,
    },
    { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as never,
  );
  const post = options.post ?? jest.fn();
  (client as unknown as { http: HttpStub }).http = { post };
  return { uploader: new HttpLocalBackupUploader(client), post };
}

/** 云端成功回包 */
function cloudOk(receipt: string = COMPLETE_RECEIPT): jest.Mock {
  return jest.fn().mockResolvedValue({
    status: 200,
    data: { cloudReference: 'cloud://pkg-1', receipt },
  });
}

/** 读取 multipart 里某个部件的字节 */
async function readPartBytes(form: FormData, name: string): Promise<Uint8Array | null> {
  const part = form.get(name);
  if (part === null) {
    return null;
  }
  return new Uint8Array(await (part as Blob).arrayBuffer());
}

/** 断言上传失败且原因码符合预期（同时把联合类型收窄到失败分支） */
function expectFailed(result: LocalBackupUploadResult, reason: string): void {
  expect(result.status).toBe('FAILED');
  if (result.status !== 'FAILED') {
    throw new Error('预期上传失败，但结果为成功');
  }
  expect(result.reason).toBe(reason);
  expect(result.code).toBe(reason);
}

describe('云备份上传端', () => {
  it('未配置云服务 ⇒ 失败关闭（不伪造成功、不发请求）', async () => {
    const { uploader, post } = buildUploader({ configured: false });

    const result = await uploader.upload({
      backupId: 'pkg-1',
      organizationId: 4,
      installationId: 'inst-1',
      packagePath: '/nonexistent',
      manifestChecksum: 'a'.repeat(64),
      byteSize: 10,
    });

    expect(result).toEqual({
      status: 'FAILED',
      reason: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_NOT_CONFIGURED,
      code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_NOT_CONFIGURED,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('上传成功：multipart 里有清单／载荷／原件三个部件，字节逐件一致', async () => {
    const fixture = await createPackage([
      { name: 'a.txt', bytes: Buffer.from('原件字节', 'utf8') },
    ]);
    const { uploader, post } = buildUploader({ post: cloudOk() });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 100,
      });

      expect(result.status).toBe('SUCCEEDED');
      expect(result).toMatchObject({ cloudReference: 'cloud://pkg-1', receipt: COMPLETE_RECEIPT });

      const [, form] = post.mock.calls[0] as [string, FormData, unknown];
      const manifest = await readPartBytes(form, 'manifest');
      const payload = await readPartBytes(form, 'payload');
      const original = await readPartBytes(form, 'files/a.txt');
      expect(manifest).not.toBeNull();
      expect(Buffer.from(payload as Uint8Array).toString('utf8')).toBe('payload-bytes');
      expect(Buffer.from(original as Uint8Array).toString('utf8')).toBe('原件字节');
      // 字段也在表单里
      expect(form.get('backupId')).toBe('pkg-1');
      expect(form.get('organizationId')).toBe('4');
    } finally {
      await fixture.cleanup();
    }
  });

  it('D5：清单登记了原件但包内读不到 ⇒ 失败关闭（不得"零原件但上传成功"）', async () => {
    const fixture = await createPackage([
      { name: 'a.txt', bytes: Buffer.from('原件字节', 'utf8') },
    ]);
    // 删掉原件文件，但清单仍然登记着它
    await rm(nodePath.join(fixture.root, 'files', 'a.txt'), { force: true });
    const { uploader, post } = buildUploader({ post: cloudOk() });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 100,
      });

      expect(result).toEqual({
        status: 'FAILED',
        reason: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE,
      });
      expect(post).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('D5：原件字节与清单摘要不符 ⇒ 失败关闭（不把串件发上云）', async () => {
    const fixture = await createPackage([
      { name: 'a.txt', bytes: Buffer.from('原件字节', 'utf8') },
    ]);
    await writeFile(nodePath.join(fixture.root, 'files', 'a.txt'), '被改过的字节', 'utf8');
    const { uploader, post } = buildUploader({ post: cloudOk() });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 100,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('D9：本机包不可读 ⇒ 报本机侧原因码（不是"云端不可达"）', async () => {
    const { uploader, post } = buildUploader({ post: cloudOk() });

    const result = await uploader.upload({
      backupId: 'pkg-1',
      organizationId: 4,
      installationId: 'inst-1',
      packagePath: '/nonexistent/package',
      manifestChecksum: 'a'.repeat(64),
      byteSize: 10,
    });

    expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
    if (result.status !== 'FAILED') {
      throw new Error('预期上传失败，但结果为成功');
    }
    expect(result.reason).not.toBe(CLOUD_UPLOAD_FAILURE_CODES.CLOUD_UNREACHABLE);
    expect(post).not.toHaveBeenCalled();
  });

  it('D3：超出大小上限 ⇒ 在读字节之前失败（请求根本没发出去）', async () => {
    const fixture = await createPackage([{ name: 'a.txt', bytes: Buffer.alloc(2048, 1) }]);
    const { uploader, post } = buildUploader({
      post: cloudOk(),
      maxUploadFileBytes: 1024,
      maxUploadPackageBytes: 4096,
    });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 2048,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('D3：整包总量超限 ⇒ 失败关闭（单件都合法也不放行）', async () => {
    const fixture = await createPackage([
      { name: 'a.txt', bytes: Buffer.alloc(1024, 1) },
      { name: 'b.txt', bytes: Buffer.alloc(1024, 2) },
    ]);
    const { uploader, post } = buildUploader({
      post: cloudOk(),
      maxUploadFileBytes: 4096,
      maxUploadPackageBytes: 1500,
    });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 2048,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('D7：回执不完整（非 JSON）⇒ 不算上传成功（与清理授权同口径）', async () => {
    const fixture = await createPackage();
    const { uploader } = buildUploader({ post: cloudOk('ok') });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 10,
      });

      expect(result).toEqual({
        status: 'FAILED',
        reason: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_INVALID_RESPONSE,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_INVALID_RESPONSE,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('D7：回执带失败语义 ⇒ 不算上传成功', async () => {
    const fixture = await createPackage();
    const { uploader } = buildUploader({
      post: cloudOk(JSON.stringify({ received: false, error: 'checksum mismatch' })),
    });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 10,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_INVALID_RESPONSE);
    } finally {
      await fixture.cleanup();
    }
  });

  it('云端 5xx ⇒ 受控"服务端异常"（云端侧失败，不是本机侧）', async () => {
    const fixture = await createPackage();
    const { uploader } = buildUploader({
      post: jest.fn().mockResolvedValue({ status: 500, data: null }),
    });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 10,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_SERVER_ERROR);
    } finally {
      await fixture.cleanup();
    }
  });

  it('清单摘要与资产行登记值不符 ⇒ 不上传（本机包被换过／被改过）', async () => {
    const fixture = await createPackage();
    const { uploader, post } = buildUploader({ post: cloudOk() });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: 'b'.repeat(64),
        byteSize: 10,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('符号链接：不跟随、不上传（不会把包外文件读上云）', async () => {
    const fixture = await createPackage([
      { name: 'a.txt', bytes: Buffer.from('原件字节', 'utf8') },
    ]);
    // 用符号链接替换原件文件
    const outside = nodePath.join(fixture.root, 'outside.txt');
    await writeFile(outside, '包外秘密', 'utf8');
    await rm(nodePath.join(fixture.root, 'files', 'a.txt'), { force: true });
    await symlink(outside, nodePath.join(fixture.root, 'files', 'a.txt'));
    const { uploader, post } = buildUploader({ post: cloudOk() });
    try {
      const result = await uploader.upload({
        backupId: 'pkg-1',
        organizationId: 4,
        installationId: 'inst-1',
        packagePath: fixture.root,
        manifestChecksum: fixture.manifestChecksum,
        byteSize: 100,
      });

      expectFailed(result, CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE);
      expect(post).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});
