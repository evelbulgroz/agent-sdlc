import {
	type GitCommitRecord,
	type PullRequestRecord,
	RUNTIME_SCHEMA_VERSION,
	validateGitCommitRecord,
	validatePullRequestRecord,
	validateRunId,
} from '../policy/contracts.ts';
import type { StoreContext } from './run-ledger.ts';

interface GitCommitRow {
	run_id: string;
	target_branch: string;
	commit_sha: string;
	tree_sha: string;
	parent_sha: string;
	message: string;
	author_name: string;
	author_email: string;
	committed_at: string;
}

interface PullRequestRow {
	run_id: string;
	pr_url: string;
	pr_number: number;
	draft: number;
	branch_name: string;
	base_branch: string;
	created_at: string;
}

export interface DeliveryRecords {
	saveGitCommit(commitInput: unknown): Readonly<GitCommitRecord>;
	getGitCommit(runId: string): Readonly<GitCommitRecord> | null;
	savePullRequest(prInput: unknown): Readonly<PullRequestRecord>;
	getPullRequest(runId: string): Readonly<PullRequestRecord> | null;
}

export function createDeliveryRecords(ctx: StoreContext): DeliveryRecords {
	function saveGitCommit(commitInput: unknown): Readonly<GitCommitRecord> {
		ctx.assertOpen();
		const commit = validateGitCommitRecord(commitInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO git_commits (
						run_id, target_branch, commit_sha, tree_sha, parent_sha,
						message, author_name, author_email, committed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id) DO UPDATE SET
						target_branch = excluded.target_branch,
						commit_sha = excluded.commit_sha,
						tree_sha = excluded.tree_sha,
						parent_sha = excluded.parent_sha,
						message = excluded.message,
						author_name = excluded.author_name,
						author_email = excluded.author_email,
						committed_at = excluded.committed_at
				`,
				)
				.run(
					commit.runId,
					commit.targetBranch,
					commit.commitSha,
					commit.treeSha,
					commit.parentSha,
					commit.message,
					commit.authorName,
					commit.authorEmail,
					commit.committedAt,
				);
			return commit;
		});
	}

	function getGitCommit(runId: string): Readonly<GitCommitRecord> | null {
		ctx.assertOpen();
		validateRunId(runId);
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM git_commits WHERE run_id = ?')
			.get(runId);
		const row = raw as GitCommitRow | undefined;
		if (!row) return null;
		return validateGitCommitRecord({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: row.run_id,
			targetBranch: row.target_branch,
			commitSha: row.commit_sha,
			treeSha: row.tree_sha,
			parentSha: row.parent_sha,
			message: row.message,
			authorName: row.author_name,
			authorEmail: row.author_email,
			committedAt: row.committed_at,
		});
	}

	function savePullRequest(prInput: unknown): Readonly<PullRequestRecord> {
		ctx.assertOpen();
		const pr = validatePullRequestRecord(prInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO pull_requests (
						run_id, pr_url, pr_number, draft, branch_name, base_branch, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id) DO UPDATE SET
						pr_url = excluded.pr_url,
						pr_number = excluded.pr_number,
						draft = excluded.draft,
						branch_name = excluded.branch_name,
						base_branch = excluded.base_branch,
						created_at = excluded.created_at
				`,
				)
				.run(
					pr.runId,
					pr.prUrl,
					pr.prNumber,
					pr.draft ? 1 : 0,
					pr.branchName,
					pr.baseBranch,
					pr.createdAt,
				);
			return pr;
		});
	}

	function getPullRequest(runId: string): Readonly<PullRequestRecord> | null {
		ctx.assertOpen();
		validateRunId(runId);
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM pull_requests WHERE run_id = ?')
			.get(runId);
		const row = raw as PullRequestRow | undefined;
		if (!row) return null;
		return validatePullRequestRecord({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: row.run_id,
			prUrl: row.pr_url,
			prNumber: row.pr_number,
			draft: Boolean(row.draft),
			branchName: row.branch_name,
			baseBranch: row.base_branch,
			createdAt: row.created_at,
		});
	}

	return {
		saveGitCommit,
		getGitCommit,
		savePullRequest,
		getPullRequest,
	};
}
