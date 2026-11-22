// src/pages/my-records/index.tsx

import { Button } from 'antd';
import { useNavigate } from 'react-router';

import { useAuthSession } from '@/features/auth-session';
import { MyRecordsList, resolveTask06CreateEntry } from '@/features/my-records';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

/**
 * 我的资料记录页（任务 07，布局参考 Demo V44 的 V24MyRecords）。
 *
 * 路由 /engineer/records 复用 protectedRouteLoader；ENGINEER 与 SUPER_ADMIN 均放行
 * （导航目录对管理员隐藏入口，他人草稿不可见由后端归属谓词保证）。
 * 「记录历史故障经验」新建入口在页头 extra（工程师专属，对齐 Demo 布局）：
 * 角色未知/加载中不渲染，避免管理员会话闪现入口；前端隐藏不替代后端写权限校验。
 * 草稿续填入口以会话角色快照作为第一道展示条件（管理员不可续填）。
 */
export function MyRecordsPage() {
  const { t } = useI18n();
  const { session } = useAuthSession();
  const navigate = useNavigate();
  const create = resolveTask06CreateEntry(session?.role);

  return (
    <div className="page-stack">
      <PageHeader
        description={t('myRecords.description')}
        extra={
          create.available && create.path !== null ? (
            <Button
              onClick={() => {
                if (create.path !== null) void navigate(create.path);
              }}
              size="small"
              type="primary"
            >
              {t('myRecords.action.create')}
            </Button>
          ) : null
        }
        eyebrow={t('myRecords.eyebrow')}
        title={t('myRecords.title')}
      />
      <MyRecordsList activeRole={session?.role} />
    </div>
  );
}
