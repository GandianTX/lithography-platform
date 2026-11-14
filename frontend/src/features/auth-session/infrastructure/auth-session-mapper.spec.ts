// src/features/auth-session/infrastructure/auth-session-mapper.spec.ts

import { describe, expect, it } from 'vitest';

import { decodeAuthSessionPayload } from './auth-session-mapper';

describe('decodeAuthSessionPayload', () => {
  it('decodes a minimal valid payload into a normalized session snapshot', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: ' access-token ',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toEqual({
      accessToken: 'access-token',
      accountId: 900101,
      adminLevel: null,
      customerOrganizationId: null,
      restriction: 'NONE',
      role: 'ENGINEER',
      userInfo: null,
    });
  });

  it('decodes restricted-session facts and defaults unknown values safely', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        adminLevel: 2,
        customerOrganizationId: 4401,
        restriction: 'MUST_CHANGE_PASSWORD',
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toEqual({
      accessToken: 'access-token',
      accountId: 900101,
      adminLevel: 2,
      customerOrganizationId: 4401,
      restriction: 'MUST_CHANGE_PASSWORD',
      role: 'ENGINEER',
      userInfo: null,
    });

    // 未知限制状态与非法身份扩展字段：回落 NONE / null，不拒绝整份会话
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        adminLevel: '2',
        customerOrganizationId: 0,
        restriction: 'UNKNOWN',
        role: 'ENGINEER',
        userInfo: null,
      }),
    ).toMatchObject({
      adminLevel: null,
      customerOrganizationId: null,
      restriction: 'NONE',
    });
  });

  it('decodes a payload carrying a valid user summary', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          accessGroup: ['ENGINEER'],
          avatarUrl: ' https://example.test/avatar/chen.png ',
          nickname: ' 陈工 ',
        },
      }),
    ).toEqual({
      accessToken: 'access-token',
      accountId: 900101,
      adminLevel: null,
      customerOrganizationId: null,
      restriction: 'NONE',
      role: 'ENGINEER',
      userInfo: {
        accessGroup: ['ENGINEER'],
        avatarUrl: 'https://example.test/avatar/chen.png',
        nickname: '陈工',
      },
    });
  });

  it.each([
    ['a missing avatarUrl (legacy snapshot)', undefined],
    ['a blank avatarUrl', '   '],
    ['a non-string avatarUrl', 42],
  ])(
    'falls back to a null avatarUrl for %s instead of rejecting the session',
    (_caseName, value) => {
      expect(
        decodeAuthSessionPayload({
          accessToken: 'access-token',
          accountId: 900101,
          role: 'ENGINEER',
          userInfo: {
            accessGroup: ['ENGINEER'],
            avatarUrl: value,
            nickname: '陈工',
          },
        }),
      ).toEqual({
        accessToken: 'access-token',
        accountId: 900101,
        adminLevel: null,
        customerOrganizationId: null,
        restriction: 'NONE',
        role: 'ENGINEER',
        userInfo: {
          accessGroup: ['ENGINEER'],
          avatarUrl: null,
          nickname: '陈工',
        },
      });
    },
  );

  it('rejects non-record and missing-field payloads', () => {
    expect(decodeAuthSessionPayload(null)).toBeNull();
    expect(decodeAuthSessionPayload('session')).toBeNull();
    expect(
      decodeAuthSessionPayload({
        accountId: 900101,
        role: 'ENGINEER',
      }),
    ).toBeNull();
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: '900101',
        role: 'ENGINEER',
      }),
    ).toBeNull();
  });

  it('rejects unknown roles and invalid account ids', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'OPERATOR',
      }),
    ).toBeNull();
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: -1,
        role: 'ENGINEER',
      }),
    ).toBeNull();
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101.5,
        role: 'ENGINEER',
      }),
    ).toBeNull();
  });

  it('rejects whitespace-only tokens via the session policy invariants', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: '   ',
        accountId: 900101,
        role: 'ENGINEER',
      }),
    ).toBeNull();
  });

  it('rejects malformed user summaries instead of passing them through', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          accessGroup: [],
          nickname: '陈工',
        },
      }),
    ).toBeNull();
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          accessGroup: ['OPERATOR'],
          nickname: '陈工',
        },
      }),
    ).toBeNull();
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          nickname: '陈工',
        },
      }),
    ).toBeNull();
  });

  it('rejects summaries that contradict the active role', () => {
    expect(
      decodeAuthSessionPayload({
        accessToken: 'access-token',
        accountId: 900101,
        role: 'ENGINEER',
        userInfo: {
          accessGroup: ['CUSTOMER'],
          nickname: '错误身份',
        },
      }),
    ).toBeNull();
  });
});
