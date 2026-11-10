import {
  assertTransactionObservationCapability,
  countActiveOwnTransactions,
} from '../../../test/utils/e2e-scoped-cleanup';

interface ObservationGrants {
  readonly threads: boolean;
  readonly events: boolean;
  readonly setup: boolean;
  readonly consumerEnabled?: boolean;
  readonly instrumentEnabled?: boolean;
  readonly activeTotal?: number;
}

const denied = (table: string): Promise<never> =>
  Promise.reject(
    new Error(`SELECT command denied to user 'rq6_lowpriv'@'127.0.0.1' for table '${table}'`),
  );

const createObservationQuery = (
  grants: ObservationGrants,
): { readonly queries: string[]; readonly query: (sql: string) => Promise<unknown> } => {
  const queries: string[] = [];
  const query = (sql: string): Promise<unknown> => {
    queries.push(sql);
    if (sql.includes('FROM performance_schema.threads AS th')) {
      if (!grants.threads) {
        return denied('threads');
      }
      return Promise.resolve([
        {
          thread_id: 42,
          processlist_id: 7,
          processlist_user: 'rq6_lowpriv',
          connection_id: 7,
          current_user_name: 'rq6_lowpriv',
        },
      ]);
    }
    if (sql.includes('FROM performance_schema.events_transactions_current AS t')) {
      if (!grants.events) {
        return denied('events_transactions_current');
      }
      return Promise.resolve([{ total: grants.activeTotal ?? 0 }]);
    }
    if (sql.includes('FROM performance_schema.setup_consumers')) {
      if (!grants.setup) {
        return denied('setup_consumers');
      }
      return Promise.resolve([
        {
          name: 'events_transactions_current',
          enabled: grants.consumerEnabled === false ? 'NO' : 'YES',
        },
      ]);
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

describe('RQ6 事务观测能力预检（离线）', () => {
  it('权限齐全且前提成立时放行，并把 0 解释为确实没有活动事务', async () => {
    const { queries, query } = createObservationQuery({ ...allGranted, activeTotal: 0 });

    await expect(assertTransactionObservationCapability(query)).resolves.toBeUndefined();

    const executed = queries.join('\n');
    expect(executed).toContain('performance_schema.threads');
    expect(executed).toContain('events_transactions_current AS t');
    expect(executed).toContain('performance_schema.setup_consumers');
    expect(executed).toContain('performance_schema.setup_instruments');
    expect(executed).not.toContain('innodb_trx');
    expect(executed).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });

  it('仅缺 threads 权限时在造数前失败关闭，且同时核验了 events_transactions_current', async () => {
    const { queries, query } = createObservationQuery({ ...allGranted, threads: false });

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(
      /performance_schema\.threads.*零造数/,
    );
    const executed = queries.join('\n');
    expect(executed).toContain('events_transactions_current AS t');
    expect(executed).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
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
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  });

  it.each([
    [{ ...allGranted, consumerEnabled: false }, /consumer 未启用/],
    [{ ...allGranted, instrumentEnabled: false }, /instrument 未启用/],
    [{ ...allGranted, setup: false }, /setup_consumers.*零造数/],
  ])('采集前提未启用或不可读时失败关闭（%s）', async (grants, expected) => {
    const { query } = createObservationQuery(grants);

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(expected);
  });

  it('当前连接在线程表中不可见时失败关闭', async () => {
    const query = (sql: string): Promise<unknown> => {
      if (sql.includes('FROM performance_schema.threads AS th')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([{ total: 0 }]);
    };

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(/threads 中不可见/);
  });

  it('按当前用户统计 ACTIVE 事务数', async () => {
    const { queries, query } = createObservationQuery({ ...allGranted, activeTotal: 2 });

    await expect(countActiveOwnTransactions(query)).resolves.toBe(2);
    expect(queries[0]).toContain('JOIN performance_schema.threads');
  });

  it.each([[[]], [[{}]], [[{ total: 'NaN' }]]])(
    '观测结果为空或不是有效计数时失败关闭',
    async (rows) => {
      const query = (): Promise<unknown> => Promise.resolve(rows);

      await expect(countActiveOwnTransactions(query)).rejects.toThrow(/事务观测结果/);
    },
  );
});
