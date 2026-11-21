// src/infrastructure/document-export/maintenance-report-document-renderer.spec.ts
//
// 导出渲染实现的真实内容验证：不解依赖、不碰库。
// - DOCX：解包 OOXML，断言正文 XML 中包含完整中文长文、15 个步骤、有效分支、附件条目；
// - PDF：pdfkit 生成后用 pdf-parse 抽取文本，断言中文可抽取、自动分页、不截断；
// - 隐藏分支不应出现在渲染内容中（文档模型层面剔除由 usecase 保证，这里验证渲染器
//   不额外引入或截断内容）。

/// <reference types="jest" />
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { ConfigService } from '@nestjs/config';
import { documentExportConfig } from '@src/infrastructure/config/config.module';
import { MaintenanceReportDocumentRenderer } from './maintenance-report-document-renderer';
import type { MaintenanceReportExportDocument } from '@src/usecases/maintenance-report/ports/maintenance-report-export-renderer.contract';
import { MaintenanceReportExportFormat } from '@app-types/models/maintenance-report.types';

/** 环境字体探测：本机存在 Noto CJK 时才跑 PDF 内容断言（DOCX 不依赖字体） */
const PDF_FONT_CANDIDATES = [
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', face: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf' },
];
const hasPdfFont = PDF_FONT_CANDIDATES.some((candidate) => existsSync(candidate.path));

/**
 * 使用真实注册的配置工厂构造 ConfigService（默认字体候选来自 config.module.ts），
 * 而不是测试内自建替身：这里断言的字体解析路径与运行时一致。
 */
const configService = new ConfigService(documentExportConfig());

const renderer = new MaintenanceReportDocumentRenderer(configService);

/** 1×1 像素 PNG（最小合法图片，用于附件嵌入验证） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const LONG_REPAIR_ACTIONS =
  '第一步检查激光器状态并记录能量读数。'.repeat(120) + '长文末尾标记ENDMARK。';

const exportDocument = (): MaintenanceReportExportDocument => ({
  title: '2026-10-01 某封测厂 历史维修记录',
  sourceLabel: '独立历史维修记录',
  customerFactoryName: '某封测厂（中文长名称验证）',
  equipmentModelLabel: 'NSR-2205i11',
  maintenanceDate: '2026-10-01',
  engineerName: '李工',
  handlingResultLabel: '故障修复',
  closureReason: null,
  resetResultLabel: '复位后正常',
  alarms: [
    {
      index: 1,
      code: 'E0012',
      description: '上片失败（报警描述验证）',
      phaseCode: 'PHASE_01',
      resetResult: 'RESET_OK',
    },
  ],
  steps: Array.from({ length: 15 }, (_, index) => ({
    no: index + 1,
    phaseCode: 'PHASE_02',
    partName: index === 0 ? '光源模块' : null,
    actionText: `排查动作 ${index + 1}：检查并复位相关子系统。`,
    resultText: `步骤结果 ${index + 1}`,
    errorCode: index === 2 ? 'ERR-204' : null,
  })),
  faults: [
    {
      branchLabel: '初始故障',
      stepNo: null,
      phaseCode: 'PHASE_01',
      mainError: 'E0012',
      unitError: 'UNIT-A',
      source: 'LASER',
      errorType: 'INTERLOCK',
      gpibStatus: 'OK',
      faultStatus: 'ACTIVE',
      description: '初始故障描述：光刻机上片失败（长描述验证）。'.repeat(30),
      action: '更换光源模块并复位。',
    },
    {
      branchLabel: '排查步骤新故障',
      stepNo: 3,
      phaseCode: 'PHASE_03',
      mainError: 'E0100',
      unitError: 'UNIT-B',
      source: 'STAGE',
      errorType: 'TIMEOUT',
      gpibStatus: 'FAIL',
      faultStatus: 'ACTIVE',
      description: '第 3 步出现的新故障。',
      action: '重新校准载台。',
    },
  ],
  actualCause: '光源模块老化（实际原因验证）。',
  repairActions: LONG_REPAIR_ACTIONS,
  verificationResult: '复测通过（复测方法与结果验证）。',
  supplementaryNote: null,
  ai: {
    status: 'NOT_USED',
    sourceType: null,
    sourceId: null,
    sourceVersion: null,
    score: null,
    correctness: null,
    helpfulness: null,
    note: null,
  },
  attachments: [
    {
      filename: '故障照片.png',
      mimeType: 'image/png',
      byteSize: TINY_PNG.length,
      description: '现场照片',
      embeddableImage: TINY_PNG,
    },
    {
      filename: '检测报告.pdf',
      mimeType: 'application/pdf',
      byteSize: 20480,
      description: null,
      embeddableImage: null,
    },
  ],
});

describe('MaintenanceReportDocumentRenderer DOCX', () => {
  it('生成可解包的 OOXML：完整中文长文、15 步、有效分支与附件均在正文中', async () => {
    const result = await renderer.render(exportDocument(), MaintenanceReportExportFormat.DOCX);
    expect(result.fileExtension).toBe('docx');
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(result.content.length).toBeGreaterThan(1000);

    const zip = await JSZip.loadAsync(result.content);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toBeDefined();

    const text = documentXml as string;
    expect(text).toContain('2026-10-01 某封测厂 历史维修记录');
    expect(text).toContain('独立历史维修记录');
    expect(text).toContain('长文末尾标记ENDMARK。');
    expect(text).toContain('排查动作 15');
    expect(text).toContain('步骤结果 15');
    expect(text).toContain('初始故障');
    expect(text).toContain('光刻机上片失败');
    expect(text).toContain('排查步骤新故障');
    expect(text).toContain('对应排查步骤：第 3 步');
    expect(text).toContain('报错代码：ERR-204');
    expect(text).toContain('不适用：本次报告未使用 AI 辅助排查');
    expect(text).toContain('附件1：故障照片.png');
    expect(text).toContain('附件2：检测报告.pdf');
    // 不截断：长文起止都在
    expect(text).toContain('第一步检查激光器状态并记录能量读数。');
  });

  it('DOCX 嵌入图片附件（media 目录）', async () => {
    const result = await renderer.render(exportDocument(), MaintenanceReportExportFormat.DOCX);
    const zip = await JSZip.loadAsync(result.content);
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
    expect(media.length).toBeGreaterThanOrEqual(1);
  });
});

describe('MaintenanceReportDocumentRenderer PDF', () => {
  (hasPdfFont ? it : it.skip)(
    '中文 PDF：可抽取文本、自动分页、长文与 15 步不截断',
    async () => {
      const result = await renderer.render(exportDocument(), MaintenanceReportExportFormat.PDF);
      expect(result.fileExtension).toBe('pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.content.subarray(0, 4).toString()).toBe('%PDF');

      const parsed = await extractPdfText(result.content);
      const text = parsed.text;
      const pages = parsed.pages;

      expect(pages).toBeGreaterThanOrEqual(2);
      expect(text).toContain('2026-10-01 某封测厂 历史维修记录');
      expect(text).toContain('某封测厂（中文长名称验证）');
      expect(text).toContain('长文末尾标记ENDMARK。');
      expect(text).toContain('排查动作 15');
      expect(text).toContain('初始故障');
      expect(text).toContain('对应排查步骤：第 3 步');
      expect(text).toContain('不适用：本次报告未使用 AI 辅助排查');
      expect(text).toContain('附件1：故障照片.png');
      // 隐藏分支标记不应出现（文档模型只包含有效分支）
      expect(text).not.toContain('已切走的旧分支');
    },
    60000,
  );
});

/**
 * pdf-parse v2 依赖 pdfjs 的动态 import worker，无法在 jest 的 CJS VM 内运行；
 * 通过一次性子进程完成文本抽取（cwd=backend 以解析 pdf-parse 依赖）。
 */
async function extractPdfText(content: Buffer): Promise<{ pages: number; text: string }> {
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'export-pdf-'));
  const file = join(dir, 'doc.pdf');
  writeFileSync(file, content);
  const script = [
    "import { PDFParse } from 'pdf-parse';",
    "import { readFileSync } from 'node:fs';",
    'const file = process.argv[process.argv.length - 1];',
    'const parser = new PDFParse({ data: new Uint8Array(readFileSync(file)) });',
    'const result = await parser.getText();',
    'process.stdout.write(JSON.stringify({ pages: result.pages?.length ?? 0, text: result.text }));',
    'await parser.destroy();',
  ].join('\n');
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script, file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 45000,
      windowsHide: true,
    });
    return JSON.parse(stdout) as { pages: number; text: string };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
