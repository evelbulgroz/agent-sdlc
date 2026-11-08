import fs from 'node:fs';
import path from 'node:path';
import { durableReplaceSync } from '@evelbulgroz/model-usage-govenor/atomic-file-state';
import { isValidRunSlug } from './run-selector.ts';

export interface TelemetryEnvelope {
	schemaVersion: number;
	runId: string;
	updatedAt: string;
	records: Array<Record<string, unknown>>;
}

export function emptyEnvelope(slug: string, nowIso: string): TelemetryEnvelope {
	return { schemaVersion: 1, runId: slug, updatedAt: nowIso, records: [] };
}

function parseEnvelope(raw: string, slug: string): TelemetryEnvelope | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object') {
			const candidate = parsed as Partial<TelemetryEnvelope>;
			if (Array.isArray(candidate.records) && candidate.runId === slug) return candidate as TelemetryEnvelope;
		}
	} catch {
		// treated as corrupt by the caller
	}
	return null;
}

/** Loads an existing envelope. A corrupt file is renamed aside with a warning and replaced by an empty envelope. */
export function loadOrRecoverEnvelope(telemetryFile: string, slug: string, nowIso: string): TelemetryEnvelope {
	if (!fs.existsSync(telemetryFile)) return emptyEnvelope(slug, nowIso);
	const envelope = parseEnvelope(fs.readFileSync(telemetryFile, 'utf8'), slug);
	if (envelope) return envelope;
	const backup = path.join(path.dirname(telemetryFile), `${slug}.corrupt.${Date.now()}.json`);
	try {
		fs.renameSync(telemetryFile, backup);
		console.warn(`telemetry-record: WARNING: Corrupted telemetry file backed up to '${path.basename(backup)}'`);
	} catch (error) {
		console.warn(`telemetry-record: Failed to backup corrupt file: ${error instanceof Error ? error.message : String(error)}`);
	}
	return emptyEnvelope(slug, nowIso);
}

/** Reads a run's telemetry envelope from the gitignored telemetry directory, optionally copying it to `dest`. */
export function exportTelemetrySnapshot(
	slug: string,
	options: { telemetryDir: string; dest?: string | null },
): TelemetryEnvelope {
	if (!isValidRunSlug(slug)) throw new Error(`Invalid run slug '${slug}' for telemetry export`);
	const telemetryDir = path.resolve(options.telemetryDir);
	if (!fs.existsSync(telemetryDir)) throw new Error(`No telemetry storage directory found at '${telemetryDir}'`);
	const realDir = fs.realpathSync(telemetryDir);
	const telemetryFile = path.resolve(telemetryDir, `${slug}.json`);
	if (!fs.existsSync(telemetryFile)) throw new Error(`No telemetry records found for run '${slug}' at '${telemetryFile}'`);
	const realTarget = fs.realpathSync(telemetryFile);
	if (path.dirname(realTarget) !== realDir) {
		throw new Error(`Telemetry target '${telemetryFile}' escapes telemetry directory boundary`);
	}
	const raw = fs.readFileSync(realTarget, 'utf8');
	try {
		JSON.parse(raw);
	} catch (error) {
		throw new Error(`Corrupted telemetry file for run '${slug}': ${error instanceof Error ? error.message : String(error)}`);
	}
	const envelope = parseEnvelope(raw, slug);
	if (!envelope) throw new Error(`Invalid telemetry envelope structure for run '${slug}'`);
	if (options.dest) {
		const destPath = path.resolve(options.dest);
		fs.mkdirSync(path.dirname(destPath), { recursive: true });
		durableReplaceSync(destPath, `${JSON.stringify(envelope, null, 2)}\n`);
	}
	return envelope;
}
