// src/adapters/api/graphql/content-submission/content-submission.schema.spec.ts

/**
 * 投稿域 GraphQL schema 收口回归（离线，不连接 MySQL / Redis）。
 *
 * 任务 07 确认需求依据：
 * - 页面 V6.5 §9「不提供普通资料录入或资料库直接新增，也不设资料审核页」；
 * - 功能 V5.6 §3「旧审核仅历史，不批量发布旧待审」「content_submission_review 保留
 *   旧资料审核历史，不作为新资料发布前置」；
 * - 任务书 V2.3 任务 07「关闭旧普通资料新增和审核入口，历史照常授权读取」。
 *
 * 据此「关闭」落在协议层而不只是隐藏按钮（R090：隐藏按钮不替代服务端检查）：
 * 审核决定写入口与对应输入/结果类型必须从 schema 中真实消失，同时审核队列/详情
 * 读取作为合法历史读取保留。本规格用 Nest code-first schema 工厂离线构建 schema，
 * 不需要数据库，因此可在实库验收前独立运行。
 */

/// <reference types="jest" />
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test, TestingModule } from '@nestjs/testing';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';

import { ContentSubmissionResolver } from './content-submission.resolver';
import { initGraphQLSchema } from '../schema/schema.init';

describe('ContentSubmission GraphQL schema（任务 07 审核入口收口，离线）', () => {
  let testingModule: TestingModule;
  let schema: GraphQLSchema;

  beforeAll(async () => {
    // 分页等共享枚举在运行时单点注册（与 api bootstrap / e2e 同口径），否则
    // PaginationArgs.mode 无法解析成 GraphQL 输入类型；该注册不连接任何外部系统。
    initGraphQLSchema();

    testingModule = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();

    schema = await testingModule.get(GraphQLSchemaFactory).create([ContentSubmissionResolver]);
  });

  afterAll(async () => {
    await testingModule.close();
  });

  const mutationFieldNames = (): string[] => {
    const mutationType = schema.getMutationType();
    return mutationType instanceof GraphQLObjectType ? Object.keys(mutationType.getFields()) : [];
  };

  const queryFieldNames = (): string[] => {
    const queryType = schema.getQueryType();
    return queryType instanceof GraphQLObjectType ? Object.keys(queryType.getFields()) : [];
  };

  it('审核决定写入口不在 schema：不提供 mutation、输入类型与结果类型', () => {
    expect(mutationFieldNames()).not.toContain('reviewContentSubmissionDecision');
    expect(schema.getType('ReviewContentSubmissionDecisionInput')).toBeUndefined();
    expect(schema.getType('ContentSubmissionReviewDecisionResultDTO')).toBeUndefined();
  });

  it('不保留 usecase 层拆分名的协议别名（returnContentSubmission / approveContentSubmission）', () => {
    const mutations = mutationFieldNames();
    expect(mutations).not.toContain('returnContentSubmission');
    expect(mutations).not.toContain('approveContentSubmission');
  });

  it('投稿自身写入口（建稿 / 改稿 / 送审）仍在 schema', () => {
    expect(mutationFieldNames()).toEqual(
      expect.arrayContaining([
        'createContentSubmissionDraft',
        'updateContentSubmissionDraft',
        'submitContentSubmission',
      ]),
    );
  });

  it('审核队列/详情读取保留为合法历史读取（旧审核仅历史）', () => {
    expect(queryFieldNames()).toEqual(
      expect.arrayContaining([
        'myContentSubmissions',
        'myContentSubmission',
        'contentSubmissionRevision',
        'reviewContentSubmissions',
        'reviewContentSubmission',
      ]),
    );
  });
});
