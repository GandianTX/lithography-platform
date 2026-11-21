// e2e/helpers/admin-document-kb-mocks.ts
//
// 管理员文档数据库视觉验收（admin-document-database-visual.spec.ts）专用的
// 仓库内确定性 GraphQL mock（第三轮 Review S1：解除对本地未入库原型文件、
// 真实后端、开发库与 backend/env/.env.development 的硬依赖）。
//
// - 真源约定：数值基准由 frontend/docs/gkj-visual-baseline.md 第 6 节与 spec 常量
//   承载；本文件只负责「让四个 Tab 固定返回最小但完整的数据状态」，不参与样式基准；
// - Playwright route 层按 operationName 精确应答，分页回显请求变量（page/pageSize），
//   未登记的 operation 返回空 data（与 visual-shell.spec 同口径，不伪造业务数据）；
// - 会话不经过登录接口：spec 用 helpers/auth-session-seed 预置 sessionStorage；
//   因此本文件不需要任何账号、Token 或环境文件。

import type { Page } from '@playwright/test';

/** 知识库四 Tab + 统计 + 型号下拉的最小完整 fixture（字段与各 adapter 的 GraphQL 契约逐一对齐）。 */
export const ADMIN_DOCUMENT_KB_FIXTURES = {
  equipmentModels: [
    { id: 47, modelCode: 'LITHO-200', modelName: '光刻机 200 型' },
    { id: 48, modelCode: 'LITHO-300', modelName: '光刻机 300 型' },
  ],
  referenceDocuments: {
    items: [
      {
        id: 501,
        title: 'E-201 故障处理手册',
        documentType: 'ERROR_CODE_MANUAL',
        equipmentModelId: 47,
        equipmentModelName: '光刻机 200 型',
        description: '覆盖 E-201 故障码的标准处理流程与复位步骤。',
        originalFilename: 'e201-manual.pdf',
        creatorNickname: '管理员',
        createdAt: '2026-08-30 15:00:00',
      },
    ],
    total: 1,
  },
  repairRequests: {
    items: [
      {
        id: 901,
        requestNo: 'RR20260901090001A1B2C3',
        customerNickname: '客户甲',
        companyName: '示例精工有限公司',
        equipmentModelId: 47,
        equipmentModelCode: 'LITHO-200',
        equipmentModelName: '光刻机 200 型',
        errorCode: 'E-201',
        isAccepted: true,
        acceptedAt: '2026-09-01 10:00:00',
        acceptedByEngineerNickname: '林工程师',
        latestResolutionStatus: 'RESOLVED',
        createdAt: '2026-09-01 09:00:00',
      },
      {
        id: 902,
        requestNo: 'RR20260902143000D4E5F6',
        customerNickname: '客户乙',
        companyName: null,
        equipmentModelId: 48,
        equipmentModelCode: 'LITHO-300',
        equipmentModelName: '光刻机 300 型',
        errorCode: 'E-305',
        isAccepted: false,
        acceptedAt: null,
        acceptedByEngineerNickname: null,
        latestResolutionStatus: null,
        createdAt: '2026-09-02 14:30:00',
      },
    ],
    total: 2,
  },
  aiConversations: {
    items: [
      {
        contentVersion: 3,
        id: 701,
        requestNo: 'RR20260901090001A1B2C3',
        requestId: 901,
        status: 'COMPLETED',
        engineerNickname: '林工程师',
        messageCount: 12,
        reportCount: 1,
        createdAt: '2026-09-01 09:20:00',
        completedAt: '2026-09-01 09:40:00',
        aiFeedback: null,
      },
    ],
    total: 1,
  },
  aiReports: {
    items: [
      {
        contentVersion: 2,
        id: 801,
        conversationId: 701,
        requestId: 901,
        requestNo: 'RR20260901090001A1B2C3',
        requestMismatch: false,
        reportType: 'TROUBLESHOOTING',
        reportTitle: 'E-201 故障排查报告',
        engineerNickname: '林工程师',
        createdAt: '2026-09-01 09:39:00',
      },
    ],
    total: 1,
  },
  stats: {
    repairRequestTotal: 2,
    referenceDocumentTotal: 1,
    aiConversationTotal: 1,
    aiReportTotal: 1,
  },
  /** 详情页 fixture（id 与列表条目同源：资料 501 / 申请 901），供眉题等逐页验收渲染就绪态。 */
  referenceDocumentDetail: {
    id: 501,
    title: 'E-201 故障处理手册',
    documentType: 'ERROR_CODE_MANUAL',
    equipmentModelId: 47,
    equipmentModelName: '光刻机 200 型',
    description: '覆盖 E-201 故障码的标准处理流程与复位步骤。',
    originalFilename: 'e201-manual.pdf',
    mimeType: 'application/pdf',
    hasFile: true,
    contentText: 'E-201 故障码标准处理流程：先断开高压，再执行复位，最后试运行确认。',
    creatorNickname: '管理员',
    createdAt: '2026-08-30 15:00:00',
    updatedAt: '2026-08-30 15:00:00',
  },
  myRepairRequestDetail: {
    id: 901,
    requestNo: 'RR20260901090001A1B2C3',
    errorCode: 'E-201',
    faultDescription: '设备报 E-201 故障码，无法继续曝光作业。',
    contentMd: '## 故障现象\n\n设备报 E-201 故障码。',
    createdAt: '2026-09-01 09:00:00',
    isAccepted: true,
    acceptedAt: '2026-09-01 10:00:00',
    latestResolutionStatus: 'RESOLVED',
    equipmentModel: { id: 47, modelCode: 'LITHO-200', modelName: '光刻机 200 型' },
    responses: [
      {
        id: 1,
        engineerNickname: '林工程师',
        resolutionStatus: 'RESOLVED',
        responseText: '已按手册完成复位，设备恢复正常。',
        createdAt: '2026-09-01 10:10:00',
      },
    ],
  },
  /**
   * 账号设置页 fixture（眉题用例 /account/settings，role 与会话种子 SUPER_ADMIN 一致）：
   * 空 data 会让 mapper 守卫失败关闭并打控制台错误（dev StrictMode 下 ×2），
   * 登记最小就绪态使页面渲染 ready 且控制台干净；字段与 MyAccountSettingsDto 契约对齐。
   */
  myAccountSettings: {
    companyName: null,
    contactEmail: null,
    loginEmail: 'self@example.com',
    loginName: 'admin',
    nickname: '管理员',
    phone: null,
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
    updatedAt: '2026-09-01T10:00:00.000Z',
  },
} as const;

type GraphQLRequestBody = {
  operationName?: string;
  variables?: {
    pagination?: { page?: number; pageSize?: number };
  };
};

/** 分页响应：items + total 来自 fixture，page/pageSize 回显请求变量（缺省 1/10）。 */
function paginated(
  items: readonly unknown[],
  total: number,
  variables: GraphQLRequestBody['variables'],
) {
  return {
    items: [...items],
    page: variables?.pagination?.page ?? 1,
    pageSize: variables?.pagination?.pageSize ?? 10,
    total,
  };
}

/** operationName → 响应 data。未登记 operation 返回空对象（壳层验收同口径）。 */
function dataByOperation(
  operationName: string | undefined,
  variables: GraphQLRequestBody['variables'],
): Record<string, unknown> {
  switch (operationName) {
    case 'AdminDocumentDatabaseStats':
      return { adminDocumentDatabaseStats: { ...ADMIN_DOCUMENT_KB_FIXTURES.stats } };
    case 'AdminRepairRequests':
      return {
        adminRepairRequests: paginated(
          ADMIN_DOCUMENT_KB_FIXTURES.repairRequests.items,
          ADMIN_DOCUMENT_KB_FIXTURES.repairRequests.total,
          variables,
        ),
      };
    case 'AdminAiConversations':
      return {
        adminAiConversations: paginated(
          ADMIN_DOCUMENT_KB_FIXTURES.aiConversations.items,
          ADMIN_DOCUMENT_KB_FIXTURES.aiConversations.total,
          variables,
        ),
      };
    case 'AdminAiReports':
      return {
        adminAiReports: paginated(
          ADMIN_DOCUMENT_KB_FIXTURES.aiReports.items,
          ADMIN_DOCUMENT_KB_FIXTURES.aiReports.total,
          variables,
        ),
      };
    case 'AdminDocumentDatabaseEquipmentModels':
    case 'EquipmentModels':
      return { equipmentModels: ADMIN_DOCUMENT_KB_FIXTURES.equipmentModels.map((m) => ({ ...m })) };
    case 'ReferenceDocuments':
      return {
        referenceDocuments: paginated(
          ADMIN_DOCUMENT_KB_FIXTURES.referenceDocuments.items,
          ADMIN_DOCUMENT_KB_FIXTURES.referenceDocuments.total,
          variables,
        ),
      };
    case 'ReferenceDocument':
      return { referenceDocument: { ...ADMIN_DOCUMENT_KB_FIXTURES.referenceDocumentDetail } };
    case 'MyRepairRequest':
      return { myRepairRequest: { ...ADMIN_DOCUMENT_KB_FIXTURES.myRepairRequestDetail } };
    case 'AdminUsers':
      return { adminUsers: { items: [], page: 1, pageSize: 20, total: 0 } };
    case 'MyRepairRequests':
      return { myRepairRequests: { items: [], page: 1, pageSize: 10, total: 0 } };
    case 'MyAccountSettings':
      return { myAccountSettings: { ...ADMIN_DOCUMENT_KB_FIXTURES.myAccountSettings } };
    default:
      return {};
  }
}

export type AdminDocumentKbMockOptions = {
  /** 命中的 operation 在网络层 abort（如型号下拉失败告警态），其余照常应答。 */
  abortOperationNames?: readonly string[];
};

/**
 * 为当前 page 安装知识库视觉验收的确定性 GraphQL mock。
 * 必须在首次页面导航前调用；同一 page 只安装一次（重复注册会叠加路由）。
 */
export async function installAdminDocumentKbGraphqlMocks(
  page: Page,
  options: AdminDocumentKbMockOptions = {},
): Promise<void> {
  const abortNames = new Set(options.abortOperationNames ?? []);

  await page.route('**/graphql', async (route) => {
    const requestBody = route.request().postDataJSON() as GraphQLRequestBody | null;
    const operationName = requestBody?.operationName;

    if (operationName !== undefined && abortNames.has(operationName)) {
      await route.abort();
      return;
    }

    await route.fulfill({
      body: JSON.stringify({ data: dataByOperation(operationName, requestBody?.variables) }),
      contentType: 'application/json',
      status: 200,
    });
  });
}
