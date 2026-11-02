import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import type {
	EvidenceReceipt, EvidenceReport, InvocationRecord,
} from '../policy/contracts/quality-schema.ts';
import type { RunAuthorizationRecord } from '../policy/contracts/run-authorization-schema.ts';

export interface EvidenceSourceObservation {
	treeSha: string;
	sourceHash: string;
	preparationHash: string;
}

export interface EvidenceInvocationContext {
	worktreeDir: string;
	worktreeRegistryId: string;
	artifactDirectory: string;
	targetPackage: string;
	authorization: RunAuthorizationRecord;
	allowedArgv: readonly (readonly string[])[];
	frozenAdapterBindingHash: string;
	expectedSourceHash: string;
	/** Observes all tracked and untracked source, excluding only approved generated outputs. */
	observeSource(): Promise<EvidenceSourceObservation>;
	/** Only explicitly frozen runtime environment is passed; no inherited environment. */
	environment?: Readonly<Record<string, string>>;
	retryOf?: string | null;
	maxRequestBytes?: number;
	maxDiagnosticBytes?: number;
	/** Remaining authorized execution duration; may narrow, never expand, the frozen timeout. */
	executionDurationCeilingMs?: number;
}

export type EvidenceSpawn = (
	command: string,
	args: readonly string[],
	options: SpawnOptionsWithoutStdio & {
		cwd: string;
		shell: false;
		stdio: ['pipe', 'pipe', 'pipe'];
	},
) => ChildProcessWithoutNullStreams;

export interface EvidenceCompletion {
	invocation: InvocationRecord;
	receipt: EvidenceReceipt;
	report: EvidenceReport | null;
	observations: {
		before: EvidenceSourceObservation | null;
		after: EvidenceSourceObservation | null;
		signal: string | null;
		durationMs: number;
	};
}

export type EvidenceReservation =
	| { kind: 'reserved' }
	| { kind: 'existing'; invocation: InvocationRecord; completion?: EvidenceCompletion };

export interface EvidenceRecordStore {
	/** Atomically inserts and charges the operation, or returns its existing durable record. */
	reserve(invocation: InvocationRecord): Promise<EvidenceReservation>;
	started(invocation: InvocationRecord): Promise<void>;
	/** Atomically publishes invocation, receipt, and observations; missing receipt never passes. */
	complete(completion: EvidenceCompletion): Promise<void>;
}

export interface EvidenceCallbacks {
	now?: () => Date;
	onDiagnostics?: (sanitized: string) => void;
}

export interface EvidenceExecutionResult extends EvidenceCompletion {
	reused: boolean;
}
