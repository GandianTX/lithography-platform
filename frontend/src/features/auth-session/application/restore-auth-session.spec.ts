// src/features/auth-session/application/restore-auth-session.spec.ts

// 启动恢复控制器的行为边界：哪一侧（本地 / 服务端）可以改写会话事实。
// 四条约束：关闭时零请求且同步；并发只发一次请求；`absent` 才清本地；
// `unavailable` 绝不当成未登录；迟到结果（stale）不写入、也不被记忆。
import { describe, expect, it, vi } from 'vitest';

import type { RestoreWebSessionResult } from '../infrastructure/auth-web-session-rest';

import type { AuthSessionSnapshot, EstablishAuthSessionInput } from './auth-session.types';
import { createWebSessionRestoreController } from './restore-auth-session';

function createSnapshot(): AuthSessionSnapshot {
  return {
    accessToken: 'restored-access-token',
    accountId: 900101,
    adminLevel: null,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    adminOrganizationId: null,
    registrationOrganizationId: null,
    restriction: 'NONE',
    role: 'ENGINEER',
    userInfo: null,
  };
}

function createSessionPort() {
  const state = {
    epoch: 0,
    established: [] as EstablishAuthSessionInput[],
    cleared: 0,
  };

  const port = {
    establishSession: (input: EstablishAuthSessionInput) => {
      state.established.push(input);
      state.epoch += 1;
    },
    clearSession: () => {
      state.cleared += 1;
      state.epoch += 1;
    },
    getSessionEpoch: () => state.epoch,
  };

  return { port, state };
}

function createGateway(result: RestoreWebSessionResult | (() => Promise<RestoreWebSessionResult>)) {
  const restore = vi.fn(typeof result === 'function' ? result : () => Promise.resolve(result));

  return { restore };
}

describe('功能关闭：不发起恢复、不改会话', () => {
  it('返回同步的 restored，网关零调用', () => {
    const { port } = createSessionPort();
    const gateway = createGateway({ status: 'absent' });
    const controller = createWebSessionRestoreController({
      enabled: false,
      gateway,
      session: port,
    });

    const outcome = controller.ensure();

    expect(outcome).toBe('restored');
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(gateway.restore).not.toHaveBeenCalled();
  });
});

describe('开启后：一次请求决定会话事实', () => {
  it('restored：写入会话真源并记忆，后续判定不再请求', async () => {
    const { port, state } = createSessionPort();
    const snapshot = createSnapshot();
    const gateway = createGateway({ status: 'restored', session: snapshot });
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    await expect(controller.ensure()).resolves.toBe('restored');
    expect(state.established).toEqual([snapshot]);

    // 记忆命中：同步返回，且不产生第二次请求
    expect(controller.ensure()).toBe('restored');
    expect(gateway.restore).toHaveBeenCalledTimes(1);
  });

  it('并发调用共享同一个请求', async () => {
    const { port } = createSessionPort();
    const gateway = createGateway(async () => ({ status: 'absent' }));
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    const first = controller.ensure();
    const second = controller.ensure();

    expect(first).toBe(second);
    await expect(first).resolves.toBe('absent');
    expect(gateway.restore).toHaveBeenCalledTimes(1);
  });

  it('absent：清除本地会话与客户端缓存（服务端明确说没有会话）', async () => {
    const { port, state } = createSessionPort();
    const clearClientCache = vi.fn();
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway: createGateway({ status: 'absent' }),
      session: port,
      clearClientCache,
    });

    await expect(controller.ensure()).resolves.toBe('absent');
    expect(state.cleared).toBe(1);
    expect(clearClientCache).toHaveBeenCalledTimes(1);
  });

  it('unavailable（服务端无法确认）：既不清会话也不缓存，重试可再问', async () => {
    const { port, state } = createSessionPort();
    const clearClientCache = vi.fn();
    const gateway = createGateway({ status: 'unavailable' });
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway,
      session: port,
      clearClientCache,
    });

    await expect(controller.ensure()).resolves.toBe('unavailable');
    expect(state.cleared).toBe(0);
    expect(clearClientCache).not.toHaveBeenCalled();

    // unavailable 会被记忆成「本次结论」，显式重试才重新请求
    expect(controller.ensure()).toBe('unavailable');
    expect(gateway.restore).toHaveBeenCalledTimes(1);
  });

  it('网关异常按 unavailable 处理，不踢人', async () => {
    const { port, state } = createSessionPort();
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway: createGateway(() => Promise.reject(new Error('network down'))),
      session: port,
    });

    await expect(controller.ensure()).resolves.toBe('unavailable');
    expect(state.cleared).toBe(0);
  });

  it('force：显式重试会发起新请求', async () => {
    const { port } = createSessionPort();
    const gateway = createGateway({ status: 'unavailable' });
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    await controller.ensure();
    await controller.ensure({ force: true });

    expect(gateway.restore).toHaveBeenCalledTimes(2);
  });
});

describe('迟到结果（stale）：绝不覆盖期间已发生变化的会话', () => {
  it('等待期间发生了登录：结果丢弃且不记忆，下一次重新询问', async () => {
    const { port, state } = createSessionPort();
    let resolveRestore: (result: RestoreWebSessionResult) => void = () => {};
    const gateway = createGateway(
      () =>
        new Promise<RestoreWebSessionResult>((resolve) => {
          resolveRestore = resolve;
        }),
    );
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    const pending = controller.ensure();

    // 恢复在途时本地已建立新会话（登录成功）
    port.establishSession(createSnapshot());
    resolveRestore({ status: 'restored', session: createSnapshot() });

    await expect(pending).resolves.toBe('stale');
    // 只写入过测试自己建立的那一次，恢复结果没有落地
    expect(state.established).toHaveLength(1);

    // stale 不记忆：后续判定必须重新向服务端确认
    void controller.ensure();
    expect(gateway.restore).toHaveBeenCalledTimes(2);
  });
});

describe('本地已确定的会话事实：无需再问服务端', () => {
  it('登录成功后 ensure 直接判定为已恢复', () => {
    const { port } = createSessionPort();
    const gateway = createGateway({ status: 'absent' });
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    controller.markSessionEstablished();

    expect(controller.ensure()).toBe('restored');
    expect(gateway.restore).not.toHaveBeenCalled();
  });

  it('主动退出成功后 ensure 直接判定为无会话，不清理第二次', () => {
    const { port, state } = createSessionPort();
    const gateway = createGateway({ status: 'restored', session: createSnapshot() });
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    controller.markSessionCleared();

    expect(controller.ensure()).toBe('absent');
    expect(gateway.restore).not.toHaveBeenCalled();
    expect(state.cleared).toBe(0);
  });
});

describe('跨页事件作废在途恢复（本页没有已建立的会话）', () => {
  function pendingGateway() {
    let settle: (result: RestoreWebSessionResult) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const restore = vi.fn(
      () =>
        new Promise<RestoreWebSessionResult>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        }),
    );

    return {
      gateway: { restore },
      settle: (value: RestoreWebSessionResult) => settle(value),
      fail: (error: unknown) => fail(error),
    };
  }

  it('作废后旧的成功响应不写会话', async () => {
    const { port, state } = createSessionPort();
    const pending = pendingGateway();
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway: pending.gateway,
      session: port,
    });

    const inFlight = controller.ensure();
    controller.invalidatePendingRestore();
    pending.settle({ status: 'restored', session: createSnapshot() });

    await expect(inFlight).resolves.toBe('stale');
    expect(state.established).toHaveLength(0);
    expect(state.epoch).toBe(0);
  });

  it('作废后旧的 401 不清会话也不清客户端缓存', async () => {
    const { port, state } = createSessionPort();
    const clearClientCache = vi.fn();
    const pending = pendingGateway();
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway: pending.gateway,
      session: port,
      clearClientCache,
    });

    const inFlight = controller.ensure();
    controller.invalidatePendingRestore();
    pending.settle({ status: 'absent' });

    await expect(inFlight).resolves.toBe('stale');
    expect(state.cleared).toBe(0);
    expect(clearClientCache).not.toHaveBeenCalled();
  });

  it('作废后旧的网络失败按 stale 处理，不导向重试页', async () => {
    const { port } = createSessionPort();
    const pending = pendingGateway();
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway: pending.gateway,
      session: port,
    });

    const inFlight = controller.ensure();
    controller.invalidatePendingRestore();
    pending.fail(new Error('offline'));

    await expect(inFlight).resolves.toBe('stale');
  });

  it('作废后立刻发新请求，旧请求收尾不清掉新请求的在途状态', async () => {
    const { port } = createSessionPort();
    const deferreds: Array<{
      resolve: (value: RestoreWebSessionResult) => void;
    }> = [];
    const restore = vi.fn(
      () =>
        new Promise<RestoreWebSessionResult>((resolve) => {
          deferreds.push({ resolve });
        }),
    );
    const controller = createWebSessionRestoreController({
      enabled: true,
      gateway: { restore },
      session: port,
    });

    const oldAttempt = controller.ensure();
    controller.invalidatePendingRestore();
    const newAttempt = controller.ensure();

    expect(newAttempt).not.toBe(oldAttempt);
    expect(restore).toHaveBeenCalledTimes(2);

    deferreds[0].resolve({ status: 'restored', session: createSnapshot() });
    await expect(oldAttempt).resolves.toBe('stale');

    // 旧请求收尾不能把新请求从「在途」位置上清掉
    expect(controller.ensure()).toBe(newAttempt);

    deferreds[1].resolve({ status: 'absent' });
    await expect(newAttempt).resolves.toBe('absent');
  });

  it('作废同时让记忆失效：即便此前判定过无会话也要重新问服务端', async () => {
    const { port } = createSessionPort();
    const gateway = createGateway({ status: 'restored', session: createSnapshot() });
    const controller = createWebSessionRestoreController({ enabled: true, gateway, session: port });

    controller.markSessionCleared();
    expect(controller.ensure()).toBe('absent');

    controller.invalidatePendingRestore();

    await expect(controller.ensure()).resolves.toBe('restored');
    expect(gateway.restore).toHaveBeenCalledTimes(1);
  });
});
