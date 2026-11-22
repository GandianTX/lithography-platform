/// <reference types="jest" />
import { resolveSyncConflictReadOnly } from './sync-conflict-readonly.policy';

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
