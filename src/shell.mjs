import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by the VS Code profile and the lightweight terminal.
export function gitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}
