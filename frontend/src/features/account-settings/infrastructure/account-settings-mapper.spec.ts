// src/features/account-settings/infrastructure/account-settings-mapper.spec.ts

/**
 * 账号设置 mapper（防腐层）单测。
 *
 * 覆盖三点边界：可选文本归一、昵称必填守卫、role / status 枚举失败关闭。
 * mapper 不信任后端数据——无法识别的枚举让整次映射失败，而不是降级成错误展示。
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SETTINGS_ROLES,
  ACCOUNT_SETTINGS_STATUSES,
} from '../application/account-settings.types';

import type { MyAccountSettingsDto } from './account-settings.dto';
import { mapMyAccountSettingsDtoToView } from './account-settings-mapper';

const UPDATED_AT = '2026-01-01T08:00:00.000Z';

function makeDto(overrides?: Partial<MyAccountSettingsDto>): MyAccountSettingsDto {
  return {
    adminLevel: 2,
    companyName: '  示例公司  ',
    contactEmail: '  contact@example.com  ',
    loginEmail: '  self@example.com  ',
    loginName: '  self_user  ',
    nickname: '  陈工  ',
    phone: '  13800000000  ',
    realName: '  张三  ',
    role: 'ENGINEER',
    status: 'ACTIVE',
    trustedCompanyName: '  可信公司  ',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('mapMyAccountSettingsDtoToView 字段归一', () => {
  it('trim 可选文本与昵称，updatedAt 原样透传', () => {
    expect(mapMyAccountSettingsDtoToView(makeDto())).toEqual({
      adminLevel: 2,
      companyName: '示例公司',
      contactEmail: 'contact@example.com',
      loginEmail: 'self@example.com',
      loginName: 'self_user',
      nickname: '陈工',
      phone: '13800000000',
      realName: '张三',
      role: 'ENGINEER',
      status: 'ACTIVE',
      trustedCompanyName: '可信公司',
      updatedAt: UPDATED_AT,
    });
  });

  it('空串、纯空白与非字符串的可选字段一律归 null，不让脏值流入内部模型', () => {
    expect(
      mapMyAccountSettingsDtoToView(
        makeDto({
          companyName: '',
          contactEmail: '   ',
          loginEmail: null,
          loginName: 42 as unknown as string,
          phone: {} as unknown as string,
          realName: '   ',
          trustedCompanyName: '',
        }),
      ),
    ).toEqual({
      adminLevel: 2,
      companyName: null,
      contactEmail: null,
      loginEmail: null,
      loginName: null,
      nickname: '陈工',
      phone: null,
      realName: null,
      role: 'ENGINEER',
      status: 'ACTIVE',
      trustedCompanyName: null,
      updatedAt: UPDATED_AT,
    });
  });
});

describe('mapMyAccountSettingsDtoToView 昵称守卫', () => {
  it.each([[''], ['   '], [undefined], [null], [7]])(
    '昵称缺失或空白（%s）时整次映射失败',
    (nickname) => {
      expect(() =>
        mapMyAccountSettingsDtoToView(makeDto({ nickname: nickname as unknown as string })),
      ).toThrow('账号设置返回了缺失的昵称。');
    },
  );
});

describe('mapMyAccountSettingsDtoToView 枚举失败关闭', () => {
  it.each([['OPERATOR'], ['engineer'], [''], ['ACTIVE'], [null], [undefined], [3]])(
    '未知 role（%s）抛错而不是降级成错误展示',
    (role) => {
      expect(() =>
        mapMyAccountSettingsDtoToView(makeDto({ role: role as unknown as string })),
      ).toThrow('账号设置返回了无法识别的角色。');
    },
  );

  it.each([['ARCHIVED'], ['active'], [''], ['ENGINEER'], [null], [undefined], [0]])(
    '未知 status（%s）抛错而不是降级成错误展示',
    (status) => {
      expect(() =>
        mapMyAccountSettingsDtoToView(makeDto({ status: status as unknown as string })),
      ).toThrow('账号设置返回了无法识别的状态。');
    },
  );

  it('契约内的全部 role 与 status 都能通过守卫', () => {
    for (const role of ACCOUNT_SETTINGS_ROLES) {
      expect(mapMyAccountSettingsDtoToView(makeDto({ role })).role).toBe(role);
    }

    for (const status of ACCOUNT_SETTINGS_STATUSES) {
      expect(mapMyAccountSettingsDtoToView(makeDto({ status })).status).toBe(status);
    }
  });
});

describe('mapMyAccountSettingsDtoToView 等级失败关闭', () => {
  it('null 表示未设置，原样保留；有限整数原样透传', () => {
    expect(mapMyAccountSettingsDtoToView(makeDto({ adminLevel: null })).adminLevel).toBeNull();
    expect(mapMyAccountSettingsDtoToView(makeDto({ adminLevel: 0 })).adminLevel).toBe(0);
    expect(mapMyAccountSettingsDtoToView(makeDto({ adminLevel: -1 })).adminLevel).toBe(-1);
  });

  it.each([[1.5], ['2'], [Number.NaN], [Number.POSITIVE_INFINITY], [undefined], [{}], [true]])(
    '未知等级（%s）抛错而不是降级成占位展示',
    (adminLevel) => {
      expect(() =>
        mapMyAccountSettingsDtoToView(makeDto({ adminLevel: adminLevel as unknown as number })),
      ).toThrow('账号设置返回了无法识别的等级。');
    },
  );
});

describe('mapMyAccountSettingsDtoToView 视图形状', () => {
  it('视图只含十二项展示字段，不携带 accountId 与任何凭据 / 令牌字段', () => {
    const polluted = {
      ...makeDto(),
      accountId: 900101,
      loginPassword: 'should-not-survive',
    } as unknown as MyAccountSettingsDto;
    const view = mapMyAccountSettingsDtoToView(polluted);
    const forbidden = [
      'accessGroup',
      'accountId',
      'identityHint',
      'loginPassword',
      'metaDigest',
      'password',
      'passwordHash',
      'token',
      'userState',
    ];

    expect(Object.keys(view).sort()).toEqual([
      'adminLevel',
      'companyName',
      'contactEmail',
      'loginEmail',
      'loginName',
      'nickname',
      'phone',
      'realName',
      'role',
      'status',
      'trustedCompanyName',
      'updatedAt',
    ]);

    for (const key of forbidden) {
      expect(view).not.toHaveProperty(key);
    }
  });
});
