// src/features/repair-request/ui/repair-request-form.tsx

import { useCallback, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Result, Select, Upload } from 'antd';
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
const MANUAL_MODEL_TEXT_MAX_LENGTH = 50;

type RepairRequestFormValues = {
  serviceOrganizationId: number;
  equipmentModelId?: number;
  equipmentModelText?: string;
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
 * 创建维修申请表单（任务 03「提交即出单」）。
 *
 * - 客户公司只读：归属来自可信登录身份的账号设置，不接受在表单内修改；
 * - 维修厂家来自后端候选（启用 + 具备维修服务资格），支持关键字检索，不支持手工输入；
 * - 机型可「选已有」或「手填新机型」二选一：手填只在提交事务内查重/登记，
 *   搜索与输入都不写库；
 * - 原件可选：先上传为暂存态，提交成功时在同一事务内绑定，提交失败保留以便重试；
 * - 型号/厂家 query 三态、幂等提交标识、在途锁与错误归一由
 *   application 的 useRepairRequestCreateFlow 承担，本组件只负责渲染与把编排结果
 *   转成提示、重置与导航。
 */
export function RepairRequestForm({ onCreated, onViewCreated }: RepairRequestFormProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [form] = Form.useForm<RepairRequestFormValues>();
  const [manualModel, setManualModel] = useState(false);
  const {
    attachment,
    clearAttachment,
    continueCreating,
    createdRequest,
    modelsState,
    retryLoadModels,
    retryLoadServiceOrganizations,
    searchServiceOrganizations,
    serviceOrgsState,
    submit,
    submitting,
    submitError,
    submitFailureReason,
    uploadAttachment,
  } = useRepairRequestCreateFlow();

  const modelsReady = modelsState.status === 'ready' && modelsState.models.length > 0;
  const serviceOrgsReady = serviceOrgsState.status === 'ready';
  const canSubmit = modelsReady && serviceOrgsReady && attachment.status !== 'uploading';

  const handleSubmit = useCallback(
    async (values: RepairRequestFormValues) => {
      const record = await submit(values);

      if (record) {
        // 重置表单，避免“继续创建”时残留旧值导致一键重复提交；随后上报创建成功
        form.resetFields();
        setManualModel(false);
        clearAttachment();
        onCreated?.(record);
      }
    },
    [clearAttachment, form, onCreated, submit],
  );

  // 「取消」即放弃当前填写内容：仅重置表单字段，不清除型号等页面级状态
  const handleCancel = useCallback(() => {
    form.resetFields();
    setManualModel(false);
    clearAttachment();
  }, [clearAttachment, form]);

  // 切换机型录入方式：清空另一侧的旧值，保证「二选一」不会同时携带两份输入
  const handleToggleManualModel = useCallback(
    (checked: boolean) => {
      setManualModel(checked);
      if (checked) {
        form.setFieldValue('equipmentModelId', undefined);
      } else {
        form.setFieldValue('equipmentModelText', undefined);
      }
    },
    [form],
  );

  const handleUpload = useCallback(
    (file: File) => {
      void uploadAttachment(file);

      return false;
    },
    [uploadAttachment],
  );

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
      {serviceOrgsState.status === 'failed' ? (
        <Alert
          action={
            <Button onClick={retryLoadServiceOrganizations} size="small">
              {t('common.retry')}
            </Button>
          }
          title={serviceOrgsState.message}
          showIcon
          type="error"
        />
      ) : null}
      {serviceOrgsState.status === 'ready' && serviceOrgsState.organizations.length === 0 ? (
        <Alert title={t('repairForm.noServiceOrgs')} showIcon type="warning" />
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
        {/* 分段一：故障信息（机型二选一 + 错误码 + 故障现象） */}
        <h3 className="repair-request-section-title">{t('repairForm.section.faultInfo')}</h3>
        {manualModel ? (
          <Form.Item
            label={
              <FieldLabel
                hint={t('repairForm.modelManualHint', { max: MANUAL_MODEL_TEXT_MAX_LENGTH })}
                title={t('repairForm.modelManualLabel')}
              />
            }
            name="equipmentModelText"
            rules={[
              { message: t('repairForm.modelManualRequired'), required: true },
              {
                max: MANUAL_MODEL_TEXT_MAX_LENGTH,
                message: t('repairForm.modelManualMax', { max: MANUAL_MODEL_TEXT_MAX_LENGTH }),
              },
            ]}
          >
            <Input
              disabled={!modelsReady}
              maxLength={MANUAL_MODEL_TEXT_MAX_LENGTH}
              placeholder={t('repairForm.modelManualPlaceholder')}
            />
          </Form.Item>
        ) : (
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
        )}
        <Form.Item>
          <Checkbox
            checked={manualModel}
            onChange={(event) => handleToggleManualModel(event.target.checked)}
          >
            {t('repairForm.modelManualToggle')}
          </Checkbox>
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
        {/* 分段二：维修安排（客户公司只读 + 维修厂家） */}
        <h3 className="repair-request-section-title">
          {t('repairForm.section.serviceArrangement')}
        </h3>
        {/* 客户公司：只读展示，归属真源在账号设置（服务端从可信身份取得） */}
        <Form.Item
          label={<FieldLabel hint={t('repairForm.companyHint')} title={t('repairForm.companyLabel')} />}
        >
          <Input disabled readOnly value={t('repairForm.companyValue')} />
        </Form.Item>
        <Form.Item
          label={
            <FieldLabel
              hint={t('repairForm.serviceOrgHint')}
              title={t('repairForm.serviceOrgLabel')}
            />
          }
          name="serviceOrganizationId"
          rules={[{ message: t('repairForm.serviceOrgRequired'), required: true }]}
        >
          <Select
            disabled={!serviceOrgsReady}
            filterOption={false}
            loading={serviceOrgsState.status === 'loading'}
            notFoundContent={
              serviceOrgsState.status === 'loading' ? t('repairForm.serviceOrgSearching') : undefined
            }
            onSearch={searchServiceOrganizations}
            options={
              serviceOrgsState.status === 'ready'
                ? serviceOrgsState.organizations.map((organization) => ({
                    label: organization.shortName
                      ? `${organization.name}（${organization.shortName}）`
                      : organization.name,
                    value: organization.id,
                  }))
                : []
            }
            placeholder={t('repairForm.serviceOrgPlaceholder')}
            showSearch
          />
        </Form.Item>
        {/* 分段三：可选原件（先上传为暂存态，提交时在同一事务内绑定） */}
        <h3 className="repair-request-section-title">{t('repairForm.section.attachment')}</h3>
        <Form.Item
          label={
            <FieldLabel
              hint={t('repairForm.attachmentHint')}
              title={t('repairForm.attachmentLabel')}
            />
          }
        >
          <div className="flex flex-col gap-2">
            {attachment.status === 'ready' ? (
              <div className="flex items-center gap-2">
                <span>{attachment.file.originalFilename}</span>
                <Button onClick={clearAttachment} size="small" type="link">
                  {t('repairForm.attachmentRemove')}
                </Button>
                <span className="repair-request-field-hint">
                  {t('repairForm.attachmentReady')}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Upload beforeUpload={handleUpload} fileList={[]} showUploadList={false}>
                  <Button disabled={attachment.status === 'uploading'}>
                    {attachment.status === 'uploading'
                      ? t('repairForm.attachmentUploading')
                      : t('repairForm.attachmentUpload')}
                  </Button>
                </Upload>
                {attachment.status === 'uploading' ? <span>{attachment.filename}</span> : null}
              </div>
            )}
            {attachment.status === 'failed' ? (
              <span className="repair-request-field-hint">{attachment.message}</span>
            ) : null}
          </div>
        </Form.Item>
        {/* 操作行（2026-09-30 复审）：整体业务规则在左、按钮在右；窄屏自动换行后
            规则在上、按钮仍右对齐（.repair-request-form-*，见 index.css） */}
        <Form.Item>
          <div className="repair-request-form-actions">
            <p className="repair-request-form-rule">{t('repairForm.rule')}</p>
            <div className="repair-request-form-buttons">
              <Button onClick={handleCancel}>{t('common.cancel')}</Button>
              <Button disabled={!canSubmit} htmlType="submit" loading={submitting} type="primary">
                {t('repairForm.submit')}
              </Button>
            </div>
          </div>
        </Form.Item>
      </Form>
    </div>
  );
}
