// src/usecases/common/file-upload.contract.ts

/**
 * 文件上传共享边界契约（usecases/common 契约位：跨域共用，架构规则豁免跨域导入）。
 *
 * 扩展名 → 规范 MIME 映射的单一真源：管理员参考资料上传与投稿附件上传共用，
 * 以扩展名为主判定、以映射结果写入数据库 MIME，不信任客户端 Content-Type；
 * 白名单放行与否由各域上传策略 token（env 可收窄）另行裁决，
 * 映射外扩展名（含无扩展名）由调用域拒绝为「类型不允许」。
 */
export const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};
