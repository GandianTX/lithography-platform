// src/modules/lithography/record-package-import.service.spec.ts

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RECORD_PACKAGE_ERROR } from '@core/common/errors/domain-error';

import {
  RecordPackageImportService,
  type RecordPackageEvaluation,
} from './record-package-import.service';

/**
 * 记录包检查事实落库单测（任务 09 S2.3；独立验收 P1 归属与并发）。
 *
 * 覆盖：
 * - 正式检查入口：包内同键重复整包拒绝；同 UUID 不同资源/版本按完整键接受；
 * - 同包重复检查返回既有批次（不产生第二个事实，也不刷新确认期失败结论）；
 * - 换包（同一 package_id、清单校验值变化）时旧预检失效并按新内容重新落事实；
 * - **归属边界（P1）**：`record_package_import.package_id` 是全局主键，
 *   同一个编号只可能有一行、只属于一个公司 ⇒ 其他公司同 ID 一律受控拒绝，
 *   零写入（不改归属、不删对方条目、不返回对方明细）；
 * - **并发（P1）**：唯一键冲突后用**当前读**回读赢家，再按同一归属/幂等口径处理。
 */
describe('record package import service', () => {
  const packageId = '11111111-2222-4333-8444-555555555555';
  const companyA = 4;
  const companyB = 9;

  function evaluation(
    checksum: string,
    passed: boolean,
    options: { targetOrganizationId?: number; items?: number } = {},
  ): RecordPackageEvaluation {
    const itemCount = options.items ?? 1;
    return {
      manifest: {
        package_id: packageId,
        organization_id: 4,
        items: [],
      },
      manifestRaw: '{"package_id":"' + packageId + '"}',
      manifestChecksum: checksum,
      targetOrganizationId: options.targetOrganizationId ?? companyA,
      outcomes: Array.from({ length: itemCount }, (_item, index) => ({
        recordUuid: `rec-${index + 1}`,
        resourceType: 'repair_request',
        versionNo: 1,
        passed,
        rejection: passed ? null : 'STRUCTURE_INVALID',
        message: passed ? null : '条目结构非法',
      })),
    } as unknown as RecordPackageEvaluation;
  }

  type ImportRow = {
    packageId: string;
    organizationId: number;
    importedByAccountId: number;
    manifestJson: string;
    manifestChecksum: string;
    status: string;
    checkStatus: string | null;
    itemTotal: number;
    itemSucceeded: number;
    itemFailed: number;
    createdAt: Date;
    completedAt: Date | null;
  };

  type ItemRow = {
    itemId?: string;
    packageId: string;
    recordUuid: string;
    resourceType: string;
    versionNo: number;
    checkResult: string;
    result: string | null;
    receiptId: string | null;
    errorMessage: string | null;
  };

  function buildService(options: {
    existingChecksum: string | null;
    existingOrganizationId?: number;
    existingStatus?: string;
    existingItems?: number;
    /** 既有批次的预检状态（缺省＝PASSED） */
    existingCheckStatus?: string | null;
    /** 既有批次的导入人（RUNNING 时即"占用人"） */
    existingImportedByAccountId?: number;
    /** 模拟并发：第一次插入时由"赢家"占用该编号并抛唯一键冲突 */
    raceWinner?: { organizationId: number; manifestChecksum: string };
  }) {
    const importRows = new Map<string, ImportRow>();
    const itemRows = new Map<string, ItemRow[]>();
    if (options.existingChecksum !== null) {
      importRows.set(packageId, {
        packageId,
        organizationId: options.existingOrganizationId ?? companyA,
        importedByAccountId: options.existingImportedByAccountId ?? 7,
        manifestJson: '{"package_id":"' + packageId + '"}',
        manifestChecksum: options.existingChecksum,
        status: options.existingStatus ?? 'PENDING',
        checkStatus:
          options.existingCheckStatus === undefined ? 'PASSED' : options.existingCheckStatus,
        itemTotal: options.existingItems ?? 1,
        itemSucceeded: options.existingStatus === 'SUCCEEDED' ? (options.existingItems ?? 1) : 0,
        itemFailed: 0,
        createdAt: new Date('2026-11-21T00:00:00.000Z'),
        completedAt:
          options.existingStatus === 'SUCCEEDED' ? new Date('2026-11-21T01:00:00.000Z') : null,
      });
      itemRows.set(
        packageId,
        Array.from({ length: options.existingItems ?? 1 }, (_item, index) => ({
          itemId: `item-${index + 1}`,
          packageId,
          recordUuid: `rec-${index + 1}`,
          resourceType: 'repair_request',
          versionNo: 1,
          checkResult: 'PASSED',
          result: options.existingStatus === 'SUCCEEDED' ? 'SUCCEEDED' : null,
          receiptId: null,
          errorMessage: null,
        })),
      );
    }

    // 写操作计数（用于断言"零写入"）
    const writes = { update: 0, delete: 0, insert: 0, itemInsert: 0, itemUpdate: 0 };

    const importRepository = {
      findOne: jest.fn().mockImplementation((input: { where: { packageId: string } }) => {
        const row = importRows.get(input.where.packageId);
        return Promise.resolve(row === undefined ? null : { ...row });
      }),
      create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
      insert: jest.fn().mockImplementation((row: ImportRow) => {
        if (options.raceWinner !== undefined && !importRows.has(row.packageId)) {
          // 并发赢家先插入并提交 ⇒ 本方插入命中唯一键冲突
          importRows.set(row.packageId, {
            ...row,
            organizationId: options.raceWinner.organizationId,
            manifestChecksum: options.raceWinner.manifestChecksum,
          });
          itemRows.set(row.packageId, []);
          const error = new Error('ER_DUP_ENTRY') as Error & { code: string };
          error.code = 'ER_DUP_ENTRY';
          return Promise.reject(error);
        }
        if (importRows.has(row.packageId)) {
          const error = new Error('ER_DUP_ENTRY') as Error & { code: string };
          error.code = 'ER_DUP_ENTRY';
          return Promise.reject(error);
        }
        writes.insert += 1;
        importRows.set(row.packageId, { ...row, createdAt: new Date(), completedAt: null });
        return Promise.resolve({ identifiers: [] });
      }),
      update: jest
        .fn()
        .mockImplementation(
          (
            where: { packageId: string; manifestChecksum?: string },
            patch: Record<string, unknown>,
          ) => {
            writes.update += 1;
            const current = importRows.get(where.packageId);
            if (current === undefined) {
              return Promise.resolve({ affected: 0 });
            }
            // 条件更新带清单摘要时，未命中即 0 行（版本已被替换）
            if (
              where.manifestChecksum !== undefined &&
              where.manifestChecksum !== current.manifestChecksum
            ) {
              return Promise.resolve({ affected: 0 });
            }
            importRows.set(where.packageId, { ...current, ...(patch as Partial<ImportRow>) });
            return Promise.resolve({ affected: 1 });
          },
        ),
    };
    const itemRepository = {
      create: jest.fn((row: Record<string, unknown>) => ({ ...row })),
      insert: jest.fn().mockImplementation((rows: ItemRow[]) => {
        writes.itemInsert += 1;
        const list = itemRows.get(rows[0]?.packageId ?? packageId) ?? [];
        const inserted = rows.map((row, index) => ({
          ...row,
          itemId: row.itemId ?? `item-${list.length + index + 1}`,
        }));
        itemRows.set(rows[0]?.packageId ?? packageId, [...list, ...inserted]);
        return Promise.resolve({ identifiers: [] });
      }),
      delete: jest.fn().mockImplementation((where: { packageId: string }) => {
        writes.delete += 1;
        itemRows.delete(where.packageId);
        return Promise.resolve({ affected: 1 });
      }),
      find: jest
        .fn()
        .mockImplementation((input: { where: { packageId: string } }) =>
          Promise.resolve(itemRows.get(input.where.packageId) ?? []),
        ),
      update: jest
        .fn()
        .mockImplementation(
          (where: { id: string; result?: unknown }, patch: Record<string, unknown>) => {
            writes.itemUpdate += 1;
            const requireNullResult =
              typeof where.result === 'object' &&
              where.result !== null &&
              'type' in where.result &&
              (where.result as { type?: string }).type === 'isNull';
            for (const [key, list] of itemRows) {
              const index = list.findIndex((item) => item.itemId === where.id);
              if (index >= 0) {
                if (requireNullResult && list[index].result !== null) {
                  return Promise.resolve({ affected: 0 });
                }
                const next = [...list];
                next[index] = { ...list[index], ...(patch as Partial<ItemRow>) };
                itemRows.set(key, next);
                return Promise.resolve({ affected: 1 });
              }
            }
            return Promise.resolve({ affected: 0 });
          },
        ),
      findOne: jest.fn().mockImplementation((input: { where: { id: string } }) => {
        for (const list of itemRows.values()) {
          const found = list.find((item) => item.itemId === input.where.id);
          if (found !== undefined) {
            return Promise.resolve({ ...found });
          }
        }
        return Promise.resolve(null);
      }),
    };
    const receiptRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const service = new RecordPackageImportService(
      importRepository as never,
      itemRepository as never,
      receiptRepository as never,
      { findOrganizationIdentityByCode: () => Promise.resolve(null) } as never,
    );

    return { service, importRows, itemRows, writes, receiptRepository };
  }

  const TEST_RECORD_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const TEST_RECORD_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

  const testItem = (
    recordUuid: string,
    resourceType: string,
    versionNo: number,
  ): Record<string, unknown> => ({
    record_uuid: recordUuid,
    resource_type: resourceType,
    version_no: versionNo,
    content_snapshot: { schema_version: 1, payload: { title: recordUuid } },
    files: [],
  });

  const withPackage = async <T>(
    items: Record<string, unknown>[],
    run: (packagePath: string) => Promise<T>,
  ): Promise<T> => {
    const packagePath = mkdtempSync(join(tmpdir(), 'task09-pkg-'));
    const raw = JSON.stringify({
      schema_version: 1,
      package_id: packageId,
      organization_id: companyA,
      installation_id: '48888888-9999-4aaa-8bbb-cccccccccccc',
      generated_at: '2026-11-25T00:00:00.000Z',
      items,
    });
    try {
      writeFileSync(join(packagePath, 'manifest.json'), raw, 'utf8');
      return await run(packagePath);
    } finally {
      rmSync(packagePath, { recursive: true, force: true });
    }
  };

  it('正式检查入口：包内同键重复是清单级错误，零批次/条目写入', async () => {
    const { service, writes, receiptRepository } = buildService({ existingChecksum: null });
    const evaluate = (packagePath: string) =>
      service.evaluatePackage({
        packagePath,
        organizationId: companyA,
        organizationCode: null,
        importedByAccountId: 7,
      });

    await expect(
      withPackage(
        [
          testItem(TEST_RECORD_A, 'REPAIR_REQUEST', 1),
          testItem(TEST_RECORD_A, 'REPAIR_REQUEST', 1),
          testItem(TEST_RECORD_B, 'MAINTENANCE_REPORT', 2),
        ],
        evaluate,
      ),
    ).rejects.toMatchObject({
      code: RECORD_PACKAGE_ERROR.INVALID_MANIFEST,
      message: expect.stringContaining('重复条目'),
    });
    expect(writes).toEqual({ update: 0, delete: 0, insert: 0, itemInsert: 0, itemUpdate: 0 });
    expect(receiptRepository.findOne).not.toHaveBeenCalled();
  });

  it('正式检查入口：同 UUID 不同资源/版本与不同键乱序均按完整键接受', async () => {
    const { service, writes } = buildService({ existingChecksum: null });

    const evaluation = await withPackage(
      [
        testItem(TEST_RECORD_B, 'REPAIR_REQUEST', 3),
        testItem(TEST_RECORD_A, 'MAINTENANCE_REPORT', 1),
        testItem(TEST_RECORD_A, 'REPAIR_REQUEST', 1),
      ],
      (packagePath) =>
        service.evaluatePackage({
          packagePath,
          organizationId: companyA,
          organizationCode: null,
          importedByAccountId: 7,
        }),
    );

    expect(evaluation.outcomes).toHaveLength(3);
    expect(evaluation.outcomes.map((outcome) => outcome.passed)).toEqual([true, true, true]);
    expect(writes).toEqual({ update: 0, delete: 0, insert: 0, itemInsert: 0, itemUpdate: 0 });
  });

  it('同包重复检查返回既有批次，不产生第二个事实', async () => {
    const { service, itemRows } = buildService({ existingChecksum: 'a'.repeat(64) });

    const result = await service.persistCheckOutcome(evaluation('a'.repeat(64), true), 7);

    expect(result.outcome).toBe('existing');
    expect(itemRows.get(packageId)).toHaveLength(1);
  });

  it('同摘要重检不会刷新确认期失败结论，受控处置须用新编号重导', async () => {
    const { service, itemRows, writes } = buildService({ existingChecksum: 'a'.repeat(64) });
    const row = itemRows.get(packageId)?.[0];
    if (row === undefined) {
      throw new Error('测试前提缺失：既有逐条事实不存在');
    }
    row.checkResult = 'REJECTED';
    row.result = null;
    row.errorMessage = '确认时原件摘要变化';
    const before = { ...row };

    const result = await service.persistCheckOutcome(evaluation('a'.repeat(64), true), 7);

    expect(result.outcome).toBe('existing');
    expect(itemRows.get(packageId)?.[0]).toEqual(before);
    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemUpdate).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });

  it('换包（同一 package_id、清单校验值变化）时旧预检失效并重新落事实', async () => {
    const { service, itemRows } = buildService({ existingChecksum: 'a'.repeat(64) });

    const result = await service.persistCheckOutcome(evaluation('b'.repeat(64), false), 7);

    expect(result.outcome).toBe('checked');
    expect(result.import.manifestChecksum).toBe('b'.repeat(64));
    expect(result.import.checkStatus).toBe('REJECTED');
    // 旧逐条结论被替换为新内容对应的结论。
    expect(itemRows.get(packageId)).toHaveLength(1);
    expect(itemRows.get(packageId)?.[0]).toMatchObject({
      packageId,
      recordUuid: 'rec-1',
      checkResult: 'REJECTED',
      result: null,
    });
  });

  it('混合检查结论：有合格条目即允许确认，硬阻断条目逐条显示但不计入导入失败', async () => {
    const { service } = buildService({ existingChecksum: null });
    const mixed: RecordPackageEvaluation = {
      manifest: { package_id: packageId, organization_id: 4, items: [] },
      manifestRaw: '{"package_id":"' + packageId + '"}',
      manifestChecksum: 'c'.repeat(64),
      targetOrganizationId: companyA,
      outcomes: [
        {
          recordUuid: 'rec-pass',
          resourceType: 'repair_request',
          versionNo: 1,
          passed: true,
          rejection: null,
          message: null,
        },
        {
          recordUuid: 'rec-blocked',
          resourceType: 'repair_request',
          versionNo: 1,
          passed: false,
          rejection: 'FILE_MISSING',
          message: '缺少原件文件',
        },
      ],
    } as unknown as RecordPackageEvaluation;

    const result = await service.persistCheckOutcome(mixed, 7);

    expect(result.import.checkStatus).toBe('PASSED');
    expect(result.import.itemFailed).toBe(0);
    expect(result.items.map((item) => item.checkResult)).toEqual(['PASSED', 'REJECTED']);
    expect(result.items[1]?.errorMessage).toBe('缺少原件文件');
  });

  // ── 归属边界（P1）：其他公司同编号一律受控拒绝，零写入、零泄露 ──────────────
  it('其他公司同编号（不同清单）：受控拒绝，零写入，A 公司数据逐字段不变', async () => {
    const { service, importRows, itemRows, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
      existingStatus: 'SUCCEEDED',
      existingItems: 3,
    });
    const before = { ...importRows.get(packageId) };
    const itemsBefore = [...(itemRows.get(packageId) ?? [])];

    await expect(
      service.persistCheckOutcome(
        evaluation('b'.repeat(64), true, { targetOrganizationId: companyB }),
        88,
      ),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    // 零写入：不改归属、不删对方条目、不插新条目
    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.insert).toBe(0);
    expect(writes.itemInsert).toBe(0);
    // A 公司数据逐字段不变
    expect(importRows.get(packageId)).toEqual(before);
    expect(itemRows.get(packageId)).toEqual(itemsBefore);
  });

  it('其他公司同编号（同摘要）：受控拒绝，不返回对方批次与逐条明细', async () => {
    const { service, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
      existingStatus: 'SUCCEEDED',
      existingItems: 3,
    });

    await expect(
      service.persistCheckOutcome(
        evaluation('a'.repeat(64), true, { targetOrganizationId: companyB }),
        88,
      ),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });

  it('同公司同摘要：幂等返回既有事实，不产生第二次写', async () => {
    const { service, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
    });

    const result = await service.persistCheckOutcome(
      evaluation('a'.repeat(64), true, { targetOrganizationId: companyA }),
      7,
    );

    expect(result.outcome).toBe('existing');
    expect(result.import.organizationId).toBe(companyA);
    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });

  it('批次正在导入（RUNNING）时换包重检：受控拒绝，不覆盖正在执行的事实', async () => {
    const { service, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
      existingStatus: 'RUNNING',
      existingItems: 2,
    });

    await expect(
      service.persistCheckOutcome(
        evaluation('b'.repeat(64), true, { targetOrganizationId: companyA }),
        7,
      ),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });

    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });

  // ── 占用与版本绑定（复验 P1）：导入确认必须绑定到同一批次版本 ────────────────
  it('占用：批次摘要已被换包重检替换（旧确认失效）⇒ 受控拒绝，零写入', async () => {
    const { service, importRows, writes } = buildService({
      existingChecksum: 'b'.repeat(64),
      existingOrganizationId: companyA,
      existingItems: 2,
    });
    const before = { ...importRows.get(packageId) };

    await expect(
      service.claimImportRun({
        packageId,
        importedByAccountId: 7,
        organizationId: companyA,
        manifestChecksum: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED });

    expect(writes.update).toBe(0);
    expect(importRows.get(packageId)).toEqual(before);
  });

  it('占用：批次归属公司与本次可信目标公司不一致 ⇒ 受控拒绝，零写入', async () => {
    const { service, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
    });

    await expect(
      service.claimImportRun({
        packageId,
        importedByAccountId: 7,
        organizationId: companyB,
        manifestChecksum: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    expect(writes.update).toBe(0);
  });

  it('占用：批次未通过预检 ⇒ 受控拒绝，零写入', async () => {
    const { service, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
      existingCheckStatus: 'REJECTED',
    });

    await expect(
      service.claimImportRun({
        packageId,
        importedByAccountId: 7,
        organizationId: companyA,
        manifestChecksum: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_NOT_PASSED });

    expect(writes.update).toBe(0);
  });

  it('占用：批次已被他人占用（RUNNING 且占用人不同）⇒ 受控拒绝，不暴露占用人身份', async () => {
    const { service, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
      existingStatus: 'RUNNING',
      existingImportedByAccountId: 4242,
    });

    await expect(
      service.claimImportRun({
        packageId,
        importedByAccountId: 7,
        organizationId: companyA,
        manifestChecksum: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });

    expect(writes.update).toBe(0);
  });

  it('占用：同一账号对自己的 RUNNING 批次也受控拒绝（账号不是独占凭据，无自动接管）', async () => {
    const { service, importRows, writes } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
      existingStatus: 'RUNNING',
      existingImportedByAccountId: 7,
      existingItems: 2,
    });

    await expect(
      service.claimImportRun({
        packageId,
        importedByAccountId: 7,
        organizationId: companyA,
        manifestChecksum: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_IN_PROGRESS });

    expect(writes.update).toBe(0);
    expect(importRows.get(packageId)?.status).toBe('RUNNING');
  });

  it('终态收敛：只更新本次占用的摘要，版本已变时受控拒绝（不把旧版本记到新版本）', async () => {
    const { service, importRows } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
    });

    await expect(
      service.finalizeImport(
        packageId,
        { status: 'SUCCEEDED', succeeded: 1, failed: 0 },
        'b'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED });

    expect(importRows.get(packageId)?.status).toBe('PENDING');
  });

  it('确认期检查失败：未执行条目改判 REJECTED 且导入结果保持 NULL', async () => {
    const { service, itemRows } = buildService({ existingChecksum: 'a'.repeat(64) });

    await service.markItemCheckRejected('item-1', '确认时原件摘要变化');

    expect(itemRows.get(packageId)?.[0]).toMatchObject({
      checkResult: 'REJECTED',
      result: null,
      errorMessage: '确认时原件摘要变化',
    });
  });

  it('确认期检查失败：已有导入结果的条目不覆盖历史结果', async () => {
    const { service, itemRows } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingStatus: 'SUCCEEDED',
    });

    await service.markItemCheckRejected('item-1', '确认时原件摘要变化');

    expect(itemRows.get(packageId)?.[0]).toMatchObject({
      checkResult: 'PASSED',
      result: 'SUCCEEDED',
      errorMessage: null,
    });
  });

  it('逐条结果：条目行已随版本被替换 ⇒ 受控拒绝（不静默吞掉 0 行）', async () => {
    const { service } = buildService({
      existingChecksum: 'a'.repeat(64),
      existingOrganizationId: companyA,
    });

    await expect(
      service.writeItemResult('item-vanished', {
        result: 'SUCCEEDED',
        errorMessage: null,
        receiptId: null,
      }),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.IMPORT_VERSION_CHANGED });
  });

  // ── 并发（P1）：唯一键冲突后用当前读回读赢家 ────────────────────────────────
  it('并发插入同编号（跨公司）：冲突后当前读回读赢家，受控拒绝且零写入', async () => {
    const { service, writes } = buildService({
      existingChecksum: null,
      raceWinner: { organizationId: companyA, manifestChecksum: 'a'.repeat(64) },
    });

    await expect(
      service.persistCheckOutcome(
        evaluation('b'.repeat(64), true, { targetOrganizationId: companyB }),
        88,
      ),
    ).rejects.toMatchObject({ code: RECORD_PACKAGE_ERROR.PACKAGE_ID_CONFLICT });

    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });

  it('并发插入同编号（同公司不同摘要）：经锁完整重检，不假称是同一个包', async () => {
    const { service, importRows, itemRows } = buildService({
      existingChecksum: null,
      raceWinner: { organizationId: companyA, manifestChecksum: 'a'.repeat(64) },
    });

    const result = await service.persistCheckOutcome(
      evaluation('b'.repeat(64), true, { targetOrganizationId: companyA, items: 2 }),
      7,
    );

    expect(result.outcome).toBe('checked');
    expect(result.import.manifestChecksum).toBe('b'.repeat(64));
    expect(result.import.organizationId).toBe(companyA);
    expect(itemRows.get(packageId)).toHaveLength(2);
    expect(importRows.get(packageId)?.manifestChecksum).toBe('b'.repeat(64));
  });

  it('并发插入同编号（同公司同摘要）：幂等返回赢家事实，不重复落事实', async () => {
    const { service, writes } = buildService({
      existingChecksum: null,
      raceWinner: { organizationId: companyA, manifestChecksum: 'a'.repeat(64) },
    });

    const result = await service.persistCheckOutcome(
      evaluation('a'.repeat(64), true, { targetOrganizationId: companyA }),
      7,
    );

    expect(result.outcome).toBe('existing');
    expect(result.import.organizationId).toBe(companyA);
    expect(writes.update).toBe(0);
    expect(writes.delete).toBe(0);
    expect(writes.itemInsert).toBe(0);
  });
});
