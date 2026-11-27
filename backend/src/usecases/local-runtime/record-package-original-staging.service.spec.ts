// src/usecases/local-runtime/record-package-original-staging.service.spec.ts
/// <reference types="jest" />

/**
 * 包内原件暂存的定向测试（S3 补丁 P3）。
 *
 * 守住三条：路径只在包根内解析、必须是**普通文件**（软链接拒绝）、
 * 字节数与 SHA-256 必须与清单一致；通过的字节登记为任务 11 的临时文件。
 *
 * 测试只在本机临时目录内造文件，不触碰任何真实数据目录。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { RecordPackageOriginalStagingService } from './record-package-original-staging.service';

describe('包内原件暂存（S3 补丁 P3）', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(nodePath.join(tmpdir(), 'record-package-'));
    mkdirSync(nodePath.join(root, 'files'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function buildService() {
    const save = jest.fn((_content: Buffer, extension: string) =>
      Promise.resolve(`storage-ref${extension}`),
    );
    const insertStagedFile = jest.fn((_data?: unknown) => Promise.resolve(undefined));
    const service = new RecordPackageOriginalStagingService(
      { save } as never,
      { insertStagedFile } as never,
    );
    return { service, save, insertStagedFile };
  }

  it('正常路径：复核字节与摘要后登记临时文件', async () => {
    const content = Buffer.from('hello package');
    writeFileSync(nodePath.join(root, 'files', 'a.pdf'), content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { service, save, insertStagedFile } = buildService();

    const staged = await service.stage({
      packagePath: root,
      files: [{ relative_path: 'files/a.pdf', sha256, byte_size: content.length }],
      businessType: 'MAINTENANCE_REPORT',
      uploadedByAccountId: 900101,
      ownerOrganizationId: 9,
    });

    expect(staged).toHaveLength(1);
    expect(staged[0].checksumSha256).toBe(sha256);
    // 回归：扩展名必须**不带点**传给存储层
    // （存储层 `FILE_EXTENSION_PATTERN` 只接受 `^[a-z0-9]{1,8}$`；
    //  带点会让任何带原件的记录包在暂存阶段失败关闭——跨安装真实验证时发现）
    expect(save).toHaveBeenCalledWith(content, 'pdf');
    expect(staged[0].byteSize).toBe(content.length);
    expect(save).toHaveBeenCalledTimes(1);
    expect(insertStagedFile).toHaveBeenCalledTimes(1);
    const stagedRow = insertStagedFile.mock.calls[0][0] as {
      businessType: string;
      bindingStatus?: string;
      uploadedByAccountId: number;
      ownerOrganizationId: number;
      fileId: string;
      uploadContextId: string;
    };
    expect(stagedRow.businessType).toBe('MAINTENANCE_REPORT');
    expect(stagedRow.uploadedByAccountId).toBe(900101);
    expect(stagedRow.ownerOrganizationId).toBe(9);
    expect(stagedRow.fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stagedRow.uploadContextId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('软链接（非普通文件）拒绝：防止以链接方式逃出包根', async () => {
    const target = nodePath.join(root, 'files', 'real.pdf');
    writeFileSync(target, Buffer.from('x'));
    symlinkSync(target, nodePath.join(root, 'files', 'link.pdf'));
    const { service, insertStagedFile } = buildService();

    await expect(
      service.stage({
        packagePath: root,
        files: [
          {
            relative_path: 'files/link.pdf',
            sha256: createHash('sha256').update('x').digest('hex'),
            byte_size: 1,
          },
        ],
        businessType: 'MAINTENANCE_REPORT',
        uploadedByAccountId: 900101,
        ownerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: 'RECORD_PACKAGE_FILE_MISSING' });
    expect(insertStagedFile).not.toHaveBeenCalled();
  });

  it('字节数与清单不符：拒绝，不落盘不登记', async () => {
    writeFileSync(nodePath.join(root, 'files', 'a.pdf'), Buffer.from('12345'));
    const { service, save, insertStagedFile } = buildService();

    await expect(
      service.stage({
        packagePath: root,
        files: [
          {
            relative_path: 'files/a.pdf',
            sha256: createHash('sha256').update('12345').digest('hex'),
            byte_size: 999,
          },
        ],
        businessType: 'MAINTENANCE_REPORT',
        uploadedByAccountId: 900101,
        ownerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: 'RECORD_PACKAGE_FILE_CHECKSUM_MISMATCH' });
    expect(save).not.toHaveBeenCalled();
    expect(insertStagedFile).not.toHaveBeenCalled();
  });

  it('摘要与清单不符：拒绝，不落盘不登记', async () => {
    writeFileSync(nodePath.join(root, 'files', 'a.pdf'), Buffer.from('12345'));
    const { service, save, insertStagedFile } = buildService();

    await expect(
      service.stage({
        packagePath: root,
        files: [{ relative_path: 'files/a.pdf', sha256: 'f'.repeat(64), byte_size: 5 }],
        businessType: 'MAINTENANCE_REPORT',
        uploadedByAccountId: 900101,
        ownerOrganizationId: 9,
      }),
    ).rejects.toMatchObject({ code: 'RECORD_PACKAGE_FILE_CHECKSUM_MISMATCH' });
    expect(save).not.toHaveBeenCalled();
    expect(insertStagedFile).not.toHaveBeenCalled();
  });

  it('路径逃逸（../）在解析阶段即被拒', async () => {
    const outside = nodePath.join(tmpdir(), `outside-${randomUUID()}.pdf`);
    writeFileSync(outside, Buffer.from('secret'));
    const { service } = buildService();

    await expect(
      service.stage({
        packagePath: root,
        files: [
          {
            relative_path: '../outside.pdf',
            sha256: createHash('sha256').update('secret').digest('hex'),
            byte_size: 6,
          },
        ],
        businessType: 'MAINTENANCE_REPORT',
        uploadedByAccountId: 900101,
        ownerOrganizationId: 9,
      }),
    ).rejects.toThrow();
    rmSync(outside, { force: true });
  });
});
