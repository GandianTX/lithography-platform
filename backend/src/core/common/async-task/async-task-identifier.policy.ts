export type AsyncTaskBizDomain =
  'ai_generation' | 'ai_embedding' | 'ai_workflow' | 'intake_analysis' | 'email';

type BizKeyPolicy = 'trace_id' | 'job_id';

const BIZ_KEY_POLICY_BY_DOMAIN: Record<AsyncTaskBizDomain, BizKeyPolicy> = {
  ai_generation: 'trace_id',
  ai_embedding: 'trace_id',
  ai_workflow: 'trace_id',
  // 首析属 AI 链路：bizKey 统一用 traceId（queue-identifiers 规则）
  intake_analysis: 'trace_id',
  email: 'job_id',
};

export interface ResolveAsyncTaskBizKeyInput {
  readonly domain: AsyncTaskBizDomain;
  readonly traceId: string;
  readonly jobId?: string;
  readonly dedupKey?: string;
}

export interface ResolveEnqueueFailureIdentifiersInput {
  readonly domain: AsyncTaskBizDomain;
  readonly traceId?: string;
  readonly dedupKey?: string;
  readonly occurredAt: Date;
  readonly traceIdPrefix: string;
}

export interface ResolvedEnqueueFailureIdentifiers {
  readonly traceId: string;
  readonly failedJobId?: string;
  readonly bizKey: string;
}

export function resolveAsyncTaskBizKey(input: ResolveAsyncTaskBizKeyInput): string {
  const policy = BIZ_KEY_POLICY_BY_DOMAIN[input.domain];
  if (policy === 'trace_id') {
    return normalizeRequiredValue(input.traceId);
  }
  const normalizedJobId = normalizeOptionalValue(input.jobId);
  if (normalizedJobId) {
    return normalizedJobId;
  }
  const normalizedDedupKey = normalizeOptionalValue(input.dedupKey);
  if (normalizedDedupKey) {
    return normalizedDedupKey;
  }
  return normalizeRequiredValue(input.traceId);
}

export function resolveEnqueueFailureIdentifiers(
  input: ResolveEnqueueFailureIdentifiersInput,
): ResolvedEnqueueFailureIdentifiers {
  const traceId =
    normalizeOptionalValue(input.traceId) ?? `${input.traceIdPrefix}${input.occurredAt.getTime()}`;
  const failedJobId = normalizeOptionalValue(input.dedupKey);
  const bizKey = resolveAsyncTaskBizKey({
    domain: input.domain,
    traceId,
    jobId: failedJobId,
    dedupKey: input.dedupKey,
  });
  return {
    traceId,
    failedJobId,
    bizKey,
  };
}

function normalizeOptionalValue(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeRequiredValue(value: string): string {
  const normalized = value.trim();
  return normalized || value;
}
