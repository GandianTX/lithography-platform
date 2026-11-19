// src/infrastructure/ai/conversation/ai-conversation-pdf.renderer.ts
// AI 诊断 PDF 渲染器（任务 05 · S4.2）
//
// 职责：把固定版本的导出快照渲染为 PDF 字节。
// - 固定内容：调用方已选定 contentVersion 与消息截止 seq，渲染器不再取数；
// - 如实标记：未完成/失败轮次按快照 turnState 标注，不美化、不补写模型结论；
// - 中文完整：使用运行时配置的 CJK 字体，缺字体直接失败（不产出空文件）；
// - 无 AI Word 导出：本渲染器只产出 PDF。

import { existsSync } from 'node:fs';

import { DomainError, AI_CONVERSATION_ERROR } from '@core/common/errors/domain-error';

import type {
  AiExportSnapshot,
  AiExportTurnState,
} from '@src/core/ai/ai-conversation-export.policy';

/** 渲染入参 */
export interface AiConversationPdfRenderInput {
  readonly snapshot: AiExportSnapshot;
  /** 中文字体文件路径（运行时配置；不入库） */
  readonly fontPath: string;
}

/** 轮次状态的中文标注（如实标记） */
const TURN_STATE_LABELS: Record<AiExportTurnState, string> = {
  SUCCEEDED: '已保存',
  FAILED: '失败',
  PENDING: '待执行',
  RUNNING: '生成中',
  UNKNOWN: '状态未知',
};

const ROLE_LABELS: Record<string, string> = {
  USER: '工程师提问',
  ASSISTANT: '故障诊断助手',
  SYSTEM: '系统',
  TOOL: '工具',
};

/** 页面与排版常量 */
const PAGE_MARGIN = 56;
const TITLE_SIZE = 18;
const BODY_SIZE = 11;
const LINE_GAP = 4;

/**
 * 渲染 PDF。
 *
 * @returns PDF 字节；字体缺失或渲染异常时抛错（调用方不得返回空文件）
 */
export async function renderAiConversationPdf(
  input: AiConversationPdfRenderInput,
): Promise<Buffer> {
  if (!existsSync(input.fontPath)) {
    throw new DomainError(
      AI_CONVERSATION_ERROR.EXPORT_FAILED,
      'PDF 导出所需中文字体不可用，请联系运维配置',
      { fontPath: input.fontPath },
    );
  }

  // 动态加载 pdfkit：仅导出路径需要，避免常驻内存占用
  const pdfkitModule = await import('pdfkit');
  const pdfkitDocument = pdfkitModule.default;

  const chunks: Buffer[] = [];
  const document = new pdfkitDocument({
    autoFirstPage: true,
    bufferPages: true,
    margins: {
      bottom: PAGE_MARGIN,
      left: PAGE_MARGIN,
      right: PAGE_MARGIN,
      top: PAGE_MARGIN,
    },
    size: 'A4',
  });
  document.registerFont('cjk', input.fontPath);
  document.font('cjk');

  const done = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', (error: Error) =>
      reject(
        new DomainError(AI_CONVERSATION_ERROR.EXPORT_FAILED, 'PDF 生成失败，请稍后重试', {}, error),
      ),
    );
  });

  writeHeader(document, input.snapshot);
  writeMeta(document, input.snapshot);
  writeMessages(document, input.snapshot);

  document.end();
  const buffer = await done;
  if (buffer.length === 0) {
    throw new DomainError(AI_CONVERSATION_ERROR.EXPORT_FAILED, 'PDF 生成失败，请稍后重试');
  }
  return buffer;
}

function writeHeader(document: PDFKit.PDFDocument, snapshot: AiExportSnapshot): void {
  document.fontSize(TITLE_SIZE).text('AI 诊断记录');
  document.moveDown(0.5);
  document
    .fontSize(BODY_SIZE)
    .fillColor('#444444')
    .text(
      `会话 #${snapshot.conversationId} · 内容版本 v${snapshot.contentVersion} · 消息截止序号 ${snapshot.lastMessageSeq}`,
    );
  document.moveDown(0.8);
  document.fillColor('#000000');
}

function writeMeta(document: PDFKit.PDFDocument, snapshot: AiExportSnapshot): void {
  const rows: Array<[string, string]> = [
    ['关联申请', snapshot.requestNo ?? '独立会话'],
    ['申请人', snapshot.engineerNickname],
    ['会话创建时间', snapshot.createdAt],
  ];
  for (const [label, value] of rows) {
    document.fontSize(BODY_SIZE).fillColor('#444444').text(`${label}：${value}`);
  }
  document.moveDown(0.8);
  document.fillColor('#000000');
}

function writeMessages(document: PDFKit.PDFDocument, snapshot: AiExportSnapshot): void {
  if (snapshot.messages.length === 0) {
    document.fontSize(BODY_SIZE).fillColor('#666666').text('该版本范围内没有已保存的消息。');
    document.fillColor('#000000');
    return;
  }
  for (const message of snapshot.messages) {
    const roleLabel = ROLE_LABELS[message.role] ?? message.role;
    const turnLabel = message.turnNo === null ? '' : ` · 第 ${message.turnNo} 轮`;
    const stateLabel = TURN_STATE_LABELS[message.turnState];
    document
      .fontSize(BODY_SIZE)
      .fillColor('#1f4e79')
      .text(`【${roleLabel}${turnLabel}】 ${stateLabel}`);
    document.moveDown(0.2);
    document.fillColor('#000000').fontSize(BODY_SIZE).text(message.text, { align: 'left' });
    document.moveDown(0.2);
    document
      .fontSize(8)
      .fillColor('#888888')
      .text(
        `消息 #${message.messageId} · 序号 ${message.messageSeq} · 版本 v${message.contentVersion} · ${message.createdAt}`,
      );
    document.moveDown(LINE_GAP / 2 + 0.6);
    document.fillColor('#000000');
  }
}
