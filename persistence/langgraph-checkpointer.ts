import { BaseCheckpointSaver } from '@langchain/langgraph';
import {
	type ChannelVersions,
	type Checkpoint,
	type CheckpointListOptions,
	type CheckpointMetadata,
	type CheckpointPendingWrite,
	type CheckpointTuple,
	type PendingWrite,
	WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import { SdlcError } from '../policy/errors.ts';
import type { CheckpointRecords } from './checkpoint-records.ts';

type RunnableConfig = Parameters<BaseCheckpointSaver['getTuple']>[0];

export interface CheckpointerStore extends CheckpointRecords {
	deleteCheckpointThread?: (threadId: string) => void;
}

export class RuntimeStoreCheckpointer extends BaseCheckpointSaver {
	readonly runtimeStore: CheckpointerStore;

	constructor(runtimeStore: CheckpointerStore) {
		super();
		this.runtimeStore = runtimeStore;
	}

	override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
		const { threadId, checkpointNamespace, checkpointId } = checkpointConfig(config);
		const row = this.runtimeStore.getCheckpointRow({
			threadId,
			checkpointNamespace,
			checkpointId,
		});
		if (!row) return undefined;
		const pendingWrites: CheckpointPendingWrite[] = [];
		for (const write of this.runtimeStore.listCheckpointWrites({
			threadId,
			checkpointNamespace: row.checkpoint_ns,
			checkpointId: row.checkpoint_id,
		})) {
			const loadedValue: unknown = await this.serde.loadsTyped(write.value_type, write.value);
			pendingWrites.push([write.task_id, write.channel, loadedValue]);
		}
		const loadedCheckpoint: unknown = await this.serde.loadsTyped(
			row.checkpoint_type,
			row.checkpoint,
		);
		const loadedMetadata: unknown = await this.serde.loadsTyped(row.metadata_type, row.metadata);
		const tuple: CheckpointTuple = {
			config: {
				configurable: {
					thread_id: threadId,
					checkpoint_ns: row.checkpoint_ns,
					checkpoint_id: row.checkpoint_id,
				},
			},
			checkpoint: loadedCheckpoint as Checkpoint,
			metadata: loadedMetadata as CheckpointMetadata,
			pendingWrites,
		};
		if (row.parent_checkpoint_id) {
			tuple.parentConfig = {
				configurable: {
					thread_id: threadId,
					checkpoint_ns: row.checkpoint_ns,
					checkpoint_id: row.parent_checkpoint_id,
				},
			};
		}
		return tuple;
	}

	override async *list(
		config: RunnableConfig,
		options: CheckpointListOptions = {},
	): AsyncGenerator<CheckpointTuple> {
		const { threadId, checkpointNamespace } = checkpointConfig(config);
		const beforeConfigurable = options.before?.configurable as
			| { checkpoint_id?: string }
			| undefined;
		const beforeId = beforeConfigurable?.checkpoint_id ?? '\uffff';
		const configurable = config.configurable as { checkpoint_ns?: string } | undefined;
		for (const row of this.runtimeStore.listCheckpointRows({
			threadId,
			checkpointNamespace:
				configurable?.checkpoint_ns === undefined ? undefined : checkpointNamespace,
			beforeId,
			limit: options.limit ?? 100,
		})) {
			const tuple = await this.getTuple({
				configurable: {
					thread_id: threadId,
					checkpoint_ns: row.checkpoint_ns,
					checkpoint_id: row.checkpoint_id,
				},
			});
			const metadataRecord = tuple?.metadata as Record<string, unknown> | undefined;
			if (
				tuple &&
				(!options.filter ||
					Object.entries(options.filter).every(([key, value]) => metadataRecord?.[key] === value))
			) {
				yield tuple;
			}
		}
	}

	override async put(
		config: RunnableConfig,
		checkpoint: Checkpoint,
		metadata: CheckpointMetadata,
		_newVersions?: ChannelVersions,
	): Promise<RunnableConfig> {
		const { threadId, checkpointNamespace, checkpointId } = checkpointConfig(config);
		const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
		const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata);
		this.runtimeStore.putCheckpointRow({
			threadId,
			checkpointNamespace,
			checkpointId: checkpoint.id,
			parentCheckpointId: checkpointId ?? null,
			checkpointType,
			checkpoint: checkpointBytes,
			metadataType,
			metadata: metadataBytes,
		});
		return {
			configurable: {
				thread_id: threadId,
				checkpoint_ns: checkpointNamespace,
				checkpoint_id: checkpoint.id,
			},
		};
	}

	override async putWrites(
		config: RunnableConfig,
		writes: PendingWrite[],
		taskId: string,
	): Promise<void> {
		const { threadId, checkpointNamespace, checkpointId } = checkpointConfig(config);
		if (!checkpointId) {
			throw new SdlcError('INVALID_CONTRACT', 'Checkpoint writes require checkpoint_id');
		}
		for (const [index, [channel, value]] of writes.entries()) {
			const writeIndex = WRITES_IDX_MAP[channel] ?? index;
			const [valueType, valueBytes] = await this.serde.dumpsTyped(value);
			this.runtimeStore.putCheckpointWrite(
				{
					threadId,
					checkpointNamespace,
					checkpointId,
					taskId,
					writeIndex,
					channel,
					valueType,
					value: valueBytes,
				},
				{ replace: writeIndex < 0 },
			);
		}
	}

	override async deleteThread(threadId: string): Promise<void> {
		if (typeof threadId !== 'string' || threadId.length === 0) {
			throw new SdlcError('INVALID_CONTRACT', 'Checkpoint thread ID is required');
		}
		this.runtimeStore.deleteCheckpointThread?.(threadId);
	}
}

function checkpointConfig(config: RunnableConfig | undefined): {
	threadId: string;
	checkpointNamespace: string;
	checkpointId: string | undefined;
} {
	const configurable = config?.configurable as
		| { thread_id?: unknown; checkpoint_ns?: unknown; checkpoint_id?: string }
		| undefined;
	const threadId = configurable?.thread_id;
	const checkpointNamespace = configurable?.checkpoint_ns ?? '';
	const checkpointId = configurable?.checkpoint_id;
	if (typeof threadId !== 'string' || threadId.length === 0) {
		throw new SdlcError('INVALID_CONTRACT', 'LangGraph checkpointer requires thread_id');
	}
	if (typeof checkpointNamespace !== 'string') {
		throw new SdlcError('INVALID_CONTRACT', 'LangGraph checkpoint_ns must be a string');
	}
	return { threadId, checkpointNamespace, checkpointId };
}
