#!/usr/bin/env node
// Compares server-config.json with the live server and applies the difference.
//   node scripts/sync.js --dry-run                 show the plan, change nothing
//   node scripts/sync.js --apply                   apply non-destructive changes
//   node scripts/sync.js --apply --prune           also delete things not in the config
//   node scripts/sync.js --apply --allow-everyone  also change @everyone permissions
//   --config <path>                                use a different config file
import { resolve } from 'node:path';
import { parseArgs, setup, run } from '../src/cli.js';
import { fetchLiveState } from '../src/state.js';
import { buildPlan, formatPlan } from '../src/plan.js';
import { appendChangelog } from '../src/changelog.js';

const CHANGELOG = resolve('CHANGELOG.md');
const GATE_FLAG = { prune: 'prune', 'allow-everyone': 'allow-everyone' };

run(async () => {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const known = new Set(['dry-run', 'apply', 'prune', 'allow-everyone']);
  for (const f of flags) if (!known.has(f)) throw new Error(`Unknown flag --${f}`);
  if (flags.has('dry-run') === flags.has('apply')) throw new Error('Pass exactly one of --dry-run or --apply.');

  const { client, config, guildId } = setup({ configPath: values.config });
  const live = await fetchLiveState(client, guildId);
  const plan = buildPlan(config, live);

  console.log(`Plan for "${live.guild.name}" (${flags.has('dry-run') ? 'DRY RUN — nothing will be changed' : 'APPLY'}):\n`);
  console.log(formatPlan(plan));
  if (flags.has('dry-run') || !plan.ops.length) return;

  console.log('\nApplying...');
  const ctx = {
    client, guildId, botTop: live.botTop,
    reason: 'server-config.json sync',
    roleIds: new Map(plan.seed.roleIds),
    ids: new Map(plan.seed.ids),
  };
  const log = [];
  let failures = 0;
  for (const op of plan.ops) {
    const line = `${op.action.toUpperCase()} ${op.label}`;
    if (op.gate && !flags.has(GATE_FLAG[op.gate])) {
      console.log(`  - skipped ${line} (needs --${GATE_FLAG[op.gate]})`);
      continue;
    }
    try {
      const result = await op.run(ctx);
      const note = typeof result === 'string' ? ` (${result})` : '';
      console.log(`  ✓ ${line}${note}`);
      if (!note) log.push(`${line}${op.details?.length ? `: ${op.details.join('; ')}` : ''}`);
    } catch (err) {
      failures++;
      console.log(`  ✗ ${line}: ${client.redact(err.message)}`);
      log.push(`FAILED ${line}: ${client.redact(err.message)}`);
    }
  }

  if (log.length) {
    appendChangelog(CHANGELOG, 'sync', log);
    console.log(`\nRecorded ${log.length} entr${log.length === 1 ? 'y' : 'ies'} in CHANGELOG.md`);
  }

  const after = buildPlan(config, await fetchLiveState(client, guildId));
  const remaining = after.ops.filter((o) => !o.gate);
  const gated = after.ops.filter((o) => o.gate);
  console.log(`\nAfter apply: ${remaining.length} ungated change(s) remaining, ${gated.length} gated change(s) pending, ${failures} failure(s).`);
  if (failures) process.exitCode = 1;
});
