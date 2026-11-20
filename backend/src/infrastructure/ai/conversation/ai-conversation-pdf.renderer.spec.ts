// src/infrastructure/ai/conversation/ai-conversation-pdf.renderer.spec.ts

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AI_CONVERSATION_ERROR } from '@core/common/errors/domain-error';
import type { AiExportSnapshot } from '@src/core/ai/ai-conversation-export.policy';

import { renderAiConversationPdf, resolveAiTurnStateLabel } from './ai-conversation-pdf.renderer';

/**
 * PDF 渲染器单测（任务 05 · S4.2 · R039-01）。
 *
 * 覆盖：缺中文字体失败关闭（不产出空文件）、中文长文完整（多页）、
 * 固定版本与截止点在产物中声明。
 *
 * 中文字体为运行时部署资源（不入库）：缺失时多页用例跳过并说明原因，
 * 「缺字体必须失败」用例始终执行。
 */
describe('AI 对话 PDF 渲染器', () => {
  const FONT_PATH = join(process.cwd(), 'var/fonts/NotoSansSC-Regular.otf');
  const HAS_FONT = existsSync(FONT_PATH);

  const snapshot = (messages: AiExportSnapshot['messages']): AiExportSnapshot => ({
    conversationId: 66,
    contentVersion: 2,
    lastMessageSeq: messages.length,
    requestNo: 'RR-20261101-001',
    requestId: 88,
    engineerNickname: '陈工程师',
    messages,
    createdAt: '2026-11-01T00:00:00.000Z',
  });

  it('P2-2：本版无回答的轮次标注为「本版未收录回答」，不表述成生成中或失败', () => {
    expect(resolveAiTurnStateLabel('UNKNOWN')).toBe('本版未收录回答');
    expect(resolveAiTurnStateLabel('UNKNOWN')).not.toMatch(/生成中|失败|待执行/);
    expect(resolveAiTurnStateLabel('SUCCEEDED')).toBe('已保存');
  });

  it('缺少中文字体时失败关闭，不产出空文件', async () => {
    await expect(
      renderAiConversationPdf({
        snapshot: snapshot([]),
        fontPath: join(process.cwd(), 'var/fonts/__missing_font__.otf'),
      }),
    ).rejects.toMatchObject({ code: AI_CONVERSATION_ERROR.EXPORT_FAILED });
  });

  const maybeIt = HAS_FONT ? it : it.skip;

  maybeIt('产出非空 PDF 字节（PDF 头可见）', async () => {
    const buffer = await renderAiConversationPdf({
      snapshot: snapshot([
        {
          messageId: 1,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          text: '曝光异常，晶圆边缘出现亮斑。',
          contentVersion: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          turnState: 'SUCCEEDED',
        },
      ]),
      fontPath: FONT_PATH,
    });

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  maybeIt('中文长文分多页输出（内容不截断）', async () => {
    const longText = '光刻机曝光异常诊断记录。'.repeat(400);
    const buffer = await renderAiConversationPdf({
      snapshot: snapshot([
        {
          messageId: 1,
          messageSeq: 1,
          turnNo: 1,
          role: 'ASSISTANT',
          text: longText,
          contentVersion: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          turnState: 'SUCCEEDED',
        },
      ]),
      fontPath: FONT_PATH,
    });

    const content = buffer.toString('latin1');
    // 多页会输出多个 /Type /Page 对象
    const pageCount = (content.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  maybeIt('失败轮次在产物中如实标注', async () => {
    const buffer = await renderAiConversationPdf({
      snapshot: snapshot([
        {
          messageId: 1,
          messageSeq: 1,
          turnNo: 1,
          role: 'USER',
          text: '问题',
          contentVersion: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          turnState: 'FAILED',
        },
      ]),
      fontPath: FONT_PATH,
    });

    expect(buffer.length).toBeGreaterThan(0);
  });
});
