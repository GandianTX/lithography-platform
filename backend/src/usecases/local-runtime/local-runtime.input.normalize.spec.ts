// src/usecases/local-runtime/local-runtime.input.normalize.spec.ts
// G-1 备份触发类型契约纯函数单测：类型层覆盖 DB CHECK 的全部取值，
// 但用户输入白名单仅旧三值；AUTO/RETRY 为系统触发，不接受客户端输入。

import { normalizeBackupTrigger, normalizeUploadIntent } from './local-runtime.input.normalize';
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

describe('业务同步身份事实归一（S2.1）', () => {
  const baseCommand = {
    entityType: 'REPORT_VERSION',
    entityLocalId: 12,
    entityVersion: '3',
    idempotencyKey: 'business-sync:11111111-2222-4333-8444-555555555555:3',
    recordUuid: '11111111-2222-4333-8444-555555555555',
    sourceVersion: 3,
    manifestChecksum: 'a'.repeat(64),
    organizationId: 9,
    accountId: 5,
  };

  it('业务同步任务必须带齐身份事实（缺一即失败关闭）', () => {
    const intent = normalizeUploadIntent(baseCommand);

    expect(intent.taskKind).toBe('BUSINESS_SYNC');
    expect(intent.recordUuid).toBe(baseCommand.recordUuid);
    expect(intent.sourceVersion).toBe(3);
    expect(intent.manifestChecksum).toBe(baseCommand.manifestChecksum);
    expect(intent.organizationId).toBe(9);
    expect(intent.accountId).toBe(5);
  });

  it('缺少稳定键／版本／摘要／公司／原账号任一项都不登记任务', () => {
    const cases: (keyof typeof baseCommand)[] = [
      'recordUuid',
      'sourceVersion',
      'manifestChecksum',
      'organizationId',
      'accountId',
    ];
    for (const key of cases) {
      expect(() => normalizeUploadIntent({ ...baseCommand, [key]: null })).toThrow(/身份事实/);
    }
  });

  it('备份类任务不要求业务身份事实（备份包不得记为业务同步）', () => {
    const intent = normalizeUploadIntent({
      entityType: 'BACKUP_MANIFEST',
      entityLocalId: 1,
      entityVersion: '1',
      idempotencyKey: 'backup:1',
    });

    expect(intent.taskKind).toBe('BACKUP_UPLOAD');
    expect(intent.recordUuid).toBeNull();
    expect(intent.accountId).toBeNull();
  });

  it('稳定键必须是 36 位 UUID 文本；版本必须是正整数', () => {
    expect(() => normalizeUploadIntent({ ...baseCommand, recordUuid: 'not-a-uuid' })).toThrow();
    expect(() => normalizeUploadIntent({ ...baseCommand, sourceVersion: 0 })).toThrow();
    expect(() => normalizeUploadIntent({ ...baseCommand, sourceVersion: 1.5 })).toThrow();
  });

  it('摘要必须是 64 位十六进制；任务种类必须是受控取值', () => {
    expect(() => normalizeUploadIntent({ ...baseCommand, manifestChecksum: 'zz' })).toThrow();
    expect(() => normalizeUploadIntent({ ...baseCommand, taskKind: 'OTHER' })).toThrow();
  });
});
