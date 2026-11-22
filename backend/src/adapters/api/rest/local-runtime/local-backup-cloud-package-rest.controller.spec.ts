// src/adapters/api/rest/local-runtime/local-backup-cloud-package-rest.controller.spec.ts
/// <reference types="jest" />

/**
 * 云端备份包授权下载入口的定向测试（任务 09 S4／A09-07）。
 *
 * 守住：
 * - 正常下载给出**字节**与正确响应头（不暴露存储引用／密钥）；
 * - 包标识形态不合法、���司参数不合法 → 400（不把畸形输入带给下游）；
 * - 云服务未接入（DomainError）→ 受控错误体，不回显底层异常。
 */

import type { JwtPayload } from '@app-types/jwt.types';
import { LOCAL_RUNTIME_ERROR, DomainError } from '@core/common/errors/domain-error';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { LocalBackupCloudPackageRestController } from './local-backup-cloud-package-rest.controller';

const user: JwtPayload = {
  sub: 900001,
  username: 'engineer',
  email: null,
  accessGroup: ['ENGINEER'],
  activeRole: 'ENGINEER' as JwtPayload['activeRole'],
};

function makeResponse() {
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    end: jest.fn((_content?: Buffer, callback?: (error?: Error | null) => void) => {
      callback?.(null);
    }),
  } as unknown as Response;
  return { response, headers };
}

function makeRequest(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
}

function buildController(execute: jest.Mock) {
  return new LocalBackupCloudPackageRestController({ execute } as never);
}

describe('云端备份包授权下载入口（A09-07）', () => {
  it('正常下载：给出字节与正确响应头（不暴露存储引用）', async () => {
    const content = Buffer.from('backup-bytes');
    const execute = jest.fn().mockResolvedValue({ fileName: 'backup-2026.zip', content });
    const controller = buildController(execute);
    const { response, headers } = makeResponse();

    await controller.download('pkg-1', makeRequest({ organizationId: '4' }), user, response);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'pkg-1', organizationId: 4 }),
    );
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Length']).toBe(String(content.byteLength));
    expect(headers['Content-Disposition']).toContain('attachment');
    expect(headers['Content-Disposition']).not.toContain('storage');
  });

  it('未指定公司时按 session 范围（传 null，由 usecase 裁决）', async () => {
    const execute = jest.fn().mockResolvedValue({ fileName: 'b.zip', content: Buffer.from('x') });
    const controller = buildController(execute);
    const { response } = makeResponse();

    await controller.download('pkg-1', makeRequest(), user, response);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ organizationId: null }));
  });

  it('包标识形态不合法 → 400（不带入下游）', async () => {
    const execute = jest.fn();
    const controller = buildController(execute);

    await expect(
      controller.download('../etc/passwd', makeRequest(), user, makeResponse().response),
    ).rejects.toBeInstanceOf(HttpException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('公司参数不是正整数 → 400', async () => {
    const execute = jest.fn();
    const controller = buildController(execute);

    await expect(
      controller.download(
        'pkg-1',
        makeRequest({ organizationId: 'abc' }),
        user,
        makeResponse().response,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('云服务未接入（受控原因码）→ 受控错误体，不回显底层异常', async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(
        new DomainError(
          LOCAL_RUNTIME_ERROR.CLOUD_PACKAGES_UNAVAILABLE,
          '云端备份包服务未接入，无法下载云端包',
        ),
      );
    const controller = buildController(execute);

    await expect(
      controller.download('pkg-1', makeRequest(), user, makeResponse().response),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
