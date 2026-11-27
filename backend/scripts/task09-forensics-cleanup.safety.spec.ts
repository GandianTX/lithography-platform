// backend/scripts/task09-forensics-cleanup.safety.spec.ts

/**
 * 取证脚本收尾纪律的**安全反例**（任务 09 剩余问题 02）。
 *
 * 覆盖计划要求的四类反例：
 * 1. **伪造归属／外部引用** → 删除前拒绝（不得删掉归属不符的行）；
 * 2. **后续 SQL 删除注入失败** → **无部分提交**（同一事务整体回滚）；
 * 3. **文件删除失败** → 收尾必须报错（不得静默通过）；
 * 4. **哨兵字节／字段被改** → 断言失败（不得用"数量不变"糊弄）。
 *
 * 关键纪律：这里用**替身数据库**证明收尾语义，
 * **不关闭**任何真实安全守卫，也不触碰任何真实库。
 */

/// <reference types="jest" />
import {
  buildCleanupError,
  assertSentinelsUnchanged,
  type SentinelSnapshot,
} from './task09-restore-selfcheck.safety';

import {
  CleanupIssueLog,
  collectResidue,
  compareSentinelEntries,
  decideAuditEventOwnership,
  decideForensicsFileCleanup,
  planForensicsCleanupSteps,
  runAtomicForensicsCleanup,
  type ForensicsCleanupExecutor,
  type ForensicsCleanupStep,
} from './task09-forensics-cleanup.safety';

type Row = Record<string, unknown>;

/** 迷你替身数据库：只支持本模块用到的 `DELETE FROM t WHERE col = ? [AND col = ?]` */
function createFakeDatabase(
  initial: Readonly<Record<string, readonly Row[]>>,
  options: { readonly failOnCall?: number } = {},
) {
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(initial)) {
    tables[table] = rows.map((row) => ({ ...row }));
  }
  let calls = 0;
  const snapshot = (): Record<string, Row[]> => {
    const copy: Record<string, Row[]> = {};
    for (const [table, rows] of Object.entries(tables)) {
      copy[table] = rows.map((row) => ({ ...row }));
    }
    return copy;
  };
  const restore = (backup: Record<string, Row[]>): void => {
    for (const key of Object.keys(tables)) {
      delete tables[key];
    }
    for (const [table, rows] of Object.entries(backup)) {
      tables[table] = rows;
    }
  };
  const applyDelete = (sql: string, params?: readonly unknown[]): void => {
    const matched = /^DELETE FROM ([A-Za-z_][A-Za-z0-9_]*) WHERE (.+)$/u.exec(sql);
    if (matched === null) {
      throw new Error(`替身不支持的 SQL：${sql}`);
    }
    const table = matched[1];
    const conditions = matched[2].split(' AND ').map((clause) => clause.split(' = '));
    const values = params ?? [];
    // DELETE 的语义：**命中条件**的行被删掉，其余原样留下
    tables[table] = (tables[table] ?? []).filter(
      (row) => !conditions.every(([column], index) => row[column] === values[index]),
    );
  };

  const executor: ForensicsCleanupExecutor = {
    transaction: async <T>(
      run: (tx: {
        query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T> => {
      const backup = snapshot();
      try {
        return await run({
          query: (sql: string, params?: readonly unknown[]): Promise<unknown> => {
            calls += 1;
            if (options.failOnCall !== undefined && calls === options.failOnCall) {
              return Promise.reject(new Error('注入的删除失败'));
            }
            applyDelete(sql, params);
            return Promise.resolve({ affectedRows: 1 });
          },
        });
      } catch (error: unknown) {
        // 事务回滚：任何一步失败 ⇒ 之前已执行的语句一并撤销
        restore(backup);
        throw error;
      }
    },
  };

  return { tables, executor };
}

const HOLD_STEP: ForensicsCleanupStep = {
  table: 'local_write_hold',
  idColumn: 'hold_id',
  id: 'hold-1',
  ownership: '本轮创建的冻结',
  conditions: { installation_id: 'inst-1', organization_id: 1 },
};

describe('取证脚本收尾 · 删除计划', () => {
  it('只允许受控表内的对象（清单外的表直接拒绝）', () => {
    expect(() =>
      planForensicsCleanupSteps([
        { ...HOLD_STEP, table: 'base_user_account_info', idColumn: 'id' },
      ]),
    ).toThrow(/受控顺序表/u);
  });

  it('拒绝不合法的列名（不把标识符拼进 SQL 的风险留在外面）', () => {
    expect(() =>
      planForensicsCleanupSteps([
        { ...HOLD_STEP, idColumn: 'hold_id; DROP TABLE local_write_hold' },
      ]),
    ).toThrow(/不合法的列名/u);
  });

  it('按"先子后父"排序（子表先于父表被删）', () => {
    const plan = planForensicsCleanupSteps([
      { table: 'base_user_account', idColumn: 'id', id: '1', ownership: '本轮账号' },
      { table: 'stored_file', idColumn: 'file_id', id: 'f1', ownership: '本轮暂存原件' },
      HOLD_STEP,
    ]);
    expect(plan.map((step) => step.table)).toEqual([
      'stored_file',
      'local_write_hold',
      'base_user_account',
    ]);
  });

  it('同一主键重复出现只保留一条', () => {
    const plan = planForensicsCleanupSteps([HOLD_STEP, HOLD_STEP]);
    expect(plan).toHaveLength(1);
  });
});

describe('取证脚本收尾 · 精确删除与归属条件', () => {
  it('**伪造归属**的行不会被删（归属条件进 WHERE）', async () => {
    const fake = createFakeDatabase({
      local_write_hold: [
        { hold_id: 'hold-1', installation_id: 'inst-1', organization_id: 1 },
        { hold_id: 'hold-1', installation_id: 'inst-OTHER', organization_id: 1 },
      ],
    });
    const result = await runAtomicForensicsCleanup([HOLD_STEP], fake.executor);
    expect(result.ok).toBe(true);
    // 归属不符的那一行仍在（只删掉了归属相符的那一行）
    expect(fake.tables['local_write_hold']).toEqual([
      { hold_id: 'hold-1', installation_id: 'inst-OTHER', organization_id: 1 },
    ]);
  });

  it('**后续 SQL 删除注入失败** ⇒ 整体回滚（无部分提交）', async () => {
    const fake = createFakeDatabase(
      {
        local_write_hold: [{ hold_id: 'hold-1', installation_id: 'inst-1', organization_id: 1 }],
        stored_file: [{ file_id: 'f1', uploaded_by_account_id: 900 }],
      },
      { failOnCall: 2 },
    );
    const result = await runAtomicForensicsCleanup(
      [
        { table: 'stored_file', idColumn: 'file_id', id: 'f1', ownership: '本轮暂存原件' },
        HOLD_STEP,
      ],
      fake.executor,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failedStep?.table).toBe('local_write_hold');
      expect(result.error).toBeInstanceOf(Error);
    }
    // 第一步虽已执行，但事务整体回滚 ⇒ 两张表都回到原样（**无部分提交**）
    expect(fake.tables['stored_file']).toHaveLength(1);
    expect(fake.tables['local_write_hold']).toHaveLength(1);
  });
});

describe('取证脚本收尾 · 问题不得被吞掉', () => {
  it('收尾问题逐条留痕（不静默丢弃）', () => {
    const log = new CleanupIssueLog();
    expect(log.hasIssues).toBe(false);
    log.record('文件删除失败：/tmp/x');
    log.recordError('数据库清理', new Error('注入的失败'));
    expect(log.hasIssues).toBe(true);
    expect(log.list).toHaveLength(2);
    expect(log.list.join(' | ')).toContain('注入的失败');
  });

  it('**文件删除失败** ⇒ 收尾必须报错（不得静默通过）', () => {
    const log = new CleanupIssueLog();
    log.record('文件删除失败：/controlled/root/a.pdf：注入的删除失败');
    const error = buildCleanupError(null, {
      errors: [...log.list],
      deleted: [],
      failed: [],
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('文件删除失败');
  });

  it('主因与清理错误**同时保留**', () => {
    const mainError = new Error('主因');
    const error = buildCleanupError(mainError, {
      errors: ['清理错误'],
      deleted: [],
      failed: [],
    });
    expect(error).toBe(mainError);
    expect((error as Error & { cleanupErrors?: readonly string[] }).cleanupErrors).toContain(
      '清理错误',
    );
  });
});

describe('取证脚本收尾 · 残留与哨兵', () => {
  it('本轮零残留：没有残留行时不产生问题', () => {
    expect(
      collectResidue([
        { label: '本轮创建的冻结', rows: 0 },
        { label: '本轮暂存原件', rows: 0 },
      ]),
    ).toEqual([]);
  });

  it('本轮零残留：仍有残留行时如实报出问题', () => {
    expect(
      collectResidue([
        { label: '本轮创建的冻结', rows: 2 },
        { label: '本轮暂存原件', rows: 0 },
      ]),
    ).toEqual(['本轮创建的冻结 仍有 2 行／项残留']);
  });

  it('哨兵字段被改写 ⇒ 断言失败（不得用"数量不变"糊弄）', () => {
    const before: SentinelSnapshot[] = [{ label: '外公司冻结#h1', fingerprint: 'status=ACTIVE' }];
    const after: SentinelSnapshot[] = [{ label: '外公司冻结#h1', fingerprint: 'status=RELEASED' }];
    expect(() => assertSentinelsUnchanged(before, after)).toThrow(/非目标哨兵发生变化/u);
  });

  it('哨兵字节摘要被改写 ⇒ 断言失败', () => {
    const before: SentinelSnapshot[] = [
      { label: 'file:a.pdf', fingerprint: 'sha256:aaa;bytes=10' },
    ];
    const after: SentinelSnapshot[] = [{ label: 'file:a.pdf', fingerprint: 'sha256:bbb;bytes=10' }];
    expect(() => assertSentinelsUnchanged(before, after)).toThrow(/非目标哨兵发生变化/u);
  });

  it('非目标不变：指纹一致时通过', () => {
    const snapshots: SentinelSnapshot[] = [
      { label: '外公司冻结#h1', fingerprint: 'status=ACTIVE' },
      { label: 'file:a.pdf', fingerprint: 'sha256:aaa;bytes=10' },
    ];
    expect(() => assertSentinelsUnchanged(snapshots, snapshots)).not.toThrow();
  });
});

describe('取证脚本收尾 · 哨兵比对（三个维度分开看）', () => {
  it('非目标对象消失 ⇒ 报 missing', () => {
    const comparison = compareSentinelEntries(
      [{ label: '外公司冻结#h1', fingerprint: 'status=ACTIVE' }],
      [],
    );
    expect(comparison.missing).toEqual(['外公司冻结#h1']);
    expect(comparison.changed).toEqual([]);
    expect(comparison.added).toEqual([]);
  });

  it('非目标对象被改写 ⇒ 报 changed', () => {
    const comparison = compareSentinelEntries(
      [{ label: '外公司冻结#h1', fingerprint: 'status=ACTIVE' }],
      [{ label: '外公司冻结#h1', fingerprint: 'status=RELEASED' }],
    );
    expect(comparison.changed).toEqual(['外公司冻结#h1']);
    expect(comparison.missing).toEqual([]);
  });

  it('新出现的对象单独归入 added（不与"被改写"混淆）', () => {
    const comparison = compareSentinelEntries(
      [{ label: '外公司冻结#h1', fingerprint: 'status=ACTIVE' }],
      [
        { label: '外公司冻结#h1', fingerprint: 'status=ACTIVE' },
        { label: 'file:本轮新写.pdf', fingerprint: 'sha256:ccc;bytes=147' },
      ],
    );
    expect(comparison.added).toEqual(['file:本轮新写.pdf']);
    expect(comparison.missing).toEqual([]);
    expect(comparison.changed).toEqual([]);
  });

  it('完全一致时三个维度都为空', () => {
    const comparison = compareSentinelEntries(
      [{ label: 'file:a.pdf', fingerprint: 'sha256:aaa;bytes=10' }],
      [{ label: 'file:a.pdf', fingerprint: 'sha256:aaa;bytes=10' }],
    );
    expect(comparison).toEqual({ missing: [], changed: [], added: [] });
  });
});
describe('取证脚本收尾 · 文件清理裁决（P2-1：数据库失败后不得删字节）', () => {
  it('数据库清理失败 ⇒ 一个字节都不删（不做"行在、字节丢"的部分清理）', () => {
    const decision = decideForensicsFileCleanup({
      databaseCleanupOk: false,
      references: ['a.pdf', 'b.pdf'],
    });
    expect(decision.deletable).toEqual([]);
    expect(decision.kept).toEqual(['a.pdf', 'b.pdf']);
    expect(decision.reason).toContain('数据库清理失败');
  });

  it('数据库清理成功且无登记行残留 ⇒ 精确回收全部本轮字节', () => {
    const decision = decideForensicsFileCleanup({
      databaseCleanupOk: true,
      references: ['a.pdf', 'b.pdf'],
      referencedByLiveRow: [],
    });
    expect(decision.deletable).toEqual(['a.pdf', 'b.pdf']);
    expect(decision.kept).toEqual([]);
  });

  it('仍有登记行的引用**保留字节**，其余照删', () => {
    const decision = decideForensicsFileCleanup({
      databaseCleanupOk: true,
      references: ['a.pdf', 'b.pdf'],
      referencedByLiveRow: ['a.pdf'],
    });
    expect(decision.deletable).toEqual(['b.pdf']);
    expect(decision.kept).toEqual(['a.pdf']);
  });

  it('重复引用只算一次', () => {
    const decision = decideForensicsFileCleanup({
      databaseCleanupOk: true,
      references: ['a.pdf', 'a.pdf'],
      referencedByLiveRow: [],
    });
    expect(decision.deletable).toEqual(['a.pdf']);
  });
});

describe('取证脚本收尾 · 审计事件归属判定（P2-2：不得按目标 ID 批量删）', () => {
  const notBefore = new Date('2026-11-24T00:00:00.000Z');
  const base = {
    actorAccountId: 900001,
    operation: 'RESTORE_LOCAL_BUSINESS',
    targetType: 'LOCAL_RESTORE',
    expectedActorAccountId: 900001,
    expectedOperation: 'RESTORE_LOCAL_BUSINESS',
    expectedTargetType: 'LOCAL_RESTORE',
    notBefore,
  };

  it('操作人、类型、产生时间都吻合 ⇒ 属于本轮', () => {
    expect(
      decideAuditEventOwnership({
        ...base,
        createdAt: new Date('2026-11-24T00:00:01.000Z'),
      }),
    ).toBe('OWNED');
  });

  it('**别的账号**写的同类型事件 ⇒ 外来（不得被本轮删除）', () => {
    expect(
      decideAuditEventOwnership({
        ...base,
        actorAccountId: 900301,
        createdAt: new Date('2026-11-24T00:00:01.000Z'),
      }),
    ).toBe('FOREIGN');
  });

  it('事件类型不同 ⇒ 外来', () => {
    expect(
      decideAuditEventOwnership({
        ...base,
        targetType: 'RECORD_PACKAGE',
        createdAt: new Date('2026-11-24T00:00:01.000Z'),
      }),
    ).toBe('FOREIGN');
  });

  it('产生时间早于本轮基线 ⇒ 外来（早于本轮 ⇒ 不是本轮写的）', () => {
    expect(
      decideAuditEventOwnership({
        ...base,
        createdAt: new Date('2026-11-23T23:59:59.000Z'),
      }),
    ).toBe('FOREIGN');
  });

  it('产生时间缺失 ⇒ 外来（无法证明 ⇒ 失败关闭）', () => {
    expect(decideAuditEventOwnership({ ...base, createdAt: null })).toBe('FOREIGN');
  });

  it('时间字段是字符串时也能判定', () => {
    expect(
      decideAuditEventOwnership({
        ...base,
        createdAt: '2026-11-24T00:00:01.000Z',
      }),
    ).toBe('OWNED');
  });
});
