import {
  createConsumerInjectionFailure,
  disableConsumerWithRecovery,
} from '../../../test/utils/consumer-instrumentation';

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

  it.each([false, true])('恢复写入抛错时保留 cause 和状态，读回失败=%s', async (readFails) => {
    const recoveryError = new Error('RECOVERY_FAILURE');
    const write = jest
      .fn()
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockRejectedValueOnce(recoveryError);
    const read = readFails
      ? jest.fn().mockRejectedValue(new Error('STATE_READ_FAILURE'))
      : jest.fn().mockResolvedValue('NO');
    const restore = await disableConsumerWithRecovery({ ...facts, write, read });
    let caught: unknown;
    try {
      await restore();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(recoveryError);
    expect((caught as Error).message).toContain('RECOVERY_FAILURE');
    expect((caught as Error).message).toContain(readFails ? 'current=UNKNOWN' : 'current=NO');
    expect((caught as Error).message).toContain('original=YES');
    if (readFails) expect((caught as Error).message).toContain('STATE_READ_FAILURE');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    '聚合错误的实际 message 包含双失败及状态，读回失败=%s',
    async (readFails) => {
      const primary = new Error('PRIMARY_ASSERTION_FAILURE');
      const recovery = new Error('RECOVERY_FAILURE');
      const failure = await createConsumerInjectionFailure({
        ...facts,
        primaryError: primary,
        cleanupErrors: [recovery],
        read: readFails
          ? jest.fn().mockRejectedValue(new Error('STATE_READ_FAILURE'))
          : jest.fn().mockResolvedValue('NO'),
      });
      expect(failure.errors).toEqual([primary, recovery]);
      expect(failure.errors[0]).toBe(primary);
      expect(failure.errors[1]).toBe(recovery);
      expect(failure.message).toContain('主错误：PRIMARY_ASSERTION_FAILURE');
      expect(failure.message).toContain('收尾错误[1]：RECOVERY_FAILURE');
      expect(failure.message).toContain('server_uuid=instance-uuid');
      expect(failure.message).toContain('original=YES');
      expect(failure.message).toContain(readFails ? 'current=UNKNOWN' : 'current=NO');
      if (readFails) expect(failure.message).toContain('STATE_READ_FAILURE');
    },
  );
});
