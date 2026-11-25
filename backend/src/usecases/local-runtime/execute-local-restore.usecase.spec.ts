// src/usecases/local-runtime/execute-local-restore.usecase.spec.ts
/// <reference types="jest" />

/**
 * 恢复**执行**用例的定向测试（任务 09 独立验收 P2：审计事实里的操作者等级）。
 *
 * 守住：
 * 1. 工程师无恢复权限（与预检／受理同一口径），拒绝时不写任何恢复事实；
 * 2. **实际**管理员等级从可信 scope 透传到执行服务（不固定一级、不缺省成一级）；
 * 3. 等级缺失／非法 ⇒ **失败关闭**，不执行恢复；
 * 4. 二级管理员的公司范围仍按"仅本公司"传入（授权不回退）。
 */

import { DomainError, PERMISSION_ERROR } from '@core/common/errors/domain-error';

import { ExecuteLocalRestoreUsecase } from './execute-local-restore.usecase';

const RESTORE_ID = '44444444-5555-4666-8777-888888888888';

function buildUsecase(options: {
  scope?: {
    role: 'ADMIN_LEVEL_1' | 'ADMIN_LEVEL_2' | 'ENGINEER';
    organizationId: number | null;
    adminLevel: 1 | 2 | null;
  };
}) {
  const scope = options.scope ?? {
    role: 'ADMIN_LEVEL_2' as const,
    organizationId: 9,
    adminLevel: 2 as const,
  };
  const scopeResolver = { resolve: jest.fn().mockResolvedValue(scope) };
  const execute = jest.fn().mockResolvedValue({
    status: 'SUCCEEDED',
    restoreId: RESTORE_ID,
    reasonCode: null,
    reason: null,
    restored: { records: 1, originals: 0, queue: 0 },
    released: true,
    holdRetained: false,
  });
  const usecase = new ExecuteLocalRestoreUsecase(scopeResolver as never, { execute } as never);
  return { usecase, scopeResolver, execute };
}

describe('恢复执行用例（独立验收 P2）', () => {
  it('二级管理员执行：把真实等级透传给执行服务（不固定一级）', async () => {
    const { usecase, execute } = buildUsecase({
      scope: { role: 'ADMIN_LEVEL_2', organizationId: 9, adminLevel: 2 },
    });

    const result = await usecase.execute({
      session: { accountId: 900202 } as never,
      restoreId: RESTORE_ID,
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(execute).toHaveBeenCalledTimes(1);
    const input = execute.mock.calls[0]?.[0] as {
      actorAccountId: number;
      actorAdminLevel: number;
      allowedOrganizationId: number | null;
    };
    expect(input.actorAccountId).toBe(900202);
    expect(input.actorAdminLevel).toBe(2);
    expect(input.allowedOrganizationId).toBe(9);
  });

  it('一级管理员执行：等级为 1，公司范围仍是全局（null）', async () => {
    const { usecase, execute } = buildUsecase({
      scope: { role: 'ADMIN_LEVEL_1', organizationId: null, adminLevel: 1 },
    });

    await usecase.execute({
      session: { accountId: 900101 } as never,
      restoreId: RESTORE_ID,
    });

    const input = execute.mock.calls[0]?.[0] as {
      actorAdminLevel: number;
      allowedOrganizationId: number | null;
    };
    expect(input.actorAdminLevel).toBe(1);
    expect(input.allowedOrganizationId).toBeNull();
  });

  it('工程师无恢复权限：拒绝，且不执行任何恢复动作', async () => {
    const { usecase, execute } = buildUsecase({
      scope: { role: 'ENGINEER', organizationId: 9, adminLevel: null },
    });

    await expect(
      usecase.execute({
        session: { accountId: 900303 } as never,
        restoreId: RESTORE_ID,
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('管理员等级缺失：失败关闭（不静默降级为一级），不执行恢复', async () => {
    const { usecase, execute } = buildUsecase({
      scope: { role: 'ADMIN_LEVEL_2', organizationId: 9, adminLevel: null },
    });

    await expect(
      usecase.execute({
        session: { accountId: 900404 } as never,
        restoreId: RESTORE_ID,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(execute).not.toHaveBeenCalled();
  });

  it('管理员等级非法（不是 1／2）：失败关闭，不执行恢复', async () => {
    const { usecase, execute } = buildUsecase({
      scope: { role: 'ADMIN_LEVEL_2', organizationId: 9, adminLevel: 3 as never },
    });

    await expect(
      usecase.execute({
        session: { accountId: 900505 } as never,
        restoreId: RESTORE_ID,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(execute).not.toHaveBeenCalled();
  });

  it('执行失败且保留冻结：如实回报，不把失败说成成功', async () => {
    const { usecase, execute } = buildUsecase({
      scope: { role: 'ADMIN_LEVEL_2', organizationId: 9, adminLevel: 2 },
    });
    execute.mockResolvedValue({
      status: 'FAILED',
      restoreId: RESTORE_ID,
      reasonCode: 'RESTORE_ROLLBACK_FAILED',
      reason: '按保护副本回滚失败',
      restored: null,
      released: false,
      holdRetained: true,
    });

    const result = await usecase.execute({
      session: { accountId: 900202 } as never,
      restoreId: RESTORE_ID,
    });

    expect(result.status).toBe('FAILED');
    expect(result.reasonCode).toBe('RESTORE_ROLLBACK_FAILED');
    expect(result.released).toBe(false);
    expect(result.holdRetained).toBe(true);
  });
});
