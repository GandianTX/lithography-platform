import {
  assertTransactionObservationCapability,
  countActiveOwnTransactions,
} from '../../../test/utils/e2e-scoped-cleanup';

describe('RQ6 事务观测能力预检（离线）', () => {
  it('无法读取 performance_schema 事务视图时在造数前失败关闭', async () => {
    const queries: string[] = [];
    const query = (sql: string): Promise<unknown> => {
      queries.push(sql);
      return Promise.reject(new Error('SELECT command denied'));
    };

    await expect(assertTransactionObservationCapability(query)).rejects.toThrow(
      /events_transactions_current.*零造数/,
    );
    expect(queries).toHaveLength(1);
  });

  it('事务视图可读时放行，且不读取需要全局 PROCESS 的 innodb_trx', async () => {
    const queries: string[] = [];
    const query = (sql: string): Promise<unknown> => {
      queries.push(sql);
      return Promise.resolve([{ total: 0 }]);
    };

    await expect(assertTransactionObservationCapability(query)).resolves.toBeUndefined();
    expect(queries.join('\n')).not.toContain('innodb_trx');
  });

  it('按当前用户统计 ACTIVE 事务数', async () => {
    const query = (): Promise<unknown> => Promise.resolve([{ total: 2 }]);

    await expect(countActiveOwnTransactions(query)).resolves.toBe(2);
  });

  it.each([[[]], [[{}]], [[{ total: 'NaN' }]]])(
    '观测结果为空或不是有效计数时失败关闭',
    async (rows) => {
      const query = (): Promise<unknown> => Promise.resolve(rows);

      await expect(countActiveOwnTransactions(query)).rejects.toThrow(/事务观测结果/);
    },
  );
});
