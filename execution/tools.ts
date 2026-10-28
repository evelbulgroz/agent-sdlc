import { execFileSync } from 'node:child_process';
import { ALLOWED_TOOLS } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { type CommandExecFn, runCommandTool } from './tool-commands.ts';
import {
	type MutationToolParameters,
	deleteFileTool,
	replaceInFileTool,
	replaceSnapshotRangeTool,
	writeFileTool,
} from './tool-mutations.ts';
import { assertModelMutationNotGenerated } from './tool-path-guards.ts';
import { executeReadTool } from './tool-read.ts';

export interface AllowedOperationsFlags {
	readonly editIsolatedWorktree?: boolean;
	readonly runAllowlistedCommands?: boolean;
	readonly [key: string]: unknown;
}

export interface ExecuteToolOptions {
	readonly toolName: string;
	readonly parameters?: MutationToolParameters;
	readonly worktreeDir: string;
	readonly allowedPathPrefixes?: readonly string[];
	readonly allowedPackages?: readonly string[];
	readonly allowedOperations?: AllowedOperationsFlags | null;
	readonly generatedPathPrefixes?: readonly string[];
	readonly execCli?: CommandExecFn;
	readonly originalContentHash?: string | null;
	readonly wholeFile?: boolean;
	readonly pageOverflow?: boolean;
}

export function executeTool({
	toolName,
	parameters,
	worktreeDir,
	allowedPathPrefixes = [],
	allowedPackages = [],
	allowedOperations = null,
	generatedPathPrefixes = [],
	execCli = execFileSync as CommandExecFn,
	originalContentHash = null,
	wholeFile = false,
	pageOverflow = false,
}: ExecuteToolOptions): Record<string, unknown> | null {
	if (!(ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
		throw new SdlcError('INVALID_INPUT', `Tool '${toolName}' is not allowlisted`);
	}

	if (allowedOperations) {
		if (
			(toolName === 'write_file' ||
				toolName === 'replace_in_file' ||
				toolName === 'replace_snapshot_range' ||
				toolName === 'delete_file') &&
			allowedOperations.editIsolatedWorktree !== true
		) {
			throw new SdlcError(
				'AUTHORIZATION_INVALID',
				'Operation editIsolatedWorktree is not permitted by authorization envelope',
			);
		}
		if (
			toolName === 'run_allowlisted_command' &&
			allowedOperations.runAllowlistedCommands !== true
		) {
			throw new SdlcError(
				'AUTHORIZATION_INVALID',
				'Operation runAllowlistedCommands is not permitted by authorization envelope',
			);
		}
	}
	if (
		toolName === 'write_file' ||
		toolName === 'replace_in_file' ||
		toolName === 'replace_snapshot_range' ||
		toolName === 'delete_file'
	) {
		assertModelMutationNotGenerated(parameters?.path, generatedPathPrefixes);
	}

	switch (toolName) {
		case 'read_file':
		case 'grep':
		case 'list_dir':
		case 'find_files':
			return executeReadTool(toolName, parameters, { worktreeDir, wholeFile, pageOverflow }) as Record<
				string,
				unknown
			> | null;
		case 'write_file':
			return writeFileTool(parameters, { worktreeDir, allowedPathPrefixes });
		case 'replace_in_file':
			return replaceInFileTool(parameters, {
				worktreeDir,
				allowedPathPrefixes,
				originalContentHash,
			});
		case 'replace_snapshot_range':
			return replaceSnapshotRangeTool(parameters, {
				worktreeDir,
				allowedPathPrefixes,
				originalContentHash,
			});
		case 'delete_file':
			return deleteFileTool(parameters, { worktreeDir, allowedPathPrefixes });
		case 'run_allowlisted_command':
			return { ...runCommandTool(parameters, { worktreeDir, allowedPackages, execCli, pageOverflow }) };
		default:
			throw new SdlcError('INVALID_INPUT', `Unsupported tool: ${toolName}`);
	}
}

const SCHEMA_STR = { type: 'string' } as const;
const SCHEMA_OPT_INT = { anyOf: [{ type: 'integer' }, { type: 'null' }] } as const;
const SCHEMA_OPT_STR = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const SCHEMA_OPT_BOOL = { anyOf: [{ type: 'boolean' }, { type: 'null' }] } as const;

function toolArm(
	toolName: string,
	required: readonly string[],
	properties: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['kind', 'toolName', 'parameters'],
		properties: {
			kind: { type: 'string', enum: ['tool_call'] },
			toolName: { type: 'string', enum: [toolName] },
			parameters: {
				type: 'object',
				additionalProperties: false,
				required,
				properties,
			},
		},
	};
}

export function minimalActionSchema(): Record<string, unknown> {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['action'],
		properties: {
			action: {
				anyOf: [
					toolArm('read_file', ['path', 'start_line', 'end_line'], {
						path: SCHEMA_STR,
						start_line: SCHEMA_OPT_INT,
						end_line: SCHEMA_OPT_INT,
					}),
					toolArm('replace_in_file', ['path', 'old_string', 'new_string', 'expected_file_hash'], {
						path: SCHEMA_STR,
						old_string: SCHEMA_STR,
						new_string: SCHEMA_STR,
						expected_file_hash: SCHEMA_STR,
					}),
					toolArm(
						'replace_snapshot_range',
						['path', 'expected_file_hash', 'start_line', 'end_line', 'new_string', 'acknowledgedShrink'],
						{
							path: SCHEMA_STR,
							expected_file_hash: SCHEMA_STR,
							start_line: { type: 'integer' },
							end_line: { type: 'integer' },
							new_string: SCHEMA_STR,
							acknowledgedShrink: SCHEMA_OPT_BOOL,
						},
					),
					toolArm('write_file', ['path', 'content', 'acknowledgedShrink'], {
						path: SCHEMA_STR,
						content: SCHEMA_STR,
						acknowledgedShrink: SCHEMA_OPT_BOOL,
					}),
					toolArm('delete_file', ['path'], { path: SCHEMA_STR }),
					toolArm('list_dir', ['path'], { path: SCHEMA_STR }),
					toolArm('find_files', ['path', 'pattern', 'query'], {
						path: SCHEMA_STR,
						pattern: SCHEMA_OPT_STR,
						query: SCHEMA_OPT_STR,
					}),
					toolArm('grep', ['path', 'pattern'], { path: SCHEMA_STR, pattern: SCHEMA_STR }),
					toolArm('run_allowlisted_command', ['command', 'args'], {
						command: SCHEMA_STR,
						args: { type: 'array', items: SCHEMA_STR },
					}),
					{
						type: 'object',
						additionalProperties: false,
						required: ['kind', 'summary'],
						properties: {
							kind: { type: 'string', enum: ['complete'] },
							summary: SCHEMA_STR,
						},
					},
				],
			},
		},
	};
}
