// src/modules/common/ai-worker/ai-worker.module.spec.ts
/// <reference types="jest" />

import type { ConfigService } from '@nestjs/config';

import type { AiConversationModelInvoker } from './conversation/ai-conversation-model.types';
import { selectAiConversationModelInvoker } from './ai-worker.module';

type ConfigEntry = readonly [key: string, value: unknown];

const fakeConfig = (entries: readonly ConfigEntry[]): ConfigService => {
  const values = new Map(entries);
  return {
    get: (key: string, defaultValue?: unknown) =>
      values.has(key) ? values.get(key) : defaultValue,
  } as unknown as ConfigService;
};

const named = (name: string) => ({ name }) as unknown as AiConversationModelInvoker;

const candidates = {
  rag: named('rag'),
  remote: named('remote'),
  fixture: named('fixture'),
};

const REMOTE_PROVIDER: ConfigEntry = ['aiWorker.providerMode', 'remote'];
const RAG_READY: readonly ConfigEntry[] = [
  ['ragDiagnosis.mode', 'remote'],
  ['ragDiagnosis.baseUrl', 'https://rag.example.com'],
  ['ragDiagnosis.apiKey', 'k'],
];

describe('selectAiConversationModelInvoker', () => {
  it('mock 模式优先走开发夹具（即使 RAG 已配置）', () => {
    const selected = selectAiConversationModelInvoker(
      fakeConfig([['aiWorker.providerMode', 'mock'], ...RAG_READY]),
      candidates,
    );

    expect(selected).toBe(candidates.fixture);
  });

  it('remote 且 RAG 配置齐全：走公共 RAG 客户端', () => {
    const selected = selectAiConversationModelInvoker(
      fakeConfig([REMOTE_PROVIDER, ...RAG_READY]),
      candidates,
    );

    expect(selected).toBe(candidates.rag);
  });

  it.each<{ label: string; entries: readonly ConfigEntry[] }>([
    {
      label: '显式 disabled',
      entries: [['ragDiagnosis.mode', 'disabled']],
    },
    {
      label: '缺少密钥',
      entries: [
        ['ragDiagnosis.mode', 'remote'],
        ['ragDiagnosis.baseUrl', 'https://rag.example.com'],
        ['ragDiagnosis.apiKey', ''],
      ],
    },
    {
      label: '缺少地址',
      entries: [
        ['ragDiagnosis.mode', 'remote'],
        ['ragDiagnosis.baseUrl', ''],
        ['ragDiagnosis.apiKey', 'k'],
      ],
    },
    { label: '未配置', entries: [] },
  ])('remote 但 RAG 不可用（$label）：保留既有直连 provider', ({ entries }) => {
    const selected = selectAiConversationModelInvoker(
      fakeConfig([REMOTE_PROVIDER, ...entries]),
      candidates,
    );

    expect(selected).toBe(candidates.remote);
  });
});
