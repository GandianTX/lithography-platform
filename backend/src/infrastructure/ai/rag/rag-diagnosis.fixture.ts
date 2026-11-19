// src/infrastructure/ai/rag/rag-diagnosis.fixture.ts
// RAG 公共诊断客户端的三组脱敏合成样例（RAG-A01／A05 交付物）。
//
// 来源与口径：
// - 01：共享归档「任务05-09-10-开工准备-20261118/需求基准」02-模型API请求样例.json
//       与 03-模型API回复样例.json（V44 归档），代表首析：空历史；
//       03 首析是否最终使用 WORK_ORDER 待 Q08，暂按 V44 样例的 INDEPENDENT。
// - 02：同目录 04-模型API请求样例.json 与 04-模型API回复样例.json，
//       代表独立对话；requestId 改为独立 UUID，避免三组替身互相覆盖。
// - 03：合成数据（非真实服务返回），代表工单对话带历史与故障字段；
//       机型编码、故障码与正文均为脱敏虚构值，不得当作真实业务数据。
//
// 本文件只提供固定输入/期望输出与期望线上信封，不发起任何 I/O。

import {
  RAG_DIAGNOSIS_SCENE_ID,
  RAG_DIAGNOSIS_SCHEMA_VERSION,
  type RagDiagnosisContextMode,
  type RagDiagnosisHistoryItem,
  type RagDiagnosisInput,
  type RagDiagnosisSuccess,
} from '@usecases/common/ports/rag-diagnosis-client.contract';

export type RagDiagnosisFixtureScenario =
  'FIRST_ANALYSIS_EMPTY_HISTORY' | 'INDEPENDENT_CHAT' | 'WORK_ORDER_WITH_HISTORY';

/** 线上请求信封：fault 给齐八字段，未知值填 null，保留字符串 "0" */
export type RagDiagnosisFixtureWireFault = Readonly<{
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  description: string | null;
  action: string | null;
  status: string | null;
}>;

export type RagDiagnosisFixtureRequestEnvelope = Readonly<{
  schemaVersion: typeof RAG_DIAGNOSIS_SCHEMA_VERSION;
  requestId: string;
  sceneId: typeof RAG_DIAGNOSIS_SCENE_ID;
  question: string;
  history: readonly RagDiagnosisHistoryItem[];
  context: Readonly<{
    mode: RagDiagnosisContextMode;
    equipmentModelCode: string | null;
    stage: number | null;
    fault: RagDiagnosisFixtureWireFault | null;
  }>;
}>;

export type RagDiagnosisFixture = Readonly<{
  scenario: RagDiagnosisFixtureScenario;
  title: string;
  /** 数据来源与暂定口径说明 */
  source: string;
  input: RagDiagnosisInput;
  expectedRequestEnvelope: RagDiagnosisFixtureRequestEnvelope;
  expectedResult: RagDiagnosisSuccess;
}>;

/** 01 首析：空历史（来源：V44 02/03 样例） */
const firstAnalysisEmptyHistory: RagDiagnosisFixture = {
  scenario: 'FIRST_ANALYSIS_EMPTY_HISTORY',
  title: '首析 · 空历史',
  source: 'V44 归档 02-模型API请求样例.json + 03-模型API回复样例.json（03 首析模式待 Q08）',
  input: {
    requestId: '11111111-1111-4111-8111-111111111111',
    question: '掩模板运送至取板台时，手臂 1 动作中断。应先核对哪些信息？',
    history: [],
    context: {
      mode: 'INDEPENDENT',
      equipmentModelCode: null,
      stage: 2,
      fault: null,
    },
  },
  expectedRequestEnvelope: {
    schemaVersion: RAG_DIAGNOSIS_SCHEMA_VERSION,
    requestId: '11111111-1111-4111-8111-111111111111',
    sceneId: RAG_DIAGNOSIS_SCENE_ID,
    question: '掩模板运送至取板台时，手臂 1 动作中断。应先核对哪些信息？',
    history: [],
    context: {
      mode: 'INDEPENDENT',
      equipmentModelCode: null,
      stage: 2,
      fault: null,
    },
  },
  expectedResult: {
    ok: true,
    requestId: '11111111-1111-4111-8111-111111111111',
    text: '手臂 1 在掩模板运送至取板台阶段值得优先关注。请记录中断前的动作、设备报警原文和能否复现，按现场规程核对手臂与取板台的状态。图中橙色为建议关注位置。',
    visualization: {
      sceneId: RAG_DIAGNOSIS_SCENE_ID,
      stage: 2,
      parts: [
        { partId: 'controller', display: 'NORMAL' },
        { partId: 'reticle_cassette', display: 'NORMAL' },
        { partId: 'reticle_arm', display: 'WARNING' },
        { partId: 'reticle_table', display: 'HIGHLIGHT' },
        { partId: 'reticle_vacuum', display: 'NORMAL' },
        { partId: 'positioning_laser', display: 'NORMAL' },
        { partId: 'wafer_cassette', display: 'NORMAL' },
        { partId: 'wafer_arm', display: 'NORMAL' },
        { partId: 'alignment_table', display: 'NORMAL' },
        { partId: 'wafer_stage', display: 'NORMAL' },
        { partId: 'projection_lens', display: 'NORMAL' },
      ],
    },
  },
};

/** 02 独立对话：空历史（来源：V44 04 请求/回复样例，requestId 改为独立 UUID） */
const independentChat: RagDiagnosisFixture = {
  scenario: 'INDEPENDENT_CHAT',
  title: '独立对话 · 空历史',
  source: 'V44 归档 04-模型API请求样例.json + 04-模型API回复样例.json',
  input: {
    requestId: '22222222-2222-4222-8222-222222222222',
    question: '晶圆定位台旋转后仍提示中心偏移，应记录哪些复测信息？',
    history: [],
    context: {
      mode: 'INDEPENDENT',
      equipmentModelCode: null,
      stage: 6,
      fault: null,
    },
  },
  expectedRequestEnvelope: {
    schemaVersion: RAG_DIAGNOSIS_SCHEMA_VERSION,
    requestId: '22222222-2222-4222-8222-222222222222',
    sceneId: RAG_DIAGNOSIS_SCENE_ID,
    question: '晶圆定位台旋转后仍提示中心偏移，应记录哪些复测信息？',
    history: [],
    context: {
      mode: 'INDEPENDENT',
      equipmentModelCode: null,
      stage: 6,
      fault: null,
    },
  },
  expectedResult: {
    ok: true,
    requestId: '22222222-2222-4222-8222-222222222222',
    text: '请记录旋转定位前后的中心偏差、报警原文和重复定位的结果。橙色标记为建议关注的定位台，现场工程师仍需按规程核实。',
    visualization: {
      sceneId: RAG_DIAGNOSIS_SCENE_ID,
      stage: 6,
      parts: [
        { partId: 'controller', display: 'NORMAL' },
        { partId: 'reticle_cassette', display: 'NORMAL' },
        { partId: 'reticle_arm', display: 'NORMAL' },
        { partId: 'reticle_table', display: 'NORMAL' },
        { partId: 'reticle_vacuum', display: 'NORMAL' },
        { partId: 'positioning_laser', display: 'NORMAL' },
        { partId: 'wafer_cassette', display: 'NORMAL' },
        { partId: 'wafer_arm', display: 'HIGHLIGHT' },
        { partId: 'alignment_table', display: 'WARNING' },
        { partId: 'wafer_stage', display: 'NORMAL' },
        { partId: 'projection_lens', display: 'NORMAL' },
      ],
    },
  },
};

/** 03 工单对话：带历史与故障字段（纯合成，脱敏虚构） */
const workOrderWithHistory: RagDiagnosisFixture = {
  scenario: 'WORK_ORDER_WITH_HISTORY',
  title: '工单对话 · 带历史与故障',
  source: '合成数据（非真实服务）；用于替身装配与故障字段保留字符串 "0" 的验证',
  input: {
    requestId: '33333333-3333-4333-8333-333333333333',
    question: '按上轮建议核对取板台后，手臂仍在中途停住，下一步应检查什么？',
    history: [
      {
        role: 'USER',
        text: '掩模板运送至取板台时，手臂 1 动作中断，已记录报警原文 E1042。',
      },
      {
        role: 'ASSISTANT',
        text: '请先核对取板台真空与手臂位置传感器，再按规程复现一次运送动作。',
      },
    ],
    context: {
      mode: 'WORK_ORDER',
      equipmentModelCode: 'SYNTH-FIXTURE-MODEL',
      stage: 3,
      fault: {
        mainError: 'E1042',
        unitError: null,
        source: 'SYNTHETIC_FIXTURE',
        errorType: null,
        gpibStatus: '0',
        description: '手臂 1 运送掩模板中途停住',
        action: null,
        status: 'OPEN',
      },
    },
  },
  expectedRequestEnvelope: {
    schemaVersion: RAG_DIAGNOSIS_SCHEMA_VERSION,
    requestId: '33333333-3333-4333-8333-333333333333',
    sceneId: RAG_DIAGNOSIS_SCENE_ID,
    question: '按上轮建议核对取板台后，手臂仍在中途停住，下一步应检查什么？',
    history: [
      {
        role: 'USER',
        text: '掩模板运送至取板台时，手臂 1 动作中断，已记录报警原文 E1042。',
      },
      {
        role: 'ASSISTANT',
        text: '请先核对取板台真空与手臂位置传感器，再按规程复现一次运送动作。',
      },
    ],
    context: {
      mode: 'WORK_ORDER',
      equipmentModelCode: 'SYNTH-FIXTURE-MODEL',
      stage: 3,
      fault: {
        mainError: 'E1042',
        unitError: null,
        source: 'SYNTHETIC_FIXTURE',
        errorType: null,
        gpibStatus: '0',
        description: '手臂 1 运送掩模板中途停住',
        action: null,
        status: 'OPEN',
      },
    },
  },
  expectedResult: {
    ok: true,
    requestId: '33333333-3333-4333-8333-333333333333',
    text: '复核取板台真空与手臂位置传感器后，若中断仍可复现，请按现场规程记录真空读数、传感器状态与手臂停止位置，并保留报警原文。图中橙色为建议优先核对的位置。',
    visualization: {
      sceneId: RAG_DIAGNOSIS_SCENE_ID,
      stage: 3,
      parts: [
        { partId: 'controller', display: 'NORMAL' },
        { partId: 'reticle_cassette', display: 'NORMAL' },
        { partId: 'reticle_arm', display: 'WARNING' },
        { partId: 'reticle_table', display: 'NORMAL' },
        { partId: 'reticle_vacuum', display: 'HIGHLIGHT' },
        { partId: 'positioning_laser', display: 'NORMAL' },
        { partId: 'wafer_cassette', display: 'NORMAL' },
        { partId: 'wafer_arm', display: 'NORMAL' },
        { partId: 'alignment_table', display: 'NORMAL' },
        { partId: 'wafer_stage', display: 'NORMAL' },
        { partId: 'projection_lens', display: 'NORMAL' },
      ],
    },
  },
};

/** 三组固定样例：首析空历史、独立对话、工单对话带历史 */
export const RAG_DIAGNOSIS_FIXTURES: readonly RagDiagnosisFixture[] = [
  firstAnalysisEmptyHistory,
  independentChat,
  workOrderWithHistory,
];

/** 按场景取样例；未登记场景返回 null */
export function findRagDiagnosisFixture(
  scenario: RagDiagnosisFixtureScenario,
): RagDiagnosisFixture | null {
  return RAG_DIAGNOSIS_FIXTURES.find((fixture) => fixture.scenario === scenario) ?? null;
}
