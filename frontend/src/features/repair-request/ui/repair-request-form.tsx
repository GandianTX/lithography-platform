// src/features/repair-request/ui/repair-request-form.tsx

import { useCallback } from 'react';
import { Alert, Button, Form, Input, Result, Select } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/shared/i18n';

import { useRepairRequestCreateFlow } from '../application/use-repair-request-create-flow';
import type { RepairRequestRecord } from '../infrastructure/repair-request.types';

// 创建成功后的返回目标：跳转维修申请列表（T-05：列表能力已落地，替换阶段一的客户首页临时落点）
const REPAIR_REQUESTS_LIST_PATH = '/customer/repair-requests';

// 缺公司归属时服务端拒绝创建（S4 门禁）：引导用户先去账号设置补录
const ACCOUNT_SETTINGS_PATH = '/account/settings';

// 长度上限与后端契约对齐（backend/src/adapters/api/graphql/repair-request/dto/create-repair-request.input.ts），
// 修改需同步后端，避免单边漂移导致前端误拦或漏校验。
const ERROR_CODE_MAX_LENGTH = 100;
const FAULT_DESCRIPTION_MAX_LENGTH = 5000;

type RepairRequestFormValues = {
  equipmentModelId: number;
  errorCode: string;
  faultDescription: string;
};

/**
 * 字段小标题 + 短提示（2026-09-30 复审：提示与字段一一对应、就近挂在标题旁，
 * 不再集中成独立右栏；提示文本从属于小标题，低强调展示）。
 */
function FieldLabel({ hint, title }: { hint: string; title: string }) {
  return (
    <span className="repair-request-field-label">
      <span>{title}</span>
      <span className="repair-request-field-hint">{hint}</span>
    </span>
  );
}

export type RepairRequestFormProps = {
  /** 创建成功回调：携带真实创建记录（已含真实 id），供工作台刷新左栏列表联动 */
  onCreated?: (record: RepairRequestRecord) => void;
  /** 「查看维修申请」跳转意图；未提供时保持既有默认行为（跳转列表路由） */
  onViewCreated?: (record: RepairRequestRecord) => void;
};

/**
 * 创建维修申请表单。
 *
 * - 型号 query 三态、重试编排、create command、在途锁与错误归一均由
 *   application 的 useRepairRequestCreateFlow 承担，本组件只负责渲染与把编排结果
 *   转成提示、重置与导航；
 * - 设备型号列表来自后端（仅启用型号），含加载中 / 失败重试 / 无可用型号三种状态；
 * - 业务拒绝展示后端消息并保留表单内容；transport 失败展示共享错误模型的用户文案；
 * - 提交中禁用按钮并以进行中标志防连点；成功展示申请编号（后端生成，不从输入取），
 *   并重置表单，避免“继续创建”时残留旧值一键重复提交；
 * - 协作端口：onCreated 在创建成功时上报记录（工作台据此刷新左栏列表）；
 *   onViewCreated 覆盖「查看维修申请」的默认跳转目标（工作台进入新申请详情路由）。
 */
export function RepairRequestForm({ onCreated, onViewCreated }: RepairRequestFormProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [form] = Form.useForm<RepairRequestFormValues>();
  const {
    continueCreating,
    createdRequest,
    modelsState,
    retryLoadModels,
    submit,
    submitting,
    submitError,
    submitFailureReason,
  } = useRepairRequestCreateFlow();

  const modelsReady = modelsState.status === 'ready' && modelsState.models.length > 0;

  const handleSubmit = useCallback(
    async (values: RepairRequestFormValues) => {
      const record = await submit(values);

      if (record) {
        // 重置表单，避免“继续创建”时残留旧值导致一键重复提交；随后上报创建成功
        form.resetFields();
        onCreated?.(record);
      }
    },
    [form, onCreated, submit],
  );

  // 「取消」即放弃当前填写内容：仅重置表单字段，不清除型号等页面级状态
  const handleCancel = useCallback(() => {
    form.resetFields();
  }, [form]);

  if (createdRequest) {
    return (
      <Result
        extra={[
          <Button key="continue" onClick={continueCreating}>
            {t('repairForm.continue')}
          </Button>,
          <Button
            key="list"
            onClick={() =>
              onViewCreated ? onViewCreated(createdRequest) : navigate(REPAIR_REQUESTS_LIST_PATH)
            }
            type="primary"
          >
            {t('repairForm.view')}
          </Button>,
        ]}
        status="success"
        subTitle={t('repairForm.requestNo', { requestNo: createdRequest.requestNo })}
        title={t('repairForm.successTitle')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {modelsState.status === 'failed' ? (
        <Alert
          action={
            <Button onClick={retryLoadModels} size="small">
              {t('common.retry')}
            </Button>
          }
          title={modelsState.message}
          showIcon
          type="error"
        />
      ) : null}
      {modelsState.status === 'ready' && modelsState.models.length === 0 ? (
        // 空态同样可恢复：型号由管理员维护，用户无需刷新整页即可再次拉取（S2-2）
        <Alert
          action={
            <Button onClick={retryLoadModels} size="small">
              {t('common.retry')}
            </Button>
          }
          title={t('repairForm.noModels')}
          showIcon
          type="warning"
        />
      ) : null}
      {submitError ? (
        <Alert
          action={
            submitFailureReason === 'company-required' ? (
              <Button onClick={() => navigate(ACCOUNT_SETTINGS_PATH)} size="small" type="primary">
                {t('common.goAccountSettings')}
              </Button>
            ) : undefined
          }
          title={submitError}
          description={
            submitFailureReason === 'company-required'
              ? t('repairForm.companyRequiredHint')
              : undefined
          }
          showIcon
          type="error"
        />
      ) : null}

      <Form form={form} layout="vertical" onFinish={(values) => void handleSubmit(values)}>
        <Form.Item
          label={<FieldLabel hint={t('repairForm.modelHint')} title={t('repairForm.modelLabel')} />}
          name="equipmentModelId"
          rules={[{ message: t('repairForm.modelRequired'), required: true }]}
        >
          <Select
            disabled={!modelsReady}
            loading={modelsState.status === 'loading'}
            options={
              modelsState.status === 'ready'
                ? modelsState.models.map((model) => ({
                    label: `${model.modelName}（${model.modelCode}）`,
                    value: model.id,
                  }))
                : []
            }
            placeholder={t('repairForm.modelPlaceholder')}
          />
        </Form.Item>
        <Form.Item
          label={
            <FieldLabel
              hint={t('repairForm.errorCodeHint', { max: ERROR_CODE_MAX_LENGTH })}
              title={t('repairForm.errorCodeLabel')}
            />
          }
          name="errorCode"
          rules={[
            { message: t('repairForm.errorCodeRequired'), required: true },
            {
              max: ERROR_CODE_MAX_LENGTH,
              message: t('repairForm.errorCodeMax', { max: ERROR_CODE_MAX_LENGTH }),
            },
          ]}
        >
          <Input
            disabled={!modelsReady}
            maxLength={ERROR_CODE_MAX_LENGTH}
            placeholder={t('repairForm.errorCodePlaceholder')}
          />
        </Form.Item>
        <Form.Item
          label={
            <FieldLabel
              hint={t('repairForm.descriptionHint', { max: FAULT_DESCRIPTION_MAX_LENGTH })}
              title={t('repairForm.descriptionLabel')}
            />
          }
          name="faultDescription"
          rules={[
            { message: t('repairForm.descriptionRequired'), required: true },
            {
              max: FAULT_DESCRIPTION_MAX_LENGTH,
              message: t('repairForm.descriptionMax', { max: FAULT_DESCRIPTION_MAX_LENGTH }),
            },
          ]}
        >
          <Input.TextArea
            disabled={!modelsReady}
            maxLength={FAULT_DESCRIPTION_MAX_LENGTH}
            placeholder={t('repairForm.descriptionPlaceholder')}
            rows={6}
            style={{ minHeight: 150 }}
          />
        </Form.Item>
        {/* 操作行（2026-09-30 复审）：整体业务规则在左、按钮在右；窄屏自动换行后
            规则在上、按钮仍右对齐（.repair-request-form-*，见 index.css） */}
        <Form.Item>
          <div className="repair-request-form-actions">
            <p className="repair-request-form-rule">{t('repairForm.rule')}</p>
            <div className="repair-request-form-buttons">
              <Button onClick={handleCancel}>{t('common.cancel')}</Button>
              <Button disabled={!modelsReady} htmlType="submit" loading={submitting} type="primary">
                {t('repairForm.submit')}
              </Button>
            </div>
          </div>
        </Form.Item>
      </Form>
    </div>
  );
}
