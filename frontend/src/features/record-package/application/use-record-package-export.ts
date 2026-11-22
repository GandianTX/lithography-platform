// src/features/record-package/application/use-record-package-export.ts

import { useCallback, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type {
  RecordPackageExportResult,
  RecordPackageResourceType,
} from '../infrastructure/record-package.types';
import { exportRecordPackage } from '../infrastructure/record-package-adapter';

export type RecordPackageExportState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'succeeded'; result: RecordPackageExportResult }
  | { status: 'failed'; message: string };

/**
 * 记录包导出流程。
 *
 * 目标目录必须是本机绝对路径（U盘挂载点或空目录），由服务端复核；
 * 前端只把服务端返回的**逐条结论**如实展示，不自行判断哪些记录可导出。
 */
export function useRecordPackageExport() {
  const [state, setState] = useState<RecordPackageExportState>({ status: 'idle' });

  const run = useCallback(
    async (input: {
      targetPath: string;
      /** 可省略：省略时由服务端按可信 session 范围取本公司（来源页导出入口） */
      organizationId?: number;
      resourceType: RecordPackageResourceType;
      recordIds: number[];
    }) => {
      setState({ status: 'running' });
      try {
        const result = await exportRecordPackage(input);
        setState({ status: 'succeeded', result });
        return { ok: true as const, result };
      } catch (error) {
        const message = isGraphQLIngressError(error)
          ? error.userMessage
          : '记录包导出失败，请稍后重试。';
        setState({ status: 'failed', message });
        return { ok: false as const, message };
      }
    },
    [],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, run, reset };
}
