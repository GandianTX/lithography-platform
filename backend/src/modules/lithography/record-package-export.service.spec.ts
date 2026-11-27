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
import { deriveRecordUuid } from '@core/local-runtime/policy/record-package-export.policy';
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
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where?: { ownerOrganizationId?: number } }) => {
          if (value === null || value === undefined) {
            return Promise.resolve(null);
          }
          const row = value as Record<string, unknown>;
          // 与真实仓储一致：按公司过滤，越权记录读不到
          if (
            where?.ownerOrganizationId !== undefined &&
            row.ownerOrganizationId !== where.ownerOrganizationId
          ) {
            return Promise.resolve(null);
          }
          return Promise.resolve(row);
        }),
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
      {
        findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-4' }),
      } as never,
      { findModelById: () => Promise.resolve(null) } as never,
    );
  };

  const command = (overrides: Partial<RecordPackageExportCommand> = {}) => ({
    organizationId: 4,
    targetPath: nodePath.join(targetRoot, 'pkg-1'),
    resourceType: 'REFERENCE_DOCUMENT' as const,
    recordIds: [1],
    exporterAccountId: 16,
    exporterScope: { role: 'ADMIN_LEVEL_2' as const, organizationId: 4, adminLevel: 2 as const },
    resolveSourceIdentity: () =>
      Promise.resolve({ accountUuid: null, loginName: null, name: null }),
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
    const result = await service.exportPackage(command());

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

  it('混合导出：一次导出可跨资源类型（逐条各自授权、逐条各自入清单）', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        ownerOrganizationId: 4,
        currentRevisionNo: 1,
        title: '资料一',
        description: '资料描述',
        storageBackend: 'local',
        storageReference: 'refs/aaa.doc.txt',
        checksumSha256: fileSha,
        byteSize: fileContent.length,
      },
      repairRequest: {
        id: 9,
        ownerOrganizationId: 4,
        currentRevisionNo: 1,
        requestNo: 'REQ-9',
        title: '工单一',
        faultDescription: '故障描述',
        contentMd: '工单正文',
        maintenanceAttachmentFileId: null,
        deprecated: false,
      },
    });

    const result = await service.exportPackage(
      command({
        targetPath: nodePath.join(targetRoot, 'pkg-mixed'),
        entries: [
          { resourceType: 'REFERENCE_DOCUMENT', recordId: 1 },
          { resourceType: 'REPAIR_REQUEST', recordId: 9 },
        ],
      }),
    );

    expect(result.itemExported).toBe(2);
    expect(result.itemFailed).toBe(0);
    // 逐条结论各自带自己的资源类型
    expect(result.items.map((item) => item.resourceType).sort()).toEqual([
      'REFERENCE_DOCUMENT',
      'REPAIR_REQUEST',
    ]);
    // 清单里两条记录的 resource_type 各自独立（导入侧本就按条目类型逐条处理）
    const manifestRaw = readFileSync(nodePath.join(result.packagePath, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      items: { resource_type: string; record_uuid: string }[];
    };
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items.map((item) => item.resource_type).sort()).toEqual([
      'REFERENCE_DOCUMENT',
      'REPAIR_REQUEST',
    ]);
    expect(new Set(manifest.items.map((item) => item.record_uuid)).size).toBe(2);
  });

  it('混合导出：旧接口形态不受影响（单一类型 ＋ 记录 id 列表）', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        ownerOrganizationId: 4,
        currentRevisionNo: 1,
        title: '资料一',
        description: '资料描述',
        storageBackend: 'local',
        storageReference: 'refs/aaa.doc.txt',
        checksumSha256: fileSha,
        byteSize: fileContent.length,
      },
    });

    const result = await service.exportPackage(command());

    expect(result.itemExported).toBe(1);
    expect(result.items[0]?.resourceType).toBe('REFERENCE_DOCUMENT');
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
    );
    const second = await buildService({ referenceDocument: row }).exportPackage(
      command({ targetPath: nodePath.join(targetRoot, 'pkg-b') }),
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
      {
        findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-4' }),
      } as never,
      { findModelById: () => Promise.resolve(null) } as never,
    );
    const result = await service.exportPackage(command({ recordIds: [1, 2] }));

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

  it('条目身份优先取源表持久化的稳定编号，历史行回退派生值', async () => {
    const buildWithRow = (recordUuid: string | null) => {
      const rows = new Map<number, Record<string, unknown>>([
        [
          2,
          {
            id: 2,
            recordUuid,
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
      return new RecordPackageExportService(
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
        {
          findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-4' }),
        } as never,
        { findModelById: () => Promise.resolve(null) } as never,
      );
    };

    const persistedUuid = '11111111-2222-4333-8444-555555555555';
    const persisted = await buildWithRow(persistedUuid).exportPackage(
      command({ recordIds: [2], targetPath: nodePath.join(targetRoot, 'pkg-persisted') }),
    );
    const persistedManifest = JSON.parse(
      readFileSync(nodePath.join(persisted.packagePath, 'manifest.json'), 'utf8'),
    );
    expect(persistedManifest.items[0].record_uuid).toBe(persistedUuid);

    const legacy = await buildWithRow(null).exportPackage(
      command({ recordIds: [2], targetPath: nodePath.join(targetRoot, 'pkg-legacy') }),
    );
    const legacyManifest = JSON.parse(
      readFileSync(nodePath.join(legacy.packagePath, 'manifest.json'), 'utf8'),
    );
    expect(legacyManifest.items[0].record_uuid).toBe(deriveRecordUuid('REFERENCE_DOCUMENT', 2));
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
    const error = await catchExportError(service.exportPackage(command({ recordIds: [1] })));
    const details = error.details as { items?: { rejection: string | null }[] };
    expect(details.items?.[0]?.rejection).toBe('STRUCTURE_INVALID');
    expect(existsSync(command().targetPath)).toBe(false);
  });

  it('错公司数据区拒绝（FOREIGN_COMPANY，逐条原因可追踪）', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        recordUuid: '22222222-3333-4444-8555-666666666666',
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
    const error = await catchExportError(service.exportPackage(command()));
    const details = error.details as { items?: { rejection: string | null; recordUuid: string }[] };
    expect(details.items?.[0]?.rejection).toBe('FOREIGN_COMPANY');
    // 越权记录的真实持久化身份不得出现在拒绝明细里（否则构成存在性泄露）
    expect(details.items?.[0]?.recordUuid).toBe(deriveRecordUuid('REFERENCE_DOCUMENT', 1));
  });

  it('工程师导出同公司他人记录：逐条拒绝（NOT_AUTHORIZED），不读正文不复制原件', async () => {
    const service = buildService({
      referenceDocument: {
        id: 1,
        recordUuid: '44444444-5555-4666-8777-888888888888',
        ownerOrganizationId: 4,
        // 作者是**他人**（不是导出人 16）
        createdByAccountId: 99,
        deprecated: false,
        currentRevisionNo: 2,
        schemaVersion: 1,
        title: '他人资料',
        documentType: 'MANUAL',
        description: null,
        contentText: '他人正文',
        originalFilename: null,
        mimeType: null,
        extensionJson: null,
        updatedAt: new Date(),
        storageBackend: null,
        storageReference: null,
      },
    });

    const error = await catchExportError(
      service.exportPackage(
        command({
          exporterAccountId: 16,
          exporterScope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
        }),
      ),
    );
    const details = error.details as { items?: { rejection: string | null; message: string }[] };
    expect(details.items?.[0]?.rejection).toBe('NOT_AUTHORIZED');
    expect(details.items?.[0]?.message).toContain('本人创建');
    // 整包不产生（目标目录不留残留）
    expect(existsSync(command().targetPath)).toBe(false);
  });

  it('本公司记录被拒绝时，拒绝明细带出其真实持久化身份（与导出条目口径一致）', async () => {
    const persistedUuid = '33333333-4444-4555-8666-777777777777';
    const service = buildService({
      referenceDocument: {
        id: 1,
        recordUuid: persistedUuid,
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
    });
    const error = await catchExportError(service.exportPackage(command()));
    const details = error.details as { items?: { rejection: string | null; recordUuid: string }[] };
    expect(details.items?.[0]?.rejection).toBe('STRUCTURE_INVALID');
    expect(details.items?.[0]?.recordUuid).toBe(persistedUuid);
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
      service.exportPackage(command({ resourceType: 'REPAIR_REQUEST' })),
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
    await expect(service.exportPackage(command({ targetPath: occupied }))).rejects.toThrow(
      '导出目标目录已存在且非空，拒绝覆盖',
    );
  });

  it('混合导出：逐类授权在同一包内逐条生效（工程师：本公司工单放行、他人资料拒绝）', async () => {
    // 资料：同公司，但**作者是他人**（工程师对资料/报告要求"作者本人"）
    const referenceRows = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          id: 1,
          ownerOrganizationId: 4,
          createdByAccountId: 99,
          deprecated: false,
          currentRevisionNo: 2,
          schemaVersion: 1,
          title: '他人资料',
          documentType: 'MANUAL',
          description: null,
          contentText: '他人正文',
          originalFilename: null,
          mimeType: null,
          extensionJson: null,
          updatedAt: new Date('2026-11-19T00:00:00.000Z'),
          storageBackend: null,
          storageReference: null,
        },
      ],
    ]);
    // 工单：同公司但受理人/客户都不是导出人（工程师对工单按**公司范围**放行）
    const repairRows = new Map<number, Record<string, unknown>>([
      [
        9,
        {
          id: 9,
          ownerOrganizationId: 4,
          customerAccountId: 77,
          acceptedByEngineerAccountId: 88,
          deprecated: false,
          currentRevisionNo: 1,
          requestNo: 'REQ-9',
          title: '工单一',
          faultDescription: '故障描述',
          contentMd: '工单正文',
          maintenanceVersionNo: 0,
          handlingResult: null,
          handlingStatus: 'IN_PROGRESS',
          createdAt: new Date('2026-11-19T00:00:00.000Z'),
          maintenanceAttachmentFileId: null,
        },
      ],
    ]);
    const byId = (rows: Map<number, Record<string, unknown>>) => ({
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: number } }) =>
          Promise.resolve(rows.get(where.id) ?? null),
        ),
    });
    const service = new RecordPackageExportService(
      byId(referenceRows) as never,
      byId(repairRows) as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {
        open: () =>
          Promise.resolve(createReadStream(nodePath.join(storageRoot, 'refs/aaa.doc.txt'))),
      } as never,
      { readInstallation: () => Promise.resolve({ installationId: 'inst-uuid-1' }) } as never,
      {
        findOrganizationIdentityById: () => Promise.resolve({ organizationCode: 'ORG-4' }),
      } as never,
      { findModelById: () => Promise.resolve(null) } as never,
    );

    const result = await service.exportPackage(
      command({
        targetPath: nodePath.join(targetRoot, 'pkg-mixed-auth'),
        entries: [
          { resourceType: 'REFERENCE_DOCUMENT', recordId: 1 },
          { resourceType: 'REPAIR_REQUEST', recordId: 9 },
        ],
        exporterAccountId: 16,
        exporterScope: { role: 'ENGINEER', organizationId: 4, adminLevel: null },
      }),
    );

    expect(result.itemTotal).toBe(2);
    // 工单按公司范围放行；资料因"非作者本人"被逐条拒绝（单条失败不拖垮整包）
    expect(result.itemExported).toBe(1);
    expect(result.itemFailed).toBe(1);
    expect(result.items[0]?.resourceType).toBe('REFERENCE_DOCUMENT');
    expect(result.items[0]?.outcome).toBe('REJECTED');
    expect(result.items[0]?.rejection).toBe('NOT_AUTHORIZED');
    expect(result.items[0]?.message).toContain('本人创建');
    expect(result.items[1]?.resourceType).toBe('REPAIR_REQUEST');
    expect(result.items[1]?.outcome).toBe('EXPORTED');

    // 只有放行条目进清单
    const manifest = JSON.parse(
      readFileSync(nodePath.join(result.packagePath, 'manifest.json'), 'utf8'),
    ) as { items: { resource_type: string }[] };
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]?.resource_type).toBe('REPAIR_REQUEST');
  });
});
