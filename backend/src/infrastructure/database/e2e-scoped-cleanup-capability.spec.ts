import {
  assertCasRestoreAffectedOne,
  assertTransactionObservationCapability,
  byteExactTextEquals,
  byteExactTextMatchCondition,
  classifyThreadInstrumentationWrite,
  countActiveOwnTransactions,
} from '../../../test/utils/e2e-scoped-cleanup';

interface ObservationGrants {
  readonly threads: boolean;
  readonly events: boolean;
  readonly setup: boolean;
  readonly enabledQuery?: boolean;
  readonly performanceSchema?: boolean;
  readonly consumerEnabled?: boolean;
  /** 单独关闭某个上游 consumer（global_instrumentation / thread_instrumentation）。 */
  readonly disabledConsumers?: ReadonlyArray<string>;
  /** 从 setup_consumers 结果中缺失某个 consumer，模拟不可确认。 */
  readonly missingConsumers?: ReadonlyArray<string>;
  readonly instrumentEnabled?: boolean;
  readonly activeTotal?: number;
  /** 当前用户除本连接外仍未开启采集的前台线程数。 */
  readonly uninstrumentedThreads?: number;
  readonly threadInstrumented?: string;
  readonly threadType?: string;
  readonly threadRows?: ReadonlyArray<Record<string, unknown>>;
  readonly threadsError?: boolean;
  readonly activeError?: boolean;
}

const denied = (table: string): Promise<never> =>
  Promise.reject(
    new Error(`SELECT command denied to user 'rq6_lowpriv'@'127.0.0.1' for table '${table}'`),
  );

const threadRow = (grants: ObservationGrants): Record<string, unknown> => ({
  thread_id: 42,
  processlist_id: 7,
  processlist_user: 'rq6_lowpriv',
  thread_type: grants.threadType ?? 'FOREGROUND',
  instrumented: grants.threadInstrumented ?? 'YES',
  connection_id: 7,
  current_user_name: 'rq6_lowpriv',
});

const createObservationQuery = (
  grants: ObservationGrants,
): { readonly queries: string[]; readonly query: (sql: string) => Promise<unknown> } => {
  const queries: string[] = [];
  const query = (sql: string): Promise<unknown> => {
    queries.push(sql);
    if (sql.includes('SELECT @@performance_schema AS enabled')) {
      if (grants.enabledQuery === false) {
        return denied('@@performance_schema');
      }
      return Promise.resolve([{ enabled: grants.performanceSchema === false ? 0 : 1 }]);
    }
    if (sql.includes("th.TYPE = 'FOREGROUND'")) {
      if (!grants.threads) {
        return denied('threads');
      }
      return Promise.resolve([{ total: grants.uninstrumentedThreads ?? 0 }]);
    }
    if (sql.includes('FROM performance_schema.threads AS th')) {
      if (!grants.threads) {
        return denied('threads');
      }
      if (grants.threadsError === true) {
        return Promise.reject(new Error('threads query failed'));
      }
      return Promise.resolve(grants.threadRows ?? [threadRow(grants)]);
    }
    if (sql.includes('FROM performance_schema.events_transactions_current AS t')) {
      if (!grants.events) {
        return denied('events_transactions_current');
      }
      if (grants.activeError === true) {
        return Promise.reject(new Error('active query failed'));
      }
      return Promise.resolve([{ total: grants.activeTotal ?? 0 }]);
    }
    if (sql.includes('FROM performance_schema.setup_consumers')) {
      if (!grants.setup) {
        return denied('setup_consumers');
      }
      return Promise.resolve(
        ['global_instrumentation', 'thread_instrumentation', 'events_transactions_current']
          .filter((name) => !(grants.missingConsumers ?? []).includes(name))
          .map((name) => ({
            name,
            enabled:
              grants.consumerEnabled === false || (grants.disabledConsumers ?? []).includes(name)
                ? 'NO'
                : 'YES',
          })),
      );
    }
    if (sql.includes('FROM performance_schema.setup_instruments')) {
      if (!grants.setup) {
        return denied('setup_instruments');
      }
      return Promise.resolve([
        { name: 'transaction', enabled: grants.instrumentEnabled === false ? 'NO' : 'YES' },
      ]);
    }
    return Promise.reject(new Error(`UNEXPECTED_SQL: ${sql}`));
  };
  return { queries, query };
};

const allGranted: ObservationGrants = { threads: true, events: true, setup: true };

const expectNoDestructiveSql = (queries: string[]): void => {
  expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
};

describe('RQ6 事务观测能力预检（离线）', () => {
  it('权限齐全且前提成立时放行，并把 0 解释为确实没有活动事务', async () => {
    const { queries, query } = createObservationQuery({ ...allGranted, activeTotal: 0 });

    await expect(assertTransactionObservationCapability(query)).resolves.toBeUndefined();

    const executed = queries.join('\n');
    expect(executed).toContain('@@performance_schema');
    expect(executed).toContain('performance_schema.threads');
    expect(executed).toContain("th.TYPE = 'FOREGROUND'");
    expect(executed).toContain('events_transactions_current AS t');
    expect(executed).toContain('performance_schema.setup_consumers');
    expect(executed).toContain('performance_schema.setup_instruments');
    expect(executed).not.toContain('innodb_trx');
    expectNoDestructiveSql(queries);
  });

  it('仅缺 threads 权限时在造数前失败关闭，且同时核验了 events_transactions_current', async () => {
    const { queries, query } = createObservationQuery({ ...allGranted, threads: false });

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(
      /performance_schema\.threads.*零造数/,
    );
    expect(queries.join('\n')).toContain('events_transactions_current AS t');
    expectNoDestructiveSql(queries);
  });

  it('threads 与 events_transactions_current 两项都缺时在造数前失败关闭', async () => {
    const { queries, query } = createObservationQuery({
      ...allGranted,
      threads: false,
      events: false,
    });

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(
      /performance_schema\.threads.*events_transactions_current.*零造数/,
    );
    expectNoDestructiveSql(queries);
  });

  const setupCases: Array<[ObservationGrants, RegExp]> = [
    [{ ...allGranted, consumerEnabled: false }, /consumer 未启用/],
    [
      { ...allGranted, disabledConsumers: ['global_instrumentation'] },
      /global_instrumentation consumer 未启用/,
    ],
    [
      { ...allGranted, disabledConsumers: ['thread_instrumentation'] },
      /thread_instrumentation consumer 未启用/,
    ],
    [
      { ...allGranted, missingConsumers: ['global_instrumentation'] },
      /global_instrumentation consumer 缺失或不可确认/,
    ],
    [{ ...allGranted, instrumentEnabled: false }, /instrument 未启用/],
    [{ ...allGranted, setup: false }, /setup_consumers.*零造数/],
  ];

  it.each(setupCases)('采集前提未启用或不可读时失败关闭（%#）', async (grants, expected) => {
    const { query } = createObservationQuery(grants);

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(expected);
  });

  it.each(['global_instrumentation', 'thread_instrumentation'])(
    '上游 consumer %s 关闭时计数拒绝，绝不能返回零事务',
    async (name) => {
      const { query } = createObservationQuery({
        ...allGranted,
        disabledConsumers: [name],
        activeTotal: 0,
      });

      await expect(countActiveOwnTransactions(query)).rejects.toThrow(
        new RegExp(`${name} consumer 未启用`),
      );
    },
  );

  const failingThreadCases: Array<[ObservationGrants, RegExp]> = [
    [{ ...allGranted, performanceSchema: false }, /不可观测/],
    [{ ...allGranted, enabledQuery: false }, /@@performance_schema/],
    [{ ...allGranted, threadRows: [] }, /threads 中不可见/],
    [{ ...allGranted, threadsError: true }, /threads/],
    [{ ...allGranted, threadInstrumented: 'NO' }, /INSTRUMENTED=NO.*不可确认/],
    [{ ...allGranted, threadInstrumented: '' }, /INSTRUMENTED=<缺失>.*不可确认/],
    [{ ...allGranted, threadType: 'BACKGROUND' }, /不是前台线程/],
    [{ ...allGranted, activeError: true }, /关联查询不可执行/],
  ];

  it.each(failingThreadCases)('线程/开关不可确认时失败关闭（%#）', async (grants, expected) => {
    const { query } = createObservationQuery(grants);

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(expected);
  });

  it('另一条池连接停采时失败关闭（全局开关与权限不变）', async () => {
    const { queries, query } = createObservationQuery({
      ...allGranted,
      uninstrumentedThreads: 1,
    });

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(
      /1 个当前用户前台线程 INSTRUMENTED<>YES.*不可观测/,
    );
    // 本连接自身仍是 YES，拒绝原因必须来自池连接检查，而非全局开关。
    expect(queries.join('\n')).toContain("th.TYPE = 'FOREGROUND'");
  });

  it('按当前用户统计 ACTIVE 事务数', async () => {
    const { queries, query } = createObservationQuery({ ...allGranted, activeTotal: 2 });

    await expect(countActiveOwnTransactions(query)).resolves.toBe(2);
    expect(queries.join('\n')).toContain('JOIN performance_schema.threads');
  });

  it('计数前复验实际线程与池连接状态；停采时报告不可观测而非 0', async () => {
    const { query } = createObservationQuery({
      ...allGranted,
      threadInstrumented: 'NO',
      activeTotal: 0,
    });

    await expect(countActiveOwnTransactions(query)).rejects.toThrow(
      /不可观测.*INSTRUMENTED=NO.*拒绝把未知状态当作无活动事务/,
    );
  });

  it('计数前发现另一条池连接停采时报告不可观测而非 0', async () => {
    const { query } = createObservationQuery({
      ...allGranted,
      uninstrumentedThreads: 2,
      activeTotal: 0,
    });

    await expect(countActiveOwnTransactions(query)).rejects.toThrow(
      /2 个当前用户前台线程.*不可观测/,
    );
  });

  it('计数前线程消失或状态不可读时报告不可观测而非 0', async () => {
    const disappeared = createObservationQuery({
      ...allGranted,
      threadRows: [],
      activeTotal: 0,
    });
    await expect(countActiveOwnTransactions(disappeared.query)).rejects.toThrow(
      /不可观测.*threads 中不可见/,
    );

    const failed = createObservationQuery({
      ...allGranted,
      threadsError: true,
      activeTotal: 0,
    });
    await expect(countActiveOwnTransactions(failed.query)).rejects.toThrow(
      /不可观测.*performance_schema\.threads/,
    );
  });

  it.each([[[]], [[{}]], [[{ total: 'NaN' }]]])(
    '观测结果为空或不是有效计数时失败关闭',
    async (rows) => {
      const query = (sql: string): Promise<unknown> => {
        if (sql.includes("th.TYPE = 'FOREGROUND'")) {
          return Promise.resolve([{ total: 0 }]);
        }
        if (sql.includes('FROM performance_schema.threads AS th')) {
          return Promise.resolve([threadRow(allGranted)]);
        }
        if (sql.includes('SELECT @@performance_schema AS enabled')) {
          return Promise.resolve([{ enabled: 1 }]);
        }
        if (sql.includes('FROM performance_schema.setup_consumers')) {
          return Promise.resolve([
            { name: 'global_instrumentation', enabled: 'YES' },
            { name: 'thread_instrumentation', enabled: 'YES' },
            { name: 'events_transactions_current', enabled: 'YES' },
          ]);
        }
        if (sql.includes('FROM performance_schema.setup_instruments')) {
          return Promise.resolve([{ name: 'transaction', enabled: 'YES' }]);
        }
        return Promise.resolve(rows);
      };

      await expect(countActiveOwnTransactions(query)).rejects.toThrow(/事务观测结果/);
    },
  );
});

describe('R02 字节精确恢复（离线）', () => {
  it('字节完全相同时才视为匹配；大小写、尾部空格与 NULL 均不匹配', () => {
    expect(byteExactTextEquals('s4e-r02.txt', 's4e-r02.txt')).toBe(true);
    expect(byteExactTextEquals('S4E-r02.txt', 's4e-r02.txt')).toBe(false);
    expect(byteExactTextEquals('s4e-r02.txt ', 's4e-r02.txt')).toBe(false);
    expect(byteExactTextEquals(null, null)).toBe(true);
    expect(byteExactTextEquals(null, '')).toBe(false);
    expect(byteExactTextEquals('', null)).toBe(false);
  });

  it('CAS 条件使用 CAST(... AS BINARY)，不使用依赖排序规则的普通等号', () => {
    const condition = byteExactTextMatchCondition('original_filename');
    expect(condition).toBe('CAST(original_filename AS BINARY) = CAST(? AS BINARY)');
    expect(condition).not.toMatch(/original_filename\s*=\s*\?/);
  });

  it('条件更新命中 1 行时视为恢复成功', () => {
    expect(() =>
      assertCasRestoreAffectedOne({
        label: 'stored_file.original_filename',
        targetId: 'f-1',
        affectedRows: 1,
      }),
    ).not.toThrow();
  });

  it.each([0, 2])('条件更新命中 %i 行时失败并给出可定位诊断', (affectedRows) => {
    expect(() =>
      assertCasRestoreAffectedOne({
        label: 'stored_file.original_filename',
        targetId: 'f-1',
        affectedRows,
      }),
    ).toThrow(
      new RegExp(
        `恢复冲突：stored_file\\.original_filename targetId=f-1 条件更新 affectedRows=${affectedRows}.*已跳过后续通用清理`,
      ),
    );
  });
});

describe('P2 线程停采写入结果分类（离线）', () => {
  it('明确命中 1 行才登记恢复责任', () => {
    expect(classifyThreadInstrumentationWrite({ affectedRows: 1 })).toEqual({
      outcome: 'applied',
      shouldRestore: true,
      affectedRows: 1,
      diagnostic: null,
    });
  });

  it('命中 0 行时不恢复，保持现状', () => {
    const decision = classifyThreadInstrumentationWrite({ affectedRows: 0 });
    expect(decision.outcome).toBe('not-applied');
    expect(decision.shouldRestore).toBe(false);
    expect(decision.affectedRows).toBe(0);
    expect(decision.diagnostic).toMatch(/命中 0 行.*不登记恢复责任/);
  });

  it.each([
    undefined,
    null,
    {},
    { affectedRows: undefined },
    { affectedRows: Number.NaN },
    { affectedRows: '' },
    { affectedRows: 'not-a-number' },
    { affectedRows: 2 },
  ])('结果不可确认时保留现场且不恢复（%#）', (raw) => {
    const decision = classifyThreadInstrumentationWrite(raw);
    expect(decision.outcome).toBe('unknown');
    expect(decision.shouldRestore).toBe(false);
    expect(decision.diagnostic).toMatch(/结果未知.*保留现场/);
  });
});
