// src/modules/lithography/record-package-export.service.spec.ts

import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  createReadStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';

import { RecordPackageExportService } from './record-package-export.service';
import type { RecordPackageExportCommand } from './record-package-export.types';
import { DomainError } from '@core/common/errors/domain-error';

/** 断言导出失败并返回 DomainError（避免 union 类型干扰逐条结论断言） */
async function catchExportError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected export to fail, but it resolved');
}

describe('record package export service', () => {
  const storageRoot = nodePath.join(__dirname, '.tmp-export-storage');
  const targetRoot = nodePath.join(__dirname, '.tmp-export-target');

  const fileContent = 'ORIGINAL-CONTENT-A';
  const fileSha = createHash('sha256').update(fileContent).digest('hex');

  const buildService = (overrides: {
    referenceDocument?: Record<string, unknown> | null;
    repairRequest?: Record<string, unknown> | null;
    storedFile?: Record<string, unknown> | null;
  }) => {
    const oneOf = (value: unknown) => ({
      findOne: jest.fn().mockResolvedValue(value ?? null),
      find: jest.fn().mockResolvedValue([]),
    });
    const fileStorage = {
      open: (reference: string) =>
        Promise.resolve(createReadStream(nodePath.join(storageRoot, reference))),
    };
    return new RecordPackageExportService(
      oneOf(overrides.referenceDocument) as never,
      oneOf(overrides.repairRequest) as never,
      oneOf({ id: 1, ownerOrganizationId: 4, currentVersionNo: 0 }) as never,
      oneOf(null) as never,
      oneOf([]) as never,
      oneOf(overrides.storedFile) as never,
      fileStorage as never,
      { readInstallation: () => Promise.resolve({ installationId: 'inst-uuid-1' }) } as never,
    );
  };

  const command = (overrides: Partial<RecordPackageExportCommand> = {}) => ({
    organizationId: 4,
    targetPath: nodePath.join(targetRoot, 'pkg-1'),
    resourceType: 'REFERENCE_DOCUMENT' as const,
    recordIds: [1],
    ...overrides,
  });

  beforeAll(() => {
    mkdirSync(nodePath.join(storageRoot, 'refs'), { recursive: true });
    writeFileSync(nodePath.join(storageRoot, 'refs/aaa.doc.txt'), fileContent);
  });

  beforeEach(() => {
    rmSync(targetRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  });

  it('合格资料导出：清单自校验通过、文件复制与 SHA-256 实测回填', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        ownerOrganizationId: 4,
        deprecated: false,
        currentRevisionNo: 2,
        schemaVersion: 1,
        title: '资料A',
        documentType: 'MANUAL',
        description: null,
        contentText: '正文',
        originalFilename: 'aaa.doc.txt',
        mimeType: 'text/plain',
        extensionJson: null,
        updatedAt: new Date('2026-11-19T00:00:00.000Z'),
        storageBackend: 'LOCAL',
        storageReference: 'refs/aaa.doc.txt',
      },
    });
    const result = await service.exportPackage(command(), 16);

    expect(result.itemExported).toBe(1);
    expect(result.itemFailed).toBe(0);
    expect(result.manifestChecksum).toHaveLength(64);

    const manifest = JSON.parse(
      readFileSync(nodePath.join(result.packagePath, 'manifest.json'), 'utf8'),
    );
    expect(manifest.package_id).toBe(result.packageId);
    expect(manifest.organization_id).toBe(4);
    expect(manifest.installation_id).toBe('inst-uuid-1');
    const file = manifest.items[0].files[0];
    expect(file.sha256).toBe(fileSha);
    expect(file.byte_size).toBe(fileContent.length);
    expect(existsSync(nodePath.join(result.packagePath, file.relative_path))).toBe(true);
    const copied = readFileSync(nodePath.join(result.packagePath, file.relative_path), 'utf8');
    expect(copied).toBe(fileContent);
  });

  it('条目身份确定性：同记录两次导出的 record_uuid 一致、package_id 不同', async () => {
    const row = {
      id: 1,
      ownerOrganizationId: 4,
      deprecated: false,
      currentRevisionNo: 2,
      schemaVersion: 1,
      title: '资料A',
      documentType: 'MANUAL',
      description: null,
      contentText: null,
      originalFilename: null,
      mimeType: null,
      extensionJson: null,
      updatedAt: new Date(),
      storageBackend: null,
      storageReference: null,
    };
    const first = await buildService({ referenceDocument: row }).exportPackage(
      command({ targetPath: nodePath.join(targetRoot, 'pkg-a') }),
      16,
    );
    const second = await buildService({ referenceDocument: row }).exportPackage(
      command({ targetPath: nodePath.join(targetRoot, 'pkg-b') }),
      16,
    );
    const manifestA = JSON.parse(
      readFileSync(nodePath.join(first.packagePath, 'manifest.json'), 'utf8'),
    );
    const manifestB = JSON.parse(
      readFileSync(nodePath.join(second.packagePath, 'manifest.json'), 'utf8'),
    );
    expect(manifestA.items[0].record_uuid).toBe(manifestB.items[0].record_uuid);
    expect(manifestA.package_id).not.toBe(manifestB.package_id);
  });

  it('部分拒绝：版本未生效条目拒绝，正常条目照常导出', async () => {
    const rows = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          id: 1,
          ownerOrganizationId: 4,
          deprecated: false,
          currentRevisionNo: 0, // 版本未生效 → 拒绝
          schemaVersion: 1,
          title: '资料B',
          documentType: 'MANUAL',
          description: null,
          contentText: null,
          originalFilename: null,
          mimeType: null,
          extensionJson: null,
          updatedAt: new Date(),
          storageBackend: null,
          storageReference: null,
        },
      ],
      [
        2,
        {
          id: 2,
          ownerOrganizationId: 4,
          deprecated: false,
          currentRevisionNo: 3,
          schemaVersion: 1,
          title: '资料B2',
          documentType: 'MANUAL',
          description: null,
          contentText: '正文B2',
          originalFilename: null,
          mimeType: null,
          extensionJson: null,
          updatedAt: new Date(),
          storageBackend: null,
          storageReference: null,
        },
      ],
    ]);
    const repo = {
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: number } }) =>
          Promise.resolve(rows.get(where.id) ?? null),
        ),
    };
    const service = new RecordPackageExportService(
      repo as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {
        open: () =>
          Promise.resolve(createReadStream(nodePath.join(storageRoot, 'refs/aaa.doc.txt'))),
      } as never,
      { readInstallation: () => Promise.resolve({ installationId: 'inst-uuid-1' }) } as never,
    );
    const result = await service.exportPackage(command({ recordIds: [1, 2] }), 16);

    expect(result.itemTotal).toBe(2);
    expect(result.itemExported).toBe(1);
    expect(result.itemFailed).toBe(1);
    expect(result.items[0].outcome).toBe('REJECTED');
    expect(result.items[0].rejection).toBe('STRUCTURE_INVALID');
    expect(result.items[1].outcome).toBe('EXPORTED');
    expect(result.items[1].versionNo).toBe(3);

    const manifest = JSON.parse(
      readFileSync(nodePath.join(result.packagePath, 'manifest.json'), 'utf8'),
    );
    expect(manifest.items).toHaveLength(1); // 拒绝条目不进清单
    expect(manifest.items[0].content_snapshot.title).toBe('资料B2');
  });

  it('全部拒绝：整包不产生，逐条拒绝原因随错误扩展返回', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        ownerOrganizationId: 4,
        deprecated: false,
        currentRevisionNo: 0,
        schemaVersion: 1,
        title: '资料B',
        documentType: 'MANUAL',
        description: null,
        contentText: null,
        originalFilename: null,
        mimeType: null,
        extensionJson: null,
        updatedAt: new Date(),
        storageBackend: null,
        storageReference: null,
      },
    });
    const error = await catchExportError(service.exportPackage(command({ recordIds: [1] }), 16));
    const details = error.details as { items?: { rejection: string | null }[] };
    expect(details.items?.[0]?.rejection).toBe('STRUCTURE_INVALID');
    expect(existsSync(command().targetPath)).toBe(false);
  });

  it('错公司数据区拒绝（FOREIGN_COMPANY，逐条原因可追踪）', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        ownerOrganizationId: 5,
        deprecated: false,
        currentRevisionNo: 2,
        schemaVersion: 1,
        title: '资料C',
        documentType: 'MANUAL',
        description: null,
        contentText: null,
        originalFilename: null,
        mimeType: null,
        extensionJson: null,
        updatedAt: new Date(),
        storageBackend: null,
        storageReference: null,
      },
    });
    const error = await catchExportError(service.exportPackage(command(), 16));
    const details = error.details as { items?: { rejection: string | null }[] };
    expect(details.items?.[0]?.rejection).toBe('FOREIGN_COMPANY');
  });

  it('附件字节数与登记不符 → 条目拒绝（不落清单）', async () => {
    const service = buildService({
      repairRequest: {
        id: 1,
        ownerOrganizationId: 4,
        deprecated: false,
        currentRevisionNo: 1,
        requestNo: 'RR-1',
        faultDescription: '故障',
        contentMd: '# 正文',
        maintenanceVersionNo: 0,
        handlingResult: null,
        handlingStatus: null,
        createdAt: new Date(),
        maintenanceAttachmentFileId: 'file-1',
      },
      storedFile: {
        fileId: 'file-1',
        ownerOrganizationId: 4,
        storageReference: 'refs/aaa.doc.txt',
        originalFilename: 'aaa.doc.txt',
        checksumSha256: fileSha,
        byteSize: String(fileContent.length + 10), // 登记值与实际不符
      },
    });
    const error = await catchExportError(
      service.exportPackage(command({ resourceType: 'REPAIR_REQUEST' }), 16),
    );
    const details = error.details as { items?: { rejection: string | null }[] };
    expect(details.items?.[0]?.rejection).toBe('FILE_CHECKSUM_MISMATCH');
    expect(existsSync(command({ resourceType: 'REPAIR_REQUEST' }).targetPath)).toBe(false);
  });

  it('目标目录已存在且非空 → 拒绝覆盖', async () => {
    const occupied = nodePath.join(targetRoot, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(nodePath.join(occupied, 'something.txt'), 'x');
    const service = buildService({});
    await expect(service.exportPackage(command({ targetPath: occupied }), 16)).rejects.toThrow(
      '导出目标目录已存在且非空，拒绝覆盖',
    );
  });
});
