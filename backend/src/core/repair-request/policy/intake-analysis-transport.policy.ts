// src/core/repair-request/policy/intake-analysis-transport.policy.ts
// 首次 AI 分析的传输文本构造与截断策略（任务 03 第二段）。
//
// 约束来源：
// - `repair_request_intake.fault_description` 数据库原稿上限 5000 字符；
// - RAG 公共契约 `question` ≤ 2000 UTF-16 码元、`fault` 单字段 ≤ 4000 码元；
// - 不得截断或修改数据库原稿：截断只发生在发送给模型的传输副本上。
//
// 截断规则（Unicode 安全 + 明确标记）：
// - 按 Unicode 码点迭代（for...of），不允许把代理对拆成两个孤立半码；
// - 预算按 UTF-16 码元计算（与公共契约一致：一个增补平面码点计 2 码元）；
// - 发生截断时在末尾追加显式截断标记，标记本身计入预算；
// - 数据库原稿保持原样，此策略只产出传输副本。

/** 截断标记：明确告知模型正文被传输层截断（计入 UTF-16 预算） */
export const INTAKE_ANALYSIS_TRUNCATION_MARKER = '…[已截断]';

/** 传输文本截断：不超限返回原样副本；超限按码点安全截断并追加显式标记 */
export function truncateTransportText(input: string, maxUnits: number): string {
  if (!Number.isInteger(maxUnits) || maxUnits <= 0) {
    throw new Error('intake_analysis_transport_max_units_invalid');
  }
  if (input.length <= maxUnits) {
    return input;
  }

  const markerUnits = utf16UnitsOf(INTAKE_ANALYSIS_TRUNCATION_MARKER);
  if (markerUnits >= maxUnits) {
    throw new Error('intake_analysis_transport_marker_exceeds_budget');
  }
  const bodyBudget = maxUnits - markerUnits;
  let bodyUnits = 0;
  let body = '';
  // for...of 按 Unicode 码点迭代，天然避免把代理对拆成孤立半码
  for (const codePoint of input) {
    const units = utf16UnitsOf(codePoint);
    if (bodyUnits + units > bodyBudget) {
      break;
    }
    body += codePoint;
    bodyUnits += units;
  }
  return `${body}${INTAKE_ANALYSIS_TRUNCATION_MARKER}`;
}

/** 组装诊断 question：机型 + 错误码 + 截断后的故障现象（总长 ≤ questionMaxUnits） */
export function buildIntakeDiagnosisQuestion(params: {
  readonly modelCode: string;
  readonly errorCode: string;
  readonly faultDescription: string;
  readonly questionMaxUnits: number;
}): string {
  const prefix = `设备型号：${params.modelCode}\n错误码：${params.errorCode}\n故障现象：`;
  const prefixUnits = utf16UnitsOf(prefix);
  if (prefixUnits >= params.questionMaxUnits) {
    throw new Error('intake_analysis_transport_question_prefix_exceeds_budget');
  }
  const faultBudget = params.questionMaxUnits - prefixUnits;
  return `${prefix}${truncateTransportText(params.faultDescription, faultBudget)}`;
}

/** 组装 fault.description 传输副本（≤ faultFieldMaxUnits，不改原稿） */
export function buildIntakeDiagnosisFaultDescription(params: {
  readonly faultDescription: string;
  readonly faultFieldMaxUnits: number;
}): string {
  return truncateTransportText(params.faultDescription, params.faultFieldMaxUnits);
}

/**
 * 模型正文收口：只去除首尾空白用于「是否有效正文」判定，不改写正文内部字符。
 * 收口在 core 而非 usecase：usecase 层禁止直接做文本 normalize（统一入口规则）。
 */
export function normalizeIntakeAnalysisOutputText(text: string): string {
  return text.trim();
}

function utf16UnitsOf(value: string): number {
  return value.length;
}
