// src/usecases/stored-file/download-stored-file.usecase.spec.ts

/// <reference types="jest" />
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { PERMISSION_ERROR, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { LocalReferenceDocumentStorage } from '@src/infrastructure/file-storage/local-reference-document-storage';
import { LocalStoredFileStorage } from '@src/infrastructure/file-storage/local-stored-file-storage';
import type { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { STORED_FILE_UPLOAD_MAX_BYTES } from './stored-file-upload.contract';
import { DownloadStoredFileUsecase } from './download-stored-file.usecase';

const session = (roles: string[], accountId = 900001): UsecaseSession =>
  ({ accountId, roles, activeRole: roles[0] }) as UsecaseSession;

const engineer = session(['ENGINEER']);
const customer = session(['CUSTOMER']);
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
    storage?: ReturnType<typeof makeStorage>;
  } = {},
) => {
  const queryService = overrides.queryService ?? makeQueryService();
  const organizationContextService =
    overrides.organizationContextService ?? makeOrganizationContextService();
  const storage = overrides.storage ?? makeStorage();
  const usecase = new DownloadStoredFileUsecase(
    queryService as unknown as StoredFileQueryService,
    organizationContextService as unknown as TrustedOrganizationContextQueryService,
    storage,
  );
  return { usecase, queryService, storage };
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

  it('客户角色拒绝，且不触达存储', async () => {
    const { usecase, storage } = makeUsecase();

    await expect(
      usecase.execute({ session: customer, fileId, uploadContextId }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
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
