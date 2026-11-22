// src/usecases/reference-document/revise-reference-document-structured.input-contract.spec.ts
//
// 任务 07 结构化管理修订 GraphQL 变量契约回归（离线，不连数据库）。
//
// 2026-11-22 契约修复回归：前端独立修订页提交的 steps 载荷曾携带 stepNo，
// 而 input ReferenceDocumentStructuredStepInput 不接受该字段，真实浏览器保存
// 恒被 GraphQL 变量校验以 BAD_USER_INPUT（HTTP 400）拒绝；此前只有不校验
// schema 的 mock adapter 单测，无法发现该契约失配。
//
// 本规格读取启动时生成的 schema SDL（src/schema.graphql，gitignored 生成物，
// 由当前 DTO 真实生成），用 graphql-js 对完整变量集做与执行期一致的强制校验：
// - 覆盖多步骤、保序、步骤新故障（STEP_NEW_FAULT 按 stepCode 关联）；
// - 服务端按数组序自动生成 stepNo（index+1），前端不提交任何序号字段；
// - 断言无「Variable … got invalid value」类变量强制错误（校验通过后执行期
//   因 SDL 无 resolver 产生的非空返回错误按预期出现并显式忽略）。
// 边界说明：本规格在既有维护报告草稿 input 契约规格同一层次上补充
// 「变量可通过 schema 校验」的实测；它不等同于浏览器端到端验收。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildASTSchema,
  parse,
  graphql as graphqlExec,
  GraphQLInputObjectType,
  type GraphQLSchema,
} from 'graphql';

const SCHEMA_PATH = join(__dirname, '..', '..', 'schema.graphql');

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
  let source: string;

  beforeAll(() => {
    source = readFileSync(SCHEMA_PATH, 'utf8');
    schema = buildASTSchema(parse(source));
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
