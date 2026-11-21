// src/features/repair-request/application/use-repair-request-create-flow.ts

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { type MessageKey, translateNow } from '@/shared/i18n';

import type {
  CreateRepairRequestFailureReason,
  EquipmentModelOption,
  RepairRequestRecord,
  ServiceOrganizationOption,
} from '../infrastructure/repair-request.types';
import {
  createRepairRequest,
  fetchEquipmentModels,
  fetchRepairServiceOrganizations,
  fetchTrustedCompanyName,
  uploadRepairRequestFile,
} from '../infrastructure/repair-request-adapter';
import type { StagedStoredFile } from '../infrastructure/stored-file-upload';

/**
 * 客户创建维修申请流程（型号 query + 厂家 query + 原件上传 + 幂等提交，收束在 feature application）。
 *
 * 行为口径：
 * - 型号三态：loading / failed（含共享错误模型用户文案与重试）/ ready（含空态）；
 * - 厂家三态同上，并支持按关键字重新检索（空关键字即拉取默认首页）；
 * - 原件为可选暂存上传：失败保留表单内容，成功后持有 fileId + uploadContextId，
 *   提交失败不丢弃（同一附件可随同一次提交标识重试）；每次上传持有可失效的请求
 *   标识（PR #27 复审）：取消、清空、开始新上传或卸载后，旧上传的成败结果一律作废，
 *   不回填当前状态；提交载荷使用提交开始时页面展示的附件快照；
 * - 可信公司名称三态（loading / failed / ready，含未绑定 null），只读展示给表单核对；
 * - 提交标识（recordUuid）在本层持有：双击由在途锁拦截，业务/网络失败后重发复用同一标识，
 *   保证「同一份报修只形成一套数据」；提交成功后换新标识，避免「继续创建」被当成重放；
 *   「原申请已删除」的失败保留同一标识（不自动重建工单），仅 restartSubmission
 *   在用户明确重新发起时换新标识；
 * - 输入归一（错误码、故障描述、手填机型去首尾空格）在本层收口，ui 只回传表单原始值；
 * - submit 成功时返回真实创建记录（含真实 id，ui 据此进入成功态并联动列表）；失败返回 null。
 */

/** 提交输入：表单原始值（ui 不做归一，去首尾空格在 application 收口） */
export type RepairRequestCreateFormValues = {
  serviceOrganizationId: number;
  equipmentModelId?: number | null;
  equipmentModelText?: string | null;
  errorCode: string;
  faultDescription: string;
};

/** 型号加载状态：页/表单只需消费干净状态，不感知 adapter 与竞态细节 */
export type RepairRequestModelsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; models: EquipmentModelOption[] };

/** 厂家候选状态（关键字检索共用同一状态机） */
export type RepairRequestServiceOrgsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; organizations: ServiceOrganizationOption[] };

/** 可选原件上传状态 */
export type RepairRequestAttachmentState =
  | { status: 'idle' }
  | { status: 'uploading'; filename: string }
  | { status: 'ready'; file: StagedStoredFile }
  | { status: 'failed'; message: string };

/**
 * 可信公司名称三态（PR #27 复审：报修表单只读展示真实所属公司）。
 * 名称取自 `myAccountSettings.trustedCompanyName`（服务端按可信组织事实解析）；
 * ready 且为 null 表示账号未绑定公司，不展示任何虚构名称。
 */
export type RepairRequestCompanyState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; trustedCompanyName: string | null };

function toUserMessage(error: unknown, fallbackKey: MessageKey): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow(fallbackKey);
}

/** 纯拉取：只产出下一状态，不直接写 state，供初始加载与重试共用 */
async function loadEquipmentModelsState(): Promise<RepairRequestModelsState> {
  try {
    const models = await fetchEquipmentModels();

    return { status: 'ready', models };
  } catch (error) {
    return {
      status: 'failed',
      message: toUserMessage(error, 'common.modelsLoadFailed'),
    };
  }
}

async function loadCompanyState(): Promise<RepairRequestCompanyState> {
  try {
    const trustedCompanyName = await fetchTrustedCompanyName();

    return { status: 'ready', trustedCompanyName };
  } catch (error) {
    return {
      status: 'failed',
      message: toUserMessage(error, 'repairForm.companyLoadFailed'),
    };
  }
}

async function loadServiceOrganizationsState(
  keyword: string,
): Promise<RepairRequestServiceOrgsState> {
  try {
    const organizations = await fetchRepairServiceOrganizations({ keyword });

    return { status: 'ready', organizations };
  } catch (error) {
    return {
      status: 'failed',
      message: toUserMessage(error, 'repairForm.serviceOrgsLoadFailed'),
    };
  }
}

/**
 * 生成稳定提交标识：优先 Web Crypto（浏览器安全上下文），
 * 缺失时退化为 RFC 4122 v4 形态的时间 + 随机拼装，仍满足后端 36 位 UUID 校验。
 */
function createSubmissionKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const random = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return `${random()}${random()}-${random()}-4${random().slice(1)}-a${random().slice(1)}-${random()}${random()}${random()}`;
}

export function useRepairRequestCreateFlow() {
  const [modelsState, setModelsState] = useState<RepairRequestModelsState>({ status: 'loading' });
  const [serviceOrgsState, setServiceOrgsState] = useState<RepairRequestServiceOrgsState>({
    status: 'loading',
  });
  const [companyState, setCompanyState] = useState<RepairRequestCompanyState>({
    status: 'loading',
  });
  const [attachment, setAttachment] = useState<RepairRequestAttachmentState>({ status: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * 最近一次业务拒绝的稳定原因（null 表示没有业务拒绝，例如 transport 失败）。
   * 供 ui 在「需先补录公司」时展示账号设置引导，而不是只显示通用失败文案。
   */
  const [submitFailureReason, setSubmitFailureReason] =
    useState<CreateRepairRequestFailureReason | null>(null);
  const [createdRequest, setCreatedRequest] = useState<RepairRequestRecord | null>(null);
  const submittingRef = useRef(false);
  /** 稳定提交标识：一次填写一份报修；提交成功（或「继续创建」）后换新 */
  const recordUuidRef = useRef<string>(createSubmissionKey());
  /** 厂家关键字检索的请求序号：只回写最后一次检索结果 */
  const serviceOrgsRequestRef = useRef(0);
  /**
   * 原件上传的请求标识（PR #27 复审）：每次开始上传自增；取消/清空/重新发起/
   * 卸载时再自增作废全部在途上传。晚到的旧上传结果凭标识不一致被丢弃，
   * 不回填当前表单状态；服务端暂存文件仍由任务 11 的生命周期管理，这里不做删除。
   */
  const uploadRequestRef = useRef(0);
  /** 卸载守卫：异步回写前确认组件仍挂载 */
  const mountedRef = useRef(true);
  /**
   * 附件状态的同步引用：submit 以「提交开始时刻」的附件快照构造载荷，
   * 保证实际提交的附件与页面当前展示的有效附件一致（提交中状态变化不影响本次载荷）。
   */
  const attachmentRef = useRef<RepairRequestAttachmentState>({ status: 'idle' });
  /** state 与 ref 同步收口：所有附件状态变更都必须走这里 */
  const applyAttachment = useCallback((next: RepairRequestAttachmentState) => {
    attachmentRef.current = next;
    setAttachment(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      // 卸载即作废全部在途上传：晚到的成败结果不再尝试回写
      uploadRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadEquipmentModelsState().then((state) => {
      if (!cancelled) {
        setModelsState(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++serviceOrgsRequestRef.current;

    void loadServiceOrganizationsState('').then((state) => {
      if (!cancelled && requestId === serviceOrgsRequestRef.current) {
        setServiceOrgsState(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadCompanyState().then((state) => {
      if (!cancelled) {
        setCompanyState(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const retryLoadModels = useCallback(() => {
    setModelsState({ status: 'loading' });
    void loadEquipmentModelsState().then((state) => {
      if (mountedRef.current) {
        setModelsState(state);
      }
    });
  }, []);

  /** 按关键字重新检索厂家（空关键字回退默认首页）；只回写最后一次检索 */
  const searchServiceOrganizations = useCallback((keyword: string) => {
    const requestId = ++serviceOrgsRequestRef.current;
    setServiceOrgsState({ status: 'loading' });

    void loadServiceOrganizationsState(keyword).then((state) => {
      if (mountedRef.current && requestId === serviceOrgsRequestRef.current) {
        setServiceOrgsState(state);
      }
    });
  }, []);

  const retryLoadServiceOrganizations = useCallback(() => {
    searchServiceOrganizations('');
  }, [searchServiceOrganizations]);

  const retryLoadCompany = useCallback(() => {
    setCompanyState({ status: 'loading' });
    void loadCompanyState().then((state) => {
      if (mountedRef.current) {
        setCompanyState(state);
      }
    });
  }, []);

  /**
   * 上传可选原件（暂存态）；失败只提示，不阻断表单其它字段。
   *
   * 请求标识失效（PR #27 复审）：开始新上传即自增令牌，使上一个在途上传的结果作废；
   * 回写前校验令牌与挂载状态，取消/清空/开始新上传/卸载后晚到的成败结果一律丢弃，
   * 不覆盖当前状态（旧失败晚到同样不覆盖，避免旧错误污染新附件状态）。
   */
  const uploadAttachment = useCallback(
    async (file: File) => {
      const requestId = ++uploadRequestRef.current;
      applyAttachment({ status: 'uploading', filename: file.name });

      const result = await uploadRepairRequestFile(file);
      if (!mountedRef.current || requestId !== uploadRequestRef.current) {
        return;
      }

      if (result.ok) {
        applyAttachment({ status: 'ready', file: result.file });

        return;
      }

      applyAttachment({ status: 'failed', message: result.message });
    },
    [applyAttachment],
  );

  /** 清空附件状态：同时作废全部在途上传（旧成功/失败/异常结果不再回填） */
  const clearAttachment = useCallback(() => {
    uploadRequestRef.current += 1;
    applyAttachment({ status: 'idle' });
  }, [applyAttachment]);

  /**
   * 提交创建。成功时返回真实创建记录（含真实 id，供 ui 进入成功态并上报联动）；失败返回 null。
   *
   * 附件口径（PR #27 复审）：载荷使用提交开始时刻 `attachmentRef` 的附件快照——
   * 页面当前展示的有效附件即实际提交的附件，提交期间的并发状态变化不影响本次载荷。
   */
  const submit = useCallback(
    async (values: RepairRequestCreateFormValues): Promise<RepairRequestRecord | null> => {
      if (submittingRef.current) {
        return null;
      }
      const attachmentSnapshot = attachmentRef.current;
      if (attachmentSnapshot.status === 'uploading') {
        setSubmitError(translateNow('repairForm.attachmentUploading'));

        return null;
      }

      submittingRef.current = true;
      setSubmitting(true);
      setSubmitError(null);
      setSubmitFailureReason(null);

      const manualModelText = values.equipmentModelText?.trim() ?? '';

      try {
        const result = await createRepairRequest({
          recordUuid: recordUuidRef.current,
          serviceOrganizationId: values.serviceOrganizationId,
          equipmentModelId: manualModelText ? null : (values.equipmentModelId ?? null),
          equipmentModelText: manualModelText ? manualModelText : null,
          errorCode: values.errorCode.trim(),
          faultDescription: values.faultDescription.trim(),
          attachment:
            attachmentSnapshot.status === 'ready'
              ? {
                  fileId: attachmentSnapshot.file.fileId,
                  uploadContextId: attachmentSnapshot.file.uploadContextId,
                }
              : null,
        });

        if (result.ok) {
          // 成功后换新标识：下一次填写是新的报修，不能复用已落库的提交标识
          recordUuidRef.current = createSubmissionKey();
          setCreatedRequest(result.repairRequest);

          return result.repairRequest;
        }

        // 业务拒绝展示后端消息并保留表单内容，不做乐观成功；
        // 提交标识保持不变：同内容重试仍会被后端识别为同一份报修。
        // 「原申请已删除」同样保留标识：重试被服务端失败关闭，
        // 只有用户明确重新发起（restartSubmission）才换新标识，不自动创建新工单
        setSubmitError(result.message);
        setSubmitFailureReason(result.reason);

        return null;
      } catch (error) {
        setSubmitError(toUserMessage(error, 'repairForm.submitFailed'));

        return null;
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) {
          setSubmitting(false);
        }
      }
    },
    [],
  );

  const continueCreating = useCallback(() => {
    setCreatedRequest(null);
    clearAttachment();
    // 防御性换新：即便某条路径没走到成功分支，也不复用上一次标识
    recordUuidRef.current = createSubmissionKey();
  }, [clearAttachment]);

  /**
   * 用户明确重新发起（「原申请已删除」后的显式动作）：换新提交标识并清空提交错误，
   * 表单内容保留供直接改后重发。此前的附件状态一并作废（该附件属于已删除的
   * 原申请；服务端文件仍归任务 11 生命周期管理，此处只清 UI 引用，不删除服务端文件）。
   */
  const restartSubmission = useCallback(() => {
    setSubmitError(null);
    setSubmitFailureReason(null);
    clearAttachment();
    recordUuidRef.current = createSubmissionKey();
  }, [clearAttachment]);

  return {
    attachment,
    clearAttachment,
    companyState,
    continueCreating,
    createdRequest,
    modelsState,
    restartSubmission,
    retryLoadCompany,
    retryLoadModels,
    retryLoadServiceOrganizations,
    searchServiceOrganizations,
    serviceOrgsState,
    submit,
    submitting,
    submitError,
    submitFailureReason,
    uploadAttachment,
  };
}
