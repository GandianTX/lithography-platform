// src/features/auth-session/application/auth-session-channel.ts

/**
 * 跨标签页会话事件。
 *
 * 只传事件，**不传令牌、不传 Cookie、不传任何身份凭据**：
 * - `logout`：某个标签页主动退出成功，其他标签页应清本地会话与缓存并回到登录页
 * - `session-replaced`：某标签页用另一个账号登录（共享 Cookie 已被替换），
 *   其他标签页必须丢弃旧身份视图
 */
export type AuthSessionChannelEvent =
  | { type: 'logout' }
  | { type: 'session-replaced'; accountId: number };

export const AUTH_SESSION_CHANNEL_NAME = 'lithography-auth-session';

type ChannelLike = {
  postMessage: (message: unknown) => void;
  close: () => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
};

export type AuthSessionChannel = {
  publish: (event: AuthSessionChannelEvent) => void;
  subscribe: (handler: (event: AuthSessionChannelEvent) => void) => () => void;
  close: () => void;
};

export function isAuthSessionChannelEvent(value: unknown): value is AuthSessionChannelEvent {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as { type?: unknown; accountId?: unknown };

  if (candidate.type === 'logout') return true;

  return candidate.type === 'session-replaced' && typeof candidate.accountId === 'number';
}

/**
 * 创建跨标签页通道。
 *
 * 运行环境不支持 `BroadcastChannel` 时降级为「无跨标签通知」（同一标签页行为不变）；
 * 绝不用 localStorage 轮询之类会持久化事件体的方案，避免事件被误当成凭据来源。
 */
export function createAuthSessionChannel(
  createChannel: (name: string) => ChannelLike | null = defaultCreateChannel,
): AuthSessionChannel {
  let channel: ChannelLike | null = null;

  const getChannel = (): ChannelLike | null => {
    if (channel) return channel;

    try {
      channel = createChannel(AUTH_SESSION_CHANNEL_NAME);
    } catch {
      channel = null;
    }

    return channel;
  };

  return {
    publish(event) {
      getChannel()?.postMessage(event);
    },
    subscribe(handler) {
      const activeChannel = getChannel();

      if (!activeChannel) {
        return () => undefined;
      }

      const listener = (messageEvent: MessageEvent) => {
        if (isAuthSessionChannelEvent(messageEvent.data)) {
          handler(messageEvent.data);
        }
      };

      activeChannel.addEventListener('message', listener);

      return () => {
        activeChannel.removeEventListener('message', listener);
      };
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}

function defaultCreateChannel(name: string): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }

  return new BroadcastChannel(name);
}

export const authSessionChannel = createAuthSessionChannel();
