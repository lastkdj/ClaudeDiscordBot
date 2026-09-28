// Appends entries to CHANGELOG.md (newest first, below the header).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HEADER = '# Server changelog\n\nStructural changes applied to the Discord server, newest first.\n';

export function appendChangelog(path, title, lines) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : HEADER;
  const [head, ...rest] = existing.split(/\n(?=## )/);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const entry = `## ${stamp} UTC — ${title}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
  writeFileSync(path, [head.trimEnd() + '\n', entry, ...rest].join('\n'));
}
