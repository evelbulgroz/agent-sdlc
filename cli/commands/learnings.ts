import path from 'node:path';
import { loadLearningStore, resolveLearningStorePath, searchLearningStore, addLearningBatch, addLearningEntry } from '../../host/learnings.ts';
import { learningStoreStats, pruneLearningStore, validateLearningStore } from '../../host/learnings-admin.ts';
import { loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { checkGraduations } from '../../host/learnings-graduations.ts';
import { SdlcError } from '../../policy/errors.ts';
import type { ParsedArguments } from '../arguments.ts';
import type { CommandDispatchOptions } from './index.ts';
import { readFileSync } from 'node:fs';

type LearningsAction = 'search' | 'add' | 'prune' | 'validate' | 'stats' | 'graduations';

async function readPayload(parsed: ParsedArguments, options: CommandDispatchOptions): Promise<unknown> {
	const file = parsed.values.get('--file');
	let raw = '';
	if (file) {
		raw = readFileSync(path.resolve(options.rootDir, file), 'utf-8');
	} else if (parsed.booleans.has('--stdin')) {
		const chunks: Buffer[] = [];
		for await (const chunk of options.streams.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
		raw = Buffer.concat(chunks).toString('utf-8');
	}
	if (!raw.trim()) {
		throw new SdlcError('INVALID_INPUT', 'learnings add requires a JSON payload via --file <path> or --stdin');
	}
	try {
		return JSON.parse(raw);
	} catch (error: unknown) {
		throw new SdlcError('INVALID_INPUT', `Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function runAction(
	action: LearningsAction,
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	repoRoot: string,
	storePath: string,
): Promise<Record<string, unknown>> {
	const scopeOptions = { rootDir: repoRoot };
	switch (action) {
		case 'search': {
			const query = parsed.values.get('--query') ?? '';
			const scope = parsed.values.get('--scope');
			if (!query && !scope) throw new SdlcError('INVALID_INPUT', 'learnings search requires --query and/or --scope');
			const results = await searchLearningStore(await loadLearningStore(storePath), {
				query,
				scope,
				limit: parsed.values.get('--limit'),
			});
			return { storePath, results };
		}
		case 'add': {
			const payload = await readPayload(parsed, options);
			const upsert = parsed.booleans.has('--upsert');
			const isBatch = Array.isArray(payload) || Array.isArray((payload as { candidates?: unknown } | null)?.candidates);
			const added = isBatch
				? await addLearningBatch(storePath, payload, { upsert, ...scopeOptions })
				: [await addLearningEntry(storePath, payload, { upsert, ...scopeOptions })];
			return { storePath, added: added.map((entry) => entry.key) };
		}
		case 'prune':
			return { storePath, ...(await pruneLearningStore(storePath, {
				key: parsed.values.get('--key'),
				missingFiles: parsed.booleans.has('--missing-files'),
				apply: parsed.booleans.has('--apply'),
				repoRoot,
			})) };
		case 'validate':
			return { storePath, ...(await validateLearningStore(storePath, scopeOptions)) };
		case 'graduations': {
			const report = checkGraduations(await loadLearningStore(storePath), repoRoot, loadHostProfileOrFallback(repoRoot).learnings?.graduations);
			const advisory = parsed.booleans.has('--advisory') || parsed.booleans.has('--warn-only');
			return { storePath, ...report, advisory, blocking: !report.ok && !advisory };
		}
		case 'stats':
			return { storePath, ...learningStoreStats(await loadLearningStore(storePath)) };
	}
}

export function learningsHandler(action: LearningsAction) {
	return async (parsed: ParsedArguments, options: CommandDispatchOptions): Promise<Record<string, unknown>> => {
		const rawRoot = parsed.values.get('--root');
		const repoRoot = rawRoot ? path.resolve(options.rootDir, rawRoot) : options.rootDir;
		const rawStore = parsed.values.get('--store');
		const storePath = await resolveLearningStorePath(
			{ rootDir: repoRoot, ...(rawStore ? { store: path.resolve(repoRoot, rawStore) } : {}) },
			repoRoot,
		);
		try {
			return await runAction(action, parsed, options, repoRoot, storePath);
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			throw new SdlcError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
		}
	};
}

export function learningsExitCode(result: Record<string, unknown>): number {
	if (result.blocking === true) return 1;
	return result.valid === false ? 2 : 0;
}
