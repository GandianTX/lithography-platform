# Intake Analysis Capability Decision

Approved by the responsible owner (负责人) on 2026-11-20, in the task 03 working
session: `intake.analysis` is admitted as an independent capability for the
customer repair-request first analysis of task 03 only — its delivery, worker
consumption, and recovery. Task 05 chat and other AI tasks stay out of this
capability's scope.

## `intake.analysis`

Owns the delivery, execution, recovery, and owner-initiated retry of the customer
repair-request first analysis (task 03): the `intake-analysis` BullMQ queue, the
intake claim / lease-takeover / write-back state machine over
`repair_request_intake` + `intake_analysis_attempt`, delivery bookkeeping in
`base_async_task_record`, and housekeeping redelivery.

### Mode, default state, and disable/recovery behavior

- Mode: `switchable`. Default state: enabled (only explicit entries in
  `CAPABILITY_DISABLED_IDS` disable it); `runtime.async-task` loss reports the
  capability as `blocked`, never rewrites configured intent.
- API side: enqueue and state inspection calls fail closed through
  `requireEnabled`; a failed delivery is not a business failure — the ledger row
  stays queued and housekeeping redelivers it.
- Worker side: the BullMQ processor starts with `autorun: false` and runs only
  when the activation usecase reports effective `enabled`. The housekeeping
  runtime trigger uses the same gate: it stays quiet at bootstrap when disabled,
  stops after the in-flight tick once the capability is disabled mid-run, never
  overlaps ticks, and does not claim the backlog while quiet. Disabling is a
  valid quiet state, not a bootstrap error. A processor that was already
  running is not paused per job by a mid-run disable, so jobs already in the
  queue may still be consumed until the process is stopped; only the
  housekeeping trigger consults the gate on every tick. Re-enabling recovery
  requires the capability to be effectively enabled at a worker process
  bootstrap: neither the processor nor the housekeeping trigger auto-resumes
  after a runtime disable, so restart the worker. No automatic recovery without
  restart is implemented or claimed.
- Backlog recovery invariant: a disabled Worker capability leaves the queue
  backlog unclaimed and recoverable — durable state lives in the
  `base_async_task_record` ledger rows and the intake/attempt state machine, not
  in logs or memory.

### Housekeeping redelivery semantics

Housekeeping runs as a periodic trigger inside the worker process only, behind
the same activation gate as the queue processor. Redelivery is state-aware: an
in-flight job (waiting/active/delayed) is never preempted; a retained terminal
job (completed/failed) is removed before re-adding, because a repeated `add`
with the same jobId cannot move a terminal job back into waiting; a missing job
is re-enqueued directly. Recovery safety comes from the claim state machine
(`ALREADY_SUCCEEDED` / `ALREADY_FAILED` / generation match / lease takeover),
not from the redelivery act.

### Ledger reconciliation (write-back finished, ledger not terminal)

A worker process may exit after the intake/attempt write-back and before the
ledger's `complete` / `fail` event. The ledger row then stays `processing` even
though the business result is already durable. Housekeeping settles it from
database facts only (no Redis dependency, no second model call):

- `SUCCEEDED` intake → ledger `succeeded`, reason
  `worker_completed:intake_reconciled`;
- `FAILED` intake → ledger `failed`, reason `worker_failed:intake_reconciled`;
- deleted intake / superseded generation / intake without a converted work
  order → ledger `cancelled` (`intake_cancelled_target_deleted`,
  `intake_cancelled_stale_intent`).

Rules: the settle is a single conditional `UPDATE` whose source status is the
status the row was scanned in, so concurrent `complete` / `fail` writes win or
lose atomically and one terminal state is never rewritten into another; a
`succeeded` ledger row is never a settle source; intake and attempt rows are
never written by reconciliation; a model-side failure is never recorded as
success (`FAILED` is only ever settled to `failed`). Reconciliation does not
advance the analysis generation and does not consume the owner's single retry.

### Permanent failures versus transient infrastructure errors

An intent that cannot produce a new result no matter how often it is
redelivered is settled once as `failed` with the stable prefix
`worker_permanent:<code>` and excluded from later scans:

- unparsable ledger `jobId` (`intake_job_id_unparsable`);
- `intake_analysis_attempt` state outside the state machine (requires manual
  repair);
- non-retryable codes where redelivery cannot possibly help
  (`INTAKE_ANALYSIS_ATTEMPT_STATE_INCONSISTENT`,
  `INTAKE_ANALYSIS_ORIGINAL_NOT_FOUND`, `INTAKE_ANALYSIS_ALREADY_FAILED`).

Everything else stays `worker_failed:<summary>` and remains redeliverable:
process exits, Redis/MySQL hiccups, a corrupted job payload whose `jobId` is
still parsable (redelivery rebuilds the payload), and lease contention. Neither
classification advances the analysis generation or spends the customer's retry;
permanent errors are terminated for manual handling, transient errors are not.
Settled rows (`worker_permanent:*`, `worker_failed:intake_reconciled`) are
filtered out of the scan query so they cannot starve the limited batch.

### Prerequisites

Durable async-task availability (`runtime.async-task`) is a hard prerequisite:
the delivery intent ledger row is written inside the submission/retry transaction,
so without it neither reliable delivery nor crash recovery can be expressed.

Worker consumption of intake jobs additionally requires the account entity
metadata closure (string foreign keys on `repair_request_intake` and stored-file
entities reference `base_user_account`); the worker module graph therefore
assembles the account base through `AccountInstallerModule`, which makes the
always-on `identity.account` anchor visible in the worker process as a derived
graph fact.

Model invocation itself stays with the shared RAG diagnosis client contract
(`RAG_DIAGNOSIS_CLIENT`); this capability does not own provider selection or
provider-call persistence beyond recording the request fact per execution.

Owner-initiated retry (generation 0 → 1) is the only path that advances the
analysis generation. Infrastructure redelivery (BullMQ attempts, housekeeping)
never advances or consumes the retry opportunity.

### Customer self-service scope (owner ruling, 2026-11-20)

Self-service is limited to the single generation 0 → 1 retry after a confirmed
model failure. Same-generation customer recovery (re-running the current
generation without spending the ordinary retry) is **not** implemented: with the
current schema the "this generation already accepted one customer recovery" and
"recovery pending delivery" facts cannot be recorded atomically and durably —
`repair_request_intake` only carries `analysis_status` / `analysis_generation`,
`intake_analysis_attempt` is unique per `(intake_id, generation_no)` so a re-run
would destroy the failure evidence, and the deterministic `(queue_name, job_id)`
ledger row for the same generation is already occupied by the first delivery.
No migration, in-memory counter, client-side debounce, or overwritable `reason`
is used as a substitute. Background-only fault recovery stays with BullMQ
attempts and housekeeping redelivery and never spends the customer's retry.
The eligibility judgement is read from persisted facts only (intake/attempt
state and the delivery-intent ledger row); ledger `failed` /
`worker_permanent:` prefixes never authorize self-service.
