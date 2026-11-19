// src/features/repair-request/application/repair-request-closure-draft-guard.spec.ts

import { describe, expect, it } from 'vitest';

import {
  MAINTENANCE_DRAFT_GUARD_IDLE,
  resolveMaintenanceClosureBlockReason,
} from './repair-request-closure-draft-guard';

describe(resolveMaintenanceClosureBlockReason.name, () => {
  it('无草稿差异且无在途写入：放行结单', () => {
    expect(resolveMaintenanceClosureBlockReason(MAINTENANCE_DRAFT_GUARD_IDLE)).toBeNull();
  });

  it('存在未保存维修内容：拦截结单', () => {
    expect(
      resolveMaintenanceClosureBlockReason({ hasUnsavedChanges: true, writePending: false }),
    ).toBe('unsaved-changes');
  });

  it('保存中或最新版本尚未读回：优先按写入未落定拦截', () => {
    expect(
      resolveMaintenanceClosureBlockReason({ hasUnsavedChanges: true, writePending: true }),
    ).toBe('write-pending');
    expect(
      resolveMaintenanceClosureBlockReason({ hasUnsavedChanges: false, writePending: true }),
    ).toBe('write-pending');
  });
});
