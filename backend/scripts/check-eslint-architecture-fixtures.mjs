import { ESLint } from 'eslint';

const RULES = {
  adapterToInfrastructure: 'local-architecture/no-adapter-to-infrastructure-imports',
  adapterTypesFromUsecase: 'local-architecture/no-adapter-types-from-usecase-implementations',
  adapterToQueryService: 'local-architecture/no-adapter-to-queryservice-imports',
  infrastructureToUsecases: 'local-architecture/no-infrastructure-to-usecases-imports',
  modulesToUsecases: 'local-architecture/no-modules-to-usecases-imports',
};

const cases = [
  {
    name: 'reject adapter importing infrastructure through an alias',
    filePath: 'src/adapters/worker/ai/ai-job.mapper.ts',
    code: `
      import { BULLMQ_QUEUES } from '@src/infrastructure/bullmq/bullmq.constants';
      void BULLMQ_QUEUES;
    `,
    ruleId: RULES.adapterToInfrastructure,
    expectViolation: true,
  },
  {
    name: 'allow adapter-local queue protocol view',
    filePath: 'src/adapters/worker/ai/ai-job.mapper.ts',
    code: `
      export const AI_QUEUE_NAME = 'ai-execution';
      void AI_QUEUE_NAME;
    `,
    ruleId: RULES.adapterToInfrastructure,
    expectViolation: false,
  },
  {
    name: 'reject adapter importing a flow type from a Usecase implementation',
    filePath: 'src/adapters/api/graphql/account/account.resolver.ts',
    code: `
      import { FetchUserInfoUsecase, type CompleteUserData } from '@src/usecases/account/fetch-user-info.usecase';
      void FetchUserInfoUsecase;
      type Probe = CompleteUserData;
      void (null as unknown as Probe);
    `,
    ruleId: RULES.adapterTypesFromUsecase,
    expectViolation: true,
  },
  {
    name: 'allow adapter importing a flow type from a dedicated types file',
    filePath: 'src/adapters/api/graphql/account/account.resolver.ts',
    code: `
      import type { CompleteUserData } from '@src/usecases/account/fetch-user-info.types';
      type Probe = CompleteUserData;
      void (null as unknown as Probe);
    `,
    ruleId: RULES.adapterTypesFromUsecase,
    expectViolation: false,
  },
  {
    name: 'allow adapter using an inline type-only import from a dedicated types file',
    filePath: 'src/adapters/api/graphql/account/account.resolver.ts',
    code: `
      import { type CompleteUserData } from '@src/usecases/account/fetch-user-info.types';
      type Probe = CompleteUserData;
      void (null as unknown as Probe);
    `,
    ruleId: RULES.adapterTypesFromUsecase,
    expectViolation: false,
  },
  {
    name: 'reject adapter value-importing from a dedicated types file',
    filePath: 'src/adapters/api/graphql/account/account.resolver.ts',
    code: `
      import { CompleteUserData } from '@src/usecases/account/fetch-user-info.types';
      type Probe = CompleteUserData;
      void (null as unknown as Probe);
    `,
    ruleId: RULES.adapterTypesFromUsecase,
    expectViolation: true,
  },
  {
    name: 'reject adapter importing a type from a Usecase registry',
    filePath: 'src/adapters/worker/ai-workflow/ai-workflow-job.processor.ts',
    code: `
      import type { AiWorkflowHandlerRegistry } from '@src/usecases/ai-worker/ai-workflow-handler.registry';
      type Probe = AiWorkflowHandlerRegistry;
      void (null as unknown as Probe);
    `,
    ruleId: RULES.adapterTypesFromUsecase,
    expectViolation: true,
  },
  {
    name: 'allow adapter importing a Usecases module for DI assembly',
    filePath: 'src/adapters/api/graphql/graphql-adapter.module.ts',
    code: `
      import { AccountUsecasesModule } from '@src/usecases/account/account-usecases.module';
      void AccountUsecasesModule;
    `,
    ruleId: RULES.adapterTypesFromUsecase,
    expectViolation: false,
  },
  {
    name: 'reject adapter importing QueryService implementation',
    filePath: 'src/adapters/api/graphql/account/account.resolver.ts',
    code: `
      import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
      void AccountQueryService;
    `,
    ruleId: RULES.adapterToQueryService,
    expectViolation: true,
  },
  {
    name: 'allow adapter importing Usecase',
    filePath: 'src/adapters/api/graphql/account/account.resolver.ts',
    code: `
      import { FetchUserInfoUsecase } from '@src/usecases/account/fetch-user-info.usecase';
      void FetchUserInfoUsecase;
    `,
    ruleId: RULES.adapterToQueryService,
    expectViolation: false,
  },
  {
    name: 'reject infrastructure importing Usecase implementation',
    filePath: 'src/infrastructure/database/transaction/typeorm-transaction.runner.ts',
    code: `
      import { FetchUserInfoUsecase } from '@src/usecases/account/fetch-user-info.usecase';
      void FetchUserInfoUsecase;
    `,
    ruleId: RULES.infrastructureToUsecases,
    expectViolation: true,
  },
  {
    name: 'allow infrastructure importing usecase-owned contract',
    filePath: 'src/infrastructure/database/transaction/typeorm-transaction.runner.ts',
    code: `
      import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
      type Probe = TransactionRunner;
      void (null as unknown as Probe);
    `,
    ruleId: RULES.infrastructureToUsecases,
    expectViolation: false,
  },
  {
    name: 'reject modules importing a domain-owned usecase contract',
    filePath: 'src/modules/lithography/protected-backup.service.ts',
    code: `
      import { LOCAL_BACKUP_STORAGE } from '@src/usecases/local-runtime/protected-backup.contract';
      void LOCAL_BACKUP_STORAGE;
    `,
    ruleId: RULES.modulesToUsecases,
    expectViolation: true,
  },
  {
    name: 'allow modules importing a shared runtime capability contract',
    filePath: 'src/modules/lithography/protected-backup.service.ts',
    code: `
      import { LOCAL_BACKUP_STORAGE } from '@src/usecases/common/ports/protected-backup.contract';
      void LOCAL_BACKUP_STORAGE;
    `,
    ruleId: RULES.modulesToUsecases,
    expectViolation: false,
  },
];

const eslint = new ESLint({ cwd: process.cwd(), cache: false });
const failures = [];

for (const fixture of cases) {
  const [result] = await eslint.lintText(fixture.code, { filePath: fixture.filePath });
  const fatalMessage = result.messages.find((message) => message.fatal);
  if (fatalMessage) {
    failures.push(`${fixture.name}: fixture did not parse: ${fatalMessage.message}`);
    continue;
  }

  const hasViolation = result.messages.some((message) => message.ruleId === fixture.ruleId);
  if (hasViolation !== fixture.expectViolation) {
    failures.push(
      `${fixture.name}: expected ${fixture.expectViolation ? 'a violation' : 'no violation'} from ${fixture.ruleId}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('eslint architecture fixtures passed\n');
