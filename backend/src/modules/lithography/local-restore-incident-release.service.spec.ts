// src/modules/lithography/local-restore-incident-release.service.spec.ts

/**
 * 恢复故障现场受控解冻的定向测试（任务 09 独立验收 P2-2）。
 *
 * 守住五条：
 * 1. **失败关闭**：无权／未确认／未填原因／运行中／目标不匹配／跨公司／
 *    冻结归属别的恢复／数据一致性不可确认 ⇒ 一律拒绝且**不解冻**；
 * 2. **解冻 ≠ 恢复成功**：解冻不改判恢复终态，审计事件的 `result` 镜像恢复自身终态；
 * 3. **如实回报**："已解除／无需解除／被拒绝"三者不得混淆（不得把"没做"说成"做了"）；
 * 4. **留痕**：成功、拒绝、失败三条路径都写审计事件（阶段承载处置事实）；
 * 5. **原子性（任务 09 恢复链最小修复 02／03）**：解冻与成功处置审计**同一事务**——
 *    审计写入失败 ⇒ 整体回滚（冻结仍 ACTIVE、无成功事件）；成功事件的审计里
 *    带得上**操作者真正填写的处置原因**。
 */

import { LOCAL_RESTORE_AUDIT_STAGES } from '@core/local-runtime/policy/local-restore-audit.policy';
import { DomainError } from '@core/common/errors/domain-error';

import { asPinoLogger, createTestPinoLogger } from '../../../test/utils/test-pino-logger';

import { BackupAssetEntity } from './entities/backup-asset.entity';
import { BackupRestoreRunEntity } from './entities/backup-restore-run.entity';
import { LocalInstallationEntity } from './entities/local-installation.entity';
import { LocalRestoreIncidentReleaseService } from './local-restore-incident-release.service';

const INSTALLATION_ID = 'inst-1';
const ORGANIZATION_ID = 4;

type RunRow = {
  restoreId: string;
  backupId: string;
  protectionBackupId: string | null;
  targetInstallationId: string | null;
  organizationId: number;
  status: string;
  resultSummary: string | null;
};

type HoldRow = {
  holdId: string;
  restoreId: string | null;
  status: string;
  holdType: string;
};

function buildRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    restoreId: 'restore-1',
    backupId: 'backup-1',
    protectionBackupId: 'protection-1',
    targetInstallationId: INSTALLATION_ID,
    organizationId: ORGANIZATION_ID,
    status: 'SUCCEEDED',
    resultSummary: JSON.stringify({ status: 'SUCCEEDED' }),
    ...overrides,
  };
}

type ServiceOptions = {
  run?: RunRow | null;
  holds?: HoldRow[];
  /** 解冻动作返回的影响行数（0＝并发下已被别的处置解掉） */
  forceReleaseResult?: number;
  /** 解冻动作抛错（模拟释放失败） */
  forceReleaseError?: boolean;
  /** 成功处置审计写入抛错（模拟审计失败 ⇒ 事务必须整体回滚） */
  auditWriteError?: boolean;
};

function buildService(options: ServiceOptions = {}) {
  const run = options.run === undefined ? buildRun() : options.run;
  const installation = { id: 1, installationId: INSTALLATION_ID };
  const assets = [{ backupId: 'protection-1', localStatus: 'PENDING' }];
  // 内存"库"：事务失败时回滚（与真实事务同语义）
  const db = {
    run,
    installation,
    assets,
    holds: (
      options.holds ?? [
        { holdId: 'hold-1', restoreId: 'restore-1', status: 'ACTIVE', holdType: 'RESTORE' },
      ]
    ).map((row) => ({ ...row })),
  };

  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === BackupRestoreRunEntity) {
        return { findOne: () => Promise.resolve(db.run) };
      }
      if (entity === LocalInstallationEntity) {
        return { findOne: () => Promise.resolve(db.installation) };
      }
      if (entity === BackupAssetEntity) {
        return {
          findOne: (query: { where: { backupId: string } }) =>
            Promise.resolve(
              db.assets.find((asset) => asset.backupId === query.where.backupId) ?? null,
            ),
        };
      }
      return {
        find: () =>
          Promise.resolve(
            db.holds.filter((row) => row.status === 'ACTIVE' && row.holdType === 'RESTORE'),
          ),
        update: () => Promise.resolve({ affected: 0 }),
      };
    },
    /** 事务：异常时回滚内存状态（真实事务语义） */
    transaction: async (callback: (entityManager: unknown) => Promise<unknown>) => {
      const snapshot = {
        holds: db.holds.map((row) => ({ ...row })),
      };
      try {
        return await callback(manager);
      } catch (error: unknown) {
        db.holds = snapshot.holds;
        throw error;
      }
    },
  };

  const restoreRunRepository = { findOne: jest.fn(() => Promise.resolve(run)), manager };
  const holdRepository = {
    find: jest.fn(() => Promise.resolve(db.holds)),
    count: jest.fn((query: { where: { status: string; restoreId?: string } }) =>
      Promise.resolve(
        db.holds.filter(
          (row) =>
            row.status === query.where.status &&
            (query.where.restoreId === undefined || row.restoreId === query.where.restoreId),
        ).length,
      ),
    ),
  };
  const backupAssetRepository = {
    findOne: jest.fn(() => Promise.resolve(assets[0] ?? null)),
  };
  const installationRepository = {
    findOne: jest.fn(() => Promise.resolve(installation)),
  };

  // 解冻动作（事务内）：归属不符 ⇒ 受控拒绝；否则把冻结标记为 RELEASED
  const releaseForRecoveryIncidentInTransaction = jest.fn(
    (input: {
      incidentRestoreId: string;
      installationId: string;
      organizationId: number;
      holdType: string;
    }) => {
      if (options.forceReleaseError === true) {
        throw new Error('注入的解冻失败');
      }
      const affected = options.forceReleaseResult ?? 1;
      if (affected > 0) {
        for (const row of db.holds) {
          if (row.status === 'ACTIVE' && row.restoreId === input.incidentRestoreId) {
            row.status = 'RELEASED';
          }
        }
      }
      return affected;
    },
  );
  const withRecoveryScopeLock = jest.fn(
    async <T>(_input: unknown, callback: () => Promise<T>): Promise<T> => await callback(),
  );
  const acquireExclusiveScopeLock = jest.fn(() => Promise.resolve());

  // **已写入**的事件（失败的写入不算）：用于断言"事务回滚 ⇒ 没有成功事件"
  const writtenEvents: Array<{ stage: string; restoreId: string }> = [];
  const appendRestoreIncidentEvent = jest.fn(
    (input: { stage: string; result: string; restoreId: string; reasonCode?: string | null }) => {
      if (options.auditWriteError === true && input.stage === 'RESTORE_HOLD_FORCE_RELEASED') {
        throw new Error('注入的审计写入失败');
      }
      writtenEvents.push({ stage: input.stage, restoreId: input.restoreId });
      return undefined;
    },
  );
  const countRestoreIncidentEventsByStage = jest.fn((input: { restoreId: string; stage: string }) =>
    Promise.resolve(
      writtenEvents.filter(
        (event) => event.restoreId === input.restoreId && event.stage === input.stage,
      ).length,
    ),
  );

  const localWriteHoldService = {
    withRecoveryScopeLock,
    releaseForRecoveryIncidentInTransaction,
  };
  const scopeLockService = { acquireExclusiveScopeLock };
  const managementAuditService = {
    appendRestoreIncidentEvent,
    countRestoreIncidentEventsByStage,
  };
  const logger = asPinoLogger(createTestPinoLogger());
  const service = new LocalRestoreIncidentReleaseService(
    restoreRunRepository as never,
    holdRepository as never,
    backupAssetRepository as never,
    installationRepository as never,
    localWriteHoldService as never,
    scopeLockService as never,
    managementAuditService as never,
    logger,
  );
  return {
    service,
    db,
    writtenEvents,
    withRecoveryScopeLock,
    releaseForRecoveryIncidentInTransaction,
    acquireExclusiveScopeLock,
    appendRestoreIncidentEvent,
  };
}

const BASE_COMMAND = {
  restoreId: 'restore-1',
  actorAccountId: 900,
  actorAdminLevel: 1,
  allowedOrganizationId: null,
  actorIsAdministrator: true,
  reason: '恢复已终态但冻结未解除，经核对数据一致，管理员受控解除',
  confirmed: true,
};

describe('恢复故障现场受控解冻 · 服务', () => {
  it('前提齐备：解除冻结，并如实回报"已解除"', async () => {
    const { service, releaseForRecoveryIncidentInTransaction, appendRestoreIncidentEvent } =
      buildService();
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('RELEASED');
    expect(outcome.released).toBe(true);
    expect(outcome.holdRetained).toBe(false);
    expect(outcome.reasonCode).toBeNull();
    // 解冻**不改判**恢复终态
    expect(outcome.restoreStatus).toBe('SUCCEEDED');
    expect(releaseForRecoveryIncidentInTransaction).toHaveBeenCalledTimes(1);
    expect(releaseForRecoveryIncidentInTransaction.mock.calls[0][0]).toMatchObject({
      incidentRestoreId: 'restore-1',
      organizationId: ORGANIZATION_ID,
      holdType: 'RESTORE',
    });
    // 审计：阶段承载处置事实，result 镜像恢复自身终态
    expect(appendRestoreIncidentEvent).toHaveBeenCalledTimes(1);
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
      result: 'SUCCEEDED',
      restoreId: 'restore-1',
    });
  });

  it('最小修复 03：成功事件的审计带上**操作者真正填写的处置原因**', async () => {
    const { service, appendRestoreIncidentEvent } = buildService();
    await service.release(BASE_COMMAND);
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({
      operatorReason: BASE_COMMAND.reason,
    });
  });

  it('最小修复 02：解冻与成功审计**同一事务**（审计带事务上下文）', async () => {
    const { service, appendRestoreIncidentEvent, acquireExclusiveScopeLock } = buildService();
    await service.release(BASE_COMMAND);
    // 锁内复核事实：排他范围锁必须在解冻之前取得
    expect(acquireExclusiveScopeLock).toHaveBeenCalledTimes(1);
    const eventParams = appendRestoreIncidentEvent.mock.calls[0][0] as {
      transactionContext?: unknown;
    };
    expect(eventParams.transactionContext).toBeDefined();
  });

  it('最小修复 02：审计写入失败 ⇒ 整体回滚（冻结仍 ACTIVE、无成功事件）', async () => {
    const { service, db, writtenEvents } = buildService({
      auditWriteError: true,
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.released).toBe(false);
    expect(outcome.holdRetained).toBe(true);
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_AUDIT_FAILED');
    // 事务回滚 ⇒ 冻结仍在（设备继续停写停传）
    expect(db.holds.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    const releasedEvents = writtenEvents.filter(
      (event) => event.stage === LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_RELEASED,
    );
    expect(releasedEvents).toHaveLength(0);
  });

  it('无权（工程师）：拒绝且**不解冻**', async () => {
    const { service, releaseForRecoveryIncidentInTransaction, appendRestoreIncidentEvent } =
      buildService();
    const outcome = await service.release({ ...BASE_COMMAND, actorIsAdministrator: false });
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.released).toBe(false);
    expect(outcome.holdRetained).toBe(true);
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_NOT_ADMIN');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
    expect(appendRestoreIncidentEvent).toHaveBeenCalledTimes(1);
  });

  it('未显式确认：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService();
    const outcome = await service.release({ ...BASE_COMMAND, confirmed: false });
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_CONFIRMATION_REQUIRED');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('未填处置原因：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService();
    const outcome = await service.release({ ...BASE_COMMAND, reason: '   ' });
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_REASON_REQUIRED');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('最小修复 03：处置原因超长 ⇒ 明确拒绝（不静默丢弃用户填写的内容）', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService();
    await expect(
      service.release({ ...BASE_COMMAND, reason: 'x'.repeat(201) }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('最小修复 03：处置原因含控制字符 ⇒ 明确拒绝', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService();
    await expect(
      service.release({
        ...BASE_COMMAND,
        // 用码点构造控制字符（BEL）：不依赖源码里的转义写法
        reason: ['正常原因', String.fromCharCode(7), '换行'].join(''),
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('剩余问题 01：处置原因含凭据／令牌 ⇒ 明确拒绝（冻结保持原状态，提示不回显原文）', async () => {
    const { service, releaseForRecoveryIncidentInTransaction, db } = buildService();
    let message = '';
    await expect(
      service.release({ ...BASE_COMMAND, reason: 'token=FAKE_EXAMPLE_SECRET' }),
    ).rejects.toBeInstanceOf(DomainError);
    try {
      await service.release({ ...BASE_COMMAND, reason: 'token=FAKE_EXAMPLE_SECRET' });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toContain('FAKE_EXAMPLE_SECRET');
    // 拒绝发生在任何解冻动作之前 ⇒ 冻结仍在（设备继续停写停传）
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
    expect(db.holds.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
  });

  it('剩余问题 01：处置原因含系统绝对路径 ⇒ 明确拒绝（提示不回显原文）', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService();
    let message = '';
    try {
      await service.release({ ...BASE_COMMAND, reason: '见 /srv/private 目录' });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toContain('/srv/private');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('伪造 restoreId（运行不存在）：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService({ run: null });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_RESTORE_NOT_FOUND');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('目标安装不是本机：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService({
      run: buildRun({ targetInstallationId: 'other-inst' }),
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_TARGET_MISMATCH');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('跨公司（二级管理员处置他公司）：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService();
    const outcome = await service.release({ ...BASE_COMMAND, allowedOrganizationId: 9 });
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_ORGANIZATION_NOT_ALLOWED');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('恢复仍在运行：拒绝且不解冻（应当走安全重试）', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService({
      run: buildRun({ status: 'RUNNING', resultSummary: JSON.stringify({ status: 'RUNNING' }) }),
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_RESTORE_RUNNING');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('活动冻结归属别的恢复：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService({
      holds: [
        { holdId: 'hold-x', restoreId: 'restore-other', status: 'ACTIVE', holdType: 'RESTORE' },
      ],
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_HOLD_OWNER_MISMATCH');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('回滚失败（数据一致性不可确认）：拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService({
      run: buildRun({
        status: 'FAILED',
        resultSummary: JSON.stringify({ status: 'FAILED', holdRetained: true }),
      }),
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_DATA_CONSISTENCY_UNCONFIRMED');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('中断（INTERRUPTED）：数据一致性不可确认 ⇒ 拒绝且不解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction } = buildService({
      run: buildRun({ status: 'INTERRUPTED', resultSummary: null }),
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_DATA_CONSISTENCY_UNCONFIRMED');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
  });

  it('失败但已按保护副本回滚（数据一致）：允许解冻，终态仍如实回报 FAILED', async () => {
    const { service, appendRestoreIncidentEvent } = buildService({
      run: buildRun({
        status: 'FAILED',
        resultSummary: JSON.stringify({ status: 'FAILED', rolledBack: true }),
      }),
    });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('RELEASED');
    expect(outcome.released).toBe(true);
    // 解冻不改判恢复终态
    expect(outcome.restoreStatus).toBe('FAILED');
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({ result: 'FAILED' });
  });

  it('已无活动冻结：如实回报"无需解除"，**不得**谎报已解冻', async () => {
    const { service, releaseForRecoveryIncidentInTransaction, appendRestoreIncidentEvent } =
      buildService({
        holds: [],
      });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('NOT_REQUIRED');
    expect(outcome.released).toBe(false);
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_NO_ACTIVE_HOLD');
    expect(releaseForRecoveryIncidentInTransaction).not.toHaveBeenCalled();
    expect(appendRestoreIncidentEvent).toHaveBeenCalledTimes(1);
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_NOT_REQUIRED,
    });
  });

  it('并发下已被别的处置解掉（影响行数为 0）：如实回报"无需解除"', async () => {
    const { service, appendRestoreIncidentEvent } = buildService({ forceReleaseResult: 0 });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('NOT_REQUIRED');
    expect(outcome.released).toBe(false);
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_NO_ACTIVE_HOLD');
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_NOT_REQUIRED,
    });
  });

  it('解冻动作失败：如实回报失败，冻结保留，并留痕', async () => {
    const { service, db, appendRestoreIncidentEvent } = buildService({ forceReleaseError: true });
    const outcome = await service.release(BASE_COMMAND);
    expect(outcome.outcome).toBe('DENIED');
    expect(outcome.released).toBe(false);
    expect(outcome.holdRetained).toBe(true);
    expect(outcome.reasonCode).toBe('RESTORE_INCIDENT_RELEASE_RELEASE_FAILED');
    // 事务回滚 ⇒ 冻结保留
    expect(db.holds.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_FAILED,
    });
  });

  it('拒绝路径的审计阶段为"被拒绝"，且不与恢复终态混为同一事实', async () => {
    const { service, appendRestoreIncidentEvent } = buildService();
    await service.release({ ...BASE_COMMAND, confirmed: false });
    expect(appendRestoreIncidentEvent.mock.calls[0][0]).toMatchObject({
      stage: LOCAL_RESTORE_AUDIT_STAGES.INCIDENT_RELEASE_DENIED,
      result: 'SUCCEEDED',
      reasonCode: 'RESTORE_INCIDENT_RELEASE_CONFIRMATION_REQUIRED',
    });
  });
});
