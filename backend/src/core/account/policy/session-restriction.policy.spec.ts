// src/core/account/policy/session-restriction.policy.spec.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';

import {
  isAccountStatusAllowedForSession,
  isUserStateAllowedForSession,
  resolveSessionRestriction,
  type SessionRestrictionFacts,
} from './session-restriction.policy';

describe('会话限制解析策略', () => {
  const facts = (overrides: Partial<SessionRestrictionFacts> = {}): SessionRestrictionFacts => ({
    mustChangePassword: false,
    identityHint: IdentityTypeEnum.ENGINEER,
    accountStatus: AccountStatus.ACTIVE,
    userState: UserState.ACTIVE,
    latestEngineerApplicationStatus: null,
    latestEngineerApplicationOrganizationId: null,
    effectiveEngineerOrganizationIds: [],
    ...overrides,
  });

  it('必须改密优先级最高', () => {
    expect(
      resolveSessionRestriction(
        facts({
          mustChangePassword: true,
          latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.REJECTED,
        }),
      ),
    ).toBe(SessionRestriction.MUST_CHANGE_PASSWORD);
  });

  it.each([
    [EngineerRegistrationApplicationStatus.PENDING, SessionRestriction.ENGINEER_PENDING],
    [EngineerRegistrationApplicationStatus.REJECTED, SessionRestriction.ENGINEER_REJECTED],
  ])('申请状态 %s 直接决定限制', (status, expected) => {
    expect(
      resolveSessionRestriction(
        facts({
          accountStatus: AccountStatus.PENDING,
          userState: UserState.PENDING,
          latestEngineerApplicationStatus: status,
        }),
      ),
    ).toBe(expected);
  });

  describe('已批准申请的资格生效判定', () => {
    it.each([
      [
        '缺少有效工程师成员关系',
        facts({
          latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.APPROVED,
          latestEngineerApplicationOrganizationId: 501,
        }),
      ],
      [
        '成员组织与申请目标不一致',
        facts({
          latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.APPROVED,
          latestEngineerApplicationOrganizationId: 501,
          effectiveEngineerOrganizationIds: [502],
        }),
      ],
      [
        '存在多个工程师成员组织（歧义）',
        facts({
          latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.APPROVED,
          latestEngineerApplicationOrganizationId: 501,
          effectiveEngineerOrganizationIds: [501, 502],
        }),
      ],
      [
        '账号未处于 ACTIVE',
        facts({
          accountStatus: AccountStatus.PENDING,
          latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.APPROVED,
          latestEngineerApplicationOrganizationId: 501,
          effectiveEngineerOrganizationIds: [501],
        }),
      ],
      [
        '资料未处于 ACTIVE',
        facts({
          userState: UserState.SUSPENDED,
          latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.APPROVED,
          latestEngineerApplicationOrganizationId: 501,
          effectiveEngineerOrganizationIds: [501],
        }),
      ],
    ])('%s 时返回 ENGINEER_INACTIVE', (_label, input) => {
      expect(resolveSessionRestriction(input)).toBe(SessionRestriction.ENGINEER_INACTIVE);
    });

    it('双状态 ACTIVE 且唯一成员组织等于申请目标时返回 NONE', () => {
      expect(
        resolveSessionRestriction(
          facts({
            latestEngineerApplicationStatus: EngineerRegistrationApplicationStatus.APPROVED,
            latestEngineerApplicationOrganizationId: 501,
            effectiveEngineerOrganizationIds: [501],
          }),
        ),
      ).toBe(SessionRestriction.NONE);
    });
  });

  it('无申请记录但双状态 PENDING 的工程师回落到 ENGINEER_PENDING', () => {
    expect(
      resolveSessionRestriction(
        facts({ accountStatus: AccountStatus.PENDING, userState: UserState.PENDING }),
      ),
    ).toBe(SessionRestriction.ENGINEER_PENDING);
  });

  it('无申请记录的存量工程师保持 NONE，不追加成员事实要求', () => {
    expect(resolveSessionRestriction(facts())).toBe(SessionRestriction.NONE);
  });

  it('非工程师身份不因申请状态字段缺失而被限制', () => {
    expect(
      resolveSessionRestriction(
        facts({ identityHint: IdentityTypeEnum.CUSTOMER, accountStatus: AccountStatus.ACTIVE }),
      ),
    ).toBe(SessionRestriction.NONE);
  });
});

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
