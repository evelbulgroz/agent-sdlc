import path from 'node:path';

export interface ErasableProbeSummary {
	readonly normalizedPath: string;
	readonly segmentCount: number;
}

export function summarizeProbePath(rawPath: string): ErasableProbeSummary {
	const normalizedPath = path.posix.normalize(rawPath);
	const segmentCount = normalizedPath.split('/').filter((part) => part.length > 0).length;
	return Object.freeze({
		normalizedPath,
		segmentCount,
	});
}
