// src/usecases/intake-analysis/intake-analysis-worker-activation.usecase.ts

import { Inject, Injectable } from '@nestjs/common';
import {
  CAPABILITY_STATE_READER,
  type CapabilityStateReader,
} from '@src/modules/common/capability-state-reader.contract';
import { INTAKE_ANALYSIS_CAPABILITY_ID } from '@src/modules/lithography/queue/intake-analysis-queue.service';

@Injectable()
export class IntakeAnalysisWorkerActivationUsecase {
  constructor(
    @Inject(CAPABILITY_STATE_READER)
    private readonly capabilityStateReader: CapabilityStateReader,
  ) {}

  shouldRun(): boolean {
    return (
      this.capabilityStateReader.getState(INTAKE_ANALYSIS_CAPABILITY_ID).effectiveState ===
      'enabled'
    );
  }
}
