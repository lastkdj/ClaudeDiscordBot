// Wiring checks: every job kind the code enqueues has a handler, and the slash
// command definitions are valid.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandJson } from '../../src/bot/commands.js';
import { registerDiscordEffects } from '../../src/bot/effects.js';
import { silentLogger } from '../../src/logger.js';
import { ManualAdapter } from '../../src/marketplace/manual.js';
import { registerBusinessJobs } from '../../src/worker/business-jobs.js';
import { JobRunner } from '../../src/worker/runner.js';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('wiring', () => {
  it('every enqueued job kind has a handler', () => {
    const kinds = new Set<string>();
    for (const file of sources(new URL('../../src', import.meta.url).pathname)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/enqueue\([^,]+,\s*'([a-zA-Z.]+)'/g)) kinds.add(m[1]!);
      for (const m of readFileSync(file, 'utf8').matchAll(/kind: '([a-zA-Z]+\.[a-zA-Z]+)'/g)) kinds.add(m[1]!);
    }
    const ctx = { db: {} as any, log: silentLogger, now: () => new Date(), payoutKey: null, source: 'JOB' as const };
    const runner = new JobRunner(ctx, silentLogger);
    registerBusinessJobs(runner, ctx, new ManualAdapter('m'));
    registerDiscordEffects(runner, { ctx } as any);
    const handled = new Set(runner.kinds());
    expect([...kinds].filter((k) => !handled.has(k)).sort()).toEqual([]);
    expect(kinds.size).toBeGreaterThan(20);
  });

  it('slash commands are valid and within Discord limits', () => {
    const cmds = commandJson();
    expect(cmds.length).toBeLessThanOrEqual(100);
    for (const c of cmds) {
      expect(c.name).toMatch(/^[a-z-]{1,32}$/);
      expect(JSON.stringify(c).length).toBeLessThan(8000);
      for (const sub of (c.options ?? []) as any[]) expect((sub.options ?? []).length).toBeLessThanOrEqual(25);
    }
  });
});
