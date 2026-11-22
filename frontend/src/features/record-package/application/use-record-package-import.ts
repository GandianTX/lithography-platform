// src/features/record-package/application/use-record-package-import.ts

import { useCallback, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';

import type {
  RecordPackageCheckResult,
  RecordPackageProcessResult,
} from '../infrastructure/record-package.types';
import { checkRecordPackage, importRecordPackage } from '../infrastructure/record-package-adapter';

export type RecordPackageImportState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'checked'; check: RecordPackageCheckResult; packagePath: string }
  | { status: 'importing'; check: RecordPackageCheckResult; packagePath: string }
  | { status: 'imported'; result: RecordPackageProcessResult; packagePath: string }
  | { status: 'failed'; message: string };

/**
 * 记录包导入流程：安全预检 → 明确确认 → 受控逐项导入 → 逐条结果。
 *
 * - 预检**不写正式业务**，只落检查事实；
 * - 确认时带上预检得到的清单摘要：包内容变了服务端会让旧确认作废；
 * - 换包／重新预检都会清掉上一次的确认状态（`reset`）。
 */
export function useRecordPackageImport() {
  const [state, setState] = useState<RecordPackageImportState>({ status: 'idle' });

  const check = useCallback(async (packagePath: string) => {
    setState({ status: 'checking' });
    try {
      const result = await checkRecordPackage(packagePath);
      setState({ status: 'checked', check: result, packagePath });
      return { ok: true as const, result };
    } catch (error) {
      const message = isGraphQLIngressError(error)
        ? error.userMessage
        : '记录包检查失败，请稍后重试。';
      setState({ status: 'failed', message });
      return { ok: false as const, message };
    }
  }, []);

  const confirmImport = useCallback(async () => {
    setState((previous) => {
      if (previous.status !== 'checked') {
        return previous;
      }
      void (async () => {
        try {
          const result = await importRecordPackage({
            packageId: previous.check.import.packageId,
            packagePath: previous.packagePath,
            manifestChecksum: previous.check.import.manifestChecksum,
          });
          setState({ status: 'imported', result, packagePath: previous.packagePath });
        } catch (error) {
          const message = isGraphQLIngressError(error)
            ? error.userMessage
            : '记录包导入失败，请稍后重试。';
          setState({ status: 'failed', message });
        }
      })();

      return {
        status: 'importing',
        check: previous.check,
        packagePath: previous.packagePath,
      } as const;
    });
  }, []);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, check, confirmImport, reset };
}
