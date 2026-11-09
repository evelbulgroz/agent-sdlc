import type { GitCliFn } from '../workflow/git-manager.ts';
import type { FakeGovernorScriptItem } from './fake-model-governor.ts';

export type GraphFixtureProfile = 'slice2' | 'slice3' | 'slice4';

export interface GraphFixtureOptions {
	profile?: GraphFixtureProfile;
	workflowPath?: string;
	gitCli?: GitCliFn;
	execCli?: GitCliFn;
}

export type GraphFixtureScript = FakeGovernorScriptItem[];

export interface ExecCall {
	cmd: string;
	args: readonly string[];
	opts: Record<string, unknown>;
}

export interface TwoTaskRequest {
	operationId?: string;
	role?: string;
	attribution?: { roleId?: string; taskId?: string };
}

export const cwdOf = (opts: Record<string, unknown>): string | undefined =>
	typeof opts.cwd === 'string' ? opts.cwd : undefined;
