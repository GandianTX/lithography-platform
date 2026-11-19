// src/infrastructure/ai/conversation/ai-conversation-export.adapter.ts
// AI 对话导出适配器（任务 05 · S4.2）
//
// 把 infrastructure 的 PDF 渲染能力适配为 usecase 端口：
// - 字体路径来自运行时配置（不入库，部署环境提供）；
// - 缺字体或渲染失败直接抛错，不产出空文件。

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AiExportSnapshot } from '@src/core/ai/ai-conversation-export.policy';
import type { AiConversationExportRenderer } from '@src/usecases/ai-conversation/ai-conversation-export-renderer.contract';

import { renderAiConversationPdf } from './ai-conversation-pdf.renderer';

@Injectable()
export class AiConversationExportAdapter implements AiConversationExportRenderer {
  constructor(private readonly configService: ConfigService) {}

  async renderPdf(snapshot: AiExportSnapshot): Promise<Buffer> {
    const fontPath = this.configService.get<string>(
      'aiConversation.export.pdfFontPath',
      'var/fonts/NotoSansSC-Regular.otf',
    );
    return renderAiConversationPdf({ snapshot, fontPath });
  }
}
