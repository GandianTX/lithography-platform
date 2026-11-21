// src/infrastructure/document-export/document-export.module.ts
//
// 文档导出能力装配：DOCX/PDF 渲染实现绑定 usecase 层渲染 boundary contract。
// 不连接数据库、不访问业务存储；附件内容由调用方（usecase）预取后传入文档模型。

import { Global, Module } from '@nestjs/common';

import { MAINTENANCE_REPORT_EXPORT_RENDERER } from '@src/usecases/maintenance-report/ports/maintenance-report-export-renderer.contract';

import { MaintenanceReportDocumentRenderer } from './maintenance-report-document-renderer';

@Global()
@Module({
  providers: [
    MaintenanceReportDocumentRenderer,
    { provide: MAINTENANCE_REPORT_EXPORT_RENDERER, useExisting: MaintenanceReportDocumentRenderer },
  ],
  exports: [MAINTENANCE_REPORT_EXPORT_RENDERER],
})
export class DocumentExportModule {}
