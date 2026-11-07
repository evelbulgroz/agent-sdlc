import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import {
  bytesHash, engineModule, fail, regularFile, relativePath, verifyFile,
} from './primitives.mjs';

const digest = value => bytesHash(Buffer.from(JSON.stringify(value)));
const same = (left, right) => digest(left) === digest(right);
const prefix = config => `${config.output}/`;

function bytes(file, maxBytes = 256 * 1024 * 1024) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) fail('invalid bootstrap file');
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function jsonReference(root, config, reference) {
  if (!reference || !relativePath(reference.path).startsWith(prefix(config))
    || !/^[a-f0-9]{64}$/.test(reference.sha256)) fail('unbound bootstrap reference');
  const input = bytes(regularFile(root, reference.path), 64 * 1024 * 1024);
  if (bytesHash(input) !== reference.sha256) fail('bootstrap reference changed');
  return JSON.parse(input.toString('utf8'));
}

export function snapshotWorkspace(root, moduleRoots) {
  root = fs.realpathSync(root);
  if (!Array.isArray(moduleRoots) || !moduleRoots.length
    || !moduleRoots.includes('node_modules') || new Set(moduleRoots).size !== moduleRoots.length) {
    fail('missing workspace dependency roots');
  }
  const entries = [];
  const walk = relative => {
    if (entries.length >= 250000) fail('workspace closure exceeds entry ceiling');
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    const entry = { path: relative, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const lexical = path.resolve(path.dirname(file), target);
      if (!lexical.startsWith(`${root}/`)) fail('workspace dependency link escaped');
      let resolved = null;
      try { resolved = fs.realpathSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (resolved && !resolved.startsWith(`${root}/`)) fail('workspace dependency link escaped');
      entries.push({ ...entry, kind: 'link', target, resolved: resolved ? path.relative(root, resolved) : null });
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, kind: 'directory' });
      for (const name of fs.readdirSync(file).sort()) walk(`${relative}/${name}`);
    } else if (stat.isFile()) {
      entries.push({ ...entry, kind: 'file', sha256: bytesHash(bytes(regularFile(root, relative))) });
    } else fail('non-regular workspace dependency');
  };
  for (const relative of [...moduleRoots].sort()) {
    relativePath(relative);
    if (relative !== 'node_modules' && !relative.endsWith('/node_modules')) fail('invalid dependency root');
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (!fs.lstatSync(current).isDirectory()) fail('non-regular workspace dependency root');
    }
    walk(relative);
  }
  return { schemaVersion: '1.0.0', roots: [...moduleRoots].sort(), entries };
}

export function frozenWorkspacePreparation(root, config, reference) {
  root = fs.realpathSync(root);
  reference = structuredClone(reference);
  const layout = jsonReference(root, config, reference);
  const assertSource = () => {
    jsonReference(root, config, reference);
    if (!same(snapshotWorkspace(root, layout.roots), layout)) fail('workspace preparation source changed');
  };
  assertSource();
  if (layout.entries.some(entry => entry.kind === 'link' && path.isAbsolute(entry.target))) {
    fail('workspace preparation requires relocatable links');
  }
  const files = layout.entries.filter(entry => entry.kind === 'file')
    .map(({ path: file, sha256 }) => ({ path: file, sha256 }));
  const destinationRoot = target => {
    target = fs.realpathSync(target);
    if (target === root || !target.startsWith(`${root}/`)
      || layout.roots.some(directory => target === `${root}/${directory}`
        || target.startsWith(`${root}/${directory}/`))) {
      fail('workspace preparation target escaped');
    }
    return target;
  };
  const verifyTarget = target => {
    if (!same(snapshotWorkspace(destinationRoot(target), layout.roots), layout)) {
      fail('prepared workspace layout changed');
    }
  };
  const prepare = target => {
    target = destinationRoot(target);
    assertSource();
    const directory = (relative, mode) => {
      let current = target;
      for (const part of relative.split('/')) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) {
          fs.mkdirSync(current);
          if (mode !== undefined && current === path.join(target, relative)) fs.chmodSync(current, mode);
        }
        else if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe workspace preparation directory');
      }
      if (mode !== undefined && (fs.statSync(current).mode & 0o777) !== mode) {
        fail('workspace preparation directory mode changed');
      }
      return current;
    };
    for (const entry of layout.entries.filter(value => value.kind !== 'link')) {
      if (entry.kind === 'directory') { directory(entry.path, entry.mode); continue; }
      const source = verifyFile(root, entry);
      directory(path.posix.dirname(entry.path));
      const destination = path.join(target, entry.path);
      if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(destination, entry.mode);
      }
      verifyFile(target, entry);
      if ((fs.statSync(destination).mode & 0o777) !== entry.mode) fail('workspace preparation file mode changed');
    }
    for (const entry of layout.entries.filter(value => value.kind === 'link')) {
      directory(path.posix.dirname(entry.path));
      const destination = path.join(target, entry.path);
      const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
      if (!stat) fs.symlinkSync(entry.target, destination);
      else if (!stat.isSymbolicLink() || fs.readlinkSync(destination) !== entry.target) {
        fail('workspace preparation link changed');
      }
    }
    verifyTarget(target);
    assertSource();
  };
  return { files, reference, prepare, verifyTarget };
}

async function engineModules() {
  const [workspace, paths, hydration, ledger, tasks, generations, contracts] = await Promise.all([
    engineModule('host/workspace'), engineModule('persistence/run-paths'),
    engineModule('workflow/checkpoint-hydration'), engineModule('persistence/run-ledger'),
    engineModule('persistence/task-plan-records'), engineModule('persistence/generation-records'),
    engineModule('policy/contracts'),
  ]);
  return { ...workspace, ...paths, ...hydration, ...ledger, ...tasks, ...generations, ...contracts };
}

async function verifyContext(root, context, engine) {
  if (!context || typeof context.repositoryRoot !== 'string'
    || fs.realpathSync(context.repositoryRoot) !== context.repositoryRoot) fail('unbound bootstrap context');
  if (context.mode === 'offline-qualification') {
    if (Object.keys(context).sort().join() !== 'baseCommitSha,mode,repositoryRoot,spec'
      || root !== context.repositoryRoot || !fs.lstatSync(path.join(root, '.git')).isDirectory()
      || !/^[a-f0-9]{40}$/.test(context.baseCommitSha)) fail('qualification cannot substitute for a run authorization');
    const head = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== context.baseCommitSha) fail('qualification base changed');
    verifyFile(root, context.spec);
    return;
  }
  if (Object.keys(context).sort().join() !== 'binding,mode,repositoryRoot'
    || context.mode !== 'checkpoint' || !/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(context.binding?.runId)) {
    fail('unbound checkpoint bootstrap');
  }
  const runRoot = path.join(engine.liveRunRoot(context.repositoryRoot), context.binding.runId);
  if (!root.startsWith(`${runRoot}/`)) fail('bootstrap escaped authorized run');
  const paths = engine.resolveRunPaths(context.binding.runId, context.repositoryRoot);
  const database = new DatabaseSync(paths.databasePath, { readOnly: true });
  try {
    database.exec('BEGIN');
    const store = { database, assertOpen() {}, transaction() { fail('bootstrap cannot mutate runtime state'); } };
    const ledger = engine.createRunLedger(store), tasks = engine.createTaskPlanRecords(store);
    const auth = engine.createGenerationRecords(store).getAuthorization(context.binding.runId);
    if (auth?.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) fail('bootstrap authorization expired');
    const binding = engine.checkpointHydrationBinding(tasks.getTaskPlan(context.binding.runId),
      ledger.getRun(context.binding.runId), auth);
    if (!binding || engine.sha256(binding) !== engine.sha256(context.binding)) fail('bootstrap frozen binding changed');
  } finally { database.close(); }
}

export async function verifyWorkspaceBootstrap(root, config, reference) {
  root = fs.realpathSync(root);
  const configuration = jsonReference(root, config, reference);
  if (!configuration || Object.keys(configuration).sort().join() !== 'context,deadline,inputs,layout,schemaVersion'
    || configuration.schemaVersion !== '1.0.0' || !Number.isSafeInteger(configuration.deadline)
    || configuration.deadline <= Date.now() || configuration.deadline - Date.now() > 5400000
    || !Array.isArray(configuration.inputs) || !configuration.inputs.length
    || new Set(configuration.inputs.map(file => file?.path)).size !== configuration.inputs.length) {
    fail('invalid or expired workspace bootstrap');
  }
  const engine = await engineModules();
  await verifyContext(root, configuration.context, engine);
  const directories = engine.discoverWorkspace(root).directories.sort();
  const requiredInputs = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
    ...directories.map(directory => `${directory}/package.json`),
    ...['.npmrc', '.pnpmfile.cjs'].filter(file => fs.existsSync(path.join(root, file)))];
  if (requiredInputs.some(file => !configuration.inputs.some(input => input.path === file))) {
    fail('incomplete workspace metadata binding');
  }
  for (const input of configuration.inputs) verifyFile(root, input);
  const moduleRoots = ['node_modules', ...directories.map(directory => `${directory}/node_modules`)
    .filter(directory => fs.existsSync(path.join(root, directory)))];
  const expected = jsonReference(root, config, configuration.layout);
  if (!same(snapshotWorkspace(root, moduleRoots), expected)) fail('frozen workspace dependency layout changed');
  if (configuration.deadline <= Date.now()) fail('workspace bootstrap deadline elapsed');
  return { schemaVersion: '1.0.0', mode: configuration.context.mode,
    configurationHash: reference.sha256, layoutHash: configuration.layout.sha256, installation: 'not-invoked' };
}
