// src/core/local-runtime/policy/local-restore-audit.policy.spec.ts

/**
 * 恢复终态／处置事件的 `detail` 白名单口径（任务 09 恢复链最小修复 03）。
 *
 * 守住两条：
 * 1. 处置人的**实际操作原因**必须能写进既有 `reason` 键（任务 10 读侧已能读出）；
 * 2. 没有处置人原因时回落到受控原因码，且 detail 里**不出现**白名单外的键。
 */

import { projectManagementAuditDetail } from '@core/management-audit/policy/management-audit-detail.policy';
import { DomainError } from '@core/common/errors/domain-error';

import {
  buildLocalRestoreAuditDetail,
  LOCAL_RESTORE_AUDIT_STAGES,
  serializeLocalRestoreAuditDetail,
} from './local-restore-audit.policy';

describe('恢复审计 detail 的白名单口径', () => {
  it('处置人原因写入 reason 键（读侧原样读回）', () => {
    const detail = buildLocalRestoreAuditDetail({
      result: 'SUCCEEDED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      operatorReason: '恢复已终态，人工核对数据一致后受控解除',
    });
    expect(detail).toEqual({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      reason: '恢复已终态，人工核对数据一致后受控解除',
    });
  });

  it('处置人原因优先于受控原因码（成功处置没有受控码，冲突口径固定）', () => {
    const detail = buildLocalRestoreAuditDetail({
      result: 'SUCCEEDED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      reasonCode: 'RESTORE_INCIDENT_RELEASE_RELEASE_FAILED',
      operatorReason: '人工核对后放行',
    });
    expect(detail.reason).toBe('人工核对后放行');
  });

  it('没有处置人原因时回落到受控原因码', () => {
    const detail = buildLocalRestoreAuditDetail({
      result: 'FAILED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_DENIED,
      reasonCode: 'RESTORE_INCIDENT_RELEASE_NOT_ADMIN',
    });
    expect(detail.reason).toBe('RESTORE_INCIDENT_RELEASE_NOT_ADMIN');
  });

  it('序列化后的 detail 能被任务 10 读侧原样投影', () => {
    const raw = serializeLocalRestoreAuditDetail({
      result: 'SUCCEEDED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      operatorReason: '恢复已终态，人工核对数据一致后受控解除',
    });
    expect(projectManagementAuditDetail(raw)).toEqual({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      reason: '恢复已终态，人工核对数据一致后受控解除',
    });
  });

  it('detail 里不出现白名单外的键（包 ID、计数、路径等一律不写）', () => {
    const raw = serializeLocalRestoreAuditDetail({
      result: 'SUCCEEDED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      operatorReason: '人工核对后放行',
    });
    expect(raw).not.toContain('restore_id');
    expect(raw).not.toContain('backup_id');
    expect(raw).not.toContain('counts');
  });
});

describe('恢复审计 detail · 写入侧敏感内容闸门（任务 09 剩余问题 01）', () => {
  it('处置原因含凭据／令牌：写入被拒（抛错），不落库', () => {
    expect(() =>
      buildLocalRestoreAuditDetail({
        result: 'SUCCEEDED',
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
        operatorReason: 'token=FAKE_EXAMPLE_SECRET',
      }),
    ).toThrow(DomainError);
  });

  it('处置原因含系统绝对路径：写入被拒（抛错），不落库', () => {
    expect(() =>
      buildLocalRestoreAuditDetail({
        result: 'SUCCEEDED',
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
        operatorReason: '见 /srv/private 目录',
      }),
    ).toThrow(DomainError);
  });

  it('拒绝时的错误提示**不回显**命中内容（不得二次泄漏）', () => {
    let message = '';
    try {
      buildLocalRestoreAuditDetail({
        result: 'SUCCEEDED',
        stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
        operatorReason: 'token=FAKE_EXAMPLE_SECRET',
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toContain('FAKE_EXAMPLE_SECRET');
    expect(message).toContain('敏感内容');
  });

  it('普通处置原因照常写入（不得把正常处置挡在门外）', () => {
    const detail = buildLocalRestoreAuditDetail({
      result: 'SUCCEEDED',
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      operatorReason: '恢复已终态，人工核对数据一致后受控解除',
    });
    expect(detail.reason).toBe('恢复已终态，人工核对数据一致后受控解除');
  });
});
