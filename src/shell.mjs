import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Shared by the VS Code profile and the lightweight terminal.
export function gitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

export function runShell(command, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', command] : ['-c', command],
      { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`world setup exited ${code}: ${command}`)));
  });
}

export async function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}
