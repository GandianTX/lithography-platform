// src/shared/http/index.ts

export type { RestRequestInit } from './rest-request';
export { fetchRestWithAuthRetry } from './rest-request';
export type { RestErrorEnvelope } from './rest-response';
export { parseAttachmentFilename, readRestErrorField, toRestErrorEnvelope } from './rest-response';
