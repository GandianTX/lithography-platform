/// <reference types="jest" />
import {
  BUSINESS_SYNC_VERDICT_REASON,
  compareOriginals,
  resolveBusinessSyncVerdict,
  type BusinessSyncDispatchRequest,
  type BusinessSyncReceiverResponse,
} from './business-sync-protocol.policy';

const REQUEST: BusinessSyncDispatchRequest = {
  organizationId: 9,
  installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  accountId: 5,
  resourceType: 'MAINTENANCE_REPORT',
  recordUuid: '11111111-2222-4333-8444-555555555555',
  versionNo: 3,
  manifestChecksum: 'a'.repeat(64),
  body: { schema_version: 2 },
  originals: [{ relativePath: 'originals/a.pdf', sha256: 'b'.repeat(64), byteSize: 1024 }],
  idempotencyKey: 'business-sync:11111111-2222-4333-8444-555555555555:3',
};

function response(
  overrides: Partial<BusinessSyncReceiverResponse> = {},
): BusinessSyncReceiverResponse {
  return {
    status: 'ACCEPTED',
    reason: 'ACCEPTED',
    organizationId: 9,
    recordUuid: '11111111-2222-4333-8444-555555555555',
    versionNo: 3,
    manifestChecksum: 'a'.repeat(64),
    receivedOriginals: [
      { relativePath: 'originals/a.pdf', sha256: 'b'.repeat(64), byteSize: 1024 },
    ],
    remoteResourceId: 'remote-1',
    snapshot: { schema_version: 2 },
    receivedAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('业务同步派发裁决（S2.2）', () => {
  it('公司、身份、版本、摘要与全部原件都对得上才接受', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response());

    expect(verdict.status).toBe('ACCEPTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.ACCEPTED);
    expect(verdict.remoteResourceId).toBe('remote-1');
  });

  it('公司不一致 → 拒绝（不得跨公司落回执）', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response({ organizationId: 10 }));

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.COMPANY_MISMATCH);
  });

  it('身份不一致 → 拒绝（不得把别的记录当成本机记录同步）', () => {
    const verdict = resolveBusinessSyncVerdict(
      REQUEST,
      response({ recordUuid: '99999999-2222-4333-8444-555555555555' }),
    );

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.IDENTITY_MISMATCH);
  });

  it('云端未给出版本事实 → 拒绝（版本不可核验不得判成功）', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response({ versionNo: null }));

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.VERSION_MISMATCH);
  });

  it('云端版本更新 → 冲突（需人工裁决）', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response({ versionNo: 4 }));

    expect(verdict.status).toBe('CONFLICT');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.CLOUD_NEWER);
    expect(verdict.cloudVersionNo).toBe(4);
  });

  it('云端版本落后 → 拒绝（未真正落地本机版本）', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response({ versionNo: 2 }));

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.VERSION_MISMATCH);
  });

  it('同版本摘要不一致 → 拒绝（不得把不同内容判为已同步）', () => {
    const verdict = resolveBusinessSyncVerdict(
      REQUEST,
      response({ manifestChecksum: 'c'.repeat(64) }),
    );

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.MANIFEST_MISMATCH);
  });

  it('原件少件 → 拒绝（全部原件必须送达）', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response({ receivedOriginals: [] }));

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.ORIGINALS_INCOMPLETE);
  });

  it('原件校验值或字节数不一致 → 拒绝', () => {
    const verdict = resolveBusinessSyncVerdict(
      REQUEST,
      response({
        receivedOriginals: [
          { relativePath: 'originals/a.pdf', sha256: 'd'.repeat(64), byteSize: 1024 },
        ],
      }),
    );

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.ORIGINAL_DIGEST_MISMATCH);
  });

  it('云端明确拒绝 → 拒绝（不落成功回执）', () => {
    const verdict = resolveBusinessSyncVerdict(
      REQUEST,
      response({ status: 'REJECTED', reason: 'AUTHORIZATION_INVALID' }),
    );

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.CLOUD_REJECTED);
  });

  it('云端声明冲突且版本一致 → 冲突', () => {
    const verdict = resolveBusinessSyncVerdict(REQUEST, response({ status: 'CONFLICT' }));

    expect(verdict.status).toBe('CONFLICT');
    expect(verdict.reason).toBe(BUSINESS_SYNC_VERDICT_REASON.MANIFEST_MISMATCH);
  });
});

describe('全部原件核对', () => {
  it('登记清单为空时只要收到空清单即通过', () => {
    expect(compareOriginals([], [])).toBeNull();
  });

  it('多一件也算对不上（不得静默忽略多余件）', () => {
    expect(
      compareOriginals(
        [],
        [{ relativePath: 'originals/x.pdf', sha256: 'a'.repeat(64), byteSize: 1 }],
      ),
    ).toBe(BUSINESS_SYNC_VERDICT_REASON.ORIGINALS_INCOMPLETE);
  });
});
