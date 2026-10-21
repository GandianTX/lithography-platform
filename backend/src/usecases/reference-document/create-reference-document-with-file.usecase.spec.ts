// src/usecases/reference-document/create-reference-document-with-file.usecase.spec.ts

/// <reference types="jest" />
import { Logger } from '@nestjs/common';

import {
  DomainError,
  ORGANIZATION_ERROR,
  PERMISSION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
} from '@core/common/errors/domain-error';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import type { CreateReferenceDocumentUsecase } from './create-reference-document.usecase';
import { CreateReferenceDocumentWithFileUsecase } from './create-reference-document-with-file.usecase';
import { CreateReferenceDocumentWithFileCommand } from './reference-document.types';

/** 上传策略测试配置：业务上限 20MB 的等价小口径，白名单仅放行 pdf/txt/md */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['application/pdf', 'text/plain', 'text/markdown'];

const SAVED_REFERENCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.pdf';

const makeStorage = () => ({
  save: jest.fn().mockResolvedValue(SAVED_REFERENCE),
  open: jest.fn(),
  delete: jest.fn().mockResolvedValue(undefined),
});

const makeInnerUsecase = () =>
  ({
    executeWithOrganizationInTransaction: jest.fn().mockResolvedValue({ id: 970123 }),
  }) as unknown as CreateReferenceDocumentUsecase & {
    executeWithOrganizationInTransaction: jest.Mock;
  };

/** 事务替身：默认直接执行回调并返回结果；受控实现覆盖以模拟 COMMIT 阶段失败 */
const transactionContext = { transaction: 'mock' };

const makeTransactionRunner = (
  runImplementation?: (callback: (context: unknown) => unknown) => unknown,
): TransactionRunner & { run: jest.Mock } =>
  ({
    run: jest.fn(
      runImplementation ??
        ((callback: (context: unknown) => unknown) => callback(transactionContext)),
    ),
  }) as unknown as TransactionRunner & { run: jest.Mock };

const makeOrganizationService = () => ({
  resolveForAccount: jest.fn().mockResolvedValue({
    membershipId: 8001,
    organizationId: 42,
    organizationCode: 'ORG-42',
    organizationName: '总部',
    organizationKind: 'CLIENT',
    memberRole: 'ADMIN',
  }),
});

const makeQueryService = () => ({
  // 上传失败补偿核查：默认「未被引用」（确定回滚路径）；各测试按需覆盖
  isStorageReferenceReferenced: jest.fn().mockResolvedValue(false),
});

const makeUsecase = (
  overrides: {
    storage?: ReturnType<typeof makeStorage>;
    inner?: ReturnType<typeof makeInnerUsecase>;
    runner?: TransactionRunner;
    org?: ReturnType<typeof makeOrganizationService>;
    query?: ReturnType<typeof makeQueryService>;
  } = {},
) => {
  const storage = overrides.storage ?? makeStorage();
  const inner = overrides.inner ?? makeInnerUsecase();
  const org = overrides.org ?? makeOrganizationService();
  const query = overrides.query ?? makeQueryService();
  const runner = overrides.runner ?? makeTransactionRunner();
  const usecase = new CreateReferenceDocumentWithFileUsecase(
    inner,
    org as unknown as TrustedOrganizationContextQueryService,
    query as unknown as ReferenceDocumentQueryService,
    runner,
    storage,
    UPLOAD_MAX_BYTES,
    ALLOWED_MIME_TYPES,
  );

  return { storage, inner, org, query, runner, usecase };
};

const makeCommand = (
  overrides: Partial<CreateReferenceDocumentWithFileCommand> = {},
): CreateReferenceDocumentWithFileCommand => ({
  session: { accountId: 900001, roles: ['SUPER_ADMIN'] },
  title: 'E2E 带文件创建',
  documentType: 'MANUAL',
  equipmentModelId: null,
  description: null,
  contentText: null,
  file: { buffer: Buffer.from('file-bytes'), originalFilename: '报告.pdf' },
  ...overrides,
});

describe('CreateReferenceDocumentWithFileUsecase', () => {
  it('保存成功且落库成功：同事务委托创建用例携带 MIME/精确引用/可信组织事实，不触发补偿删除', async () => {
    const { storage, inner, org, query, usecase } = makeUsecase();

    const result = await usecase.execute(makeCommand());

    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save).toHaveBeenCalledWith(Buffer.from('file-bytes'), 'pdf');
    // 组织前置解析在文件写入之前（F03）
    expect(org.resolveForAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 900001 }),
    );
    expect(inner.executeWithOrganizationInTransaction).toHaveBeenCalledTimes(1);
    expect(inner.executeWithOrganizationInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ accountId: 900001 }),
        title: 'E2E 带文件创建',
        contentText: null,
        file: {
          originalFilename: '报告.pdf',
          mimeType: 'application/pdf',
          storageReference: SAVED_REFERENCE,
        },
      }),
      expect.anything(),
      // 落库归属使用可信解析出的组织（不取客户端自报）
      42,
    );
    expect(result).toEqual({ id: 970123 });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(query.isStorageReferenceReferenced).not.toHaveBeenCalled();
  });

  it('保存失败不触发落库：抛 CREATION_FAILED，不调用创建用例，也不补偿删除', async () => {
    const { storage, inner, query, usecase } = makeUsecase();
    storage.save.mockRejectedValueOnce(new Error('disk failure'));

    await expect(usecase.execute(makeCommand())).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.CREATION_FAILED,
    });

    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(query.isStorageReferenceReferenced).not.toHaveBeenCalled();
  });

  it('组织前置拒绝（无有效成员/组织停用）：storage.save 不得被调用（F03 存储零调用）', async () => {
    const { storage, inner, org, query, usecase } = makeUsecase();
    org.resolveForAccount.mockRejectedValueOnce(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '当前账号没有有效组织成员关系'),
    );

    await expect(usecase.execute(makeCommand())).rejects.toMatchObject({
      code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
    });

    expect(storage.save).not.toHaveBeenCalled();
    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(query.isStorageReferenceReferenced).not.toHaveBeenCalled();
  });

  it('组织前置拒绝（成员歧义）：storage.save 不得被调用（F03 存储零调用）', async () => {
    const { storage, inner, org, usecase } = makeUsecase();
    org.resolveForAccount.mockRejectedValueOnce(
      new DomainError(ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP, '当前账号存在多个有效组织成员关系'),
    );

    await expect(usecase.execute(makeCommand())).rejects.toMatchObject({
      code: ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP,
    });

    expect(storage.save).not.toHaveBeenCalled();
    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('正常回滚（回调内落库失败）：核查确认未被引用后精确删除本次新文件，并保留原错误', async () => {
    const { storage, inner, query, usecase } = makeUsecase();
    const businessError = new DomainError(
      REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
      '设备型号不存在',
    );
    inner.executeWithOrganizationInTransaction.mockRejectedValueOnce(businessError);

    await expect(usecase.execute(makeCommand())).rejects.toBe(businessError);

    // 独立读取核查按精确存储引用查询（未命中 + 回调未完成 → 确定回滚、精确删除）
    expect(query.isStorageReferenceReferenced).toHaveBeenCalledWith(SAVED_REFERENCE);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(SAVED_REFERENCE);
  });

  it('COMMIT 确认丢失但实际已提交：文件已被正式资料引用，保留文件不删除（F02 修复红线）', async () => {
    const runner = makeTransactionRunner(async (callback) => {
      await callback(transactionContext);
      throw new Error('COMMIT_ACK_LOST');
    });
    const { storage, query, usecase } = makeUsecase({ runner });
    query.isStorageReferenceReferenced.mockResolvedValueOnce(true);
    const loggerWarn = jest
      .spyOn((usecase as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);

    try {
      await expect(usecase.execute(makeCommand())).rejects.toThrow('COMMIT_ACK_LOST');

      expect(query.isStorageReferenceReferenced).toHaveBeenCalledWith(SAVED_REFERENCE);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(`storageReference=${SAVED_REFERENCE}`),
      );
    } finally {
      loggerWarn.mockRestore();
    }
  });

  it('COMMIT 结果不明（回调完成但核查暂无引用）：保留文件并记录精确引用，不删（单次读取为空不是终局回滚证据）', async () => {
    const runner = makeTransactionRunner(async (callback) => {
      await callback(transactionContext);
      throw new Error('commit outcome unknown');
    });
    const { storage, query, usecase } = makeUsecase({ runner });
    const loggerError = jest
      .spyOn((usecase as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(usecase.execute(makeCommand())).rejects.toThrow('commit outcome unknown');

      expect(query.isStorageReferenceReferenced).toHaveBeenCalledWith(SAVED_REFERENCE);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining(`storageReference=${SAVED_REFERENCE}`),
      );
    } finally {
      loggerError.mockRestore();
    }
  });

  it('核查读取失败：事务终局不明，保留文件并记录精确引用，不删除', async () => {
    const { storage, inner, query, usecase } = makeUsecase();
    const businessError = new DomainError(
      REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
      '设备型号不存在',
    );
    inner.executeWithOrganizationInTransaction.mockRejectedValueOnce(businessError);
    query.isStorageReferenceReferenced.mockRejectedValueOnce(new Error('probe timeout'));
    const loggerError = jest
      .spyOn((usecase as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(usecase.execute(makeCommand())).rejects.toBe(businessError);

      expect(storage.delete).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining(`storageReference=${SAVED_REFERENCE}`),
        expect.stringContaining('probe timeout'),
      );
    } finally {
      loggerError.mockRestore();
    }
  });

  it('补偿删除失败不静默、不覆盖原错误：记录含精确引用的错误日志，仍抛出原业务错误', async () => {
    const { storage, inner, usecase } = makeUsecase();
    const businessError = new DomainError(
      REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND,
      '设备型号不存在',
    );
    inner.executeWithOrganizationInTransaction.mockRejectedValueOnce(businessError);
    storage.delete.mockRejectedValueOnce(new Error('unlink permission denied'));
    const loggerError = jest
      .spyOn((usecase as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(usecase.execute(makeCommand())).rejects.toBe(businessError);

      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining(`storageReference=${SAVED_REFERENCE}`),
        expect.stringContaining('unlink permission denied'),
      );
    } finally {
      loggerError.mockRestore();
    }
  });

  it('非管理员在任何 I/O 前被拒（负责人 0911）：ENGINEER 触发 INSUFFICIENT_PERMISSIONS，保存/事务/删除均未调用', async () => {
    const { storage, inner, runner, usecase } = makeUsecase();

    await expect(
      usecase.execute(makeCommand({ session: { accountId: 900002, roles: ['ENGINEER'] } })),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(storage.save).not.toHaveBeenCalled();
    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('非管理员在任何 I/O 前被拒（负责人 0911）：CUSTOMER 同样不触发任何文件或数据库动作', async () => {
    const { storage, inner, runner, usecase } = makeUsecase();

    await expect(
      usecase.execute(makeCommand({ session: { accountId: 900003, roles: ['CUSTOMER'] } })),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });

    expect(storage.save).not.toHaveBeenCalled();
    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('实际字节数超上限：UPLOAD_FILE_TOO_LARGE，不触存储不落库（大小以 buffer.byteLength 为准）', async () => {
    const { storage, inner, runner, usecase } = makeUsecase();

    await expect(
      usecase.execute(
        makeCommand({
          file: {
            buffer: Buffer.alloc(UPLOAD_MAX_BYTES + 1),
            originalFilename: '报告.pdf',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TOO_LARGE });

    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('白名单外扩展名：UPLOAD_FILE_TYPE_NOT_ALLOWED，不触存储不落库', async () => {
    const { storage, inner, usecase } = makeUsecase();

    await expect(
      usecase.execute(
        makeCommand({ file: { buffer: Buffer.from('MZ'), originalFilename: 'evil.exe' } }),
      ),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });

    expect(storage.save).not.toHaveBeenCalled();
    expect(inner.executeWithOrganizationInTransaction).not.toHaveBeenCalled();
  });

  it('无扩展名同样拒绝（映射无命中即白名单外，不信任客户端 MIME）', async () => {
    const { storage, usecase } = makeUsecase();

    await expect(
      usecase.execute(
        makeCommand({ file: { buffer: Buffer.from('x'), originalFilename: 'noext' } }),
      ),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED });

    expect(storage.save).not.toHaveBeenCalled();
  });
});
