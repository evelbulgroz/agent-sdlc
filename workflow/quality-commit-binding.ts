import type { GitCommitRecord, RunAuthorizationRecord, RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { assertBranchCommitBinding } from './git-manager.ts';
import { getRunCheckpointQualityPolicy, type WorkflowRuntimeLike } from './node-helpers.ts';

export function assertQualityCommitBinding(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	auth: RunAuthorizationRecord,
	record: Readonly<GitCommitRecord> | null,
): { commitSha: string; treeSha: string } | undefined {
	if (!getRunCheckpointQualityPolicy(runtime, snapshot)) return undefined;
	if (!record || !auth.targetBranch || record.targetBranch !== auth.targetBranch ||
		record.treeSha !== snapshot.qualityCheckpointTreeSha) {
		throw new SdlcError('POLICY_VIOLATION',
			'Quality delivery requires the approved target branch and recorded reviewed commit');
	}
	return assertBranchCommitBinding({
		worktreeDir: snapshot.integrationWorktreePath || snapshot.worktreePath || '',
		branchName: record.targetBranch,
		expectedCommitSha: record.commitSha,
		expectedTreeSha: record.treeSha,
		gitCli: runtime.gitCli,
	});
}
