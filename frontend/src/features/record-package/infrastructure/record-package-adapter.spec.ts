// src/features/record-package/infrastructure/record-package-adapter.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeGraphQL = vi.fn();

vi.mock('@/shared/graphql', () => ({
  executeGraphQL: (...args: unknown[]) => executeGraphQL(...args),
}));

import { exportRecordPackage, normalizeRecordIds } from './record-package-adapter';

const RESULT = {
  packageId: 'pkg-1',
  packagePath: '/mnt/usb/pkg',
  organizationId: 9,
  resourceType: 'REPAIR_REQUEST',
  manifestChecksum: 'a'.repeat(64),
  itemTotal: 1,
  itemExported: 1,
  itemFailed: 0,
  items: [],
};

describe('记录包导出适配层', () => {
  beforeEach(() => {
    executeGraphQL.mockClear();
    executeGraphQL.mockResolvedValue({ exportRecordPackage: RESULT });
  });

  it('混合导出：entries 按 GraphQL 契约透传', async () => {
    executeGraphQL.mockResolvedValue({ exportRecordPackage: RESULT });

    await exportRecordPackage({
      targetPath: '/mnt/usb/pkg',
      resourceType: 'REPAIR_REQUEST',
      recordIds: [],
      entries: [{ resourceType: 'MAINTENANCE_REPORT', recordId: 7 }],
    });

    const [query, variables] = executeGraphQL.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('$entries: [RecordPackageExportEntryInput!]');
    expect(query).toContain('entries: $entries');
    expect(variables.entries).toEqual([{ resourceType: 'MAINTENANCE_REPORT', recordId: 7 }]);
  });

  it('未提供混合条目时 entries 传 null（沿用旧的单一类型形态）', async () => {
    executeGraphQL.mockResolvedValue({ exportRecordPackage: RESULT });

    await exportRecordPackage({
      targetPath: '/mnt/usb/pkg',
      resourceType: 'MAINTENANCE_REPORT',
      recordIds: [12],
    });

    const [, variables] = executeGraphQL.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.entries).toBeNull();
  });

  it('记录 ID 归一化为正整数（多值输入控件给出的是字符串）', async () => {
    executeGraphQL.mockResolvedValue({ exportRecordPackage: RESULT });

    await exportRecordPackage({
      targetPath: '/mnt/usb/pkg',
      resourceType: 'REPAIR_REQUEST',
      recordIds: ['12', ' 13 ', 'x', 0, -1],
    });

    const [, variables] = executeGraphQL.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.recordIds).toEqual([12, 13]);
    expect(normalizeRecordIds(['7'])).toEqual([7]);
  });
});
