// src/adapters/api/rest/stored-file/stored-file-rest.controller.spec.ts

/// <reference types="jest" />
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import http, { type ServerResponse } from 'node:http';
import { PassThrough, Readable } from 'node:stream';

import type { JwtPayload } from '@app-types/jwt.types';
import { STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { HttpException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';

import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { DownloadStoredFileUsecase } from '@src/usecases/stored-file/download-stored-file.usecase';
import { GetStoredFileMetadataUsecase } from '@src/usecases/stored-file/get-stored-file-metadata.usecase';
import { UploadStoredFileUsecase } from '@src/usecases/stored-file/upload-stored-file.usecase';
import {
  buildCfbDifatChainTailFixture,
  buildCfbDirectoryChainTailFixture,
  officeSamples,
} from '../../../../../test/fixtures/stored-file-samples';
import { StoredFileRestController } from './stored-file-rest.controller';

const uploadAllowedMimeTypes = [
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

const user: JwtPayload = {
  sub: 900001,
  username: 'engineer',
  email: null,
  accessGroup: ['ENGINEER'],
  activeRole: 'ENGINEER' as JwtPayload['activeRole'],
};

const metadataView = {
  fileId: '11111111-1111-4111-8111-111111111111',
  businessType: 'REPAIR_PROCESS',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
  byteSize: 10,
  checksumSha256: 'checksum',
  status: 'VALID',
  bindingStatus: 'TEMPORARY',
  businessId: null,
  uploadContextId: '22222222-2222-4222-8222-222222222222',
  verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
} as const;

const makeController = () => {
  const uploadUsecase = { execute: jest.fn().mockResolvedValue(metadataView) };
  const metadataUsecase = { execute: jest.fn().mockResolvedValue(metadataView) };
  const downloadUsecase = {
    execute: jest.fn().mockResolvedValue({
      fileId: metadataView.fileId,
      originalFilename: metadataView.originalFilename,
      mimeType: metadataView.mimeType,
      content: Readable.from([Buffer.from('pdf')]),
    }),
  };
  const controller = new StoredFileRestController(
    uploadUsecase as unknown as UploadStoredFileUsecase,
    metadataUsecase as unknown as GetStoredFileMetadataUsecase,
    downloadUsecase as unknown as DownloadStoredFileUsecase,
  );
  return { controller, uploadUsecase, metadataUsecase, downloadUsecase };
};

const guardMetadata = (handler: object): unknown[] =>
  Reflect.getMetadata('__guards__', handler) ?? [];

const roleMetadata = (handler: object): string[] => Reflect.getMetadata('roles', handler) ?? [];

describe('StoredFileRestController', () => {
  it('三个端点均挂载 JwtAuthGuard + RolesGuard（未登录请求在守卫层 401）', () => {
    const prototype = StoredFileRestController.prototype as unknown as Record<string, unknown>;
    for (const method of ['upload', 'getMetadata', 'download']) {
      const handler = prototype[method] as object;
      expect(guardMetadata(handler)).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    }
  });

  it('上传仅工程师角色；元数据/下载为工程师与管理员读角色', () => {
    const prototype = StoredFileRestController.prototype as unknown as Record<string, unknown>;
    expect(roleMetadata(prototype.upload as object)).toEqual(['ENGINEER']);
    expect(roleMetadata(prototype.getMetadata as object)).toEqual(['ENGINEER', 'SUPER_ADMIN']);
    expect(roleMetadata(prototype.download as object)).toEqual(['ENGINEER', 'SUPER_ADMIN']);
  });

  it('缺少 multipart 文件时映射为 400 受控错误', async () => {
    const { controller } = makeController();

    const error = await controller
      .upload(undefined, user, 'REPAIR_PROCESS')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    const httpError = error as HttpException;
    expect(httpError.getStatus()).toBe(400);
    expect(httpError.getResponse()).toMatchObject({
      code: STORED_FILE_ERROR.UPLOAD_FILE_MISSING,
    });
  });

  it('元数据传递可信会话、上下文与原文文件名；不自行组装组织', async () => {
    const { controller, metadataUsecase } = makeController();

    await controller.getMetadata(
      metadataView.fileId,
      { query: { uploadContextId: metadataView.uploadContextId } } as unknown as Request,
      user,
    );

    expect(metadataUsecase.execute).toHaveBeenCalledWith({
      session: { accountId: 900001, roles: ['ENGINEER'], activeRole: 'ENGINEER' },
      fileId: metadataView.fileId,
      uploadContextId: metadataView.uploadContextId,
    });
  });
});

type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  aborted: boolean;
  error?: Error;
};

describe('StoredFileRestController 正式下载入口（真实 Nest HTTP）', () => {
  const fileId = metadataView.fileId;
  const downloadPath = `/api/stored-files/${fileId}/download?uploadContextId=${metadataView.uploadContextId}`;
  let app: INestApplication;
  let port: number;
  let downloadExecute: jest.Mock;
  let serverResponse: ServerResponse | undefined;

  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(label);
  };

  const requestDownload = (): Promise<RawResponse> =>
    new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: downloadPath }, (response) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (aborted: boolean, error?: Error): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            aborted,
            error,
          });
        };

        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('aborted', () => finish(true));
        response.on('error', (error: Error) => finish(true, error));
        response.on('end', () => finish(false));
      });
      request.on('error', (error: Error) => {
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true, error });
      });
    });

  beforeAll(async () => {
    downloadExecute = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [StoredFileRestController],
      providers: [
        { provide: UploadStoredFileUsecase, useValue: { execute: jest.fn() } },
        { provide: GetStoredFileMetadataUsecase, useValue: { execute: jest.fn() } },
        { provide: DownloadStoredFileUsecase, useValue: { execute: downloadExecute } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): { getRequest(): { user?: JwtPayload } };
        }): boolean => {
          context.switchToHttp().getRequest().user = user;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.use((_request: Request, response: ServerResponse, next: () => void): void => {
      serverResponse = response;
      next();
    });
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('成功对照：响应头、字节数与 SHA-256 一致', async () => {
    const payload = Buffer.from('受控下载内容\n', 'utf8');
    downloadExecute.mockResolvedValue({
      fileId,
      originalFilename: '维修记录.pdf',
      mimeType: 'application/pdf',
      content: Readable.from([payload]),
    });

    const response = await requestDownload();

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(String(response.headers['content-disposition'])).toContain("filename*=UTF-8''");
    expect(response.body.equals(payload)).toBe(true);
    expect(createHash('sha256').update(response.body).digest('hex')).toBe(
      createHash('sha256').update(payload).digest('hex'),
    );
  });

  it('响应头未发送：清除下载专用头并返回固定受控错误，不回显底层异常', async () => {
    downloadExecute.mockResolvedValue({
      fileId,
      originalFilename: '维修记录.pdf',
      mimeType: 'application/pdf',
      content: new Readable({
        read(): void {
          this.destroy(new Error('ENOENT /private/storage/secret-ref'));
        },
      }),
    });

    const response = await requestDownload();
    const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['content-type']).toContain('application/json');
    expect(body).toEqual({
      statusCode: 404,
      code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
      message: '原件文件暂时不可用',
    });
    expect(response.body.toString('utf8')).not.toContain('ENOENT');
    expect(response.body.toString('utf8')).not.toContain('secret-ref');
  });

  it('响应已开始：中断传输，不追加 JSON 或底层错误文本', async () => {
    let pushed = false;
    downloadExecute.mockResolvedValue({
      fileId,
      originalFilename: '维修记录.pdf',
      mimeType: 'application/pdf',
      content: new Readable({
        read(): void {
          if (pushed) return;
          pushed = true;
          this.push(Buffer.from('PARTIAL-BYTES'));
          setImmediate(() => this.destroy(new Error('read failed after headers')));
        },
      }),
    });

    const response = await requestDownload();
    const received = response.body.toString('utf8');

    expect(response.aborted || response.error !== undefined).toBe(true);
    expect(received).not.toContain(STORED_FILE_ERROR.FILE_NOT_AVAILABLE);
    expect(received).not.toContain('原件文件暂时不可用');
    expect(received).not.toContain('read failed after headers');
    expect(received).not.toContain('{');
  });

  it('等待打开期间客户端断开：迟到的源流被销毁，不写响应头、不启动传输', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const pending: { enter?: () => void; release?: (payload: unknown) => void } = {};
      const entered = new Promise<void>((resolve) => {
        pending.enter = resolve;
      });
      downloadExecute.mockImplementationOnce(() => {
        pending.enter?.();
        return new Promise((resolve) => {
          pending.release = resolve;
        });
      });

      let readCalls = 0;
      const lateContent = new Readable({
        read(): void {
          // 迟到的源流在销毁前不产生数据
          readCalls += 1;
        },
        destroy(_error, callback): void {
          setImmediate(() => callback(new Error('late storage read failed')));
        },
      });
      let lateClosed = false;
      lateContent.once('close', () => {
        lateClosed = true;
      });

      const request = http.get({ host: '127.0.0.1', port, path: downloadPath });
      request.on('error', (): void => undefined);
      await entered;

      const response = serverResponse;
      expect(response).toBeDefined();
      let responseClosed = false;
      response?.once('close', () => {
        responseClosed = true;
      });

      request.destroy();
      await waitFor(() => responseClosed, '客户端断开后服务端响应未关闭');

      pending.release?.({
        fileId,
        originalFilename: '维修记录.pdf',
        mimeType: 'application/pdf',
        content: lateContent,
      });
      await waitFor(() => lateClosed, '迟到的源流未被销毁');

      expect(lateContent.destroyed).toBe(true);
      expect(readCalls).toBe(0);
      expect(response?.headersSent).toBe(false);
      expect(response?.getHeader('content-disposition')).toBeUndefined();
      expect(response?.getHeader('content-type')).toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('传输中断开：源流被销毁且不追加错误体', async () => {
    const content = new PassThrough();
    content.write(Buffer.from('PARTIAL-BYTES'));
    let contentClosed = false;
    content.once('close', () => {
      contentClosed = true;
    });
    downloadExecute.mockResolvedValueOnce({
      fileId,
      originalFilename: '维修记录.pdf',
      mimeType: 'application/pdf',
      content,
    });

    const request = http.get({ host: '127.0.0.1', port, path: downloadPath });
    request.on('error', (): void => undefined);
    const response = await new Promise<http.IncomingMessage>((resolve) => {
      request.once('response', resolve);
    });
    response.on('error', (): void => undefined);
    response.on('data', (): void => undefined);

    request.destroy();
    await waitFor(() => contentClosed, '传输中断开后源流未销毁');

    expect(content.destroyed).toBe(true);
  });

  it('传输中客户端断开且源流销毁报错：源流关闭、监听器清理、无未捕获异常且不追加错误体', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const partial = Buffer.from('PARTIAL-BYTES');
      let readCalls = 0;
      let destroyCallbackRaised = false;
      const content = new Readable({
        read(): void {
          readCalls += 1;
          if (readCalls === 1) {
            this.push(partial);
          }
        },
        destroy(_error, callback): void {
          setImmediate(() => {
            destroyCallbackRaised = true;
            callback(new Error('storage read destroy failed'));
          });
        },
      });
      let contentClosed = false;
      content.once('close', () => {
        contentClosed = true;
      });
      const baselineErrorListeners = content.listenerCount('error');

      downloadExecute.mockResolvedValueOnce({
        fileId,
        originalFilename: '维修记录.pdf',
        mimeType: 'application/pdf',
        content,
      });

      serverResponse = undefined;
      const chunks: Buffer[] = [];
      let markPartialReceived: (() => void) | undefined;
      const partialReceived = new Promise<void>((resolve) => {
        markPartialReceived = resolve;
      });

      const request = http.get({ host: '127.0.0.1', port, path: downloadPath });
      request.on('error', (): void => undefined);
      const response = await new Promise<http.IncomingMessage>((resolve) => {
        request.once('response', resolve);
      });
      response.on('error', (): void => undefined);
      response.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
        if (Buffer.concat(chunks).includes(partial)) {
          markPartialReceived?.();
        }
      });

      await partialReceived;
      expect(response.statusCode).toBe(200);
      expect(Buffer.concat(chunks).includes(partial)).toBe(true);

      const responseObject = serverResponse as ServerResponse | undefined;
      expect(responseObject).toBeDefined();
      let responseClosed = false;
      responseObject?.once('close', () => {
        responseClosed = true;
      });

      request.destroy();
      await waitFor(() => responseClosed, '客户端断开后服务端响应未关闭');
      await waitFor(() => contentClosed, '客户端断开后源流未完成关闭');
      await waitFor(() => destroyCallbackRaised, '源流销毁回调未报错');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(content.destroyed).toBe(true);
      expect(content.listenerCount('error')).toBe(baselineErrorListeners);
      expect(responseObject?.destroyed).toBe(true);
      expect(responseObject?.writableEnded).toBe(false);
      expect(uncaught).toEqual([]);

      const received = Buffer.concat(chunks).toString('utf8');
      expect(received).toContain('PARTIAL-BYTES');
      expect(received).not.toContain(STORED_FILE_ERROR.FILE_NOT_AVAILABLE);
      expect(received).not.toContain('原件文件暂时不可用');
      expect(received).not.toContain('storage read destroy failed');
      expect(received).not.toContain('{');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });
});

describe('StoredFileRestController 正式上传入口（真实 Nest multipart HTTP）', () => {
  const boundary = '----lithography-upload-test';
  let app: INestApplication;
  let port: number;
  let storageSave: jest.Mock;
  let insertStagedFile: jest.Mock;

  const multipartBody = (filename: string, content: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="businessType"\r\n\r\nREPAIR_PROCESS\r\n`,
        'utf8',
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

  const requestUpload = (filename: string, content: Buffer): Promise<RawResponse> => {
    const body = multipartBody(filename, content);
    return new Promise((resolve) => {
      const headers: Record<string, string | number> = {};
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      headers['content-length'] = body.byteLength;
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/stored-files',
          method: 'POST',
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
              aborted: false,
            }),
          );
          response.on('error', (error: Error) =>
            resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true, error }),
          );
        },
      );
      request.on('error', (error: Error) =>
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true, error }),
      );
      request.end(body);
    });
  };

  beforeAll(async () => {
    storageSave = jest.fn().mockResolvedValue('private/storage/ref');
    insertStagedFile = jest.fn((input: Record<string, unknown>) => ({
      ...input,
      status: 'VALID',
      bindingStatus: 'TEMPORARY',
      businessId: null,
      verifiedAt: new Date('2026-11-15T00:00:00.000Z'),
      createdAt: new Date('2026-11-15T00:00:00.000Z'),
    }));
    const uploadUsecase = new UploadStoredFileUsecase(
      { insertStagedFile } as never,
      {} as never,
      { resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 1 }) } as never,
      {
        run: (callback: (context: never) => Promise<unknown>) => callback({} as never),
      } as never,
      { save: storageSave } as never,
      uploadAllowedMimeTypes,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [StoredFileRestController],
      providers: [
        { provide: UploadStoredFileUsecase, useValue: uploadUsecase },
        { provide: GetStoredFileMetadataUsecase, useValue: { execute: jest.fn() } },
        { provide: DownloadStoredFileUsecase, useValue: { execute: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): { getRequest(): { user?: JwtPayload } };
        }): boolean => {
          context.switchToHttp().getRequest().user = user;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('合法 docx 经 multipart 上传返回 201，MIME/字节数/SHA-256 与样本一致', async () => {
    const response = await requestUpload('sample.docx', officeSamples.docx);
    const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(body.byteSize).toBe(officeSamples.docx.byteLength);
    expect(body.checksumSha256).toBe(createHash('sha256').update(officeSamples.docx).digest('hex'));
    expect(body.status).toBe('VALID');
    expect(body.bindingStatus).toBe('TEMPORARY');
    expect(storageSave).toHaveBeenCalledTimes(1);
    expect(insertStagedFile).toHaveBeenCalledTimes(1);
  });

  it('截断的 docx 经 multipart 上传返回受控 415，存储与登记均为 0', async () => {
    storageSave.mockClear();
    insertStagedFile.mockClear();
    const response = await requestUpload(
      'broken.docx',
      officeSamples.docx.subarray(0, officeSamples.docx.byteLength - 100),
    );
    const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;

    expect(response.status).toBe(415);
    expect(body.code).toBe(STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED);
    expect(storageSave).not.toHaveBeenCalled();
    expect(insertStagedFile).not.toHaveBeenCalled();
  });

  it.each([
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
  ])(
    'OLE 非法链尾经 multipart 上传返回受控 415，存储与登记均为 0：%s',
    async (_label, content, filename) => {
      storageSave.mockClear();
      insertStagedFile.mockClear();
      const response = await requestUpload(filename, content);
      const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;

      expect(response.status).toBe(415);
      expect(body.code).toBe(STORED_FILE_ERROR.UPLOAD_FILE_TYPE_NOT_ALLOWED);
      expect(storageSave).not.toHaveBeenCalled();
      expect(insertStagedFile).not.toHaveBeenCalled();
    },
  );
});
