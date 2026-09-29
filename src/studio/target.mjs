// The storyboard's explicit target syntax, shared by validation and playback.
export function parseTarget(source) {
  if (typeof source !== 'string') throw new Error('target must be text');
  const quoted = '"((?:[^"\\\\]|\\\\.)+)"';
  const simple = new RegExp(`^(text|row|line|label)\\s+${quoted}$`, 's').exec(source);
  if (simple) return { kind: simple[1], value: JSON.parse(`"${simple[2]}"`) };
  const role = new RegExp(`^role\\s+([a-z][a-z0-9_-]*)\\s+${quoted}$`, 's').exec(source);
  if (role) return { kind: 'role', role: role[1], value: JSON.parse(`"${role[2]}"`) };
  const css = /^css\s+(.+)$/s.exec(source);
  if (css && css[1].trim()) return { kind: 'css', value: css[1].trim() };
  throw new Error(`invalid target: ${source}`);
}
