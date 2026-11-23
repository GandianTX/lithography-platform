/// <reference types="jest" />
import {
  resolveSyncConflictCloudAdoption,
  resolveSyncConflictReadOnly,
} from './sync-conflict-readonly.policy';

describe('只读内容不得恢复（S2.3）', () => {
  it('可写内容放行', () => {
    expect(resolveSyncConflictReadOnly({ withdrawn: false, frozen: false, closed: false })).toEqual(
      { readOnly: false, reason: null },
    );
  });

  it('已删除／下架 → 只读', () => {
    expect(resolveSyncConflictReadOnly({ withdrawn: true, frozen: false, closed: false })).toEqual({
      readOnly: true,
      reason: 'SOURCE_WITHDRAWN',
    });
  });

  it('冻结 → 只读', () => {
    expect(resolveSyncConflictReadOnly({ withdrawn: false, frozen: true, closed: false })).toEqual({
      readOnly: true,
      reason: 'SOURCE_FROZEN',
    });
  });

  it('结单 → 只读', () => {
    expect(resolveSyncConflictReadOnly({ withdrawn: false, frozen: false, closed: true })).toEqual({
      readOnly: true,
      reason: 'SOURCE_CLOSED',
    });
  });

  it('多项成立时取最先成立的原因（删除优先于冻结、结单）', () => {
    expect(resolveSyncConflictReadOnly({ withdrawn: true, frozen: true, closed: true })).toEqual({
      readOnly: true,
      reason: 'SOURCE_WITHDRAWN',
    });
  });
});

/**
 * 采用云端视图的准入（R066）。
 *
 * 与"只读"口径的关键差别：**已结单允许只读采用**——
 * 允许有读取权的用户把云端内容呈现为本地视图，但不写业务记录、不改历史，
 * 采用者也不因此获得写入权；已删除／下架、冻结一律拒绝。
 */
describe('采用云端视图的准入（R066）', () => {
  it('可写内容：允许采用（非只读采用）', () => {
    expect(
      resolveSyncConflictCloudAdoption({ withdrawn: false, frozen: false, closed: false }),
    ).toEqual({ adoptable: true, reason: null, readOnlyAdoption: false });
  });

  it('已结单：允许**只读采用**', () => {
    expect(
      resolveSyncConflictCloudAdoption({ withdrawn: false, frozen: false, closed: true }),
    ).toEqual({ adoptable: true, reason: null, readOnlyAdoption: true });
  });

  it('已删除／下架：拒绝采用', () => {
    expect(
      resolveSyncConflictCloudAdoption({ withdrawn: true, frozen: false, closed: false }),
    ).toEqual({ adoptable: false, reason: 'SOURCE_WITHDRAWN', readOnlyAdoption: false });
  });

  it('冻结：拒绝采用', () => {
    expect(
      resolveSyncConflictCloudAdoption({ withdrawn: false, frozen: true, closed: false }),
    ).toEqual({ adoptable: false, reason: 'SOURCE_FROZEN', readOnlyAdoption: false });
  });

  it('多项成立时取最先成立的原因（删除优先于冻结、结单）', () => {
    expect(
      resolveSyncConflictCloudAdoption({ withdrawn: true, frozen: true, closed: true }),
    ).toEqual({ adoptable: false, reason: 'SOURCE_WITHDRAWN', readOnlyAdoption: false });
  });
});
