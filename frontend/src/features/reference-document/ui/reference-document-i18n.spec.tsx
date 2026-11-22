// src/features/reference-document/ui/reference-document-i18n.spec.tsx
// @vitest-environment jsdom
//
// 任务 07 资料详情面板与管理修订页语言切换组件测试。
//
// 2026-11-22 i18n 修复回归：此前两页面全部硬编码中文，英文模式下正文不变。
// 本规格用真实 I18nProvider 渲染组件并实际切换语言，断言系统文案随语言变化、
// 用户输入内容（厂家/机型/正文）不被翻译或改写。
//
// 替身边界：仅 mock 数据读取 hook（use-reference-document-detail /
// use-reference-document-revisions / use-reference-document-editable-content /
// use-reference-equipment-models）与下载适配器，使组件以「ready」状态渲染；
// 组件本身、词条表与翻译函数全部真实。展示逻辑之外的业务行为由其他规格覆盖。
import { useMemo, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AppLanguage, createTranslator, I18nContext, useI18n } from '@/shared/i18n';
import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import type { ReferenceDocumentDetail } from '../infrastructure/reference-document.types';

import type { ReferenceDocumentViewer } from './reference-document-detail-panel';
import { ReferenceDocumentDetailPanel } from './reference-document-detail-panel';
import { ReferenceDocumentRevisePanel } from './reference-document-revise-panel';

const detailReady = vi.hoisted(() => ({ state: null as unknown }));
const revisionsReady = vi.hoisted(() => ({ state: null as unknown }));
const editableReady = vi.hoisted(() => ({ state: null as unknown }));
const modelsState = vi.hoisted(() => ({ state: null as unknown }));

vi.mock('../application/use-reference-document-detail', () => ({
  useReferenceDocumentDetail: () => detailReady.state,
}));
vi.mock('../application/use-reference-document-revisions', () => ({
  useReferenceDocumentRevisions: () => revisionsReady.state,
}));
vi.mock('../application/use-reference-document-editable-content', () => ({
  useReferenceDocumentEditableContent: () => editableReady.state,
}));
vi.mock('../application/use-reference-equipment-models', () => ({
  useReferenceEquipmentModels: () => modelsState.state,
}));
vi.mock('../infrastructure/reference-document-http-adapter', () => ({
  downloadReferenceDocumentFile: vi.fn(),
}));

const DETAIL_FIXTURE = {
  id: 970001,
  title: 'T07-i18n 验收资料',
  documentType: 'MAINTENANCE_GUIDE',
  equipmentModelId: 2,
  equipmentModelName: '机型-用户输入',
  equipmentModelText: null,
  description: null,
  originalFilename: null,
  organizationName: '公司-用户输入',
  ingestMethod: 'ADMIN_CREATED',
  sourceKind: 'INDEPENDENT_REPORT',
  effectiveRevisionNo: 1,
  creatorNickname: '工程师-用户输入',
  createdAt: '2026-11-22T02:00:00.000Z',
  mimeType: null,
  hasFile: false,
  contentText: '正文-用户输入',
  contentSource: 'CURRENT_REVISION',
  sourceReportId: 970002,
  sourceReportVersionId: 970003,
  frozenReport: null,
  sourceReportAttachment: null,
  structuredContent: {
    schemaVersion: 1,
    maintenanceDate: '2026-11-22',
    maintenanceEngineerName: '工程师-用户输入',
    customerFactoryName: '厂家-用户输入',
    equipmentModelText: '机型-用户输入',
    resetResult: 'NORMAL',
    faults: [],
    steps: [],
    handlingResult: 'FIXED',
    closureReason: null,
    actualCause: null,
    repairActions: null,
    verificationResult: null,
    supplementaryNote: null,
  },
  caseDetail: null,
  caseHandlingStatus: null,
  viewerIsOriginalAuthor: true,
  updatedAt: '2026-11-22T03:00:00.000Z',
} as unknown as ReferenceDocumentDetail;

function readyDetailState() {
  return { state: { status: 'ready', requestSeq: 1, detail: DETAIL_FIXTURE }, reload: vi.fn() };
}

/**
 * 测试用语言 Provider：与 app 层 I18nProvider 相同的语义
 * （真实词条表 + createTranslator + 语言状态），但不引入 app 层模块——
 * I18nProvider 本身的持久化与 <html lang> 行为由 app 层规格覆盖。
 */
function TestI18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>('zh-CN');
  const t = useMemo(() => createTranslator(language), [language]);
  const value = useMemo(() => ({ language, setLanguage, t }), [language, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function SwitchProbe({ register }: { register: (fn: (l: 'zh-CN' | 'en') => void) => void }) {
  const { setLanguage } = useI18n();
  register(setLanguage);
  return null;
}

const ADMIN_VIEWER: ReferenceDocumentViewer = { role: 'SUPER_ADMIN', adminLevel: 1 };

describe('参考资料详情面板语言切换', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('默认中文显示系统文案与用户输入原值', () => {
    detailReady.state = readyDetailState();
    revisionsReady.state = {
      state: {
        status: 'ready',
        revisions: {
          documentId: 970001,
          currentRevisionNo: 1,
          sourceKind: 'INDEPENDENT_REPORT',
          sourceReportVersionId: 970003,
          revisions: [],
        },
      },
      reload: vi.fn(),
    };
    render(
      <MemoryRouter>
        <MessageFeedbackProvider>
          <TestI18nProvider>
            <ReferenceDocumentDetailPanel documentId={970001} viewer={ADMIN_VIEWER} />
          </TestI18nProvider>
        </MessageFeedbackProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('管理修订后报告内容')).toBeDefined();
    expect(screen.getAllByText('客户厂家').length).toBeGreaterThan(0);
    expect(screen.getAllByText('排查步骤').length).toBeGreaterThan(0);
    expect(screen.getAllByText('维修结果').length).toBeGreaterThan(0);
    expect(screen.getByText('管理操作')).toBeDefined();
    expect(screen.getAllByText('厂家-用户输入').length).toBeGreaterThan(0);
    expect(screen.getAllByText('机型-用户输入').length).toBeGreaterThan(0);
  });

  it('切换英文后系统文案变为英文，用户输入内容不被翻译', () => {
    detailReady.state = readyDetailState();
    revisionsReady.state = {
      state: {
        status: 'ready',
        revisions: {
          documentId: 970001,
          currentRevisionNo: 1,
          sourceKind: 'INDEPENDENT_REPORT',
          sourceReportVersionId: 970003,
          revisions: [],
        },
      },
      reload: vi.fn(),
    };
    let switchTo: ((l: 'zh-CN' | 'en') => void) | undefined;
    render(
      <MemoryRouter>
        <MessageFeedbackProvider>
          <TestI18nProvider>
            <ReferenceDocumentDetailPanel documentId={970001} viewer={ADMIN_VIEWER} />
            <SwitchProbe
              register={(fn) => {
                switchTo = fn;
              }}
            />
          </TestI18nProvider>
        </MessageFeedbackProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('管理修订后报告内容')).toBeDefined();
    act(() => {
      switchTo?.('en');
    });
    expect(screen.getByText('Content of applied managed revision')).toBeDefined();
    expect(screen.getAllByText('Customer factory').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Troubleshooting steps').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Repair outcome').length).toBeGreaterThan(0);
    expect(screen.getByText('Management actions')).toBeDefined();
    expect(screen.getByText('Manage revision')).toBeDefined();
    expect(screen.queryByText('管理修订后报告内容')).toBeNull();
    expect(screen.getAllByText('厂家-用户输入').length).toBeGreaterThan(0);
    expect(screen.getAllByText('机型-用户输入').length).toBeGreaterThan(0);
  });
});

describe('管理修订页语言切换', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('非一级管理员提示按语言显示', () => {
    editableReady.state = { state: { status: 'loading' }, reload: vi.fn() };
    modelsState.state = { state: { status: 'loading' }, models: [] };
    let switchTo: ((l: 'zh-CN' | 'en') => void) | undefined;
    render(
      <MemoryRouter>
        <MessageFeedbackProvider>
          <TestI18nProvider>
            <ReferenceDocumentRevisePanel
              documentId={970001}
              viewer={{ role: null, adminLevel: null }}
            />
            <SwitchProbe
              register={(fn) => {
                switchTo = fn;
              }}
            />
          </TestI18nProvider>
        </MessageFeedbackProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('仅一级管理员可以管理修订正式资料。')).toBeDefined();
    act(() => {
      switchTo?.('en');
    });
    expect(
      screen.getByText(
        'Only level-1 administrators can perform managed revisions on formal documents.',
      ),
    ).toBeDefined();
    expect(screen.queryByText('仅一级管理员可以管理修订正式资料。')).toBeNull();
  });
});
