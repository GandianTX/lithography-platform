/// <reference types="jest" />
// src/core/local-runtime/policy/local-runtime-viewer-scope.policy.spec.ts

import { DomainError } from '@core/common/errors/domain-error';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  assertInstallationSettingsWritable,
  assertLocalRuntimeAdministrator,
  resolveLocalRuntimeViewerScope,
  type LocalRuntimeViewerFacts,
} from './local-runtime-viewer-scope.policy';

const adminSession = (adminLevel: number | null, trustedOrganizationId: number | null = null) =>
  ({
    roles: [IdentityTypeEnum.SUPER_ADMIN],
    activeRole: IdentityTypeEnum.SUPER_ADMIN,
    adminLevel,
    trustedOrganizationId,
  }) satisfies LocalRuntimeViewerFacts;

const engineerSession = (trustedOrganizationId: number | null) =>
  ({
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
    adminLevel: null,
    trustedOrganizationId,
  }) satisfies LocalRuntimeViewerFacts;

describe('本地运行数据查看者范围判定', () => {
  describe('管理员', () => {
    it('一级管理员取得全局授权范围（organizationId 为 null）', () => {
      expect(resolveLocalRuntimeViewerScope(adminSession(1))).toEqual({
        role: 'ADMIN_LEVEL_1',
        organizationId: null,
        adminLevel: 1,
      });
    });

    it('二级管理员限定在可信公司', () => {
      expect(resolveLocalRuntimeViewerScope(adminSession(2, 5))).toEqual({
        role: 'ADMIN_LEVEL_2',
        organizationId: 5,
        adminLevel: 2,
      });
    });

    it('二级管理员缺少可信公司时失败关闭', () => {
      expect(() => resolveLocalRuntimeViewerScope(adminSession(2, null))).toThrow(DomainError);
    });

    it('等级缺失时失败关闭且不降级为全局', () => {
      expect(() => resolveLocalRuntimeViewerScope(adminSession(null))).toThrow(DomainError);
    });

    it('等级为非法值（3）时失败关闭', () => {
      expect(() => resolveLocalRuntimeViewerScope(adminSession(3))).toThrow(DomainError);
    });
  });

  describe('工程师', () => {
    it('取本公司范围', () => {
      expect(resolveLocalRuntimeViewerScope(engineerSession(4))).toEqual({
        role: 'ENGINEER',
        organizationId: 4,
        adminLevel: null,
      });
    });

    it('缺少可信公司时失败关闭', () => {
      expect(() => resolveLocalRuntimeViewerScope(engineerSession(null))).toThrow(DomainError);
    });
  });

  describe('其余身份与不一致事实', () => {
    it('客户被拒绝', () => {
      expect(() =>
        resolveLocalRuntimeViewerScope({
          roles: [IdentityTypeEnum.CUSTOMER],
          activeRole: IdentityTypeEnum.CUSTOMER,
          adminLevel: null,
          trustedOrganizationId: 4,
        }),
      ).toThrow(DomainError);
    });

    it('同时具备管理员与工程师角色时，按 activeRole 取最小权限（工程师仅本公司）', () => {
      expect(
        resolveLocalRuntimeViewerScope({
          roles: [IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER],
          activeRole: IdentityTypeEnum.ENGINEER,
          adminLevel: 1,
          trustedOrganizationId: 4,
        }),
      ).toEqual({ role: 'ENGINEER', organizationId: 4, adminLevel: null });
    });

    it('角色为工程师但 activeRole 为管理员时不得借用工程师公司范围', () => {
      expect(() =>
        resolveLocalRuntimeViewerScope({
          roles: [IdentityTypeEnum.ENGINEER],
          activeRole: IdentityTypeEnum.SUPER_ADMIN,
          adminLevel: 1,
          trustedOrganizationId: 4,
        }),
      ).toThrow(DomainError);
    });

    it('activeRole 缺失时拒绝', () => {
      expect(() =>
        resolveLocalRuntimeViewerScope({
          roles: [IdentityTypeEnum.SUPER_ADMIN],
          activeRole: undefined,
          adminLevel: 1,
          trustedOrganizationId: null,
        }),
      ).toThrow(DomainError);
    });
  });

  describe('动作准入', () => {
    it('仅一级管理员可写本机级设置', () => {
      expect(() =>
        assertInstallationSettingsWritable({
          role: 'ADMIN_LEVEL_1',
          organizationId: null,
          adminLevel: 1,
        }),
      ).not.toThrow();
      expect(() =>
        assertInstallationSettingsWritable({
          role: 'ADMIN_LEVEL_2',
          organizationId: 5,
          adminLevel: 2,
        }),
      ).toThrow(DomainError);
      expect(() =>
        assertInstallationSettingsWritable({
          role: 'ENGINEER',
          organizationId: 5,
          adminLevel: null,
        }),
      ).toThrow(DomainError);
    });

    it('工程师不得执行管理员专属动作', () => {
      expect(() =>
        assertLocalRuntimeAdministrator({ role: 'ENGINEER', organizationId: 5, adminLevel: null }),
      ).toThrow(DomainError);
      expect(() =>
        assertLocalRuntimeAdministrator({
          role: 'ADMIN_LEVEL_2',
          organizationId: 5,
          adminLevel: 2,
        }),
      ).not.toThrow();
    });
  });
});
