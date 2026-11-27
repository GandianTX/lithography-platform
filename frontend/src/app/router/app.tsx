// src/app/router/app.tsx

import {
  createBrowserRouter,
  isRouteErrorResponse,
  redirect,
  RouterProvider,
  useRouteError,
} from 'react-router';

import { AppLayout } from '@/app/layout';

import { AccountSettingsPage } from '@/pages/account-settings';
import { AdminPage } from '@/pages/admin';
import { AdminAiConversationsPage } from '@/pages/admin-ai-conversations';
import { AdminCompaniesPage } from '@/pages/admin-companies';
import { AdminDocumentDatabasePage } from '@/pages/admin-document-database';
import { AdminEngineerApprovalsPage } from '@/pages/admin-engineer-approvals';
import { AdminOperationRecordsPage } from '@/pages/admin-operation-records';
import { AdminOrderDetailPage, AdminOrdersPage } from '@/pages/admin-orders';
import { AdminReferenceOwnershipPage } from '@/pages/admin-reference-ownership';
import { AdminReferenceOwnershipDetailPage } from '@/pages/admin-reference-ownership-detail';
import { AdminReferenceRevisePage } from '@/pages/admin-reference-revise';
import { AdminUsersPage } from '@/pages/admin-users';
import {
  CustomerPage,
  CustomerRepairRequestDetailRoute,
  CustomerRepairRequestsPage,
} from '@/pages/customer';
import { EngineerPage } from '@/pages/engineer';
import { EngineerAiHistoryPage, EngineerAiPage } from '@/pages/engineer-ai';
import {
  EngineerMaintenanceRecordEditorPage,
  EngineerMaintenanceRecordNewPage,
  EngineerMaintenanceRecordsPage,
} from '@/pages/engineer-maintenance-records';
import { EngineerRepairRequestDetailPage } from '@/pages/engineer-repair-request-detail';
import { EngineerRepairRequestsPage } from '@/pages/engineer-repair-requests';
import {
  EngineerWorkOrderSummariesPage,
  EngineerWorkOrderSummaryEditorPage,
} from '@/pages/engineer-work-order-summaries';
import { ErrorPreviewPage } from '@/pages/error-preview';
import { LocalBackupPage } from '@/pages/local-backup';
import { LocalSettingsPage } from '@/pages/local-settings';
import { MyRecordDetailPage } from '@/pages/my-record-detail';
import { MyRecordsPage } from '@/pages/my-records';
import { ProjectStructurePage } from '@/pages/project-structure';
import { RecordPackagesPage } from '@/pages/record-packages';
import { ReferenceDocumentDetailPage } from '@/pages/reference-document-detail';
import { ReferenceDocumentsPage } from '@/pages/reference-documents';
import { RegisterCustomerPage } from '@/pages/register-customer';
import { RegisterEngineerPage } from '@/pages/register-engineer';
import { RepairRequestCreatePage } from '@/pages/repair-request-create';
import { RestrictedPage } from '@/pages/restricted';
import { canAccessSharedUiGallery, SharedUiGalleryPage } from '@/pages/shared-ui-gallery';
import { SyncConflictsPage } from '@/pages/sync-conflicts';
import { Error403, Error404, Error500, ErrorRouteCrash } from '@/features/error-feedback';

import { getAppEnv } from '@/shared/env';

import { canAccessGame2048Lab, Game2048LabPage } from '@/labs/game-2048';
import { canAccessSandboxPlayground, SandboxPlaygroundPage } from '@/sandbox/playground';

import { LoginPageRoute } from './login-page-route';
import { indexRouteLoader, loginLoader, protectedRouteLoader } from './route-guards';
import { registerAppRouter } from './router-bridge';

function RouteErrorPage() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    if (error.status === 403) {
      return <Error403 />;
    }

    if (error.status === 404) {
      return <Error404 />;
    }

    if (error.status >= 500) {
      return <Error500 />;
    }
  }

  return <ErrorRouteCrash />;
}

function RouteErrorBoundary() {
  return (
    <AppLayout>
      <RouteErrorPage />
    </AppLayout>
  );
}

function game2048LabLoader() {
  if (!canAccessGame2048Lab(getAppEnv())) {
    throw redirect('/');
  }

  return null;
}

function sandboxPlaygroundLoader() {
  if (!canAccessSandboxPlayground(getAppEnv())) {
    throw redirect('/');
  }

  return null;
}

function sharedUiGalleryLoader() {
  if (!canAccessSharedUiGallery(getAppEnv())) {
    throw redirect('/');
  }

  return null;
}

const router = createBrowserRouter([
  {
    children: [
      {
        index: true,
        loader: indexRouteLoader,
      },
      {
        element: <LoginPageRoute />,
        loader: loginLoader,
        path: 'login',
      },
      {
        // 客户注册（S3）：公开页，已登录会话按登录页同一策略回到角色主页
        element: <RegisterCustomerPage />,
        loader: loginLoader,
        path: 'register/customer',
      },
      {
        // 工程师注册（S4）：同为公开页，成功后只落待审申请、不签发会话
        element: <RegisterEngineerPage />,
        loader: loginLoader,
        path: 'register/engineer',
      },
      {
        // 受限会话落地页：必须改密 / 工程师待审 / 工程师拒绝的会话只允许停留在
        // 本页，其余受保护路由由 protectedRouteLoader 统一收回这里；非受限会话
        // 访问本页时跳回自己的角色主页（决策唯一实现在 auth-session 策略层）
        element: <RestrictedPage />,
        loader: protectedRouteLoader,
        path: 'restricted',
      },
      {
        element: <AdminPage />,
        loader: protectedRouteLoader,
        path: 'admin',
      },
      {
        // 文档数据库页（PR3 S3）：路由治理复用 protectedRouteLoader 与既有 /admin/**
        // 角色策略（SUPER_ADMIN 放行，ENGINEER/CUSTOMER 按角色路径表拒绝），
        // 与 admin/users 同模式，不新增第二份角色判定。
        element: <AdminDocumentDatabasePage />,
        loader: protectedRouteLoader,
        path: 'admin/document-database',
      },
      {
        // AI 会话记录页（任务 05 · S4.1 · R038）：管理员只读入口。
        // 与文档数据库页不同，本页对一级与二级管理员同时开放（文档数据库整体页为一级专属）；
        // 数据范围由服务端按级别裁决（一级跨公司、二级本公司），前端不做公司过滤。
        element: <AdminAiConversationsPage />,
        loader: protectedRouteLoader,
        path: 'admin/ai-conversations',
      },
      {
        // 关键操作记录页（任务10）：只读列表；路由治理复用 protectedRouteLoader 与
        // /admin/** 角色策略（SUPER_ADMIN 放行），会话范围由页面与后端共同裁决。
        element: <AdminOperationRecordsPage />,
        loader: protectedRouteLoader,
        path: 'admin/operation-records',
      },
      {
        // 工单管理直达页（任务 04）：复用 admin-document-database 的维修申请列表/
        // 详情/修订能力；路由治理沿用 protectedRouteLoader 与 /admin/** 角色策略。
        element: <AdminOrdersPage />,
        loader: protectedRouteLoader,
        path: 'admin/orders',
      },
      {
        // 归属待核实清单页（任务 07 R061-01）：与普通资料库分开的一级管理员专用入口；
        // 路由治理复用 protectedRouteLoader，/admin/reference-ownership 在
        // auth-session 管理路径策略中按 GLOBAL 范围守卫（仅一级放行），
        // 服务端按一级身份与 PENDING 谓词独立裁决数据。
        element: <AdminReferenceOwnershipPage />,
        loader: protectedRouteLoader,
        path: 'admin/reference-ownership',
      },
      {
        // 归属待核实详情页（任务 07 R061-01）：从待核实清单进入，详情内走已实现的
        // 归属更正（R061-02）；非 PENDING 条目由服务端统一 NOT_FOUND。
        element: <AdminReferenceOwnershipDetailPage />,
        loader: protectedRouteLoader,
        path: 'admin/reference-ownership/:documentId',
      },
      {
        // 独立管理修订页（任务 07）：从资料详情「管理修订」进入；结构化报告修订
        // 复用任务 04 编辑器。/admin/reference-revise 在 auth-session 管理路径策略
        // 中按 GLOBAL 范围守卫（仅一级放行）；写权限由服务端最终裁决。
        element: <AdminReferenceRevisePage />,
        loader: protectedRouteLoader,
        path: 'admin/reference-revise/:documentId',
      },
      {
        // 工单管理独立详情页（任务 04）：从列表进入，return 时恢复筛选与分页。
        element: <AdminOrderDetailPage />,
        loader: protectedRouteLoader,
        path: 'admin/orders/:requestId',
      },
      {
        // 公司档案页（任务 08.2）：路由治理复用 protectedRouteLoader 与既有 /admin/**
        // 角色策略（SUPER_ADMIN 放行）；一级/二级差异由页面按会话等级呈现，服务端独立裁决
        element: <AdminCompaniesPage />,
        loader: protectedRouteLoader,
        path: 'admin/companies',
      },
      {
        // 工程师注册审批页（任务 08.3）：路由治理复用 protectedRouteLoader 与既有 /admin/**
        // 角色策略（SUPER_ADMIN 放行）；一级全范围、二级仅本公司的差异由服务端独立裁决
        element: <AdminEngineerApprovalsPage />,
        loader: protectedRouteLoader,
        path: 'admin/engineer-registrations',
      },
      {
        // 用户管理页：路由治理完全复用 protectedRouteLoader 与既有 /admin/**
        // 角色策略（SUPER_ADMIN 放行，ENGINEER/CUSTOMER 按角色路径表拒绝），
        element: <AdminUsersPage />,
        loader: protectedRouteLoader,
        path: 'admin/users',
      },
      {
        // 账号设置：对全部登录角色开放（导航目录同口径）；角色治理复用
        // protectedRouteLoader + auth-session 角色路径表的 /account 根路径，
        // 不在本文件另立角色判断
        element: <AccountSettingsPage />,
        loader: protectedRouteLoader,
        path: 'account/settings',
      },
      {
        // 记录包页（任务 09 S3.1）：导出与导入 U 盘记录包。
        // 路由治理复用 protectedRouteLoader；公司范围与是否可导入由服务端按 Session 裁决。
        element: <RecordPackagesPage />,
        loader: protectedRouteLoader,
        path: 'engineer/record-packages',
      },
      {
        // 同步冲突页（任务 09 S2.3）：工程师与管理员的冲突处理入口（差异对照 + 裁决）。
        // 角色放行由 auth-session 的 /engineer 根路径表覆盖；可读范围与是否可裁决
        // 由服务端按 Session 裁决，前端不传公司参数。
        element: <SyncConflictsPage />,
        loader: protectedRouteLoader,
        path: 'engineer/sync-conflicts',
      },
      {
        // 备份与恢复（任务 09 S3/S4）：自动备份设置、手动备份、备份记录与恢复预检。
        // 角色与范围由 auth-session 角色路径表 /local-backup 根路径裁决（工程师与
        // 管理员放行，客户禁入）；公司/设备维度由服务端按 Session 裁决，前端不传参
        element: <LocalBackupPage />,
        loader: protectedRouteLoader,
        path: 'local-backup',
      },
      {
        // 本地设置：导航末项、只读（任务 09 R064）。角色与范围由
        // auth-session 角色路径表 /local-settings 根路径裁决（工程师与管理员放行，
        // 客户禁入）；公司/设备维度由服务端按 Session 裁决，前端不传参
        element: <LocalSettingsPage />,
        loader: protectedRouteLoader,
        path: 'local-settings',
      },
      {
        element: <EngineerPage />,
        loader: protectedRouteLoader,
        path: 'engineer',
      },
      {
        // 任务05：AI 对话工作区（草稿优先：首次发送才创建会话）
        element: <EngineerAiPage />,
        loader: protectedRouteLoader,
        path: 'engineer/ai',
      },
      {
        // 任务05 S2：本人问答记录（只读列表，可回到对应会话）
        element: <EngineerAiHistoryPage />,
        loader: protectedRouteLoader,
        path: 'engineer/ai/history',
      },
      {
        element: <EngineerRepairRequestsPage />,
        loader: protectedRouteLoader,
        path: 'engineer/repair-requests',
      },
      {
        element: <EngineerRepairRequestDetailPage />,
        loader: protectedRouteLoader,
        path: 'engineer/repair-requests/:requestId',
      },
      {
        // 历史维修记录（任务 06）：独立入口，与工单维修总结共用同一套报告编辑界面。
        // 路由治理复用 protectedRouteLoader，角色判定仍由服务端 usecase 复核。
        element: <EngineerMaintenanceRecordsPage />,
        loader: protectedRouteLoader,
        path: 'engineer/maintenance-records',
      },
      {
        element: <EngineerMaintenanceRecordNewPage />,
        loader: protectedRouteLoader,
        path: 'engineer/maintenance-records/new',
      },
      {
        element: <EngineerMaintenanceRecordEditorPage />,
        loader: protectedRouteLoader,
        path: 'engineer/maintenance-records/:reportId',
      },
      {
        // 工单维修总结待填写列表：服务端只返回本人已接且已结单的工单。
        element: <EngineerWorkOrderSummariesPage />,
        loader: protectedRouteLoader,
        path: 'engineer/work-order-summaries',
      },
      {
        element: <EngineerWorkOrderSummaryEditorPage />,
        loader: protectedRouteLoader,
        path: 'engineer/work-order-summaries/:repairRequestId',
      },
      {
        // 我的资料记录（任务 07）：ENGINEER 与 SUPER_ADMIN 可进入（导航目录对管理员同入口）；
        // 页面只展示本人创建记录（后端 usecase 独立复核 activeRole 与作者 + 本组织谓词）
        element: <MyRecordsPage />,
        loader: protectedRouteLoader,
        path: 'engineer/records',
      },
      {
        element: <MyRecordDetailPage />,
        loader: protectedRouteLoader,
        path: 'engineer/records/:recordId',
      },
      {
        element: <CustomerPage />,
        loader: protectedRouteLoader,
        path: 'customer',
      },
      {
        // T-04（前移注册）：列表与详情；角色治理复用 protectedRouteLoader，
        // SUPER_ADMIN 按裁定 2 继承放行（不扩大拒绝清单，拒绝清单仍仅拒 /new）。
        element: <CustomerRepairRequestsPage />,
        loader: protectedRouteLoader,
        path: 'customer/repair-requests',
      },
      {
        element: <CustomerRepairRequestDetailRoute />,
        loader: protectedRouteLoader,
        path: 'customer/repair-requests/:requestId',
      },
      {
        element: <RepairRequestCreatePage />,
        loader: protectedRouteLoader,
        path: 'customer/repair-requests/new',
      },
      {
        // 历史维修记录库（任务 07 改造读侧）：角色治理复用 protectedRouteLoader +
        // auth-session 角色路径表（ENGINEER/SUPER_ADMIN 放行，CUSTOMER 安全跳转）。
        // 旧「普通新增」路由 /reference-documents/new 已下线（任务 07 关闭旧入口），
        // 直达地址落 404，而不是仅隐藏按钮。
        element: <ReferenceDocumentsPage />,
        loader: protectedRouteLoader,
        path: 'reference-documents',
      },
      {
        // 旧「新增资料」直达地址显式下线（任务 07）：不渲染表单、不再转发到别处，
        // 直接返回 404；写作能力由后续受控修订入口重新引入。
        element: <Error404 />,
        loader: protectedRouteLoader,
        path: 'reference-documents/new',
      },
      {
        element: <ReferenceDocumentDetailPage />,
        loader: protectedRouteLoader,
        path: 'reference-documents/:documentId',
      },
      {
        element: <ProjectStructurePage />,
        path: 'project-structure',
      },
      {
        element: <ErrorPreviewPage />,
        path: 'error-preview',
      },
      {
        element: <SharedUiGalleryPage />,
        loader: sharedUiGalleryLoader,
        path: 'dev/shared-ui',
      },
      {
        element: <Game2048LabPage />,
        loader: game2048LabLoader,
        path: 'labs/game-2048',
      },
      {
        element: <SandboxPlaygroundPage />,
        loader: sandboxPlaygroundLoader,
        path: 'sandbox/playground',
      },
      {
        element: <Error404 />,
        path: '*',
      },
    ],
    element: <AppLayout />,
    errorElement: <RouteErrorBoundary />,
    path: '/',
  },
]);

registerAppRouter(router);

export function App() {
  return <RouterProvider router={router} />;
}
