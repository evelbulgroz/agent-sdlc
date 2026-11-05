import fs from 'node:fs';
import path from 'node:path';

export const SPANS_FILE = 'spans.jsonl';

export type SpanKind = 'implementer' | 'prepare' | 'critic';

export interface RunSpan {
	kind: SpanKind;
	label: string;
	startedAt: string;
	finishedAt: string;
	ok: boolean;
}

function spansPath(store: unknown): string | null {
	const databasePath = store && typeof store === 'object' && 'databasePath' in store ? store.databasePath : null;
	return typeof databasePath === 'string' ? path.join(path.dirname(databasePath), SPANS_FILE) : null;
}

/** Times `work` and appends a span next to the run's runtime store; telemetry failures never affect the run. */
export async function timedSpan<T>(store: unknown, kind: SpanKind, label: string, work: () => Promise<T> | T): Promise<T> {
	const startedAt = new Date().toISOString();
	let ok = false;
	try {
		const value = await work();
		ok = true;
		return value;
	} finally {
		const file = spansPath(store);
		if (file) {
			const span: RunSpan = { kind, label, startedAt, finishedAt: new Date().toISOString(), ok };
			try {
				fs.appendFileSync(file, `${JSON.stringify(span)}\n`);
			} catch {
				// Best-effort telemetry.
			}
		}
	}
}

export function readSpans(databasePath: string): RunSpan[] {
	const file = path.join(path.dirname(databasePath), SPANS_FILE);
	if (!fs.existsSync(file)) return [];
	const spans: RunSpan[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as Partial<RunSpan>;
			if (typeof value.kind === 'string' && typeof value.label === 'string' &&
				typeof value.startedAt === 'string' && typeof value.finishedAt === 'string') {
				spans.push({ ...value, ok: value.ok === true } as RunSpan);
			}
		} catch {
			// Skip a torn trailing line.
		}
	}
	return spans;
}
