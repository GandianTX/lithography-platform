// src/usecases/stored-file/download-stored-file.usecase.spec.ts

/// <reference types="jest" />
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import {
  ACCOUNT_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
  STORED_FILE_ERROR,
} from '@core/common/errors/domain-error';
import { LocalReferenceDocumentStorage } from '@src/infrastructure/file-storage/local-reference-document-storage';
import { LocalStoredFileStorage } from '@src/infrastructure/file-storage/local-stored-file-storage';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { STORED_FILE_UPLOAD_MAX_BYTES } from './stored-file-upload.contract';
import { DownloadStoredFileUsecase } from './download-stored-file.usecase';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const customer = session(['CUSTOMER']);
const admin = session(['SUPER_ADMIN'], 900010);
const fileId = '11111111-1111-4111-8111-111111111111';
const uploadContextId = '22222222-2222-4222-8222-222222222222';

const payload = Buffer.from('原样下载内容-2026\n', 'utf8');
const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

const downloadFacts = {
  fileId,
  storageReference: 'private/ref.pdf',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
  byteSize: payload.byteLength,
  checksumSha256: sha256(payload),
};

const makeQueryService = () => ({
  findAuthorizedDownload: jest.fn().mockResolvedValue(downloadFacts),
});

const makeOrganizationContextService = () => ({
  tryResolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
  resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
});

const makeAccountQueryService = () => ({
  findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
});

const makeStorage = () => ({
  save: jest.fn(),
  open: jest.fn().mockResolvedValue(Readable.from([payload])),
  delete: jest.fn(),
  verifyIntegrity: jest.fn(),
});

const makeUsecase = (
  overrides: {
    queryService?: ReturnType<typeof makeQueryService>;
    organizationContextService?: ReturnType<typeof makeOrganizationContextService>;
    accountQueryService?: ReturnType<typeof makeAccountQueryService>;
    storage?: ReturnType<typeof makeStorage>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const accountQueryService = overrides.accountQueryService ?? makeAccountQueryService();
  const storage = overrides.storage ?? makeStorage();
  const usecase = new DownloadStoredFileUsecase(
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    accountQueryService as unknown as AccountQueryService,
    storage,
  );
  return { usecase, queryService, organizationContextService, accountQueryService, storage };
};

const readAll = async (content: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of content as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(label);
};

describe('DownloadStoredFileUsecase', () => {
  it('授权通过后只返回已校验字节，不暴露存储引用，且只打开一次', async () => {
    const { usecase, storage } = makeUsecase();

    const result = await usecase.execute({ session: engineer, fileId, uploadContextId });

    expect(storage.open).toHaveBeenCalledTimes(1);
    expect(storage.open).toHaveBeenCalledWith('private/ref.pdf');
    expect(result).toMatchObject({
      fileId,
      originalFilename: '维修记录.pdf',
      mimeType: 'application/pdf',
    });
    expect(result).not.toHaveProperty('storageReference');
    await expect(readAll(result.content)).resolves.toEqual(payload);
  });

  it('直接请求不属于自己的原件：授权失败且不触达存储', async () => {
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(null);
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId: 'wrong-context' }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('客户读链路：期望用途切换为 REPAIR_REQUEST，归属仍由查询服务裁决', async () => {
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(null);
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: customer, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(queryService.findAuthorizedDownload).toHaveBeenCalledWith(
      expect.objectContaining({ fileId, expectedBusinessType: 'REPAIR_REQUEST' }),
    );
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('一级管理员跨公司下载：管理员范围传入查询服务，授权后才触达存储', async () => {
    const { usecase, queryService, storage } = makeUsecase();

    await usecase.execute({ session: admin, fileId, uploadContextId: null });

    expect(queryService.findAuthorizedDownload).toHaveBeenCalledWith({
      fileId,
      session: admin,
      viewerOrganizationId: null,
      uploadContextId: null,
      expectedBusinessType: 'REPAIR_PROCESS',
      adminOrganizationId: null,
    });
    expect(storage.open).toHaveBeenCalledWith('private/ref.pdf');
  });

  it('二级管理员跨公司拒绝：NOT_FOUND 且不打开存储', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockResolvedValueOnce({
      organizationId: 700002,
    });
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(null);
    const { usecase, storage } = makeUsecase({
      queryService,
      accountQueryService,
      organizationContextService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('二级管理员：工单仅 owner 归属（服务公司为空）时拒绝，且不打开存储', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockResolvedValueOnce({
      organizationId: 700002,
    });
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(null);
    const { usecase, storage } = makeUsecase({
      queryService,
      accountQueryService,
      organizationContextService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('二级管理员组织事实异常：受控 NOT_FOUND，不查询也不打开存储', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockRejectedValueOnce(
      new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织'),
    );
    const { usecase, queryService, storage } = makeUsecase({
      accountQueryService,
      organizationContextService,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(queryService.findAuthorizedDownload).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('管理员等级为 NULL：失败关闭 NOT_FOUND，不查询也不打开存储', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValueOnce(null);
    const { usecase, queryService, storage } = makeUsecase({ accountQueryService });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(queryService.findAuthorizedDownload).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('管理员账号行缺失：失败关闭 NOT_FOUND，不查询也不打开存储', async () => {
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockRejectedValueOnce(
      new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账户不存在'),
    );
    const { usecase, queryService, storage } = makeUsecase({ accountQueryService });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(queryService.findAuthorizedDownload).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('存储对象缺失时返回受控 FILE_NOT_AVAILABLE，不泄露路径', async () => {
    const storage = makeStorage();
    storage.open.mockRejectedValueOnce(new Error('ENOENT private/ref.pdf'));
    const { usecase } = makeUsecase({ storage });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
  });

  it('非法 fileId 拒绝', async () => {
    const { usecase } = makeUsecase();

    await expect(
      usecase.execute({ session: engineer, fileId: 'bad', uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.INVALID_PARAMS });
  });

  it('登记字节数超出业务上限时在打开存储前拒绝', async () => {
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce({
      ...downloadFacts,
      byteSize: STORED_FILE_UPLOAD_MAX_BYTES + 1,
    });
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it.each([
    ['零字节', 0],
    ['负数', -1],
    ['非整数', 1.5],
    ['非安全整数', Number.MAX_SAFE_INTEGER + 1],
  ])('登记字节数无效（%s）时在打开存储前拒绝', async (_label, byteSize) => {
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce({ ...downloadFacts, byteSize });
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it.each([
    ['长度不足', 'a'.repeat(63)],
    ['非十六进制', 'z'.repeat(64)],
    ['空串', ''],
  ])('登记 SHA-256 无效（%s）时在打开存储前拒绝', async (_label, checksumSha256) => {
    const queryService = makeQueryService();
    queryService.findAuthorizedDownload.mockResolvedValueOnce({
      ...downloadFacts,
      checksumSha256,
    });
    const { usecase, storage } = makeUsecase({ queryService });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('读取长度超出登记字节数时返回受控错误并销毁源流', async () => {
    const content = new Readable({
      read(): void {
        this.push(Buffer.alloc(downloadFacts.byteSize + 1, 0x61));
        this.push(null);
      },
    });
    let closed = false;
    content.once('close', () => {
      closed = true;
    });
    const storage = makeStorage();
    storage.open.mockResolvedValueOnce(content);
    const { usecase } = makeUsecase({ storage });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
    await waitFor(() => closed, '超限读取后源流未关闭');
    expect(content.destroyed).toBe(true);
  });

  it('读取过程中源流报错时返回受控错误', async () => {
    const content = new Readable({
      read(): void {
        this.destroy(new Error('disk read failed at /private/storage'));
      },
    });
    const storage = makeStorage();
    storage.open.mockResolvedValueOnce(content);
    const { usecase } = makeUsecase({ storage });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
  });

  it('读取中客户端断开：源流被销毁并返回受控错误', async () => {
    const content = new Readable({
      read(): void {
        // 故意不结束：等待客户端断开信号销毁源流
      },
    });
    let closed = false;
    content.once('close', () => {
      closed = true;
    });
    const storage = makeStorage();
    storage.open.mockResolvedValueOnce(content);
    const { usecase } = makeUsecase({ storage });
    const abortController = new AbortController();

    const execution = usecase.execute({
      session: engineer,
      fileId,
      uploadContextId,
      signal: abortController.signal,
    });
    await waitFor(() => storage.open.mock.calls.length === 1, '存储未被打开');
    abortController.abort();

    await expect(execution).rejects.toMatchObject({
      code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
    });
    await waitFor(() => closed, '断开后源流未关闭');
    expect(content.destroyed).toBe(true);
  });

  it('打开迟到返回而客户端已断开：迟到源流被销毁', async () => {
    const content = new Readable({
      read(): void {
        // 迟到源流在销毁前不产生数据
      },
    });
    let closed = false;
    content.once('close', () => {
      closed = true;
    });
    const storage = makeStorage();
    let releaseOpen: ((stream: Readable) => void) | undefined;
    storage.open.mockImplementationOnce(
      () =>
        new Promise<Readable>((resolve) => {
          releaseOpen = resolve;
        }),
    );
    const { usecase } = makeUsecase({ storage });
    const abortController = new AbortController();

    const execution = usecase.execute({
      session: engineer,
      fileId,
      uploadContextId,
      signal: abortController.signal,
    });
    await waitFor(() => releaseOpen !== undefined, '存储打开未进入等待');
    abortController.abort();
    releaseOpen?.(content);

    await expect(execution).rejects.toMatchObject({
      code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
    });
    await waitFor(() => closed, '迟到源流未关闭');
    expect(content.destroyed).toBe(true);
  });
});

describe('DownloadStoredFileUsecase 真实临时磁盘完整性校验', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-file-download-'));
  const base = new LocalReferenceDocumentStorage({ get: jest.fn(() => baseDir) } as never);
  const storage = new LocalStoredFileStorage(base);
  const original = Buffer.from('真实磁盘原件内容-2026', 'utf8');

  const makeDiskUsecase = () => {
    const queryService = makeQueryService();
    const usecase = new DownloadStoredFileUsecase(
      queryService as unknown as StoredFileQueryService,
      makeOrganizationContextService() as unknown as TrustedOrganizationContextQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      storage,
    );
    return { usecase, queryService };
  };

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const registerFacts = async (content: Buffer) => {
    const reference = await storage.save(content, 'txt');
    return {
      ...downloadFacts,
      storageReference: reference,
      byteSize: content.byteLength,
      checksumSha256: sha256(content),
    };
  };

  it('磁盘原样下载：打开一次，返回字节与哈希均与登记一致', async () => {
    const facts = await registerFacts(original);
    const { usecase, queryService } = makeDiskUsecase();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(facts);
    const openSpy = jest.spyOn(storage, 'open');

    const result = await usecase.execute({ session: engineer, fileId, uploadContextId });
    const received = await readAll(result.content);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(received.equals(original)).toBe(true);
    expect(sha256(received)).toBe(facts.checksumSha256);
  });

  it('磁盘文件被截断：返回受控错误且不返回原件字节', async () => {
    const facts = await registerFacts(original);
    fs.writeFileSync(
      path.join(baseDir, facts.storageReference),
      original.subarray(0, original.byteLength - 3),
    );
    const { usecase, queryService } = makeDiskUsecase();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(facts);

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
  });

  it('磁盘同长度内容被替换：返回受控错误且不返回原件字节', async () => {
    const facts = await registerFacts(original);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] ^ 0xff;
    expect(tampered.byteLength).toBe(original.byteLength);
    fs.writeFileSync(path.join(baseDir, facts.storageReference), tampered);
    const { usecase, queryService } = makeDiskUsecase();
    queryService.findAuthorizedDownload.mockResolvedValueOnce(facts);

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
  });

  it('磁盘文件比登记更长：读取到登记上限即拒绝', async () => {
    const facts = await registerFacts(original);
    fs.writeFileSync(
      path.join(baseDir, facts.storageReference),
      Buffer.concat([original, Buffer.from('extra')]),
    );
    const { usecase, queryService } = makeDiskUsecase();
    queryService.findAuthorizedDownload.mockResolvedValueOnce({
      ...facts,
      byteSize: original.byteLength,
    });

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE });
  });
});

/**
 * 归属判断使用真实 StoredFileQueryService；数据库替身范围仅限四个 Repository 的
 * `findOne` 返回值（内存 jest 替身），不连接 MySQL，也不验证 SQL/查询构造。
 */
describe('DownloadStoredFileUsecase 真实 QueryService 归属判断', () => {
  const boundFileRow = () => ({
    fileId,
    uploadedByAccountId: 900001,
    ownerOrganizationId: 700002,
    storageReference: 'private/ref.pdf',
    originalFilename: '维修记录.pdf',
    mimeType: 'application/pdf',
    byteSize: String(payload.byteLength),
    checksumSha256: sha256(payload),
    status: 'VALID',
    businessType: 'REPAIR_PROCESS',
    businessId: '42',
    uploadContextId: 'ctx',
    bindingStatus: 'BOUND',
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  });

  const makeLevel2AdminUsecase = () => {
    const storedFile = { findOne: jest.fn().mockResolvedValue(boundFileRow()), count: jest.fn() };
    const processEntry = { findOne: jest.fn().mockResolvedValue({ id: 700001 }) };
    const request = {
      findOne: jest.fn().mockResolvedValue({
        id: 42,
        intakeId: 7001,
        serviceOrganizationId: 700002,
        ownerOrganizationId: 920002,
        deprecated: false,
      }),
    };
    const intake = { findOne: jest.fn() };
    const queryService = new StoredFileQueryService(
      storedFile as never,
      processEntry as never,
      request as never,
      intake as never,
    );
    const accountQueryService = makeAccountQueryService();
    accountQueryService.findAdminLevelByAccountId.mockResolvedValue(2);
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.resolveForAccount.mockResolvedValue({ organizationId: 700002 });
    const storage = makeStorage();
    const usecase = new DownloadStoredFileUsecase(
      queryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      accountQueryService as unknown as AccountQueryService,
      storage,
    );
    return { usecase, storage, request, intake };
  };

  it('工单与报修服务公司一致：授权通过并打开存储', async () => {
    const { usecase, storage, intake } = makeLevel2AdminUsecase();
    intake.findOne.mockResolvedValue({ id: 7001, serviceOrganizationId: 700002 });

    const result = await usecase.execute({ session: admin, fileId, uploadContextId: null });

    expect(storage.open).toHaveBeenCalledTimes(1);
    await expect(readAll(result.content)).resolves.toEqual(payload);
  });

  it('工单与报修服务公司冲突：NOT_FOUND 且不打开存储', async () => {
    const { usecase, storage, intake } = makeLevel2AdminUsecase();
    intake.findOne.mockResolvedValue({ id: 7001, serviceOrganizationId: 920002 });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('工单未关联报修：NOT_FOUND 且不打开存储', async () => {
    const { usecase, storage, request, intake } = makeLevel2AdminUsecase();
    request.findOne.mockResolvedValue({
      id: 42,
      intakeId: null,
      serviceOrganizationId: 700002,
      ownerOrganizationId: 700002,
      deprecated: false,
    });

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(intake.findOne).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('原始报修不存在：NOT_FOUND 且不打开存储', async () => {
    const { usecase, storage, intake } = makeLevel2AdminUsecase();
    intake.findOne.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: admin, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });
});

/**
 * 客户报修原件（BOUND REPAIR_REQUEST）× 指定厂家工程师（任务 03/04 交叉链路）。
 * 归属判断使用真实 StoredFileQueryService；数据库替身范围仅限 Repository
 * `findOne` 返回值（内存 jest 替身），不连接 MySQL。
 */
describe('DownloadStoredFileUsecase 工程师读取客户报修原件', () => {
  const boundRequestFileRow = () => ({
    fileId,
    uploadedByAccountId: 900001,
    ownerOrganizationId: 910001,
    storageReference: 'private/ref.pdf',
    originalFilename: '报修原件.pdf',
    mimeType: 'application/pdf',
    byteSize: String(payload.byteLength),
    checksumSha256: sha256(payload),
    status: 'VALID',
    businessType: 'REPAIR_REQUEST',
    businessId: '7001',
    uploadContextId: 'ctx',
    bindingStatus: 'BOUND',
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  });

  const makeEngineerUsecase = (viewerOrganizationId = 910001) => {
    const storedFile = {
      findOne: jest.fn().mockResolvedValue(boundRequestFileRow()),
      count: jest.fn(),
    };
    const processEntry = { findOne: jest.fn().mockResolvedValue(null) };
    const request = {
      findOne: jest.fn().mockResolvedValue({
        id: 42,
        serviceOrganizationId: 910001,
        deprecated: false,
      }),
    };
    const intake = {
      findOne: jest.fn().mockResolvedValue({
        id: 7001,
        fileId,
        customerAccountId: 900001,
        serviceOrganizationId: 910001,
        deletedAt: null,
      }),
    };
    const queryService = new StoredFileQueryService(
      storedFile as never,
      processEntry as never,
      request as never,
      intake as never,
    );
    const organizationContextService = makeOrganizationContextService();
    organizationContextService.tryResolveForAccount.mockResolvedValue({
      organizationId: viewerOrganizationId,
    });
    const storage = makeStorage();
    const usecase = new DownloadStoredFileUsecase(
      queryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      makeAccountQueryService() as unknown as AccountQueryService,
      storage,
    );
    return { usecase, storage, request, intake };
  };

  it('指定厂家工程师下载真实关联工单的客户原件：内容与登记一致', async () => {
    const { usecase, storage } = makeEngineerUsecase();

    const result = await usecase.execute({ session: engineer, fileId, uploadContextId: null });

    expect(storage.open).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fileId, originalFilename: '报修原件.pdf' });
    expect(result).not.toHaveProperty('storageReference');
    await expect(readAll(result.content)).resolves.toEqual(payload);
  });

  it('外公司工程师下载客户原件：NOT_FOUND 且不打开存储', async () => {
    const { usecase, storage } = makeEngineerUsecase(700002);

    await expect(
      usecase.execute({
        session: session(['ENGINEER'], 900002),
        fileId,
        uploadContextId: null,
      }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('工单未关联该原稿：NOT_FOUND 且不打开存储', async () => {
    const { usecase, storage, request } = makeEngineerUsecase();
    request.findOne.mockResolvedValue(null);

    await expect(
      usecase.execute({ session: engineer, fileId, uploadContextId: null }),
    ).rejects.toMatchObject({ code: STORED_FILE_ERROR.NOT_FOUND });
    expect(storage.open).not.toHaveBeenCalled();
  });
});
