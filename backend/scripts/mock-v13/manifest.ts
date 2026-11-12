// scripts/mock-v13/manifest.ts

/**
 * V13 Mock 数据的固定清单：组织、账号、工单、报告与资料都以这里为唯一事实来源。
 *
 * 约束：
 * - 所有可读名称带 `[MOCK-V13]` 或 `mock_v13_` 前缀，静态可辨；
 * - 所有稳定 UUID 由键名派生，重跑得到同一值，便于定位与不新增同义行；
 * - 这里不含密码、密钥或令牌。
 */

import { createHash } from 'node:crypto';

export const MOCK_PREFIX = 'MOCK-V13';
export const MOCK_LABEL = '[MOCK-V13]';
export const LOGIN_PREFIX = 'mock_v13_';
export const EMAIL_DOMAIN = '@mock-v13.invalid';
export const MOCK_TAG = 'MOCK-V13';

/** 固定写入时间，保证重跑与验收查询可复现。 */
export const FIXED_ACCOUNT_CREATED_AT = new Date('2026-11-05T01:00:00.000Z');
export const FIXED_BUSINESS_AT = new Date('2026-11-06T02:00:00.000Z');
export const FIXED_REPORT_AT = new Date('2026-11-07T03:00:00.000Z');

export const PACK_IDS = [
  'p0-org-accounts',
  'p0-equipment',
  'p0-repair',
  'p0-reports',
  'p0-documents',
  'p1-ai',
  'p1-local',
  'p1-packages',
  'p1-backup',
] as const;

export type PackId = (typeof PACK_IDS)[number];

/* eslint-disable @typescript-eslint/naming-convention -- 数据包 ID 是命令行稳定标识，固定使用连字符 */
export const PACK_TITLES: Record<PackId, string> = {
  'p0-org-accounts': '组织、账号、工程师申请',
  'p0-equipment': '测试机型',
  'p0-repair': '报修、工单、维修过程与客户回复',
  'p0-reports': '维修报告草稿/正式报告与冻结版本',
  'p0-documents': '参考资料、下载原件与操作留痕',
  'p1-ai': 'AI 历史会话与分析对照',
  'p1-local': '本机安装、公司设置、授权与同步冲突',
  'p1-packages': '记录包合法/损坏样例',
  'p1-backup': '备份与恢复非成功样例',
};
/* eslint-enable @typescript-eslint/naming-convention */

export type OrganizationKey = 'A' | 'B';

export interface OrganizationSpec {
  readonly key: OrganizationKey;
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly kind: 'PEER';
  readonly isManagedCompany: true;
  readonly isServiceProvider: true;
}

export const ORGANIZATIONS: readonly OrganizationSpec[] = [
  {
    key: 'A',
    code: `${MOCK_PREFIX}-A`,
    name: `${MOCK_LABEL} 星港光电（测试 A）`,
    shortName: '星港测试 A',
    kind: 'PEER',
    isManagedCompany: true,
    isServiceProvider: true,
  },
  {
    key: 'B',
    code: `${MOCK_PREFIX}-B`,
    name: `${MOCK_LABEL} 远岚微纳（测试 B）`,
    shortName: '远岚测试 B',
    kind: 'PEER',
    isManagedCompany: true,
    isServiceProvider: true,
  },
];

export type Role = 'SUPER_ADMIN' | 'ENGINEER' | 'CUSTOMER';

export interface AccountSpec {
  /** 稳定键，用于派生 UUID、幂等键与验收索引。 */
  readonly key: string;
  readonly loginName: string;
  readonly nickname: string;
  readonly realName: string;
  readonly role: Role;
  readonly adminLevel: 1 | 2 | null;
  /** 组织成员归属；null 表示刻意不授予任何组织成员关系（待审/拒绝申请）。 */
  readonly organization: 'PLATFORM' | OrganizationKey | null;
  /** 客户资料中的客户公司归属。 */
  readonly profileOrganization: OrganizationKey | null;
  readonly accountStatus: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
  readonly userState: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
  readonly note: string;
}

export const ACCOUNTS: readonly AccountSpec[] = [
  {
    key: 'admin-l1-a',
    loginName: `${LOGIN_PREFIX}admin_l1_a`,
    nickname: '测试一级管理员甲',
    realName: '一级管理员甲（测试）',
    role: 'SUPER_ADMIN',
    adminLevel: 1,
    organization: 'PLATFORM',
    profileOrganization: null,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: '一级管理员，仅按设计拥有全局管理范围',
  },
  {
    key: 'admin-l1-b',
    loginName: `${LOGIN_PREFIX}admin_l1_b`,
    nickname: '测试一级管理员乙',
    realName: '一级管理员乙（测试）',
    role: 'SUPER_ADMIN',
    adminLevel: 1,
    organization: 'PLATFORM',
    profileOrganization: null,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: '一级管理员，用于范围对照',
  },
  {
    key: 'admin-l2-a',
    loginName: `${LOGIN_PREFIX}admin_l2_a`,
    nickname: '星港测试二级管理员',
    realName: '星港二级管理员（测试）',
    role: 'SUPER_ADMIN',
    adminLevel: 2,
    organization: 'A',
    profileOrganization: null,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: '二级管理员，仅管理 A 公司',
  },
  {
    key: 'admin-l2-b',
    loginName: `${LOGIN_PREFIX}admin_l2_b`,
    nickname: '远岚测试二级管理员',
    realName: '远岚二级管理员（测试）',
    role: 'SUPER_ADMIN',
    adminLevel: 2,
    organization: 'B',
    profileOrganization: null,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: '二级管理员，仅管理 B 公司',
  },
  {
    key: 'engineer-a',
    loginName: `${LOGIN_PREFIX}engineer_a`,
    nickname: '星港测试工程师',
    realName: '星港工程师（测试）',
    role: 'ENGINEER',
    adminLevel: null,
    organization: 'A',
    profileOrganization: null,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: 'A 公司已开通工程师',
  },
  {
    key: 'engineer-b',
    loginName: `${LOGIN_PREFIX}engineer_b`,
    nickname: '远岚测试工程师',
    realName: '远岚工程师（测试）',
    role: 'ENGINEER',
    adminLevel: null,
    organization: 'B',
    profileOrganization: null,
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: 'B 公司已开通工程师，用于跨公司拒绝对照',
  },
  {
    key: 'customer-a',
    loginName: `${LOGIN_PREFIX}customer_a`,
    nickname: '星港测试客户甲',
    realName: '星港客户甲（测试）',
    role: 'CUSTOMER',
    adminLevel: null,
    organization: 'A',
    profileOrganization: 'A',
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: 'A 公司客户，只能看本人报修',
  },
  {
    key: 'customer-b',
    loginName: `${LOGIN_PREFIX}customer_b`,
    nickname: '远岚测试客户',
    realName: '远岚客户（测试）',
    role: 'CUSTOMER',
    adminLevel: null,
    organization: 'B',
    profileOrganization: 'B',
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: 'B 公司客户',
  },
  {
    key: 'customer-a2',
    loginName: `${LOGIN_PREFIX}customer_a2`,
    nickname: '星港测试客户乙',
    realName: '星港客户乙（测试）',
    role: 'CUSTOMER',
    adminLevel: null,
    organization: 'A',
    profileOrganization: 'A',
    accountStatus: 'ACTIVE',
    userState: 'ACTIVE',
    note: '同公司另一客户，用于“本人范围”反例，不占 8 个基础名额',
  },
  {
    key: 'pending-engineer',
    loginName: `${LOGIN_PREFIX}pending_engineer`,
    nickname: '待审工程师申请',
    realName: '待审申请人（测试）',
    role: 'ENGINEER',
    adminLevel: null,
    organization: null,
    profileOrganization: null,
    accountStatus: 'PENDING',
    userState: 'PENDING',
    note: '工程师申请待审，与正式注册一致：身份提示 ENGINEER、账号与用户态待审、无成员关系',
  },
  {
    key: 'rejected-engineer',
    loginName: `${LOGIN_PREFIX}rejected_engineer`,
    nickname: '已拒绝工程师申请',
    realName: '已拒绝申请人（测试）',
    role: 'ENGINEER',
    adminLevel: null,
    organization: null,
    profileOrganization: null,
    accountStatus: 'PENDING',
    userState: 'PENDING',
    note: '工程师申请已拒绝，与正式注册一致：身份提示 ENGINEER、账号仍待审、无成员关系与工程师权限',
  },
  {
    key: 'disabled-customer',
    loginName: `${LOGIN_PREFIX}disabled_customer`,
    nickname: '停用客户账号',
    realName: '停用客户（测试）',
    role: 'CUSTOMER',
    adminLevel: null,
    organization: 'A',
    profileOrganization: 'A',
    accountStatus: 'SUSPENDED',
    userState: 'SUSPENDED',
    note: '停用普通账号，成员关系保留但账号不可用',
  },
];

export function mockEmail(loginName: string): string {
  return `${loginName}${EMAIL_DOMAIN}`;
}

/** 由稳定键派生 36 位 UUID；重跑恒定，不依赖随机数。 */
export function mockUuid(key: string): string {
  const bytes = createHash('sha256').update(`${MOCK_PREFIX}:${key}`).digest();
  const hex = bytes.subarray(0, 16).toString('hex').split('');
  // version 5
  hex[12] = '5';
  // variant 10xx
  const variant = Number.parseInt(hex[16], 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join('-');
}

export interface TicketSpec {
  readonly key: string;
  readonly requestNo: string;
  readonly intakeRecordUuid: string;
  readonly customerKey: string;
  readonly serviceOrganization: OrganizationKey;
  readonly modelSlot: 0 | 1;
  readonly createdAt: Date;
  readonly converted: boolean;
  readonly analysisStatus: 'SUCCEEDED' | 'RUNNING' | 'FAILED';
  readonly errorCode: string;
  readonly faultDescription: string;
  readonly acceptedByKey: string | null;
  readonly acceptedAt: Date | null;
  readonly handlingResult:
    | 'FIXED'
    | 'PART_PURCHASED'
    | 'PROVIDE_PLAN_SELF_EXECUTE'
    | 'INTERRUPTED'
    | 'UNREPAIRABLE'
    | null;
  readonly handlingStatus: 'COMPLETED' | 'IN_PROGRESS' | 'UNRESOLVED' | null;
  readonly handlingRecordedAt: Date | null;
  readonly handlingEndedAt: Date | null;
  readonly closureStatus: 'OPEN' | 'CLOSED' | null;
  readonly closedAt: Date | null;
  readonly closureReason: string | null;
  readonly responseText: string | null;
  readonly resolutionStatus: 'PENDING' | 'RESOLVED' | null;
  readonly processOperation: string | null;
  readonly processTestResult: string | null;
  readonly processAt: Date | null;
}

const ticketBase = {
  modelSlot: 0 as const,
  analysisStatus: 'SUCCEEDED' as const,
  converted: true,
};

export const TICKETS: readonly TicketSpec[] = [
  {
    ...ticketBase,
    key: 'a-pending',
    requestNo: `${MOCK_PREFIX}-REQ-A-001`,
    intakeRecordUuid: mockUuid('intake:a-pending'),
    customerKey: 'customer-a',
    serviceOrganization: 'A',
    createdAt: new Date('2026-11-06T01:00:00.000Z'),
    errorCode: 'E-1010',
    faultDescription: '曝光台 X 向定位偏移约 20nm，批次间重复性变差。',
    acceptedByKey: null,
    acceptedAt: null,
    handlingResult: null,
    handlingStatus: null,
    handlingRecordedAt: null,
    handlingEndedAt: null,
    closureStatus: 'OPEN',
    closedAt: null,
    closureReason: null,
    responseText: null,
    resolutionStatus: null,
    processOperation: null,
    processTestResult: null,
    processAt: null,
  },
  {
    ...ticketBase,
    key: 'a-in-progress',
    requestNo: `${MOCK_PREFIX}-REQ-A-002`,
    intakeRecordUuid: mockUuid('intake:a-in-progress'),
    customerKey: 'customer-a',
    serviceOrganization: 'A',
    modelSlot: 1,
    createdAt: new Date('2026-11-06T01:20:00.000Z'),
    errorCode: 'E-2041',
    faultDescription: '扫描台报警后复位失败，等待备件期间保持处理中。',
    acceptedByKey: 'engineer-a',
    acceptedAt: new Date('2026-11-06T01:40:00.000Z'),
    handlingResult: 'INTERRUPTED',
    handlingStatus: 'IN_PROGRESS',
    handlingRecordedAt: new Date('2026-11-06T03:10:00.000Z'),
    handlingEndedAt: null,
    closureStatus: 'OPEN',
    closedAt: null,
    closureReason: '备件在途，客户同意保留工单继续处理。',
    responseText: '已完成初步排查，扫描台复位失败与驱动板有关，备件到货后继续。',
    resolutionStatus: 'PENDING',
    processOperation: '断电后检查扫描台驱动板接插件，记录复位报警日志。',
    processTestResult: '复位仍失败，报警 E-2041 可稳定复现。',
    processAt: new Date('2026-11-06T02:30:00.000Z'),
  },
  {
    ...ticketBase,
    key: 'a-closed-no-summary',
    requestNo: `${MOCK_PREFIX}-REQ-A-003`,
    intakeRecordUuid: mockUuid('intake:a-closed-no-summary'),
    customerKey: 'customer-a2',
    serviceOrganization: 'A',
    modelSlot: 0,
    createdAt: new Date('2026-11-06T01:30:00.000Z'),
    errorCode: 'E-3312',
    faultDescription: '工件台回零异常，重新上电后恢复，需要记录处置结果。',
    acceptedByKey: 'engineer-a',
    acceptedAt: new Date('2026-11-06T01:50:00.000Z'),
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    handlingRecordedAt: new Date('2026-11-06T04:00:00.000Z'),
    handlingEndedAt: new Date('2026-11-06T04:00:00.000Z'),
    closureStatus: 'CLOSED',
    closedAt: new Date('2026-11-06T04:05:00.000Z'),
    closureReason: null,
    responseText: '已重新校准回零传感器并复测通过，工单已结单；本单刻意不写报告总结。',
    resolutionStatus: 'RESOLVED',
    processOperation: '清洁回零传感器并重新执行回零标定。',
    processTestResult: '连续 3 次回零通过，无报警。',
    processAt: new Date('2026-11-06T03:40:00.000Z'),
  },
  {
    ...ticketBase,
    key: 'b-closed-with-report',
    requestNo: `${MOCK_PREFIX}-REQ-B-001`,
    intakeRecordUuid: mockUuid('intake:b-closed-with-report'),
    customerKey: 'customer-b',
    serviceOrganization: 'B',
    modelSlot: 1,
    createdAt: new Date('2026-11-06T01:40:00.000Z'),
    errorCode: 'E-2210',
    faultDescription: '掩模台通信偶发中断，复位后恢复，需形成正式总结。',
    acceptedByKey: 'engineer-b',
    acceptedAt: new Date('2026-11-06T02:00:00.000Z'),
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    handlingRecordedAt: new Date('2026-11-06T05:00:00.000Z'),
    handlingEndedAt: new Date('2026-11-06T05:00:00.000Z'),
    closureStatus: 'CLOSED',
    closedAt: new Date('2026-11-06T05:10:00.000Z'),
    closureReason: null,
    responseText: '更换通信线缆并复测 24 小时无中断，已结单并提交正式报告。',
    resolutionStatus: 'RESOLVED',
    processOperation: '更换掩模台通信线缆，检查接地。',
    processTestResult: '24 小时连续运行无通信中断。',
    processAt: new Date('2026-11-06T04:30:00.000Z'),
  },
  {
    key: 'a-intake-running',
    requestNo: `${MOCK_PREFIX}-INTAKE-A-001`,
    intakeRecordUuid: mockUuid('intake:a-intake-running'),
    customerKey: 'customer-a',
    serviceOrganization: 'A',
    modelSlot: 0,
    createdAt: new Date('2026-11-06T06:00:00.000Z'),
    converted: false,
    analysisStatus: 'RUNNING',
    errorCode: 'E-4100',
    faultDescription: '新报修：光源能量波动，分析任务仍在进行中（未转单）。',
    acceptedByKey: null,
    acceptedAt: null,
    handlingResult: null,
    handlingStatus: null,
    handlingRecordedAt: null,
    handlingEndedAt: null,
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    responseText: null,
    resolutionStatus: null,
    processOperation: null,
    processTestResult: null,
    processAt: null,
  },
  {
    key: 'b-intake-failed',
    requestNo: `${MOCK_PREFIX}-INTAKE-B-001`,
    intakeRecordUuid: mockUuid('intake:b-intake-failed'),
    customerKey: 'customer-b',
    serviceOrganization: 'B',
    modelSlot: 1,
    createdAt: new Date('2026-11-06T06:10:00.000Z'),
    converted: false,
    analysisStatus: 'FAILED',
    errorCode: 'E-4101',
    faultDescription: '新报修：温控异常，分析任务失败（未转单）。',
    acceptedByKey: null,
    acceptedAt: null,
    handlingResult: null,
    handlingStatus: null,
    handlingRecordedAt: null,
    handlingEndedAt: null,
    closureStatus: null,
    closedAt: null,
    closureReason: null,
    responseText: null,
    resolutionStatus: null,
    processOperation: null,
    processTestResult: null,
    processAt: null,
  },
];

export const REPORT_KEYS = {
  draftA: 'report-draft-a',
  draftB: 'report-draft-b',
  formalA: 'report-formal-a',
  formalB: 'report-formal-b',
} as const;

export const REPORT_TITLES = {
  draftA: `${MOCK_LABEL} 星港历史案例草稿（无附件）`,
  draftB: `${MOCK_LABEL} 远岚历史案例草稿（含原件）`,
  formalA: `${MOCK_LABEL} 星港独立正式报告：对准漂移处置`,
  formalB: `${MOCK_LABEL} 远岚工单总结：掩模台通信中断`,
} as const;

export const DOCUMENT_TITLES = {
  materialA: `${MOCK_LABEL} 星港曝光台对准漂移处置手册`,
  materialOffline: `${MOCK_LABEL} 星港旧版对准手册（下架对照）`,
  reportA: `${MOCK_LABEL} 星港独立报告资料：对准漂移处置`,
  reportB: `${MOCK_LABEL} 远岚工单总结资料：掩模台通信中断`,
} as const;

export const AI_QUESTION_UUIDS = {
  conversationAFirst: mockUuid('ai:question:a-1'),
  conversationASecond: mockUuid('ai:question:a-2'),
  conversationBFirst: mockUuid('ai:question:b-1'),
} as const;

export const mockSecondaryKey = (pack: string, key: string): string =>
  `${MOCK_PREFIX}:${pack}:${key}`;
