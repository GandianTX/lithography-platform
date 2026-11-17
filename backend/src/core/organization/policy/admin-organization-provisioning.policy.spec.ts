// src/core/organization/policy/admin-organization-provisioning.policy.spec.ts

import { randomBytes } from 'crypto';
import { DomainError, ORGANIZATION_MANAGEMENT_ERROR } from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import { LOGIN_NAME_MAX_LENGTH } from '@core/account/policy/login-name.policy';
import {
  PROVISIONED_ADMIN_LOGIN_PREFIX,
  PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH,
  PROVISIONED_ADMIN_TEMPORARY_PASSWORD_PREFIX,
  computeProvisioningInputFingerprint,
  deriveProvisionedAdminLoginName,
  deriveProvisionedAdminNickname,
  generateTemporaryPasswordCandidate,
  normalizeProvisioningSubmissionKey,
  type ProvisioningFingerprintInput,
} from './admin-organization-provisioning.policy';

describe('admin organization provisioning policy', () => {
  const baseInput: ProvisioningFingerprintInput = {
    name: '示例客户公司',
    shortName: '示例',
    contactName: '张三',
    contactPhone: '13800000000',
    contactEmail: 'zhangsan@example.com',
    address: '上海市',
    remark: null,
    status: 'ACTIVE',
    isServiceProvider: false,
  };

  describe('normalizeProvisioningSubmissionKey', () => {
    it('接受合法 UUID 并统一小写与去空白', () => {
      const key = ' 3F2504E0-4F89-41D3-9A0C-0305E82C3301 ';
      expect(normalizeProvisioningSubmissionKey(key)).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    });

    it.each([
      ['非字符串', 123],
      ['空串', '   '],
      ['缺段', '3f2504e0-4f89-41d3-9a0c'],
      ['非十六进制', 'zzzzzzzz-4f89-41d3-9a0c-0305e82c3301'],
      ['变体非法', '3f2504e0-4f89-41d3-ca0c-0305e82c3301'],
    ])('拒绝非法提交标识：%s', (_label, value) => {
      expect(() => normalizeProvisioningSubmissionKey(value)).toThrow(DomainError);
      try {
        normalizeProvisioningSubmissionKey(value);
      } catch (error) {
        expect((error as DomainError).code).toBe(
          ORGANIZATION_MANAGEMENT_ERROR.SUBMISSION_KEY_INVALID,
        );
      }
    });
  });

  describe('computeProvisioningInputFingerprint', () => {
    it('同输入产生稳定的 64 位十六进制指纹', () => {
      const first = computeProvisioningInputFingerprint({ ...baseInput });
      const second = computeProvisioningInputFingerprint({ ...baseInput });
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each([
      ['name', '另一客户公司'],
      ['shortName', '另一'],
      ['contactName', '李四'],
      ['contactPhone', '13900000000'],
      ['contactEmail', 'lisi@example.com'],
      ['address', '北京市'],
      ['remark', '备注'],
      ['status', 'DISABLED'],
      ['isServiceProvider', true],
    ] as ReadonlyArray<[keyof ProvisioningFingerprintInput, unknown]>)(
      '字段 %s 变化会改变指纹',
      (field, value) => {
        const changed = { ...baseInput, [field]: value };
        expect(computeProvisioningInputFingerprint(changed)).not.toBe(
          computeProvisioningInputFingerprint(baseInput),
        );
      },
    );

    it('null 与空串在指纹上可区分', () => {
      const withNull = computeProvisioningInputFingerprint({ ...baseInput, remark: null });
      const withEmpty = computeProvisioningInputFingerprint({ ...baseInput, remark: '' });
      expect(withNull).not.toBe(withEmpty);
    });
  });

  describe('deriveProvisionedAdminLoginName', () => {
    it('生成固定前缀、列宽内且符合登录名字符集的稳定登录名', () => {
      const loginName = deriveProvisionedAdminLoginName(
        'ADMIN_ORG_2f1c0d3a-0000-4000-8000-000000000001',
      );
      expect(loginName.startsWith(PROVISIONED_ADMIN_LOGIN_PREFIX)).toBe(true);
      expect(loginName).toHaveLength(29);
      expect(loginName.length).toBeLessThanOrEqual(LOGIN_NAME_MAX_LENGTH);
      expect(loginName).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(
        deriveProvisionedAdminLoginName('ADMIN_ORG_2f1c0d3a-0000-4000-8000-000000000001'),
      ).toBe(loginName);
    });

    it('不同公司编号生成不同登录名', () => {
      expect(deriveProvisionedAdminLoginName('ADMIN_ORG_A')).not.toBe(
        deriveProvisionedAdminLoginName('ADMIN_ORG_B'),
      );
    });
  });

  describe('deriveProvisionedAdminNickname', () => {
    it('短名称原样返回', () => {
      expect(deriveProvisionedAdminNickname('示例公司')).toBe('示例公司');
    });

    it('超长名称按码点截断到 50', () => {
      const nickname = deriveProvisionedAdminNickname('公'.repeat(80));
      expect(Array.from(nickname)).toHaveLength(PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH);
      expect(nickname).toBe('公'.repeat(PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH));
    });

    it('不切断代理对（emoji 完整保留）', () => {
      const nickname = deriveProvisionedAdminNickname('😀'.repeat(60));
      expect(Array.from(nickname)).toHaveLength(PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH);
      expect(nickname).toBe('😀'.repeat(PROVISIONED_ADMIN_NICKNAME_MAX_LENGTH));
    });

    it('空白名称拒绝生成', () => {
      expect(() => deriveProvisionedAdminNickname('   ')).toThrow(DomainError);
    });
  });

  describe('generateTemporaryPasswordCandidate', () => {
    const passwordPolicyService = new PasswordPolicyService();

    it('固定长度、固定前缀', () => {
      for (let index = 0; index < 200; index += 1) {
        const candidate = generateTemporaryPasswordCandidate(randomBytes);
        expect(candidate.startsWith(PROVISIONED_ADMIN_TEMPORARY_PASSWORD_PREFIX)).toBe(true);
        expect(candidate).toHaveLength(PROVISIONED_ADMIN_TEMPORARY_PASSWORD_PREFIX.length + 16);
      }
    });

    it('按调用方最多 5 次重试即可得到策略合法密码', () => {
      // 生成器已排除连续 3 个重复字符；其余极低概率不合格项由调用方重试兜底。
      for (let round = 0; round < 200; round += 1) {
        let valid = false;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const candidate = generateTemporaryPasswordCandidate(randomBytes);
          if (passwordPolicyService.validatePassword(candidate).isValid) {
            valid = true;
            break;
          }
        }
        expect(valid).toBe(true);
      }
    });

    it('使用注入的安全随机源而不是可预测常量', () => {
      const sequence = (offset: number) => (size: number) =>
        Buffer.from(Array.from({ length: size }, (_, index) => (index * 7 + offset) % 64));
      const fixed = generateTemporaryPasswordCandidate(sequence(0));
      const other = generateTemporaryPasswordCandidate(sequence(1));
      expect(fixed).not.toBe(other);
    });

    it('随机源返回空 Buffer 时拒绝生成', () => {
      expect(() => generateTemporaryPasswordCandidate(() => Buffer.alloc(0))).toThrow(DomainError);
    });
  });
});
