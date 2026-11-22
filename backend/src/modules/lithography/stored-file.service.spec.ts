// src/modules/lithography/stored-file.service.spec.ts
/// <reference types="jest" />

/**
 * 暂存原件受控写服务的定向测试（任务 09 P3-3 跨资源失败补偿）。
 *
 * 重点锁定 `releaseTemporaryFiles` 的**精确补偿**语义：
 * 只处理调用方指名的 fileId，且只处理"未被业务绑定"的暂存行——
 * 不动已绑定的既有原件，不动他人／他公司的对象。
 */

import { StoredFileService } from './stored-file.service';

function buildService(updateResult: { affected?: number } = {}) {
  const update = jest.fn().mockResolvedValue({ affected: updateResult.affected ?? 1 });
  const repository = { update, findOne: jest.fn(), save: jest.fn() };
  const service = new StoredFileService(repository as never);
  return { service, update };
}

describe('暂存原件受控写服务（P3-3）', () => {
  it('精确释放：只按 fileId 名单 ＋ 未绑定条件更新（行保留、标记失效）', async () => {
    const { service, update } = buildService({ affected: 2 });

    const affected = await service.releaseTemporaryFiles({ fileIds: ['file-1', 'file-2'] });

    expect(affected).toBe(2);
    expect(update).toHaveBeenCalledTimes(1);
    const [where, set] = update.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(where.status).toBe('VALID');
    expect(where.bindingStatus).toBe('TEMPORARY');
    expect(where.businessId).toBeDefined();
    expect(set).toEqual({ status: 'FAILED' });
    // 不改绑定关系：绑定状态与业务 id 保持不变（满足既有 CHECK 约束）
    expect(set.bindingStatus).toBeUndefined();
    expect(set.businessId).toBeUndefined();
  });

  it('空名单：不发起任何更新', async () => {
    const { service, update } = buildService();

    const affected = await service.releaseTemporaryFiles({ fileIds: [] });

    expect(affected).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('命中 0（行已被绑定或状态已变）：如实返回 0，由调用方按"保留"处理', async () => {
    const { service } = buildService({ affected: 0 });

    const affected = await service.releaseTemporaryFiles({ fileIds: ['file-1'] });

    expect(affected).toBe(0);
  });
});
