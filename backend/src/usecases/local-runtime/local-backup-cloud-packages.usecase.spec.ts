// src/usecases/local-runtime/local-backup-cloud-packages.usecase.spec.ts
/// <reference types="jest" />

/**
 * 云端备份包元数据与下载的定向测试（任务 09 S4 第 3 条）。
 *
 * 守住：范围＝可信 session 公司；他人草稿不出本入口；未接入（R-02）失败关闭；
 * 下载**只给字节**、不产生恢复语义。
 */

import {
  DownloadLocalBackupCloudPackageUsecase,
  ListLocalBackupCloudPackagesUsecase,
} from './local-backup-cloud-packages.usecase';

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ADMIN_LEVEL_2',
  roles: ['SUPER_ADMIN'],
  identityType: 'SUPER_ADMIN',
  adminLevel: 2,
} as never;

function buildProvider(organizationId = 9) {
  return {
    listPackages: jest.fn(() =>
      Promise.resolve([
        {
          packageId: 'cloud-pkg-1',
          organizationId,
          backupId: 'backup-1',
          createdAt: '2026-11-20T00:00:00.000Z',
          byteSize: 1024,
          checksumSha256: 'a'.repeat(64),
        },
      ]),
    ),
    downloadPackage: jest.fn(() =>
      Promise.resolve({ fileName: 'backup.zip', content: Buffer.from('bytes') }),
    ),
  };
}

function buildUsecase(
  provider: unknown,
  scope: { organizationId: number | null } = { organizationId: 9 },
) {
  const moduleRef = {
    get: jest.fn(() => {
      if (provider === null) {
        throw new Error('未注册');
      }
      return provider;
    }),
  };
  const scopeResolver = { resolve: jest.fn(() => Promise.resolve(scope)) };
  return {
    listUsecase: new ListLocalBackupCloudPackagesUsecase(
      scopeResolver as never,
      moduleRef as never,
    ),
    downloadUsecase: new DownloadLocalBackupCloudPackageUsecase(
      scopeResolver as never,
      moduleRef as never,
    ),
    moduleRef,
  };
}

describe('云端备份包元数据与下载（S4）', () => {
  it('云服务未接入（R-02）：按受控原因码失败关闭，不伪造可用云包', async () => {
    const { listUsecase } = buildUsecase(null);

    await expect(listUsecase.execute({ session: SESSION })).rejects.toMatchObject({
      code: 'LOCAL_RUNTIME_CLOUD_PACKAGES_UNAVAILABLE',
    });
  });

  it('范围＝会话公司：只返回本公司包', async () => {
    const provider = buildProvider(9);
    const { listUsecase } = buildUsecase(provider);

    const result = await listUsecase.execute({ session: SESSION });

    expect(result.organizationId).toBe(9);
    expect(result.packages).toHaveLength(1);
    expect(provider.listPackages).toHaveBeenCalledWith(SESSION, { organizationId: 9 });
  });

  it('实现方越界返回他人包：外层再过滤，不外泄', async () => {
    const provider = buildProvider(10);
    const { listUsecase } = buildUsecase(provider);

    const result = await listUsecase.execute({ session: SESSION });

    expect(result.packages).toHaveLength(0);
  });

  it('二级管理员查询他公司：拒绝（范围外与不存在同码）', async () => {
    const provider = buildProvider(9);
    const { listUsecase } = buildUsecase(provider);

    await expect(
      listUsecase.execute({ session: SESSION, organizationId: 10 }),
    ).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_CLOUD_PACKAGES_UNAVAILABLE' });
    expect(provider.listPackages).not.toHaveBeenCalled();
  });

  it('一级管理员（全局范围）可指定公司', async () => {
    const provider = buildProvider(10);
    const { listUsecase } = buildUsecase(provider, { organizationId: null });

    const result = await listUsecase.execute({ session: SESSION, organizationId: 10 });

    expect(result.organizationId).toBe(10);
    expect(result.packages).toHaveLength(1);
  });

  it('下载只给字节与文件名，不产生任何恢复语义', async () => {
    const provider = buildProvider(9);
    const { downloadUsecase } = buildUsecase(provider);

    const result = await downloadUsecase.execute({ session: SESSION, packageId: 'cloud-pkg-1' });

    expect(result.fileName).toBe('backup.zip');
    expect(result.content.toString()).toBe('bytes');
    expect(provider.downloadPackage).toHaveBeenCalledWith(SESSION, {
      organizationId: 9,
      packageId: 'cloud-pkg-1',
    });
  });
});
