// src/features/local-runtime/infrastructure/local-runtime-graphql-adapter.spec.ts

import { describe, expect, it } from 'vitest';

import type { LocalRuntimeStatus } from './local-runtime.types';
import { mapLocalRuntimeStatus } from './local-runtime-graphql-adapter';

const baseStatus: LocalRuntimeStatus = {
  installationId: '11111111-1111-1111-1111-111111111111',
  localSiteName: null,
  mappedOrganizationId: null,
  mappedOrganizationCode: null,
  viewerRole: 'ENGINEER',
  scopeOrganizationId: 4,
  service: {
    apiStatus: 'UP',
    databaseStatus: 'UP',
    taskFactSource: 'SQL',
    taskRecovery: 'ON_RESTART',
  },
  storage: {
    businessFileDirectory: 'var/reference-documents',
    businessFileDirectoryWritable: true,
    backupDirectory: 'var/local-backups',
    backupDirectoryWritable: false,
  },
  tasks: {
    pendingUploadCount: 2,
    uploadingUploadCount: 0,
    failedUploadCount: 1,
    succeededUploadCount: 5,
    runningBackupCount: 0,
    lastBackupStartedAt: null,
    lastBackupFinishedAt: null,
  },
  companies: [],
  authorizations: [],
  generatedAt: '2026-11-18T10:00:00.000Z',
};

describe('本地运行状态载荷映射', () => {
  it('原样保留服务端事实，不补造公司或成功状态', () => {
    const view = mapLocalRuntimeStatus({ localRuntimeStatus: baseStatus });

    expect(view).toEqual(baseStatus);
    expect(view.companies).toEqual([]);
  });

  it('缺失安装标识时失败，不用空串冒充已初始化', () => {
    expect(() =>
      mapLocalRuntimeStatus({
        localRuntimeStatus: { ...baseStatus, installationId: '' },
      }),
    ).toThrow(/安装标识/);
  });

  it('未知角色一字不放行（不猜测更宽角色）', () => {
    expect(() =>
      mapLocalRuntimeStatus({
        localRuntimeStatus: {
          ...baseStatus,
          viewerRole: 'ADMIN_LEVEL_3' as LocalRuntimeStatus['viewerRole'],
        },
      }),
    ).toThrow(/未知角色/);
  });

  it('非全局范围的 tasks 为 null 时原样保留，不补造 0 计数', () => {
    const view = mapLocalRuntimeStatus({
      localRuntimeStatus: { ...baseStatus, tasks: null },
    });

    expect(view.tasks).toBeNull();
  });

  it('授权记录保留凭据用途，页面据此区分业务同步与备份凭据', () => {
    const view = mapLocalRuntimeStatus({
      localRuntimeStatus: {
        ...baseStatus,
        authorizations: [
          {
            activeCount: 1,
            credentialPurpose: 'BUSINESS_SYNC',
            lastVerifiedAt: null,
            organizationId: 4,
            revokedCount: 0,
          },
        ],
      },
    });

    expect(view.authorizations[0]?.credentialPurpose).toBe('BUSINESS_SYNC');
  });

  it('授权汇总缺失时归一为空数组', () => {
    const view = mapLocalRuntimeStatus({
      localRuntimeStatus: {
        ...baseStatus,
        authorizations: undefined as unknown as LocalRuntimeStatus['authorizations'],
      },
    });

    expect(view.authorizations).toEqual([]);
  });

  it('公司计划缺失时归一为空数组', () => {
    const view = mapLocalRuntimeStatus({
      localRuntimeStatus: {
        ...baseStatus,
        companies: undefined as unknown as LocalRuntimeStatus['companies'],
      },
    });

    expect(view.companies).toEqual([]);
  });
});
