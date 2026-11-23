// src/modules/lithography/business-sync-source.service.spec.ts

/**
 * 业务同步来源读取服务（任务 09 P1-2 收口）。
 *
 * 守住：
 * - **清单与字节逐项对上**：字节从服务端受控存储实读，摘要与字节数实测；
 * - **同名附件不撞相对路径**：两件同名附件必须走不同路径（否则逐项核对失效）；
 * - **大小有上限**：单件／总量超限即不派发（原件字节要整读进内存）；
 * - **读不到字节就不派发**：宁可失败，也不送"清单说有、字节其实没有"的包。
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  BUSINESS_SYNC_MAX_ORIGINAL_BYTES,
  BUSINESS_SYNC_MAX_TOTAL_ORIGINAL_BYTES,
  BusinessSyncSourceService,
} from './business-sync-source.service';

type StubRow = Record<string, unknown>;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 把内容包装成存储端口的可读流 */
const toStream = (content: Buffer | string): Readable => Readable.from([Buffer.from(content)]);

describe('BusinessSyncSourceService（业务同步来源读取）', () => {
  const documentRow: StubRow = {
    id: 11,
    recordUuid: 'uuid-doc',
    ownerOrganizationId: 4,
    currentRevisionNo: 3,
    schemaVersion: 1,
    title: '资料标题',
    documentType: 'MANUAL',
    description: '资料说明',
    contentText: '资料正文',
    originalFilename: 'manual.pdf',
    mimeType: 'application/pdf',
    extensionJson: null,
    storageBackend: 'LOCAL',
    storageReference: 'a'.repeat(32) + '.pdf',
    deprecated: false,
    deletedAt: null,
    publicationStatus: 'ONLINE',
    ownershipStatus: 'CONFIRMED',
    createdByAccountId: 21,
    updatedByAccountId: null,
  };

  const buildService = (options: {
    document?: StubRow | null;
    reportAttachments?: StubRow[];
    contents?: Record<string, Buffer | string>;
    failingStream?: boolean;
  }) => {
    const contents = options.contents ?? {};
    const referenceDocumentRepository = {
      find: jest.fn(() => Promise.resolve([documentRow])),
      findOne: jest.fn(() =>
        Promise.resolve(options.document === undefined ? documentRow : options.document),
      ),
    };
    const repairRequestRepository = {
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
    };
    const maintenanceReportRepository = {
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
    };
    const reportVersionRepository = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 5,
          reportId: 6,
          versionNo: 1,
          schemaVersion: 2,
          changeKind: 'SUBMIT',
          payloadSnapshot: { title: '报告' },
          submittedAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ),
    };
    const reportAttachmentRepository = {
      find: jest.fn(() => Promise.resolve(options.reportAttachments ?? [])),
    };
    const storedFileRepository = {
      findOne: jest.fn(() => Promise.resolve(null)),
    };
    const fileStorage = {
      open: jest.fn((storageReference: string) => {
        if (options.failingStream === true) {
          const stream = new Readable({
            read() {
              this.destroy(new Error('读取失败'));
            },
          });
          return Promise.resolve(stream);
        }
        const content = contents[storageReference] ?? '默认字节';
        return Promise.resolve(toStream(content));
      }),
    };

    const service = new BusinessSyncSourceService(
      referenceDocumentRepository as never,
      repairRequestRepository as never,
      maintenanceReportRepository as never,
      reportVersionRepository as never,
      reportAttachmentRepository as never,
      storedFileRepository as never,
      fileStorage as never,
    );
    return { service, fileStorage };
  };

  it('资料：正文与原件字节一并读出，摘要与字节数为实测值', async () => {
    const content = Buffer.from('资料原件真实字节', 'utf8');
    const { service } = buildService({
      contents: { [documentRow['storageReference'] as string]: content },
    });

    const payload = await service.readPayload({
      resourceType: 'REFERENCE_DOCUMENT',
      recordId: 11,
      recordUuid: 'uuid-doc',
      versionNo: 3,
    });

    expect(payload.body['title']).toBe('资料标题');
    expect(payload.body['content_text']).toBe('资料正文');
    expect(payload.originals).toHaveLength(1);
    expect(payload.originals[0].byteSize).toBe(content.byteLength);
    expect(payload.originals[0].sha256).toBe(sha256(content));
    // 字节与清单一一对应
    expect(payload.originalPayloads).toHaveLength(1);
    expect(Buffer.from(payload.originalPayloads[0].bytes).equals(content)).toBe(true);
    expect(payload.originalPayloads[0].relativePath).toBe(payload.originals[0].relativePath);
  });

  it('资料：没有存储原件时清单与字节都为空（不臆造原件）', async () => {
    const { service } = buildService({
      document: { ...documentRow, storageBackend: null, storageReference: null },
    });

    const payload = await service.readPayload({
      resourceType: 'REFERENCE_DOCUMENT',
      recordId: 11,
      recordUuid: 'uuid-doc',
      versionNo: 3,
    });

    expect(payload.originals).toHaveLength(0);
    expect(payload.originalPayloads).toHaveLength(0);
  });

  it('原件读取失败：抛错，不送出"清单有、字节没有"的包', async () => {
    const { service } = buildService({ failingStream: true });

    await expect(
      service.readPayload({
        resourceType: 'REFERENCE_DOCUMENT',
        recordId: 11,
        recordUuid: 'uuid-doc',
        versionNo: 3,
      }),
    ).rejects.toThrow();
  });

  it('单件原件超过大小上限：不派发', async () => {
    const oversized = Buffer.alloc(BUSINESS_SYNC_MAX_ORIGINAL_BYTES + 1, 1);
    const { service } = buildService({
      contents: { [documentRow['storageReference'] as string]: oversized },
    });

    await expect(
      service.readPayload({
        resourceType: 'REFERENCE_DOCUMENT',
        recordId: 11,
        recordUuid: 'uuid-doc',
        versionNo: 3,
      }),
    ).rejects.toThrow(/上限/);
  });

  it('同名附件：两件同名附件走不同相对路径（逐项核对才成立）', async () => {
    const first = Buffer.from('第一件', 'utf8');
    const second = Buffer.from('第二件', 'utf8');
    const { service } = buildService({
      reportAttachments: [
        {
          id: 1,
          reportId: 6,
          status: 'CURRENT',
          sortOrder: 1,
          checksumSha256: sha256(first),
          byteSize: first.byteLength,
          originalFilename: 'report.pdf',
          storageReference: 'c'.repeat(32) + '.pdf',
        },
        {
          id: 2,
          reportId: 6,
          status: 'CURRENT',
          sortOrder: 2,
          checksumSha256: sha256(second),
          byteSize: second.byteLength,
          originalFilename: 'report.pdf',
          storageReference: 'd'.repeat(32) + '.pdf',
        },
      ],
      contents: {
        ['c'.repeat(32) + '.pdf']: first,
        ['d'.repeat(32) + '.pdf']: second,
      },
    });

    const payload = await service.readPayload({
      resourceType: 'MAINTENANCE_REPORT',
      recordId: 6,
      recordUuid: 'uuid-report',
      versionNo: 1,
    });

    expect(payload.originals.map((item) => item.relativePath)).toEqual([
      'originals/report.pdf',
      'originals/report-2.pdf',
    ]);
    expect(new Set(payload.originals.map((item) => item.relativePath)).size).toBe(2);
    expect(Buffer.from(payload.originalPayloads[0].bytes).equals(first)).toBe(true);
    expect(Buffer.from(payload.originalPayloads[1].bytes).equals(second)).toBe(true);
  });

  it('原件总量超过上限：不派发', async () => {
    const half = Math.floor(BUSINESS_SYNC_MAX_TOTAL_ORIGINAL_BYTES / 2) + 1024;
    const first = Buffer.alloc(half, 1);
    const second = Buffer.alloc(half, 2);
    const { service } = buildService({
      reportAttachments: [
        {
          id: 1,
          reportId: 6,
          status: 'CURRENT',
          sortOrder: 1,
          checksumSha256: sha256(first),
          byteSize: first.byteLength,
          originalFilename: 'a.bin',
          storageReference: 'e'.repeat(32) + '.bin',
        },
        {
          id: 2,
          reportId: 6,
          status: 'CURRENT',
          sortOrder: 2,
          checksumSha256: sha256(second),
          byteSize: second.byteLength,
          originalFilename: 'b.bin',
          storageReference: 'f'.repeat(32) + '.bin',
        },
      ],
      contents: {
        ['e'.repeat(32) + '.bin']: first,
        ['f'.repeat(32) + '.bin']: second,
      },
    });

    await expect(
      service.readPayload({
        resourceType: 'MAINTENANCE_REPORT',
        recordId: 6,
        recordUuid: 'uuid-report',
        versionNo: 1,
      }),
    ).rejects.toThrow(/上限/);
  });
});
