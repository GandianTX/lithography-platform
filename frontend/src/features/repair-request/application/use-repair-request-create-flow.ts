// src/features/repair-request/application/use-repair-request-create-flow.ts

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { type MessageKey, translateNow } from '@/shared/i18n';

import type {
  CreateRepairRequestFailureReason,
  EquipmentModelOption,
  RepairRequestRecord,
} from '../infrastructure/repair-request.types';
import {
  createRepairRequest,
  fetchEquipmentModels,
} from '../infrastructure/repair-request-adapter';

/**
 * 客户创建维修申请流程（型号 query 三态 + create command，收束在 feature application）。
 *
 * 从创建表单（ui）搬出的原因：表单原先同时持有型号 query 的加载状态机、重试编排、
 * create command 与在途锁，`ui` 不应吞掉业务编排与数据访问（stable-clean architecture §5）。
 * 搬出后 `ui` 只剩「渲染 + 把编排结果转成提示、重置与导航」。
 *
 * 行为口径（与搬出前逐字一致）：
 * - 型号三态：loading / failed（含共享错误模型用户文案与重试）/ ready（含空态，
 *   空态同样可重试拉取，用户无需刷新整页）；
 * - 初次加载带 cancelled 守卫，卸载后不再回写状态；
 * - create command：进行中以防连点 ref 拦重复提交；业务拒绝展示后端消息并保留表单内容，
 *   transport 失败展示共享错误模型的用户文案；
 * - 输入归一（错误码与故障描述去首尾空格）在本层收口，ui 只回传表单原始值；
 * - submit 成功时返回真实创建记录（含真实 id，ui 据此重置表单并进入成功态，
 *   工作台据此刷新左栏列表）；失败返回 null；
 *   createdRequest 由本层持有，continueCreating 复位以便「继续创建」。
 */

/** 提交输入：表单原始值（ui 不做归一，去首尾空格在 application 收口） */
export type RepairRequestCreateFormValues = {
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
};

/** 型号加载状态：页/表单只需消费干净状态，不感知 adapter 与竞态细节 */
export type RepairRequestModelsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; models: EquipmentModelOption[] };

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

export function useRepairRequestCreateFlow() {
  const [modelsState, setModelsState] = useState<RepairRequestModelsState>({ status: 'loading' });
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

  const retryLoadModels = useCallback(() => {
    setModelsState({ status: 'loading' });
    void loadEquipmentModelsState().then(setModelsState);
  }, []);

  /** 提交创建。成功时返回真实创建记录（含真实 id，供 ui 重置表单并上报联动）；失败返回 null。 */
  const submit = useCallback(
    async (values: RepairRequestCreateFormValues): Promise<RepairRequestRecord | null> => {
      if (submittingRef.current) {
        return null;
      }

      submittingRef.current = true;
      setSubmitting(true);
      setSubmitError(null);
      setSubmitFailureReason(null);

      try {
        const result = await createRepairRequest({
          equipmentModelId: values.equipmentModelId,
          errorCode: values.errorCode.trim(),
          faultDescription: values.faultDescription.trim(),
        });

        if (result.ok) {
          setCreatedRequest(result.repairRequest);

          return result.repairRequest;
        }

        // 业务拒绝展示后端消息并保留表单内容，不做乐观成功
        setSubmitError(result.message);
        setSubmitFailureReason(result.reason);

        return null;
      } catch (error) {
        setSubmitError(toUserMessage(error, 'repairForm.submitFailed'));

        return null;
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [],
  );

  const continueCreating = useCallback(() => setCreatedRequest(null), []);

  return {
    continueCreating,
    createdRequest,
    modelsState,
    retryLoadModels,
    submit,
    submitting,
    submitError,
    submitFailureReason,
  };
}
