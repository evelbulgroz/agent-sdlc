import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { fail, verifyFile } from './primitives.ts';
import type { CopyEntry } from './admission-types.ts';

const BATCH_FILES = 512;
const MAX_WORKERS = 8;

function ensureDirectories(target: string, copies: readonly CopyEntry[]): void {
  const checked = new Set();
  for (const file of copies) {
    let directory = target;
    for (const part of file.destination.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      if (checked.has(directory)) continue;
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (!stat) fs.mkdirSync(directory);
      else if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe preparation directory');
      checked.add(directory);
    }
  }
}

// Every copy is still verified against its frozen hash at the destination; a source is hashed once per batch.
export function processBatch(target: string, copies: readonly CopyEntry[]): void {
  const verifiedSources = new Set();
  for (const file of copies) {
    const key = `${file.sourceRoot}\0${file.source}\0${file.sha256}`;
    const source = verifiedSources.has(key) ? path.join(file.sourceRoot, file.source)
      : verifyFile(file.sourceRoot, { path: file.source, sha256: file.sha256 });
    verifiedSources.add(key);
    const destination = path.join(target, file.destination);
    if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(destination, file.mode);
    }
    verifyFile(target, { path: file.destination, sha256: file.sha256 });
    if ((fs.statSync(destination).mode & 0o777) !== file.mode) fail('preparation executable mode changed');
  }
}

function batchesBySource(copies: readonly CopyEntry[]): CopyEntry[][] {
  const groups = new Map<string, CopyEntry[]>();
  for (const file of copies) {
    const key = `${file.sourceRoot}\0${file.source}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  let current: CopyEntry[] = [];
  const batches: CopyEntry[][] = [current];
  for (const group of groups.values()) {
    if (current.length >= BATCH_FILES) batches.push(current = []);
    current.push(...group);
  }
  return batches;
}

export async function copyFrozenFiles(target: string, copies: readonly CopyEntry[],
  { inlineBelow = 2048, workers = MAX_WORKERS }: { inlineBelow?: number; workers?: number } = {}): Promise<void> {
  ensureDirectories(target, copies);
  if (copies.length < inlineBelow) return processBatch(target, copies);
  const batches = batchesBySource(copies);
  const count = Math.min(workers, os.availableParallelism(), batches.length);
  let next = 0;
  const pool: Worker[] = [];
  try {
    await Promise.all(Array.from({ length: count }, () => new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { target } });
      pool.push(worker);
      const dispatch = () => {
        if (next >= batches.length) { resolve(); return; }
        worker.postMessage(batches[next++]);
      };
      worker.on('message', (message) => (message.error ? reject(new Error(message.error)) : dispatch()));
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0) reject(new Error(`preparation worker exited ${code}`)); });
      dispatch();
    })));
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
  }
}

if (!isMainThread && workerData?.target) {
  parentPort?.on('message', (copies: CopyEntry[]) => {
    try {
      processBatch(workerData.target, copies);
      parentPort?.postMessage({ ok: true });
    } catch (error) {
      parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
