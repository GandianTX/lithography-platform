// src/infrastructure/logger/logger.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule, PinoLogger } from 'nestjs-pino';

@Module({
  imports: [
    ConfigModule,
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return {
          pinoHttp: {
            level: configService.get<string>('logger.level', 'info'),
            transport: configService.get('logger.transport'),
            redact: configService.get<string[]>('logger.redactFields', []),
            customProps: configService.get('logger.customProps'),
            customLogLevel: configService.get('logger.customLogLevel'),
          },
        };
      },
    }),
  ],
  // 显式导出 PinoLogger：导入本模块的模块即可解析日志依赖，
  // 不必各自再引一次 nestjs-pino 的模块（也让装配可解析性可静态核对）
  exports: [PinoLogger],
})
export class LoggerModule {}
