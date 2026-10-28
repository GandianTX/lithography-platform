// src/features/reference-document/ui/reference-document-list.spec.tsx
// @vitest-environment jsdom

/**
 * 参考资料列表面板 UI 单测。
 *
 * 走真实面板 + 真实列表 query 状态机，只 mock 外部 adapter 与路由跳转；
 * 筛选参数形状、空态文案与分页行为均由生产组件决定，测试不复制规则。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import type {
  ReferenceDocumentListItem,
  ReferenceDocumentListPage,
} from '../infrastructure/reference-document.types';
import * as referenceDocumentAdapter from '../infrastructure/reference-document-adapter';

import { ReferenceDocumentList } from './reference-document-list';

vi.mock('../infrastructure/reference-document-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentAdapter>();

  return {
    ...actual,
    fetchReferenceDocuments: vi.fn(),
    fetchReferenceEquipmentModels: vi.fn(),
  };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const navigateMock = vi.fn();

const fetchListMock = vi.mocked(referenceDocumentAdapter.fetchReferenceDocuments);
const fetchModelsMock = vi.mocked(referenceDocumentAdapter.fetchReferenceEquipmentModels);

function buildItem(
  id: number,
  overrides: Partial<ReferenceDocumentListItem> = {},
): ReferenceDocumentListItem {
  return {
    id,
    title: `参考资料 ${id}`,
    documentType: 'ERROR_CODE_MANUAL',
    equipmentModelId: 49,
    equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
    equipmentModelText: null,
    description: '说明文本',
    originalFilename: null,
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseHandlingStatus: null,
    creatorNickname: '系统管理员',
    createdAt: '2026-08-10T08:00:00.000Z',
    ...overrides,
  };
}

function buildPage(
  items: ReferenceDocumentListItem[],
  total = items.length,
  page = 1,
  pageSize = 10,
): ReferenceDocumentListPage {
  return { items, total, page, pageSize };
}

beforeEach(() => {
  fetchListMock.mockReset();
  fetchModelsMock.mockReset();
  navigateMock.mockReset();
  fetchModelsMock.mockResolvedValue([
    { id: 47, modelCode: 'ASML-TWINSCAN-XT-1900I', modelName: 'ASML TWINSCAN XT:1900i' },
    { id: 49, modelCode: 'ASML-TWINSCAN-NXT-1980DI', modelName: 'ASML TWINSCAN NXT:1980Di' },
  ]);
});

describe('ReferenceDocumentList', () => {
  it('加载中展示骨架屏，就绪后展示列表行与分页', async () => {
    let resolveList: (value: ReferenceDocumentListPage) => void = () => {};
    fetchListMock.mockReturnValueOnce(
      new Promise<ReferenceDocumentListPage>((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<ReferenceDocumentList />);

    expect(document.querySelector('.ant-skeleton')).toBeTruthy();

    await act(async () => {
      resolveList(buildPage([buildItem(970001)], 1));
    });

    await screen.findByText('参考资料 970001');
    expect(document.querySelector('.ant-skeleton')).toBeNull();
    expect(screen.getByText('错误代码手册')).toBeTruthy();
    expect(screen.getByText('ASML TWINSCAN NXT:1980Di')).toBeTruthy();
    // 纯文本资料展示占位而非空白
    expect(screen.getByText('纯文本')).toBeTruthy();
    // 总数出现两处：真实汇总条（参考资料）与卡底统计，二者同源
    expect(screen.getAllByText('共 1 条')).toHaveLength(2);
  });

  it('无筛选时以不带 filter 参数请求；点击行进入详情路由', async () => {
    fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

    render(<ReferenceDocumentList />);
    await screen.findByText('参考资料 970001');

    expect(fetchListMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 }, undefined);

    fireEvent.click(screen.getByText('参考资料 970001'));

    expect(navigateMock).toHaveBeenCalledWith('/reference-documents/970001');
  });

  it('标题搜索防抖后按关键词请求', async () => {
    vi.useFakeTimers();

    try {
      fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

      render(<ReferenceDocumentList />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchListMock).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByPlaceholderText('按文档标题搜索'), {
        target: { value: '维护指南' },
      });

      // 防抖窗口内不触发请求
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(fetchListMock).toHaveBeenCalledTimes(1);

      // 防抖窗口过后按关键词重载
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(fetchListMock).toHaveBeenCalledTimes(2);
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 1, pageSize: 10 },
        { titleKeyword: '维护指南' },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('选择文档类型与设备型号后请求携带组合 filter（下拉经 AntD 门户渲染）', async () => {
    fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

    render(<ReferenceDocumentList />);
    await screen.findByText('参考资料 970001');

    // AntD Select 的 placeholder 不是 input 属性，jsdom 下按 combobox role + 页面顺序定位
    //（与 real e2e 先例一致）；下拉经 portal 渲染，mouseDown 展开
    // PR5 R2：筛选区默认收起，先点工具区「筛选」按钮展开
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    const [typeSelect, modelSelect] = screen.getAllByRole('combobox');
    await act(async () => {
      fireEvent.mouseDown(typeSelect);
    });
    fireEvent.click(await screen.findByText('维护指南'));

    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 1, pageSize: 10 },
        { documentType: 'MAINTENANCE_GUIDE' },
      );
    });

    await act(async () => {
      fireEvent.mouseDown(modelSelect);
    });
    // 型号 option label 为「modelName（modelCode）」组合格式，按子串匹配
    fireEvent.click(await screen.findByText(/ASML TWINSCAN XT:1900i/));

    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 1, pageSize: 10 },
        { documentType: 'MAINTENANCE_GUIDE', equipmentModelId: 47 },
      );
    });
  });

  it('结果为空区分「筛选无结果」与「库为空」', async () => {
    fetchListMock.mockResolvedValue(buildPage([], 0, 1));

    render(<ReferenceDocumentList />);

    await screen.findByText('暂无参考资料。');

    // 打开文档类型下拉（先展开筛选区，筛选区首个 combobox）并选中 → 空文案切换为筛选语义
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByText('错误代码手册'));

    await screen.findByText('没有符合筛选条件的参考资料。');
    expect(screen.queryByText('暂无参考资料。')).toBeNull();
  });

  it('加载失败展示共享错误文案与重试入口，重试沿用当前页码', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    fetchListMock.mockRejectedValueOnce(networkError);

    render(<ReferenceDocumentList />);

    await screen.findByText(networkError.userMessage);
    expect(screen.queryByText('暂无参考资料。')).toBeNull();

    fetchListMock.mockResolvedValueOnce(buildPage([buildItem(970002)]));
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await screen.findByText('参考资料 970002');
    expect(fetchListMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 }, undefined);
  });

  it('列表本体不渲染新增入口：主操作已移交页面页头（PR5 S3-2）', async () => {
    fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

    render(<ReferenceDocumentList />);
    await screen.findByText('参考资料 970001');

    expect(screen.queryByText('新增资料')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalledWith('/reference-documents/new');
  });

  it('当前页为空但总数不为 0 时保留分页器并可翻页回退（不形成死路，PR5 S3-3）', async () => {
    fetchListMock.mockResolvedValueOnce(buildPage([], 25, 3));

    const { container } = render(<ReferenceDocumentList />);

    // 第三页被删空：文案是「当前页空」，不是「库空」，也不与失败态叠加
    await screen.findByText('当前页暂无数据，请翻页返回。');
    expect(screen.queryByText('暂无参考资料。')).toBeNull();
    expect(screen.queryByText('没有符合筛选条件的参考资料。')).toBeNull();
    // 汇总条（参考资料）与卡底统计同源，均为 total=25
    expect(screen.getAllByText('共 25 条')).toHaveLength(2);

    const secondPage = container.querySelector('.ant-pagination-item-2 a');
    expect(secondPage).not.toBeNull();

    fetchListMock.mockResolvedValueOnce(buildPage([buildItem(970005)], 25, 2));
    fireEvent.click(secondPage as HTMLElement);

    await screen.findByText('参考资料 970005');
    expect(fetchListMock).toHaveBeenLastCalledWith({ page: 2, pageSize: 10 }, undefined);
    expect(screen.queryByText('当前页暂无数据，请翻页返回。')).toBeNull();
  });

  it('设备型号加载失败展示重试入口，重试后型号恢复可选并参与筛选（PR5 S3-3）', async () => {
    const modelsError = new GraphQLIngressError({
      type: 'network',
      message: 'models fetch failed',
    });
    fetchModelsMock.mockRejectedValueOnce(modelsError);
    fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

    render(<ReferenceDocumentList />);

    // 型号失败不阻塞列表：列表仍就绪，只额外多一条型号错误与重试入口
    await screen.findByText('参考资料 970001');
    await screen.findByText(modelsError.userMessage);
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();

    // 重试成功返回与首次不同的型号集合，证明下拉选项确实来自重试后的响应
    fetchModelsMock.mockResolvedValueOnce([
      { id: 47, modelCode: 'ASML-TWINSCAN-XT-1900I', modelName: 'ASML TWINSCAN XT:1900i' },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    });

    await waitFor(() => {
      expect(fetchModelsMock).toHaveBeenCalledTimes(2);
    });

    // PR5 R2：筛选区默认收起，展开后才能取到型号下拉
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    const [, modelSelect] = screen.getAllByRole('combobox');
    await act(async () => {
      fireEvent.mouseDown(modelSelect);
    });
    fireEvent.click(await screen.findByText(/ASML TWINSCAN XT:1900i/));

    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 1, pageSize: 10 },
        { equipmentModelId: 47 },
      );
    });
    // 重试成功后错误告警消失
    expect(screen.queryByText(modelsError.userMessage)).toBeNull();
  });

  it('表格只渲染后端真实字段集合，不含向量化 / 分块 / 参与检索等伪造列与假统计（PR5 S3-4）', async () => {
    fetchListMock.mockResolvedValue(buildPage([buildItem(970001)], 1));

    const { container } = render(<ReferenceDocumentList />);
    await screen.findByText('参考资料 970001');

    const headerTexts = Array.from(container.querySelectorAll('.ant-table-thead th')).map((th) =>
      th.textContent?.trim(),
    );
    expect(headerTexts).toEqual([
      '文档标题',
      '文档类型',
      '适用设备型号',
      '文档说明',
      '原始文件名',
      '创建人',
      '创建时间',
    ]);

    // 唯一统计是后端返回的 total，不得出现派生指标或伪造状态
    const text = container.textContent ?? '';
    for (const forbidden of [
      '向量化',
      '向量',
      '分块',
      '参与检索',
      '命中',
      '相似度',
      '索引状态',
      'embedding',
      'chunk',
    ]) {
      expect(text, `不应出现伪造字段：${forbidden}`).not.toContain(forbidden);
    }
    expect(container.querySelectorAll('.ant-statistic')).toHaveLength(0);
  });

  it('独立资料页清除按钮落在 reference-library-* 前缀下，点击后恢复无筛选请求（评审修复轮 P1-2）', async () => {
    vi.useFakeTimers();

    try {
      fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

      render(<ReferenceDocumentList />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByPlaceholderText('按文档标题搜索'), {
        target: { value: '维护指南' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 1, pageSize: 10 },
        { titleKeyword: '维护指南' },
      );

      // 前缀契约：独立资料页直接消费中性原语 shared/ui/toolbar-controls，DOM 上同时保留
      // 中性基类 toolbar-search-clear 与页面作用域覆盖层 reference-library-search-clear；
      // index.css 中 .kb-search-clear / .reference-library-search-clear 共用同一条几何定义，
      // 若独立变体退回默认前缀 'kb'，样式与几何断言的落点即失效（CSS 侧由 e2e computed style 守住）。
      const clearButton = screen.getByRole('button', { name: '清除标题搜索' });
      expect(clearButton.className).toBe('toolbar-search-clear reference-library-search-clear');

      fireEvent.click(clearButton);
      expect(screen.getByPlaceholderText<HTMLInputElement>('按文档标题搜索').value).toBe('');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(fetchListMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 }, undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('独立资料页筛选区默认收起，展开 / 活动 / 重置状态机与知识库变体同构（PR5 R2）', async () => {
    fetchListMock.mockResolvedValue(buildPage([buildItem(970001)], 25));

    render(<ReferenceDocumentList />);
    await screen.findByText('参考资料 970001');

    const filterButton = () => screen.getByRole('button', { name: '筛选' });
    // 默认收起：筛选控件完全不渲染（占 0px），按钮 aria-expanded=false
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(filterButton()).toHaveAttribute('aria-expanded', 'false');
    expect(filterButton().className).toBe('toolbar-button reference-library-toolbar-button');

    fireEvent.click(filterButton());
    expect(filterButton()).toHaveAttribute('aria-expanded', 'true');
    const [typeSelect] = screen.getAllByRole('combobox');
    await act(async () => {
      fireEvent.mouseDown(typeSelect);
    });
    fireEvent.click(await screen.findByText('维护指南'));

    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 1, pageSize: 10 },
        { documentType: 'MAINTENANCE_GUIDE' },
      );
    });
    // 有生效筛选：筛选按钮转 active，重置按钮出现
    expect(filterButton()).toHaveClass('reference-library-toolbar-button--active');

    // 收起不清值：不触发新请求，重新展开后已选值仍在
    const callsAfterFilter = fetchListMock.mock.calls.length;
    fireEvent.click(filterButton());
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(fetchListMock.mock.calls.length).toBe(callsAfterFilter);
    fireEvent.click(filterButton());
    expect(
      document.querySelector('.reference-library-filter-panel')?.textContent ?? '',
      '重新展开后已选值仍在（收起不清值）',
    ).toContain('维护指南');

    // 翻到第 2 页后重置：清除全部条件并回到第 1 页（filter 变化由 query 状态机回页）
    const secondPage = document.querySelector('.ant-pagination-item-2 a') as HTMLElement | null;
    expect(secondPage).not.toBeNull();
    fireEvent.click(secondPage as HTMLElement);
    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith(
        { page: 2, pageSize: 10 },
        { documentType: 'MAINTENANCE_GUIDE' },
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => {
      expect(fetchListMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 }, undefined);
    });
    expect(filterButton()).not.toHaveClass('reference-library-toolbar-button--active');
  });

  // PR5 整页视觉计划 S3-2 / S3-3：汇总条三项必须可追溯到真实状态源，且四态显式。
  describe('真实汇总条（PR5 整页视觉计划 S3）', () => {
    const summaryText = () =>
      document.querySelector('.reference-library-summary')?.textContent ?? '';

    it('就绪态：总数取自列表 total，类型取自后端枚举，型号取自型号 query 条数', async () => {
      fetchListMock.mockResolvedValue(buildPage([buildItem(970001)], 7, 1));

      render(<ReferenceDocumentList />);
      await screen.findByText('参考资料 970001');

      const cells = document.querySelectorAll('.reference-library-summary-cell');
      expect(cells).toHaveLength(3);
      expect(cells[0].textContent).toContain('参考资料');
      expect(cells[0].textContent).toContain('共 7 条');
      expect(cells[1].textContent).toContain('支持类型');
      // 类型集合来自后端契约枚举，不由测试复制
      expect(cells[1].textContent).toContain('错误代码手册');
      expect(cells[1].textContent).toContain('·');
      // 型号条数取自 useReferenceEquipmentModels 的真实响应（beforeEach 桩为 2 条）
      expect(cells[2].textContent).toContain('适用型号');
      expect(cells[2].textContent).toContain('2 个型号');
    });

    it('加载态：总数与型号均显示加载状态，不伪造数字', async () => {
      fetchListMock.mockReturnValue(new Promise<ReferenceDocumentListPage>(() => {}));
      fetchModelsMock.mockReturnValue(new Promise<never>(() => {}));

      await act(async () => {
        render(<ReferenceDocumentList />);
      });

      const cells = document.querySelectorAll('.reference-library-summary-cell');
      expect(cells).toHaveLength(3);
      expect(cells[0].textContent).toContain('加载中…');
      expect(cells[2].textContent).toContain('加载中…');
      // 类型来自静态枚举，加载态下仍可展示（不参与异步）
      expect(cells[1].textContent).toContain('错误代码手册');
    });

    it('失败态：总数与型号均显示加载失败，仍不出现任何假统计', async () => {
      const listError = new GraphQLIngressError({ type: 'network', message: 'list failed' });
      const modelsError = new GraphQLIngressError({ type: 'network', message: 'models failed' });
      fetchListMock.mockRejectedValue(listError);
      fetchModelsMock.mockRejectedValue(modelsError);

      render(<ReferenceDocumentList />);

      // 列表与型号两处错误告警同为网络类归一文案，故用 findAll
      await screen.findAllByText(listError.userMessage);

      const cells = document.querySelectorAll('.reference-library-summary-cell');
      expect(cells[0].textContent).toContain('加载失败');
      expect(cells[2].textContent).toContain('加载失败');
      expect(summaryText()).not.toMatch(/\d+\s*条/);
      expect(summaryText()).not.toMatch(/\d+\s*个型号/);
    });

    it('knowledge-base 变体不重复渲染本汇总条（知识库页有自己的四分区汇总）', async () => {
      fetchListMock.mockResolvedValue(buildPage([buildItem(970001)], 1));

      render(<ReferenceDocumentList variant="knowledge-base" />);
      await screen.findByText('参考资料 970001');

      expect(document.querySelector('.reference-library-summary')).toBeNull();
      expect(document.querySelector('.kb-summary')).toBeNull();
    });
  });

  describe('knowledge-base 变体（PR3 R7）', () => {
    it('渲染 kb-card 工具区/紧凑表格/卡底统计，不渲染卡片标题与新增入口', async () => {
      fetchListMock.mockResolvedValue(buildPage([buildItem(970001)], 1));

      render(<ReferenceDocumentList variant="knowledge-base" />);
      await screen.findByText('参考资料 970001');

      expect(document.querySelector('.kb-card')).not.toBeNull();
      expect(document.querySelector('.kb-toolbar')).not.toBeNull();
      expect(document.querySelector('.kb-table-scope')).not.toBeNull();
      expect(document.querySelector('.kb-card-footer')?.textContent).toContain('共 1 条');
      // 新增入口由页面右上主操作区承担：变体内不渲染
      expect(screen.queryByText('新增资料')).toBeNull();
      expect(screen.getByPlaceholderText('按文档标题搜索')).toBeTruthy();
      expect(screen.getByRole('button', { name: '筛选' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    it('筛选默认收起，展开后选择类型触发组合筛选，重置清除全部条件', async () => {
      fetchListMock.mockResolvedValue(buildPage([buildItem(970001)], 1));

      render(<ReferenceDocumentList variant="knowledge-base" />);
      await screen.findByText('参考资料 970001');

      // 默认收起：无可见 combobox
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: '筛选' }));
      const [typeSelect] = screen.getAllByRole('combobox');
      await act(async () => {
        fireEvent.mouseDown(typeSelect);
      });
      fireEvent.click(await screen.findByText('维护指南'));

      await waitFor(() => {
        expect(fetchListMock).toHaveBeenLastCalledWith(
          { page: 1, pageSize: 10 },
          { documentType: 'MAINTENANCE_GUIDE' },
        );
      });

      // 有生效筛选后按钮出现 active 提示
      expect(screen.getByRole('button', { name: '筛选' })).toHaveClass('kb-toolbar-button--active');

      fireEvent.click(screen.getByRole('button', { name: '重置' }));
      await waitFor(() => {
        expect(fetchListMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 }, undefined);
      });
    });

    it('主搜索框输入经防抖后按关键词请求，清除按钮回传空值恢复全量', async () => {
      vi.useFakeTimers();

      try {
        fetchListMock.mockResolvedValue(buildPage([buildItem(970001)]));

        render(<ReferenceDocumentList variant="knowledge-base" />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        fireEvent.change(screen.getByPlaceholderText('按文档标题搜索'), {
          target: { value: '维护指南' },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
        });
        expect(fetchListMock).toHaveBeenLastCalledWith(
          { page: 1, pageSize: 10 },
          { titleKeyword: '维护指南' },
        );

        fireEvent.click(screen.getByRole('button', { name: '清除标题搜索' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
        });
        expect(fetchListMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 10 }, undefined);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
