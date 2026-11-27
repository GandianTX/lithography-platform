// src/usecases/stored-file/upload-stored-file.usecase.spec.ts

/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { createHash } from 'node:crypto';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  DomainError,
  PERMISSION_ERROR,
  REPAIR_REQUEST_ERROR,
  STORED_FILE_ERROR,
  SYNC_ERROR,
} from '@core/common/errors/domain-error';
import { Logger } from '@nestjs/common';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { StoredFileService } from '@src/modules/lithography/stored-file.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import {
  buildCfbDifatChainTailFixture,
  buildCfbDirectoryChainTailFixture,
  makeMinimalPdf,
  minimalJpeg,
  minimalPng,
  officeSamples,
} from '../../../test/fixtures/stored-file-samples';
import { STORED_FILE_UPLOAD_MAX_BYTES } from './stored-file-upload.contract';
import { UploadStoredFileUsecase } from './upload-stored-file.usecase';

const transactionContext = { transaction: 'mock' };
const organizationId = 910001;

const session = (roles: string[], activeRole?: string, accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole }) as UsecaseSession;

const engineer = session(['ENGINEER'], 'ENGINEER');
const customer = session(['CUSTOMER'], 'CUSTOMER');
const engineerWithoutActiveRole = session(['ENGINEER'], undefined);

/** 合法 PDF 内容（结构完整，实际内容判定为 application/pdf） */
const pdfBytes = makeMinimalPdf();

/** 仅把 OLE 链尾改为 FREE 后继的两种非法样本（目录链 / DIFAT 链） */
const illegalOleChainTailCases: Array<[string, Buffer, string]> = [
  [
    '目录链尾 FREE',
    buildCfbDirectoryChainTailFixture(officeSamples.doc, 0xffffffff).buffer,
    'directory-free.doc',
  ],
  [
    'DIFAT 链尾 FREE',
    buildCfbDifatChainTailFixture(officeSamples.xls, 0xffffffff).buffer,
    'difat-free.xls',
  ],
];

const makeStoredFileService = () => ({
  insertStagedFile: jest.fn().mockImplementation((data: Record<string, unknown>) => ({
    fileId: data.fileId,
    uploadedByAccountId: data.uploadedByAccountId,
    ownerOrganizationId: data.ownerOrganizationId,
    storageReference: data.storageReference,
    originalFilename: data.originalFilename,
    mimeType: data.mimeType,
    byteSize: data.byteSize,
    checksumSha256: data.checksumSha256,
    status: 'VALID',
    businessType: data.businessType,
    businessId: null,
    uploadContextId: data.uploadContextId,
    bindingStatus: 'TEMPORARY',
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  })),
});

const makeQueryService = () => ({
  isStorageReferenceReferenced: jest.fn().mockResolvedValue(false),
});

const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId,
    organizationCode: 'SERVICE_DEFAULT',
    organizationName: '乙方默认组织',
    organizationKind: 'SERVICE',
    memberRole: 'ENGINEER',
  }),
});

/** 客户公司真源（`base_user_info.customer_organization_id`）：任务 03 报修原件归属 */
const makeAccountQueryService = () => ({
  findCustomerOrganizationId: jest.fn().mockResolvedValue(organizationId),
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
  }) as unknown as TransactionRunner & { run: jest.Mock };

const makeStorage = () => ({
  save: jest.fn().mockResolvedValue('0123456789abcdef0123456789abcdef.pdf'),
  open: jest.fn(),
  delete: jest.fn().mockResolvedValue(undefined),
  verifyIntegrity: jest.fn().mockResolvedValue(true),
});

const allowedMimeTypes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/markdown',
  'text/csv',
];

const makeUsecase = (
  overrides: {
    storedFileService?: ReturnType<typeof makeStoredFileService>;
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
    transactionRunner?: ReturnType<typeof makeTransactionRunner>;
    storage?: ReturnType<typeof makeStorage>;
  } = {},
) => {
  const storedFileService = overrides.storedFileService ?? makeStoredFileService();
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const accountQueryService = overrides.accountQueryService ?? makeAccountQueryService();
  const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();
  const storage = overrides.storage ?? makeStorage();
  // 冻结闸门替身：可观察调用次序（守卫必须先于写盘）
  const holdService = {
    assertBusinessWritable: jest.fn(() => Promise.resolve()),
    assertBusinessWritableInTransaction: jest.fn(
      (_input: { organizationId: number; transactionContext: unknown }) => Promise.resolve(),
    ),
    assertCompanyWritable: jest.fn(() => Promise.resolve()),
    assertCompanyWritableInTransaction: jest.fn(() => Promise.resolve()),
    assertWritable: jest.fn(() => Promise.resolve()),
  };

  const usecase = new UploadStoredFileUsecase(
    storedFileService as unknown as StoredFileService,
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    holdService as unknown as LocalWriteHoldService,
    accountQueryService as unknown as AccountQueryService,
    transactionRunner,
    storage,
    allowedMimeTypes,
  );

  return {
    usecase,
    storedFileService,
    queryService,
    organizationContextService,
    accountQueryService,
    transactionRunner,
    storage,
    holdService,
  };
};

const command = (overrides: Record<string, unknown> = {}) => ({
  session: engineer,
  businessType: 'REPAIR_PROCESS',
  file: { buffer: pdfBytes, originalFilename: '维修记录.pdf' },
  ...overrides,
});

/** 篡改首个条目的数据描述符 CRC（有签名写法：签名 + CRC + 两个大小）。 */
const withCorruptDataDescriptor = (zip: Buffer): Buffer => {
  const patched = Buffer.from(zip);
  const centralDirectoryOffset = patched.readUInt32LE(patched.byteLength - 6);
  const localHeaderOffset = patched.readUInt32LE(centralDirectoryOffset + 42);
  const nameLength = patched.readUInt16LE(localHeaderOffset + 26);
  const extraLength = patched.readUInt16LE(localHeaderOffset + 28);
  const compressedSize = patched.readUInt32LE(centralDirectoryOffset + 20);
  const descriptorOffset = localHeaderOffset + 30 + nameLength + extraLength + compressedSize;
  expect(patched.readUInt32LE(descriptorOffset)).toBe(0x08074b50);
  patched.writeUInt32LE(patched.readUInt32LE(descriptorOffset + 4) ^ 0x1, descriptorOffset + 4);
  return patched;
};

describe('UploadStoredFileUsecase', () => {
  it('合法上传：先授权与可信公司，再写存储，最后在事务内登记 VALID + TEMPORARY', async () => {
    const { usecase, storedFileService, organizationContextService, storage } = makeUsecase();

    const result = await usecase.execute(command());

    expect(organizationContextService.resolveForAccount.mock.invocationCallOrder[0]).toBeLessThan(
      storage.save.mock.invocationCallOrder[0],
    );
    expect(storage.save).toHaveBeenCalledWith(pdfBytes, 'pdf');
    expect(storedFileService.insertStagedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedByAccountId: 900001,
        ownerOrganizationId: organizationId,
        storageReference: '0123456789abcdef0123456789abcdef.pdf',
        originalFilename: '维修记录.pdf',
        mimeType: 'application/pdf',
        byteSize: pdfBytes.byteLength,
        checksumSha256: createHash('sha256').update(pdfBytes).digest('hex'),
        businessType: 'REPAIR_PROCESS',
      }),
      transactionContext,
    );
    expect(result.status).toBe('VALID');
    expect(result.bindingStatus).toBe('TEMPORARY');
    expect(result.businessId).toBeNull();
    expect(result.uploadContextId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.fileId).not.toBe(result.uploadContextId);
  });

  it('尺寸边界：恰好 20,000,000 字节通过', async () => {
    const { usecase, storage } = makeUsecase();
    const atLimit = makeMinimalPdf(STORED_FILE_UPLOAD_MAX_BYTES);

    await expect(
      usecase.execute(command({ file: { buffer: atLimit, originalFilename: 'limit.pdf' } })),
    ).resolves.toMatchObject({ byteSize: STORED_FILE_UPLOAD_MAX_BYTES });
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('六种 Office 真实样本走完整上传正例：保存、登记一次，大小/MIME/SHA-256 一致', async () => {
    const cases: Array<[keyof typeof officeSamples, string]> = [
      ['doc', 'application/msword'],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['xls', 'application/vnd.ms-excel'],
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['ppt', 'application/vnd.ms-powerpoint'],
      ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ];

    for (const [extension, mimeType] of cases) {
      const { usecase, storage, storedFileService } = makeUsecase();
      const buffer = officeSamples[extension];

      const result = await usecase.execute(
        command({ file: { buffer, originalFilename: `sample.${extension}` } }),
      );

      expect(storage.save).toHaveBeenCalledTimes(1);
      expect(storage.save).toHaveBeenCalledWith(buffer, extension);
      expect(storedFileService.insertStagedFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        mimeType,
        byteSize: buffer.byteLength,
        checksumSha256: createHash('sha256').update(buffer).digest('hex'),
        status: 'VALID',
        bindingStatus: 'TEMPORARY',
      });
    }
  });

  it('图片真实结构走上传正例', async () => {
    for (const [buffer, filename, mimeType] of [
      [minimalPng, 'sample.png', 'image/png'],
      [minimalJpeg, 'sample.jpg', 'image/jpeg'],
    ] as const) {
      const { usecase, storage } = makeUsecase();
      await expect(
        usecase.execute(command({ file: { buffer, originalFilename: filename } })),
      ).resolves.toMatchObject({ mimeType, byteSize: buffer.byteLength });
      expect(storage.save).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['普通 ZIP 冒充 docx', officeSamples, 'fake.docx'],
    ['docx 交叉改名为 xlsx', officeSamples, 'cross.xlsx'],
    ['截断的 OLE doc', officeSamples, 'truncated.doc'],
    ['仅 PDF 文件头', officeSamples, 'header.pdf'],
    ['仅 PNG 文件头', officeSamples, 'header.png'],
    ['仅 JPEG 文件头', officeSamples, 'header.jpg'],
  ])('拒绝路径不写存储、不登记：%s', async (_label, samples, filename) => {
    const { usecase, storage, storedFileService } = makeUsecase();
    const buffer = (() => {
      switch (filename) {
        case 'fake.docx':
          return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
        case 'cross.xlsx':
          return samples.docx;
        case 'truncated.doc':
          return samples.doc.subarray(0, 128);
        case 'header.pdf':
          return Buffer.from('%PDF-1.7\n', 'ascii');
        case 'header.png':
          return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        default:
          return Buffer.from([0xff, 0xd8, 0xff]);
      }
    })();

    await expect(
      usecase.execute(command({ file: { buffer, originalFilename: filename } })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });

    expect(storage.save).not.toHaveBeenCalled();
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
  });

  it('ZIP 数据描述符字段与中央目录不符拒绝，且不写盘、不登记', async () => {
    const { usecase, storage, storedFileService } = makeUsecase();
    const buffer = withCorruptDataDescriptor(officeSamples.docx);

    await expect(
      usecase.execute(command({ file: { buffer, originalFilename: 'descriptor.docx' } })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });

    expect(storage.save).not.toHaveBeenCalled();
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
  });

  it.each(illegalOleChainTailCases)(
    'OLE 非法链尾映射为类型不允许且不写盘、不登记：%s',
    async (_label, buffer, filename) => {
      const { usecase, storage, storedFileService } = makeUsecase();

      await expect(
        usecase.execute(command({ file: { buffer, originalFilename: filename } })),
      ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });

      expect(storage.save).not.toHaveBeenCalled();
      expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
    },
  );

  it('ZIP 条目预算超限拒绝，且不写盘、不登记', async () => {
    const { usecase, storage, storedFileService } = makeUsecase();
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (let index = 0; index < 513; index += 1) {
      const name = Buffer.from(`entry-${index}.xml`, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(name.byteLength, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(name.byteLength, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name);
      centrals.push(central, name);
      offset += local.byteLength + name.byteLength;
    }
    const centralDirectory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(513, 8);
    eocd.writeUInt16LE(513, 10);
    eocd.writeUInt32LE(centralDirectory.byteLength, 12);
    eocd.writeUInt32LE(offset, 16);
    const budgetBomb = Buffer.concat([...locals, centralDirectory, eocd]);

    await expect(
      usecase.execute(command({ file: { buffer: budgetBomb, originalFilename: 'budget.docx' } })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });
    expect(storage.save).not.toHaveBeenCalled();
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
  });

  it('尺寸边界：超过 20,000,000 字节拒绝，且不触达存储', async () => {
    const { usecase, storage } = makeUsecase();
    const overLimit = Buffer.alloc(STORED_FILE_UPLOAD_MAX_BYTES + 1);

    await expect(
      usecase.execute(command({ file: { buffer: overLimit, originalFilename: 'over.pdf' } })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TOO_LARGE });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('空文件拒绝，且不触达存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute(
        command({ file: { buffer: Buffer.alloc(0), originalFilename: 'empty.pdf' } }),
      ),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_MISSING });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('实际内容与扩展名不符时拒绝（伪装 PDF 的文本）', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          file: { buffer: Buffer.from('not-a-pdf'), originalFilename: 'fake.pdf' },
        }),
      ),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('用途不在当前白名单时拒绝，且不解析组织、不触达存储', async () => {
    const { usecase, organizationContextService, storage } = makeUsecase();

    await expect(
      usecase.execute(command({ businessType: 'UNKNOWN_PURPOSE' })),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.PURPOSE_NOT_SUPPORTED });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('客户上传维修过程原件（REPAIR_PROCESS）拒绝，不写存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(usecase.execute(command({ session: customer }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('MAINTENANCE_REPORT 用途（任务 06）已接入白名单：工程师可上传暂存', async () => {
    const { usecase, organizationContextService, storage } = makeUsecase();

    await expect(
      usecase.execute(command({ businessType: 'MAINTENANCE_REPORT' })),
    ).resolves.toBeDefined();
    expect(organizationContextService.resolveForAccount).toHaveBeenCalled();
    expect(storage.save).toHaveBeenCalled();
  });

  it('客户角色拒绝（未登录之外的角色边界），不写存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(usecase.execute(command({ session: customer }))).rejects.toMatchObject({
      code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('任务 03：客户上传报修原件时归属公司来自账号事实（不查成员关系）', async () => {
    const { usecase, storedFileService, organizationContextService, accountQueryService } =
      makeUsecase();

    await usecase.execute(
      command({
        session: customer,
        businessType: 'REPAIR_REQUEST',
        file: { buffer: pdfBytes, originalFilename: '报修原件.pdf' },
      }),
    );

    expect(accountQueryService.findCustomerOrganizationId).toHaveBeenCalledWith({
      accountId: 900001,
    });
    expect(organizationContextService.resolveForAccount).not.toHaveBeenCalled();
    expect(storedFileService.insertStagedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        businessType: 'REPAIR_REQUEST',
        ownerOrganizationId: organizationId,
        uploadedByAccountId: 900001,
      }),
      transactionContext,
    );
  });

  it('任务 03：工程师不能上传报修原件（用途与身份交叉拒绝）', async () => {
    const { usecase, storedFileService, storage } = makeUsecase();

    await expect(
      usecase.execute(
        command({
          session: engineer,
          businessType: 'REPAIR_REQUEST',
          file: { buffer: pdfBytes, originalFilename: '报修原件.pdf' },
        }),
      ),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('任务 03：客户缺公司归属时拒绝上传报修原件，且不写存储', async () => {
    const accountQueryService = {
      findCustomerOrganizationId: jest.fn().mockResolvedValue(null),
    };
    const { usecase, storage } = makeUsecase({ accountQueryService });

    await expect(
      usecase.execute(
        command({
          session: customer,
          businessType: 'REPAIR_REQUEST',
          file: { buffer: pdfBytes, originalFilename: '报修原件.pdf' },
        }),
      ),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.CUSTOMER_COMPANY_REQUIRED });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('工程师缺少 activeRole 时失败关闭', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute(command({ session: engineerWithoutActiveRole })),
    ).rejects.toBeInstanceOf(DomainError);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('无可信公司归属时拒绝，不写存储', async () => {
    const organizationContextService = {
      resolveForAccount: jest
        .fn()
        .mockRejectedValue(new DomainError('ORGANIZATION_NO_ACTIVE_MEMBERSHIP', 'no org')),
    };
    const { usecase, storage } = makeUsecase({ organizationContextService });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: 'ORGANIZATION_NO_ACTIVE_MEMBERSHIP',
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('存储写入失败映射为受控错误，且不登记数据库', async () => {
    const storage = makeStorage();
    storage.save.mockRejectedValueOnce(new Error('disk full'));
    const { usecase, storedFileService } = makeUsecase({ storage });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: STORED_FILE_ERROR.UPLOAD_FAILED,
    });
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
  });
});

describe('UploadStoredFileUsecase 存储补偿判定', () => {
  const storageReference = '0123456789abcdef0123456789abcdef.pdf';
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const diagnosticMessage = (): string => String(warnSpy.mock.calls.at(-1)?.[0] ?? '');

  /** 登记回调已完成，但调用方仍收到错误（提交回执丢失/提交后报错） */
  const makeCommitThenFailRunner = () =>
    ({
      run: jest.fn(async (cb: (ctx: unknown) => unknown) => {
        await cb(transactionContext);
        throw new Error('commit acknowledgement lost');
      }),
    }) as unknown as TransactionRunner & { run: jest.Mock };

  /**
   * 事务回调已执行、但**提交回执丢失**（终局未知）：真实库语义。
   *
   * 写盘发生在事务内 ⇒ 回调必须真的跑过，才谈得上"字节已写下但终局未知"。
   */
  const makeRunnerFailingAfterCallback = (error: unknown) =>
    ({
      run: jest.fn(async (cb: (ctx: unknown) => unknown) => {
        await cb(transactionContext);
        throw error;
      }),
    }) as unknown as TransactionRunner & { run: jest.Mock };

  it('写盘拒绝：事务已回滚且未登记、不探测引用、不声称已保留、不删除', async () => {
    const storage = makeStorage();
    storage.save.mockRejectedValueOnce(new Error('disk full'));
    const { usecase, transactionRunner, queryService, storedFileService } = makeUsecase({
      storage,
    });

    await expect(usecase.execute(command())).rejects.toMatchObject({
      code: STORED_FILE_ERROR.UPLOAD_FAILED,
    });

    // 写盘发生在**事务内** ⇒ 事务回滚，**没有任何登记**
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
    expect(queryService.isStorageReferenceReferenced).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    const message = diagnosticMessage();
    expect(message).toContain('stored_file.upload.storage_save_failed');
    expect(message).toContain('"stage":"storage-save"');
    expect(message).toContain('"transactionStarted":true');
    expect(message).toContain('"transactionOutcome":"rolled-back"');
    expect(message).toContain('"registered":false');
    expect(message).toContain('"fileState":"unconfirmed"');
    expect(message).toContain('原件暂存失败');
    expect(message).not.toContain('compensation_retained');
    expect(message).not.toContain('已保留');
  });

  it('最小修复 01：写盘在**事务内的冻结守卫之后**、登记之前（同一事务、同一范围共享锁）', async () => {
    const { usecase, storage, storedFileService, holdService, transactionRunner } = makeUsecase();

    await usecase.execute(command());

    // 守卫（取范围共享锁）先于写盘
    expect(holdService.assertBusinessWritableInTransaction).toHaveBeenCalledTimes(1);
    expect(
      holdService.assertBusinessWritableInTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(storage.save.mock.invocationCallOrder[0]);
    // 写盘先于登记
    expect(storage.save.mock.invocationCallOrder[0]).toBeLessThan(
      storedFileService.insertStagedFile.mock.invocationCallOrder[0],
    );
    // 守卫与登记用的是**同一个事务上下文**
    expect(holdService.assertBusinessWritableInTransaction.mock.calls[0][0]).toMatchObject({
      transactionContext,
    });
    expect(storedFileService.insertStagedFile).toHaveBeenCalledWith(
      expect.anything(),
      transactionContext,
    );
    expect(transactionRunner.run).toHaveBeenCalledTimes(1);
  });

  it('最小修复 01：冻结已生效（事务内守卫拒绝）⇒ **不写盘**、不登记', async () => {
    const { usecase, storage, storedFileService, holdService } = makeUsecase();
    holdService.assertBusinessWritableInTransaction.mockRejectedValueOnce(
      new DomainError(SYNC_ERROR.WRITE_HELD, '目标公司数据区正在恢复期冻结'),
    );

    await expect(usecase.execute(command())).rejects.toBeInstanceOf(DomainError);

    expect(storage.save).not.toHaveBeenCalled();
    expect(storedFileService.insertStagedFile).not.toHaveBeenCalled();
  });

  it('回归：事务终局未确认且独立查询查不到引用时，仍保留文件并记录诊断', async () => {
    const transactionRunner = makeRunnerFailingAfterCallback(new Error('commit outcome unknown'));
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(false);
    const { usecase, storage } = makeUsecase({ transactionRunner, queryService });

    await expect(usecase.execute(command())).rejects.toThrow('commit outcome unknown');

    expect(queryService.isStorageReferenceReferenced).toHaveBeenCalledWith(storageReference);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(diagnosticMessage()).toContain(storageReference);
    expect(diagnosticMessage()).toContain('unreferenced');
    expect(diagnosticMessage()).toContain('unconfirmed');
  });

  it('确认回滚（登记回调抛错）但事务契约未给出明确终局时，保留文件并报告', async () => {
    const callbackError = new DomainError(STORED_FILE_ERROR.UPLOAD_FAILED, '登记失败');
    const storedFileService = makeStoredFileService();
    storedFileService.insertStagedFile.mockRejectedValueOnce(callbackError);
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(false);
    const { usecase, storage } = makeUsecase({ storedFileService, queryService });

    await expect(usecase.execute(command())).rejects.toBe(callbackError);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(diagnosticMessage()).toContain('unconfirmed');
  });

  it('真实提交但调用方收到错误时，保留文件并报告已存在引用', async () => {
    const transactionRunner = makeCommitThenFailRunner();
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(true);
    const { usecase, storage } = makeUsecase({ transactionRunner, queryService });

    await expect(usecase.execute(command())).rejects.toThrow('commit acknowledgement lost');

    expect(storage.delete).not.toHaveBeenCalled();
    expect(diagnosticMessage()).toContain('referenced');
  });

  it('引用探测失败时保留文件，主错误不变且不删除', async () => {
    const primaryError = new DomainError(STORED_FILE_ERROR.UPLOAD_FAILED, 'db down');
    const transactionRunner = makeRunnerFailingAfterCallback(primaryError);
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockRejectedValueOnce(new Error('probe unavailable'));
    const { usecase, storage } = makeUsecase({ transactionRunner, queryService });

    await expect(usecase.execute(command())).rejects.toBe(primaryError);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(diagnosticMessage()).toContain('probe-failed');
    expect(diagnosticMessage()).toContain(primaryError.message);
  });

  it('引用探测失败且日志抛错时，调用者仍收到同一主错误且不删除', async () => {
    const primaryError = new DomainError(STORED_FILE_ERROR.UPLOAD_FAILED, 'db down');
    const transactionRunner = makeTransactionRunner();
    transactionRunner.run.mockRejectedValueOnce(primaryError);
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockRejectedValueOnce(new Error('probe unavailable'));
    warnSpy.mockImplementationOnce(() => {
      throw new Error('logger broken');
    });
    const { usecase, storage } = makeUsecase({ transactionRunner, queryService });

    await expect(usecase.execute(command())).rejects.toBe(primaryError);

    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('回调已完成但事务 runner 随后报错：完成标记为 true、终局未确认且原件保留', async () => {
    const transactionRunner = makeCommitThenFailRunner();
    const queryService = makeQueryService();
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(false);
    const { usecase, storage, storedFileService } = makeUsecase({
      transactionRunner,
      queryService,
    });

    await expect(usecase.execute(command())).rejects.toThrow('commit acknowledgement lost');

    expect(storedFileService.insertStagedFile).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(diagnosticMessage()).toContain('"registrationCallbackCompleted":true');
    expect(diagnosticMessage()).toContain('"transactionOutcome":"unconfirmed"');
  });

  it('存储对象身份不明时保留并报告，不执行删除', async () => {
    const storage = makeStorage();
    storage.save.mockResolvedValueOnce('');
    const transactionRunner = makeRunnerFailingAfterCallback(new Error('db down'));
    const { usecase } = makeUsecase({ storage, transactionRunner });

    await expect(usecase.execute(command())).rejects.toThrow('db down');

    expect(storage.delete).not.toHaveBeenCalled();
    expect(diagnosticMessage()).toContain('unavailable');
  });
});
