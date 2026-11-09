import fs from 'node:fs';
import path from 'node:path';

const nodeScript = (file: string): boolean => /\.[cm]?js$/.test(file)
  || fs.readFileSync(file, 'utf8').slice(0, 64).startsWith('#!/usr/bin/env node');

// Frozen copies carry no node_modules/.bin, so package scripts cannot resolve CLIs such as eslint.
// `node` is the absolute node executable the shims exec (the profile's nodeExecutable).
export function writeBinShims(worktreeDir: string, packageDir: string, node: string): void {
  if (!path.isAbsolute(node)) throw new Error('writeBinShims requires an absolute node executable');
  const modules = path.join(worktreeDir, packageDir, 'node_modules');
  const names = fs.readdirSync(modules).flatMap((name) => name.startsWith('@')
    ? fs.readdirSync(path.join(modules, name)).map((child) => `${name}/${child}`) : [name]);
  const bin = path.join(modules, '.bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const manifest = path.join(modules, name, 'package.json');
    if (name.startsWith('.') || !fs.existsSync(manifest)) continue;
    const declared = JSON.parse(fs.readFileSync(manifest, 'utf8')).bin;
    const entries: Record<string, string> = typeof declared === 'string' ? { [name.split('/').pop() ?? name]: declared } : declared ?? {};
    for (const [command, target] of Object.entries(entries)) {
      const script = path.join(modules, name, target);
      const shim = path.join(bin, command);
      if (!/^[\w.-]+$/.test(command) || !script.startsWith(`${modules}/`) || !fs.existsSync(script)
        || !nodeScript(script) || fs.existsSync(shim)) continue;
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${node}" "$(dirname "$0")/../${name}/${target}" "$@"\n`, { mode: 0o755 });
    }
  }
}
