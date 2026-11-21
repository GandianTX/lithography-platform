// src/core/management-audit/policy/management-audit-detail.policy.spec.ts

import { projectManagementAuditDetail } from './management-audit-detail.policy';

/**
 * 关键操作记录 detail 安全投影单测（任务 10 S1.2）。
 *
 * 口径：只有「合法 JSON 对象 + 白名单键 + 合法取值」才进入响应；
 * 历史自由文本、数组、超长原文、未知键一律不展示，避免把正文/凭据透传给页面。
 */
describe('projectManagementAuditDetail', () => {
  it('空值与空白不产生摘要', () => {
    expect(projectManagementAuditDetail(null)).toBeNull();
    expect(projectManagementAuditDetail('')).toBeNull();
    expect(projectManagementAuditDetail('   ')).toBeNull();
  });

  it('历史自由文本与非对象 JSON 一律不展示', () => {
    expect(projectManagementAuditDetail('管理员删除了资料 A')).toBeNull();
    expect(projectManagementAuditDetail('[]')).toBeNull();
    expect(projectManagementAuditDetail('[{"reason":"x"}]')).toBeNull();
    expect(projectManagementAuditDetail('"reason"')).toBeNull();
    expect(projectManagementAuditDetail('null')).toBeNull();
    expect(projectManagementAuditDetail('{broken json')).toBeNull();
  });

  it('超长原文直接视为不可展示', () => {
    const oversized = JSON.stringify({ reason: 'x'.repeat(9_000) });
    expect(projectManagementAuditDetail(oversized)).toBeNull();
  });

  it('只保留白名单键，未知键与正文类字段全部丢弃', () => {
    const raw = JSON.stringify({
      reason: '  重复上传，更正归属  ',
      contentMd: '# 正文不应出现',
      filePath: '/tmp/secret.pdf',
      password: 'p@ssw0rd',
      loginNameMasked: 'dev-a***',
    });

    const detail = projectManagementAuditDetail(raw);

    expect(detail).toEqual({ reason: '重复上传，更正归属' });
    expect(JSON.stringify(detail)).not.toContain('正文');
    expect(JSON.stringify(detail)).not.toContain('secret');
    expect(JSON.stringify(detail)).not.toContain('loginNameMasked');
  });

  it('白名单键全部合法时完整投影', () => {
    const raw = JSON.stringify({
      reason: '恢复前保护副本校验通过',
      stage: 'APPLY',
      changedFields: ['ownerOrganizationId', 'reviewStatus'],
      attemptNo: 2,
      beforeOrganizationName: '开发联调公司 A',
      afterOrganizationName: '开发联调公司 B',
    });

    expect(projectManagementAuditDetail(raw)).toEqual({
      reason: '恢复前保护副本校验通过',
      stage: 'APPLY',
      changedFields: ['ownerOrganizationId', 'reviewStatus'],
      attemptNo: 2,
      beforeOrganizationName: '开发联调公司 A',
      afterOrganizationName: '开发联调公司 B',
    });
  });

  it('原因按码点截断到 200', () => {
    const detail = projectManagementAuditDetail(JSON.stringify({ reason: '原'.repeat(260) }));
    expect(detail?.reason).toHaveLength(200);
  });

  it('stage 仅接受大写下划线标识，自由文本被丢弃', () => {
    expect(projectManagementAuditDetail(JSON.stringify({ stage: 'PRECHECK' }))).toEqual({
      stage: 'PRECHECK',
    });
    expect(projectManagementAuditDetail(JSON.stringify({ stage: '预检通过' }))).toBeNull();
    expect(projectManagementAuditDetail(JSON.stringify({ stage: 'apply stage' }))).toBeNull();
    expect(projectManagementAuditDetail(JSON.stringify({ stage: 'APPLY; DROP TABLE' }))).toBeNull();
  });

  it('changedFields 只保留合法标识符并去重', () => {
    const detail = projectManagementAuditDetail(
      JSON.stringify({
        changedFields: ['ownerOrganizationId', '', 'bad field', 'ownerOrganizationId', 42, 'name'],
      }),
    );

    expect(detail).toEqual({ changedFields: ['ownerOrganizationId', 'name'] });
  });

  it('changedFields 元素超过上限时截断，非数组被丢弃', () => {
    const many = Array.from({ length: 30 }, (_, index) => `field${index}`);
    const detail = projectManagementAuditDetail(JSON.stringify({ changedFields: many }));
    expect(detail?.changedFields).toHaveLength(20);

    expect(
      projectManagementAuditDetail(JSON.stringify({ changedFields: 'ownerOrganizationId' })),
    ).toBeNull();
  });

  it('attemptNo 只接受非负整数', () => {
    expect(projectManagementAuditDetail(JSON.stringify({ attemptNo: 0 }))).toEqual({
      attemptNo: 0,
    });
    expect(projectManagementAuditDetail(JSON.stringify({ attemptNo: -1 }))).toBeNull();
    expect(projectManagementAuditDetail(JSON.stringify({ attemptNo: 1.5 }))).toBeNull();
    expect(projectManagementAuditDetail(JSON.stringify({ attemptNo: '2' }))).toBeNull();
    expect(projectManagementAuditDetail(JSON.stringify({ attemptNo: 2_000_000 }))).toBeNull();
  });

  it('公司名按 120 码点截断', () => {
    const detail = projectManagementAuditDetail(
      JSON.stringify({ afterOrganizationName: '司'.repeat(200) }),
    );
    expect(detail?.afterOrganizationName).toHaveLength(120);
  });

  it('没有任何合法字段时返回 null', () => {
    expect(projectManagementAuditDetail(JSON.stringify({ unknownKey: 'value' }))).toBeNull();
    expect(projectManagementAuditDetail(JSON.stringify({ reason: '   ' }))).toBeNull();
  });
});
