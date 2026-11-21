// src/modules/lithography/record-package-import.service.spec.ts

import {
  RecordPackageImportService,
  type RecordPackageEvaluation,
} from './record-package-import.service';

/**
 * 记录包检查事实落库单测（任务 09 S2.3）。
 *
 * 覆盖：同包重复检查返回既有批次（不产生第二个事实）；
 * 换包（同一 package_id、清单校验值变化）时旧预检失效并按新内容重新落事实。
 */
describe('record package import service', () => {
  const packageId = '11111111-2222-4333-8444-555555555555';

  function evaluation(checksum: string, passed: boolean): RecordPackageEvaluation {
    return {
      manifest: {
        package_id: packageId,
        organization_id: 4,
        items: [],
      },
      manifestRaw: '{"package_id":"' + packageId + '"}',
      manifestChecksum: checksum,
      outcomes: [
        {
          recordUuid: 'rec-1',
          resourceType: 'repair_request',
          versionNo: 1,
          passed,
          rejection: passed ? null : 'STRUCTURE_INVALID',
          message: passed ? null : '条目结构非法',
        },
      ],
    } as unknown as RecordPackageEvaluation;
  }

  function buildService(options: { existingChecksum: string | null }) {
    const importRows = new Map<string, Record<string, unknown>>();
    if (options.existingChecksum !== null) {
      importRows.set(packageId, {
        packageId,
        organizationId: 4,
        importedByAccountId: 7,
        manifestJson: '{}',
        manifestChecksum: options.existingChecksum,
        status: 'PENDING',
        checkStatus: 'PASSED',
        itemTotal: 1,
        itemSucceeded: 1,
        itemFailed: 0,
        createdAt: new Date('2026-11-21T00:00:00.000Z'),
        completedAt: null,
      });
    }
    const itemRows: Record<string, unknown>[] = [];

    const importRepository = {
      findOne: jest
        .fn()
        .mockImplementation((input: { where: { packageId: string } }) =>
          Promise.resolve(importRows.get(input.where.packageId) ?? null),
        ),
      create: jest.fn((row: Record<string, unknown>) => row),
      insert: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        importRows.set(packageId, { ...row, createdAt: new Date(), completedAt: null });
        return Promise.resolve({ identifiers: [] });
      }),
      update: jest
        .fn()
        .mockImplementation((where: { packageId: string }, patch: Record<string, unknown>) => {
          importRows.set(where.packageId, { ...importRows.get(where.packageId), ...patch });
          return Promise.resolve({ affected: 1 });
        }),
    };
    const itemRepository = {
      create: jest.fn((row: Record<string, unknown>) => row),
      insert: jest.fn().mockImplementation((rows: Record<string, unknown>[]) => {
        itemRows.push(...rows);
        return Promise.resolve({ identifiers: [] });
      }),
      delete: jest.fn().mockImplementation(() => {
        itemRows.length = 0;
        return Promise.resolve({ affected: 0 });
      }),
      find: jest.fn().mockResolvedValue(itemRows),
    };
    const receiptRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const service = new RecordPackageImportService(
      importRepository as never,
      itemRepository as never,
      receiptRepository as never,
    );

    return { service, importRows, itemRows };
  }

  it('同包重复检查返回既有批次，不产生第二个事实', async () => {
    const { service, itemRows } = buildService({ existingChecksum: 'a'.repeat(64) });

    const result = await service.persistCheckOutcome(evaluation('a'.repeat(64), true), 7);

    expect(result.outcome).toBe('existing');
    expect(itemRows).toHaveLength(0);
  });

  it('换包（同一 package_id、清单校验值变化）时旧预检失效并重新落事实', async () => {
    const { service, itemRows } = buildService({ existingChecksum: 'a'.repeat(64) });

    const result = await service.persistCheckOutcome(evaluation('b'.repeat(64), false), 7);

    expect(result.outcome).toBe('checked');
    expect(result.import.manifestChecksum).toBe('b'.repeat(64));
    expect(result.import.checkStatus).toBe('REJECTED');
    // 旧逐条结论被替换为新内容对应的结论。
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]).toMatchObject({
      packageId,
      recordUuid: 'rec-1',
      checkResult: 'REJECTED',
      result: null,
    });
  });
});
