// src/shared/graphql/index.ts

export {
  clearGraphQLClientCache,
  configureGraphQLRuntime,
  getGraphQLClient,
  getGraphQLRuntimeConfig,
} from './client';
export type { GraphQLErrorDetail, GraphQLIngressErrorType } from './errors';
export {
  GraphQLIngressError,
  isForbiddenIngressError,
  isGraphQLIngressError,
  readGraphQLErrorDetail,
  toGraphQLIngressError,
} from './errors';
export type { GraphQLAuthMode } from './request';
export { executeGraphQL } from './request';
