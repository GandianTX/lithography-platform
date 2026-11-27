// src/infrastructure/config/config.module.document-export.spec.ts
//
// 导出配置注册与读取路径验证（防止「只定义工厂、未注册到 ConfigModule.load」）：
// - 注册：AppConfigModule 实际加载的工厂清单包含 documentExportConfig；
// - 默认读取：未配置环境变量时给出空路径 + 内置 CJK 候选；
// - 显式读取：DOCUMENT_EXPORT_PDF_FONT_PATH / _FACE 覆盖默认候选；
// - 渲染器真实读取：用注册工厂产出的 ConfigService 构造渲染器，
//   显式配置缺失字体时必须失败关闭（不能静默回落到候选字体）。

/// <reference types="jest" />
import { existsSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import {
  APP_CONFIG_FACTORIES,
  documentExportConfig,
} from '@src/infrastructure/config/config.module';
import { MaintenanceReportDocumentRenderer } from '@src/infrastructure/document-export/maintenance-report-document-renderer';
import type { MaintenanceReportExportDocument } from '@src/usecases/maintenance-report/ports/maintenance-report-export-renderer.contract';
import { MaintenanceReportExportFormat } from '@app-types/models/maintenance-report.types';

const NOTO_TTC = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
const NOTO_FACE = 'NotoSansCJKsc-Regular';
const DROID_TTF = '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf';

const originalFontPath = process.env.DOCUMENT_EXPORT_PDF_FONT_PATH;
const originalFontFace = process.env.DOCUMENT_EXPORT_PDF_FONT_FACE;

const restoreEnv = (): void => {
  if (originalFontPath === undefined) delete process.env.DOCUMENT_EXPORT_PDF_FONT_PATH;
  else process.env.DOCUMENT_EXPORT_PDF_FONT_PATH = originalFontPath;
  if (originalFontFace === undefined) delete process.env.DOCUMENT_EXPORT_PDF_FONT_FACE;
  else process.env.DOCUMENT_EXPORT_PDF_FONT_FACE = originalFontFace;
};

const buildDocument = (): MaintenanceReportExportDocument => ({
  title: '中文 PDF 字体配置验证',
  sourceLabel: '工单维修总结',
  customerFactoryName: '某封测厂',
  equipmentModelLabel: 'NSR-2205i11',
  maintenanceDate: '2026-11-21',
  engineerName: '李工',
  handlingResultLabel: '故障修复',
  closureReason: null,
  resetResultLabel: '复位后正常',
  alarms: [],
  steps: [
    {
      no: 1,
      phaseCode: 'PHASE_01',
      partName: null,
      actionText: '检查激光器状态并复位。',
      resultText: null,
      errorCode: null,
    },
  ],
  faults: [],
  actualCause: null,
  repairActions: null,
  verificationResult: null,
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
  attachments: [],
});

const renderPdf = async (
  doc: MaintenanceReportExportDocument = buildDocument(),
): Promise<Buffer> => {
  const renderer = new MaintenanceReportDocumentRenderer(new ConfigService(documentExportConfig()));
  const result = await renderer.render(doc, MaintenanceReportExportFormat.PDF);
  return result.content;
};

describe('documentExport 配置注册', () => {
  afterEach(restoreEnv);

  it('AppConfigModule 加载的工厂清单包含 documentExportConfig', () => {
    expect(APP_CONFIG_FACTORIES).toContain(documentExportConfig);
  });

  it('未配置环境变量时输出空显式路径与内置 CJK 候选', () => {
    delete process.env.DOCUMENT_EXPORT_PDF_FONT_PATH;
    delete process.env.DOCUMENT_EXPORT_PDF_FONT_FACE;
    const config = documentExportConfig() as {
      documentExport: {
        pdfFontPath: string;
        pdfFontFace: string;
        pdfFontCandidates: Array<{ path: string; face?: string }>;
      };
    };
    expect(config.documentExport.pdfFontPath).toBe('');
    expect(config.documentExport.pdfFontFace).toBe('');
    expect(config.documentExport.pdfFontCandidates.length).toBeGreaterThan(0);
    expect(config.documentExport.pdfFontCandidates[0].path).toBe(NOTO_TTC);
    expect(config.documentExport.pdfFontCandidates[0].face).toBe(NOTO_FACE);
  });

  it('显式环境变量覆盖默认候选（路径与 TTC face 名都可读到）', () => {
    process.env.DOCUMENT_EXPORT_PDF_FONT_PATH = DROID_TTF;
    process.env.DOCUMENT_EXPORT_PDF_FONT_FACE = 'DroidSansFallback';
    const config = documentExportConfig() as {
      documentExport: { pdfFontPath: string; pdfFontFace: string };
    };
    expect(config.documentExport.pdfFontPath).toBe(DROID_TTF);
    expect(config.documentExport.pdfFontFace).toBe('DroidSansFallback');
  });
});

describe('渲染器真实读取 documentExport 配置', () => {
  afterEach(restoreEnv);

  it('显式路径指向不存在的字体时失败关闭，不静默回落候选字体', async () => {
    process.env.DOCUMENT_EXPORT_PDF_FONT_PATH = '/nonexistent/task06-missing-font.ttf';
    delete process.env.DOCUMENT_EXPORT_PDF_FONT_FACE;
    await expect(renderPdf()).rejects.toThrow();
  });

  (existsSync(DROID_TTF) ? it : it.skip)(
    '显式路径指向可用字体时按该字体渲染 PDF',
    async () => {
      process.env.DOCUMENT_EXPORT_PDF_FONT_PATH = DROID_TTF;
      delete process.env.DOCUMENT_EXPORT_PDF_FONT_FACE;
      const content = await renderPdf();
      expect(content.subarray(0, 4).toString()).toBe('%PDF');
    },
    60000,
  );

  (existsSync(NOTO_TTC) ? it : it.skip)(
    '显式路径 + TTC face 名时按集合内字面渲染 PDF',
    async () => {
      process.env.DOCUMENT_EXPORT_PDF_FONT_PATH = NOTO_TTC;
      process.env.DOCUMENT_EXPORT_PDF_FONT_FACE = NOTO_FACE;
      const content = await renderPdf();
      expect(content.subarray(0, 4).toString()).toBe('%PDF');
    },
    60000,
  );

  (existsSync(NOTO_TTC) || existsSync(DROID_TTF) ? it : it.skip)(
    '未配置显式路径时按注册候选探测渲染 PDF',
    async () => {
      delete process.env.DOCUMENT_EXPORT_PDF_FONT_PATH;
      delete process.env.DOCUMENT_EXPORT_PDF_FONT_FACE;
      const content = await renderPdf();
      expect(content.subarray(0, 4).toString()).toBe('%PDF');
    },
    60000,
  );
});
