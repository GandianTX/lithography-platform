// scripts/mock-v13/packs-p1.ts

/**
 * P1 数据包：AI 历史、本地同步、记录包、备份恢复样例。
 * 未接入真实执行器的能力只造“可解释的非成功样例”，不伪造成功回执。
 */

import * as path from 'node:path';

import { findOne, insertRow } from './db';
import {
  canonicalJson,
  corruptMockPackage,
  buildMockPackage,
  sha256Hex,
  verifyMockPackageContent,
} from './files';
import {
  AI_QUESTION_UUIDS,
  FIXED_BUSINESS_AT,
  FIXED_REPORT_AT,
  MOCK_LABEL,
  MOCK_PREFIX,
  ORGANIZATIONS,
  mockUuid,
} from './manifest';
import { requireReportIds } from './packs-p0';
import {
  PackContext,
  assertAccountsEligible,
  readNumber,
  requireAccountId,
  requireOrganizationId,
  resolveInstallationIdentity,
} from './packs-shared';
import { MockConflictError } from './errors';

async function ensureConversation(
  context: PackContext,
  input: {
    key: string;
    requestId: number | null;
    organizationId: number;
    engineerId: number;
    feedback: string;
    createdAt: Date;
  },
): Promise<number> {
  const existing = await findOne(context.qr, 'ai_conversation', {
    engineer_account_id: input.engineerId,
    created_at: input.createdAt,
  });
  if (existing) {
    if (
      Number(existing.owner_organization_id) !== input.organizationId ||
      (input.requestId === null
        ? existing.request_id !== null
        : Number(existing.request_id) !== input.requestId)
    ) {
      throw new MockConflictError(`AI 会话 ${input.key} 已存在但归属不同，拒绝改写`);
    }
    context.report.reused();
    return readNumber(existing, 'id');
  }
  const id = await insertRow(context.qr, 'ai_conversation', {
    request_id: input.requestId,
    owner_organization_id: input.organizationId,
    content_version: 1,
    engineer_account_id: input.engineerId,
    status: 'COMPLETED',
    ai_feedback: input.feedback,
    created_at: input.createdAt,
    completed_at: new Date(input.createdAt.getTime() + 30 * 60 * 1000),
  });
  context.report.inserted();
  context.report.scenario({
    kind: 'file',
    key: `ai-conversation:${input.key}`,
    id,
    detail: input.requestId === null ? '独立会话' : `关联工单 #${input.requestId}`,
  });
  return id;
}

async function ensureMessage(
  context: PackContext,
  input: {
    conversationId: number;
    seq: number;
    turnNo: number | null;
    role: 'SYSTEM' | 'USER' | 'ASSISTANT' | 'TOOL';
    content: string;
    questionUuid?: string;
    createdAt: Date;
  },
): Promise<number> {
  const existing = await findOne(context.qr, 'ai_message', {
    conversation_id: input.conversationId,
    message_seq: input.seq,
  });
  if (existing) {
    context.report.reused();
    return readNumber(existing, 'id');
  }
  const id = await insertRow(context.qr, 'ai_message', {
    question_uuid: input.questionUuid ?? null,
    content_version: 1,
    conversation_id: input.conversationId,
    message_seq: input.seq,
    turn_no: input.turnNo,
    role: input.role,
    content_text: input.content,
    created_at: input.createdAt,
  });
  context.report.inserted();
  return id;
}

async function ensureAnalysis(
  context: PackContext,
  input: {
    questionUuid: string;
    conversationId: number;
    questionMessageId: number;
    answerMessageId: number | null;
    status: 'SUCCEEDED' | 'FAILED';
    failureReason: string | null;
    savedAt: Date;
    completedAt: Date | null;
  },
): Promise<void> {
  const existing = await findOne(context.qr, 'ai_message_analysis', {
    question_uuid: input.questionUuid,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'ai_message_analysis', {
    question_uuid: input.questionUuid,
    conversation_id: input.conversationId,
    question_message_id: input.questionMessageId,
    answer_message_id: input.answerMessageId,
    status: input.status,
    failure_reason: input.failureReason,
    content_version: 1,
    saved_at: input.savedAt,
    completed_at: input.completedAt,
  });
  context.report.inserted();
}

export async function runAiPack(context: PackContext): Promise<void> {
  await assertAccountsEligible(context, ['engineer-a', 'engineer-b'], 'p1-ai');
  const orgA = await requireOrganizationId(context, 'A');
  const orgB = await requireOrganizationId(context, 'B');
  const engineerA = await requireAccountId(context, 'engineer-a');
  const engineerB = await requireAccountId(context, 'engineer-b');
  const requestA = await findOne(context.qr, 'repair_request', {
    request_no: `${MOCK_PREFIX}-REQ-A-002`,
  });
  const requestB = await findOne(context.qr, 'repair_request', {
    request_no: `${MOCK_PREFIX}-REQ-B-001`,
  });
  if (!requestA || !requestB) {
    throw new MockConflictError('缺少关联工单，请先运行 p0-repair');
  }

  const createdAt = new Date('2026-11-06T02:10:00.000Z');
  const conversationA = await ensureConversation(context, {
    key: 'a-progress',
    requestId: readNumber(requestA, 'id'),
    organizationId: orgA,
    engineerId: engineerA,
    feedback: `${MOCK_LABEL} 问答可复现，第二个问题分析失败用于对照。`,
    createdAt,
  });
  await ensureMessage(context, {
    conversationId: conversationA,
    seq: 1,
    turnNo: null,
    role: 'SYSTEM',
    content: `${MOCK_LABEL} 历史会话系统提示（合成样例）`,
    createdAt,
  });
  const questionA1 = await ensureMessage(context, {
    conversationId: conversationA,
    seq: 2,
    turnNo: 1,
    role: 'USER',
    content: '扫描台复位失败，报警 E-2041，应该先检查什么？',
    questionUuid: AI_QUESTION_UUIDS.conversationAFirst,
    createdAt: new Date(createdAt.getTime() + 60 * 1000),
  });
  const answerA1 = await ensureMessage(context, {
    conversationId: conversationA,
    seq: 3,
    turnNo: 1,
    role: 'ASSISTANT',
    content: '建议先断电检查驱动板接插件，再读取复位日志确认报警是否可复现。',
    createdAt: new Date(createdAt.getTime() + 90 * 1000),
  });
  const questionA2 = await ensureMessage(context, {
    conversationId: conversationA,
    seq: 4,
    turnNo: 2,
    role: 'USER',
    content: '备件未到时如何向客户说明工单状态？',
    questionUuid: AI_QUESTION_UUIDS.conversationASecond,
    createdAt: new Date(createdAt.getTime() + 120 * 1000),
  });
  await ensureMessage(context, {
    conversationId: conversationA,
    seq: 5,
    turnNo: 2,
    role: 'ASSISTANT',
    content: '说明当前排查结论、备件状态与预计恢复条件，保留工单为处理中。',
    createdAt: new Date(createdAt.getTime() + 150 * 1000),
  });
  await ensureAnalysis(context, {
    questionUuid: AI_QUESTION_UUIDS.conversationAFirst,
    conversationId: conversationA,
    questionMessageId: questionA1,
    answerMessageId: answerA1,
    status: 'SUCCEEDED',
    failureReason: null,
    savedAt: new Date(createdAt.getTime() + 95 * 1000),
    completedAt: new Date(createdAt.getTime() + 95 * 1000),
  });
  await ensureAnalysis(context, {
    questionUuid: AI_QUESTION_UUIDS.conversationASecond,
    conversationId: conversationA,
    questionMessageId: questionA2,
    answerMessageId: null,
    status: 'FAILED',
    failureReason: '模拟分析失败：模型超时，未产出结论。',
    savedAt: new Date(createdAt.getTime() + 125 * 1000),
    completedAt: new Date(createdAt.getTime() + 125 * 1000),
  });

  const independentCreatedAt = new Date('2026-11-06T05:20:00.000Z');
  const conversationB = await ensureConversation(context, {
    key: 'b-independent',
    requestId: null,
    organizationId: orgB,
    engineerId: engineerB,
    feedback: `${MOCK_LABEL} 独立会话，用于问答样例。`,
    createdAt: independentCreatedAt,
  });
  const questionB = await ensureMessage(context, {
    conversationId: conversationB,
    seq: 1,
    turnNo: 1,
    role: 'USER',
    content: '掩模台通信偶发中断，如何判断是线缆还是板卡问题？',
    questionUuid: AI_QUESTION_UUIDS.conversationBFirst,
    createdAt: new Date(independentCreatedAt.getTime() + 60 * 1000),
  });
  const answerB = await ensureMessage(context, {
    conversationId: conversationB,
    seq: 2,
    turnNo: 1,
    role: 'ASSISTANT',
    content: '先观察中断是否随振动出现，再替换线缆复测；若仍复现再排查板卡。',
    createdAt: new Date(independentCreatedAt.getTime() + 90 * 1000),
  });
  await ensureAnalysis(context, {
    questionUuid: AI_QUESTION_UUIDS.conversationBFirst,
    conversationId: conversationB,
    questionMessageId: questionB,
    answerMessageId: answerB,
    status: 'SUCCEEDED',
    failureReason: null,
    savedAt: new Date(independentCreatedAt.getTime() + 95 * 1000),
    completedAt: new Date(independentCreatedAt.getTime() + 95 * 1000),
  });

  const reportExisting = await findOne(context.qr, 'ai_report', {
    conversation_id: conversationA,
    report_type: 'FAULT_DIAGNOSIS',
  });
  if (!reportExisting) {
    await insertRow(context.qr, 'ai_report', {
      request_id: readNumber(requestA, 'id'),
      conversation_id: conversationA,
      engineer_account_id: engineerA,
      report_title: `${MOCK_LABEL} 扫描台复位失败诊断`,
      report_type: 'FAULT_DIAGNOSIS',
      content_md: `${MOCK_LABEL} 合成历史报告：检查驱动板接插件与复位日志。`,
      created_at: FIXED_REPORT_AT,
    });
    context.report.inserted();
  } else {
    context.report.reused();
  }
}

export async function runLocalPack(context: PackContext): Promise<void> {
  await assertAccountsEligible(context, ['engineer-a', 'engineer-b'], 'p1-local');
  const orgA = await requireOrganizationId(context, 'A');
  const orgB = await requireOrganizationId(context, 'B');
  const engineerA = await requireAccountId(context, 'engineer-a');
  const engineerB = await requireAccountId(context, 'engineer-b');
  const reports = await requireReportIds(context);

  const installation = await resolveInstallationIdentity(context);
  context.report.reused();

  await ensureCompanySetting(context, installation.installationId, {
    organizationId: orgA,
    isCurrent: 1,
    backupEnabled: 1,
    nextBackupAt: new Date('2026-11-09T02:00:00.000Z'),
    autoUploadEnabled: 0,
  });
  await ensureCompanySetting(context, installation.installationId, {
    organizationId: orgB,
    isCurrent: 0,
    backupEnabled: 0,
    nextBackupAt: null,
    autoUploadEnabled: 0,
  });

  await ensureAuthorization(context, installation.installationId, engineerA, orgA, 'ACTIVE', null);
  await ensureAuthorization(
    context,
    installation.installationId,
    engineerB,
    orgB,
    'REVOKED',
    FIXED_BUSINESS_AT,
  );

  const uploadKey = 'upload:report-version:b';
  const uploadExisting = await findOne(context.qr, 'local_upload_task', {
    idempotency_key: `${MOCK_PREFIX}:${uploadKey}`,
  });
  if (!uploadExisting) {
    const manifestChecksum = sha256Hex(canonicalJson({ mock: true, key: uploadKey }));
    await insertRow(context.qr, 'local_upload_task', {
      record_uuid: mockUuid(uploadKey),
      source_version: 1,
      task_kind: 'BUSINESS_SYNC',
      manifest_checksum: manifestChecksum,
      installation_id: installation.installationId,
      entity_type: 'REPORT_VERSION',
      entity_local_id: reports.versionB,
      entity_version: '1',
      idempotency_key: `${MOCK_PREFIX}:${uploadKey}`,
      status: 'CANCELLED',
      attempt_count: 0,
      last_attempt_at: null,
      remote_id: null,
      remote_receipt: null,
      error_code: null,
      error_message: null,
      created_at: FIXED_BUSINESS_AT,
      updated_at: FIXED_BUSINESS_AT,
    });
    context.report.inserted();
    context.report.note('上传任务为 CANCELLED，不触发真实外传');
  } else {
    context.report.reused();
  }

  const conflictRecordUuid = mockUuid('sync:record:b-report');
  const receiptId = mockUuid('sync:receipt:b-report');
  const receiptExisting = await findOne(context.qr, 'sync_receipt', { receipt_id: receiptId });
  if (!receiptExisting) {
    await insertRow(context.qr, 'sync_receipt', {
      receipt_id: receiptId,
      record_uuid: conflictRecordUuid,
      organization_id: orgB,
      resource_type: 'MAINTENANCE_REPORT',
      version_no: 1,
      source_system: 'LOCAL',
      source_installation_id: installation.installationId,
      remote_resource_id: null,
      received_at: FIXED_BUSINESS_AT,
      receipt_status: 'CONFLICT',
      manifest_checksum: sha256Hex(canonicalJson({ mock: true, key: 'sync:b-report' })),
      created_at: FIXED_BUSINESS_AT,
      confirmed_at: null,
    });
    context.report.inserted();
  } else {
    context.report.reused();
  }

  const conflictId = mockUuid('sync:conflict:b-report');
  const conflictExisting = await findOne(context.qr, 'sync_conflict', {
    conflict_id: conflictId,
  });
  if (!conflictExisting) {
    await insertRow(context.qr, 'sync_conflict', {
      conflict_id: conflictId,
      record_uuid: conflictRecordUuid,
      organization_id: orgB,
      resource_type: 'MAINTENANCE_REPORT',
      version_no: 1,
      local_version: 2,
      cloud_version: 1,
      displayed_cloud_version: 1,
      decision: 'PENDING',
      local_snapshot: canonicalJson({
        schema_version: 1,
        mock: true,
        title: '本地版本（待裁决）',
      }),
      cloud_snapshot: canonicalJson({
        schema_version: 1,
        mock: true,
        title: '云端版本（待裁决）',
      }),
      conflict_reason: `${MOCK_LABEL} 本地与云端版本冲突样例`,
      status: 'PENDING',
      confirmed_by_account_id: null,
      confirmed_at: null,
      created_at: FIXED_BUSINESS_AT,
    });
    context.report.inserted();
  } else {
    context.report.reused();
  }
}

async function ensureCompanySetting(
  context: PackContext,
  installationId: string,
  input: {
    organizationId: number;
    isCurrent: 0 | 1;
    backupEnabled: 0 | 1;
    nextBackupAt: Date | null;
    autoUploadEnabled: 0;
  },
): Promise<void> {
  const existing = await findOne(context.qr, 'local_company_setting', {
    installation_id: installationId,
    organization_id: input.organizationId,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'local_company_setting', {
    installation_id: installationId,
    organization_id: input.organizationId,
    setting_source: 'LOCAL_MANUAL',
    is_current: input.isCurrent,
    initialized_at: FIXED_BUSINESS_AT,
    backup_interval_hours: 72,
    backup_enabled: input.backupEnabled,
    next_backup_at: input.nextBackupAt,
    last_auto_success_at: null,
    last_auto_failure_at: null,
    failure_reason: null,
    auto_upload_enabled: input.autoUploadEnabled,
    created_at: FIXED_BUSINESS_AT,
    updated_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
}

async function ensureAuthorization(
  context: PackContext,
  installationId: string,
  accountId: number,
  organizationId: number,
  status: 'ACTIVE' | 'REVOKED',
  revokedAt: Date | null,
): Promise<void> {
  const existing = await findOne(context.qr, 'local_account_authorization', {
    installation_id: installationId,
    account_id: accountId,
    organization_id: organizationId,
  });
  if (existing) {
    if (String(existing.authorization_status) !== status) {
      throw new MockConflictError(`本机授权 ${accountId} 状态不同，拒绝改写`);
    }
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'local_account_authorization', {
    installation_id: installationId,
    account_id: accountId,
    organization_id: organizationId,
    authorization_status: status,
    authorized_at: FIXED_BUSINESS_AT,
    revoked_at: revokedAt,
    signed_claims: null,
    permission_version: null,
    last_verified_at: null,
    created_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
}

export async function runPackagesPack(context: PackContext): Promise<void> {
  await assertAccountsEligible(context, ['engineer-b'], 'p1-packages');
  const orgB = await requireOrganizationId(context, 'B');
  const engineerB = await requireAccountId(context, 'engineer-b');

  const validPackage = buildMockPackage({
    packageId: mockUuid('package:valid:b'),
    organizationCode: ORGANIZATIONS[1].code,
    generatedAt: '2026-11-07T06:00:00.000Z',
    items: [
      {
        record_uuid: mockUuid('package:record:valid'),
        resource_type: 'MAINTENANCE_REPORT',
        version_no: 1,
        payload: { title: `${MOCK_LABEL} 记录包合法样例`, mock: true },
      },
    ],
  });
  const validContent = `${JSON.stringify(validPackage, null, 2)}\n`;
  const validPath = path.join(context.mockFileDir, 'packages', 'valid-package.json');
  const validState = context.files.ensure(validPath, Buffer.from(validContent, 'utf8'));
  if (validState === 'REUSED') {
    context.report.note('合法包文件已存在且一致');
  }
  const corruptContent = `${JSON.stringify(corruptMockPackage(validPackage), null, 2)}\n`;
  const corruptPath = path.join(context.mockFileDir, 'packages', 'corrupt-package.json');
  const corruptState = context.files.ensure(corruptPath, Buffer.from(corruptContent, 'utf8'));
  if (corruptState === 'REUSED') {
    context.report.note('损坏包文件已存在且一致');
  }

  const validVerification = verifyMockPackageContent(validContent);
  const corruptVerification = verifyMockPackageContent(corruptContent);
  if (!validVerification.ok || corruptVerification.ok) {
    throw new MockConflictError('记录包自检结果不符合预期（合法包应通过、损坏包应失败）');
  }
  context.report.note(`包校验：合法=通过；损坏=拒绝(${corruptVerification.computed.slice(0, 8)}…)`);

  await ensurePackageImport(context, {
    packageId: mockUuid('package:valid:b'),
    organizationId: orgB,
    importedBy: engineerB,
    manifestJson: validContent,
    status: 'PENDING',
    checkStatus: 'PASSED',
    itemTotal: 1,
    itemSucceeded: 0,
    itemFailed: 0,
    items: [
      {
        recordUuid: validPackage.items[0].record_uuid,
        checkResult: 'PASSED',
        errorMessage: null,
      },
    ],
  });
  await ensurePackageImport(context, {
    packageId: mockUuid('package:corrupt:b'),
    organizationId: orgB,
    importedBy: engineerB,
    manifestJson: corruptContent,
    status: 'PENDING',
    checkStatus: 'REJECTED',
    itemTotal: 1,
    itemSucceeded: 0,
    itemFailed: 1,
    items: [
      {
        recordUuid: validPackage.items[0].record_uuid,
        checkResult: 'REJECTED',
        errorMessage: 'MOCK-V13 清单校验不通过（损坏对照）',
      },
    ],
  });

  context.report.scenario({
    kind: 'package',
    key: 'valid-package',
    id: validPath,
    detail: '校验通过、未执行导入（无真实导入器）',
  });
  context.report.scenario({
    kind: 'package',
    key: 'corrupt-package',
    id: corruptPath,
    detail: '校验拒绝对照',
  });
}

async function ensurePackageImport(
  context: PackContext,
  input: {
    packageId: string;
    organizationId: number;
    importedBy: number;
    manifestJson: string;
    status: 'PENDING' | 'FAILED';
    checkStatus: 'PASSED' | 'REJECTED';
    itemTotal: number;
    itemSucceeded: number;
    itemFailed: number;
    items: readonly {
      recordUuid: string;
      checkResult: string;
      errorMessage: string | null;
    }[];
  },
): Promise<void> {
  const existing = await findOne(context.qr, 'record_package_import', {
    package_id: input.packageId,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'record_package_import', {
    package_id: input.packageId,
    organization_id: input.organizationId,
    imported_by_account_id: input.importedBy,
    manifest_json: input.manifestJson,
    manifest_checksum: sha256Hex(input.manifestJson),
    status: input.status,
    check_status: input.checkStatus,
    item_total: input.itemTotal,
    item_succeeded: input.itemSucceeded,
    item_failed: input.itemFailed,
    created_at: FIXED_REPORT_AT,
    completed_at: FIXED_REPORT_AT,
  });
  context.report.inserted();
  for (const [index, item] of input.items.entries()) {
    await insertRow(context.qr, 'record_package_item', {
      package_id: input.packageId,
      record_uuid: item.recordUuid,
      resource_type: 'MAINTENANCE_REPORT',
      version_no: index + 1,
      check_result: item.checkResult,
      result: null,
      receipt_id: null,
      error_message: item.errorMessage,
      created_at: FIXED_REPORT_AT,
    });
    context.report.inserted();
  }
}

export async function runBackupPack(context: PackContext): Promise<void> {
  await assertAccountsEligible(context, ['admin-l2-a'], 'p1-backup');
  const orgA = await requireOrganizationId(context, 'A');
  const adminA = await requireAccountId(context, 'admin-l2-a');
  const installation = await resolveInstallationIdentity(context);

  const run1 = await ensureBackupRun(context, installation.installationId, {
    key: 'manual',
    organizationId: orgA,
    trigger: 'MANUAL',
    startedAt: new Date('2026-11-07T05:00:00.000Z'),
    finishedAt: new Date('2026-11-07T05:05:00.000Z'),
    errorCode: 'MOCK_V13_NO_EXECUTOR',
    errorMessage: '测试样例：未接入隔离备份执行器，未生成真实备份包。',
  });
  const run2 = await ensureBackupRun(context, installation.installationId, {
    key: 'scheduled',
    organizationId: orgA,
    trigger: 'SCHEDULED',
    startedAt: new Date('2026-11-08T02:00:00.000Z'),
    finishedAt: new Date('2026-11-08T02:03:00.000Z'),
    errorCode: 'MOCK_V13_NO_EXECUTOR',
    errorMessage: '测试样例：调度触发但执行器缺失，状态为失败。',
  });

  const asset1 = await ensureBackupAsset(context, installation.installationId, {
    key: 'run-manual',
    runId: run1,
    organizationId: orgA,
    failureReason: '未上传云端（无执行器）',
  });
  const asset2 = await ensureBackupAsset(context, installation.installationId, {
    key: 'run-scheduled',
    runId: run2,
    organizationId: orgA,
    failureReason: '未上传云端（无执行器）',
  });

  await ensureRestoreRun(context, installation.installationId, {
    key: 'pending',
    backupId: asset1,
    protectionBackupId: null,
    organizationId: orgA,
    startedBy: adminA,
    status: 'PENDING',
    checkStatus: 'PENDING',
    startedAt: null,
    finishedAt: null,
    resultSummary: 'MOCK-V13 待确认，未执行恢复。',
  });
  await ensureRestoreRun(context, installation.installationId, {
    key: 'failed',
    backupId: asset1,
    protectionBackupId: asset2,
    organizationId: orgA,
    startedBy: adminA,
    status: 'FAILED',
    checkStatus: null,
    startedAt: new Date('2026-11-08T06:00:00.000Z'),
    finishedAt: new Date('2026-11-08T06:02:00.000Z'),
    resultSummary: 'MOCK-V13 预检失败，未执行恢复。',
  });

  context.report.scenario({
    kind: 'backup',
    key: 'local-backup-run:manual',
    id: run1,
    detail: 'FAILED（无执行器）',
  });
  context.report.scenario({
    kind: 'backup',
    key: 'backup-asset:run-manual',
    id: asset1,
    detail: '本地清单存在、云端失败',
  });
}

async function ensureBackupRun(
  context: PackContext,
  installationId: string,
  input: {
    key: string;
    organizationId: number;
    trigger: 'MANUAL' | 'SCHEDULED';
    startedAt: Date;
    finishedAt: Date;
    errorCode: string;
    errorMessage: string;
  },
): Promise<number> {
  const existing = await findOne(context.qr, 'local_backup_run', {
    installation_id: installationId,
    organization_id: input.organizationId,
    trigger_type: input.trigger,
    started_at: input.startedAt,
  });
  if (existing) {
    context.report.reused();
    return readNumber(existing, 'id');
  }
  const id = await insertRow(context.qr, 'local_backup_run', {
    installation_id: installationId,
    organization_id: input.organizationId,
    manual_upload_status: 'NOT_REQUIRED',
    manual_cleanup_status: 'NOT_REQUIRED',
    trigger_type: input.trigger,
    status: 'FAILED',
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    manifest_path: null,
    manifest_checksum: null,
    byte_size: null,
    attachment_count: null,
    schema_version: null,
    error_code: input.errorCode,
    error_message: input.errorMessage,
    created_at: input.startedAt,
    updated_at: input.finishedAt,
  });
  context.report.inserted();
  return id;
}

async function ensureBackupAsset(
  context: PackContext,
  installationId: string,
  input: {
    key: string;
    runId: number;
    organizationId: number;
    failureReason: string;
  },
): Promise<string> {
  const backupId = mockUuid(`backup-asset:${input.key}`);
  const existing = await findOne(context.qr, 'backup_asset', { backup_id: backupId });
  if (existing) {
    context.report.reused();
    return backupId;
  }
  const relativePath = path.join('backups', `${input.key}.json`);
  const content = Buffer.from(
    canonicalJson({
      schema_version: 1,
      mock: true,
      key: input.key,
      note: '未接入隔离执行器；仅清单样例，不代表可恢复备份。',
    }),
    'utf8',
  );
  const state = context.files.ensure(path.join(context.mockFileDir, relativePath), content);
  if (state === 'REUSED') {
    context.report.note(`备份清单已存在且一致: ${relativePath}`);
  }
  await insertRow(context.qr, 'backup_asset', {
    backup_id: backupId,
    run_id: input.runId,
    organization_id: input.organizationId,
    local_cleanup_run_id: null,
    installation_id: installationId,
    format_version: 1,
    data_version: 'v13-mock',
    manifest_checksum: sha256Hex(content),
    local_reference: relativePath,
    cloud_reference: null,
    encryption_key_id: null,
    verified_at: null,
    retention_until: null,
    failure_reason: input.failureReason,
    deleted_at: null,
    local_cleanup_error: null,
    storage_reference: relativePath,
    file_sha256: sha256Hex(content),
    byte_size: content.length,
    cloud_status: 'FAILED',
    local_status: 'PENDING',
    cloud_receipt: null,
    attempt_count: 1,
    last_attempt_at: FIXED_REPORT_AT,
    created_at: FIXED_REPORT_AT,
    updated_at: FIXED_REPORT_AT,
  });
  context.report.inserted();
  return backupId;
}

async function ensureRestoreRun(
  context: PackContext,
  installationId: string,
  input: {
    key: string;
    backupId: string;
    protectionBackupId: string | null;
    organizationId: number;
    startedBy: number;
    status: 'PENDING' | 'FAILED';
    checkStatus: 'PENDING' | 'FAILED' | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    resultSummary: string;
  },
): Promise<void> {
  const restoreId = mockUuid(`restore-run:${input.key}`);
  const existing = await findOne(context.qr, 'backup_restore_run', {
    restore_id: restoreId,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'backup_restore_run', {
    restore_id: restoreId,
    backup_id: input.backupId,
    protection_backup_id: input.protectionBackupId,
    target_installation_id: installationId,
    check_status: input.checkStatus,
    confirmation: input.startedAt
      ? canonicalJson({
          schema_version: 1,
          mock: true,
          confirmed_by: input.startedBy,
          note: '仅测试样例，未执行恢复',
        })
      : null,
    organization_id: input.organizationId,
    started_by_account_id: input.startedBy,
    status: input.status,
    check_snapshot: canonicalJson({
      schema_version: 1,
      mock: true,
      check: input.checkStatus,
      note: '未接入恢复执行器',
    }),
    restored_scope: null,
    result_summary: input.resultSummary,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  });
  context.report.inserted();
}
