// src/features/auth-session/application/auth-session.types.ts

export const AUTH_SESSION_ROLES = ['SUPER_ADMIN', 'ENGINEER', 'CUSTOMER'] as const;

export type AuthSessionRole = (typeof AUTH_SESSION_ROLES)[number];

/**
 * 会话限制状态（与后端 SessionRestriction 同口径）：NONE 为正常会话，
 * 其余值只允许访问受限落地页 `/restricted`。限制状态由后端按数据库事实
 * 每请求重算，前端仅据此做路由收口，不作为授权依据。
 */
export const AUTH_SESSION_RESTRICTIONS = [
  'NONE',
  'MUST_CHANGE_PASSWORD',
  'ENGINEER_PENDING',
  'ENGINEER_REJECTED',
] as const;

export type AuthSessionRestriction = (typeof AUTH_SESSION_RESTRICTIONS)[number];

export type AuthSessionUserSummary = {
  accessGroup: readonly AuthSessionRole[];
  /**
   * 本人真实头像 URL（后端登录结果已返回该字段）；无头像时为 null。
   * 归一化保证字段恒存在：缺失/空白一律回落 null，消费方按 null 显示昵称首字，
   * 不因缺字段判定会话非法（旧持久化快照刷新后必须仍可用）。
   */
  avatarUrl: string | null;
  nickname: string;
};

export type AuthSessionSnapshot = {
  accessToken: string;
  accountId: number;
  /**
   * 管理员等级（非管理员为 null）与客户公司归属（无归属为 null）。
   * 二者均为身份展示/上下文事实，不参与会话合法性判定。
   */
  adminLevel: number | null;
  customerOrganizationId: number | null;
  /** 会话限制状态：非 NONE 时前端只放行 `/restricted` */
  restriction: AuthSessionRestriction;
  role: AuthSessionRole;
  userInfo: AuthSessionUserSummary | null;
};

/**
 * 建立会话的入参：新增的 restriction / adminLevel / customerOrganizationId
 * 设计为可选，兼容仅携带最小身份的既有调用方与测试夹具；缺省值分别为
 * NONE / null / null。
 */
export type EstablishAuthSessionInput = Omit<
  AuthSessionSnapshot,
  'adminLevel' | 'customerOrganizationId' | 'restriction'
> & {
  adminLevel?: number | null;
  customerOrganizationId?: number | null;
  restriction?: AuthSessionRestriction;
};

export type AuthSessionState =
  | {
      session: null;
      status: 'anonymous';
    }
  | {
      session: AuthSessionSnapshot;
      status: 'authenticated';
    };

export type AuthSessionPersistence = {
  clear: () => void;
  read: () => AuthSessionSnapshot | null;
  write: (session: AuthSessionSnapshot) => void;
};

/**
 * 不含 Token 的窄会话身份：accountId 标识「谁」，epoch 标识「哪一个会话生命周期」。
 * 会话建立（登录）、恢复（刷新后重建）、清除（登出 / 失效）都推进代次，同一账号
 * 退出后重新登录会得到不同代次；会话内的昵称回写不推进。供改密等动作在**请求
 * 发起前**采样固化身份，迟到响应由 store 与当前会话比对裁决。
 */
export type AuthSessionIdentity = {
  accountId: number;
  epoch: number;
};

export type AuthSessionView = Omit<AuthSessionSnapshot, 'accessToken'>;

export type AuthSessionViewState =
  | {
      session: null;
      status: 'anonymous';
    }
  | {
      session: AuthSessionView;
      status: 'authenticated';
    };
