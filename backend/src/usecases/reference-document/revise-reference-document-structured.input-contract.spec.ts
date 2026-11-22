// src/usecases/reference-document/revise-reference-document-structured.input-contract.spec.ts
//
// 任务 07 结构化管理修订 GraphQL 变量契约回归（离线，不连数据库）。
//
// 2026-11-22 契约修复回归：前端独立修订页提交的 steps 载荷曾携带 stepNo，
// 而 input ReferenceDocumentStructuredStepInput 不接受该字段，真实浏览器保存
// 恒被 GraphQL 变量校验以 BAD_USER_INPUT（HTTP 400）拒绝；此前只有不校验
// schema 的 mock adapter 单测，无法发现该契约失配。
//
// 本规格在测试内离线生成 schema：用启动时 autoSchemaFile 同一生成器
// @nestjs/graphql GraphQLSchemaFactory（经 GraphQLSchemaBuilderModule），
// 从真实 resolver 与全部引用的 input/output/args 类型生成完整 GraphQLSchema，
// 再用 graphql-js 对完整变量集做与执行期一致的强制校验。
// 2026-11-22 CI 修复：不再读取本地启动服务写出的 src/schema.graphql（gitignored
// 生成物，CI 干净环境不存在）；离线生成与启动时打印的 SDL 由同一元数据存储
// （LazyMetadataStorage → TypeMetadataStorage）驱动，契约等价。生成的 schema
// 字段未绑定 resolver（resolve: undefined），执行语义与此前 buildASTSchema(SDL)
// 一致：变量校验通过后执行期报「Cannot return null」，据此显式断言。
// - 覆盖多步骤、保序、步骤新故障（STEP_NEW_FAULT 按 stepCode 关联）；
// - 服务端按数组序自动生成 stepNo（index+1），前端不提交任何序号字段；
// - 断言无「Variable … got invalid value」类变量强制错误（校验通过后执行期
//   因无 resolver 产生的非空返回错误按预期出现并显式忽略）。
// 边界说明：本规格在既有维护报告草稿 input 契约规格同一层次上补充
// 「变量可通过 schema 校验」的实测；它不等同于浏览器端到端验收。
import { Test, type TestingModule } from '@nestjs/testing';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';

import { PaginationArgs, SortInput } from '@src/adapters/api/graphql/pagination.args';
import { PageInfoType } from '@src/adapters/api/graphql/pagination.type-factory';
import { registerEnums } from '@src/adapters/api/graphql/schema/enum.registry';
import { ReferenceDocumentResolver } from '@src/adapters/api/graphql/reference-document/reference-document.resolver';
import { ReferenceDocumentFilterInput } from '@src/adapters/api/graphql/reference-document/dto/reference-document-filter.input';
import {
  ReferenceDocumentCaseDetailDTO,
  ReferenceDocumentDetailDTO,
  ReferenceDocumentEditableContentDTO,
  ReferenceDocumentFrozenAiDTO,
  ReferenceDocumentFrozenAlarmDTO,
  ReferenceDocumentFrozenFaultDTO,
  ReferenceDocumentFrozenReportDTO,
  ReferenceDocumentFrozenStepDTO,
  ReferenceDocumentListItemDTO,
  ReferenceDocumentPaginatedDTO,
  ReferenceDocumentRevisionDTO,
  ReferenceDocumentRevisionsDTO,
  ReferenceDocumentStructuredContentDTO,
  ReferenceDocumentStructuredFaultDTO,
  ReferenceDocumentStructuredStepDTO,
} from '@src/adapters/api/graphql/reference-document/dto/reference-document-read.dto';
import {
  AdminDeleteReferenceDocumentInput,
  CorrectReferenceDocumentOwnershipInput,
  OfflineReferenceDocumentInput,
  ReferenceDocumentCaseMutationResultDTO,
  ReferenceDocumentManagedMutationResultDTO,
  ReferenceDocumentMutationResultDTO,
  ReferenceDocumentStructuredContentInput,
  ReferenceDocumentStructuredFaultInput,
  ReferenceDocumentStructuredStepInput,
  ReviseReferenceDocumentInput,
  ReviseReferenceDocumentStructuredInput,
  UpdateReferenceDocumentCaseInput,
} from '@src/adapters/api/graphql/reference-document/dto/reference-document-write.dto';

import { graphql as graphqlExec, GraphQLInputObjectType, type GraphQLSchema } from 'graphql';

/** 传入 schema 工厂的类型清单：resolver + 该 resolver 全部引用的
 * args/input/output 类型（LazyMetadataStorage.load 仅收集显式传入的类）。 */
const SCHEMA_TYPES = [
  ReferenceDocumentResolver,
  // args
  PaginationArgs,
  SortInput,
  // inputs
  ReferenceDocumentFilterInput,
  ReviseReferenceDocumentInput,
  ReviseReferenceDocumentStructuredInput,
  ReferenceDocumentStructuredContentInput,
  ReferenceDocumentStructuredFaultInput,
  ReferenceDocumentStructuredStepInput,
  OfflineReferenceDocumentInput,
  AdminDeleteReferenceDocumentInput,
  CorrectReferenceDocumentOwnershipInput,
  UpdateReferenceDocumentCaseInput,
  // outputs（含详情/历史版本嵌套类型）
  ReferenceDocumentDetailDTO,
  ReferenceDocumentEditableContentDTO,
  ReferenceDocumentPaginatedDTO,
  ReferenceDocumentRevisionsDTO,
  ReferenceDocumentMutationResultDTO,
  ReferenceDocumentManagedMutationResultDTO,
  ReferenceDocumentCaseMutationResultDTO,
  ReferenceDocumentCaseDetailDTO,
  ReferenceDocumentListItemDTO,
  ReferenceDocumentFrozenAlarmDTO,
  ReferenceDocumentFrozenStepDTO,
  ReferenceDocumentFrozenFaultDTO,
  ReferenceDocumentStructuredContentDTO,
  ReferenceDocumentStructuredFaultDTO,
  ReferenceDocumentStructuredStepDTO,
  ReferenceDocumentFrozenAiDTO,
  ReferenceDocumentFrozenReportDTO,
  ReferenceDocumentRevisionDTO,
  PageInfoType,
] as const;

const MUTATION = `mutation($id: Int!, $i: ReviseReferenceDocumentStructuredInput!){
  reviseReferenceDocumentStructured(id:$id, input:$i){ id revisionNo }
}`;

/** 与前端 toStructuredRevisePayload 输出形状一致的真实载荷
 * （键集由前端 model/revise-form.spec.ts 钉住，两侧共同构成契约回归）。 */
function buildFrontendShapedVariables() {
  return {
    id: 970001,
    i: {
      expectedVersion: 1,
      reason: '契约回归：结构化管理修订载荷实测',
      title: '契约回归资料',
      description: null,
      equipmentModelId: 2,
      structured: {
        schemaVersion: 1,
        maintenanceDate: '2026-11-22',
        maintenanceEngineerName: '开发工程师 A',
        customerFactoryName: 'R3厂家标记-修订值',
        resetResult: 'NORMAL',
        faults: [
          {
            branchKind: 'INITIAL',
            stepCode: null,
            phaseCode: 'PHASE_02',
            mainError: null,
            unitError: null,
            source: null,
            errorType: null,
            gpibStatus: null,
            faultStatus: null,
            description: '初始故障（测试）',
            action: null,
          },
          {
            branchKind: 'STEP_NEW_FAULT',
            stepCode: 'STEP-2',
            phaseCode: null,
            mainError: null,
            unitError: null,
            source: null,
            errorType: null,
            gpibStatus: null,
            faultStatus: null,
            description: '步骤新故障（测试）',
            action: null,
          },
        ],
        steps: [
          {
            stepCode: 'STEP-1',
            phaseCode: 'PHASE_01',
            errorCode: null,
            partName: null,
            actionText: '检查（测试）',
            resultCode: 'RESOLVED',
          },
          {
            stepCode: 'STEP-2',
            phaseCode: null,
            errorCode: null,
            partName: null,
            actionText: '更换（测试）',
            resultCode: 'NEW_FAULT',
          },
          {
            stepCode: 'STEP-3',
            phaseCode: null,
            errorCode: null,
            partName: null,
            actionText: '复测（测试）',
            resultCode: 'RESOLVED',
          },
        ],
        handlingResult: 'FIXED',
        closureReason: null,
        actualCause: null,
        repairActions: null,
        verificationResult: null,
        supplementaryNote: null,
      },
    },
  };
}

describe('reviseReferenceDocumentStructured 变量契约（真实 schema 校验）', () => {
  let schema: GraphQLSchema;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    const schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    // 与启动时 schema.init.ts 一致：枚举经统一注册表登记后由同一生成器产出。
    registerEnums();
    schema = await schemaFactory.create([...SCHEMA_TYPES]);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('前端形状载荷（多步骤保序 + 步骤新故障关联）通过当前 schema 变量校验', async () => {
    const result = await graphqlExec({
      schema,
      source: MUTATION,
      variableValues: buildFrontendShapedVariables(),
    });
    const coercionErrors = result.errors?.filter((error) =>
      error.message.includes('got invalid value'),
    );
    expect(coercionErrors ?? []).toEqual([]);
    // SDL 无 resolver：变量校验通过后执行期才报非空返回错误——出现该错误
    // 恰恰证明变量强制校验已全部通过。
    expect(result.errors?.some((error) => /Cannot return null/.test(error.message))).toBe(true);
  });

  it('携带 stepNo 的历史缺陷载荷被变量校验拒绝（回归钉住拒绝语义）', async () => {
    const variables = buildFrontendShapedVariables();
    for (const step of variables.i.structured.steps) {
      (step as Record<string, unknown>).stepNo = 1;
    }
    const result = await graphqlExec({ schema, source: MUTATION, variableValues: variables });
    expect(
      result.errors?.some((error) =>
        error.message.includes('Field "stepNo" is not defined by type'),
      ),
    ).toBe(true);
  });

  it('schema 的 steps input 与前端提交白名单一致：无 stepNo、恰六字段', () => {
    const stepInput = schema.getType('ReferenceDocumentStructuredStepInput');
    expect(stepInput).toBeDefined();
    expect(stepInput).toBeInstanceOf(GraphQLInputObjectType);
    const fields = (stepInput as GraphQLInputObjectType).getFields();
    expect(Object.keys(fields).sort()).toEqual(
      ['actionText', 'errorCode', 'partName', 'phaseCode', 'resultCode', 'stepCode'].sort(),
    );
    expect(fields.stepNo).toBeUndefined();
  });
});
