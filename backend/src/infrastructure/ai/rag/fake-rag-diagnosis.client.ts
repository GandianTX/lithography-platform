// src/infrastructure/ai/rag/fake-rag-diagnosis.client.ts
// RAG 公共诊断客户端的可注入替身（boundary contract 的测试实现）。
//
// 用途：03／05 在公共 PR 合入前即可通过同一令牌装配并演练；
// 不发起任何网络请求，不读取配置，不写数据库。
// 返回内容固定取自 rag-diagnosis.fixture.ts 的三组合成样例。

import { Injectable } from '@nestjs/common';
import {
  RAG_DIAGNOSIS_ERROR_CODES,
  type RagDiagnosisClient,
  type RagDiagnosisInput,
  type RagDiagnosisOptions,
  type RagDiagnosisResult,
} from '@usecases/common/ports/rag-diagnosis-client.contract';
import { RAG_DIAGNOSIS_FIXTURES } from './rag-diagnosis.fixture';

export type FakeRagDiagnosisCall = Readonly<{
  input: RagDiagnosisInput;
  /** 调用时 signal 是否已取消（用于断言「发起前取消」路径） */
  signalAborted: boolean;
}>;

@Injectable()
export class FakeRagDiagnosisClient implements RagDiagnosisClient {
  /** 按调用顺序记录的入参，供消费方测试断言 */
  readonly calls: FakeRagDiagnosisCall[] = [];

  private readonly resultsByRequestId: ReadonlyMap<string, RagDiagnosisResult> = new Map(
    RAG_DIAGNOSIS_FIXTURES.map((fixture) => [fixture.input.requestId, fixture.expectedResult]),
  );

  diagnose(input: RagDiagnosisInput, options?: RagDiagnosisOptions): Promise<RagDiagnosisResult> {
    const signalAborted = options?.signal?.aborted === true;
    this.calls.push({ input, signalAborted });

    // 与真实客户端保持同一语义：发起前已取消不发请求，直接归 CANCELLED。
    if (signalAborted) {
      return Promise.resolve({
        ok: false,
        requestId: input.requestId,
        code: RAG_DIAGNOSIS_ERROR_CODES.CANCELLED,
      });
    }

    const result = this.resultsByRequestId.get(input.requestId);
    if (!result) {
      return Promise.reject(
        new Error(`FakeRagDiagnosisClient 未登记 requestId：${input.requestId}`),
      );
    }
    return Promise.resolve(result);
  }
}
