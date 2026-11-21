import fs from 'node:fs';
import { SdlcError } from '../policy/errors.ts';

function siblingFile(absoluteGoalFile: string, suffix: string): string | null {
	if (!absoluteGoalFile.endsWith('.md')) return null;
	const sibling = `${absoluteGoalFile.slice(0, -'.md'.length)}${suffix}`;
	return fs.existsSync(sibling) ? sibling : null;
}

/**
 * A goal named `something.md` may have `something.tasks.json` or
 * `something.obligations.json` beside it. shell start names each file only
 * when the caller passed the matching flag; it does not attach the sibling.
 */
export function assertStartSiblings(
	absoluteGoalFile: string,
	taskPlanFile: string | null,
	obligationsFile: string | null,
): void {
	const tasks = siblingFile(absoluteGoalFile, '.tasks.json');
	if (!taskPlanFile && tasks) {
		throw new SdlcError(
			'INVALID_INPUT',
			`shell start requires --task-plan-file because sibling task manifest exists: ${tasks}`,
		);
	}
	const obligations = siblingFile(absoluteGoalFile, '.obligations.json');
	if (!obligationsFile && obligations) {
		throw new SdlcError(
			'INVALID_INPUT',
			`shell start requires --obligations-file because sibling obligations file exists: ${obligations}`,
		);
	}
}
