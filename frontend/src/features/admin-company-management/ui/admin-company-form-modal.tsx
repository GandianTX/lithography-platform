// src/features/admin-company-management/ui/admin-company-form-modal.tsx

/**
 * 公司档案新增 / 编辑弹窗。
 *
 * 两个弹窗共用同一套字段与校验，分成两个导出组件只是为了保持提交入参类型精确：
 * 新增提交 `AdminCompanyCreateDraft`，编辑提交 `AdminCompanyUpdateDraft`。
 *
 * - 字段顺序与 V44 公司弹窗一致：全称、联系人、电话、简称、邮箱、地址、备注、启用、维修服务；
 * - 宽度对齐 V44 的 760 px，窄屏按视口收缩，正文受控滚动，标题与底部动作始终可达；
 * - 新增时状态与维修资格都由用户独立选择（缺省启用），编号、受管归类由服务端决定；
 * - 编辑时编号只读展示；提交差异字段（键缺省 = 不修改，空白 = 清空），
 *   避免把打开弹窗时的旧值重发而覆盖他人并发修改；
 * - 全称精确同名只作提示（含停用与未受管档案；编辑排除自身），不阻断提交，也不自动合并；
 * - 提交期间重复提交由宿主命令 hook 的 in-flight 锁拦截，弹窗侧只负责展示错误与保留草稿。
 */

import type { ModalProps } from 'antd';
import { Alert, Form, Input, Modal, Switch } from 'antd';

import { useStaleSubmitGuard } from '@/shared/ui/dialog-session';

import {
  ADMIN_COMPANY_ADDRESS_MAX_LENGTH,
  ADMIN_COMPANY_CONTACT_EMAIL_MAX_LENGTH,
  ADMIN_COMPANY_CONTACT_NAME_MAX_LENGTH,
  ADMIN_COMPANY_CONTACT_PHONE_MAX_LENGTH,
  ADMIN_COMPANY_NAME_MAX_LENGTH,
  ADMIN_COMPANY_REMARK_MAX_LENGTH,
  ADMIN_COMPANY_SHORT_NAME_MAX_LENGTH,
  findAdminCompanyEmailIssue,
} from '../application/admin-company-management.policy';
import type {
  AdminCompanyCreateDraft,
  AdminCompanyRecordResult,
  AdminCompanyRow,
  AdminCompanyUpdateDraft,
  AdminOrganizationStatus,
} from '../application/admin-company-management.types';
import { useAdminCompanyNameCheck } from '../application/use-admin-company-name-check';

type CompanyFormValues = {
  address: string;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  enabled: boolean;
  isServiceProvider: boolean;
  name: string;
  remark: string;
  shortName: string;
};

/** 同名只提示、不合并：提交后仍会新增一条独立档案 */
const SAME_NAME_HINT =
  '已存在同名公司档案（含停用与未受管档案）。保存后会保留独立档案，不会自动合并。';

/**
 * V44 公司弹窗宽度为 760 px。窄屏按视口留出 16 px 边距后收缩；正文受控滚动，
 * 保证标题与「取消 / 创建（保存）」始终可见可达，不靠整页滚动兜底。
 */
const COMPANY_MODAL_LAYOUT: Pick<ModalProps, 'style' | 'styles' | 'width'> = {
  style: { maxWidth: 'calc(100vw - 32px)' },
  styles: { body: { maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' } },
  width: 760,
};

const EMAIL_RULES = [
  {
    validator: (_: unknown, value: string | undefined) => {
      const issue = findAdminCompanyEmailIssue(value ?? '');

      return issue === null ? Promise.resolve() : Promise.reject(new Error(issue));
    },
  },
];

function CompanyFormFields({
  mode,
  organizationCode,
  nameHint,
}: {
  mode: 'create' | 'edit';
  organizationCode?: string;
  nameHint?: string;
}) {
  return (
    <>
      {mode === 'edit' ? (
        <Form.Item label="公司编号">
          <Input disabled value={organizationCode ?? ''} />
        </Form.Item>
      ) : null}

      <Form.Item<CompanyFormValues>
        extra={nameHint}
        label="公司全称"
        name="name"
        rules={[
          { required: true, whitespace: true, message: '请输入公司全称' },
          {
            max: ADMIN_COMPANY_NAME_MAX_LENGTH,
            message: `公司全称最多 ${ADMIN_COMPANY_NAME_MAX_LENGTH} 个字符`,
          },
        ]}
      >
        <Input maxLength={ADMIN_COMPANY_NAME_MAX_LENGTH} placeholder="填写公司法定全称" />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        label="联系人姓名"
        name="contactName"
        rules={[
          {
            max: ADMIN_COMPANY_CONTACT_NAME_MAX_LENGTH,
            message: `联系人姓名最多 ${ADMIN_COMPANY_CONTACT_NAME_MAX_LENGTH} 个字符`,
          },
        ]}
      >
        <Input maxLength={ADMIN_COMPANY_CONTACT_NAME_MAX_LENGTH} />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        label="联系电话"
        name="contactPhone"
        rules={[
          { required: true, whitespace: true, message: '请输入联系电话' },
          {
            max: ADMIN_COMPANY_CONTACT_PHONE_MAX_LENGTH,
            message: `联系电话最多 ${ADMIN_COMPANY_CONTACT_PHONE_MAX_LENGTH} 个字符`,
          },
        ]}
      >
        <Input maxLength={ADMIN_COMPANY_CONTACT_PHONE_MAX_LENGTH} />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        label="公司简称"
        name="shortName"
        rules={[
          {
            max: ADMIN_COMPANY_SHORT_NAME_MAX_LENGTH,
            message: `公司简称最多 ${ADMIN_COMPANY_SHORT_NAME_MAX_LENGTH} 个字符`,
          },
        ]}
      >
        <Input maxLength={ADMIN_COMPANY_SHORT_NAME_MAX_LENGTH} />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        extra="不限制企业域，仅作联系与展示。"
        label="公司邮箱"
        name="contactEmail"
        rules={EMAIL_RULES}
      >
        <Input maxLength={ADMIN_COMPANY_CONTACT_EMAIL_MAX_LENGTH} />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        label="地址"
        name="address"
        rules={[
          {
            max: ADMIN_COMPANY_ADDRESS_MAX_LENGTH,
            message: `地址最多 ${ADMIN_COMPANY_ADDRESS_MAX_LENGTH} 个字符`,
          },
        ]}
      >
        <Input.TextArea
          autoSize={{ maxRows: 3, minRows: 1 }}
          maxLength={ADMIN_COMPANY_ADDRESS_MAX_LENGTH}
        />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        label="备注"
        name="remark"
        rules={[
          {
            max: ADMIN_COMPANY_REMARK_MAX_LENGTH,
            message: `备注最多 ${ADMIN_COMPANY_REMARK_MAX_LENGTH} 个字符`,
          },
        ]}
      >
        <Input.TextArea
          autoSize={{ maxRows: 4, minRows: 2 }}
          maxLength={ADMIN_COMPANY_REMARK_MAX_LENGTH}
        />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        extra={
          mode === 'create'
            ? '可在此选择启用或停用；停用公司不会出现在注册与报修候选中。'
            : undefined
        }
        label="公司启用"
        name="enabled"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>

      <Form.Item<CompanyFormValues>
        extra="具备维修资格的公司会出现在客户报修的服务商候选中。"
        label="提供维修服务"
        name="isServiceProvider"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
    </>
  );
}

type AdminCompanyCreateModalProps = {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (draft: AdminCompanyCreateDraft) => Promise<AdminCompanyRecordResult>;
};

export function AdminCompanyCreateModal({
  onCancel,
  onSubmit,
  open,
  submitting,
}: AdminCompanyCreateModalProps) {
  const [form] = Form.useForm<CompanyFormValues>();
  // 创建弹窗没有目标主键，`open` 的每一次翻转就是一次新会话
  const {
    captureSubmitSeq,
    invalidateInFlightSubmit,
    isCurrentSubmitSeq,
    setSubmitError,
    submitError,
  } = useStaleSubmitGuard(open);
  const nameValue = Form.useWatch('name', form) as string | undefined;
  const hasSameName = useAdminCompanyNameCheck({ enabled: open, name: nameValue });

  const handleFinish = async (values: CompanyFormValues) => {
    const submitSeq = captureSubmitSeq();

    setSubmitError(null);

    const result = await onSubmit({
      name: values.name,
      shortName: values.shortName ?? '',
      contactName: values.contactName ?? '',
      contactPhone: values.contactPhone,
      contactEmail: values.contactEmail ?? '',
      address: values.address ?? '',
      remark: values.remark ?? '',
      status: toStatus(values.enabled ?? true),
      isServiceProvider: values.isServiceProvider ?? false,
    });

    if (!isCurrentSubmitSeq(submitSeq)) {
      return;
    }

    if (!result.ok && result.message) {
      setSubmitError(result.message);
    }
  };

  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="创建"
      open={open}
      title="新增公司档案"
      {...COMPANY_MODAL_LAYOUT}
      onCancel={() => {
        invalidateInFlightSubmit();
        onCancel();
      }}
      onOk={() => void form.submit()}
    >
      <Form
        form={form}
        initialValues={{ enabled: true, isServiceProvider: false }}
        layout="vertical"
        preserve={false}
        onFinish={(values) => void handleFinish(values)}
      >
        <CompanyFormFields mode="create" nameHint={hasSameName ? SAME_NAME_HINT : undefined} />

        {submitError ? <Alert message={submitError} showIcon type="error" /> : null}
      </Form>
    </Modal>
  );
}

type AdminCompanyEditModalProps = {
  company: AdminCompanyRow | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (draft: AdminCompanyUpdateDraft) => Promise<AdminCompanyRecordResult>;
};

function toCompanyFormValues(company: AdminCompanyRow): CompanyFormValues {
  return {
    address: company.address ?? '',
    contactEmail: company.contactEmail ?? '',
    contactName: company.contactName ?? '',
    contactPhone: company.contactPhone ?? '',
    enabled: company.status === 'ACTIVE',
    isServiceProvider: company.isServiceProvider,
    name: company.name,
    remark: company.remark ?? '',
    shortName: company.shortName ?? '',
  };
}

function toStatus(enabled: boolean): AdminOrganizationStatus {
  return enabled ? 'ACTIVE' : 'DISABLED';
}

export function AdminCompanyEditModal({
  company,
  onCancel,
  onSubmit,
  submitting,
}: AdminCompanyEditModalProps) {
  const [form] = Form.useForm<CompanyFormValues>();
  // 目标主键就是本弹窗的会话身份：切换行、关闭后重开都会推进代次
  const {
    captureSubmitSeq,
    invalidateInFlightSubmit,
    isCurrentSubmitSeq,
    setSubmitError,
    submitError,
  } = useStaleSubmitGuard(company === null ? null : company.organizationId);
  const nameValue = Form.useWatch('name', form) as string | undefined;
  const hasSameName = useAdminCompanyNameCheck({
    enabled: company !== null,
    name: nameValue,
    excludeOrganizationId: company?.organizationId ?? null,
  });

  const handleFinish = async (values: CompanyFormValues) => {
    if (!company) {
      return;
    }

    const submitSeq = captureSubmitSeq();

    setSubmitError(null);

    const draft: AdminCompanyUpdateDraft = { organizationId: company.organizationId };

    if (values.name.trim() !== company.name) {
      draft.name = values.name.trim();
    }

    if (values.contactPhone.trim() !== (company.contactPhone ?? '')) {
      draft.contactPhone = values.contactPhone.trim();
    }

    if (values.shortName.trim() !== (company.shortName ?? '')) {
      draft.shortName = values.shortName.trim() || null;
    }

    if (values.contactName.trim() !== (company.contactName ?? '')) {
      draft.contactName = values.contactName.trim() || null;
    }

    if (values.contactEmail.trim() !== (company.contactEmail ?? '')) {
      draft.contactEmail = values.contactEmail.trim() || null;
    }

    if (values.address.trim() !== (company.address ?? '')) {
      draft.address = values.address.trim() || null;
    }

    if (values.remark.trim() !== (company.remark ?? '')) {
      draft.remark = values.remark.trim() || null;
    }

    const status = toStatus(values.enabled);
    if (status !== company.status) {
      draft.status = status;
    }

    if (values.isServiceProvider !== company.isServiceProvider) {
      draft.isServiceProvider = values.isServiceProvider;
    }

    if (
      draft.name === undefined &&
      draft.contactPhone === undefined &&
      draft.shortName === undefined &&
      draft.contactName === undefined &&
      draft.contactEmail === undefined &&
      draft.address === undefined &&
      draft.remark === undefined &&
      draft.status === undefined &&
      draft.isServiceProvider === undefined
    ) {
      setSubmitError('请至少修改一项后再保存。');
      return;
    }

    const result = await onSubmit(draft);

    if (!isCurrentSubmitSeq(submitSeq)) {
      return;
    }

    if (!result.ok && result.message) {
      setSubmitError(result.message);
    }
  };

  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="保存"
      open={company !== null}
      title={`编辑公司档案：${company?.name ?? ''}`}
      {...COMPANY_MODAL_LAYOUT}
      onCancel={() => {
        invalidateInFlightSubmit();
        onCancel();
      }}
      onOk={() => void form.submit()}
    >
      <Form
        form={form}
        // 以目标主键为 key：快速切换行时强制重挂载，避免 initialValues 不生效残留上一行草稿
        key={company === null ? 'none' : `company-${company.organizationId}`}
        initialValues={company ? toCompanyFormValues(company) : undefined}
        layout="vertical"
        preserve={false}
        onFinish={(values) => void handleFinish(values)}
      >
        <CompanyFormFields
          mode="edit"
          nameHint={hasSameName ? SAME_NAME_HINT : undefined}
          organizationCode={company?.organizationCode}
        />

        {submitError ? <Alert message={submitError} showIcon type="error" /> : null}
      </Form>
    </Modal>
  );
}
