import crypto from 'node:crypto';
import fs from 'node:fs';
import { citationRule, verificationBlock } from './ac-author-feedback.ts';
import { assertToolPathContained, safeCanonicalPath } from './tool-path-guards.ts';
import {
	EXECUTOR_INLINE_BYTE_CAP,
	EXECUTOR_PAGE_EDGE_LINES,
} from './tool-read.ts';

const COMPACT_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'write_file',
	'replace_in_file',
	'replace_snapshot_range',
	'delete_file',
]);

export interface MinimalPromptInput {
	readonly taskId?: string;
	readonly worktreeDir?: string;
	readonly specSummary?: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly agentsMd?: string;
	readonly authoredPaths?: readonly string[];
	readonly targetedVerificationCommand?: readonly string[] | null;
	readonly verificationCommands?: readonly (readonly string[])[];
	readonly generatorCommand?: readonly string[] | null;
	readonly [key: string]: unknown;
}

export interface MinimalToolCallRecord {
	readonly toolName?: string;
	readonly parameters?: Record<string, unknown>;
	readonly result?: Record<string, unknown> | null;
	readonly stepIndex?: number;
}

export function formatAllowlistedCommands(input: MinimalPromptInput = {}): string {
	const list: string[] = [];
	const pushCmd = (cmd: readonly string[] | null | undefined): void => {
		if (!Array.isArray(cmd) || cmd.length === 0) return;
		const text = cmd.join(' ');
		if (!list.includes(text)) list.push(text);
	};
	pushCmd(input.targetedVerificationCommand);
	for (const cmd of input.verificationCommands ?? []) pushCmd(cmd);
	pushCmd(input.generatorCommand);
	if (list.length === 0) return '';
	return `Allowlisted commands:\n${list.map((cmd) => `- ${cmd}`).join('\n')}`;
}

export function compactToolCallEntry(
	call: MinimalToolCallRecord | null | undefined,
	index: number,
	toolCalls: readonly MinimalToolCallRecord[] = [],
	input: MinimalPromptInput = {},
): string {
	const toolName = call?.toolName;
	const params = call?.parameters ?? {};
	const result = call?.result ?? {};
	if (
		toolName === 'write_file' ||
		toolName === 'replace_in_file' ||
		toolName === 'replace_snapshot_range'
	) {
		const compactParams: Record<string, unknown> = { ...params };
		for (const field of ['content', 'old_string', 'new_string']) {
			const val = compactParams[field];
			if (typeof val === 'string') {
				compactParams[`${field}Bytes`] = Buffer.byteLength(val, 'utf8');
				delete compactParams[field];
			}
		}
		return `${toolName} ${JSON.stringify(compactParams)}\n${JSON.stringify(result)}`;
	}
	if (
		toolName === 'read_file' &&
		typeof params.path === 'string' &&
		typeof result?.content === 'string'
	) {
		const targetPath = safeCanonicalPath(params.path);
		const contentBytes = Buffer.byteLength(result.content, 'utf8');
		const hasAuthoredPaths = Array.isArray(input?.authoredPaths) && input.authoredPaths.length > 0;
		const earlyStart =
			typeof result.shownStartLine === 'number'
				? result.shownStartLine
				: typeof params.start_line === 'number'
					? params.start_line
					: 1;
		const earlyEnd =
			typeof result.shownEndLine === 'number'
				? result.shownEndLine
				: typeof params.end_line === 'number'
					? params.end_line
					: Number.MAX_SAFE_INTEGER;
		const superseded = toolCalls.slice(index + 1).some((later) => {
			const laterPath = safeCanonicalPath(later?.parameters?.path);
			if (!laterPath || laterPath !== targetPath) return false;
			if (later?.result?.error || later?.result?.code) return false;
			if (later?.toolName && COMPACT_WRITE_TOOLS.has(later.toolName)) return true;
			if (later?.toolName === 'read_file' && (contentBytes > 64 || hasAuthoredPaths)) {
				const laterStart =
					typeof later?.result?.shownStartLine === 'number'
						? later.result.shownStartLine
						: typeof later?.parameters?.start_line === 'number'
							? later.parameters.start_line
							: 1;
				const laterEnd =
					typeof later?.result?.shownEndLine === 'number'
						? later.result.shownEndLine
						: typeof later?.parameters?.end_line === 'number'
							? later.parameters.end_line
							: Number.MAX_SAFE_INTEGER;
				return laterStart <= earlyStart && laterEnd >= earlyEnd;
			}
			return false;
		});
		if (superseded) {
			const compactResult = {
				...result,
				content: `[collapsed: superseded by later tool call on ${targetPath}]`,
			};
			return `${toolName} ${JSON.stringify(params)}\n${JSON.stringify(compactResult)}`;
		}
	}
	return `${String(toolName)} ${JSON.stringify(params)}\n${JSON.stringify(result)}`;
}

export function formatWorkingSetBlock(input: MinimalPromptInput = {}): string | null {
	if (!Array.isArray(input.authoredPaths) || input.authoredPaths.length === 0) return null;
	if (!input.worktreeDir || typeof input.worktreeDir !== 'string') return null;
	const entries: string[] = [];
	const seen = new Set<string>();
	for (const rawPath of input.authoredPaths) {
		const relPath = safeCanonicalPath(rawPath);
		if (!relPath || seen.has(relPath)) continue;
		seen.add(relPath);
		let resolved: string;
		try {
			resolved = assertToolPathContained(input.worktreeDir, relPath);
		} catch {
			continue;
		}
		if (!fs.existsSync(resolved)) continue;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		const content = fs.readFileSync(resolved, 'utf8');
		const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
		const lines = content.split('\n');
		const bytes = Buffer.byteLength(content, 'utf8');
		const body =
			bytes <= EXECUTOR_INLINE_BYTE_CAP
				? content
				: `${lines.slice(0, EXECUTOR_PAGE_EDGE_LINES).join('\n')}\n...\n${lines.slice(-EXECUTOR_PAGE_EDGE_LINES).join('\n')}`;
		entries.push(
			`File: ${relPath} (expected_file_hash: ${hash}, totalLines: ${lines.length})\n${body}`,
		);
	}
	if (entries.length === 0) return null;
	return `### Working set\n${entries.join('\n\n')}`;
}

export function promptBlocks(
	input: MinimalPromptInput,
	feedback = '',
	toolCalls: readonly MinimalToolCallRecord[] = [],
): string[] {
	const criteria = (input.acceptanceCriteria ?? [])
		.map((item, index) => `${index + 1}. ${item}`)
		.join('\n');
	const commandsSection = formatAllowlistedCommands(input);
	const blocks: string[] = [
		[
			'Implement the task in the worktree. Read, search, edit, and run the allowlisted pnpm command. Declare complete when the task is done.',
			`Task: ${String(input.taskId ?? '')}`,
			input.specSummary ?? '',
			commandsSection,
			criteria,
			citationRule(input.acceptanceCriteria),
			input.agentsMd ?? '',
		]
			.filter((part) => part !== '')
			.join('\n'),
	];
	for (let index = 0; index < toolCalls.length; index += 1) {
		const body = compactToolCallEntry(toolCalls[index], index, toolCalls, input);
		blocks.push(index === 0 ? `### Tool results\n${body}` : body);
	}
	const workingSetBlock = formatWorkingSetBlock(input);
	if (workingSetBlock) blocks.push(workingSetBlock);
	if (feedback) blocks.push(verificationBlock(feedback, toolCalls));
	return blocks;
}
