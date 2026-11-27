/// <reference types="jest" />
import {
  resolveSyncConflictEntry,
  type SyncConflictEntryFacts,
} from './sync-conflict-entry.policy';

/**
 * 冲突处理入口的写权与版本二次校验（任务 09 后续S1.6）。
 *
 * 覆盖口径：写权与裁决入口一致（一级管理员全局／其余限本公司）；只有待处理
 * 冲突才给入口；当前展示版本必须与服务端当前版本一致且落在冲突版本集合内。
 */
describe('resolveSyncConflictEntry（冲突处理入口纯规则）', () => {
  const baseFacts = (overrides: Partial<SyncConflictEntryFacts> = {}): SyncConflictEntryFacts => ({
    scopeOrganizationId: 4,
    conflictOrganizationId: 4,
    recordReadable: true,
    conflictStatus: 'PENDING',
    displayedVersion: 3,
    serverCurrentVersion: 3,
    conflictVersions: [3, 4, 3, 4],
    ...overrides,
  });

  it('写权成立且展示版本一致时给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts());

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ALLOWED');
  });

  it('记录级授权未通过时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts({ recordReadable: false }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NOT_READABLE');
  });

  it('冲突不属于本公司数据区时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(
      baseFacts({ scopeOrganizationId: 4, conflictOrganizationId: 9 }),
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('FOREIGN_COMPANY');
  });

  it('一级管理员的全局范围可以处理任意公司的冲突', () => {
    const result = resolveSyncConflictEntry(
      baseFacts({ scopeOrganizationId: null, conflictOrganizationId: 9 }),
    );

    expect(result.allowed).toBe(true);
  });

  it('冲突已裁决或已忽略时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts({ conflictStatus: 'RESOLVED' }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('CONFLICT_NOT_PENDING');
  });

  it('调用方未提供展示版本时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts({ displayedVersion: null }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('VERSION_NOT_ALIGNED');
  });

  it('展示版本与服务端当前版本不一致时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts({ displayedVersion: 2 }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('VERSION_NOT_ALIGNED');
  });

  it('展示版本不在冲突固化的版本集合内时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts({ conflictVersions: [7, 8, 7, 8] }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('VERSION_NOT_ALIGNED');
  });

  it('服务端当前版本不可核验时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(baseFacts({ serverCurrentVersion: null }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('VERSION_NOT_ALIGNED');
  });

  it('冲突版本集合含"历史未知"空位时，仍按已知版本位匹配', () => {
    const result = resolveSyncConflictEntry(baseFacts({ conflictVersions: [null, 3, null, null] }));

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ALLOWED');
  });

  it('历史冲突的版本位全部未知时不给出处理入口', () => {
    const result = resolveSyncConflictEntry(
      baseFacts({
        serverCurrentVersion: null,
        displayedVersion: null,
        conflictVersions: [null, null, null, null],
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('VERSION_NOT_ALIGNED');
  });
});
