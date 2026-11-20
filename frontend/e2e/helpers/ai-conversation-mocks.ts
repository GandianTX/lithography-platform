// e2e/helpers/ai-conversation-mocks.ts
// 任务05：AI 对话工作区的 GraphQL mock 夹具（共享单一真源）
//
// 说明：任务05 的工作区用例与 V44 展示层验收用例共用同一套 GraphQL 拦截桩，
// 避免出现平行实现导致「同一夹具两种行为」而无法对账。
// 覆盖 operation：MyAiConversations / MyAiConversation / CreateAiConversation /
// EngineerRepairRequests / SubmitAiQuestion / RetryAiQuestion / AiQuestionStatus /
// ExportAiConversation。

import type { Page, Route } from '@playwright/test';

export const PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
];

export function buildParts(display: string, overrides: Record<string, string> = {}) {
  return PART_IDS.map((partId) => ({ partId, display: overrides[partId] ?? display }));
}

export type MockState = {
  conversationId: number;
  turns: Array<{
    questionUuid: string;
    turnNo: number;
    question: { id: number; text: string; role: string; contentVersion: number } | null;
    answer: { id: number; text: string; role: string; contentVersion: number } | null;
    analysisStatus: string | null;
    failureReason: string | null;
    analysisContentVersion: number | null;
    completedAt: string | null;
  }>;
  requestId: number | null;
  submitCount: number;
  retryCount: number;
  /** 状态查询返回序列：按轮次取用 */
  statusQueue: Array<{
    /** 绑定到指定轮次（turnNo）；缺省表示按查询顺序消费一次 */
    turnNo?: number;
    /** 持续返回该状态（不消费），用于「该轮始终未完成」场景 */
    sticky?: boolean;
    status: string;
    visualization: unknown;
    failureReason?: string | null;
  }>;
};

export function createMockState(): MockState {
  return {
    conversationId: 501,
    turns: [],
    requestId: null,
    submitCount: 0,
    retryCount: 0,
    statusQueue: [],
  };
}

export function buildConversationDto(state: MockState) {
  return {
    id: state.conversationId,
    requestId: state.requestId,
    requestNo: state.requestId === null ? '' : `RR20261119000000AC${state.requestId}`,
    status: 'ACTIVE',
    contentVersion: state.turns.length + 1,
    createdAt: '2026-11-19T08:00:00.000Z',
    completedAt: null,
    messages: state.turns.flatMap((turn) =>
      [turn.question, turn.answer].filter((message) => message !== null),
    ),
    turns: state.turns,
  };
}

export async function installGraphQLMock(
  page: Page,
  state: MockState,
  options: { createDelayMs?: number; submitHoldMs?: number } = {},
) {
  await page.route('**/graphql', async (route: Route) => {
    const payload = route.request().postDataJSON() as {
      operationName?: string;
      variables?: Record<string, unknown>;
    };
    const operation = payload.operationName ?? '';
    const variables = payload.variables ?? {};

    if (operation === 'MyAiConversations') {
      return route.fulfill({
        body: JSON.stringify({
          data: {
            myAiConversations: {
              items: [
                {
                  id: state.conversationId,
                  requestId: state.requestId,
                  requestNo: state.requestId === null ? '' : `RR20261119000000AC${state.requestId}`,
                  status: 'ACTIVE',
                  contentVersion: state.turns.length + 1,
                  messageCount: state.turns.length * 2,
                  turnCount: state.turns.length,
                  createdAt: '2026-11-19T08:00:00.000Z',
                },
              ],
              total: 1,
              page: 1,
              pageSize: 20,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'MyAiConversation') {
      return route.fulfill({
        body: JSON.stringify({ data: { myAiConversation: buildConversationDto(state) } }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'ExportAiConversation') {
      // 导出固定内容版本：返回一份最小 PDF 字节（Base64）
      const input = variables.input as { conversationId: number; contentVersion: number };
      return route.fulfill({
        body: JSON.stringify({
          data: {
            exportAiConversation: {
              format: 'PDF',
              filename: `ai-conversation-${input.conversationId}-v${input.contentVersion}.pdf`,
              mimeType: 'application/pdf',
              contentVersion: input.contentVersion,
              lastMessageSeq: state.turns.length * 2,
              byteSize: 8,
              contentBase64: Buffer.from('%PDF-mock').toString('base64'),
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'CreateAiConversation') {
      const input = variables.input as { requestId?: number | null };
      if (options.createDelayMs !== undefined) {
        // U05：可控延迟创建，供「创建期间锁定」用例观察中间态
        await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));
      }
      state.requestId = input.requestId ?? null;
      state.turns = [];
      return route.fulfill({
        body: JSON.stringify({
          data: {
            createAiConversation: {
              id: state.conversationId,
              requestId: state.requestId,
              requestNo: state.requestId === null ? '' : `RR20261119000000AC${state.requestId}`,
              status: 'ACTIVE',
              contentVersion: 1,
              createdAt: '2026-11-19T08:00:00.000Z',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'EngineerRepairRequests') {
      // S1：关联工单候选来自「本人已接单」列表，选择器只展示业务编号 + 机型
      return route.fulfill({
        body: JSON.stringify({
          data: {
            engineerRepairRequests: {
              items: [
                {
                  id: 8801,
                  requestNo: 'MR-20261120-001',
                  equipmentModel: { id: 31, modelCode: 'NSR-S635E', modelName: 'NIKON NSR-S635E' },
                  errorCode: 'VACUUM_LOW',
                  createdAt: '2026-11-19T02:00:00.000Z',
                  isAccepted: true,
                  acceptedAt: '2026-11-19T03:00:00.000Z',
                  latestResolutionStatus: 'PROCESSING',
                  customerNickname: '开发客户A1',
                  operationText: '取板台真空报警',
                  viewStatus: 'ACCEPTED',
                },
                {
                  id: 8802,
                  requestNo: 'MR-20261120-002',
                  equipmentModel: { id: 32, modelCode: 'NXT:1980Di', modelName: 'ASML NXT:1980Di' },
                  errorCode: 'ALIGN_FAIL',
                  createdAt: '2026-11-18T02:00:00.000Z',
                  isAccepted: true,
                  acceptedAt: '2026-11-18T03:00:00.000Z',
                  latestResolutionStatus: 'PROCESSING',
                  customerNickname: '开发客户B1',
                  operationText: '定位异常',
                  viewStatus: 'ACCEPTED',
                },
              ],
              page: 1,
              pageSize: 50,
              total: 2,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'SubmitAiQuestion') {
      const input = variables.input as {
        questionUuid: string;
        question: string;
        stage?: number | null;
      };
      state.submitCount += 1;
      // P2-1 反例：可控延迟提交响应，供「提交在飞时输入新草稿」观察中间态
      if (options.submitHoldMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.submitHoldMs));
      }
      const turnNo = state.turns.length + 1;
      state.turns.push({
        questionUuid: input.questionUuid,
        turnNo,
        question: {
          id: turnNo * 10,
          text: input.question,
          role: 'USER',
          contentVersion: turnNo,
        },
        answer: null,
        analysisStatus: 'PENDING',
        failureReason: null,
        analysisContentVersion: null,
        completedAt: null,
      });
      return route.fulfill({
        body: JSON.stringify({
          data: {
            submitAiQuestion: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: 'PENDING',
              turnNo,
              messageSeq: turnNo * 10,
              contentVersion: turnNo,
              replayed: false,
              dispatchStatus: 'QUEUED',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'RetryAiQuestion') {
      const input = variables.input as { questionUuid: string };
      state.retryCount += 1;
      const turn = state.turns.find((item) => item.questionUuid === input.questionUuid);
      if (turn !== undefined) {
        turn.analysisStatus = 'PENDING';
        turn.failureReason = null;
      }
      return route.fulfill({
        body: JSON.stringify({
          data: {
            retryAiQuestion: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: 'PENDING',
              turnNo: turn?.turnNo ?? 1,
              messageSeq: 1,
              contentVersion: state.turns.length + 1,
              replayed: false,
              dispatchStatus: 'QUEUED',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    if (operation === 'AiQuestionStatus') {
      const input = variables.input as { questionUuid: string };
      const turn = state.turns.find((item) => item.questionUuid === input.questionUuid);
      const boundIndex = state.statusQueue.findIndex(
        (item) => item.turnNo !== undefined && item.turnNo === turn?.turnNo,
      );
      const freeIndex = state.statusQueue.findIndex((item) => item.turnNo === undefined);
      const pickIndex = boundIndex >= 0 ? boundIndex : freeIndex;
      const picked =
        pickIndex >= 0
          ? (state.statusQueue[pickIndex] as {
              turnNo?: number;
              sticky?: boolean;
              status: string;
              visualization: unknown;
              failureReason?: string | null;
            })
          : null;
      if (picked !== null && picked.sticky !== true) {
        state.statusQueue.splice(pickIndex, 1);
      }
      const next =
        picked !== null
          ? picked
          : {
              status: 'SUCCEEDED',
              visualization: {
                sceneId: 'LITHO_WORKFLOW_V1',
                stage: 2,
                parts: buildParts('NORMAL'),
              },
            };
      if (turn !== undefined && next.status !== 'PENDING' && next.status !== 'RUNNING') {
        turn.analysisStatus = next.status;
        turn.failureReason = next.failureReason ?? null;
        turn.completedAt = '2026-11-19T08:05:00.000Z';
        if (next.status === 'SUCCEEDED') {
          turn.answer = {
            id: turn.turnNo * 10 + 1,
            text: '建议先检查取板台真空吸附与激光定位组件。',
            role: 'ASSISTANT',
            contentVersion: turn.analysisContentVersion ?? turn.turnNo,
          };
        }
      }
      return route.fulfill({
        body: JSON.stringify({
          data: {
            aiQuestionStatus: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: next.status,
              failureReason: next.failureReason ?? null,
              contentVersion: turn?.analysisContentVersion ?? state.turns.length + 1,
              turnNo: turn?.turnNo ?? 1,
              questionText: turn?.question?.text ?? '',
              answer:
                next.status === 'SUCCEEDED'
                  ? {
                      id: (turn?.turnNo ?? 1) * 10 + 1,
                      text: '建议先检查取板台真空吸附与激光定位组件。',
                      role: 'ASSISTANT',
                      contentVersion: turn?.analysisContentVersion ?? 1,
                    }
                  : null,
              visualization: next.visualization,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    }

    return route.fulfill({
      body: JSON.stringify({ errors: [{ message: `unhandled operation: ${operation}` }] }),
      contentType: 'application/json',
      status: 200,
    });
  });
}

/** 从本人已接工单候选里选择一项（下拉选项标题为「工单号 · 机型」） */
export async function pickWorkOrder(page: Page, label: string) {
  await page.getByLabel('关联工单').click();
  // AntD 虚拟列表里的 role=option 是无障碍占位，实际可点的是下拉项
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: label })
    .first()
    .click();
}
