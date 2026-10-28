// Terminal nodes. repair_failure halts with AUTONOMOUS_REPAIR_RETIRED. finalize_run records friction.

import type { RuntimeState } from '../../policy/contracts.ts';
import type { GraphStateValues, WorkflowRuntimeLike } from '../node-helpers.ts';
import { escalateAutonomousRepairRetired } from '../preflight-gate.ts';

export function createRepairFailureNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		return escalateAutonomousRepairRetired(runtime, snapshot, {
			causalId: `repair-retired-${snapshot.runtimeRevision}`,
		});
	};
}

export function createFinalizeRunNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		if (snapshot.state !== 'READY_FOR_GIT_APPROVAL' && snapshot.state !== 'DONE') {
			return { snapshot };
		}

		// Check if PROMPT_FRICTION_DETECTED was already recorded for this run
		const alreadyDetected = runtime.runtimeStore.database
			.prepare("SELECT 1 FROM events WHERE run_id = ? AND event_type = 'PROMPT_FRICTION_DETECTED'")
			.get(snapshot.runId);
		if (alreadyDetected) {
			return { snapshot };
		}

		const repairs =
			snapshot.semanticRepairsCount ??
			runtime.runtimeStore.getSemanticRepairsCount(snapshot.runId) ??
			0;

		let toolFailures = 0;
		try {
			const row = runtime.runtimeStore.database
				.prepare(
					'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id = ? AND exit_code IS NOT NULL AND exit_code != 0',
				)
				.get(snapshot.runId);
			toolFailures = typeof row?.count === 'number' ? row.count : 0;
		} catch {
			toolFailures = 0;
		}

		let qaDivergences = 0;
		try {
			const rows = runtime.runtimeStore.database
				.prepare(
					"SELECT findings_json FROM critic_reviews WHERE run_id = ? AND phase = 'qa'",
				)
				.all(snapshot.runId);
			for (const r of rows) {
				const findingsJson =
					typeof r.findings_json === 'string' ? r.findings_json : '';
				if (!findingsJson) continue;
				try {
					const parsed = JSON.parse(findingsJson) as
						| unknown[]
						| { findings?: unknown[] };
					const findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
					for (const rawFinding of findings) {
						const f =
							rawFinding && typeof rawFinding === 'object'
								? (rawFinding as Record<string, unknown>)
								: {};
						const text = `${String(f.evidence ?? '')} ${String(f.message ?? '')} ${String(f.ruleId ?? '')}`;
						if (/GAP|DIVERGENT/i.test(text)) {
							qaDivergences += 1;
						}
					}
				} catch {
					if (/GAP|DIVERGENT/i.test(findingsJson)) {
						qaDivergences += 1;
					}
				}
			}
		} catch {
			qaDivergences = 0;
		}

		if (repairs === 0 && toolFailures === 0 && qaDivergences === 0) {
			return { snapshot };
		}

		const parts: string[] = [];
		if (repairs > 0) parts.push(`repairs: ${repairs}`);
		if (toolFailures > 0) parts.push(`tool failures: ${toolFailures}`);
		if (qaDivergences > 0) parts.push(`qa divergences: ${qaDivergences}`);
		const advisory = `💡 Trace friction detected (${parts.join(', ')}). Run 'agent-sdlc skills --run ${snapshot.runId}' to analyze.`;

		const next = runtime.transition(snapshot, {
			to: snapshot.state,
			eventType: 'PROMPT_FRICTION_DETECTED',
			causalId: `friction-detected-${snapshot.runtimeRevision}`,
			updates: {},
			payload: {
				repairs,
				toolFailures,
				qaDivergences,
				advisory,
			},
		});

		return { snapshot: next };
	};
}
