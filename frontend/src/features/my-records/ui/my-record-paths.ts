// src/features/my-records/ui/my-record-paths.ts

/** 本人记录路由（与 app/router 注册保持一致，单一真源） */
export const MY_RECORDS_LIST_PATH = '/engineer/records';

export function buildMyRecordDetailPath(recordId: number): string {
  return `${MY_RECORDS_LIST_PATH}/${recordId}`;
}

/** 已发布正式资料跳转到参考资料详情（仅在有标识时由调用方渲染入口） */
export function buildPublishedDocumentPath(documentId: number): string {
  return `/reference-documents/${documentId}`;
}

/** 路由参数解析：非正整数返回 null（不发起请求，直接 not-found） */
export function parseMyRecordIdParam(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
