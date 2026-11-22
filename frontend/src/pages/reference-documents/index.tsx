// src/pages/reference-documents/index.tsx

import { ReferenceDocumentList } from '@/features/reference-document';

import { PageHeader } from '@/shared/ui/page-header';

/**
 * 参考资料库列表页。
 *
 * 路由 /reference-documents 在 app/router 注册并复用 protectedRouteLoader；
 * 角色路由放行表仅允许 ENGINEER / SUPER_ADMIN（CUSTOMER 被安全跳转回个人主页），
 * 一级管理员的服务端范围为全部正式资料，工程师/二级管理员为本公司。
 *
 * 任务 07：旧「普通新增」入口（页面按钮与 /reference-documents/new 直达路由）已下线；
 * 本页只保留读侧与受控下载，不渲染任何写入入口。列表组件不读取 Session、不判定角色，
 * 可见数据范围由服务端按请求期会话裁决。
 *
 * 整页视觉变体（PR5 整页视觉计划 20260929）：本页是精确列表路由，页面根挂
 * `reference-library-page` 承担桌面顶部 48.5px 视觉节奏，页头走 `reference-library`
 * 紧凑变体（20/28、12/16、高 67、下距 20）；工作区纯色铺满由 AppLayout 的
 * `app-workspace--reference-library` 负责。详情路由不消费本变体。
 */
export function ReferenceDocumentsPage() {
  return (
    <div className="page-stack reference-library-page">
      <PageHeader
        description="查阅光刻机维护知识库：错误代码手册、维护指南、安全规范与检查表。"
        eyebrow="Reference Documents"
        title="参考资料库"
        variant="reference-library"
      />
      <ReferenceDocumentList />
    </div>
  );
}
