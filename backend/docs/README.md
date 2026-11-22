# Docs Index

For AIGC. Read less. Route first.

## Folders

- `docs/common/`: global architecture and shared conventions
- `docs/capabilities/`: stable semantic capability decisions referenced by code anchors
- `docs/api/`: API / GraphQL adapter rules
- `docs/worker/`: worker / queue / async-consumer rules
- `docs/project-convention/`: project-specific conventions
- `docs/generated/`: generated local observation docs; do not edit manually
- `docs/frontend/`: optional frontend-facing contract notes and cross-repo alignment drafts, not backend source of truth
- `docs/deprecated/`: historical design background only, not implementation guidance
- `plans/`: active plans, priorities, followups and deliverables
- Do not read `docs/human/` for implementation guidance

## Conflict Or Overlap Resolution

Before applying multiple rule documents, read `docs/common/rule-precedence.rules.md` first.

## Global GraphQL Error Contract

- Every GraphQL interface must follow `docs/api/graphql-error-contract-current.md`.
- AI agents must read it before changing GraphQL adapters, guards, exception filters, auth/session flows, or frontend-facing API docs.
- `errors[].extensions.code === 'UNAUTHENTICATED'` is the stable frontend runtime signal for auth/session failure.
- Frontend must not depend on `extensions.errorCode` for production runtime branching; it may be hidden or omitted.

## Route By Task

- GraphQL error/auth/session response contract:
  - `docs/api/graphql-error-contract-current.md`
  - `docs/api/adapters.rules.md`
  - `docs/api/auth-session-current.md` when auth/session behavior changes

- Layer boundaries:
  - `docs/common/eslint-architecture-rules.md` when you need the lint rule map or validation command
  - `docs/common/boundary-contract.rules.md`
  - `docs/common/core.rules.md`
  - `docs/common/aggregate.rules.md`
  - `docs/common/modules.rules.md`
  - `docs/common/modules.extra.rules.md`
  - `docs/common/usecase.rules.md`
  - `docs/common/usecase-write-flow-boundaries.rules.md`
  - `docs/api/adapters.rules.md`
  - `docs/common/infrastructure.rules.md`
  - `docs/common/entity.rules.md`

- QueryService or type placement:
  - `docs/common/queryservice.rules.md`
  - `docs/common/type.rules.md`

- Aggregate roots, child entities, or Entity purity:
  - `docs/common/aggregate.rules.md`
  - `docs/common/entity.rules.md`
  - `docs/common/usecase-write-flow-boundaries.rules.md`

- Boundary contract or port/contract naming:
  - `docs/common/boundary-contract.rules.md`

- Capability semantics, anchors, or runtime governance:
  - `docs/common/capability.rules.md` for the complete stable rule set
  - `docs/common/capability-plugin-authoring.guide.md` when evaluating an authorized capability proposal or selecting its smallest runtime shape
  - `docs/capabilities/current.md` for current semantic boundaries
  - `docs/common/capability-boundary-examples.md` when a composition usecase looks like a capability
  - `docs/generated/capabilities-current.md` for the generated module-graph projection
  - `docs/common/boundary-contract.rules.md` when adding a narrow layer-owned runtime contract
  - `docs/worker/qm-worker-integration.rules.md` when adding queue transport or worker consumer
  - `docs/api/graphql-error-contract-current.md` when changing capability-aware GraphQL behavior

- Input normalization:
  - `docs/project-convention/input-field-design.md`
  - `docs/project-convention/input-normalize-v1-boundaries.md`

- Time fields or time normalization:
  - `docs/project-convention/time-field-design.md`
  - `docs/project-convention/time-normalize-v1-boundaries.md`

- Database baseline / first-release schema delivery:
  - `docs/project-convention/database-baseline-delivery.rules.md`
  - Also read this when changing physical table names in `@Entity()` or baseline migrations.

- E2E execution model:
  - `docs/project-convention/e2e-test-groups.md`

- AI queue identifiers / async audit / trace semantics:
  - `docs/common/queue-identifiers.rules.md`
  - `docs/common/ai-task-lifecycle-audit.rules.md`
  - `docs/project-convention/ai-provider-call-persistence.rules.md`

- AI workflow context / admission / worker handler:
  - `docs/common/queue-identifiers.rules.md`
  - `docs/common/ai-task-lifecycle-audit.rules.md`
  - `docs/worker/qm-worker-integration.rules.md`
  - `docs/worker/worker-adapter.rules.md`
  - `docs/worker/worker-usecase.rules.md`

- Add a new worker queue:
  - `docs/worker/qm-worker-integration.rules.md`
  - `docs/worker/worker-adapter.rules.md`
  - `docs/worker/worker-usecase.rules.md`

- Email worker delivery:
  - `docs/worker/email-worker-delivery.rules.md`

- Skills:
  - `docs/common/skills.rules.md`

- In-progress plans or phased design:
  - `plans/README.md`
  - read the current plan list inside `plans/README.md`

- Frontend contract alignment:
  - `docs/frontend/README.md`
  - backend truth still comes from `docs/api/*.md` and `docs/common/*.rules.md`

- Auth / session current contract:
  - `docs/api/graphql-error-contract-current.md`
  - `docs/api/auth-session-current.md`

- Account / userInfo write current contract:
  - `docs/api/account-write-current.md`

## One-Line Meanings

- `core.rules`: pure domain only
- `capability.rules`: semantic decisions, minimal anchors, runtime contributions, state, and observation rules
- `capability-plugin-authoring.guide.md`: non-normative smallest-shape and human-observation guide
- `capability-boundary-examples.md`: generic classification examples and the composition negative example
- `capabilities/current.md`: stable current semantic capability boundaries
- `generated/capabilities-current.md`: generated shallow projection from the API/Worker module graphs
- `eslint-architecture-rules.md`: executable lint rule map and architecture validation commands
- `boundary-contract.rules`: layer-owned contract naming and port/contract distinction
- `aggregate.rules`: aggregate root and child-entity write boundaries
- `modules.rules`: reusable same-domain services only
- `modules.extra.rules`: optional but common modules(service) practices
- `usecase.rules`: orchestration and transaction ownership
- `usecase-write-flow-boundaries.rules`: write-flow split and transaction-root boundaries
- `adapters.rules`: protocol adaptation only
- `infrastructure.rules`: external/runtime implementation only
- `entity.rules`: ORM Entity purity and adapter-decorator ban
- `queryservice.rules`: read-side access and normalized output
- `type.rules`: where shared vs local types belong
- `queue-identifiers.rules`: `jobId` vs `dedupKey` vs `traceId`
- `ai-task-lifecycle-audit.rules`: async task audit semantics
- `ai-provider-call-persistence.rules`: provider-call record semantics
- `database-baseline-delivery.rules`: first-release baseline migration and table naming rules
- `e2e-test-groups.md`: `core` / `worker` / `smoke` test routing
- `input-field-design.md`: input-normalization design
- `input-normalize-v1-boundaries.md`: primitive normalize boundaries
- `time-field-design.md`: `TIMESTAMP(3)` vs `DATE` vs `DATETIME`
- `time-normalize-v1-boundaries.md`: parse / normalize / format / guard boundaries
- `qm-worker-integration.rules.md`: queue integration checklist, AI workflow handler registration and generic workflow boundary
- `worker-adapter.rules.md`: worker adapter boundary
- `worker-usecase.rules.md`: worker usecase boundary
- `email-worker-delivery.rules.md`: email delivery runtime boundary
- `skills.rules.md`: skill authoring and usage
- `graphql-error-contract-current.md`: global GraphQL error/auth runtime contract for every interface
- `auth-session-current.md`: current auth / session / identity contract snapshot
- `account-write-current.md`: current account / userInfo write contract snapshot
- `admin-document-database-graphql-current.md`: current admin Document Database read-only GraphQL aggregation contract snapshot (PR3, SUPER_ADMIN only)
- `reference-document-graphql-current.md`: current reference-document GraphQL read/write contract and task-07 management audit handoff
- `plans/README.md`: planning directory usage, reading order and current plan index
