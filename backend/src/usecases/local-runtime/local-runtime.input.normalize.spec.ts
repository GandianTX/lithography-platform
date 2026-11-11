// src/usecases/local-runtime/local-runtime.input.normalize.spec.ts
// G-1 备份触发类型契约纯函数单测：类型层覆盖 DB CHECK 的全部取值，
// 但用户输入白名单仅旧三值；AUTO/RETRY 为系统触发，不接受客户端输入。

import { normalizeBackupTrigger } from './local-runtime.input.normalize';
import type { LocalBackupTriggerType } from '@src/modules/lithography/local-runtime.types';

// 数据库 chk_local_backup_run_trigger 允许的全部取值（与迁移 1775501100000 一致）。
const DB_CHECK_TRIGGER_VALUES = ['SCHEDULED', 'MANUAL', 'AUTO', 'RETRY', 'USB_EXPORT'] as const;

// 编译期断言：DB CHECK 的每个取值都必须能被 LocalBackupTriggerType 表示。
type DbValuesAreRepresentable =
  (typeof DB_CHECK_TRIGGER_VALUES)[number] extends LocalBackupTriggerType ? true : false;
const dbValuesAreRepresentable: DbValuesAreRepresentable = true;

describe('G-1 LocalBackupTriggerType 契约', () => {
  it('类型层覆盖 DB CHECK 全部 5 个取值（含 AUTO/RETRY）', () => {
    expect(dbValuesAreRepresentable).toBe(true);
    expect(DB_CHECK_TRIGGER_VALUES).toHaveLength(5);
    expect(DB_CHECK_TRIGGER_VALUES).toEqual(
      expect.arrayContaining(['AUTO', 'RETRY', 'SCHEDULED', 'MANUAL', 'USB_EXPORT']),
    );
  });

  it('用户输入接受旧三值 SCHEDULED/MANUAL/USB_EXPORT', () => {
    expect(normalizeBackupTrigger('SCHEDULED')).toBe('SCHEDULED');
    expect(normalizeBackupTrigger('MANUAL')).toBe('MANUAL');
    expect(normalizeBackupTrigger('USB_EXPORT')).toBe('USB_EXPORT');
  });

  it('用户输入拒绝 AUTO/RETRY（系统触发值，不允许客户端发起）', () => {
    expect(() => normalizeBackupTrigger('AUTO')).toThrow();
    expect(() => normalizeBackupTrigger('RETRY')).toThrow();
  });

  it('用户输入拒绝未知取值', () => {
    expect(() => normalizeBackupTrigger('UNKNOWN')).toThrow();
  });
});
