// src/modules/lithography/queries/sync-status.query.service.spec.ts

/**
 * 同步状态读取的**用途维度**回归（任务 09 S4 第 2 条）。
 *
 * 口径：业务同步只认**业务同步用途**的凭据；云备份凭据不得充数
 * （否则"已授权同步"会被一份备份凭据点亮）；用途不可核验（声明缺失／不可解析）
 * 一律不计入——"未取得该事实"，不判定为失效。
 */

import { SyncStatusQueryService } from './sync-status.query.service';

const BUSINESS_SYNC_CLAIMS = JSON.stringify({ purpose: 'BUSINESS_SYNC' });
const CLOUD_BACKUP_CLAIMS = JSON.stringify({ purpose: 'CLOUD_BACKUP' });

function buildService(rows: Record<string, unknown>[]) {
  const find = jest.fn().mockResolvedValue(rows);
  const service = new SyncStatusQueryService(
    { find: jest.fn().mockResolvedValue([]) } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { find } as never,
  );
  return { service, find };
}

describe('同步状态读取的用途维度（S4）', () => {
  it('业务同步用途的凭据 → 账号计入 ACTIVE', async () => {
    const { service } = buildService([
      {
        accountId: 900101,
        organizationId: 4,
        authorizationStatus: 'ACTIVE',
        signedClaims: BUSINESS_SYNC_CLAIMS,
      },
    ]);

    const result = await service.readAuthorizations('inst-1', 4, [900101]);

    expect(result.get(900101)).toBe('ACTIVE');
  });

  it('只有云备份用途的凭据 → 不计入（不得被当成业务同步授权）', async () => {
    const { service } = buildService([
      {
        accountId: 900101,
        organizationId: 4,
        authorizationStatus: 'ACTIVE',
        signedClaims: CLOUD_BACKUP_CLAIMS,
      },
    ]);

    const result = await service.readAuthorizations('inst-1', 4, [900101]);

    expect(result.has(900101)).toBe(false);
  });

  it('声明缺失（用途不可核验）→ 不计入，也不判定为失效', async () => {
    const { service } = buildService([
      { accountId: 900101, organizationId: 4, authorizationStatus: 'ACTIVE' },
    ]);

    const result = await service.readAuthorizations('inst-1', 4, [900101]);

    expect(result.has(900101)).toBe(false);
  });

  it('业务同步用途但已撤销 → REVOKED（撤权事实如实反映）', async () => {
    const { service } = buildService([
      {
        accountId: 900101,
        organizationId: 4,
        authorizationStatus: 'REVOKED',
        signedClaims: BUSINESS_SYNC_CLAIMS,
      },
    ]);

    const result = await service.readAuthorizations('inst-1', 4, [900101]);

    expect(result.get(900101)).toBe('REVOKED');
  });
});
