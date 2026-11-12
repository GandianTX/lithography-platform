// scripts/mock-v13/packs-p0.ts

/**
 * P0 数据包：组织账号、机型、报修工单、维修报告、参考资料。
 */

import * as path from 'node:path';

import { findOne, findMany, insertRow, updateRow } from './db';
import { canonicalJson, mockPng, mockTextDocument, sha256Hex } from './files';
import {
  ACCOUNTS,
  AccountSpec,
  DOCUMENT_TITLES,
  FIXED_ACCOUNT_CREATED_AT,
  FIXED_BUSINESS_AT,
  FIXED_REPORT_AT,
  MOCK_LABEL,
  MOCK_PREFIX,
  REPORT_KEYS,
  REPORT_TITLES,
  TICKETS,
  mockEmail,
  mockUuid,
} from './manifest';
import {
  OrganizationIds,
  PackContext,
  organizationIdFor,
  readNumber,
  readString,
  requireAccountId,
  resolveModels,
  resolveOrganizationIds,
} from './packs-shared';
import { MockConflictError } from './errors';

const ACCOUNT_ROLES = new Set(['SUPER_ADMIN', 'ENGINEER', 'CUSTOMER']);

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseRoleArray(value: unknown, context: string): string[] {
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string')) {
      throw new MockConflictError(`${context} 不是合法角色数组`);
    }
    return value as string[];
  }
  if (typeof value !== 'string') {
    throw new MockConflictError(`${context} 不是字符串`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('not array');
    }
    return parsed as string[];
  } catch {
    throw new MockConflictError(`${context} 不是合法角色数组`);
  }
}

export async function runOrgAccountsPack(context: PackContext): Promise<void> {
  const ids = await resolveOrganizationIds(context);
  for (const account of ACCOUNTS) {
    await ensureAccount(context, account, ids);
  }
  for (const account of ACCOUNTS) {
    if (account.organization === null) continue;
    await ensureMembership(context, account, ids);
  }
  await ensureEngineerApplications(context, ids);
}

async function ensureAccount(
  context: PackContext,
  account: AccountSpec,
  ids: OrganizationIds,
): Promise<void> {
  const email = mockEmail(account.loginName);
  const existing = await findOne(context.qr, 'base_user_account', {
    login_name: account.loginName,
  });
  if (existing) {
    const existingEmail = asText(existing.login_email);
    const identity = asText(existing.identity_hint);
    const level = existing.admin_level === null ? null : Number(existing.admin_level);
    const status = asText(existing.status);
    const passwordHash = asText(existing.login_password);
    if (
      existingEmail !== email ||
      identity !== account.role ||
      level !== account.adminLevel ||
      status !== account.accountStatus ||
      passwordHash !== context.passwordHash
    ) {
      throw new MockConflictError(
        `账号 ${account.loginName} 已存在但事实不同（email=${existingEmail}, identity=${identity}, level=${level}, status=${status}），拒绝复用与重置`,
      );
    }
    context.report.reused();
    const accountId = readNumber(existing, 'id');
    await ensureUserInfo(context, account, accountId, ids);
    context.report.scenario({
      kind: 'account',
      key: account.loginName,
      id: accountId,
      detail: `${account.role}${account.adminLevel ? ` L${account.adminLevel}` : ''} ${account.note}`,
    });
    return;
  }

  const accountId = await insertRow(context.qr, 'base_user_account', {
    login_name: account.loginName,
    login_email: email,
    login_password: context.passwordHash,
    status: account.accountStatus,
    recent_login_history: null,
    identity_hint: account.role,
    admin_level: account.adminLevel,
    must_change_password: 0,
    created_at: FIXED_ACCOUNT_CREATED_AT,
    updated_at: FIXED_ACCOUNT_CREATED_AT,
  });
  context.report.inserted();
  await ensureUserInfo(context, account, accountId, ids);
  context.report.scenario({
    kind: 'account',
    key: account.loginName,
    id: accountId,
    detail: `${account.role}${account.adminLevel ? ` L${account.adminLevel}` : ''} ${account.note}`,
  });
}

async function ensureUserInfo(
  context: PackContext,
  account: AccountSpec,
  accountId: number,
  ids: OrganizationIds,
): Promise<void> {
  const existing = await findOne(context.qr, 'base_user_info', { account_id: accountId });
  const profileOrganizationId = organizationIdFor(ids, account.profileOrganization);
  if (existing) {
    const accessGroup = parseRoleArray(existing.access_group, `${account.loginName} access_group`);
    if (accessGroup.length !== 1 || !ACCOUNT_ROLES.has(accessGroup[0])) {
      throw new MockConflictError(`账号 ${account.loginName} 的 access_group 不是单一角色`);
    }
    const decrypted = context.encryption.decrypt(asText(existing.meta_digest));
    const digestRoles = parseRoleArray(decrypted, `${account.loginName} meta_digest`);
    if (digestRoles.length !== 1 || digestRoles[0] !== accessGroup[0]) {
      throw new MockConflictError(
        `账号 ${account.loginName} 的 meta_digest 与 access_group 不一致`,
      );
    }
    const existingOrganizationId =
      existing.customer_organization_id === null ? null : Number(existing.customer_organization_id);
    if (existingOrganizationId !== profileOrganizationId) {
      throw new MockConflictError(
        `账号 ${account.loginName} 的资料归属公司为 ${existingOrganizationId}，与预期 ${profileOrganizationId} 不同，拒绝改写`,
      );
    }
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'base_user_info', {
    account_id: accountId,
    nickname: account.nickname,
    real_name: account.realName,
    customer_organization_id: profileOrganizationId,
    company_name:
      account.profileOrganization !== null
        ? `${MOCK_LABEL} 客户公司 ${account.profileOrganization}`
        : `${MOCK_LABEL} 平台账号`,
    gender: 'SECRET',
    birth_date: null,
    avatar_url: null,
    email: mockEmail(account.loginName),
    signature: `${MOCK_PREFIX} 开发测试账号，仅用于联调`,
    access_group: JSON.stringify([account.role]),
    address: null,
    phone: null,
    tags: JSON.stringify([MOCK_PREFIX, account.role]),
    geographic: null,
    meta_digest: context.encryption.encrypt(JSON.stringify([account.role])),
    notify_count: 0,
    unread_count: 0,
    user_state: account.userState,
    created_at: FIXED_ACCOUNT_CREATED_AT,
    updated_at: FIXED_ACCOUNT_CREATED_AT,
  });
  context.report.inserted();
}

async function ensureMembership(
  context: PackContext,
  account: AccountSpec,
  ids: OrganizationIds,
): Promise<void> {
  const accountId = await requireAccountId(context, account.key);
  const organizationId = organizationIdFor(ids, account.organization);
  if (organizationId === null) return;
  const existing = await findOne(context.qr, 'organization_membership', {
    organization_id: organizationId,
    account_id: accountId,
  });
  if (existing) {
    const role = String(existing.member_role);
    const status = String(existing.status);
    if (role !== account.role || status !== 'ACTIVE') {
      throw new MockConflictError(
        `账号 ${account.loginName} 的成员关系异常（role=${role}, status=${status}），拒绝改写`,
      );
    }
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'organization_membership', {
    organization_id: organizationId,
    account_id: accountId,
    member_role: account.role,
    status: 'ACTIVE',
    joined_at: FIXED_BUSINESS_AT,
    left_at: null,
    created_at: FIXED_BUSINESS_AT,
    updated_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
}

async function ensureEngineerApplications(
  context: PackContext,
  ids: OrganizationIds,
): Promise<void> {
  const pendingAccountId = await requireAccountId(context, 'pending-engineer');
  const rejectedAccountId = await requireAccountId(context, 'rejected-engineer');
  const adminB = await requireAccountId(context, 'admin-l2-b');

  await ensureApplication(context, {
    accountId: pendingAccountId,
    organizationId: ids.A,
    status: 'PENDING',
    note: `${MOCK_LABEL} 工程师申请待审样例：未授予成员关系`,
    submittedAt: new Date('2026-11-05T02:00:00.000Z'),
    reviewerId: null,
    reviewedAt: null,
    reviewComment: null,
  });
  await ensureApplication(context, {
    accountId: rejectedAccountId,
    organizationId: ids.B,
    status: 'REJECTED',
    note: `${MOCK_LABEL} 工程师申请拒绝样例：不取得工程师权限`,
    submittedAt: new Date('2026-11-05T02:10:00.000Z'),
    reviewerId: adminB,
    reviewedAt: new Date('2026-11-05T03:00:00.000Z'),
    reviewComment: '测试样例：资料不完整，予以拒绝。',
  });
}

async function ensureApplication(
  context: PackContext,
  input: {
    accountId: number;
    organizationId: number;
    status: 'PENDING' | 'REJECTED';
    note: string;
    submittedAt: Date;
    reviewerId: number | null;
    reviewedAt: Date | null;
    reviewComment: string | null;
  },
): Promise<void> {
  const existing = await findOne(context.qr, 'engineer_registration_application', {
    account_id: input.accountId,
  });
  if (existing) {
    if (
      Number(existing.organization_id) !== input.organizationId ||
      String(existing.status) !== input.status
    ) {
      throw new MockConflictError(`工程师申请 ${input.accountId} 已存在但组织或状态不同，拒绝改写`);
    }
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'engineer_registration_application', {
    account_id: input.accountId,
    organization_id: input.organizationId,
    status: input.status,
    application_note: input.note,
    submitted_at: input.submittedAt,
    reviewed_by_account_id: input.reviewerId,
    reviewed_at: input.reviewedAt,
    review_comment: input.reviewComment,
    created_at: input.submittedAt,
    updated_at: input.reviewedAt ?? input.submittedAt,
  });
  context.report.inserted();
}

export async function runEquipmentPack(context: PackContext): Promise<void> {
  const models = await resolveModels(context);
  if (models.length >= 2) {
    context.report.reused(models.length);
    context.report.note(`复用现有启用机型 ${models.map((item) => item.modelCode).join(', ')}`);
    for (const model of models) {
      context.report.scenario({
        kind: 'file',
        key: `equipment:${model.modelCode}`,
        id: model.id,
        detail: model.modelName,
      });
    }
    return;
  }
  const templates = [
    { code: `${MOCK_PREFIX}-MODEL-1`, name: `${MOCK_LABEL} 测试机型一（193nm 干式）`, order: 900 },
    { code: `${MOCK_PREFIX}-MODEL-2`, name: `${MOCK_LABEL} 测试机型二（KrF 扫描）`, order: 901 },
  ];
  for (const template of templates.slice(models.length)) {
    const existing = await findOne(context.qr, 'equipment_model', {
      model_code: template.code,
    });
    if (existing) {
      if (!readString(existing, 'model_name').startsWith(MOCK_LABEL)) {
        throw new MockConflictError(`机型 ${template.code} 已存在但不是 Mock 机型`);
      }
      context.report.reused();
      continue;
    }
    const id = await insertRow(context.qr, 'equipment_model', {
      model_code: template.code,
      model_name: template.name,
      sort_order: template.order,
      enabled: 1,
      created_at: FIXED_BUSINESS_AT,
      updated_at: FIXED_BUSINESS_AT,
    });
    context.report.inserted();
    context.report.scenario({
      kind: 'file',
      key: `equipment:${template.code}`,
      id,
      detail: template.name,
    });
  }
}

interface StoredFileInput {
  fileKey: string;
  relativePath: string;
  absolutePath: string;
  content: Buffer;
  originalFilename: string;
  mimeType: string;
  uploaderKey: string;
  organizationId: number;
  businessType: string;
}

async function ensureStoredFile(context: PackContext, input: StoredFileInput): Promise<string> {
  const reference = input.relativePath;
  const fileId = mockUuid(`stored-file:${input.fileKey}`);
  const existing = await findOne(context.qr, 'stored_file', { file_id: fileId });
  const fileState = context.files.ensure(input.absolutePath, input.content);
  if (existing) {
    if (readString(existing, 'storage_reference') !== reference) {
      throw new MockConflictError(`原件 ${input.fileKey} 的存储引用不一致`);
    }
    context.report.reused();
    return fileId;
  }
  if (fileState === 'REUSED') {
    context.report.note(`文件已存在且校验一致: ${reference}`);
  }
  await insertRow(context.qr, 'stored_file', {
    file_id: fileId,
    uploaded_by_account_id: await requireAccountId(context, input.uploaderKey),
    owner_organization_id: input.organizationId,
    storage_reference: reference,
    original_filename: input.originalFilename,
    mime_type: input.mimeType,
    byte_size: input.content.length,
    checksum_sha256: sha256Hex(input.content),
    status: 'VALID',
    business_type: input.businessType,
    business_id: null,
    upload_context_id: mockUuid(`upload-context:${input.fileKey}`),
    // 先登记为 TEMPORARY（business_id 必须为空），待业务主键生成后再绑定；
    // BOUND 要求 business_id 非空，直接以 BOUND 插入会违反 chk_stored_file_binding_pair。
    binding_status: 'TEMPORARY',
    created_at: FIXED_BUSINESS_AT,
    verified_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
  context.report.scenario({
    kind: 'file',
    key: input.fileKey,
    id: reference,
    detail: input.originalFilename,
  });
  return fileId;
}

export async function runRepairPack(context: PackContext): Promise<void> {
  const ids = await resolveOrganizationIds(context);
  const models = await resolveModels(context);
  if (models.length < 2) {
    throw new MockConflictError('启用机型不足 2 个，请先运行 p0-equipment');
  }

  const intakeAFileContent = mockPng();
  const intakeAFileReference = path.join('files', 'intake-a-in-progress.png');
  const intakeAFileId = await ensureStoredFile(context, {
    fileKey: 'intake:a-in-progress',
    relativePath: intakeAFileReference,
    absolutePath: path.join(context.mockFileDir, intakeAFileReference),
    content: intakeAFileContent,
    originalFilename: 'mock-v13-intake-a-in-progress.png',
    mimeType: 'image/png',
    uploaderKey: 'customer-a',
    organizationId: ids.A,
    businessType: 'REPAIR_REQUEST_INTAKE',
  });

  for (const ticket of TICKETS) {
    const customerId = await requireAccountId(context, ticket.customerKey);
    const customerOrganizationId = ids[ticket.serviceOrganization];
    const model = models[ticket.modelSlot];
    const intakeExisting = await findOne(context.qr, 'repair_request_intake', {
      record_uuid: ticket.intakeRecordUuid,
    });
    let intakeId: number;
    if (intakeExisting) {
      if (
        Number(intakeExisting.customer_account_id) !== customerId ||
        Number(intakeExisting.service_organization_id) !== customerOrganizationId
      ) {
        throw new MockConflictError(`报修采集 ${ticket.requestNo} 已存在但归属不同，拒绝改写`);
      }
      intakeId = readNumber(intakeExisting, 'id');
      context.report.reused();
    } else {
      intakeId = await insertRow(context.qr, 'repair_request_intake', {
        record_uuid: ticket.intakeRecordUuid,
        customer_account_id: customerId,
        customer_organization_id: customerOrganizationId,
        service_organization_id: customerOrganizationId,
        equipment_model_id: model.id,
        error_code: ticket.errorCode,
        fault_description: ticket.faultDescription,
        file_id: ticket.key === 'a-in-progress' ? intakeAFileId : null,
        analysis_status: ticket.analysisStatus,
        analysis_generation: ticket.analysisStatus === 'RUNNING' ? 0 : 1,
        converted_request_id: null,
        deleted_at: null,
        created_at: ticket.createdAt,
      });
      context.report.inserted();
    }
    context.report.scenario({
      kind: 'intake',
      key: ticket.requestNo,
      id: intakeId,
      detail: ticket.converted ? '已转单' : `未转单（${ticket.analysisStatus}）`,
    });

    if (!ticket.converted) {
      continue;
    }

    const requestExisting = await findOne(context.qr, 'repair_request', {
      request_no: ticket.requestNo,
    });
    let requestId: number;
    if (requestExisting) {
      if (
        Number(requestExisting.intake_id) !== intakeId ||
        Number(requestExisting.customer_account_id) !== customerId ||
        Number(requestExisting.owner_organization_id) !== customerOrganizationId
      ) {
        throw new MockConflictError(`工单 ${ticket.requestNo} 已存在但归属不同，拒绝改写`);
      }
      requestId = readNumber(requestExisting, 'id');
      context.report.reused();
    } else {
      const acceptedById =
        ticket.acceptedByKey === null
          ? null
          : await requireAccountId(context, ticket.acceptedByKey);
      requestId = await insertRow(context.qr, 'repair_request', {
        request_no: ticket.requestNo,
        intake_id: intakeId,
        customer_organization_id: customerOrganizationId,
        service_organization_id: customerOrganizationId,
        closure_status: ticket.closureStatus,
        closed_at: ticket.closedAt,
        closure_reason: ticket.closureReason,
        is_historical: 0,
        current_revision_no: 0,
        customer_account_id: customerId,
        equipment_model_id: model.id,
        error_code: ticket.errorCode,
        fault_description: ticket.faultDescription,
        content_md: ticket.faultDescription,
        created_at: ticket.createdAt,
        is_accepted: ticket.acceptedByKey === null ? 0 : 1,
        accepted_by_engineer_account_id: acceptedById,
        accepted_at: ticket.acceptedAt,
        owner_organization_id: customerOrganizationId,
        handling_result: ticket.handlingResult,
        handling_status: ticket.handlingStatus,
        handling_recorded_at: ticket.handlingRecordedAt,
        handling_recorded_by_account_id: acceptedById,
        handling_ended_at: ticket.handlingEndedAt,
        deprecated: 0,
        deleted_at: null,
      });
      context.report.inserted();
      await updateRow(
        context.qr,
        'repair_request_intake',
        { id: intakeId },
        { converted_request_id: requestId },
      );
    }
    context.report.scenario({
      kind: 'ticket',
      key: ticket.requestNo,
      id: requestId,
      detail: `客户=${ticket.customerKey} 服务公司=${ticket.serviceOrganization} 状态=${
        ticket.acceptedByKey === null ? '待接单' : (ticket.handlingStatus ?? '已接单')
      }`,
    });

    if (ticket.key === 'a-in-progress') {
      await updateRow(
        context.qr,
        'stored_file',
        { file_id: intakeAFileId },
        { business_id: String(intakeId), binding_status: 'BOUND' },
      );
    }

    if (ticket.responseText && ticket.acceptedByKey && ticket.resolutionStatus) {
      const engineerId = await requireAccountId(context, ticket.acceptedByKey);
      const existingResponse = await findOne(context.qr, 'engineer_response', {
        request_id: requestId,
        engineer_account_id: engineerId,
        created_at: ticket.handlingRecordedAt ?? ticket.createdAt,
      });
      if (!existingResponse) {
        await insertRow(context.qr, 'engineer_response', {
          request_id: requestId,
          engineer_account_id: engineerId,
          customer_account_id: customerId,
          resolution_status: ticket.resolutionStatus,
          response_text: ticket.responseText,
          created_at: ticket.handlingRecordedAt ?? ticket.createdAt,
        });
        context.report.inserted();
      } else {
        context.report.reused();
      }
    }

    if (ticket.processOperation && ticket.acceptedByKey) {
      const engineerId = await requireAccountId(context, ticket.acceptedByKey);
      const entryUuid = mockUuid(`process:${ticket.key}`);
      const existingEntry = await findOne(context.qr, 'repair_process_entry', {
        entry_uuid: entryUuid,
      });
      if (!existingEntry) {
        await insertRow(context.qr, 'repair_process_entry', {
          entry_uuid: entryUuid,
          request_id: requestId,
          author_account_id: engineerId,
          operation_text: ticket.processOperation,
          test_result: ticket.processTestResult,
          occurred_at: ticket.processAt ?? ticket.createdAt,
          time_source: 'RECORDED_BY_ENGINEER',
          file_id: null,
          version_no: 1,
          created_at: ticket.processAt ?? ticket.createdAt,
        });
        context.report.inserted();
      } else {
        context.report.reused();
      }
    }
  }
}

interface ReportSeed {
  key: keyof typeof REPORT_KEYS;
  organizationKey: 'A' | 'B';
  sourceType: 'HISTORICAL_CASE' | 'WORK_ORDER_SUMMARY';
  status: 'DRAFT' | 'APPROVED';
  title: string;
  engineerKey: string;
  modelSlot: 0 | 1;
  modelText: string | null;
  requestNo: string | null;
  aiUsage: 'NOT_USED' | 'USED';
}

const REPORT_SEEDS: readonly ReportSeed[] = [
  {
    key: 'draftA',
    organizationKey: 'A',
    sourceType: 'HISTORICAL_CASE',
    status: 'DRAFT',
    title: REPORT_TITLES.draftA,
    engineerKey: 'engineer-a',
    modelSlot: 0,
    modelText: 'NIKON NSR-2205i11D（手填测试机型）',
    requestNo: null,
    aiUsage: 'NOT_USED',
  },
  {
    key: 'draftB',
    organizationKey: 'B',
    sourceType: 'HISTORICAL_CASE',
    status: 'DRAFT',
    title: REPORT_TITLES.draftB,
    engineerKey: 'engineer-b',
    modelSlot: 1,
    modelText: 'ASML XT 测试机型（手填）',
    requestNo: null,
    aiUsage: 'NOT_USED',
  },
  {
    key: 'formalA',
    organizationKey: 'A',
    sourceType: 'HISTORICAL_CASE',
    status: 'APPROVED',
    title: REPORT_TITLES.formalA,
    engineerKey: 'engineer-a',
    modelSlot: 0,
    modelText: null,
    requestNo: null,
    aiUsage: 'NOT_USED',
  },
  {
    key: 'formalB',
    organizationKey: 'B',
    sourceType: 'WORK_ORDER_SUMMARY',
    status: 'APPROVED',
    title: REPORT_TITLES.formalB,
    engineerKey: 'engineer-b',
    modelSlot: 1,
    modelText: null,
    requestNo: `${MOCK_PREFIX}-REQ-B-001`,
    aiUsage: 'USED',
  },
];

export interface ReportIds {
  readonly drafts: readonly number[];
  readonly formalA: number;
  readonly formalB: number;
  readonly versionA: number;
  readonly versionB: number;
}

export async function runReportsPack(context: PackContext): Promise<ReportIds> {
  const ids = await resolveOrganizationIds(context);
  const models = await resolveModels(context);
  if (models.length < 2) {
    throw new MockConflictError('启用机型不足 2 个，请先运行 p0-equipment');
  }
  const adminA = await requireAccountId(context, 'admin-l2-a');
  const adminB = await requireAccountId(context, 'admin-l2-b');

  let formalA = 0;
  let formalB = 0;
  let versionA = 0;
  let versionB = 0;
  const drafts: number[] = [];

  for (const seed of REPORT_SEEDS) {
    const organizationId = ids[seed.organizationKey];
    const engineerId = await requireAccountId(context, seed.engineerKey);
    const submissionRequestId = `mock-v13:report:${seed.key}`;
    const payloadHash = sha256Hex(
      canonicalJson({ key: seed.key, title: seed.title, source: seed.sourceType }),
    );
    const existing = await findOne(context.qr, 'maintenance_report', {
      submission_request_id: submissionRequestId,
    });
    let reportId: number;
    if (existing) {
      if (
        Number(existing.owner_organization_id) !== organizationId ||
        String(existing.source_type) !== seed.sourceType ||
        !asText(existing.title).startsWith(MOCK_LABEL)
      ) {
        throw new MockConflictError(`报告 ${seed.title} 已存在但归属或来源不同，拒绝改写`);
      }
      reportId = readNumber(existing, 'id');
      context.report.reused();
    } else {
      const requestRow =
        seed.requestNo === null
          ? null
          : await findOne(context.qr, 'repair_request', { request_no: seed.requestNo });
      if (seed.requestNo !== null && !requestRow) {
        throw new MockConflictError(
          `正式报告依赖的工单 ${seed.requestNo} 不存在，请先运行 p0-repair`,
        );
      }
      const isApproved = seed.status === 'APPROVED';
      reportId = await insertRow(context.qr, 'maintenance_report', {
        owner_organization_id: organizationId,
        source_type: seed.sourceType,
        repair_request_id: requestRow ? readNumber(requestRow, 'id') : null,
        title: seed.title,
        customer_factory_name: `${MOCK_LABEL} ${seed.organizationKey} 测试客户工厂`,
        equipment_model_id: seed.modelText === null ? models[seed.modelSlot].id : null,
        equipment_model_text: seed.modelText,
        maintenance_date: '2026-11-06',
        maintenance_engineer_account_id: engineerId,
        maintenance_engineer_name_snapshot: `${MOCK_PREFIX} 工程师快照`,
        supplementary_note: `${MOCK_LABEL} 开发测试数据`,
        handling_result: 'FIXED',
        closure_reason: null,
        reset_result: 'NORMAL',
        actual_cause: '测试原因：通信链路接触不良。',
        repair_actions: '测试处置：更换线缆并复测。',
        verification_result: '测试验证：连续运行 24 小时无异常。',
        submission_request_id: submissionRequestId,
        submission_payload_hash: payloadHash,
        phase_flow_version: 1,
        status: seed.status,
        current_version_no: isApproved ? 1 : 0,
        last_submitted_at: isApproved ? new Date('2026-11-07T02:00:00.000Z') : null,
        last_reviewed_at: isApproved ? new Date('2026-11-07T04:00:00.000Z') : null,
        ai_usage: seed.aiUsage,
        ai_source_type: seed.aiUsage === 'USED' ? 'AI_QUESTION' : null,
        ai_source_id: seed.aiUsage === 'USED' ? mockUuid('ai:question:b-1') : null,
        ai_source_version: seed.aiUsage === 'USED' ? '1' : null,
        ai_score: seed.aiUsage === 'USED' ? 5 : null,
        ai_correctness: seed.aiUsage === 'USED' ? 'CORRECT' : null,
        ai_helpfulness: seed.aiUsage === 'USED' ? 4 : null,
        ai_note: seed.aiUsage === 'USED' ? '测试样例：AI 建议与实际处置一致。' : null,
        created_by_account_id: engineerId,
        updated_by_account_id: engineerId,
        created_at: FIXED_REPORT_AT,
        updated_at: FIXED_REPORT_AT,
      });
      context.report.inserted();
    }
    context.report.scenario({
      kind: 'report',
      key: seed.title,
      id: reportId,
      detail: `${seed.sourceType} / ${seed.status}`,
    });

    if (seed.status === 'DRAFT') {
      drafts.push(reportId);
    } else if (seed.key === 'formalA') {
      formalA = reportId;
      versionA = await ensureReportVersion(context, reportId, engineerId, seed.title);
      await ensureReportReview(context, reportId, versionA, adminA);
    } else if (seed.key === 'formalB') {
      formalB = reportId;
      versionB = await ensureReportVersion(context, reportId, engineerId, seed.title);
      await ensureReportReview(context, reportId, versionB, adminB);
      await ensureWorkOrderReportDetails(context, reportId);
    }
  }

  await ensureDraftAttachment(context, drafts);
  return { drafts, formalA, formalB, versionA, versionB };
}

async function ensureReportVersion(
  context: PackContext,
  reportId: number,
  engineerId: number,
  title: string,
): Promise<number> {
  const existing = await findOne(context.qr, 'maintenance_report_version', {
    report_id: reportId,
    version_no: 1,
  });
  if (existing) {
    context.report.reused();
    return readNumber(existing, 'id');
  }
  const versionId = await insertRow(context.qr, 'maintenance_report_version', {
    report_id: reportId,
    version_no: 1,
    change_kind: 'SUBMIT',
    change_reason: null,
    schema_version: 2,
    payload_snapshot: canonicalJson({
      schema_version: 2,
      mock: true,
      title,
      summary: `${MOCK_LABEL} 冻结版本快照`,
    }),
    submitted_by_account_id: engineerId,
    submitted_at: new Date('2026-11-07T02:00:00.000Z'),
    created_at: new Date('2026-11-07T02:00:00.000Z'),
  });
  context.report.inserted();
  return versionId;
}

async function ensureReportReview(
  context: PackContext,
  reportId: number,
  versionId: number,
  reviewerId: number,
): Promise<void> {
  const existing = await findOne(context.qr, 'maintenance_report_review', {
    version_id: versionId,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'maintenance_report_review', {
    report_id: reportId,
    version_id: versionId,
    decision: 'APPROVE',
    comment: `${MOCK_LABEL} 审核通过样例`,
    reviewed_by_account_id: reviewerId,
    reviewed_at: new Date('2026-11-07T04:00:00.000Z'),
  });
  context.report.inserted();
}

async function ensureWorkOrderReportDetails(context: PackContext, reportId: number): Promise<void> {
  const stepExisting = await findOne(context.qr, 'maintenance_report_step', {
    report_id: reportId,
    step_no: 1,
  });
  if (!stepExisting) {
    await insertRow(context.qr, 'maintenance_report_step', {
      report_id: reportId,
      step_no: 1,
      step_code: 'MOCK-V13-STEP-1',
      phase_code: 'PHASE_02',
      part_name: '掩模台通信链路',
      action_text: '更换通信线缆并重新压接接地端。',
      result_code: 'RESOLVED',
      error_code: null,
      result_text: '复测通过。',
      new_alarm_code: null,
      is_valid_new_branch: 0,
      created_at: FIXED_REPORT_AT,
      updated_at: FIXED_REPORT_AT,
    });
    context.report.inserted();
  } else {
    context.report.reused();
  }

  const faultUuid = mockUuid('report:fault:formal-b');
  const faultExisting = await findOne(context.qr, 'maintenance_report_fault', {
    fault_uuid: faultUuid,
  });
  if (!faultExisting) {
    await insertRow(context.qr, 'maintenance_report_fault', {
      report_id: reportId,
      fault_uuid: faultUuid,
      branch_kind: 'INITIAL_PANEL',
      step_code: null,
      panel_snapshot: null,
      fault_description: '掩模台通信偶发中断。',
      fault_cause: '通信线缆接触不良。',
      handling_action: '更换通信线缆。',
      main_error: null,
      unit_error: null,
      error_type: null,
      gpib_status: null,
      status: 'RESOLVED',
      source: 'USER',
      phase_code: 'PHASE_02',
      is_active: 1,
      lifecycle_status: 'RESOLVED',
      lifecycle_source: 'USER',
      created_at: FIXED_REPORT_AT,
    });
    context.report.inserted();
  } else {
    context.report.reused();
  }

  const alarmExisting = await findOne(context.qr, 'maintenance_report_alarm', {
    report_id: reportId,
    alarm_index: 1,
  });
  if (!alarmExisting) {
    await insertRow(context.qr, 'maintenance_report_alarm', {
      report_id: reportId,
      alarm_index: 1,
      alarm_code: 'E-2210',
      alarm_description: '掩模台通信中断报警。',
      phase_code: 'PHASE_02',
      reset_result: 'RESET_OK',
    });
    context.report.inserted();
  } else {
    context.report.reused();
  }
}

async function ensureDraftAttachment(
  context: PackContext,
  drafts: readonly number[],
): Promise<void> {
  const draftB = drafts[1];
  if (!draftB) return;
  const content = mockPng();
  const relativePath = path.join('report-attachments', 'draft-b.png');
  const state = context.files.ensure(path.join(context.mockFileDir, relativePath), content);
  if (state === 'REUSED') {
    context.report.note(`附件文件已存在且校验一致: ${relativePath}`);
  }
  const existing = await findOne(context.qr, 'maintenance_report_attachment', {
    report_id: draftB,
    sort_order: 1,
  });
  if (existing) {
    if (String(existing.checksum_sha256) !== sha256Hex(content)) {
      throw new MockConflictError('报告附件已存在但校验和不一致，拒绝覆盖');
    }
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'maintenance_report_attachment', {
    report_id: draftB,
    original_filename: 'mock-v13-draft-b.png',
    mime_type: 'image/png',
    byte_size: content.length,
    checksum_sha256: sha256Hex(content),
    storage_backend: 'LOCAL',
    storage_reference: relativePath,
    sort_order: 1,
    description: `${MOCK_LABEL} 报告原件样例（有附件报告）`,
    status: 'CURRENT',
    uploaded_by_account_id: await requireAccountId(context, 'engineer-b'),
    retired_at: null,
    created_at: FIXED_REPORT_AT,
    updated_at: FIXED_REPORT_AT,
  });
  context.report.inserted();
  context.report.scenario({
    kind: 'file',
    key: 'report-attachment:draft-b',
    id: relativePath,
    detail: '维修报告原件样例',
  });
}

export async function runDocumentsPack(context: PackContext): Promise<void> {
  const reports = await requireReportIds(context);
  const ids = await resolveOrganizationIds(context);
  const models = await resolveModels(context);
  if (models.length < 2) {
    throw new MockConflictError('启用机型不足 2 个，请先运行 p0-equipment');
  }
  const engineerA = await requireAccountId(context, 'engineer-a');
  const engineerB = await requireAccountId(context, 'engineer-b');

  const reference = `${sha256Hex('mock-v13:reference-document:a').slice(0, 32)}.txt`;
  const referenceContent = mockTextDocument(
    DOCUMENT_TITLES.materialA,
    '对准漂移处置步骤：1. 检查工件台基准；2. 重做对准标定；3. 复测 3 个批次。',
  );
  const storageState = context.files.ensure(
    path.join(context.referenceStorageDir, reference),
    referenceContent,
  );
  if (storageState === 'REUSED') {
    context.report.note(`参考资料文件已存在且校验一致: ${reference}`);
  }

  const materialA = await ensureDocument(context, {
    title: DOCUMENT_TITLES.materialA,
    documentType: '维修手册',
    organizationId: ids.A,
    createdBy: engineerA,
    modelId: models[0].id,
    sourceKind: 'MATERIAL',
    sourceReportId: null,
    sourceReportVersionId: null,
    publicationStatus: 'ONLINE',
    contentText: referenceContent.toString('utf8'),
    storageBackend: 'LOCAL',
    storageReference: reference,
    originalFilename: 'mock-v13-reference-a.txt',
    mimeType: 'text/plain',
    currentRevisionNo: 1,
    key: 'material-a',
  });
  await ensureDocumentRevision(context, materialA, engineerA);

  const offlineDocument = await ensureDocument(context, {
    title: DOCUMENT_TITLES.materialOffline,
    documentType: '维修手册（旧版）',
    organizationId: ids.A,
    createdBy: engineerA,
    modelId: models[0].id,
    sourceKind: 'MATERIAL',
    sourceReportId: null,
    sourceReportVersionId: null,
    publicationStatus: 'OFFLINE',
    contentText: '旧版内容：仅用于下架状态对照。',
    storageBackend: null,
    storageReference: null,
    originalFilename: null,
    mimeType: null,
    currentRevisionNo: 0,
    key: 'material-offline',
  });

  const reportDocA = await ensureDocument(context, {
    title: DOCUMENT_TITLES.reportA,
    documentType: '维修报告摘录',
    organizationId: ids.A,
    createdBy: engineerA,
    modelId: models[0].id,
    sourceKind: 'INDEPENDENT_REPORT',
    sourceReportId: reports.formalA,
    sourceReportVersionId: reports.versionA,
    publicationStatus: 'ONLINE',
    contentText: `${MOCK_LABEL} 由独立正式报告冻结版本生成的资料样例。`,
    storageBackend: null,
    storageReference: null,
    originalFilename: null,
    mimeType: null,
    currentRevisionNo: 0,
    key: 'report-a',
  });

  const reportDocB = await ensureDocument(context, {
    title: DOCUMENT_TITLES.reportB,
    documentType: '工单总结摘录',
    organizationId: ids.B,
    createdBy: engineerB,
    modelId: models[1].id,
    sourceKind: 'WORK_ORDER_SUMMARY',
    sourceReportId: reports.formalB,
    sourceReportVersionId: reports.versionB,
    publicationStatus: 'ONLINE',
    contentText: `${MOCK_LABEL} 由有资格工单总结的正式报告版本生成的资料样例。`,
    storageBackend: null,
    storageReference: null,
    originalFilename: null,
    mimeType: null,
    currentRevisionNo: 0,
    key: 'report-b',
  });

  await ensureAuditEvent(context, {
    key: 'audit-delete-offline',
    actorId: await requireAccountId(context, 'admin-l1-a'),
    actorLevel: 1,
    organizationId: ids.A,
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetId: String(offlineDocument),
    detail: `${MOCK_LABEL} 下架对照样例留痕`,
  });
  await ensureAuditEvent(context, {
    key: 'audit-correct-ownership',
    actorId: await requireAccountId(context, 'admin-l2-a'),
    actorLevel: 2,
    organizationId: ids.A,
    operation: 'CORRECT_DOCUMENT_OWNERSHIP',
    targetId: String(reportDocA),
    detail: `${MOCK_LABEL} 归属纠正留痕`,
  });
  context.report.scenario({
    kind: 'document',
    key: DOCUMENT_TITLES.reportB,
    id: reportDocB,
    detail: 'B 公司可读正式资料（追到工单总结版本）',
  });
}

interface DocumentInput {
  title: string;
  documentType: string;
  organizationId: number;
  createdBy: number;
  modelId: number;
  sourceKind: 'MATERIAL' | 'INDEPENDENT_REPORT' | 'WORK_ORDER_SUMMARY';
  sourceReportId: number | null;
  sourceReportVersionId: number | null;
  publicationStatus: 'ONLINE' | 'OFFLINE';
  contentText: string;
  storageBackend: 'LOCAL' | null;
  storageReference: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  currentRevisionNo: number;
  key: string;
}

async function ensureDocument(context: PackContext, input: DocumentInput): Promise<number> {
  // 有来源版本时按 uk_reference_document_source_report_version 查重，避免撞唯一索引；
  // 无来源版本（手工资料）时该列均为 NULL，唯一索引不生效，改用标题查重。
  const existing =
    input.sourceReportVersionId !== null
      ? await findOne(context.qr, 'reference_document', {
          source_report_version_id: input.sourceReportVersionId,
        })
      : await findOne(context.qr, 'reference_document', { title: input.title });
  if (existing) {
    if (
      Number(existing.owner_organization_id) !== input.organizationId ||
      String(existing.source_kind) !== input.sourceKind ||
      !asText(existing.title).startsWith(MOCK_LABEL)
    ) {
      throw new MockConflictError(`资料 ${input.title} 已存在但归属或来源不同，拒绝改写`);
    }
    context.report.reused();
    context.report.scenario({
      kind: 'document',
      key: input.title,
      id: readNumber(existing, 'id'),
      detail: `${input.sourceKind} / ${input.publicationStatus}`,
    });
    return readNumber(existing, 'id');
  }
  const documentId = await insertRow(context.qr, 'reference_document', {
    title: input.title,
    document_type: input.documentType,
    equipment_model_id: input.modelId,
    description: `${MOCK_LABEL} 开发测试资料`,
    original_filename: input.originalFilename,
    mime_type: input.mimeType,
    content_text: input.contentText,
    storage_backend: input.storageBackend,
    storage_reference: input.storageReference,
    created_by_account_id: input.createdBy,
    owner_organization_id: input.organizationId,
    publication_status: input.publicationStatus,
    ownership_status: 'CONFIRMED',
    current_revision_no: input.currentRevisionNo,
    source_kind: input.sourceKind,
    source_report_id: input.sourceReportId,
    source_report_version_id: input.sourceReportVersionId,
    ingest_method: 'ADMIN_DIRECT',
    source_submission_id: null,
    source_revision_id: null,
    equipment_model_text: null,
    updated_by_account_id: input.createdBy,
    extension_json: JSON.stringify({ mock_v13: true, key: input.key }),
    schema_version: 1,
    deprecated: 0,
    deleted_at: null,
    created_at: FIXED_BUSINESS_AT,
    updated_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
  context.report.scenario({
    kind: 'document',
    key: input.title,
    id: documentId,
    detail: `${input.sourceKind} / ${input.publicationStatus}`,
  });
  return documentId;
}

async function ensureDocumentRevision(
  context: PackContext,
  documentId: number,
  actorId: number,
): Promise<void> {
  const existing = await findOne(context.qr, 'reference_document_revision', {
    document_id: documentId,
    revision_no: 1,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'reference_document_revision', {
    document_id: documentId,
    revision_no: 1,
    before_snapshot: canonicalJson({ schema_version: 1, mock: true, content_text: '初始版本' }),
    after_snapshot: canonicalJson({
      schema_version: 1,
      mock: true,
      content_text: '补充复测步骤后的有效版本',
    }),
    actor_account_id: actorId,
    reason: `${MOCK_LABEL} 修订对照样例`,
    created_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
}

async function ensureAuditEvent(
  context: PackContext,
  input: {
    key: string;
    actorId: number;
    actorLevel: number;
    organizationId: number;
    operation: 'ADMIN_DELETE_DOCUMENT' | 'CORRECT_DOCUMENT_OWNERSHIP';
    targetId: string;
    detail: string;
  },
): Promise<void> {
  const eventId = mockUuid(`audit:${input.key}`);
  const existing = await findOne(context.qr, 'management_audit_event', {
    event_id: eventId,
  });
  if (existing) {
    context.report.reused();
    return;
  }
  await insertRow(context.qr, 'management_audit_event', {
    event_id: eventId,
    actor_account_id: input.actorId,
    actor_admin_level: input.actorLevel,
    organization_id: input.organizationId,
    operation: input.operation,
    target_type: 'REFERENCE_DOCUMENT',
    target_id: input.targetId,
    result: 'SUCCEEDED',
    detail: input.detail,
    created_at: FIXED_BUSINESS_AT,
  });
  context.report.inserted();
}

export async function requireReportIds(context: PackContext): Promise<ReportIds> {
  const formalA = await findOne(context.qr, 'maintenance_report', {
    submission_request_id: 'mock-v13:report:formalA',
  });
  const formalB = await findOne(context.qr, 'maintenance_report', {
    submission_request_id: 'mock-v13:report:formalB',
  });
  if (!formalA || !formalB) {
    throw new MockConflictError('缺少正式报告，请先运行 p0-reports');
  }
  const versionA = await findOne(context.qr, 'maintenance_report_version', {
    report_id: readNumber(formalA, 'id'),
    version_no: 1,
  });
  const versionB = await findOne(context.qr, 'maintenance_report_version', {
    report_id: readNumber(formalB, 'id'),
    version_no: 1,
  });
  if (!versionA || !versionB) {
    throw new MockConflictError('缺少正式报告冻结版本，请先运行 p0-reports');
  }
  const drafts = await findMany(
    context.qr,
    'maintenance_report',
    { source_type: 'HISTORICAL_CASE', status: 'DRAFT' },
    'id ASC',
    5,
  );
  return {
    drafts: drafts.map((row) => readNumber(row, 'id')),
    formalA: readNumber(formalA, 'id'),
    formalB: readNumber(formalB, 'id'),
    versionA: readNumber(versionA, 'id'),
    versionB: readNumber(versionB, 'id'),
  };
}
