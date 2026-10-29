import type { StoreContext } from './run-ledger.ts';

export interface CheckpointDbRow {
	thread_id: string;
	checkpoint_ns: string;
	checkpoint_id: string;
	parent_checkpoint_id: string | null;
	checkpoint_type: string;
	checkpoint: Uint8Array | string;
	metadata_type: string;
	metadata: Uint8Array | string;
}

export interface CheckpointWriteDbRow {
	thread_id: string;
	checkpoint_ns: string;
	checkpoint_id: string;
	task_id: string;
	write_index: number;
	channel: string;
	value_type: string;
	value: Uint8Array | string;
}

export interface CheckpointRowInput {
	threadId: string;
	checkpointNamespace: string;
	checkpointId: string;
	parentCheckpointId: string | null;
	checkpointType: string;
	checkpoint: NodeJS.ArrayBufferView | string;
	metadataType: string;
	metadata: NodeJS.ArrayBufferView | string;
}

export interface CheckpointWriteInput {
	threadId: string;
	checkpointNamespace: string;
	checkpointId: string;
	taskId: string;
	writeIndex: number;
	channel: string;
	valueType: string;
	value: NodeJS.ArrayBufferView | string;
}

export interface CheckpointRecords {
	getCheckpointRow(params: {
		threadId: string;
		checkpointNamespace?: string;
		checkpointId?: string;
	}): CheckpointDbRow | undefined;
	listCheckpointRows(params: {
		threadId: string;
		checkpointNamespace?: string;
		beforeId?: string;
		limit?: number;
	}): CheckpointDbRow[];
	putCheckpointRow(row: CheckpointRowInput): void;
	putCheckpointWrite(row: CheckpointWriteInput, options: { replace: boolean }): void;
	listCheckpointWrites(params: {
		threadId: string;
		checkpointNamespace: string;
		checkpointId: string;
	}): CheckpointWriteDbRow[];
}

export function createCheckpointRecords(ctx: StoreContext): CheckpointRecords {
	function getCheckpointRow({
		threadId,
		checkpointNamespace = '',
		checkpointId,
	}: {
		threadId: string;
		checkpointNamespace?: string;
		checkpointId?: string;
	}): CheckpointDbRow | undefined {
		if (checkpointId) {
			const raw: unknown = ctx.database
				.prepare(
					`
					SELECT * FROM checkpoints
					WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
				`,
				)
				.get(threadId, checkpointNamespace, checkpointId);
			return raw as CheckpointDbRow | undefined;
		}
		const raw: unknown = ctx.database
			.prepare(
				`
				SELECT * FROM checkpoints
				WHERE thread_id = ? AND checkpoint_ns = ?
				ORDER BY rowid DESC LIMIT 1
			`,
			)
			.get(threadId, checkpointNamespace);
		return raw as CheckpointDbRow | undefined;
	}

	function listCheckpointRows({
		threadId,
		checkpointNamespace,
		beforeId = '\uffff',
		limit = 100,
	}: {
		threadId: string;
		checkpointNamespace?: string;
		beforeId?: string;
		limit?: number;
	}): CheckpointDbRow[] {
		const namespaceClause = checkpointNamespace === undefined ? '' : 'AND checkpoint_ns = ?';
		const parameters =
			checkpointNamespace === undefined
				? [threadId, beforeId, limit]
				: [threadId, checkpointNamespace, beforeId, limit];
		const raw: unknown = ctx.database
			.prepare(
				`
				SELECT * FROM checkpoints
				WHERE thread_id = ? ${namespaceClause} AND checkpoint_id < ?
				ORDER BY checkpoint_id DESC LIMIT ?
			`,
			)
			.all(...parameters);
		return raw as CheckpointDbRow[];
	}

	function putCheckpointRow(row: CheckpointRowInput): void {
		ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT OR REPLACE INTO checkpoints (
						thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
						checkpoint_type, checkpoint, metadata_type, metadata
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`,
				)
				.run(
					row.threadId,
					row.checkpointNamespace,
					row.checkpointId,
					row.parentCheckpointId,
					row.checkpointType,
					row.checkpoint,
					row.metadataType,
					row.metadata,
				);
		});
	}

	function putCheckpointWrite(row: CheckpointWriteInput, { replace }: { replace: boolean }): void {
		ctx.transaction(() => {
			const verb = replace ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
			ctx.database
				.prepare(
					`
					${verb} INTO checkpoint_writes (
						thread_id, checkpoint_ns, checkpoint_id, task_id,
						write_index, channel, value_type, value
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`,
				)
				.run(
					row.threadId,
					row.checkpointNamespace,
					row.checkpointId,
					row.taskId,
					row.writeIndex,
					row.channel,
					row.valueType,
					row.value,
				);
		});
	}

	function listCheckpointWrites({
		threadId,
		checkpointNamespace,
		checkpointId,
	}: {
		threadId: string;
		checkpointNamespace: string;
		checkpointId: string;
	}): CheckpointWriteDbRow[] {
		const raw: unknown = ctx.database
			.prepare(
				`
				SELECT * FROM checkpoint_writes
				WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
				ORDER BY task_id, write_index
			`,
			)
			.all(threadId, checkpointNamespace, checkpointId);
		return raw as CheckpointWriteDbRow[];
	}

	return {
		getCheckpointRow,
		listCheckpointRows,
		putCheckpointRow,
		putCheckpointWrite,
		listCheckpointWrites,
	};
}
