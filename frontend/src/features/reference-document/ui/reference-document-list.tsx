// src/features/reference-document/ui/reference-document-list.tsx

import { useEffect, useMemo, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { Alert, Button, Card, Empty, Pagination, Select, Skeleton, Table } from 'antd';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { ToolbarButton, ToolbarSearchField } from '@/shared/ui/toolbar-controls';

import { useReferenceDocumentList } from '../application/use-reference-document-list';
import { useReferenceEquipmentModels } from '../application/use-reference-equipment-models';
import type {
  ReferenceDocumentListFilter,
  ReferenceDocumentListItem,
} from '../infrastructure/reference-document.types';
import { REFERENCE_DOCUMENT_TYPE_LABELS } from '../infrastructure/reference-document.types';

import { buildReferenceDocumentDetailPath } from './reference-document-paths';

/** 标题搜索防抖间隔（ms） */
const SEARCH_DEBOUNCE_MS = 300;

/** 来源类型展示（任务 07）：服务端只返回 ONLINE + CONFIRMED 的正式资料 */
const SOURCE_KIND_LABELS: Record<string, string> = {
  INDEPENDENT_REPORT: '独立报告',
  WORK_ORDER_SUMMARY: '工单总结',
  MATERIAL: '普通资料',
};

/**
 * 列定义即「只展示后端真实字段」的唯一真源（PR5 S3-4）：七列一一对应后端
 * ReferenceDocumentItem 的字段，不引入向量化、分块数、参与检索等派生/伪造列。
 * 长文本列（标题 / 说明 / 原始文件名）统一走 AntD `ellipsis`（PR5 S3-5）：
 * 单行截断 + 原生 title 提示，行高保持在紧凑密度内；行点击进入详情不受影响。
 */
const columns: TableColumnsType<ReferenceDocumentListItem> = [
  { dataIndex: 'title', key: 'title', ellipsis: true, title: '文档标题', width: 260 },
  {
    dataIndex: 'documentType',
    key: 'documentType',
    render: (value: string) => REFERENCE_DOCUMENT_TYPE_LABELS[value] ?? value,
    title: '文档类型',
    width: 130,
  },
  {
    key: 'sourceKind',
    render: (_value, record) => SOURCE_KIND_LABELS[record.sourceKind] ?? record.sourceKind,
    title: '来源',
    width: 130,
  },
  {
    key: 'effectiveRevisionNo',
    render: (_value, record) =>
      record.effectiveRevisionNo > 0 ? `v${record.effectiveRevisionNo}` : '原始版本',
    title: '生效版本',
    width: 110,
  },
  {
    key: 'equipmentModel',
    render: (_value, record) =>
      record.equipmentModelId === null ? '通用资料' : record.equipmentModelName,
    title: '适用设备型号',
    width: 200,
  },
  {
    dataIndex: 'description',
    key: 'description',
    ellipsis: true,
    render: (value: string | null) => value ?? '—',
    title: '文档说明',
  },
  {
    dataIndex: 'originalFilename',
    key: 'originalFilename',
    ellipsis: true,
    render: (value: string | null) => value ?? '纯文本',
    title: '原始文件名',
    width: 180,
  },
  { dataIndex: 'creatorNickname', key: 'creatorNickname', title: '创建人', width: 110 },
  {
    dataIndex: 'createdAt',
    key: 'createdAt',
    render: (value: string) => formatDateTimeText(value),
    title: '创建时间',
    width: 180,
  },
];

/**
 * 参考资料列表面板。
 *
 * - 标题搜索防抖；类型下拉与型号下拉筛选（型号选项走后端 equipmentModels）；
 * - 加载中 / 空列表 / 加载失败（含重试）/ 分页交互齐全；
 * - 空态区分筛选结果为空（total = 0）与当前页为空（保留分页器可回页，不形成死路）；
 * - 点击列表项进入详情路由；
 * - 两个变体共用同一份状态机与表格/分页结构，只切换**局部作用域类名前缀**：
 *   `knowledge-base` 变体供 /admin/document-database 消费（PR3 R7）：kb-card 外壳 +
 *   主搜索 + 筛选展开区 + 紧凑表格与卡底分页，新增入口由页面右上主操作区承担；
 *   默认变体供独立 /reference-documents 页消费（PR5 S3-1；评审修复轮 P1-1 补结构、
 *   复检轮 O1 去卡头；PR5 R2 筛选区默认收起）：保留通用 AntD Card 外壳但**不渲染卡头**
 *   （列表标题由页面 PageHeader 承载），卡内「工具区—筛选区（展开时）—表格—卡底分页」
 *   连续贴合，几何对齐知识库表格；且不挂任何 `.kb-*` 壳类，故整页 kb modifier 探针
 *   （PR3 回归）在该页恒为 0。
 *
 * 两个变体均**不渲染新增入口**（PR5 S3-2）：管理员新增属页面级主操作，由页面页头动作区
 * 承担；本组件不读取 Session、不判定角色，工程师与管理员的 DOM 差异只由页面层产生。
 */
type ReferenceDocumentListProps = {
  variant?: 'default' | 'knowledge-base';
};

export function ReferenceDocumentList({ variant = 'default' }: ReferenceDocumentListProps) {
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [documentType, setDocumentType] = useState<string | undefined>(undefined);
  const [equipmentModelId, setEquipmentModelId] = useState<number | undefined>(undefined);
  const [filterOpen, setFilterOpen] = useState(false);
  const models = useReferenceEquipmentModels();

  // 标题搜索防抖：输入即时回显，防抖后才触发列表重载
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(searchText);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText]);

  const filter = useMemo<ReferenceDocumentListFilter | undefined>(() => {
    const titleKeyword = debouncedKeyword.trim();
    const nextFilter: ReferenceDocumentListFilter = {};

    if (titleKeyword) {
      nextFilter.titleKeyword = titleKeyword;
    }

    if (documentType) {
      nextFilter.documentType = documentType;
    }

    if (equipmentModelId !== undefined) {
      nextFilter.equipmentModelId = equipmentModelId;
    }

    return Object.keys(nextFilter).length > 0 ? nextFilter : undefined;
  }, [debouncedKeyword, documentType, equipmentModelId]);

  const { state, goToPage, reload } = useReferenceDocumentList(filter);

  const hasActiveFilter =
    debouncedKeyword.trim().length > 0 ||
    documentType !== undefined ||
    equipmentModelId !== undefined;

  const resetFilters = () => {
    setSearchText('');
    setDocumentType(undefined);
    setEquipmentModelId(undefined);
  };

  const isKnowledgeBase = variant === 'knowledge-base';
  /** 局部作用域类前缀：知识库变体沿用 PR3 的 kb-*；独立资料页使用 reference-library-*。 */
  const scope = isKnowledgeBase ? 'kb' : 'reference-library';

  /**
   * 真实汇总条取值（PR5 整页视觉计划 S3）：三项全部来自本组件已取得的现有状态源，
   * 不新增第二次请求、不固定演示数字、不引入原型演示字段：
   * - 参考资料：列表状态机的 `state.total`（loading/failed 显示对应状态，不伪造数字）；
   * - 支持类型：后端契约枚举 `REFERENCE_DOCUMENT_TYPE_LABELS` 的真实类型集合；
   * - 适用型号：`useReferenceEquipmentModels()` 的真实型号数量（loading/failed 明确显示）。
   */
  const referenceTotalText =
    state.status === 'ready'
      ? `共 ${state.total} 条`
      : state.status === 'loading'
        ? '加载中…'
        : '加载失败';
  const documentTypesText = Object.values(REFERENCE_DOCUMENT_TYPE_LABELS).join(' · ');
  const equipmentModelsText =
    models.state.status === 'ready'
      ? `${models.state.models.length} 个型号`
      : models.state.status === 'loading'
        ? '加载中…'
        : '加载失败';
  /** 两个变体同构：筛选区默认收起（不渲染、占 0px），由工具区「筛选」按钮展开（PR5 R2）。
   *  收起不清值：`filterOpen` 只控制渲染，不参与 filter 计算。 */
  const filtersExpanded = filterOpen;

  /** 各状态的卡内边距：知识库变体落 `kb-card-state`，独立资料页落 `reference-library-card-state`
   * （两者同几何 1rem），使四态与工具区 / 表格处于同一张卡内的连续结构。 */
  const inCardState = (node: ReactNode) => <div className={`${scope}-card-state`}>{node}</div>;

  const listBody = (
    <>
      <div className={`${scope}-toolbar`}>
        <ToolbarSearchField
          className={`${scope}-search`}
          clearClassName={`${scope}-search-clear`}
          clearLabel="清除标题搜索"
          onChange={setSearchText}
          placeholder="按文档标题搜索"
          value={searchText}
        />
        <ToolbarButton
          active={hasActiveFilter}
          activeClassName={`${scope}-toolbar-button--active`}
          aria-expanded={filterOpen}
          className={`${scope}-toolbar-button`}
          onClick={() => setFilterOpen((previous) => !previous)}
        >
          筛选
        </ToolbarButton>
      </div>

      {filtersExpanded ? (
        <div className={`${scope}-filter-panel`}>
          <Select
            allowClear
            placeholder="文档类型"
            style={{ width: 160 }}
            value={documentType}
            onChange={(value) => setDocumentType(value)}
            options={Object.entries(REFERENCE_DOCUMENT_TYPE_LABELS).map(([value, label]) => ({
              label,
              value,
            }))}
          />
          <Select
            allowClear
            loading={models.state.status === 'loading'}
            placeholder="适用设备型号"
            style={{ width: 240 }}
            value={equipmentModelId}
            onChange={(value) => setEquipmentModelId(value)}
            options={
              models.state.status === 'ready'
                ? models.state.models.map((model) => ({
                    label: `${model.modelName}（${model.modelCode}）`,
                    value: model.id,
                  }))
                : []
            }
          />
          {hasActiveFilter ? (
            <ToolbarButton className={`${scope}-toolbar-button`} onClick={resetFilters}>
              重置
            </ToolbarButton>
          ) : null}
        </div>
      ) : null}

      {models.state.status === 'failed'
        ? inCardState(
            <Alert
              action={
                <Button onClick={models.reload} size="small">
                  重试
                </Button>
              }
              title={models.state.message}
              showIcon
              type="error"
            />,
          )
        : null}

      {state.status === 'loading' ? inCardState(<Skeleton active paragraph={{ rows: 6 }} />) : null}

      {state.status === 'failed'
        ? inCardState(
            <Alert
              action={
                <Button onClick={reload} size="small">
                  重试
                </Button>
              }
              title={state.message}
              showIcon
              type="error"
            />,
          )
        : null}

      {state.status === 'ready' && state.total === 0
        ? inCardState(
            <Empty
              description={hasActiveFilter ? '没有符合筛选条件的参考资料。' : '暂无参考资料。'}
            />,
          )
        : null}

      {state.status === 'ready' && state.total > 0 ? (
        <>
          {state.items.length > 0 ? (
            <div className={`${scope}-table-scope`}>
              <Table<ReferenceDocumentListItem>
                columns={columns}
                dataSource={state.items}
                onRow={(record) => ({
                  onClick: () => navigate(buildReferenceDocumentDetailPath(record.id)),
                  style: { cursor: 'pointer' },
                })}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1400 }}
              />
            </div>
          ) : (
            inCardState(<Empty description="当前页暂无数据，请翻页返回。" />)
          )}
          <div className={`${scope}-card-footer`}>
            <span>共 {state.total} 条</span>
            <Pagination
              current={state.page}
              onChange={goToPage}
              pageSize={state.pageSize}
              showSizeChanger={false}
              size="small"
              total={state.total}
            />
          </div>
        </>
      ) : null}
    </>
  );

  if (isKnowledgeBase) {
    return <div className="kb-card">{listBody}</div>;
  }

  // 默认变体（独立 /reference-documents 页，PR5 整页视觉计划 S3-1）：在列表卡之上渲染
  // 真实汇总条（三项取值见上方注释）。knowledge-base 内嵌变体不重复渲染本汇总条
  //（知识库页有自己的四分区汇总条）。
  return (
    <>
      <div className="reference-library-summary">
        <div className="reference-library-summary-cell">
          <div className="reference-library-summary-label">参考资料</div>
          <div className="reference-library-summary-value">{referenceTotalText}</div>
        </div>
        <div className="reference-library-summary-cell">
          <div className="reference-library-summary-label">支持类型</div>
          <div className="reference-library-summary-value">{documentTypesText}</div>
        </div>
        <div className="reference-library-summary-cell">
          <div className="reference-library-summary-label">适用型号</div>
          <div className="reference-library-summary-value">{equipmentModelsText}</div>
        </div>
      </div>
      <div className="reference-library-card">
        {/* 不渲染卡头：原型 .kb-card 内只有「工具区—表格—卡底」三段，列表标题由页面 PageHeader 承载
            （PR5 S3 复检轮 O1）。AntD Card 在无 title/extra 时不会生成 .ant-card-head。 */}
        <Card>
          <div className="reference-library-list-body">{listBody}</div>
        </Card>
      </div>
    </>
  );
}
