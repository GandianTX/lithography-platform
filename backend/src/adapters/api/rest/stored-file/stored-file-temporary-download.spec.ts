/// <reference types="jest" />
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { JwtPayload } from '@app-types/jwt.types';
import { STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { DownloadStoredFileUsecase } from '@src/usecases/stored-file/download-stored-file.usecase';
import { GetStoredFileMetadataUsecase } from '@src/usecases/stored-file/get-stored-file-metadata.usecase';
import { UploadStoredFileUsecase } from '@src/usecases/stored-file/upload-stored-file.usecase';
import { StoredFileRestController } from './stored-file-rest.controller';

const fileId = '11111111-1111-4111-8111-111111111111';
const uploadContextId = '22222222-2222-4222-8222-222222222222';
const wrongUploadContextId = '33333333-3333-4333-8333-333333333333';
const payload = Buffer.from('t11-temporary-owner-download\n', 'utf8');
const checksumSha256 = createHash('sha256').update(payload).digest('hex');

const engineer = (accountId: number): JwtPayload => ({
  sub: accountId,
  username: `engineer-${accountId}`,
  email: null,
  accessGroup: ['ENGINEER'],
  activeRole: 'ENGINEER' as JwtPayload['activeRole'],
});

type RawResponse = { status: number; body: Buffer };

/**
 * TEMPORARY 本人下载适配层回归：真实 Controller → 真实 DownloadStoredFileUsecase。
 *
 * 替身边界：
 * - QueryService 为测试替身，只按“上传者 + 上下文”返回下载事实或 null；
 *   真实 TEMPORARY 授权由 stored-file.query.service.spec.ts 覆盖；
 * - 存储 `open` 读取临时文件，不连接真实存储；
 * - JWT/Roles Guard 被覆写为注入测试用户，认证本身不在本规格覆盖范围。
 */
describe('TEMPORARY 本人下载（真实 Nest HTTP + 真实 Usecase）', () => {
  let app: INestApplication;
  let port: number;
  let storageDir: string;
  let storageOpen: jest.Mock;
  let activeUser: JwtPayload;
  let observedContext: { fileId?: string; uploadContextId?: string | null } | null;

  const request = (urlPath: string): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
    });

  const downloadPath = (context?: string): string =>
    `/api/stored-files/${fileId}/download${
      context === undefined ? '' : `?uploadContextId=${context}`
    }`;

  const errorCode = (response: RawResponse): string =>
    (JSON.parse(response.body.toString('utf8')) as { code: string }).code;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'litho-t11-temp-download-'));
    fs.writeFileSync(path.join(storageDir, 'temp.png'), payload);
    storageOpen = jest.fn(() => fs.createReadStream(path.join(storageDir, 'temp.png')));

    const queryDouble = {
      findAuthorizedDownload: jest.fn(
        (query: {
          fileId: string;
          uploadContextId: string | null;
          session: { accountId: number };
        }) => {
          observedContext = {
            fileId: query.fileId,
            uploadContextId: query.uploadContextId,
          };
          if (query.session.accountId !== 900001) return null;
          if (query.uploadContextId !== uploadContextId) return null;
          return {
            fileId,
            storageReference: 'diag/temp.png',
            originalFilename: 't11-temporary.png',
            mimeType: 'image/png',
            byteSize: payload.byteLength,
            checksumSha256,
          };
        },
      ),
    };
    const orgDouble = {
      tryResolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
      resolveForAccount: jest.fn().mockResolvedValue({ organizationId: 910001 }),
    };
    const accountDouble = { findAdminLevelByAccountId: jest.fn().mockResolvedValue(null) };

    const downloadUsecase = new DownloadStoredFileUsecase(
      queryDouble as never,
      orgDouble as never,
      accountDouble as never,
      { open: storageOpen } as never,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [StoredFileRestController],
      providers: [
        { provide: DownloadStoredFileUsecase, useValue: downloadUsecase },
        { provide: GetStoredFileMetadataUsecase, useValue: { execute: jest.fn() } },
        { provide: UploadStoredFileUsecase, useValue: { execute: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): { getRequest(): { user?: JwtPayload } };
        }): boolean => {
          context.switchToHttp().getRequest().user = activeUser;
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

  beforeEach(() => {
    activeUser = engineer(900001);
    observedContext = null;
    storageOpen.mockClear();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('本人 + 正确上下文：下载 200，上下文透传，字节与 SHA-256 一致', async () => {
    const response = await request(downloadPath(uploadContextId));

    expect(response.status).toBe(200);
    expect(response.body.equals(payload)).toBe(true);
    expect(createHash('sha256').update(response.body).digest('hex')).toBe(checksumSha256);
    expect(observedContext).toEqual({ fileId, uploadContextId });
    expect(storageOpen).toHaveBeenCalledTimes(1);
  });

  it('缺失上下文：拒绝为 NOT_FOUND 且不打开存储', async () => {
    const response = await request(downloadPath());

    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe(STORED_FILE_ERROR.NOT_FOUND);
    expect(observedContext).toEqual({ fileId, uploadContextId: null });
    expect(storageOpen).not.toHaveBeenCalled();
  });

  it('错误上下文：拒绝为 NOT_FOUND 且不打开存储', async () => {
    const response = await request(downloadPath(wrongUploadContextId));

    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe(STORED_FILE_ERROR.NOT_FOUND);
    expect(observedContext).toEqual({ fileId, uploadContextId: wrongUploadContextId });
    expect(storageOpen).not.toHaveBeenCalled();
  });

  it('非上传者（同公司工程师）：拒绝为 NOT_FOUND 且不打开存储', async () => {
    activeUser = engineer(900002);

    const response = await request(downloadPath(uploadContextId));

    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe(STORED_FILE_ERROR.NOT_FOUND);
    expect(storageOpen).not.toHaveBeenCalled();
  });
});
