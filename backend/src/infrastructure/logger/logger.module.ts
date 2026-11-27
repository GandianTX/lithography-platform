// src/infrastructure/logger/logger.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

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
  // 显式导出 **nestjs-pino 的模块类**：导入本模块的模块即可解析日志依赖，
  // 不必各自再引一次 nestjs-pino 的模块（也让装配可解析性可静态核对）。
  //
  // 注意：**不能**导出 PinoLogger 这个 provider——Nest 11 只允许转导出「模块类」，
  // 转导出 provider 会在装配期抛 `UnknownExportException`
  // （`validateExportedProvider` 只接受本模块自有 provider 或已导入的模块类），
  // 导致本模块**无法被任何独立装配**（应用启动、实库/集成用例）引用。
  // nestjs-pino 的模块本身是 @Global，日志依赖在任何位置都可解析。
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
