import { disableConsumerWithRecovery } from '../../../test/utils/consumer-instrumentation';

describe('consumer 采集开关的写入与恢复责任', () => {
  const facts = {
    serverUuid: 'instance-uuid',
    consumer: 'global_instrumentation',
    original: 'YES',
  };

  it('明确写入后只按原条件恢复并读回', async () => {
    const write = jest.fn().mockResolvedValue({ affectedRows: 1 });
    const read = jest.fn().mockResolvedValue('YES');
    const restore = await disableConsumerWithRecovery({ ...facts, write, read });
    await restore();
    expect(write.mock.calls).toEqual([
      ['YES', 'NO'],
      ['NO', 'YES'],
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('写入结果丢失时保留主错误、可见状态及实例定位，不认领恢复', async () => {
    const original = new Error('result lost');
    const write = jest.fn().mockRejectedValue(original);
    const read = jest.fn().mockResolvedValue('NO');
    let thrown: unknown;
    try {
      await disableConsumerWithRecovery({ ...facts, write, read });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(original);
    expect((thrown as Error).message).toMatch(
      /instance-uuid.*global_instrumentation.*current=NO.*result lost/,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([{ affectedRows: 0 }, {}, { affectedRows: 2 }])(
    '写入未命中或结果未知时不恢复：%j',
    async (result) => {
      const write = jest.fn().mockResolvedValue(result);
      await expect(
        disableConsumerWithRecovery({ ...facts, write, read: () => Promise.resolve('NO') }),
      ).rejects.toThrow(/保留现场/);
      expect(write).toHaveBeenCalledTimes(1);
    },
  );

  it('恢复条件未命中时报告冲突，不反复写入', async () => {
    const write = jest
      .fn()
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({ affectedRows: 0 });
    const restore = await disableConsumerWithRecovery({
      ...facts,
      write,
      read: () => Promise.resolve('NO'),
    });
    await expect(restore()).rejects.toThrow(/恢复未确认/);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
