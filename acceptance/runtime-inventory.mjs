import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail, readJson, regularFile, relativePath, verifyFile } from './primitives.mjs';

export function inventorySources(sources) {
  if (sources?.schemaVersion !== '1.0.0' || !Array.isArray(sources.entries)
    || !sources.entries.length || !Array.isArray(sources.allowedSourceRoots)) fail('empty source inventory');
  const roots = sources.allowedSourceRoots.map((root) => fs.realpathSync(root));
  const files = [];
  const nativeInterpreters = [];
  const destinations = new Set();
  const walk = (source, destination, ancestors = new Set(), excludeModules = false) => {
    relativePath(destination);
    const actual = fs.realpathSync(source);
    if (!roots.some((root) => actual === root || actual.startsWith(`${root}/`))) {
      fail(`unapproved source target: ${actual}`);
    }
    if (ancestors.has(actual)) fail(`dependency cycle requires audited bundling: ${source}`);
    const stat = fs.statSync(actual);
    if (stat.isDirectory()) {
      const next = new Set([...ancestors, actual]);
      for (const name of fs.readdirSync(actual).sort()) {
        if (excludeModules && name === 'node_modules') continue;
        walk(path.join(actual, name), `${destination}/${name}`, next, excludeModules);
      }
    } else {
      if (!stat.isFile() || destinations.has(destination)) fail(`invalid/duplicate source: ${destination}`);
      destinations.add(destination);
      files.push({ source: actual, path: destination, sizeBytes: stat.size,
        mode: stat.mode & 0o777, sha256: bytesHash(fs.readFileSync(actual)) });
      const interpreter = elfInterpreter(fs.readFileSync(actual));
      if (interpreter) nativeInterpreters.push({ path: destination, interpreter });
    }
  };
  for (const entry of sources.entries) {
    if (!entry.provenance || !entry.license) fail('missing source provenance/license');
    walk(entry.source, entry.destination, new Set(), entry.excludeModules === true);
  }
  for (const entry of sources.generatedFiles ?? []) {
    relativePath(entry.path);
    if (destinations.has(entry.path) || typeof entry.contents !== 'string'
      || Buffer.byteLength(entry.contents) > 65536) fail('invalid generated runtime file');
    destinations.add(entry.path);
    files.push({ source: null, path: entry.path, contents: entry.contents,
      sizeBytes: Buffer.byteLength(entry.contents), mode: 0o644,
      sha256: bytesHash(Buffer.from(entry.contents)) });
  }
  return { schemaVersion: '1.0.0', sourcesHash: bytesHash(Buffer.from(JSON.stringify(sources))),
    allowedSourceRoots: roots, files, nativeInterpreters,
    blockingRequirements: sources.blockingRequirements ?? [], qualified: false };
}

// Materialize npm's ancestor lookup with real directories; cycles resolve to an
// already installed ancestor rather than requiring pnpm symlinks or infinite copies.
export function packageSources(root, names) {
  const installed = new Map();
  const entries = [];
  const sourceRoots = new Set();
  const accepts = (values, value) => !values || (!values.includes(`!${value}`)
    && (!values.some((entry) => !entry.startsWith('!')) || values.includes(value)));
  const libc = process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  const compatible = (pkg) => accepts(pkg.os, process.platform) && accepts(pkg.cpu, process.arch)
    && accepts(pkg.libc, libc);
  const findSource = (name, from) => {
    let current = from;
    while (true) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };
  const findInstalled = (name, destination) => {
    let current = destination;
    while (current !== '.') {
      const target = `${current}/node_modules/${name}`;
      if (installed.has(target)) return installed.get(target);
      current = path.posix.dirname(current);
    }
    return installed.get(`node_modules/${name}`) ?? null;
  };
  const add = (name, source, destination) => {
    if (installed.has(destination)) {
      if (installed.get(destination) !== source) fail(`package collision: ${destination}`);
      return;
    }
    if (entries.length >= 10000 || destination.split('/').length > 160) fail('dependency closure too deep');
    installed.set(destination, source);
    sourceRoots.add(source);
    const pkg = readJson(path.join(source, 'package.json'));
    entries.push({ source, destination, excludeModules: true,
      provenance: `${pkg.name}@${pkg.version}`, license: String(pkg.license ?? 'SEE PACKAGE LICENSE') });
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    const peers = new Set(Object.keys(pkg.peerDependencies ?? {}));
    const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      const actual = findSource(dependency, source);
      if (!actual) {
        if (optional.has(dependency) || peers.has(dependency)) continue;
        fail(`installed dependency missing: ${pkg.name} -> ${dependency}`);
      }
      if (!compatible(readJson(path.join(actual, 'package.json')))) {
        if (optional.has(dependency)) continue;
        fail(`incompatible installed dependency: ${dependency}`);
      }
      if (findInstalled(dependency, destination) === actual) continue;
      const target = installed.has(`node_modules/${dependency}`)
        ? `${destination}/node_modules/${dependency}` : `node_modules/${dependency}`;
      add(dependency, actual, target);
    }
  };
  // Pin direct dependencies first so a transitive package cannot choose their versions.
  for (const name of names) {
    const source = findSource(name, root);
    if (!source) fail(`installed package missing: ${name}`);
    installed.set(`node_modules/${name}`, source);
  }
  const direct = [...installed.entries()];
  installed.clear();
  for (const [destination, source] of direct) installed.set(destination, source);
  for (const [destination] of direct) {
    const source = installed.get(destination);
    installed.delete(destination);
    add(readJson(path.join(source, 'package.json')).name, source, destination);
  }
  return { entries, sourceRoots: [...sourceRoots] };
}

export function nativeSources(files) {
  const entries = new Map();
  for (const file of files) {
    if (file.source === null) continue;
    const bytes = fs.readFileSync(file.source);
    if (bytes.length < 4 || bytes.subarray(0, 4).toString('hex') !== '7f454c46') continue;
    let output;
    try {
      output = execFileSync('/usr/bin/ldd', [file.source], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (/not a dynamic executable|statically linked/.test(String(error.stderr))) continue;
      fail(`cannot qualify native dependencies: ${file.source}`);
    }
    if (output.includes('not found')) fail(`missing native dependency: ${file.source}`);
    const interpreter = elfInterpreter(bytes);
    const native = [...output.matchAll(/(?:=>\s*)?(\/[^\s()]+)\s+\(/g)].map((match) => match[1]);
    if (interpreter) native.push(interpreter);
    for (const source of native) {
      entries.set(source, { source, destination: `sysroot${source}`,
        provenance: `Installed native dependency for ${file.path}`, license: 'Installed system package notices' });
    }
  }
  return [...entries.values()];
}

export function expandedInventory(sources, root) {
  const expanded = { ...sources, entries: [...sources.entries],
    allowedSourceRoots: [...sources.allowedSourceRoots] };
  if (sources.packageRoot) {
    const packageRoot = path.resolve(root, sources.packageRoot);
    const pkg = readJson(path.join(packageRoot, 'package.json'));
    const names = sources.packageNames ?? Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const packages = packageSources(packageRoot, names);
    expanded.entries.push(...packages.entries);
    expanded.allowedSourceRoots.push(...packages.sourceRoots);
  }
  const inventory = inventorySources(expanded);
  if (sources.includeNativeDependencies === true) {
    const native = nativeSources(inventory.files);
    const addition = inventorySources({ schemaVersion: '1.0.0', entries: native,
      allowedSourceRoots: [...new Set(native.map((entry) => path.dirname(fs.realpathSync(entry.source))))] });
    inventory.files.push(...addition.files);
    inventory.allowedSourceRoots.push(...addition.allowedSourceRoots);
    inventory.nativeDependencies = addition.files.map(({ path: file, sha256 }) => ({ path: file, sha256 }));
  }
  inventory.sourcesHash = bytesHash(Buffer.from(JSON.stringify(sources)));
  return inventory;
}

export function elfInterpreter(bytes) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46') return null;
  if (bytes[4] !== 2 || bytes[5] !== 1) fail('unsupported native ELF format');
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  if (size < 56 || offset + size * count > bytes.length) fail('invalid ELF headers');
  for (let index = 0; index < count; index += 1) {
    const header = offset + size * index;
    if (bytes.readUInt32LE(header) !== 3) continue;
    const start = Number(bytes.readBigUInt64LE(header + 8));
    const length = Number(bytes.readBigUInt64LE(header + 32));
    if (start + length > bytes.length || length < 1) fail('invalid ELF interpreter');
    return bytes.subarray(start, start + length).toString('utf8').replace(/\0$/, '');
  }
  return null;
}

// `runtime` is the host-relative runtime directory (config.runtime).
export function materialize(root, inventory, runtime) {
  if (typeof runtime !== 'string' || inventory?.schemaVersion !== '1.0.0'
    || !Array.isArray(inventory.files) || !inventory.files.length) fail('invalid runtime materialization');
  relativePath(runtime);
  const resolved = fs.realpathSync(root);
  const staging = path.join(resolved, runtime);
  let parent = resolved;
  for (const part of runtime.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('unsafe runtime destination parent');
  }
  if (fs.existsSync(staging)) fail('runtime destination already exists');
  const paths = new Set();
  for (const file of inventory.files) {
    relativePath(file.path);
    if (paths.has(file.path) || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      fail('invalid runtime file metadata');
    }
    paths.add(file.path);
    if (file.source === null) {
      if (typeof file.contents !== 'string' || bytesHash(Buffer.from(file.contents)) !== file.sha256) {
        fail('generated runtime file drift');
      }
      continue;
    }
    if (!inventory.allowedSourceRoots.some((prefix) =>
      file.source === prefix || file.source.startsWith(`${prefix}/`))) fail('source escaped inventory');
    const actual = regularFile(path.parse(file.source).root, file.source.slice(1));
    if (bytesHash(fs.readFileSync(actual)) !== file.sha256) fail(`source drift: ${file.source}`);
  }
  fs.mkdirSync(staging, { recursive: true });
  for (const file of inventory.files) {
    const target = path.join(staging, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file.source === null) fs.writeFileSync(target, file.contents, { flag: 'wx' });
    else fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, file.mode);
    verifyFile(staging, file);
  }
  return staging;
}

export function verifyRuntime(root, manifest) {
  if (manifest?.schemaVersion !== '1.0.0' || manifest.qualified !== true
    || !Array.isArray(manifest.files) || !manifest.files.length) fail('runtime is not qualified');
  for (const file of manifest.files) verifyFile(root, file);
  if (!Array.isArray(manifest.commands) || !manifest.commands.length) fail('missing frozen commands');
  for (const command of manifest.commands) {
    if (!command.id || !Array.isArray(command.argv) || !path.isAbsolute(command.argv[0])
      || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) fail('invalid frozen command');
    verifyFile('/', { path: command.argv[0].slice(1), sha256: command.executableSha256 });
  }
  return manifest;
}

export function dependencyManifest(inventory, runtime) {
  if (inventory?.schemaVersion !== '1.0.0' || !Array.isArray(inventory.files)
    || !inventory.files.length || inventory.files.length > 100000) fail('invalid dependency inventory');
  relativePath(runtime);
  const files = inventory.files.map((file) => {
    relativePath(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) fail('invalid dependency hash');
    return { path: `${runtime}/${file.path}`, sha256: file.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(files.map((file) => file.path)).size !== files.length) fail('duplicate dependency path');
  const result = { schemaVersion: '1.0.0', files };
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 > 20 * 1024 * 1024) fail('dependency manifest too large');
  return result;
}
