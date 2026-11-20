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
import { AdminOrderDetailPage, AdminOrdersPage } from '@/pages/admin-orders';
import { AdminUsersPage } from '@/pages/admin-users';
import {
  CustomerPage,
  CustomerRepairRequestDetailRoute,
  CustomerRepairRequestsPage,
} from '@/pages/customer';
import { EngineerPage } from '@/pages/engineer';
import { EngineerAiHistoryPage, EngineerAiPage } from '@/pages/engineer-ai';
import { EngineerRepairRequestDetailPage } from '@/pages/engineer-repair-request-detail';
import { EngineerRepairRequestsPage } from '@/pages/engineer-repair-requests';
import { ErrorPreviewPage } from '@/pages/error-preview';
import { ProjectStructurePage } from '@/pages/project-structure';
import { ReferenceDocumentDetailPage } from '@/pages/reference-document-detail';
import { ReferenceDocumentNewPage } from '@/pages/reference-document-new';
import { ReferenceDocumentsPage } from '@/pages/reference-documents';
import { RegisterCustomerPage } from '@/pages/register-customer';
import { RegisterEngineerPage } from '@/pages/register-engineer';
import { RepairRequestCreatePage } from '@/pages/repair-request-create';
import { RestrictedPage } from '@/pages/restricted';
import { canAccessSharedUiGallery, SharedUiGalleryPage } from '@/pages/shared-ui-gallery';
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
        // 工单管理直达页（任务 04）：复用 admin-document-database 的维修申请列表/
        // 详情/修订能力；路由治理沿用 protectedRouteLoader 与 /admin/** 角色策略。
        element: <AdminOrdersPage />,
        loader: protectedRouteLoader,
        path: 'admin/orders',
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
        // AI 参考资料库（0907 任务二）：角色治理复用 protectedRouteLoader +
        // auth-session 角色路径表（ENGINEER/SUPER_ADMIN 放行，CUSTOMER 安全跳转）；
        // 新增页对 ENGINEER 由角色路径拒绝清单拦截（与后端写接口精确口径一致）
        element: <ReferenceDocumentsPage />,
        loader: protectedRouteLoader,
        path: 'reference-documents',
      },
      {
        element: <ReferenceDocumentNewPage />,
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
