import type {
  EngineerResolutionStatus,
  RepairRequestAcceptanceViewStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { StoredFileBindingStatus, StoredFileStatus } from '@app-types/models/stored-file.types';
import type {
  IntakeAnalysisDisplayState,
  IntakeAnalysisRetryReason,
} from '@core/repair-request/policy/intake-analysis-retry.policy';

/**
 * AI 会话共享枚举兼容出口。
 *
 * 正本（唯一行为真源）在共享类型层 `@app-types/models/ai-conversation.types`：
 * adapter / DTO / enum registry 直接引用它，避免 adapter 运行时依赖 modules 实现。
 * 此处仅做转发，使既有 Entity 的 `'../lithography.types'` import 路径保持不变
 * （PR3 不修改 AI Entity 文件范围），不复制任何字符串值。
 */
export { AiConversationStatus, AiMessageRole } from '@app-types/models/ai-conversation.types';

/**
 * 设备型号读侧稳定视图（客户端可见字段）
 */
export type EquipmentModelView = {
  id: number;
  modelCode: string;
  modelName: string;
};

/**
 * 设备型号详情快照（含启用状态，供写流程启用状态校验）
 */
export type EquipmentModelDetailSnapshot = EquipmentModelView & {
  enabled: boolean;
};

/**
 * 维修申请写入数据（由 usecase 完成全部业务判定后传入）
 */
export type RepairRequestInsertData = {
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  /** 可信组织归属；无有效成员关系的自注册客户为 null（存量兼容语义） */
  ownerOrganizationId?: number | null;
  /** 报修原始输入主键（任务 03 提交即出单；旧调用方不传则为 null，保持存量语义） */
  intakeId?: number | null;
  /** 客户可信公司（必须是真实落库的 ID；仅 intakeId 非空时必填，实体 CHECK 兜底） */
  customerOrganizationId?: number | null;
  /** 选定维修厂家（必须是真实落库的 ID；仅 intakeId 非空时必填，实体 CHECK 兜底） */
  serviceOrganizationId?: number | null;
};

/**
 * 维修申请写入完成后的稳定快照（不暴露 ORM Entity）
 */
export type RepairRequestSnapshot = {
  id: number;
  requestNo: string;
  customerAccountId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  createdAt: Date;
  isAccepted: boolean;
  /** 逻辑删除事实；首析重试与删除并发裁决使用 */
  deprecated: boolean;
  /** 报修原始输入主键；旧工单为 null */
  intakeId: number | null;
  /** 客户公司 / 服务公司反规范化列；旧工单可空 */
  customerOrganizationId: number | null;
  serviceOrganizationId: number | null;
  /**
   * 归属公司（写入公司数据区的口径列，与备份/恢复范围一致）。
   *
   * 恢复期写入冻结按本列判定"这行属于哪家公司"：冻结期内对该公司的写入一律拒绝，
   * 避免恢复期间并发写入被整体替换掉。历史行为空 ⇒ 不属于任何公司数据区。
   */
  ownerOrganizationId?: number | null;
};

/**
 * 报修原始输入写入数据（任务 03「提交即出单」）。
 *
 * 全部字段都是服务端事实：客户账号来自会话、客户公司来自 `base_user_info`、
 * 服务公司与机型来自事务内复核/登记后的真实 ID；客户端只提供 recordUuid 与业务输入。
 * 分析状态由服务统一落 `WAITING` + 代次 0，不接受调用方指定。
 */
export type RepairRequestIntakeInsertData = {
  recordUuid: string;
  customerAccountId: number;
  customerOrganizationId: number;
  serviceOrganizationId: number;
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
  /** 客户私有报修原件；未上传为 null（绑定事实由同一事务内的原件绑定写入） */
  fileId: string | null;
};

/**
 * 报修原始输入稳定快照。
 *
 * 用途：
 * - 同标识重放核对（以落库事实逐字段比对，不依赖内容哈希列）；
 * - 第二段首析编排读取的可持久化执行意图（analysisStatus / analysisGeneration）。
 */
export type RepairRequestIntakeSnapshot = RepairRequestIntakeInsertData & {
  id: number;
  analysisStatus: string;
  analysisGeneration: number;
  convertedRequestId: number | null;
  createdAt: Date;
};

/**
 * 同标识重放核验的工单侧最小状态事实（任务 03 / PR #27 复审）。
 *
 * 重放返回原工单前，usecase 在事务内以此核验「工单仍有效 + 双向关联成立」；
 * 只携带裁决所需的状态列，不外发报修内容字段。
 */
export type RepairRequestReplayRequestState = {
  readonly id: number;
  readonly customerAccountId: number;
  /** 报修原始输入主键；双向关联核验要求与本原稿 id 一致 */
  readonly intakeId: number | null;
  /** 逻辑删除事实（deprecated 列）；已删除的重放不得返回成功 */
  readonly deprecated: boolean;
};

/**
 * 同标识重放核验的原稿侧最小状态事实（任务 03 / PR #27 复审）。
 *
 * 删除链路对原稿与工单同事务软删；本事实用于核验原稿未删除且
 * `converted_request_id` 与工单侧读到的关联一致（双向关联异常失败关闭）。
 */
export type RepairRequestReplayIntakeState = {
  readonly id: number;
  readonly customerAccountId: number;
  readonly convertedRequestId: number | null;
  /** 原稿逻辑删除事实（deleted_at 列非空即已删除） */
  readonly deleted: boolean;
};

/**
 * 首析认领结果（任务 03 第二段）。
 *
 * CLAIMED 携带 `attemptId` 作为本次执行的唯一归属凭据：
 * 认领事务在 intake 行锁内推进状态并插入 RUNNING 尝试行；
 * 租约过期接管会删除旧尝试行并插入新行，旧执行持有的 attemptId 随之失效，
 * 写回按「attempt 行存在且仍 RUNNING」仲裁，旧执行无法抢先或覆盖新执行的结果。
 */
export type IntakeAnalysisClaimResult =
  | {
      kind: 'CLAIMED';
      intakeId: number;
      generationNo: number;
      attemptId: number;
      startedAt: Date;
    }
  | { kind: 'ALREADY_SUCCEEDED'; intakeId: number; generationNo: number }
  | { kind: 'ALREADY_FAILED'; intakeId: number; generationNo: number }
  | { kind: 'LEASE_ACTIVE'; intakeId: number; generationNo: number }
  | {
      kind: 'NOT_EXECUTABLE';
      intakeId: number;
      reason: 'NOT_FOUND' | 'DELETED' | 'NOT_CONVERTED' | 'GENERATION_MISMATCH';
    }
  | { kind: 'ATTEMPT_STATE_INCONSISTENT'; intakeId: number; generationNo: number };

/** 首析写回输入：成功必须携带非空有效正文；失败携带受控稳定原因码 */
export type IntakeAnalysisFinishInput = {
  intakeId: number;
  generationNo: number;
  attemptId: number;
  outcome:
    | { kind: 'SUCCEEDED'; outputText: string; providerCallId: number | null }
    | { kind: 'FAILED'; failureReason: string; providerCallId: number | null };
};

/**
 * 首析写回结果：
 * - WRITTEN：归属核验通过且终态已落库；
 * - OWNERSHIP_LOST：执行凭据失效（租约被接管 / 代次已切换 / 迟到旧执行），
 *   不改变任何状态；
 * - REJECTED：目标不满足可写回前提（已删除 / 无工单 / 代次不匹配），
 *   不改变任何状态（已删除报修不得被迟到分析复活）。
 */
export type IntakeAnalysisFinishResult =
  | { kind: 'WRITTEN'; intakeId: number; generationNo: number }
  | { kind: 'OWNERSHIP_LOST'; intakeId: number; generationNo: number }
  | {
      kind: 'REJECTED';
      intakeId: number;
      reason: 'NOT_FOUND' | 'DELETED' | 'NOT_CONVERTED' | 'GENERATION_MISMATCH' | 'NOT_RUNNING';
    };

/** 首析主动重试的代次切换写入结果（affected = 1 才算切换成功） */
export type IntakeAnalysisGenerationBumpResult = {
  affected: number;
};

/**
 * 首析自助资格的写侧事实（事务内按 intake 行锁读取）。
 * 账本事实由 usecase 跨模块核对；本类型不包含任何运行期计数或缓存状态。
 */
export type IntakeAnalysisRetryWriteFacts = {
  intakeCustomerAccountId: number;
  intakeDeleted: boolean;
  convertedRequestId: number | null;
  generation: number;
  status: string;
  attemptGenerationNo: number | null;
  attemptStatus: string | null;
  attemptFailureReasonRecorded: boolean;
};

/**
 * 设备型号登记写入数据（手填机型在提交事务内按编码查重后再登记）。
 */
export type EquipmentModelInsertData = {
  modelCode: string;
  modelName: string;
};

/**
 * 维修申请原子接单写入数据。
 * engineerAccountId 仅来自后端 Session，acceptedAt 仅来自后端系统事件时间，
 * 两者均不得由客户端传入（由 UseCase 保证）。
 */
export type RepairRequestAcceptData = {
  requestId: number;
  engineerAccountId: number;
  acceptedAt: Date;
};

/**
 * 维修申请原子接单写入结果：仅表达 UseCase 裁决所需信息，不暴露 ORM Entity。
 * affected = 1 代表条件更新命中并写入成功；0 代表无可接单行，
 * 由 UseCase 结合最小状态读取区分“不存在/已删除”与“已接单”。
 */
export type RepairRequestAcceptWriteResult = {
  affected: number;
};

/**
 * 接单最小状态快照：仅供接单 UseCase 在条件更新未命中时裁决错误类别，
 * 不得流入 Adapter 或前端。
 */
export type RepairRequestAcceptanceStatusSnapshot = {
  id: number;
  isAccepted: boolean;
  deprecated: boolean;
};

/**
 * 回复目标最小状态快照：仅供回复 UseCase 在事务内做回复资格裁决，
 * 不得流入 Adapter 或前端。
 * 仅状态事实，不含权限决策；customerAccountId 与 acceptedByEngineerAccountId
 * 供 UseCase 派生归属与判断接单人身份，不直接对外输出。
 */
export type EngineerResponseTargetSnapshot = {
  id: number;
  customerAccountId: number;
  isAccepted: boolean;
  acceptedByEngineerAccountId: number | null;
  deprecated: boolean;
  /** 已结束事实（COMPLETED/UNRESOLVED/CLOSED）；旧行可空 */
  handlingStatus: string | null;
  closureStatus: string | null;
  /** 可信服务公司ID；intake 缺失、服务公司缺失或两处冲突时为 null（必须失败关闭） */
  serviceOrganizationId: number | null;
};

/**
 * 接单目标锁读快照：仅接单用例在事务内做组织范围与接单资格裁决，
 * 不得流入 Adapter 或前端。
 */
export type RepairRequestAcceptTargetSnapshot = {
  id: number;
  deprecated: boolean;
  isAccepted: boolean;
  /** 可信服务公司ID；intake 缺失、服务公司缺失或两处冲突时为 null（必须失败关闭） */
  serviceOrganizationId: number | null;
  /** 归属公司（写入冻结判定口径列，与备份/恢复范围一致） */
  ownerOrganizationId?: number | null;
};

/**
 * 工程师回复追加写入数据（由 UseCase 完成资格裁决后传入）。
 * engineerAccountId 仅来自可信 Session，customerAccountId 仅来自目标申请快照，
 * 两者均不得由客户端传入；responseText 已完成业务判定。
 */
export type EngineerResponseInsertData = {
  requestId: number;
  engineerAccountId: number;
  customerAccountId: number;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
};

/**
 * 工程师回复写入完成后的稳定快照（不暴露 ORM Entity）。
 * createdAt 为服务端系统事件时间。
 */
export type EngineerResponseWriteSnapshot = {
  id: number;
  requestId: number;
  engineerAccountId: number;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
  createdAt: Date;
};

/**
 * 工程师列表范围枚举（四态，默认 ALL）：
 * - ALL：全部未删除申请；
 * - AVAILABLE：未接单（待接单池）；
 * - MINE：当前工程师已接单；
 * - TAKEN_BY_OTHER：其他工程师已接单。
 * GraphQL 层以字符串表达，由 Usecase 校验，adapter 不导入本常量。
 */
export const REPAIR_REQUEST_ENGINEER_LIST_SCOPES = [
  'ALL',
  'AVAILABLE',
  'MINE',
  'TAKEN_BY_OTHER',
] as const;

export type RepairRequestEngineerListScope = (typeof REPAIR_REQUEST_ENGINEER_LIST_SCOPES)[number];

/**
 * 详情读入口的角色范围：客户入口与工程师入口按角色分开（负责人 20260901 裁定），
 * 同一 DTO 由 QueryService 按 scope 限定有效身份判定数据范围。
 */
export type RepairRequestDetailReadScope = 'CUSTOMER' | 'ENGINEER';

/**
 * 维修申请列表项稳定读视图。
 * 客户列表、工程师待接单列表、工程师已接单列表复用同一结构（对接方案第一节）；
 * 不暴露归属类账号 ID（customerAccountId / acceptedByEngineerAccountId）。
 */
export type RepairRequestListItemView = {
  id: number;
  requestNo: string;
  equipmentModel: EquipmentModelView;
  errorCode: string;
  createdAt: Date;
  isAccepted: boolean;
  acceptedAt: Date | null;
  /** 最新回复处理状态；尚无回复时为 null */
  latestResolutionStatus: EngineerResolutionStatus | null;
};

/** 客户列表项：在基础列表项上补充首析状态事实（仅本人列表装配；旧行无原稿时为 null） */
export type RepairRequestCustomerListItemView = RepairRequestListItemView & {
  /** 首析状态（WAITING/RUNNING/SUCCEEDED/FAILED）；无原稿关联的旧单为 null */
  analysisStatus: string | null;
  /** 首析代次（0=初次；1=唯一重试）；无原稿关联的旧单为 null */
  analysisGeneration: number | null;
};

/**
 * 工程师回复稳定读视图（对外契约）。
 * engineerNickname 为实时关联账号安全昵称（负责人裁定 3：不存快照，读时关联返回，
 * 缺失回落「工程师」由 usecase 保证）；不返回工程师账号 ID。
 */
export type EngineerResponseView = {
  id: number;
  engineerNickname: string;
  resolutionStatus: EngineerResolutionStatus;
  responseText: string;
  createdAt: Date;
};

/**
 * 工程师回复 QueryService 内部装配结果：含归属工程师账号 ID，
 * 仅供 usecase 跨域富集昵称使用，不对外输出。
 */
export type EngineerResponseQueryResult = Omit<EngineerResponseView, 'engineerNickname'> & {
  engineerAccountId: number;
};

/**
 * 列表分页参数（仅 OFFSET；第一版排序由契约固定，不提供客户端自定义排序）
 */
export type RepairRequestListPagination = {
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/**
 * 列表分页结果
 */
export type RepairRequestListPage = {
  items: RepairRequestListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 工程师列表可选筛选（对外契约）：
 * - equipmentModelId：设备型号等值筛选；
 * - customerNickname：客户昵称关键词（Usecase 完成 trim 归一，空白视为未提供；
 *   LIKE 通配符转义在账号域 QueryService 内完成）。
 */
export type RepairRequestEngineerListFilter = {
  equipmentModelId?: number;
  customerNickname?: string;
};

/**
 * 工程师列表筛选（QueryService 内部口径）：客户昵称已由 usecase 经账号域
 * 批量解析为客户账号 ID 集合，分页与 total 计算前即完成筛选（禁止先分页后过滤）。
 */
export type RepairRequestEngineerListFilterInternal = {
  equipmentModelId?: number;
  customerAccountIds?: number[];
};

/**
 * 工程师列表项 QueryService 内部装配结果：含归属类账号 ID，
 * 仅供 usecase 跨域富集客户/接单工程师展示资料使用，不对外输出。
 */
export type RepairRequestEngineerListItemQueryResult = RepairRequestListItemView & {
  customerAccountId: number;
  acceptedByEngineerAccountId: number | null;
  closureStatus?: string | null;
  closedAt?: Date | null;
  handlingResult?: RepairRequestHandlingResult | null;
  handlingStatus?: RepairRequestHandlingStatus | null;
};

/**
 * 工程师列表项稳定读视图：在基础列表项上补充客户/接单工程师安全展示资料
 * 与当前会话视角状态；昵称实时关联（缺失回落「客户」/「工程师」），不返回账号 ID。
 */
export type RepairRequestEngineerListItemView = RepairRequestListItemView & {
  customerNickname: string;
  customerCompanyName: string | null;
  acceptanceViewStatus: RepairRequestAcceptanceViewStatus;
  /** 接单工程师当前昵称；未接单为 null */
  acceptedEngineerNickname: string | null;
  /** 结单事实（CLOSED）；未结单为 null。仅用于列表展示真实工单进度 */
  closureStatus?: string | null;
  closedAt?: Date | null;
  handlingResult?: RepairRequestHandlingResult | null;
  handlingStatus?: RepairRequestHandlingStatus | null;
};

/**
 * 工程师列表分页结果（昵称富集后）
 */
export type RepairRequestEngineerListPage = {
  items: RepairRequestEngineerListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 工程师列表分页 QueryService 装配结果（昵称富集前）
 */
export type RepairRequestEngineerListQueryPage = {
  items: RepairRequestEngineerListItemQueryResult[];
  total?: number;
  page: number;
  pageSize: number;
};

/** 内部维修过程已绑定原件的安全展示字段（不暴露存储引用） */
export type RepairProcessEntryStoredFileView = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

/**
 * 内部维修过程写事务快照（模块内细粒度写操作产物）。
 * authorAccountId 仅用于事务内作者校验，不进入对外视图。
 */
export type RepairProcessEntrySnapshot = {
  id: string;
  entryUuid: string;
  requestId: number;
  authorAccountId: number;
  operationText: string;
  testResult: string | null;
  occurredAt: Date | null;
  timeSource: string;
  fileId: string | null;
  versionNo: number;
  createdAt: Date;
};

/** 内部维修过程稳定读视图：仅接单工程师可见，不暴露作者账号 ID */
export type RepairProcessEntryView = Omit<RepairProcessEntrySnapshot, 'authorAccountId'> & {
  file: RepairProcessEntryStoredFileView | null;
};

/**
 * 客户可见首析视图（仅客户入口装配；工程师入口走 `intake` 原始报修视图）。
 * 正文仅成功态返回真实模型输出；失败只给状态与代次，不向客户暴露受控失败原因细节。
 * displayState / retryEligibility 由服务端按可持久化事实判定（见
 * `@core/repair-request/policy/intake-analysis-retry.policy`），前端不自行组合。
 */
export type RepairRequestIntakeAnalysisCustomerView =
  RepairRequestIntakeAnalysisCustomerBaseView & {
    /** 服务端判定的展示状态（排队/运行/完成/失败可重试/失败不可自助/不可用） */
    displayState: IntakeAnalysisDisplayState;
    /** 自助重试资格：eligible 与稳定原因码（不含内部异常或任务标识） */
    retryEligibility: {
      eligible: boolean;
      reason: IntakeAnalysisRetryReason;
    };
  };

/**
 * 客户可见首析的持久化事实部分（QueryService 只读装配）。
 * 展示状态与重试资格需要跨模块读取投递账本，由 usecase 补账本事实后判定，
 * 因此读侧不直接产出最终视图，避免 QueryService 越层读其他模块。
 */
export type RepairRequestIntakeAnalysisCustomerBaseView = {
  status: string;
  generation: number;
  /** 首析正文；仅 SUCCEEDED 非空 */
  outputText: string | null;
  finishedAt: Date | null;
};

/**
 * 首析自助资格判定事实（QueryService 装配、usecase 补账本事实后判定的内部输入）。
 * 只承载可持久化事实，不进入对外视图，也不得由适配器消费。
 */
export type RepairRequestIntakeAnalysisRetryFacts = {
  requestId: number;
  intakeId: number;
  requestCustomerAccountId: number;
  intakeExists: boolean;
  intakeCustomerAccountId: number | null;
  intakeDeleted: boolean;
  convertedRequestId: number | null;
  generation: number;
  status: string;
  attemptGenerationNo: number | null;
  attemptStatus: string | null;
  attemptFailureReasonRecorded: boolean;
};

/** 客户报修原件安全展示字段（不暴露存储引用与校验和） */
export type RepairRequestOriginalFileView = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
};

/** 客户详情的维修厂家展示字段（仅名称与主键，不含联系信息） */
export type RepairRequestServiceOrganizationView = {
  id: number;
  name: string;
};

/**
 * 维修申请详情稳定读视图（客户与工程师入口共用结构，读权限由 QueryService 按身份判定）。
 * responses 按 createdAt ASC + id ASC 排序；不暴露归属类账号 ID。
 */
export type RepairRequestDetailView = {
  id: number;
  requestNo: string;
  equipmentModel: EquipmentModelView;
  errorCode: string;
  faultDescription: string;
  contentMd: string;
  createdAt: Date;
  isAccepted: boolean;
  acceptedAt: Date | null;
  /** 最新回复处理状态（按 createdAt DESC + id DESC 取末条）；尚无回复时为 null */
  latestResolutionStatus: EngineerResolutionStatus | null;
  responses: EngineerResponseView[];
  /** 结单事实（旧行可空）；客户可见，不包含内部过程与原件 */
  closureStatus: string | null;
  closedAt: Date | null;
  closureReason: string | null;
  handlingResult: RepairRequestHandlingResult | null;
  handlingStatus: RepairRequestHandlingStatus | null;
  /** 内部维修过程；仅接单工程师本人可见，客户入口恒为空数组 */
  processEntries: RepairProcessEntryView[];
  /** 结构化内部维修记录；仅工程师入口返回，客户入口为 null（不泄露内部记录与维修原件） */
  maintenance: RepairMaintenanceRecordView | null;
  /** 排查步骤；仅工程师入口返回，客户入口恒为空数组 */
  maintenanceSteps: RepairMaintenanceStepView[];
  /** 故障面板；仅工程师入口返回，客户入口恒为空数组 */
  maintenanceFaultPanels: RepairMaintenanceFaultPanelView[];
  /** 客户原始报修与首次 AI 分析；仅工程师入口返回，客户入口为 null */
  intake: RepairIntakeSourceView | null;
  /** 客户可见首析状态与正文；仅客户入口装配，工程师入口为 null（走 intake） */
  intakeAnalysis: RepairRequestIntakeAnalysisCustomerView | null;
  /** 客户报修原件安全字段；仅客户入口装配（下载走共用授权链路），工程师入口为 null */
  originalFile: RepairRequestOriginalFileView | null;
  /** 维修厂家（选定维修服务公司）；仅客户入口装配，工程师入口为 null */
  serviceOrganization: RepairRequestServiceOrganizationView | null;
  /** 当前会话是否可保存结构化维修记录（接单本人 + 未结束） */
  canEditMaintenance: boolean;
};

/**
 * 详情 QueryService 装配结果（昵称富集前）：回复含工程师账号 ID，
 * 另含归属类账号 ID，均由 usecase 跨域富集为安全展示字段后才对外输出，
 * 不得直接流入 Adapter。
 */
export type RepairRequestDetailQueryResult = Omit<
  RepairRequestDetailView,
  'responses' | 'intakeAnalysis'
> & {
  responses: EngineerResponseQueryResult[];
  customerAccountId: number;
  acceptedByEngineerAccountId: number | null;
  /** 首析持久化事实（未含展示状态与重试资格；由 usecase 判定后装配） */
  intakeAnalysis: RepairRequestIntakeAnalysisCustomerBaseView | null;
  /**
   * 客户入口首析自助资格判定事实（补账本事实后由 usecase 判定）；
   * 内部输入，不进入对外视图（客户入口无原稿关联或工程师入口为 null）。
   */
  intakeAnalysisRetryFacts: RepairRequestIntakeAnalysisRetryFacts | null;
};

/**
 * 工程师详情稳定读视图：在共用详情上补充客户/接单工程师安全展示资料
 * 与当前会话视角状态（TAKEN_BY_OTHER 只读，MINE 可回复，AVAILABLE 可接单）。
 */
export type RepairRequestEngineerDetailView = RepairRequestDetailView & {
  customerNickname: string;
  customerCompanyName: string | null;
  acceptanceViewStatus: RepairRequestAcceptanceViewStatus;
  /** 接单工程师当前昵称；未接单为 null */
  acceptedEngineerNickname: string | null;
};

/**
 * 维修申请软删除条件更新结果（模块内细粒度写操作产物，仅报告状态事实）。
 * 错误映射与幂等成功决策归 usecase（负责人 20260901 裁定 5）：
 * - DELETED：条件更新命中，软删除完成
 * - ALREADY_DELETED：本人已删除（幂等成功语义由 usecase 决定）
 * - NOT_FOUND_OR_NOT_OWNER：行不存在或非本人归属（统一口径，不泄露存在性）
 * - ALREADY_ACCEPTED：本人已接单（接单/删除互斥）
 */
export type RepairRequestDeleteOutcome =
  | { kind: 'DELETED'; id: number; requestNo: string }
  | { kind: 'ALREADY_DELETED'; id: number; requestNo: string }
  | { kind: 'NOT_FOUND_OR_NOT_OWNER'; id: number }
  | { kind: 'ALREADY_ACCEPTED'; id: number; requestNo: string };

// ---------- 历史维修记录库（0907.docx 任务二） ----------

/** 资料列表分页参数（仅 OFFSET；排序由契约固定：创建时间倒序 + 主键倒序） */
export type ReferenceDocumentListPagination = {
  page: number;
  pageSize: number;
  withTotal: boolean;
};

/** 资料列表筛选条件（标题模糊 + 文档类型等值 + 设备型号等值 + 案例处理状态等值，均可选） */
export type ReferenceDocumentListFilter = {
  title?: string;
  documentType?: string;
  equipmentModelId?: number;
  /** 案例处理状态等值筛选（UNRESOLVED/IN_PROGRESS/RESOLVED）；仅命中 FAULT_CASE 资料的案例明细 */
  caseHandlingStatus?: string;
};

/**
 * 正式资料案例明细稳定读视图（仅 FAULT_CASE 资料存在，普通资料为 null）。
 * 不返回 casePayloadJson / schemaVersion 等内部扩展字段。
 */
export type ReferenceDocumentCaseDetailView = {
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
};

/**
 * 资料列表项稳定读视图。
 * 默认仅返回未软删资料；创建人展示经 creatorNickname（实时关联，缺失回落），
 * 不返回 createdByAccountId；不返回 storageBackend/storageReference 与服务器路径；
 * 不携带 contentText 大字段（仅详情返回）。
 *
 * A-PR0 §4.3 新增字段：organizationName（组织展示名）、ingestMethod（来源信息，
 * ADMIN_DIRECT/REVIEWED_SUBMISSION）、equipmentModelText（机型文字）、
 * caseHandlingStatus（案例处理状态，普通资料为 null；列表不返回案例大段正文）。
 */
export type ReferenceDocumentListItemView = {
  id: number;
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  description: string | null;
  originalFilename: string | null;
  organizationName: string;
  ingestMethod: string;
  /** 来源类型：INDEPENDENT_REPORT / WORK_ORDER_SUMMARY / MATERIAL（任务 07 列表展示） */
  sourceKind: string;
  /** 生效管理修订号；0 表示原始冻结内容或原始正文 */
  effectiveRevisionNo: number;
  caseHandlingStatus: string | null;
  creatorNickname: string;
  createdAt: Date;
};

/** 列表项 QueryService 内部装配结果：创建人昵称富集前含账号 ID，仅供 usecase 跨域富集，不对外输出 */
export type ReferenceDocumentListItemQueryResult = Omit<
  ReferenceDocumentListItemView,
  'creatorNickname'
> & { createdByAccountId: number };

/**
 * 资料详情稳定读视图（元数据 + 文本内容）。
 * 不返回账号 ID、存储后端/存储引用与服务器路径（0907.docx：不能把服务器本地路径返回给浏览器）；
 * 「是否有文件」以衍生布尔 hasFile 对外（权威判定 = storageReference 非空，与下载/编辑防御真源一致）。
 *
 * A-PR0 §4.3 新增字段：organizationName（组织展示名）、ingestMethod（来源信息）、
 * equipmentModelText（机型文字）、caseDetail（案例明细，普通资料为 null，兼容旧组件）。
 */
export type ReferenceDocumentDetailView = {
  id: number;
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelName: string | null;
  equipmentModelText: string | null;
  description: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  hasFile: boolean;
  contentText: string | null;
  organizationName: string;
  ingestMethod: string;
  caseDetail: ReferenceDocumentCaseDetailView | null;
  creatorNickname: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 资料详情 QueryService 装配结果：含 storageReference 内部字段。
 * storageReference 仅供下载用例定位存储对象，不进入对外 DTO（DetailView 保持剥离）。
 */
export type ReferenceDocumentDetailQueryResult = Omit<
  ReferenceDocumentDetailView,
  'creatorNickname'
> & {
  createdByAccountId: number;
  /** 归属公司 ID（内部装配字段；owner_organization_id 可为 null，未知历史归属） */
  ownerOrganizationId: number | null;
  storageReference: string | null;
  /** 来源与状态事实：仅供 usecase 组装生效正文与可见性判断，不直接对外输出该结构 */
  sourceKind: string;
  sourceReportId: number | null;
  sourceReportVersionId: number | null;
  publicationStatus: string;
  ownershipStatus: string;
  effectiveRevisionNo: number;
  /** 内容快照 schema 版本（管理修订快照 JSON 的 schema_version 单一口径，不进入对外 DTO） */
  schemaVersion: number;
};

/** 资料列表分页结果 */
export type ReferenceDocumentListPage = {
  items: ReferenceDocumentListItemView[];
  total?: number;
  page: number;
  pageSize: number;
};

/**
 * 历史维修记录库读侧范围（列表 / 详情 / 历史版本 / 原件下载共用同一口径）。
 *
 * - ORGANIZATION：工程师与二级管理员，仅本公司已确认归属的正式资料；
 * - GLOBAL：一级管理员，全部公司已确认归属的正式资料（功能 V5.6 R055、页面 V6.5 §9.1）；
 * - 客户不产生任何范围（在 usecase 角色断言处拒绝）。
 *
 * 范围只决定「哪些公司的正式资料可读」；未知归属（ownership_status = PENDING）、
 * 下架（OFFLINE）、软删的行不在任何范围可见，谓词由 QueryService 统一叠加，
 * 他人未提交草稿不在本表，不因本范围可见。范围由服务端从可信会话与账号
 * 当前等级事实决议（见 reference-document-read-scope.ts），不接受客户端自报。
 */
export type ReferenceDocumentReadScope =
  | { kind: 'ORGANIZATION'; organizationId: number }
  | { kind: 'GLOBAL' }
  /**
   * 原作者删除本人正式资料（任务 07 R053）专用写路径范围：
   * 仅按 createdByAccountId = 会话账号收敛，不按组织收敛——归属更正可能把
   * 条目迁到其他公司，作者身份仍是删除资格的唯一依据（本人条目）。
   * 读路径不得使用本范围，避免绕过组织可见谓词。
   */
  | { kind: 'AUTHOR'; accountId: number };

/**
 * 生效正文来源：
 * - ORIGINAL：资料自身正文（无修订、无冻结报告来源）；
 * - FROZEN_REPORT：由任务 06 冻结报告版本发布，读取原始冻结快照；
 * - CURRENT_REVISION：存在生效的管理修订，读取修订后正文。
 */
export type ReferenceDocumentContentSource = 'ORIGINAL' | 'FROZEN_REPORT' | 'CURRENT_REVISION';

/** 冻结报告快照中对普通读者可见的内容事实（不包含账号内部标识与存储引用） */
export type ReferenceDocumentFrozenReportView = {
  versionId: number;
  versionNo: number;
  schemaVersion: number;
  submittedAt: Date;
  sourceType: string;
  repairRequestId: number | null;
  title: string;
  customerFactoryName: string;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  maintenanceDate: string;
  maintenanceEngineerName: string;
  alarms: Array<{
    alarmIndex: number;
    alarmCode: string;
    alarmDescription: string | null;
    phaseCode: string;
    resetResult: string;
  }>;
  steps: Array<{
    stepNo: number;
    stepCode: string;
    phaseCode: string;
    partName: string | null;
    actionText: string;
    resultText: string | null;
    newAlarmCode: string | null;
    isValidNewBranch: boolean;
  }>;
  ai: {
    usage: string;
    sourceType: string | null;
    sourceId: string | null;
    sourceVersion: string | null;
    score: number | null;
    correctness: string | null;
    helpfulness: number | null;
    note: string | null;
  };
  /**
   * 任务 07 管理修订（加法式扩展）：冻结快照任务 06 扩展键的结构化展示视图
   * （故障面板与维修结果字段）。任务 04 旧快照缺键按空值降级，不阻断既有展示。
   */
  faults: Array<{
    branchKind: string;
    stepCode: string | null;
    phaseCode: string | null;
    mainError: string | null;
    unitError: string | null;
    source: string | null;
    errorType: string | null;
    gpibStatus: string | null;
    faultStatus: string | null;
    description: string;
    action: string | null;
  }>;
  handlingResult: string | null;
  closureReason: string | null;
  resetResult: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
};

/** 资料结构化故障面板视图（任务 07 管理修订；分支枚举与任务 06 冻结快照一致） */
export type ReferenceDocumentStructuredFaultView = {
  branchKind: 'INITIAL' | 'RESET_NEW_FAULT' | 'STEP_NEW_FAULT';
  stepCode: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

/** 资料结构化排查步骤视图（任务 07 管理修订；stepCode 为稳定关联键） */
export type ReferenceDocumentStructuredStepView = {
  stepCode: string;
  stepNo: number;
  phaseCode: string | null;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: 'RESOLVED' | 'UNRESOLVED' | 'NEW_FAULT';
};

/**
 * 资料结构化内容视图（任务 07 管理修订；修订快照 structuredReport 键的读视图，
 * 形状与任务 06 冻结快照报告内容子集同构）。客户厂家/机型文字为继承事实。
 */
export type ReferenceDocumentStructuredContentView = {
  schemaVersion: number;
  maintenanceDate: string;
  maintenanceEngineerName: string;
  customerFactoryName: string;
  equipmentModelText: string | null;
  resetResult: 'NORMAL' | 'SAME_FAULT' | 'NEW_FAULT';
  faults: ReferenceDocumentStructuredFaultView[];
  steps: ReferenceDocumentStructuredStepView[];
  handlingResult: string | null;
  closureReason: string | null;
  actualCause: string | null;
  repairActions: string | null;
  verificationResult: string | null;
  supplementaryNote: string | null;
};

/**
 * 资料生效修订摘要（历史版本读取）。
 * contentText 取自该修订 after_snapshot 的内容键：授权追溯可查看旧管理修订
 * 版本的具体生效内容（V5.6 版本追溯要求），而非仅版本号与摘要。
 */
export type ReferenceDocumentRevisionSummaryView = {
  revisionNo: number;
  reason: string;
  actorAccountId: number;
  createdAt: Date;
  /** 该修订版本的生效正文（after_snapshot.contentText；快照缺内容键时为 null） */
  contentText: string | null;
};

/**
 * 来源报告冻结版本的原件附件视图（任务 07 P2：有权读者可经资料详情下载入口授权下载）。
 * 只含展示与下载所需的公开标识（R062-02 口径：fileId 允许返回，不暴露存储引用与路径）。
 */
export type ReferenceDocumentSourceAttachmentView = {
  attachmentId: number;
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
};

/**
 * 历史维修记录库详情稳定读视图：基础详情 + 来源/状态/生效版本与生效正文。
 *
 * - contentText 为「生效正文」：存在管理修订时取修订后正文，否则取原始正文；
 * - frozenReport 仅在 sourceKind 为报告来源且尚无管理修订时非空；
 * - 仅 ONLINE + CONFIRMED + 未软删的行可读取（不可见行统一 NOT_FOUND）。
 */
export type ReferenceDocumentLibraryDetailView = ReferenceDocumentDetailView & {
  sourceKind: string;
  publicationStatus: string;
  ownershipStatus: string;
  effectiveRevisionNo: number;
  sourceReportId: number | null;
  sourceReportVersionId: number | null;
  /** 当前会话账号是否为本条资料的原作者（R053 作者删除入口依据；不返回账号 ID） */
  viewerIsOriginalAuthor: boolean;
  contentSource: ReferenceDocumentContentSource;
  frozenReport: ReferenceDocumentFrozenReportView | null;
  /** 任务 07 管理修订：生效修订携带结构化内容键时返回（旧扁平修订为 null） */
  structuredContent: ReferenceDocumentStructuredContentView | null;
  /**
   * 来源报告冻结版本的原件附件（任务 07 P2；按冻结版本附件绑定装配，
   * 不回退当前报告附件列表；无冻结原件或引用失效为 null）
   */
  sourceReportAttachment: ReferenceDocumentSourceAttachmentView | null;
};

/**
 * 资料创建写入数据（由 usecase 完成全部业务判定后传入）。
 * createdByAccountId 仅来自可信 Session，不得由客户端传入；
 * ownerOrganizationId 由可信组织上下文解析（A-PR0 §2.1），不得由客户端传入；
 * ingestMethod 固定 ADMIN_DIRECT（管理员直建；审核发布路径由 S5 写 REVIEWED_SUBMISSION）；
 * 内容来源为正文或文件至少一个（chk_reference_document_content_source 兜底）：
 * 纯文本创建时存储四字段为 null；文件创建时存储引用由服务端生成（不可猜测、无路径语义）。
 */
export type ReferenceDocumentInsertData = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelText?: string | null;
  description: string | null;
  contentText: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  storageBackend: string | null;
  storageReference: string | null;
  createdByAccountId: number;
  ownerOrganizationId: number;
  ingestMethod: string;
  // 审核发布（REVIEWED_SUBMISSION）来源回链；管理员直建不传
  // （同空或同有与「正式资料与来源投稿同组织」由 CHECK/外键与用例事务内核验保证）
  sourceSubmissionId?: number | null;
  sourceRevisionId?: number | null;
  /**
   * R051-01 报告来源回链（方案二）：正式提交时写入报告来源与冻结版本；
   * sourceKind 覆盖默认 MATERIAL，INDEPENDENT_REPORT/WORK_ORDER_SUMMARY
   * 必须同时提供 sourceReportId 与 sourceReportVersionId（实体 CHECK 兜底）。
   * uk_reference_document_source_report_version 保证一份冻结版本至多一份正式资料。
   */
  sourceKind?: string;
  sourceReportId?: number | null;
  sourceReportVersionId?: number | null;
  extensionJson?: Record<string, unknown> | null;
  schemaVersion?: number;
};

/**
 * 正式故障案例明细写入数据（审核发布插入时由发布用例从冻结快照组装）。
 * 满足实体 chk_reference_document_case_detail_status / resolution：
 * handling_status 受控值域；RESOLVED 时 resolution 必填非空。
 */
export type ReferenceDocumentCaseDetailInsertData = {
  documentId: number;
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
  casePayloadJson?: Record<string, unknown> | null;
};

/**
 * 正式故障案例明细更正写入数据（A-PR0 §S6 专属更正，全量覆盖式更新）。
 * 由 usecase 在合并后的最终态上完成校验（必填存在性、RESOLVED 必填结果）后传入；
 * casePayloadJson / schemaVersion / 创建时间不在更正文范围内（维持原值）。
 */
export type ReferenceDocumentCaseDetailUpdateData = {
  documentId: number;
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
};

/**
 * 资料编辑写入数据（由 usecase 完成字段合并与校验后传入，全量覆盖式更新）。
 * 满足实体 chk_reference_document_content_source：正文与已有存储引用至少存在一个；
 * 编辑不支持替换/移除文件，存储四列维持原值。
 */
export type ReferenceDocumentUpdateData = {
  documentId: number;
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  description: string | null;
  contentText: string | null;
  /**
   * 机型文字（S6 案例更正扩展）：未传（undefined）时不更新该列（通用编辑不参与）；
   * 显式 null 表示清空（与 chk_reference_document_model_exclusive 互补）
   */
  equipmentModelText?: string | null;
  /** 最后修改人（S6 案例更正扩展，正式更正必写）：未传时不更新该列（历史来源行保持可空） */
  updatedByAccountId?: number;
};

/**
 * 资料软删除条件更新结果（仅状态事实，不表决策；错误映射归 usecase）。
 * - DELETED：条件更新命中，软删除完成
 * - NOT_FOUND：行不存在或已软删（负责人 docx 口径统一 NOT_FOUND，不泄露删除状态）
 */
export type ReferenceDocumentDeleteOutcome =
  { kind: 'DELETED'; id: number } | { kind: 'NOT_FOUND'; id: number };

// ---------- 共用业务原件（任务 11） ----------

/**
 * 原件写入完成后的稳定快照（不暴露 ORM Entity）。
 * byteSize 由 bigint 列转安全整数（迁移 CHECK 上限 20,000,000，远小于 JS 安全整数上限）。
 */
export type StoredFileSnapshot = {
  fileId: string;
  uploadedByAccountId: number;
  ownerOrganizationId: number;
  storageReference: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  status: string;
  businessType: string;
  businessId: string | null;
  uploadContextId: string;
  bindingStatus: string;
  createdAt: Date;
  verifiedAt: Date | null;
};

/**
 * 原件安全元数据读视图：对外只暴露业务与校验事实，
 * 不包含 storageReference、服务器路径、上传者/归属公司账号 ID。
 */
export type StoredFileMetadataView = {
  fileId: string;
  businessType: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  status: StoredFileStatus;
  bindingStatus: StoredFileBindingStatus;
  businessId: string | null;
  uploadContextId: string;
  verifiedAt: Date | null;
  createdAt: Date;
};

/** 原件暂存写入数据（业务判定全部由 usecase 完成后传入） */
export type StoredFileInsertData = {
  fileId: string;
  uploadedByAccountId: number;
  ownerOrganizationId: number;
  storageReference: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  businessType: string;
  uploadContextId: string;
};

/** 绑定前置的工单锁读快照：只含状态事实，决策归 usecase */
export type RepairProcessBindingTargetSnapshot = {
  id: number;
  /** 旧归属列，仅作历史事实保留；不用于服务公司授权 */
  ownerOrganizationId: number | null;
  /** 报修原始输入ID；空表示旧工单，服务公司来源不可确认 */
  intakeId: number | null;
  /** 可信服务公司ID（仅由报修原始输入解析；非工单旧字段兜底） */
  serviceOrganizationId: number | null;
  isAccepted: boolean;
  acceptedByEngineerAccountId: number | null;
  deprecated: boolean;
  handlingStatus: string | null;
  closureStatus: string | null;
  /** 维修记录版本号；结单必须基于确认时看到的版本 */
  maintenanceVersionNo: number;
};

// ---------- 结构化内部维修记录（任务 04） ----------

/** 维修附件安全展示字段（不暴露存储引用与上传者/公司账号 ID） */
export type RepairMaintenanceAttachmentView = {
  fileId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};

/** 排查步骤读视图 */
export type RepairMaintenanceStepView = {
  id: string;
  stepNo: number;
  errorCode: string | null;
  partName: string | null;
  actionText: string;
  resultCode: string;
};

/** 故障面板读视图 */
export type RepairMaintenanceFaultPanelView = {
  id: string;
  panelType: string;
  stepId: string | null;
  phaseCode: string | null;
  mainError: string | null;
  unitError: string | null;
  source: string | null;
  errorType: string | null;
  gpibStatus: string | null;
  faultStatus: string | null;
  description: string;
  action: string | null;
};

/** 工单维修事实读视图（日期为 YYYY-MM-DD 字符串，不回传时区语义） */
export type RepairMaintenanceRecordView = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  versionNo: number;
  attachment: RepairMaintenanceAttachmentView | null;
};

/**
 * 工程师可见的修订快照：仅维修事实、排查步骤与故障面板。
 * 不包含附件、处理结果、结单信息或其他管理员快照字段。
 */
export type EngineerRepairRevisionSnapshotView = {
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  steps: RepairMaintenanceStepView[];
  panels: RepairMaintenanceFaultPanelView[];
};

/** 修订对比不可用原因（稳定码，由前端本地化） */
export type EngineerRepairRevisionCompareUnavailableReason =
  'NO_COMPARABLE_SNAPSHOT' | 'NO_VISIBLE_MAINTENANCE_CHANGE';

/** 工程师修订历史行查询结果（含内部修订人账号 ID，由用例富集昵称后剥离） */
export type EngineerRepairRevisionHistoryItemQueryResult = {
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorAccountId: number;
  createdAt: Date;
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
  compareUnavailableReason: EngineerRepairRevisionCompareUnavailableReason | null;
};

export type EngineerRepairRevisionHistoryItemView = Omit<
  EngineerRepairRevisionHistoryItemQueryResult,
  'actorAccountId'
> & { actorNickname: string };

/** 工程师修订详情查询结果：只含工程师可见的维修快照与必要历史元数据 */
export type EngineerRepairRevisionDetailQueryResult = {
  requestId: number;
  revisionNo: number;
  previousVersion: number;
  reason: string;
  actorAccountId: number;
  createdAt: Date;
  hasComparableSnapshot: boolean;
  hasVisibleMaintenanceChange: boolean;
  compareUnavailableReason: EngineerRepairRevisionCompareUnavailableReason | null;
  before: EngineerRepairRevisionSnapshotView | null;
  after: EngineerRepairRevisionSnapshotView | null;
};

export type EngineerRepairRevisionDetailView = Omit<
  EngineerRepairRevisionDetailQueryResult,
  'actorAccountId'
> & { actorNickname: string };

/** 首次 AI 分析读视图（仅工程师/管理员可见） */
export type RepairIntakeAnalysisView = {
  status: string;
  generation: number;
  outputText: string | null;
  failureReason: string | null;
  finishedAt: Date | null;
};

/** 客户原始报修读视图（工程师/管理员可见；客户入口不返回） */
export type RepairIntakeSourceView = {
  intakeId: number;
  faultDescription: string;
  customerFile: RepairMaintenanceAttachmentView | null;
  analysis: RepairIntakeAnalysisView | null;
};

/** 维修保存目标锁读快照（仅用例在事务内裁决，不对外） */
export type RepairRequestMaintenanceTargetSnapshot = {
  id: number;
  intakeId: number | null;
  serviceOrganizationId: number | null;
  /** 归属公司（写入冻结判定口径列，与备份/恢复范围一致） */
  ownerOrganizationId?: number | null;
  isAccepted: boolean;
  acceptedByEngineerAccountId: number | null;
  deprecated: boolean;
  handlingStatus: string | null;
  closureStatus: string | null;
  maintenanceAttachmentFileId: string | null;
  maintenanceVersionNo: number;
};

/** 维修保存写入数据（业务判定与归一已完成） */
export type RepairMaintenanceSaveData = {
  requestId: number;
  expectedVersion: number;
  maintenanceDate: string | null;
  engineerName: string | null;
  resetResult: string | null;
  supplementaryNote: string | null;
  steps: ReadonlyArray<{
    id: string | null;
    stepNo: number;
    errorCode: string | null;
    partName: string | null;
    actionText: string;
    resultCode: string;
  }>;
  panels: ReadonlyArray<{
    id: string | null;
    panelType: string;
    stepNo: number | null;
    phaseCode: string | null;
    mainError: string | null;
    unitError: string | null;
    source: string | null;
    errorType: string | null;
    gpibStatus: string | null;
    faultStatus: string | null;
    description: string;
    action: string | null;
  }>;
};

/**
 * 下载定位结果：storageReference 不进入对外视图，仅供下载用例读取存储；
 * byteSize/checksumSha256 为登记事实，仅供用例在发送前核对实际内容。
 */
export type StoredFileDownloadFacts = {
  fileId: string;
  storageReference: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
};
