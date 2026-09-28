// Keeps one panel message in each entry channel (welcome, support, ...),
// editing it in place on restart instead of posting duplicates.
import * as V from '../discord-ui/views.js';
import { CHANNELS, getState, type Runtime, setState, textChannel } from './runtime.js';

const PANELS: [key: string, channel: string, build: () => V.Payload][] = [
  ['welcome', CHANNELS.welcome, V.welcomePanel],
  ['support', CHANNELS.support, V.supportPanel],
  ['directOrder', CHANNELS.directOrder, V.directOrderPanel],
  ['providerApply', CHANNELS.providerApply, V.applyPanel],
  ['providerPanel', CHANNELS.providerPanel, V.providerPanel],
];

export async function ensurePanels(rt: Runtime): Promise<string[]> {
  const missing: string[] = [];
  for (const [key, channelName, build] of PANELS) {
    const ch = textChannel(rt, channelName);
    if (!ch) {
      missing.push(`#${channelName}`);
      continue;
    }
    const payload = build();
    const stored = await getState(rt.ctx.db, `panel.${key}`);
    const existing = stored?.messageId && stored.channelId === ch.id ? await ch.messages.fetch(stored.messageId).catch(() => null) : null;
    if (existing) {
      await existing.edit(payload);
      continue;
    }
    const msg = await ch.send(payload);
    await msg.pin().catch(() => {});
    await setState(rt.ctx.db, `panel.${key}`, { channelId: ch.id, messageId: msg.id });
  }
  return missing;
}
