import type { AcceptanceEvidenceConfig } from '../host/acceptance-evidence-schema.ts';

type CommandBlocks = NonNullable<AcceptanceEvidenceConfig['commands']>;
export type CommandBlock = CommandBlocks[string];
export type PretestBlock = NonNullable<AcceptanceEvidenceConfig['pretest']>[number];
export type SentinelBlock = NonNullable<AcceptanceEvidenceConfig['sentinel']>;
type CanaryBlock = NonNullable<AcceptanceEvidenceConfig['canary']>;

export type CanaryConfig = Readonly<Omit<CanaryBlock, 'files'> & {
	files: readonly Readonly<CanaryBlock['files'][number]>[];
}>;

/** The slice of a loaded host profile the acceptance resolver reads. */
export interface AcceptanceProfile {
	profileId: string;
	repositoryId: string;
	stateDir: string;
	reviewDir: string;
	runsDir?: string | null;
	acceptanceEvidence?: AcceptanceEvidenceConfig | undefined;
}

export interface AcceptanceConfig {
	readonly root: string;
	readonly profileId: string;
	readonly canaryId: string;
	readonly slug: string;
	readonly packageRoot: string;
	readonly openApiPath: string | null;
	readonly readOnlyBinds: readonly string[];
	readonly output: string;
	readonly runtime: string;
	readonly helpers: string | null;
	readonly node: string;
	readonly packageManager: string | null;
	readonly preflightCommand: readonly string[] | null;
	readonly taskVerificationCommand: readonly string[] | null;
	readonly repositoryId: string;
	readonly stateDir: string;
	readonly reviewDir: string;
	readonly runsDir: string | null;
	readonly preflightResult: string | null;
	readonly providerCredentials: readonly string[];
	readonly canary: CanaryConfig | null;
	readonly caseManifest: string;
	readonly runtimeSources: string;
	readonly commands: Readonly<CommandBlocks>;
	readonly pretest: readonly PretestBlock[];
	readonly sentinel: SentinelBlock | null;
}

export interface SandboxMount { source: string; destination: string }
export interface SandboxSymlink { target: string; destination: string }

export interface CommandSandbox {
	binaries?: readonly SandboxMount[];
	report?: string;
	cwd?: string;
}

export interface NamespaceOptions {
	writable?: readonly string[];
	readOnly?: readonly string[];
	env?: Readonly<Record<string, string>>;
	command?: CommandSandbox;
}

export interface OwnedResult { stdout: string; stderr: string; code: number | null }

export interface OwnedOptions {
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	timeoutMs?: number;
	maxBytes?: number;
	ownerGroupId?: number | null;
}

export type ExecuteOwned = (argv: readonly string[], options?: OwnedOptions) => Promise<OwnedResult>;

export interface SupervisedLaunch {
	argv: readonly string[];
	cwd: string;
	deadline: number;
	readOnly?: readonly SandboxMount[];
	writable?: readonly SandboxMount[];
	symlinks?: readonly SandboxSymlink[];
	env?: Readonly<Record<string, string>>;
	privateEnv?: Readonly<Record<string, string>>;
	now?: () => number;
	maxBytes?: number;
	isolateNetwork?: boolean;
}

export type RunnerOutcome = 'passed' | 'failed' | 'skipped' | 'incomplete';
export type CaseOutcome = RunnerOutcome | 'not-run';

export interface CaseAttempt { outcome: RunnerOutcome; [key: string]: unknown }

export interface CaseEntry {
	file: string;
	caseKey: string;
	obligationIds: string[];
	capabilities: string[];
	[key: string]: unknown;
}
