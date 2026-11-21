/// <reference types="jest" />
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { CapabilityModule } from '@src/infrastructure/capability/capability.module';
import { BULLMQ_QUEUES } from '@src/infrastructure/bullmq/bullmq.constants';
import { IntakeAnalysisQueueModule } from './intake-analysis-queue.module';
import { IntakeAnalysisQueueService } from './intake-analysis-queue.service';
import { BullMqProducerGateway } from '@src/infrastructure/bullmq/producer.gateway';

/**
 * IntakeAnalysisQueueModule 真实依赖装配回归（离线，不连 Redis）。
 *
 * IntakeAnalysisQueueService 注入 BullMqProducerGateway，后者由 BullMqModule
 * 导出——若本模块漏导入 BullMqModule（DI 桥接缺失），Nest 解析会在此失败。
 * 替身边界：BullMQ 队列 token 全部替换为空对象（避免真实 Redis 连接）；
 * ConfigService 以全局 ConfigModule 内存配置提供，不读 env 文件、不触网。
 */
const queueTokens = Object.values(BULLMQ_QUEUES).map((queueName) => getQueueToken(queueName));

describe('IntakeAnalysisQueueModule 依赖装配（离线）', () => {
  it('经 BullMqModule 导入可解析 IntakeAnalysisQueueService 与 ProducerGateway', async () => {
    const builder = Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [
            () => ({
              redis: { host: '127.0.0.1', port: 6390, db: 0, tls: false },
              bullmq: { prefix: 'bullmq-assembly-spec' },
            }),
          ],
        }),
        CapabilityModule.forRoot({ process: 'api' }),
        IntakeAnalysisQueueModule,
      ],
    });
    for (const token of queueTokens) {
      builder.overrideProvider(token).useValue({});
    }
    const moduleRef = await builder.compile();
    try {
      expect(moduleRef.get(IntakeAnalysisQueueService)).toBeInstanceOf(IntakeAnalysisQueueService);
      expect(moduleRef.get(BullMqProducerGateway)).toBeInstanceOf(BullMqProducerGateway);
    } finally {
      await moduleRef.close();
    }
  });
});
