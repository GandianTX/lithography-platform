// src/usecases/content-submission/content-submission-attachments.usecases.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  CONTENT_SUBMISSION_ERROR,
  DomainError,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import type { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import type { ContentSubmissionQueryService } from '@src/modules/lithography/queries/content-submission.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { DownloadContentSubmissionAttachmentUsecase } from './download-content-submission-attachment.usecase';
import { RemoveContentSubmissionAttachmentUsecase } from './remove-content-submission-attachment.usecase';
import { UploadContentSubmissionAttachmentUsecase } from './upload-content-submission-attachment.usecase';

const transactionContext = { transaction: 'mock' };

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const otherEngineer = session(['ENGINEER'], 900002);
const superAdmin = session(['SUPER_ADMIN'], 900099);
const customer = session(['CUSTOMER']);

/** 行锁快照替身（默认本人 + 本组织 + DRAFT 普通资料） */
const lockSnapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 970001,
  submissionKind: 'MATERIAL',
  ownerOrganizationId: 910001,
  submittedByAccountId: 900001,
  status: 'DRAFT',
  currentRevisionNo: 0,
  ...overrides,
});

/** 可信组织上下文替身：缺省解析到甲方默认组织（与 Seed 口径一致） */
const makeOrganizationContextService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 950001,
    organizationId: 910001,
    organizationCode: 'CLIENT_DEFAULT',
    organizationName: '甲方默认组织',
    organizationKind: 'CLIENT',
    memberRole: 'ENGINEER',
  }),
});

const makeTransactionRunner = () =>
  ({
    run: jest.fn((cb: (ctx: unknown) => unknown) => cb(transactionContext)),
  }) as unknown as TransactionRunner & { run: jest.Mock };

/**
 * 撰写/移除写服务替身：行锁默认返回 null（未授权），各测试按需覆盖；
 * replaceCurrentAttachment 默认返回安全元数据快照。
 */
const makeWriteService = () => ({
  lockSubmissionForWrite: jest.fn().mockResolvedValue(null),
  replaceCurrentAttachment: jest.fn().mockResolvedValue({
    attachmentId: 980001,
    originalFilename: '操作手册.pdf',
    mimeType: 'application/pdf',
    byteSize: 10,
  }),
  retireCurrentAttachment: jest.fn().mockResolvedValue({ retired: true }),
});

const makeQueryService = () => ({
  findSubmissionAccessFacts: jest.fn().mockResolvedValue(null),
  findAttachmentForDownload: jest.fn().mockResolvedValue(null),
  // 上传失败补偿核查：默认「未被引用」（确定回滚路径）；各测试按需覆盖
  isStorageReferenceReferenced: jest.fn().mockResolvedValue(false),
});

const makeStorage = () => ({
  save: jest.fn().mockResolvedValue('attachments/2026/02/server-generated-ref.pdf'),
  open: jest.fn().mockResolvedValue(Readable.from([Buffer.from('pdf-bytes')])),
  delete: jest.fn().mockResolvedValue(undefined),
});

const uploadFile = (overrides: Record<string, unknown> = {}) => ({
  buffer: Buffer.from('file-bytes'),
  originalFilename: '操作手册.pdf',
  ...overrides,
});

/** 默认白名单沿用管理员上传配置（测试只取常用子集） */
const defaultAllowedMimeTypes = ['application/pdf', 'image/png', 'text/plain', 'text/markdown'];

describe('UploadContentSubmissionAttachmentUsecase', () => {
  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
      transactionRunner?: ReturnType<typeof makeTransactionRunner>;
      storage?: ReturnType<typeof makeStorage>;
      uploadMaxBytes?: number;
      allowedMimeTypes?: string[];
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();
    const storage = overrides.storage ?? makeStorage();

    const usecase = new UploadContentSubmissionAttachmentUsecase(
      writeService as unknown as ContentSubmissionService,
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
      storage,
      overrides.uploadMaxBytes ?? 20 * 1024 * 1024,
      overrides.allowedMimeTypes ?? defaultAllowedMimeTypes,
    );

    return {
      usecase,
      writeService,
      queryService,
      organizationContextService,
      transactionRunner,
      storage,
    };
  };

  it('上传成功：授权通过后才写存储，先退役旧引用再登记新行，返回安全元数据', async () => {
    const { usecase, writeService, storage } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());

    const result = await usecase.execute({
      session: engineer,
      submissionId: 970001,
      file: uploadFile(),
    });

    // 授权先于文件 I/O（A-PR0 §2.1）：行锁裁决调用序必须先于 storage.save
    expect(writeService.lockSubmissionForWrite.mock.invocationCallOrder[0]).toBeLessThan(
      storage.save.mock.invocationCallOrder[0],
    );
    expect(storage.save).toHaveBeenCalledWith(Buffer.from('file-bytes'), 'pdf');
    expect(writeService.replaceCurrentAttachment).toHaveBeenCalledWith(
      {
        submissionId: 970001,
        originalFilename: '操作手册.pdf',
        // MIME 取自扩展名映射（不信任客户端 Content-Type）
        mimeType: 'application/pdf',
        // 大小以服务端实际字节数为准
        byteSize: 10,
        storageBackend: 'local',
        storageReference: 'attachments/2026/02/server-generated-ref.pdf',
        uploadedByAccountId: 900001,
      },
      transactionContext,
    );
    expect(result).toEqual({
      attachmentId: 980001,
      originalFilename: '操作手册.pdf',
      mimeType: 'application/pdf',
      byteSize: 10,
    });
  });

  it('扩展名大小写归一：.PDF 仍映射为规范 MIME', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());

    await usecase.execute({
      session: engineer,
      submissionId: 970001,
      file: uploadFile({ originalFilename: '操作手册.PDF' }),
    });

    expect(writeService.replaceCurrentAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'application/pdf' }),
      transactionContext,
    );
  });

  it('RETURNED 状态本人可替换附件（退回重提前的改稿窗口）', async () => {
    const { usecase, writeService, storage } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot({ status: 'RETURNED' }));

    await usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() });

    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(writeService.replaceCurrentAttachment).toHaveBeenCalledTimes(1);
  });

  it('他人投稿：NOT_FOUND 且完全不触盘（storage.save 零调用）', async () => {
    const { usecase, storage, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      lockSnapshot({ submittedByAccountId: 900002 }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(storage.save).not.toHaveBeenCalled();
    expect(writeService.replaceCurrentAttachment).not.toHaveBeenCalled();
  });

  it('跨组织投稿：统一 NOT_FOUND（不泄露存在性）且不触盘', async () => {
    const { usecase, storage, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      lockSnapshot({ ownerOrganizationId: 910002 }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('送审中（PENDING_REVIEW）：STATE_NOT_EDITABLE 且不触盘（并发防护不穿透）', async () => {
    const { usecase, storage, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      lockSnapshot({ status: 'PENDING_REVIEW' }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(storage.save).not.toHaveBeenCalled();
    expect(writeService.replaceCurrentAttachment).not.toHaveBeenCalled();
  });

  it('非工程师账号（管理员/客户）：PERMISSION_ERROR 且不做任何服务调用', async () => {
    const { usecase, storage, writeService, transactionRunner } = makeUsecase();

    for (const actor of [superAdmin, customer]) {
      await expect(
        usecase.execute({ session: actor, submissionId: 970001, file: uploadFile() }),
      ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    }
    expect(writeService.lockSubmissionForWrite).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });

  it('文件缺失/空文件：UPLOAD_FILE_MISSING（不进入事务）', async () => {
    const { usecase, transactionRunner, storage } = makeUsecase();

    await expect(
      usecase.execute({
        session: engineer,
        submissionId: 970001,
        file: uploadFile({ buffer: Buffer.alloc(0) }),
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_MISSING });
    expect(transactionRunner.run).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('超过大小上限：UPLOAD_FILE_TOO_LARGE（以实际字节数为准）', async () => {
    const { usecase, storage } = makeUsecase({ uploadMaxBytes: 4 });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('映射外扩展名（无扩展名/未支持类型）：UPLOAD_FILE_TYPE_NOT_ALLOWED', async () => {
    const { usecase, storage } = makeUsecase();

    for (const filename of ['木马.exe', '裸文件']) {
      await expect(
        usecase.execute({
          session: engineer,
          submissionId: 970001,
          file: uploadFile({ originalFilename: filename }),
        }),
      ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });
    }
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('配置白名单收窄：映射内但不在白名单的类型同样拒绝（可收窄不可放宽）', async () => {
    const { usecase, storage } = makeUsecase({ allowedMimeTypes: ['image/png'] });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('存储保存失败：CREATION_FAILED 且不登记附件行、不产生补偿删除', async () => {
    const { usecase, writeService, storage, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    storage.save.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.CREATION_FAILED });
    expect(writeService.replaceCurrentAttachment).not.toHaveBeenCalled();
    // 本次无成功写入的引用：无补偿删除，也不做核查读取
    expect(storage.delete).not.toHaveBeenCalled();
    expect(queryService.isStorageReferenceReferenced).not.toHaveBeenCalled();
  });

  it('落库失败：核查确认回滚且未被引用后，补偿删除本次新生成文件，并保留原错误', async () => {
    const { usecase, writeService, storage, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    const dbError = new DomainError(CONTENT_SUBMISSION_ERROR.CREATION_FAILED, '附件登记失败');
    writeService.replaceCurrentAttachment.mockRejectedValueOnce(dbError);

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.CREATION_FAILED });
    // 独立读取核查按精确存储引用查询（未命中 → 确定回滚、精确删除）
    expect(queryService.isStorageReferenceReferenced).toHaveBeenCalledWith(
      'attachments/2026/02/server-generated-ref.pdf',
    );
    expect(storage.delete).toHaveBeenCalledWith('attachments/2026/02/server-generated-ref.pdf');
  });

  it('补偿删除失败不掩盖原错误：记入错误日志后仍抛原错误（可观测且可清理）', async () => {
    const loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { usecase, writeService, storage } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    writeService.replaceCurrentAttachment.mockRejectedValueOnce(
      new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '落库失败'),
    );
    storage.delete.mockRejectedValueOnce(new Error('permission denied'));

    try {
      await expect(
        usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
      ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPDATE_FAILED });
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('attachments/2026/02/server-generated-ref.pdf'),
        expect.anything(),
      );
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  it('提交成功但确认丢失（COMMIT_ACK_LOST 控制流复现）：文件已被引用，绝不误删', async () => {
    const loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const transactionRunner = makeTransactionRunner();
    // 回调成功（附件行已落库）→ 事务已执行提交 → 提交确认丢失
    transactionRunner.run.mockImplementationOnce(async (cb: (ctx: unknown) => Promise<unknown>) => {
      await cb(transactionContext);
      throw new Error('COMMIT_ACK_LOST');
    });
    const { usecase, writeService, storage, queryService } = makeUsecase({ transactionRunner });
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(true);

    try {
      await expect(
        usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
      ).rejects.toThrow('COMMIT_ACK_LOST');
      // 修复红线：不再出现「已提交但 fileDeleted=true」
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('attachments/2026/02/server-generated-ref.pdf'),
      );
    } finally {
      loggerWarnSpy.mockRestore();
    }
  });

  it('回调已完成但核查暂无引用（提交终局不明）：保留文件并记录，不做删除猜测', async () => {
    const loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const transactionRunner = makeTransactionRunner();
    transactionRunner.run.mockImplementationOnce(async (cb: (ctx: unknown) => Promise<unknown>) => {
      await cb(transactionContext);
      throw new Error('commit outcome unknown');
    });
    const { usecase, writeService, storage, queryService } = makeUsecase({ transactionRunner });
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    // 核查默认返回 false：单次读取为空不能当作终局回滚证据

    try {
      await expect(
        usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
      ).rejects.toThrow('commit outcome unknown');
      expect(queryService.isStorageReferenceReferenced).toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('attachments/2026/02/server-generated-ref.pdf'),
      );
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  it('核查读取失败：保留文件、记录待核查引用，原错误不被覆盖（fail-safe）', async () => {
    const loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { usecase, writeService, storage, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    writeService.replaceCurrentAttachment.mockRejectedValueOnce(
      new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '落库失败'),
    );
    queryService.isStorageReferenceReferenced.mockRejectedValueOnce(new Error('probe timeout'));

    try {
      await expect(
        usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
      ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPDATE_FAILED });
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('attachments/2026/02/server-generated-ref.pdf'),
        expect.anything(),
      );
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  it('核查命中被引用（含已 RETIRED 行）时以数据库事实为准：宁多留不误删', async () => {
    const loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { usecase, writeService, storage, queryService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    writeService.replaceCurrentAttachment.mockRejectedValueOnce(
      new DomainError(CONTENT_SUBMISSION_ERROR.UPDATE_FAILED, '落库失败'),
    );
    queryService.isStorageReferenceReferenced.mockResolvedValueOnce(true);

    try {
      await expect(
        usecase.execute({ session: engineer, submissionId: 970001, file: uploadFile() }),
      ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.UPDATE_FAILED });
      // 本地错误推断为回滚，但数据库引用事实优先：保留文件
      expect(storage.delete).not.toHaveBeenCalled();
    } finally {
      loggerWarnSpy.mockRestore();
    }
  });
});

describe('RemoveContentSubmissionAttachmentUsecase', () => {
  const makeUsecase = (
    overrides: {
      writeService?: ReturnType<typeof makeWriteService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
      transactionRunner?: ReturnType<typeof makeTransactionRunner>;
    } = {},
  ) => {
    const writeService = overrides.writeService ?? makeWriteService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    const transactionRunner = overrides.transactionRunner ?? makeTransactionRunner();

    const usecase = new RemoveContentSubmissionAttachmentUsecase(
      writeService as unknown as ContentSubmissionService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    );

    return { usecase, writeService, organizationContextService, transactionRunner };
  };

  it('移除成功：行锁裁决后退役当前引用（只改数据库标记，不动存储文件）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001 }),
    ).resolves.toBeUndefined();
    expect(writeService.retireCurrentAttachment).toHaveBeenCalledWith({
      submissionId: 970001,
      transactionContext,
    });
  });

  it('RETURNED 本人可移除（退回改稿窗口与上传同一状态口径）', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot({ status: 'RETURNED' }));

    await usecase.execute({ session: engineer, submissionId: 970001 });

    expect(writeService.retireCurrentAttachment).toHaveBeenCalledTimes(1);
  });

  it('无当前附件（重复移除）：幂等成功，写服务返回未退役不影响结果', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(lockSnapshot());
    writeService.retireCurrentAttachment.mockResolvedValueOnce({ retired: false });

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001 }),
    ).resolves.toBeUndefined();
  });

  it('送审中（PENDING_REVIEW）：STATE_NOT_EDITABLE 且不执行退役', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(
      lockSnapshot({ status: 'PENDING_REVIEW' }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE });
    expect(writeService.retireCurrentAttachment).not.toHaveBeenCalled();
  });

  it('他人投稿/跨组织：统一 NOT_FOUND 且不执行退役', async () => {
    const { usecase, writeService } = makeUsecase();
    writeService.lockSubmissionForWrite.mockResolvedValueOnce(null);

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(writeService.retireCurrentAttachment).not.toHaveBeenCalled();
  });

  it('非工程师账号：PERMISSION_ERROR 且不进入事务', async () => {
    const { usecase, transactionRunner } = makeUsecase();

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(transactionRunner.run).not.toHaveBeenCalled();
  });
});

describe('DownloadContentSubmissionAttachmentUsecase', () => {
  const makeUsecase = (
    overrides: {
      queryService?: ReturnType<typeof makeQueryService>;
      organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
      storage?: ReturnType<typeof makeStorage>;
    } = {},
  ) => {
    const queryService = overrides.queryService ?? makeQueryService();
    const organizationContextService =
      overrides.organizationContextService ?? makeOrganizationContextService();
    const storage = overrides.storage ?? makeStorage();

    const usecase = new DownloadContentSubmissionAttachmentUsecase(
      queryService as unknown as ContentSubmissionQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      storage,
    );

    return { usecase, queryService, organizationContextService, storage };
  };

  const accessFacts = (overrides: Record<string, unknown> = {}) => ({
    submittedByAccountId: 900001,
    ownerOrganizationId: 910001,
    ...overrides,
  });

  const attachmentRef = (overrides: Record<string, unknown> = {}) => ({
    id: 980001,
    originalFilename: '操作手册.pdf',
    mimeType: 'application/pdf',
    storageReference: 'attachments/2026/02/server-generated-ref.pdf',
    ...overrides,
  });

  it('本人下载：返回附件元数据与内容流（存储引用不进入结果）', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(accessFacts());
    queryService.findAttachmentForDownload.mockResolvedValueOnce(attachmentRef());

    const result = await usecase.execute({
      session: engineer,
      submissionId: 970001,
      attachmentId: 980001,
    });

    expect(queryService.findAttachmentForDownload).toHaveBeenCalledWith({
      submissionId: 970001,
      attachmentId: 980001,
    });
    expect(storage.open).toHaveBeenCalledWith('attachments/2026/02/server-generated-ref.pdf');
    expect(result).toEqual({
      attachmentId: 980001,
      originalFilename: '操作手册.pdf',
      mimeType: 'application/pdf',
      content: expect.anything(),
    });
    // 结果只含安全元数据与内容流，存储引用不得出现在任何输出字段
    expect(Object.keys(result).sort()).toEqual([
      'attachmentId',
      'content',
      'mimeType',
      'originalFilename',
    ]);
  });

  it('本组织管理员可下载他人投稿的附件（同组织审核口径）', async () => {
    const { usecase, queryService } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(accessFacts());
    queryService.findAttachmentForDownload.mockResolvedValueOnce(attachmentRef());

    const result = await usecase.execute({
      session: superAdmin,
      submissionId: 970001,
      attachmentId: 980001,
    });

    expect(result.attachmentId).toBe(980001);
  });

  it('角色含 SUPER_ADMIN 但 activeRole 为 ENGINEER：他人投稿附件 NOT_FOUND 且不触盘（精确口径失败关闭）', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(accessFacts());

    await expect(
      usecase.execute({
        session: session(['ENGINEER', 'SUPER_ADMIN'], 900099),
        submissionId: 970001,
        attachmentId: 980001,
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findAttachmentForDownload).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('同组织其他工程师：NOT_FOUND 且不触盘（他人投稿附件不是公开数据）', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(
      accessFacts({ submittedByAccountId: 900777 }),
    );

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, attachmentId: 980001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findAttachmentForDownload).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('跨组织（即使管理员）：NOT_FOUND 且不触盘', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(
      accessFacts({ ownerOrganizationId: 910002 }),
    );

    await expect(
      usecase.execute({ session: superAdmin, submissionId: 970001, attachmentId: 980001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('投稿不存在：NOT_FOUND 且不查询附件', async () => {
    const { usecase, queryService, storage } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, attachmentId: 980001 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(queryService.findAttachmentForDownload).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('附件不属于该投稿（T10 ID 篡改）：NOT_FOUND 且不触盘', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(accessFacts());
    // 双过滤（id + submission_id）未命中：查询返回 null
    queryService.findAttachmentForDownload.mockResolvedValueOnce(null);

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, attachmentId: 980999 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('附件 ID 非法：INVALID_PARAMS（不进入任何查询）', async () => {
    const { usecase, queryService, storage } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, submissionId: 970001, attachmentId: 0 }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.INVALID_PARAMS });
    expect(queryService.findSubmissionAccessFacts).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('存储对象缺失/引用不可用：FILE_NOT_AVAILABLE 受控错误（不泄露路径与引用）', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(accessFacts());
    queryService.findAttachmentForDownload.mockResolvedValueOnce(attachmentRef());
    storage.open.mockRejectedValueOnce(new Error('/var/data/secret/path.pdf'));

    const error = (await usecase
      .execute({ session: engineer, submissionId: 970001, attachmentId: 980001 })
      .catch((caught: unknown) => caught)) as DomainError;

    expect(error).toMatchObject({ code: CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE });
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('客户角色：PERMISSION_ERROR 且不查询任何事实', async () => {
    const { usecase, queryService, storage } = makeUsecase();

    await expect(
      usecase.execute({ session: customer, submissionId: 970001, attachmentId: 980001 }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(queryService.findSubmissionAccessFacts).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('非本人普通工程师具备他人断言：不因 roles 含 ENGINEER 而放行他人附件（精确归属裁决）', async () => {
    const { usecase, queryService, storage } = makeUsecase();
    queryService.findSubmissionAccessFacts.mockResolvedValueOnce(accessFacts());

    await expect(
      usecase.execute({
        session: otherEngineer,
        submissionId: 970001,
        attachmentId: 980001,
      }),
    ).rejects.toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });
});
