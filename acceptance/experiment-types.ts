export type Dimension = 'logicalCalls' | 'physicalCalls' | 'inputTokens' | 'outputTokens' | 'costMicrousd';
export type DimensionAmounts = Record<Dimension, number>;

export interface ScenarioLimits extends DimensionAmounts { runId: string }

export interface DispatchInventoryEntry {
  scenario: string;
  runId: string;
  roleId: string;
  logicalCalls: number;
  maxPhysicalAttempts: number;
  maxPromptTokens: number;
  maxCompletionTokens: number;
}

/** The single experiment configuration shared by validators, the ledger, the governor, and broker messages. */
export interface ExperimentConfiguration extends DimensionAmounts {
  maxElapsedMs: number;
  maxAttemptCostMicrousd: number;
  scenarios: Record<string, ScenarioLimits>;
  dispatchInventory: DispatchInventoryEntry[];
}

export interface RequestedLimits {
  maxPromptTokens: number;
  maxCompletionTokens: number;
  maxPhysicalAttempts: number;
  maxRetriesPerRoute: number;
  maxFailovers: number;
  maxCostMicrousd?: number;
}

export interface ResolvedRole { roleId: string; requestedLimits: RequestedLimits }
export interface RoleRecord { roles: ResolvedRole[] }

export interface DispatchRequest {
  runId: string;
  operationId: string;
  attribution?: { roleId?: string };
  requestedLimits?: RequestedLimits;
  [key: string]: unknown;
}

export interface ExperimentClock { startsAt: number; deadline: number }

export interface CanaryQualityPolicy {
  schemaVersion: string;
  policyId: string;
  testRetryPolicy: string;
  additionalCandidateReviews: number;
  followUpDispatches: number;
  retrieval?: {
    maxPacketBytes: number; maxPacketLines: number;
    maxTotalBytesPerCandidate: number; maxTotalLinesPerCandidate: number;
  };
  execution?: { maxInvocations: number; maxTotalDurationMs: number };
  review?: { maxLogicalDispatches: number; maxPhysicalCalls: number; maxInputTokens: number; maxOutputTokens: number };
}

export interface RecipeBrokerRequest {
  runId: string;
  argv: string[];
  worktree: string;
  timeoutMs: number;
}

export interface RecipeBrokerResult { code: number; stdout: string; stderr: string }

export interface EvidenceBrokerRequest {
  runId: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  stdin: string;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface EvidenceBrokerResult {
  code: number | null;
  signal: string | null;
  reason: string | null;
  stdout: string;
  stderr: string;
}

/** The ledger surface the governor and broker rely on, satisfied by the local and the remote ledger. */
export interface ExperimentLedgerPort {
  dispatchLimits(request: DispatchRequest, scenario: string): DispatchInventoryEntry;
  clock(): ExperimentClock | Promise<ExperimentClock>;
  reserve(request: DispatchRequest, scenario: string, charge: DimensionAmounts): unknown;
  settle(request: DispatchRequest, actual: DimensionAmounts | null): unknown;
}
