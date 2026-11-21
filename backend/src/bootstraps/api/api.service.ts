// src/bootstraps/api/api.service.ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface ApiHealthPayload {
  readonly status: 'ok';
  readonly service: 'api';
  /**
   * 可选的运行实例标识。
   *
   * 仅在进程环境显式设置 `APP_INSTANCE_TAG` 时返回，用于隔离验收核对
   * 「浏览器同源代理命中的就是本轮启动的 API」；未设置时响应与既有契约一致。
   */
  readonly instanceTag?: string;
  readonly timestamp: string;
  readonly uptimeSeconds: number;
}

export interface ApiReadinessPayload {
  readonly status: 'ready';
  readonly service: 'api';
  readonly checks: {
    readonly database: 'up';
  };
  readonly timestamp: string;
}

@Injectable()
export class ApiService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  getHealth(): ApiHealthPayload {
    const instanceTag = (process.env.APP_INSTANCE_TAG ?? '').trim();
    return {
      status: 'ok',
      service: 'api',
      ...(instanceTag.length > 0 ? { instanceTag } : {}),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  async getReadiness(): Promise<ApiReadinessPayload> {
    if (!this.dataSource.isInitialized) {
      throw new Error('database datasource not initialized');
    }
    await this.dataSource.query('SELECT 1');
    return {
      status: 'ready',
      service: 'api',
      checks: {
        database: 'up',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
