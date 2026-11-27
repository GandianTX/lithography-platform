// src/infrastructure/cloud/http-local-backup-cloud-provider.spec.ts
/**
 * 守住四条：
 * 1. **只回本公司数据区的包**：实现方越界也由本层过滤（跨公司不外泄）；
 * 2. **下载权限 ≠ 恢复权限**：本实现只给字节，不触发任何恢复动作；
 * 3. **响应按不可信输入处理**：形态非法的条目丢弃、整体形态非法按服务不可用；
 * 4. **凭据只出现在请求头**：不进错误信息、不进返回元数据。
 */
import { HttpLocalBackupCloudClient } from './http-local-backup-cloud.client';
import {
  CloudProviderUnavailableError,
  HttpLocalBackupCloudProvider,
} from './http-local-backup-cloud-provider';

type HttpStub = { get: jest.Mock };

function buildClient(baseUrl: string | null): HttpLocalBackupCloudClient {
  return new HttpLocalBackupCloudClient(
    {
      baseUrl,
      credential: 'cred-1',
      timeoutMs: 5_000,
      maxUploadFileBytes: 1024,
      maxUploadPackageBytes: 4096,
    },
    { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as never,
  );
}

function buildProvider(options: { get?: jest.Mock } = {}): {
  provider: HttpLocalBackupCloudProvider;
  get: jest.Mock;
} {
  const client = buildClient('https://cloud.example.com/api');
  const get = options.get ?? jest.fn();
  (client as unknown as { http: HttpStub }).http = { get };
  return { provider: new HttpLocalBackupCloudProvider(client), get };
}

const session = { accountId: 1, roles: ['ENGINEER'], activeRole: 'ENGINEER' } as never;

describe('云端备份包读取端', () => {
  it('只回本公司数据区的包（跨公司不外泄）', async () => {
    const { provider } = buildProvider({
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          packages: [
            { packageId: 'pkg-1', organizationId: 4, byteSize: 10 },
            { packageId: 'pkg-2', organizationId: 7, byteSize: 20 },
          ],
        },
      }),
    });

    const packages = await provider.listPackages(session, { organizationId: 4 });

    expect(packages.map((item) => item.packageId)).toEqual(['pkg-1']);
  });

  it('形态非法的条目被丢弃（不把非法字段透传出去）', async () => {
    const { provider } = buildProvider({
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          packages: [
            { packageId: 'pkg-1', organizationId: 4 },
            { packageId: '', organizationId: 4 },
            { packageId: 'pkg-3', organizationId: 'x' },
          ],
        },
      }),
    });

    const packages = await provider.listPackages(session, { organizationId: 4 });

    expect(packages.map((item) => item.packageId)).toEqual(['pkg-1']);
    expect(packages[0]?.byteSize).toBeNull();
    expect(packages[0]?.checksumSha256).toBeNull();
  });

  it('整体形态非法 ⇒ 按云端服务不可用（不伪造空列表）', async () => {
    const { provider } = buildProvider({
      get: jest.fn().mockResolvedValue({ status: 200, data: { packages: 'not-an-array' } }),
    });

    await expect(provider.listPackages(session, { organizationId: 4 })).rejects.toBeInstanceOf(
      CloudProviderUnavailableError,
    );
  });

  it('下载取得字节并给出文件名（不触发任何恢复动作）', async () => {
    const bytes = Buffer.from('云端包字节', 'utf8');
    const { provider, get } = buildProvider({
      get: jest.fn().mockResolvedValue({ status: 200, data: bytes }),
    });

    const download = await provider.downloadPackage(session, {
      organizationId: 4,
      packageId: 'pkg-1',
    });

    expect(download.content.equals(bytes)).toBe(true);
    expect(download.fileName).toBe('backup-pkg-1.bin');
    const [url] = get.mock.calls[0] as [string];
    expect(url).toContain('/backup-packages/pkg-1/content');
  });

  it('下载得到空字节 ⇒ 按形态非法（服务不可用）', async () => {
    const { provider } = buildProvider({
      get: jest.fn().mockResolvedValue({ status: 200, data: Buffer.alloc(0) }),
    });

    await expect(
      provider.downloadPackage(session, { organizationId: 4, packageId: 'pkg-1' }),
    ).rejects.toBeInstanceOf(CloudProviderUnavailableError);
  });

  it('云端 4xx/5xx ⇒ 按服务不可用（受控错误码，不含地址与凭据）', async () => {
    const rejected = buildProvider({
      get: jest.fn().mockResolvedValue({ status: 404, data: null }),
    });
    await expect(
      rejected.provider.listPackages(session, { organizationId: 4 }),
    ).rejects.toBeInstanceOf(CloudProviderUnavailableError);

    const failed = buildProvider({
      get: jest.fn().mockResolvedValue({ status: 500, data: null }),
    });
    await expect(
      failed.provider.listPackages(session, { organizationId: 4 }),
    ).rejects.toBeInstanceOf(CloudProviderUnavailableError);
  });

  it('未配置 ⇒ 调用即失败（错误信息不含地址与凭据）', async () => {
    const client = buildClient(null);
    const provider = new HttpLocalBackupCloudProvider(client);

    await expect(provider.listPackages(session, { organizationId: 4 })).rejects.toMatchObject({
      code: 'CLOUD_NOT_CONFIGURED',
    });
    await expect(
      provider.downloadPackage(session, { organizationId: 4, packageId: 'pkg-1' }),
    ).rejects.toMatchObject({ code: 'CLOUD_NOT_CONFIGURED' });
  });
});
