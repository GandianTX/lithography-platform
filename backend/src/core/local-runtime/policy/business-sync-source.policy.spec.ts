/// <reference types="jest" />
import {
  buildBusinessSyncIdempotencyKey,
  composeBusinessSyncEntityLocalId,
  computeBusinessSyncManifestChecksum,
  parseBusinessSyncEntityLocalId,
  resolveBusinessSyncSourceEligibility,
  type BusinessSyncSourceEligibilityFacts,
} from './business-sync-source.policy';

describe('业务同步清单摘要（正文 + 原件清单）', () => {
  const baseInput = {
    resourceType: 'MAINTENANCE_REPORT',
    recordUuid: '11111111-2222-4333-8444-555555555555',
    versionNo: 3,
    body: { schema_version: 2, payload: { b: 2, a: 1 } },
    originals: [{ relativePath: 'originals/a.pdf', sha256: 'A'.repeat(64), byteSize: 1024 }],
  };

  it('同一输入恒得到同一个 64 位十六进制摘要', () => {
    const first = computeBusinessSyncManifestChecksum(baseInput);
    const second = computeBusinessSyncManifestChecksum(baseInput);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('正文键顺序不影响摘要（两侧字段顺序不同也算同一份内容）', () => {
    const reordered = computeBusinessSyncManifestChecksum({
      ...baseInput,
      body: { payload: { a: 1, b: 2 }, schema_version: 2 },
    });

    expect(reordered).toBe(computeBusinessSyncManifestChecksum(baseInput));
  });

  it('原件顺序不影响摘要（清单按相对路径归一）', () => {
    const reversed = computeBusinessSyncManifestChecksum({
      ...baseInput,
      originals: [
        { relativePath: 'originals/b.pdf', sha256: 'b'.repeat(64), byteSize: 2 },
        { relativePath: 'originals/a.pdf', sha256: 'A'.repeat(64), byteSize: 1024 },
      ],
    });
    const ordered = computeBusinessSyncManifestChecksum({
      ...baseInput,
      originals: [
        { relativePath: 'originals/a.pdf', sha256: 'A'.repeat(64), byteSize: 1024 },
        { relativePath: 'originals/b.pdf', sha256: 'b'.repeat(64), byteSize: 2 },
      ],
    });

    expect(reversed).toBe(ordered);
  });

  it('版本或原件内容变化时摘要随之变化（不得把不同内容判为同一份）', () => {
    expect(computeBusinessSyncManifestChecksum({ ...baseInput, versionNo: 4 })).not.toBe(
      computeBusinessSyncManifestChecksum(baseInput),
    );
    expect(
      computeBusinessSyncManifestChecksum({
        ...baseInput,
        originals: [{ relativePath: 'originals/a.pdf', sha256: 'c'.repeat(64), byteSize: 1024 }],
      }),
    ).not.toBe(computeBusinessSyncManifestChecksum(baseInput));
  });

  it('校验值大小写归一（大小写不同视为同一原件）', () => {
    expect(
      computeBusinessSyncManifestChecksum({
        ...baseInput,
        originals: [{ relativePath: 'originals/a.pdf', sha256: 'a'.repeat(64), byteSize: 1024 }],
      }),
    ).toBe(computeBusinessSyncManifestChecksum(baseInput));
  });
});

describe('业务同步来源准入裁决', () => {
  const baseFacts = (
    overrides: Partial<BusinessSyncSourceEligibilityFacts> = {},
  ): BusinessSyncSourceEligibilityFacts => ({
    withdrawn: false,
    versionTrusted: true,
    currentVersion: 3,
    identityPersisted: true,
    authorizationStatus: 'ACTIVE',
    ...overrides,
  });

  it('全部事实成立时准入并给出当前版本', () => {
    const result = resolveBusinessSyncSourceEligibility(baseFacts());

    expect(result).toEqual({ eligible: true, rejection: null, version: 3 });
  });

  it('已删除／下架 → WITHDRAWN', () => {
    const result = resolveBusinessSyncSourceEligibility(baseFacts({ withdrawn: true }));

    expect(result.eligible).toBe(false);
    expect(result.rejection).toBe('WITHDRAWN');
  });

  it('版本不可核验 → VERSION_UNTRUSTED', () => {
    expect(
      resolveBusinessSyncSourceEligibility(baseFacts({ versionTrusted: false })).rejection,
    ).toBe('VERSION_UNTRUSTED');
    expect(
      resolveBusinessSyncSourceEligibility(baseFacts({ currentVersion: null })).rejection,
    ).toBe('VERSION_UNTRUSTED');
    expect(resolveBusinessSyncSourceEligibility(baseFacts({ currentVersion: 0 })).rejection).toBe(
      'VERSION_UNTRUSTED',
    );
  });

  it('稳定身份未持久化 → IDENTITY_UNTRUSTED（不回填派生值）', () => {
    const result = resolveBusinessSyncSourceEligibility(baseFacts({ identityPersisted: false }));

    expect(result.eligible).toBe(false);
    expect(result.rejection).toBe('IDENTITY_UNTRUSTED');
  });

  it('授权撤销 → AUTHORIZATION_INVALID；授权未登记 → AUTHORIZATION_UNKNOWN', () => {
    expect(
      resolveBusinessSyncSourceEligibility(baseFacts({ authorizationStatus: 'REVOKED' })).rejection,
    ).toBe('AUTHORIZATION_INVALID');
    expect(
      resolveBusinessSyncSourceEligibility(baseFacts({ authorizationStatus: 'UNKNOWN' })).rejection,
    ).toBe('AUTHORIZATION_UNKNOWN');
  });
});

describe('业务同步本地实体 ID 与幂等键', () => {
  it('（来源类型, 行号）压成的本地实体 ID 可往返还原', () => {
    const localId = composeBusinessSyncEntityLocalId('REFERENCE_DOCUMENT', 7);

    expect(parseBusinessSyncEntityLocalId(localId)).toEqual({
      resourceType: 'REFERENCE_DOCUMENT',
      recordId: 7,
    });
  });

  it('不同来源类型的同一行号不会撞成同一个本地实体 ID', () => {
    expect(composeBusinessSyncEntityLocalId('REFERENCE_DOCUMENT', 5)).not.toBe(
      composeBusinessSyncEntityLocalId('REPAIR_REQUEST', 5),
    );
    expect(composeBusinessSyncEntityLocalId('REPAIR_REQUEST', 5)).not.toBe(
      composeBusinessSyncEntityLocalId('MAINTENANCE_REPORT', 5),
    );
  });

  it('未登记的来源类型失败关闭（不静默产生错误任务）', () => {
    expect(() => composeBusinessSyncEntityLocalId('UNKNOWN_TYPE', 1)).toThrow();
  });

  it('无法还原的本地实体 ID 返回 null（历史行保持未知）', () => {
    expect(parseBusinessSyncEntityLocalId(5)).toBeNull();
    expect(parseBusinessSyncEntityLocalId(0)).toBeNull();
  });

  it('幂等键只由稳定键与版本决定（重复提交得到同一键）', () => {
    expect(buildBusinessSyncIdempotencyKey('abc', 3)).toBe(
      buildBusinessSyncIdempotencyKey('abc', 3),
    );
    expect(buildBusinessSyncIdempotencyKey('abc', 3)).not.toBe(
      buildBusinessSyncIdempotencyKey('abc', 4),
    );
  });
});
