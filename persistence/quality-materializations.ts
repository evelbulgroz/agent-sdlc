import { z } from 'zod';
import { CandidateBindingSchema } from '../policy/contracts/quality-schema.ts';
import { GIT_SHA, IDENTIFIER_PATTERN } from '../policy/contracts/primitives.ts';
import { qualityFailure, type QualityStorage } from './quality-storage.ts';

const IntentSchema = z.strictObject({
	runId: z.string(), correctionId: z.string().regex(IDENTIFIER_PATTERN),
	binding: CandidateBindingSchema, relativePath: z.literal('worktrees/integration'),
	priorTreeSha: z.string().regex(GIT_SHA).nullable(), baseTreeSha: z.string().regex(GIT_SHA),
});
export type FinalMaterializationIntent = z.infer<typeof IntentSchema>;
export type FinalMaterializationPhase = 'intended' | 'resetting' | 'checking-out' | 'ready';

export function createQualityMaterializations(storage: QualityStorage) {
	function getFinalMaterialization(runId: string, correctionId: string) {
		const intent = storage.get<FinalMaterializationIntent>(runId, 'final-materialization', correctionId);
		if (!intent) return null;
		const phase = storage.status(runId, 'final-materialization', correctionId) ?? 'intended';
		if (!['intended', 'resetting', 'checking-out', 'ready'].includes(phase)) {
			qualityFailure('Invalid final materialization progress');
		}
		return { intent, phase: phase as FinalMaterializationPhase };
	}
	function beginFinalMaterialization(input: FinalMaterializationIntent) {
		const intent = IntentSchema.parse(input);
		return storage.ctx.transaction(() => {
			const correction = storage.get(intent.runId, 'correction', intent.correctionId);
			if (!correction || intent.runId !== intent.binding.runId ||
				intent.binding.checkpointKind !== 'final' ||
				storage.status(intent.runId, 'correction', intent.correctionId) === 'completed') {
				qualityFailure('Final materialization requires an active correction');
			}
			storage.put(intent.runId, 'final-materialization', intent.correctionId, intent);
			return intent;
		});
	}
	function advanceFinalMaterialization(runId: string, correctionId: string, phase: FinalMaterializationPhase) {
		return storage.ctx.transaction(() => {
			const current = getFinalMaterialization(runId, correctionId);
			const phases = ['intended', 'resetting', 'checking-out', 'ready'];
			if (!current || (phase !== current.phase &&
				phases.indexOf(phase) !== phases.indexOf(current.phase) + 1)) {
				qualityFailure('Invalid final materialization transition');
			}
			storage.put(runId, 'final-materialization-progress', `${correctionId}:${phase}`, { correctionId, phase });
			storage.status(runId, 'final-materialization', correctionId, phase);
		});
	}
	return { getFinalMaterialization, beginFinalMaterialization, advanceFinalMaterialization };
}
