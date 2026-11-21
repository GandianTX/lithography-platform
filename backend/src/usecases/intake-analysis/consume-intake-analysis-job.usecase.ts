// src/usecases/intake-analysis/consume-intake-analysis-job.usecase.ts
// 首析 Worker 消费用例（任务 03 第二段）：process / complete / fail 三段生命周期。
//
// process 流程（等待模型不持有数据库事务）：
// 1. jobId 归属核对：解析 `intake-analysis:{intakeId}:g{gen}` 并与 payload 比对，
//    异构/伪造 job 直接不可重试失败；
// 2. 账本 recordStarted（worker_processing，source=system）；
// 3. 短事务认领（WAITING→RUNNING 首次，或租约过期接管）→ 获得本次执行的
//    attemptId 凭据；LEASE_ACTIVE / ALREADY_* 不产生第二次执行；
// 4. 事务外读取保存时的报修原稿与可信机型编码，构造传输请求
//    （错误码不假充设备主报警；不发附件、私有链接与无关账号信息）；
// 5. 注入 RAG_DIAGNOSIS_CLIENT 单次调用 diagnose（不重试、不抛传输异常）；
// 6. provider-call 审计（真实请求事实）→ 短事务写回：归属核验（未删除 /
//    工单存在 / 代次匹配 / attempt 凭据有效）→ 正文有效才落 output_text，
//    失败记受控稳定原因码；图形不持久化。
//
// fail 语义：fail 只处理基建级异常（认领/写回前的系统故障、payload 异常等），
// 只推进账本终态；intake 状态由认领/写回路径独占推进 —— 旧执行超时后
// housekeeping 会凭账本行补投并由租约接管恢复，模型失败的明确失败在 process
// 内写回为受控 FAILED（第 0 代失败后仅剩本人唯一一次主动重试）。
//
// 永久错误分类（见 @core/common/async-task/intake-analysis-failure.policy）：
// adapter 传入 nonRetryableCode，确定无法通过补投产生新结果的码落
// `worker_permanent:<code>` 并从补投扫描中排除，避免被移除后无限补投；
// 其余（进程退出、job payload 损坏但 jobId 可解析、租约占用、客户端异常）保留
// `worker_failed:<summary>`，仍由 housekeeping 补投恢复。

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { buildIntakeAnalysisFailureReason } from '@core/common/async-task/intake-analysis-failure.policy';
import {
  parseIntakeAnalysisJobId,
  INTAKE_ANALYSIS_JOB_NAME,
} from '@core/common/async-task/intake-analysis-job-id.policy';
import {
  buildIntakeDiagnosisFaultDescription,
  buildIntakeDiagnosisQuestion,
  normalizeIntakeAnalysisOutputText,
} from '@core/repair-request/policy/intake-analysis-transport.policy';
import { AiProviderCallRecordService } from '@src/modules/ai-provider-call-record/ai-provider-call-record.service';
import { AsyncTaskRecordService } from '@src/modules/async-task-record/async-task-record.service';
import type { IntakeAnalysisFinishInput } from '@src/modules/lithography/lithography.types';
import { IntakeAnalysisService } from '@src/modules/lithography/intake-analysis.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import {
  RAG_DIAGNOSIS_CLIENT,
  RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS,
  RAG_DIAGNOSIS_QUESTION_MAX_UNITS,
  type RagDiagnosisClient,
  type RagDiagnosisInput,
  type RagDiagnosisResult,
} from '@src/usecases/common/ports/rag-diagnosis-client.contract';
import { IntakeAnalysisNonRetryableError } from './intake-analysis-worker.errors';
import type {
  ConsumeIntakeAnalysisJobCompleteInput,
  ConsumeIntakeAnalysisJobFailInput,
  ConsumeIntakeAnalysisJobProcessInput,
  ConsumeIntakeAnalysisJobProcessResult,
} from './intake-analysis-worker.types';

/** 首析审计 bizType（AI 统一 bizKey = traceId） */
export const INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE = 'intake_analysis';

/** 受控失败原因码前缀：模型侧/契约侧失败统一落 intake_analysis_attempt.failure_reason */
export const INTAKE_ANALYSIS_FAILURE_REASON_PREFIX = 'RAG_';
const FAILURE_EMPTY_RESPONSE = `${INTAKE_ANALYSIS_FAILURE_REASON_PREFIX}EMPTY_RESPONSE`;

@Injectable()
export class ConsumeIntakeAnalysisJobUsecase {
  private readonly logger = new Logger(ConsumeIntakeAnalysisJobUsecase.name);

  constructor(
    private readonly intakeAnalysisService: IntakeAnalysisService,
    private readonly asyncTaskRecordService: AsyncTaskRecordService,
    private readonly aiProviderCallRecordService: AiProviderCallRecordService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(RAG_DIAGNOSIS_CLIENT)
    private readonly ragDiagnosisClient: RagDiagnosisClient,
  ) {}

  async process(
    input: ConsumeIntakeAnalysisJobProcessInput,
  ): Promise<ConsumeIntakeAnalysisJobProcessResult> {
    this.assertJobIdMatchesPayload(input);

    await this.asyncTaskRecordService.recordStarted({
      data: {
        queueName: input.queueName,
        jobName: input.jobName,
        jobId: input.jobId,
        traceId: input.traceId,
        bizType: INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
        bizKey: input.traceId,
        source: 'system',
        overwriteExistingSource: true,
        reason: 'worker_processing',
        attemptCount: Math.max(input.attemptsMade + 1, 1),
        maxAttempts: input.maxAttempts,
        overwriteExistingMaxAttempts: true,
        enqueuedAt: input.enqueuedAt,
        startedAt: input.startedAt,
        occurredAt: input.startedAt,
      },
    });

    const claim = await this.transactionRunner.run((transactionContext) =>
      this.intakeAnalysisService.claimForAnalysis({
        intakeId: input.intakeId,
        generationNo: input.generationNo,
        now: input.startedAt ?? new Date(),
        transactionContext,
      }),
    );

    if (claim.kind === 'ALREADY_SUCCEEDED') {
      return { accepted: true, intakeId: input.intakeId, generationNo: input.generationNo };
    }
    if (claim.kind === 'ALREADY_FAILED') {
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_already_failed',
        'INTAKE_ANALYSIS_ALREADY_FAILED',
      );
    }
    if (claim.kind === 'LEASE_ACTIVE') {
      // 租约有效期内不允许并发执行同代次：本执行退出且不触发基建重试
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_lease_active',
        'INTAKE_ANALYSIS_LEASE_ACTIVE',
      );
    }
    if (claim.kind === 'NOT_EXECUTABLE') {
      throw new IntakeAnalysisNonRetryableError(
        `intake_analysis_not_executable:${claim.reason}`,
        'INTAKE_ANALYSIS_NOT_EXECUTABLE',
      );
    }
    if (claim.kind === 'ATTEMPT_STATE_INCONSISTENT') {
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_attempt_state_inconsistent',
        'INTAKE_ANALYSIS_ATTEMPT_STATE_INCONSISTENT',
      );
    }
    const attemptId = claim.attemptId;

    const original = await this.intakeAnalysisService.getIntakeForAnalysis({
      intakeId: input.intakeId,
    });
    if (!original) {
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_original_not_found',
        'INTAKE_ANALYSIS_ORIGINAL_NOT_FOUND',
      );
    }

    const providerStartedAt = new Date();
    const requestId = randomUUID();
    const diagnosisInput = this.buildDiagnosisInput({
      requestId,
      modelCode: original.modelCode,
      errorCode: original.intake.errorCode,
      faultDescription: original.intake.faultDescription,
    });

    let result: RagDiagnosisResult;
    try {
      result = await this.ragDiagnosisClient.diagnose(diagnosisInput);
    } catch (error: unknown) {
      // 契约保证 diagnose 不抛传输异常；此处属于客户端实现缺陷，按不可重试失败处理
      await this.recordProviderCall({
        input,
        providerStatus: 'failed',
        normalizedErrorCode: 'RAG_CLIENT_UNEXPECTED_ERROR',
        providerRequestId: requestId,
        providerStartedAt,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : null,
      });
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_client_unexpected_error',
        'INTAKE_ANALYSIS_CLIENT_UNEXPECTED_ERROR',
      );
    }

    const providerCallId = await this.recordProviderCall({
      input,
      providerStatus: result.ok ? 'succeeded' : 'failed',
      normalizedErrorCode: result.ok ? null : result.code,
      providerRequestId: requestId,
      providerStartedAt,
      errorMessage: null,
    });

    const outcome = this.resolveOutcome(result, providerCallId);
    const finish = await this.transactionRunner.run((transactionContext) =>
      this.intakeAnalysisService.finishIntakeAnalysis({
        input: {
          intakeId: input.intakeId,
          generationNo: input.generationNo,
          attemptId,
          outcome,
        },
        transactionContext,
      }),
    );

    switch (finish.kind) {
      case 'WRITTEN':
        break;
      case 'OWNERSHIP_LOST':
        // 旧执行迟到 / 租约已被接管 / 代次已切换：丢弃本次结果，不得覆盖有效状态
        this.logger.warn(
          `intake analysis result discarded (ownership lost): intakeId=${input.intakeId} generationNo=${input.generationNo} attemptId=${attemptId}`,
        );
        break;
      case 'REJECTED':
        // 已删除 / 无工单 / 代次不匹配：迟到结果不得让已删除报修复活
        this.logger.warn(
          `intake analysis result rejected (${finish.reason}): intakeId=${input.intakeId} generationNo=${input.generationNo}`,
        );
        break;
    }
    return { accepted: true, intakeId: input.intakeId, generationNo: input.generationNo };
  }

  async complete(input: ConsumeIntakeAnalysisJobCompleteInput): Promise<void> {
    await this.asyncTaskRecordService.recordFinished({
      data: {
        queueName: input.queueName,
        jobName: input.jobName,
        jobId: input.jobId,
        traceId: input.traceId,
        bizType: INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
        bizKey: input.traceId,
        source: 'system',
        overwriteExistingSource: true,
        status: 'succeeded',
        reason: 'worker_completed',
        attemptCount: Math.max(input.attemptsMade, 1),
        maxAttempts: input.maxAttempts,
        overwriteExistingMaxAttempts: true,
        enqueuedAt: input.enqueuedAt,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        occurredAt: input.finishedAt,
      },
    });
  }

  async fail(input: ConsumeIntakeAnalysisJobFailInput): Promise<void> {
    await this.asyncTaskRecordService.recordFinished({
      data: {
        queueName: input.queueName,
        jobName: input.jobName,
        jobId: input.jobId,
        traceId: input.traceId,
        bizType: INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
        bizKey: input.traceId,
        source: 'system',
        overwriteExistingSource: true,
        status: 'failed',
        // 永久错误落 `worker_permanent:<code>`（受控终结，housekeeping 不再补投）；
        // 临时故障保留 `worker_failed:<summary>`，仍由补投恢复
        reason: buildIntakeAnalysisFailureReason({
          nonRetryableCode: input.nonRetryableCode,
          summary: input.reason,
        }),
        attemptCount: Math.max(input.attemptsMade, 1),
        maxAttempts: input.maxAttempts,
        overwriteExistingMaxAttempts: true,
        enqueuedAt: input.enqueuedAt,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        occurredAt: input.occurredAt ?? input.finishedAt,
      },
    });
    // intake 状态不在 fail 路径推进：
    // - 认领前失败：意图仍为 WAITING，账本行已终态，housekeeping 凭账本行补投；
    // - 认领后系统故障：intake RUNNING 且尝试行租约会过期，补投后由接管路径恢复；
    // - 模型侧明确失败已在 process 内写回受控 FAILED，不进入本方法。
    // 永久错误同样不改 intake：受控终结只作用于账本行，既不推进代次，也不消耗
    // 客户唯一一次主动重试（代次只由 RetryIntakeAnalysisUsecase 推进）。
  }

  private assertJobIdMatchesPayload(input: ConsumeIntakeAnalysisJobProcessInput): void {
    const parsed = parseIntakeAnalysisJobId(input.jobId);
    if (
      !parsed ||
      parsed.intakeId !== input.intakeId ||
      parsed.generationNo !== input.generationNo
    ) {
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_job_mismatch',
        'INTAKE_ANALYSIS_JOB_MISMATCH',
      );
    }
    if (input.jobName !== INTAKE_ANALYSIS_JOB_NAME) {
      throw new IntakeAnalysisNonRetryableError(
        'intake_analysis_job_name_unknown',
        'INTAKE_ANALYSIS_JOB_NAME_UNKNOWN',
      );
    }
  }

  /**
   * 构造模型请求：仅使用提交时保存的可信机型、业务错误码与故障现象。
   * 业务错误码放入 question（不假充设备主报警 mainError）；
   * fault.description 使用传输截断副本，数据库原稿不变；
   * history 为空（首析），不发送附件、私有下载链接与账号信息。
   */
  private buildDiagnosisInput(params: {
    readonly requestId: string;
    readonly modelCode: string;
    readonly errorCode: string;
    readonly faultDescription: string;
  }): RagDiagnosisInput {
    const question = buildIntakeDiagnosisQuestion({
      modelCode: params.modelCode,
      errorCode: params.errorCode,
      faultDescription: params.faultDescription,
      questionMaxUnits: RAG_DIAGNOSIS_QUESTION_MAX_UNITS,
    });
    const faultDescription = buildIntakeDiagnosisFaultDescription({
      faultDescription: params.faultDescription,
      faultFieldMaxUnits: RAG_DIAGNOSIS_FAULT_FIELD_MAX_UNITS,
    });
    return {
      requestId: params.requestId,
      question,
      history: [],
      context: {
        mode: 'INDEPENDENT',
        equipmentModelCode: params.modelCode,
        stage: null,
        fault: {
          mainError: null,
          unitError: null,
          source: null,
          errorType: null,
          gpibStatus: null,
          description: faultDescription,
          action: null,
          status: null,
        },
      },
    };
  }

  /** 结果映射：有效正文才视为成功；空正文按明确失败处理 */
  private resolveOutcome(
    result: RagDiagnosisResult,
    providerCallId: number | null,
  ): IntakeAnalysisFinishInput['outcome'] {
    if (result.ok) {
      const outputText = normalizeIntakeAnalysisOutputText(result.text);
      if (outputText.length === 0) {
        return { kind: 'FAILED', failureReason: FAILURE_EMPTY_RESPONSE, providerCallId };
      }
      return { kind: 'SUCCEEDED', outputText, providerCallId };
    }
    return {
      kind: 'FAILED',
      failureReason: `${INTAKE_ANALYSIS_FAILURE_REASON_PREFIX}${result.code}`,
      providerCallId,
    };
  }

  private async recordProviderCall(params: {
    readonly input: ConsumeIntakeAnalysisJobProcessInput;
    readonly providerStatus: 'succeeded' | 'failed';
    readonly normalizedErrorCode: string | null;
    readonly providerRequestId: string;
    readonly providerStartedAt: Date;
    readonly errorMessage: string | null;
  }): Promise<number | null> {
    try {
      const record = await this.aiProviderCallRecordService.createRecord({
        data: {
          traceId: params.input.traceId,
          bizType: INTAKE_ANALYSIS_ASYNC_TASK_BIZ_TYPE,
          bizKey: params.input.traceId,
          bizSubKey: `${params.input.intakeId}:g${params.input.generationNo}`,
          source: 'system',
          provider: 'rag-diagnosis',
          model: 'rag-diagnosis',
          taskType: 'generate',
          providerRequestId: params.providerRequestId,
          providerStatus: params.providerStatus,
          normalizedErrorCode: params.normalizedErrorCode,
          errorMessage: params.errorMessage,
          providerStartedAt: params.providerStartedAt,
          providerFinishedAt: new Date(),
        },
      });
      return record.id;
    } catch (auditWriteError: unknown) {
      // 审计写失败不阻断业务写回：provider-call 事实保留在日志中补查
      this.logger.error(
        'intake analysis provider call record write failed',
        auditWriteError instanceof Error ? auditWriteError.stack : String(auditWriteError),
      );
      return null;
    }
  }
}
