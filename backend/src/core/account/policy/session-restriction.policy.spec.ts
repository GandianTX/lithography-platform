// src/core/account/policy/session-restriction.policy.spec.ts

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { UserState } from '@app-types/models/user-info.types';
import { SessionRestriction } from '@app-types/auth/session-restriction.types';

import {
  evaluateSessionStatusCombination,
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

describe('会话状态组合门禁策略', () => {
  const gate = (
    accountStatus: AccountStatus | null,
    userState: UserState | null,
    restriction: SessionRestriction = SessionRestriction.NONE,
    allowRestrictedSession = false,
  ) =>
    evaluateSessionStatusCombination({
      accountStatus,
      userState,
      restriction,
      allowRestrictedSession,
    });

  it('ACTIVE／ACTIVE 在无限制时放行', () => {
    expect(gate(AccountStatus.ACTIVE, UserState.ACTIVE)).toEqual({ allowed: true });
  });

  it('ACTIVE／ACTIVE 存在限制时仍需入口显式允许受限会话', () => {
    expect(
      gate(AccountStatus.ACTIVE, UserState.ACTIVE, SessionRestriction.MUST_CHANGE_PASSWORD),
    ).toEqual({ allowed: false, rejection: 'RESTRICTED_SESSION_NOT_ALLOWED' });
    expect(
      gate(AccountStatus.ACTIVE, UserState.ACTIVE, SessionRestriction.MUST_CHANGE_PASSWORD, true),
    ).toEqual({ allowed: true });
  });

  it('PENDING／PENDING 仅在存在限制且允许受限会话时放行', () => {
    expect(
      gate(AccountStatus.PENDING, UserState.PENDING, SessionRestriction.ENGINEER_PENDING, true),
    ).toEqual({ allowed: true });
    expect(
      gate(AccountStatus.PENDING, UserState.PENDING, SessionRestriction.ENGINEER_PENDING, false),
    ).toEqual({ allowed: false, rejection: 'RESTRICTED_SESSION_NOT_ALLOWED' });
    expect(gate(AccountStatus.PENDING, UserState.PENDING, SessionRestriction.NONE, true)).toEqual({
      allowed: false,
      rejection: 'STATUS_NOT_ALLOWED',
    });
  });

  it.each([
    ['账号 ACTIVE / 资料 PENDING', AccountStatus.ACTIVE, UserState.PENDING],
    ['账号 PENDING / 资料 ACTIVE', AccountStatus.PENDING, UserState.ACTIVE],
  ])('%s 的单边状态即使允许受限会话也失败关闭', (_label, accountStatus, userState) => {
    expect(gate(accountStatus, userState, SessionRestriction.ENGINEER_PENDING, true)).toEqual({
      allowed: false,
      rejection: 'STATUS_COMBINATION_MISMATCH',
    });
  });

  it('缺行失败关闭并区分账号行与资料行', () => {
    expect(gate(null, UserState.PENDING, SessionRestriction.ENGINEER_PENDING, true)).toEqual({
      allowed: false,
      rejection: 'ACCOUNT_STATUS_MISSING',
    });
    expect(gate(AccountStatus.PENDING, null, SessionRestriction.ENGINEER_PENDING, true)).toEqual({
      allowed: false,
      rejection: 'USER_STATE_MISSING',
    });
  });

  it.each([
    ['账号停用', AccountStatus.SUSPENDED, UserState.ACTIVE],
    ['账号封禁', AccountStatus.BANNED, UserState.SUSPENDED],
    ['资料停用', AccountStatus.ACTIVE, UserState.SUSPENDED],
    ['双状态停用', AccountStatus.SUSPENDED, UserState.SUSPENDED],
  ])('%s 时即使允许受限会话也拒绝', (_label, accountStatus, userState) => {
    expect(gate(accountStatus, userState, SessionRestriction.MUST_CHANGE_PASSWORD, true)).toEqual({
      allowed: false,
      rejection: 'STATUS_NOT_ALLOWED',
    });
  });
});
