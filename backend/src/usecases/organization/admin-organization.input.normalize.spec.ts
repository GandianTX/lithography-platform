// src/usecases/organization/admin-organization.input.normalize.spec.ts

import { INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import {
  ADMIN_ORGANIZATION_KEYWORD_MAX_LENGTH,
  normalizeAdminOrganizationCreateInput,
  normalizeAdminOrganizationUpdateInput,
  normalizeBooleanFlag,
  normalizeOptionalEmail,
  normalizeOrganizationId,
  normalizeOrganizationKeyword,
  normalizeOrganizationStatus,
} from './admin-organization.input.normalize';

describe('admin-organization.input.normalize（一级公司档案输入归一）', () => {
  describe('normalizeOrganizationKeyword', () => {
    it('去首尾空白透传；缺省、null 与纯空白视为未填', () => {
      expect(normalizeOrganizationKeyword('  光刻  ')).toBe('光刻');
      expect(normalizeOrganizationKeyword(undefined)).toBeUndefined();
      expect(normalizeOrganizationKeyword(null)).toBeUndefined();
      expect(normalizeOrganizationKeyword('   ')).toBeUndefined();
    });

    it('非字符串或超长拒绝，不静默截断', () => {
      expect(() => normalizeOrganizationKeyword(123)).toThrow(
        expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }),
      );
      expect(() =>
        normalizeOrganizationKeyword('a'.repeat(ADMIN_ORGANIZATION_KEYWORD_MAX_LENGTH + 1)),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });
  });

  describe('normalizeOrganizationId', () => {
    it('正整数透传，其余拒绝', () => {
      expect(normalizeOrganizationId(7)).toBe(7);

      for (const invalid of [0, -1, 1.5, '7', null, undefined]) {
        expect(() => normalizeOrganizationId(invalid)).toThrow(
          expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }),
        );
      }
    });
  });

  describe('normalizeOrganizationStatus / normalizeBooleanFlag', () => {
    it('状态只接受 ACTIVE / DISABLED', () => {
      expect(normalizeOrganizationStatus('ACTIVE')).toBe('ACTIVE');
      expect(normalizeOrganizationStatus('DISABLED')).toBe('DISABLED');
      expect(() => normalizeOrganizationStatus('PENDING')).toThrow(
        expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE }),
      );
    });

    it('布尔开关只接受真正的布尔值', () => {
      expect(normalizeBooleanFlag(true, 'isServiceProvider', '提供维修服务')).toBe(true);
      expect(() => normalizeBooleanFlag('true', 'isServiceProvider', '提供维修服务')).toThrow(
        expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }),
      );
    });
  });

  describe('normalizeOptionalEmail', () => {
    it('缺省与空白归一为 null，非空时校验格式', () => {
      expect(normalizeOptionalEmail(undefined)).toBeNull();
      expect(normalizeOptionalEmail('  ')).toBeNull();
      expect(normalizeOptionalEmail(' ops@example.com ')).toBe('ops@example.com');
      expect(() => normalizeOptionalEmail('not-an-email')).toThrow(
        expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }),
      );
    });
  });

  describe('normalizeAdminOrganizationCreateInput', () => {
    it('全称与联系电话 trim 后必填；可选字段缺省为 null；维修资格缺省 false', () => {
      expect(
        normalizeAdminOrganizationCreateInput({
          name: '  光刻设备（上海）有限公司  ',
          contactPhone: ' 021-12345678 ',
        }),
      ).toEqual({
        name: '光刻设备（上海）有限公司',
        contactPhone: '021-12345678',
        shortName: null,
        contactName: null,
        contactEmail: null,
        address: null,
        remark: null,
        isServiceProvider: false,
      });
    });

    it('全称或联系电话 trim 后为空、超长、邮箱非法时拒绝', () => {
      expect(() =>
        normalizeAdminOrganizationCreateInput({ name: '   ', contactPhone: '021' }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY }));

      expect(() =>
        normalizeAdminOrganizationCreateInput({ name: '公司', contactPhone: '   ' }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY }));

      expect(() =>
        normalizeAdminOrganizationCreateInput({
          name: 'a'.repeat(201),
          contactPhone: '021',
        }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));

      expect(() =>
        normalizeAdminOrganizationCreateInput({
          name: '公司',
          contactPhone: '021',
          contactEmail: 'bad-email',
        }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });
  });

  describe('normalizeAdminOrganizationUpdateInput', () => {
    it('未提供的键不进入补丁，未传字段保持不变', () => {
      const { organizationId, patch } = normalizeAdminOrganizationUpdateInput({
        organizationId: 7,
        name: ' 新全称 ',
      });

      expect(organizationId).toBe(7);
      expect(patch).toEqual({ name: '新全称' });
      expect(Object.keys(patch)).toHaveLength(1);
    });

    it('显式 null 或纯空白收敛为 null（清空），布尔与状态按白名单写入', () => {
      const { patch } = normalizeAdminOrganizationUpdateInput({
        organizationId: 7,
        shortName: '   ',
        contactName: null,
        contactEmail: '',
        address: ' 上海市 ',
        remark: null,
        status: 'DISABLED',
        isServiceProvider: true,
      });

      expect(patch).toEqual({
        shortName: null,
        contactName: null,
        contactEmail: null,
        address: '上海市',
        remark: null,
        status: 'DISABLED',
        isServiceProvider: true,
      });
    });

    it('全称或联系电话显式为空白时拒绝，required 字段不会被写成 null', () => {
      expect(() =>
        normalizeAdminOrganizationUpdateInput({ organizationId: 7, name: '  ' }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.REQUIRED_TEXT_EMPTY }));

      expect(() =>
        normalizeAdminOrganizationUpdateInput({ organizationId: 7, contactPhone: null }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });

    it('编号、受管归类与类别即使混入原始入参也不会进入补丁', () => {
      const raw = {
        organizationId: 7,
        name: '公司',
        organizationCode: 'HACKED',
        isManagedCompany: false,
        kind: 'PEER',
      };
      const { patch } = normalizeAdminOrganizationUpdateInput(raw);

      expect(patch).toEqual({ name: '公司' });
    });

    it('状态与维修资格仅接受白名单值 / 布尔值', () => {
      expect(() =>
        normalizeAdminOrganizationUpdateInput({ organizationId: 7, status: 'PENDING' }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_ENUM_VALUE }));

      expect(() =>
        normalizeAdminOrganizationUpdateInput({ organizationId: 7, isServiceProvider: 'yes' }),
      ).toThrow(expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_TEXT }));
    });
  });
});
