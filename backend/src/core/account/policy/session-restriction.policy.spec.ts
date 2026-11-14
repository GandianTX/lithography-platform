// src/core/account/policy/session-restriction.policy.spec.ts

import { AccountStatus } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';

import {
  isAccountStatusAllowedForSession,
  isUserStateAllowedForSession,
} from './session-restriction.policy';

describe('会话状态门禁策略', () => {
  describe('账号状态', () => {
    it('无限制时 ACTIVE 放行、PENDING 拒绝', () => {
      expect(
        isAccountStatusAllowedForSession({
          accountStatus: AccountStatus.ACTIVE,
          restriction: SessionRestriction.NONE,
          allowRestrictedSession: false,
        }),
      ).toBe(true);
      expect(
        isAccountStatusAllowedForSession({
          accountStatus: AccountStatus.PENDING,
          restriction: SessionRestriction.NONE,
          allowRestrictedSession: true,
        }),
      ).toBe(false);
    });

    it('存在限制但调用方未允许受限会话时，ACTIVE 也拒绝', () => {
      expect(
        isAccountStatusAllowedForSession({
          accountStatus: AccountStatus.ACTIVE,
          restriction: SessionRestriction.ENGINEER_PENDING,
          allowRestrictedSession: false,
        }),
      ).toBe(false);
    });

    it('存在限制且允许受限会话时，PENDING 放行', () => {
      expect(
        isAccountStatusAllowedForSession({
          accountStatus: AccountStatus.PENDING,
          restriction: SessionRestriction.MUST_CHANGE_PASSWORD,
          allowRestrictedSession: true,
        }),
      ).toBe(true);
    });

    it('缺失或非 ACTIVE / PENDING 状态一律拒绝', () => {
      expect(
        isAccountStatusAllowedForSession({
          accountStatus: null,
          restriction: SessionRestriction.ENGINEER_PENDING,
          allowRestrictedSession: true,
        }),
      ).toBe(false);
      expect(
        isAccountStatusAllowedForSession({
          accountStatus: AccountStatus.BANNED,
          restriction: SessionRestriction.ENGINEER_PENDING,
          allowRestrictedSession: true,
        }),
      ).toBe(false);
    });
  });

  describe('资料状态', () => {
    it('与账号状态同口径', () => {
      expect(
        isUserStateAllowedForSession({
          userState: UserState.ACTIVE,
          restriction: SessionRestriction.NONE,
          allowRestrictedSession: false,
        }),
      ).toBe(true);
      expect(
        isUserStateAllowedForSession({
          userState: UserState.PENDING,
          restriction: SessionRestriction.ENGINEER_PENDING,
          allowRestrictedSession: true,
        }),
      ).toBe(true);
      expect(
        isUserStateAllowedForSession({
          userState: UserState.PENDING,
          restriction: SessionRestriction.NONE,
          allowRestrictedSession: true,
        }),
      ).toBe(false);
      expect(
        isUserStateAllowedForSession({
          userState: null,
          restriction: SessionRestriction.ENGINEER_PENDING,
          allowRestrictedSession: true,
        }),
      ).toBe(false);
    });
  });
});
