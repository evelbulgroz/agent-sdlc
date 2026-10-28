// Author-vendor canonicalisation and resolution for heterogeneous critic review.
// Leaf module: the critic adapter, gate, and CLI commands import from here.

import { SdlcError } from '../policy/errors.ts';

export type CanonicalAuthorVendor =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'xai'
	| 'deepseek'
	| 'meta';

export type HostVendor = 'google' | 'copilot' | 'xai' | 'anthropic';

export interface AuthorVendorSnapshot {
	runId?: string;
	authorVendor?: string | null;
}

export interface AuthorVendorRuntimeStoreLike {
	database?: {
		prepare(sql: string): {
			all(...params: unknown[]): unknown[];
		};
	} | null;
}

export function canonicalizeAuthorVendor(raw: unknown): CanonicalAuthorVendor {
	if (!raw || typeof raw !== 'string') {
		throw new SdlcError('AUTHOR_VENDOR_UNKNOWN', 'Canonical author vendor is required');
	}
	const normalized = raw.trim().toLowerCase();
	if (
		normalized === 'openai' ||
		normalized === 'copilot' ||
		normalized === 'github' ||
		normalized === 'github-copilot' ||
		normalized.startsWith('openai/') ||
		normalized.startsWith('copilot/') ||
		normalized.startsWith('gpt-') ||
		normalized.startsWith('o1-') ||
		normalized.startsWith('o3-')
	) {
		return 'openai';
	}
	if (
		normalized === 'anthropic' ||
		normalized.startsWith('anthropic/') ||
		normalized.startsWith('claude-') ||
		normalized === 'claude'
	) {
		return 'anthropic';
	}
	if (
		normalized === 'google' ||
		normalized === 'antigravity' ||
		normalized.startsWith('google/') ||
		normalized.startsWith('gemini-') ||
		normalized === 'gemini'
	) {
		return 'google';
	}
	if (
		normalized === 'xai' ||
		normalized === 'x-ai' ||
		normalized.startsWith('xai/') ||
		normalized.startsWith('x-ai/') ||
		normalized.startsWith('grok-') ||
		normalized === 'grok'
	) {
		return 'xai';
	}
	if (
		normalized === 'deepseek' ||
		normalized.startsWith('deepseek/') ||
		normalized.startsWith('deepseek-')
	) {
		return 'deepseek';
	}
	if (
		normalized === 'meta' ||
		normalized.startsWith('meta/') ||
		normalized.startsWith('meta-llama') ||
		normalized.startsWith('llama-') ||
		normalized === 'llama'
	) {
		return 'meta';
	}
	throw new SdlcError('AUTHOR_VENDOR_UNKNOWN', `Unknown or unsupported author vendor: '${raw}'`);
}

export function canonicalizeAuthorVendors({
	authorVendor,
	authorVendors,
}: {
	authorVendor?: unknown;
	authorVendors?: readonly unknown[] | null;
} = {}): readonly CanonicalAuthorVendor[] {
	const rawVendors: unknown[] = Array.isArray(authorVendors) ? [...authorVendors] : [];
	if (rawVendors.length === 0 && authorVendor !== undefined && authorVendor !== null) {
		rawVendors.push(authorVendor);
	}
	if (rawVendors.length === 0) {
		throw new SdlcError('AUTHOR_VENDOR_UNKNOWN', 'Canonical author vendor is required');
	}
	return Object.freeze([...new Set(rawVendors.map(canonicalizeAuthorVendor))]);
}

export function detectHostVendor(env: NodeJS.ProcessEnv = process.env): HostVendor | null {
	if (env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_CONVERSATION_ID) {
		return 'google';
	}
	if (
		env.GITHUB_COPILOT ||
		env.COPILOT_DEBUG_NONCE ||
		env.VSCODE_COPILOT ||
		env.COPILOT_AGENT
	) {
		return 'copilot';
	}
	if (env.GROK_AGENT || env.XAI_AGENT) {
		return 'xai';
	}
	if (env.CLAUDE_AGENT || env.ANTHROPIC_AGENT) {
		return 'anthropic';
	}
	return null;
}

export function resolveAuthorVendor(
	snapshot: AuthorVendorSnapshot,
	{ synthetic = false }: { synthetic?: boolean } = {},
): CanonicalAuthorVendor {
	const raw =
		snapshot.authorVendor ||
		process.env.AUTHOR_VENDOR ||
		(synthetic ? 'google' : null) ||
		detectHostVendor() ||
		'google';
	return canonicalizeAuthorVendor(raw);
}

export const CODE_AUTHOR_ROLES = Object.freeze([
	'implementer',
	'repairer',
	'cleaner',
	'hardener',
] as const);

export function resolveCodeAuthorVendors(
	snapshot: AuthorVendorSnapshot,
	runtimeStore?: AuthorVendorRuntimeStoreLike | null,
	{ synthetic = false }: { synthetic?: boolean } = {},
): readonly CanonicalAuthorVendor[] {
	const fallback = resolveAuthorVendor(snapshot, { synthetic });
	if (!runtimeStore?.database) return Object.freeze([fallback]);
	const placeholders = CODE_AUTHOR_ROLES.map(() => '?').join(', ');
	const rows = runtimeStore.database
		.prepare(
			`SELECT synthetic, model_id, provider
			 FROM model_operations
			 WHERE run_id = ?
			   AND status = 'succeeded'
			   AND role_id IN (${placeholders})
			 ORDER BY created_at, operation_id`,
		)
		.all(snapshot.runId, ...CODE_AUTHOR_ROLES);
	const vendors: CanonicalAuthorVendor[] = [];
	for (const rawRow of rows) {
		const row = (rawRow && typeof rawRow === 'object' ? rawRow : {}) as {
			synthetic?: unknown;
			model_id?: unknown;
			provider?: unknown;
		};
		if (row.synthetic === 1) {
			if (!vendors.includes(fallback)) vendors.push(fallback);
			continue;
		}
		const raw = row.model_id ?? row.provider;
		if (!raw) continue;
		const vendor = canonicalizeAuthorVendor(raw);
		if (!vendors.includes(vendor)) vendors.push(vendor);
	}
	return Object.freeze(vendors.length > 0 ? vendors : [fallback]);
}
