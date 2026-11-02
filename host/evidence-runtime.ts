import { spawn } from 'node:child_process';
import type { EvidenceSpawn } from './evidence-types.ts';

/** Deliberately separate from injected synchronous execCli used by preparation and Git. */
export const defaultEvidenceSpawn: EvidenceSpawn = (command, args, options) =>
	spawn(command, [...args], { ...options, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
