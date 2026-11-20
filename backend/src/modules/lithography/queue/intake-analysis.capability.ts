// src/modules/lithography/queue/intake-analysis.capability.ts
// 首析能力锚点：投递与 Worker 消费统一受 `intake.analysis` 能力开关控制。

import { Injectable } from '@nestjs/common';
import { CapabilityAnchorProvider } from '@src/infrastructure/capability/capability.decorators';

export const INTAKE_ANALYSIS_CAPABILITY_ANCHOR_ID = 'intake.analysis' as const;

@Injectable()
@CapabilityAnchorProvider({
  capabilityId: INTAKE_ANALYSIS_CAPABILITY_ANCHOR_ID,
  mode: 'switchable',
  decisionRef: 'docs/capabilities/intake-analysis.md',
  requires: ['runtime.async-task'],
})
export class IntakeAnalysisCapabilityAnchor {}
