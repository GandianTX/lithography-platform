// src/pages/engineer-repair-requests/index.tsx

import { useSearchParams } from 'react-router';

import type { EngineerRepairListScope } from '@/features/repair-request';
import { EngineerRepairRequestList } from '@/features/repair-request';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 工程师维修申请列表页。
 *
 * 路由 /engineer/repair-requests 在 app/router 注册并复用
 * protectedRouteLoader；页面只装配 feature 公开组件，不持有 Session、
 * Token、角色映射或另一份列表真源。
 *
 * 支持以查询参数恢复范围状态（如 /engineer/repair-requests?scope=MINE
 * 供首页「我的接单」快捷入口进入）：仅接受后端四态合法值，非法值回落默认 ALL。
 */
const SCOPE_PARAM_KEY = 'scope';

const SCOPE_PARAM_VALUES: readonly EngineerRepairListScope[] = [
  'ALL',
  'AVAILABLE',
  'MINE',
  'TAKEN_BY_OTHER',
];

function parseScopeParam(raw: string | null): EngineerRepairListScope | undefined {
  return SCOPE_PARAM_VALUES.find((value) => value === raw);
}

export function EngineerRepairRequestsPage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const initialScope = parseScopeParam(searchParams.get(SCOPE_PARAM_KEY));

  return (
    <div className="page-stack">
      <PageHeader
        description={t('engineer.listDescription')}
        eyebrow="Repair Requests"
        title={t('engineer.listTitle')}
      />
      <EngineerRepairRequestList initialScope={initialScope} />
    </div>
  );
}
