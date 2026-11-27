// src/core/local-runtime/policy/local-restore-incident-release.policy.spec.ts

/**
 * 恢复故障现场受控解冻的裁决口径（任务 09 独立验收 P2-2）。
 *
 * 断言写"**期望行为**"：任何无法确认的前提都必须**拒绝**（失败关闭），
 * 不得出现"先解冻再补证据"的降级放行。
 */

import {
  decideIncidentReleaseReasonVerdict,
  decideRestoreIncidentReleaseVerdict,
  LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES,
  LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH,
  type RestoreIncidentReleaseFacts,
} from './local-restore-incident-release.policy';

const BASE_FACTS: RestoreIncidentReleaseFacts = {
  actorIsAdministrator: true,
  allowedOrganizationId: null,
  restoreExists: true,
  installationMatches: true,
  restoreOrganizationId: 1,
  restoreStatus: 'SUCCEEDED',
  dataConsistencyConfirmed: true,
  protectionCopyConfirmed: true,
  ownedHoldCount: 1,
  otherHoldCount: 0,
  reasonProvided: true,
  confirmed: true,
};

const facts = (overrides: Partial<RestoreIncidentReleaseFacts>): RestoreIncidentReleaseFacts => ({
  ...BASE_FACTS,
  ...overrides,
});

describe('恢复故障现场受控解冻 · 裁决', () => {
  it('全部前提成立时允许解冻', () => {
    expect(decideRestoreIncidentReleaseVerdict(BASE_FACTS)).toEqual({ allowed: true });
  });

  it('非管理员一律拒绝（工程师／客户）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ actorIsAdministrator: false }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NOT_ADMIN,
    );
  });

  it('未填处置原因拒绝', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ reasonProvided: false }));
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.REASON_REQUIRED,
    );
  });

  it('未显式确认拒绝', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ confirmed: false }));
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.CONFIRMATION_REQUIRED,
    );
  });

  it('恢复运行不存在拒绝', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ restoreExists: false }));
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.RESTORE_NOT_FOUND,
    );
  });

  it('目标安装不是本机拒绝（异机处置不得放行）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ installationMatches: false }));
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.TARGET_MISMATCH,
    );
  });

  it('二级管理员处置他公司现场拒绝（跨公司不得放行）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(
      facts({ allowedOrganizationId: 2, restoreOrganizationId: 1 }),
    );
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.ORGANIZATION_NOT_ALLOWED,
    );
  });

  it('二级管理员处置本公司现场允许', () => {
    expect(
      decideRestoreIncidentReleaseVerdict(
        facts({ allowedOrganizationId: 1, restoreOrganizationId: 1 }),
      ),
    ).toEqual({ allowed: true });
  });

  it('一级管理员（全局范围）可处置任意公司现场', () => {
    expect(
      decideRestoreIncidentReleaseVerdict(
        facts({ allowedOrganizationId: null, restoreOrganizationId: 7 }),
      ),
    ).toEqual({ allowed: true });
  });

  it('恢复仍在运行（PENDING／RUNNING）拒绝：应当走安全重试', () => {
    for (const status of ['PENDING', 'RUNNING'] as const) {
      const verdict = decideRestoreIncidentReleaseVerdict(facts({ restoreStatus: status }));
      expect(verdict.allowed === false && verdict.reasonCode).toBe(
        LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.RESTORE_RUNNING,
      );
    }
  });

  it('没有活动冻结时拒绝（幂等：如实回报"无需解除"，不谎报已解冻）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(
      facts({ ownedHoldCount: 0, otherHoldCount: 0 }),
    );
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.NO_ACTIVE_HOLD,
    );
  });

  it('活动冻结归属于别的恢复时拒绝（不得一刀切解掉别人的冻结）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(
      facts({ ownedHoldCount: 0, otherHoldCount: 1 }),
    );
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.HOLD_OWNER_MISMATCH,
    );
  });

  it('保护副本无法确认拒绝', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ protectionCopyConfirmed: false }));
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.PROTECTION_COPY_UNCONFIRMED,
    );
  });

  it('数据一致性无法确认拒绝（回滚失败／中断 ⇒ 先人工修复数据）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ dataConsistencyConfirmed: false }));
    expect(verdict.allowed === false && verdict.reasonCode).toBe(
      LOCAL_RESTORE_INCIDENT_RELEASE_REASON_CODES.DATA_CONSISTENCY_UNCONFIRMED,
    );
  });

  it('中断（INTERRUPTED）即使其它前提齐备也不放行：数据一致性无法确认', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(
      facts({ restoreStatus: 'INTERRUPTED', dataConsistencyConfirmed: false }),
    );
    expect(verdict.allowed).toBe(false);
  });

  it('失败且已按保护副本回滚（数据一致性可确认）允许解冻', () => {
    expect(
      decideRestoreIncidentReleaseVerdict(
        facts({
          restoreStatus: 'FAILED',
          dataConsistencyConfirmed: true,
          protectionCopyConfirmed: true,
        }),
      ),
    ).toEqual({ allowed: true });
  });

  it('拒绝信息只含受控码与受控说明（不含自由文本、路径与正文）', () => {
    const verdict = decideRestoreIncidentReleaseVerdict(facts({ actorIsAdministrator: false }));
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) {
      expect(verdict.reasonCode).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/u);
      expect(verdict.message).not.toMatch(/\//u);
      expect(verdict.message).not.toMatch(/[一-龥]{20,}/u);
    }
  });
});

describe('处置原因的最小校验（任务 09 恢复链最小修复 03）', () => {
  it('去首尾空白后接受，并把规范化后的原因交回', () => {
    const verdict = decideIncidentReleaseReasonVerdict('  恢复已终态，人工核对后放行  ');
    expect(verdict).toEqual({ ok: true, reason: '恢复已终态，人工核对后放行' });
  });

  it('空（只有空白）⇒ 明确判为未填写', () => {
    expect(decideIncidentReleaseReasonVerdict('   ')).toEqual({ ok: false, kind: 'EMPTY' });
  });

  it('超长（超过上限）⇒ 明确拒绝，不静默截断', () => {
    const long = 'x'.repeat(LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH + 1);
    expect(decideIncidentReleaseReasonVerdict(long)).toEqual({ ok: false, kind: 'TOO_LONG' });
  });

  it('恰好等于上限 ⇒ 通过（写进去的必须读得出来）', () => {
    const exact = 'x'.repeat(LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH);
    expect(decideIncidentReleaseReasonVerdict(exact)).toEqual({ ok: true, reason: exact });
  });

  it('含控制字符 ⇒ 明确拒绝（读侧只截断、不清洗）', () => {
    const control = ['正常原因', String.fromCharCode(7), '换行'].join('');
    expect(decideIncidentReleaseReasonVerdict(control)).toEqual({
      ok: false,
      kind: 'CONTROL_CHARACTER',
    });
  });

  it('上限按码点计（多字节字符不会被误判超长）', () => {
    const cjk = '原'.repeat(LOCAL_RESTORE_INCIDENT_RELEASE_REASON_MAX_LENGTH);
    expect(decideIncidentReleaseReasonVerdict(cjk)).toEqual({ ok: true, reason: cjk });
  });
});

describe('处置原因 · 敏感内容边界（任务 09 剩余问题 01）', () => {
  it('普通中文运维原因照常可用（不得把正常处置挡在门外）', () => {
    expect(decideIncidentReleaseReasonVerdict('恢复已终态，人工核对数据一致后受控解除')).toEqual({
      ok: true,
      reason: '恢复已终态，人工核对数据一致后受控解除',
    });
    expect(decideIncidentReleaseReasonVerdict('临时排障：token 已失效，请重新获取')).toEqual({
      ok: true,
      reason: '临时排障：token 已失效，请重新获取',
    });
  });

  it('示例凭据赋值／令牌：明确拒绝，且结论里**不含**命中的原文', () => {
    const verdict = decideIncidentReleaseReasonVerdict('token=FAKE_EXAMPLE_SECRET /srv/private');
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false && verdict.kind === 'SENSITIVE_CONTENT') {
      expect(verdict.sensitiveKind).toBe('CREDENTIAL_LIKE');
    } else {
      throw new Error('预期命中敏感内容');
    }
    expect(JSON.stringify(verdict)).not.toContain('FAKE_EXAMPLE_SECRET');
    expect(JSON.stringify(verdict)).not.toContain('/srv/private');
  });

  it('示例 password 赋值：明确拒绝', () => {
    expect(decideIncidentReleaseReasonVerdict('password=Hunter2')).toEqual({
      ok: false,
      kind: 'SENSITIVE_CONTENT',
      sensitiveKind: 'CREDENTIAL_LIKE',
    });
  });

  it('Unix 系统绝对路径：明确拒绝', () => {
    expect(decideIncidentReleaseReasonVerdict('见 /srv/private 目录')).toEqual({
      ok: false,
      kind: 'SENSITIVE_CONTENT',
      sensitiveKind: 'ABSOLUTE_PATH',
    });
  });

  it('Windows 系统绝对路径：明确拒绝', () => {
    expect(decideIncidentReleaseReasonVerdict('C:\\Windows\\System32')).toEqual({
      ok: false,
      kind: 'SENSITIVE_CONTENT',
      sensitiveKind: 'ABSOLUTE_PATH',
    });
  });

  it('拒绝结论只带类别，不回显敏感内容（错误提示不得二次泄漏）', () => {
    const verdict = decideIncidentReleaseReasonVerdict('token=FAKE_EXAMPLE_SECRET');
    expect(Object.keys(verdict).sort()).toEqual(['kind', 'ok', 'sensitiveKind']);
  });
});
