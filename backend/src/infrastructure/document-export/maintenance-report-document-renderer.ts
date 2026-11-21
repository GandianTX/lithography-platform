// src/infrastructure/document-export/maintenance-report-document-renderer.ts
//
// 维修报告导出渲染实现（DOCX 可编辑 + PDF 中文多页）。
//
// - DOCX：docx 库生成 OOXML，Word 端按字体名解析中文，天然可编辑；
// - PDF：pdfkit 嵌入配置指定的 CJK 字体（TTC/TTF），长文与多步自动分页；
// - 只消费 usecase 传入的文档模型，逐条完整输出，不截断、不丢分支；
// - 不读库、不写库、不访问存储：附件内容由 usecase 预取后放进文档模型。

import * as docx from 'docx';
import { existsSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import PDFDocument from 'pdfkit';
import { MaintenanceReportExportFormat } from '@app-types/models/maintenance-report.types';

import type {
  MaintenanceReportExportAttachmentLine,
  MaintenanceReportExportDocument,
  MaintenanceReportExportRenderResult,
  MaintenanceReportExportRenderer,
} from '@src/usecases/maintenance-report/ports/maintenance-report-export-renderer.contract';

const DOCX_DEFAULT_FONT = 'SimSun';
const DOCX_BODY_SIZE = 21; // half-points ≈ 10.5pt

/** 配置候选条目形状（路径 + TTC 内 face 名），默认值见 config.module.ts documentExport 段 */
type PdfFontCandidate = { path: string; face?: string };

@Injectable()
export class MaintenanceReportDocumentRenderer implements MaintenanceReportExportRenderer {
  constructor(private readonly configService: ConfigService) {}

  async render(
    document: MaintenanceReportExportDocument,
    format: MaintenanceReportExportFormat,
  ): Promise<MaintenanceReportExportRenderResult> {
    if (format === MaintenanceReportExportFormat.DOCX) {
      return {
        content: await this.renderDocx(document),
        mimeType: DOCX_MIME,
        fileExtension: 'docx',
      };
    }
    return { content: await this.renderPdf(document), mimeType: PDF_MIME, fileExtension: 'pdf' };
  }

  private async renderDocx(document: MaintenanceReportExportDocument): Promise<Buffer> {
    const children: docx.Paragraph[] = [
      ...buildDocxHeading(document.title, docx.HeadingLevel.TITLE),
      ...buildDocxMetaSection(document),
      ...buildDocxAlarmSection(document.alarms),
      ...buildDocxStepSection(document.steps),
      ...buildDocxFaultSection(document.faults),
      ...buildDocxResultSection(document),
      ...buildDocxAiSection(document),
      ...buildDocxAttachmentSection(document.attachments),
      ...buildDocxSourceOriginalSection(document),
    ];

    const file = new docx.Document({
      styles: {
        default: {
          document: {
            run: { font: DOCX_DEFAULT_FONT, size: DOCX_BODY_SIZE },
          },
        },
      },
      sections: [{ children }],
    });
    return docx.Packer.toBuffer(file);
  }

  private async renderPdf(document: MaintenanceReportExportDocument): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 56, autoFirstPage: true });
    this.applyPdfFont(doc);
    const chunks: Buffer[] = [];
    const collected = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    doc.fontSize(18).text(document.title, { align: 'center' }).moveDown(0.5).fontSize(11);

    writePdfMetaSection(doc, document);
    writePdfAlarmSection(doc, document.alarms);
    writePdfStepSection(doc, document.steps);
    writePdfFaultSection(doc, document.faults);
    writePdfResultSection(doc, document);
    writePdfAiSection(doc, document);
    writePdfAttachmentSection(doc, document.attachments);
    writePdfSourceOriginalSection(doc, document);

    doc.end();
    return collected;
  }

  /** 显式配置优先；未配置时按配置候选顺序探测第一个存在的系统 CJK 字体 */
  private applyPdfFont(doc: PDFKit.PDFDocument): void {
    const configuredPath = this.configService.get<string>('documentExport.pdfFontPath', '').trim();
    if (configuredPath.length > 0) {
      const configuredFace = this.configService
        .get<string>('documentExport.pdfFontFace', '')
        .trim();
      if (configuredFace.length > 0) {
        doc.font(configuredPath, configuredFace);
      } else {
        doc.font(configuredPath);
      }
      return;
    }
    const candidates = this.configService.get<PdfFontCandidate[]>(
      'documentExport.pdfFontCandidates',
      [],
    );
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate.path)) {
          if (candidate.face !== undefined && candidate.face.length > 0) {
            doc.font(candidate.path, candidate.face);
          } else {
            doc.font(candidate.path);
          }
          return;
        }
      } catch {
        // 单个候选探测失败继续尝试下一个
      }
    }
    throw new Error('未找到可用的 PDF 中文字体（documentExport.pdfFontPath 未配置且候选均缺失）');
  }
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

function line(label: string, value: string | null): string {
  const text = value === null || value.trim().length === 0 ? '—' : value;
  return `${label}：${text}`;
}

// —— DOCX 组装 ————————————————————————————————————————————————

function buildDocxHeading(
  title: string,
  heading: (typeof docx.HeadingLevel)[keyof typeof docx.HeadingLevel],
): docx.Paragraph[] {
  return [new docx.Paragraph({ text: title, heading, alignment: docx.AlignmentType.CENTER })];
}

function buildDocxMetaSection(document: MaintenanceReportExportDocument): docx.Paragraph[] {
  const items: string[] = [
    line('报告来源', document.sourceLabel),
    line('客户厂家', document.customerFactoryName),
    line('设备型号', document.equipmentModelLabel),
    line('维修日期', document.maintenanceDate),
    line('维修人员', document.engineerName),
    line('维修结果', document.handlingResultLabel),
    line('中断/无法修复原因', document.closureReason),
    line('复位结果', document.resetResultLabel),
  ];
  return items.map((text) => new docx.Paragraph({ text, spacing: { after: 60 } }));
}

function buildDocxSectionHeading(text: string): docx.Paragraph {
  return new docx.Paragraph({
    text,
    heading: docx.HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 80 },
  });
}

function buildDocxAlarmSection(
  alarms: MaintenanceReportExportDocument['alarms'],
): docx.Paragraph[] {
  if (alarms.length === 0) return [];
  const paragraphs: docx.Paragraph[] = [buildDocxSectionHeading('故障报警（最多 8 项）')];
  for (const alarm of alarms) {
    paragraphs.push(
      new docx.Paragraph({
        text: `报警${alarm.index}：${alarm.code}（${alarm.phaseCode}，${alarm.resetResult}）${
          alarm.description ?? ''
        }`,
        spacing: { after: 60 },
      }),
    );
  }
  return paragraphs;
}

function buildDocxStepSection(steps: MaintenanceReportExportDocument['steps']): docx.Paragraph[] {
  const paragraphs: docx.Paragraph[] = [buildDocxSectionHeading('排查步骤')];
  for (const step of steps) {
    paragraphs.push(
      new docx.Paragraph({
        text: `步骤${step.no}（${step.phaseCode}）：${step.actionText}`,
        spacing: { after: 40 },
      }),
    );
    if (step.partName !== null) {
      paragraphs.push(new docx.Paragraph({ text: `零件/部位：${step.partName}` }));
    }
    if (step.errorCode !== null) {
      paragraphs.push(new docx.Paragraph({ text: `报错代码：${step.errorCode}` }));
    }
    if (step.resultText !== null) {
      paragraphs.push(new docx.Paragraph({ text: `步骤结果：${step.resultText}` }));
    }
  }
  return paragraphs;
}

function buildDocxFaultSection(
  faults: MaintenanceReportExportDocument['faults'],
): docx.Paragraph[] {
  const paragraphs: docx.Paragraph[] = [buildDocxSectionHeading('当前有效故障分支')];
  for (const fault of faults) {
    paragraphs.push(
      new docx.Paragraph({ text: `【${fault.branchLabel}】`, spacing: { before: 120 } }),
    );
    if (fault.stepNo !== null) {
      paragraphs.push(new docx.Paragraph({ text: line('对应排查步骤', `第 ${fault.stepNo} 步`) }));
    }
    paragraphs.push(new docx.Paragraph({ text: line('阶段', fault.phaseCode) }));
    paragraphs.push(new docx.Paragraph({ text: line('Main Error', fault.mainError) }));
    paragraphs.push(new docx.Paragraph({ text: line('Unit Error', fault.unitError) }));
    paragraphs.push(new docx.Paragraph({ text: line('Source', fault.source) }));
    paragraphs.push(new docx.Paragraph({ text: line('Error Type', fault.errorType) }));
    paragraphs.push(new docx.Paragraph({ text: line('GPIB Status', fault.gpibStatus) }));
    paragraphs.push(new docx.Paragraph({ text: line('Status', fault.faultStatus) }));
    paragraphs.push(new docx.Paragraph({ text: line('故障描述', fault.description) }));
    paragraphs.push(new docx.Paragraph({ text: line('处理动作', fault.action) }));
  }
  return paragraphs;
}

function buildDocxResultSection(document: MaintenanceReportExportDocument): docx.Paragraph[] {
  return [
    buildDocxSectionHeading('总结评价'),
    new docx.Paragraph({ text: line('实际确认原因', document.actualCause) }),
    new docx.Paragraph({ text: line('维修措施', document.repairActions) }),
    new docx.Paragraph({ text: line('复测方法与结果', document.verificationResult) }),
    new docx.Paragraph({ text: line('补充说明', document.supplementaryNote) }),
  ];
}

function buildDocxAiSection(document: MaintenanceReportExportDocument): docx.Paragraph[] {
  const paragraphs: docx.Paragraph[] = [buildDocxSectionHeading('AI 辅助排查评价附录')];
  if (document.ai.status === 'NOT_USED') {
    paragraphs.push(
      new docx.Paragraph({
        text: '不适用：本次报告未使用 AI 辅助排查（真实会话评价依赖任务 05 联调，未接入时不作评价）。',
      }),
    );
    return paragraphs;
  }
  paragraphs.push(new docx.Paragraph({ text: line('评价来源类型', document.ai.sourceType) }));
  paragraphs.push(new docx.Paragraph({ text: line('评价来源标识', document.ai.sourceId) }));
  paragraphs.push(new docx.Paragraph({ text: line('评价内容版本', document.ai.sourceVersion) }));
  paragraphs.push(
    new docx.Paragraph({
      text: line('综合评分', document.ai.score === null ? null : `${document.ai.score} / 5`),
    }),
  );
  paragraphs.push(new docx.Paragraph({ text: line('正确性', document.ai.correctness) }));
  paragraphs.push(
    new docx.Paragraph({
      text: line(
        '帮助度',
        document.ai.helpfulness === null ? null : `${document.ai.helpfulness} / 4`,
      ),
    }),
  );
  paragraphs.push(new docx.Paragraph({ text: line('评价说明', document.ai.note) }));
  return paragraphs;
}

function buildDocxAttachmentSection(
  attachments: MaintenanceReportExportAttachmentLine[],
): docx.Paragraph[] {
  const paragraphs: docx.Paragraph[] = [buildDocxSectionHeading('附件')];
  if (attachments.length === 0) {
    paragraphs.push(new docx.Paragraph({ text: '本报告未选择附件。' }));
    return paragraphs;
  }
  let index = 0;
  for (const attachment of attachments) {
    index += 1;
    paragraphs.push(
      new docx.Paragraph({
        text: `附件${index}：${attachment.filename}（${attachment.mimeType}，${attachment.byteSize} 字节）${
          attachment.description ? `；${attachment.description}` : ''
        }`,
        spacing: { before: 120 },
      }),
    );
    if (attachment.embeddableImage !== null) {
      paragraphs.push(
        new docx.Paragraph({
          children: [
            new docx.ImageRun({
              data: attachment.embeddableImage,
              type: attachment.mimeType.includes('png')
                ? 'png'
                : attachment.mimeType.includes('gif')
                  ? 'gif'
                  : attachment.mimeType.includes('bmp')
                    ? 'bmp'
                    : 'jpg',
              transformation: { width: 480, height: 320 },
            }),
          ],
        }),
      );
    }
  }
  return paragraphs;
}

/** 来源工单原件引用（工单总结，仅报告作者导出时出现）：只列元数据，不冒称已冻结 */
function buildDocxSourceOriginalSection(
  document: MaintenanceReportExportDocument,
): docx.Paragraph[] {
  const sourceOriginal = document.sourceWorkOrderOriginal;
  if (sourceOriginal === undefined || sourceOriginal === null) return [];
  return [
    buildDocxSectionHeading('来源工单原件'),
    new docx.Paragraph({
      text: `${sourceOriginal.filename}（${sourceOriginal.byteSize} 字节）；本行为引用记录：原件归属来源工单，未随本报告冻结，请按来源工单权限读取。`,
      spacing: { before: 120 },
    }),
  ];
}

// —— PDF 写入 ————————————————————————————————————————————————

function writePdfSectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.8).fontSize(13).text(text).moveDown(0.3).fontSize(11);
}

function writePdfMetaSection(
  doc: PDFKit.PDFDocument,
  document: MaintenanceReportExportDocument,
): void {
  const items = [
    line('报告来源', document.sourceLabel),
    line('客户厂家', document.customerFactoryName),
    line('设备型号', document.equipmentModelLabel),
    line('维修日期', document.maintenanceDate),
    line('维修人员', document.engineerName),
    line('维修结果', document.handlingResultLabel),
    line('中断/无法修复原因', document.closureReason),
    line('复位结果', document.resetResultLabel),
  ];
  doc.text(items.join('\n'));
}

function writePdfAlarmSection(
  doc: PDFKit.PDFDocument,
  alarms: MaintenanceReportExportDocument['alarms'],
): void {
  if (alarms.length === 0) return;
  writePdfSectionHeading(doc, '故障报警（最多 8 项）');
  for (const alarm of alarms) {
    doc.text(
      `报警${alarm.index}：${alarm.code}（${alarm.phaseCode}，${alarm.resetResult}）${
        alarm.description ?? ''
      }`,
    );
  }
}

function writePdfStepSection(
  doc: PDFKit.PDFDocument,
  steps: MaintenanceReportExportDocument['steps'],
): void {
  writePdfSectionHeading(doc, '排查步骤');
  for (const step of steps) {
    doc.text(`步骤${step.no}（${step.phaseCode}）：${step.actionText}`);
    if (step.partName !== null) doc.text(`零件/部位：${step.partName}`);
    if (step.errorCode !== null) doc.text(`报错代码：${step.errorCode}`);
    if (step.resultText !== null) doc.text(`步骤结果：${step.resultText}`);
    doc.moveDown(0.2);
  }
}

function writePdfFaultSection(
  doc: PDFKit.PDFDocument,
  faults: MaintenanceReportExportDocument['faults'],
): void {
  writePdfSectionHeading(doc, '当前有效故障分支');
  for (const fault of faults) {
    doc.text(`【${fault.branchLabel}】`);
    if (fault.stepNo !== null) {
      doc.text(line('对应排查步骤', `第 ${fault.stepNo} 步`));
    }
    doc.text(line('阶段', fault.phaseCode));
    doc.text(line('Main Error', fault.mainError));
    doc.text(line('Unit Error', fault.unitError));
    doc.text(line('Source', fault.source));
    doc.text(line('Error Type', fault.errorType));
    doc.text(line('GPIB Status', fault.gpibStatus));
    doc.text(line('Status', fault.faultStatus));
    doc.text(line('故障描述', fault.description));
    doc.text(line('处理动作', fault.action));
    doc.moveDown(0.3);
  }
}

function writePdfResultSection(
  doc: PDFKit.PDFDocument,
  document: MaintenanceReportExportDocument,
): void {
  writePdfSectionHeading(doc, '总结评价');
  doc.text(
    [
      line('实际确认原因', document.actualCause),
      line('维修措施', document.repairActions),
      line('复测方法与结果', document.verificationResult),
      line('补充说明', document.supplementaryNote),
    ].join('\n'),
  );
}

function writePdfAiSection(
  doc: PDFKit.PDFDocument,
  document: MaintenanceReportExportDocument,
): void {
  writePdfSectionHeading(doc, 'AI 辅助排查评价附录');
  if (document.ai.status === 'NOT_USED') {
    doc.text(
      '不适用：本次报告未使用 AI 辅助排查（真实会话评价依赖任务 05 联调，未接入时不作评价）。',
    );
    return;
  }
  doc.text(
    [
      line('评价来源类型', document.ai.sourceType),
      line('评价来源标识', document.ai.sourceId),
      line('评价内容版本', document.ai.sourceVersion),
      line('综合评分', document.ai.score === null ? null : `${document.ai.score} / 5`),
      line('正确性', document.ai.correctness),
      line('帮助度', document.ai.helpfulness === null ? null : `${document.ai.helpfulness} / 4`),
      line('评价说明', document.ai.note),
    ].join('\n'),
  );
}

function writePdfAttachmentSection(
  doc: PDFKit.PDFDocument,
  attachments: MaintenanceReportExportAttachmentLine[],
): void {
  writePdfSectionHeading(doc, '附件');
  if (attachments.length === 0) {
    doc.text('本报告未选择附件。');
    return;
  }
  let index = 0;
  for (const attachment of attachments) {
    index += 1;
    doc
      .text(
        `附件${index}：${attachment.filename}（${attachment.mimeType}，${attachment.byteSize} 字节）${
          attachment.description ? `；${attachment.description}` : ''
        }`,
      )
      .moveDown(0.2);
    if (
      attachment.embeddableImage !== null &&
      (attachment.mimeType === 'image/png' || attachment.mimeType === 'image/jpeg')
    ) {
      doc.image(attachment.embeddableImage, { fit: [460, 320] }).moveDown(0.3);
    }
  }
}

function writePdfSourceOriginalSection(
  doc: PDFKit.PDFDocument,
  document: MaintenanceReportExportDocument,
): void {
  const sourceOriginal = document.sourceWorkOrderOriginal;
  if (sourceOriginal === undefined || sourceOriginal === null) return;
  writePdfSectionHeading(doc, '来源工单原件');
  doc
    .text(
      `${sourceOriginal.filename}（${sourceOriginal.byteSize} 字节）；本行为引用记录：原件归属来源工单，未随本报告冻结，请按来源工单权限读取。`,
    )
    .moveDown(0.2);
}
