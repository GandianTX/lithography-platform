import { AudienceTypeEnum, IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeEngineerRegistrationProfile,
  normalizeRegisterWithEmailInput,
  normalizeRegisterWithThirdPartyInput,
  normalizeRegistrationNicknameCandidatesInput,
  normalizeRegistrationOrganizationName,
  normalizeWeappRegisterInput,
  normalizeWeappRegisterParams,
  resolveRegistrationOrganizationChoice,
} from './registration-input.normalize';

describe('registration input normalize', () => {
  it('邮箱注册应 trim/lowercase 邮箱，并稳定化昵称', () => {
    expect(
      normalizeRegisterWithEmailInput({
        loginEmail: ' USER@Example.COM ',
        nickname: ' Ｔｅｓｔ　Ｕｓｅｒ🙂 ',
      }),
    ).toEqual({
      loginEmail: 'user@example.com',
      nickname: 'Test User',
    });
  });

  it('邮箱注册缺省或空白昵称应归一化为 undefined', () => {
    expect(
      normalizeRegisterWithEmailInput({
        loginEmail: 'user@example.com',
        nickname: null,
      }),
    ).toEqual({
      loginEmail: 'user@example.com',
      nickname: undefined,
    });

    expect(
      normalizeRegisterWithEmailInput({
        loginEmail: 'user@example.com',
        nickname: undefined,
      }),
    ).toEqual({
      loginEmail: 'user@example.com',
      nickname: undefined,
    });
  });

  it('邮箱注册应拒绝不符合规则的昵称', () => {
    expect(() =>
      normalizeRegisterWithEmailInput({
        loginEmail: 'user@example.com',
        nickname: 'A',
      }),
    ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
  });

  it('昵称候选项应 trim、过滤空白并去重', () => {
    expect(
      normalizeRegistrationNicknameCandidatesInput({
        providedNickname: '  Alice  ',
        fallbackOptions: [' Alice ', 'Bob', '', 'Bob', null],
      }),
    ).toEqual({
      providedNickname: 'Alice',
      fallbackOptions: ['Alice', 'Bob'],
    });
  });

  it('第三方注册邮箱应允许缺省、null 和空白输入', () => {
    expect(normalizeRegisterWithThirdPartyInput({})).toEqual({ email: undefined });
    expect(normalizeRegisterWithThirdPartyInput({ email: null })).toEqual({ email: undefined });
    expect(normalizeRegisterWithThirdPartyInput({ email: '   ' })).toEqual({ email: undefined });
    expect(normalizeRegisterWithThirdPartyInput({ email: ' USER@Example.COM ' })).toEqual({
      email: 'user@example.com',
    });
  });

  it('weapp 注册应提供稳定默认昵称并归一化参数', () => {
    expect(normalizeWeappRegisterInput()).toEqual({ defaultNickname: '微信用户' });
    expect(
      normalizeWeappRegisterParams({
        authCredential: '  credential  ',
        audience: AudienceTypeEnum.DESKTOP,
      }),
    ).toEqual({
      authCredential: 'credential',
      audience: AudienceTypeEnum.DESKTOP,
    });
  });

  it('weapp 注册应拒绝非法 audience', () => {
    expect(() =>
      normalizeWeappRegisterParams({
        authCredential: 'credential',
        audience: 'MOBILE' as unknown as AudienceTypeEnum,
      }),
    ).toThrow(DomainError);
  });

  describe('手填公司名称与公司分支', () => {
    it('公司名称 trim；空白归一为 null；超长拒绝', () => {
      expect(normalizeRegistrationOrganizationName('  光刻公司  ')).toBe('光刻公司');
      expect(normalizeRegistrationOrganizationName('   ')).toBeNull();
      expect(normalizeRegistrationOrganizationName(null)).toBeNull();
      expect(() => normalizeRegistrationOrganizationName('公'.repeat(201))).toThrow(DomainError);
    });

    it('客户只传公司 ID：走名单内公司分支', () => {
      expect(
        resolveRegistrationOrganizationChoice({
          organizationId: 12,
          role: IdentityTypeEnum.CUSTOMER,
        }),
      ).toEqual({ kind: 'EXISTING', organizationId: 12 });
    });

    it('客户只传手填名称：走新建公司分支（名称已 trim）', () => {
      expect(
        resolveRegistrationOrganizationChoice({
          organizationName: '  自家公司  ',
          role: IdentityTypeEnum.CUSTOMER,
        }),
      ).toEqual({ kind: 'SELF_FILLED', organizationName: '自家公司' });
    });

    it('客户混传 ID 与手填名称：拒绝', () => {
      expect(() =>
        resolveRegistrationOrganizationChoice({
          organizationId: 12,
          organizationName: '自家公司',
          role: IdentityTypeEnum.CUSTOMER,
        }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });

    it('客户 ID 与名称皆空：拒绝', () => {
      expect(() =>
        resolveRegistrationOrganizationChoice({ role: IdentityTypeEnum.CUSTOMER }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });

    it('非法公司 ID：拒绝', () => {
      expect(() =>
        resolveRegistrationOrganizationChoice({
          organizationId: 0,
          role: IdentityTypeEnum.CUSTOMER,
        }),
      ).toThrow(DomainError);
    });

    it('工程师只允许名单内公司，手填名称拒绝', () => {
      expect(
        resolveRegistrationOrganizationChoice({
          organizationId: 12,
          role: IdentityTypeEnum.ENGINEER,
        }),
      ).toEqual({ kind: 'EXISTING', organizationId: 12 });
      expect(() =>
        resolveRegistrationOrganizationChoice({
          organizationName: '自家公司',
          role: IdentityTypeEnum.ENGINEER,
        }),
      ).toThrow(DomainError);
    });
  });

  describe('工程师姓名与联系电话', () => {
    it('trim 后原样保留姓名与带分隔符的电话', () => {
      expect(
        normalizeEngineerRegistrationProfile({
          realName: '  张三  ',
          phone: ' 138-0013-8000 ',
        }),
      ).toEqual({ realName: '张三', phone: '138-0013-8000' });
    });

    it('姓名与电话缺省、空白或非字符串均拒绝', () => {
      for (const input of [
        { realName: undefined, phone: '13800138000' },
        { realName: '   ', phone: '13800138000' },
        { realName: 123, phone: '13800138000' },
        { realName: '张三', phone: null },
        { realName: '张三', phone: ' ' },
      ]) {
        expect(() => normalizeEngineerRegistrationProfile(input)).toThrow(DomainError);
      }
    });

    it('姓名超过 200 字符、电话超过 20 字符即拒绝', () => {
      expect(() =>
        normalizeEngineerRegistrationProfile({
          realName: '张'.repeat(201),
          phone: '13800138000',
        }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));

      expect(() =>
        normalizeEngineerRegistrationProfile({
          realName: '张三',
          phone: '1'.repeat(21),
        }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });

    it('电话去分隔符后必须是 6–20 位数字，允许前导 +', () => {
      expect(
        normalizeEngineerRegistrationProfile({ realName: '张三', phone: '+8613800138000' }),
      ).toEqual({ realName: '张三', phone: '+8613800138000' });

      for (const phone of ['12345', 'abcdefgh', '138 0013 8000 ext 1', '++8613800138000']) {
        expect(() => normalizeEngineerRegistrationProfile({ realName: '张三', phone })).toThrow(
          expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }),
        );
      }
    });
  });
});
