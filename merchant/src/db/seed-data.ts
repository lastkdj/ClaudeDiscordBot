// Initial taxonomy (ARCHITECTURE §4). Editable later with /catalog; the seed is idempotent.

export interface SeedService {
  code: string;
  name: string;
  kind?: 'SERVICE' | 'CURRENCY';
  pricingUnit?: 'per_run' | 'per_level' | 'per_1M' | 'per_unit' | 'fixed';
  profile?: 'CURRENCY' | 'BOOSTING' | 'RAID' | 'DEFAULT';
  risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  trial?: boolean;
  windowSec?: number;
  holdDays?: number;
}

export interface SeedCategory {
  code: string;
  name: string;
  services?: SeedService[];
}

export interface SeedGame {
  code: string;
  name: string;
  emoji: string;
  shortName: string;
  channelPrefix: string;
  versions: [string, string][];
  categories: SeedCategory[];
  /** Fields a provider needs, shared by the game's services unless overridden. */
  requirements: { key: string; label: string; required: boolean }[];
}

const cur = (code: string, name: string): SeedService => ({ code, name, kind: 'CURRENCY', pricingUnit: 'per_1M', profile: 'CURRENCY', risk: 'LOW', trial: true, windowSec: 600 });
const boost = (code: string, name: string, risk: SeedService['risk'] = 'MEDIUM', extra: Partial<SeedService> = {}): SeedService => ({ code, name, profile: 'BOOSTING', risk, ...extra });
const other = (): SeedCategory => ({ code: 'other', name: 'Other', services: [{ code: 'custom', name: 'Custom request', profile: 'DEFAULT', risk: 'MEDIUM' }] });

export const SEED: SeedGame[] = [
  {
    code: 'wow',
    name: 'World of Warcraft',
    emoji: '⚔️',
    shortName: 'WoW',
    channelPrefix: 'wow',
    versions: [['retail', 'Retail'], ['classic-prog', 'Classic Progression'], ['classic-era', 'Classic Era / Hardcore / Seasonal']],
    requirements: [
      { key: 'region', label: 'Region (EU/US)', required: true },
      { key: 'realm', label: 'Realm and faction', required: true },
      { key: 'character', label: 'Character name and class/spec', required: true },
      { key: 'notes', label: 'Anything else the provider needs', required: false },
    ],
    categories: [
      { code: 'mythic-plus', name: 'Mythic+', services: [boost('key-timed', 'Mythic+ key (timed)', 'MEDIUM', { pricingUnit: 'per_run', windowSec: 1800 }), boost('weekly-vault', 'Weekly vault run', 'MEDIUM', { pricingUnit: 'per_run' })] },
      { code: 'dungeons', name: 'Dungeons', services: [boost('dungeon-run', 'Dungeon run', 'LOW', { pricingUnit: 'per_run', trial: true })] },
      { code: 'raids', name: 'Raids', services: [
        { code: 'normal-clear', name: 'Raid normal full clear', profile: 'RAID', risk: 'MEDIUM', windowSec: 1800 },
        { code: 'heroic-clear', name: 'Raid heroic full clear', profile: 'RAID', risk: 'HIGH', windowSec: 1800 },
        { code: 'mythic-boss', name: 'Raid mythic boss kill', profile: 'RAID', risk: 'HIGH', windowSec: 1800 },
      ] },
      { code: 'pvp', name: 'PvP', services: [boost('arena-rating', 'Arena rating', 'HIGH'), boost('rbg-wins', 'Rated battleground wins', 'MEDIUM')] },
      { code: 'gold', name: 'Gold', services: [cur('gold', 'Gold (per 1M)')] },
      { code: 'leveling', name: 'Leveling', services: [boost('leveling', 'Character leveling', 'MEDIUM', { pricingUnit: 'per_level' })] },
      { code: 'powerleveling', name: 'Powerleveling', services: [boost('powerleveling', 'Powerleveling (piloted)', 'HIGH', { pricingUnit: 'per_level' })] },
      { code: 'achievements', name: 'Achievements', services: [boost('achievement', 'Achievement', 'MEDIUM')] },
      { code: 'glory', name: 'Glory Achievements', services: [boost('glory', 'Glory achievement', 'MEDIUM')] },
      { code: 'mounts', name: 'Mounts', services: [boost('mount', 'Mount farm', 'MEDIUM')] },
      { code: 'reputation', name: 'Reputation', services: [boost('reputation', 'Reputation grind', 'LOW', { trial: true })] },
      { code: 'professions', name: 'Professions', services: [boost('profession', 'Profession leveling', 'LOW')] },
      { code: 'gear', name: 'Gear', services: [boost('gear', 'Gear upgrade runs', 'MEDIUM')] },
      { code: 'questing', name: 'Questing', services: [boost('questing', 'Questing', 'LOW', { trial: true })] },
      { code: 'collections', name: 'Collections', services: [boost('collection', 'Collection (pets, toys, transmog)', 'LOW')] },
      { code: 'legacy', name: 'Legacy Content', services: [boost('legacy', 'Legacy raid/dungeon run', 'LOW', { trial: true })] },
      { code: 'coaching', name: 'Coaching', services: [{ code: 'coaching', name: 'Coaching session (per hour)', profile: 'DEFAULT', risk: 'LOW', pricingUnit: 'per_unit', trial: true }] },
      other(),
    ],
  },
  {
    code: 'albion',
    name: 'Albion Online',
    emoji: '🏹',
    shortName: 'Albion',
    channelPrefix: 'albion',
    versions: [['americas', 'Americas'], ['europe', 'Europe'], ['asia', 'Asia']],
    requirements: [
      { key: 'character', label: 'Character name', required: true },
      { key: 'location', label: 'City / delivery location', required: false },
      { key: 'notes', label: 'Anything else the provider needs', required: false },
    ],
    categories: [
      { code: 'silver', name: 'Silver', services: [cur('silver', 'Silver (per 1M)')] },
      { code: 'gold', name: 'Gold', services: [{ ...cur('gold', 'Gold (per unit)'), pricingUnit: 'per_unit' }] },
      { code: 'fame', name: 'Fame Farming', services: [boost('fame', 'Fame farming', 'MEDIUM')] },
      { code: 'pve', name: 'PvE', services: [boost('pve', 'PvE content', 'MEDIUM')] },
      { code: 'pvp', name: 'PvP', services: [boost('pvp', 'PvP content', 'HIGH')] },
      { code: 'gathering', name: 'Gathering', services: [boost('gathering', 'Gathering', 'LOW', { trial: true })] },
      { code: 'crafting', name: 'Crafting', services: [boost('crafting', 'Crafting', 'LOW')] },
      { code: 'dungeons', name: 'Dungeons', services: [boost('solo', 'Solo dungeon', 'LOW', { trial: true }), boost('group', 'Group dungeon', 'MEDIUM'), boost('avalonian', 'Avalonian dungeon', 'HIGH')] },
      { code: 'mists', name: 'Mists / Corrupted', services: [boost('mists', 'Mists / corrupted dungeon', 'MEDIUM')] },
      { code: 'leveling', name: 'Leveling (specs/masteries)', services: [boost('mastery', 'Spec / mastery leveling', 'MEDIUM', { pricingUnit: 'per_level' })] },
      other(),
    ],
  },
  {
    code: 'runescape',
    name: 'RuneScape',
    emoji: '🪓',
    shortName: 'RuneScape',
    channelPrefix: 'rs',
    versions: [['osrs', 'Old School'], ['rs3', 'RuneScape 3']],
    requirements: [
      { key: 'rsn', label: 'RuneScape name', required: true },
      { key: 'world', label: 'Preferred world / meeting spot', required: false },
      { key: 'notes', label: 'Anything else the provider needs', required: false },
    ],
    categories: [
      { code: 'gold', name: 'Gold', services: [cur('gold', 'Gold (per 1M)')] },
      { code: 'skills', name: 'Skills', services: [boost('skill', 'Skill training', 'MEDIUM', { pricingUnit: 'per_level' })] },
      { code: 'questing', name: 'Questing', services: [boost('quest', 'Quest completion', 'MEDIUM')] },
      { code: 'bossing', name: 'Bossing / PvM', services: [boost('boss', 'Boss kills', 'MEDIUM', { pricingUnit: 'per_unit' })] },
      { code: 'minigames', name: 'Minigames', services: [boost('minigame', 'Minigame', 'LOW', { trial: true })] },
      { code: 'diaries', name: 'Achievements & Diaries', services: [boost('diary', 'Achievement diary', 'MEDIUM')] },
      { code: 'capes', name: 'Quest Capes', services: [boost('quest-cape', 'Quest cape', 'HIGH')] },
      // Account services carry the most risk (credentials): HIGH, and never posted in Discord (Q7).
      { code: 'account', name: 'Account services', services: [boost('account', 'Account service (piloted)', 'HIGH')] },
      other(),
    ],
  },
  {
    code: 'diablo',
    name: 'Diablo',
    emoji: '🔥',
    shortName: 'Diablo',
    channelPrefix: 'diablo',
    versions: [['d4-season', 'Diablo IV (Season)'], ['d4-eternal', 'Diablo IV (Eternal)'], ['d2r-ladder', 'Diablo II: Resurrected (Ladder)'], ['d2r-nonladder', 'Diablo II: Resurrected (Non-ladder)'], ['immortal', 'Diablo Immortal']],
    requirements: [
      { key: 'battletag', label: 'BattleTag / character', required: true },
      { key: 'platform', label: 'Platform and region', required: true },
      { key: 'notes', label: 'Anything else the provider needs', required: false },
    ],
    categories: [
      { code: 'currency', name: 'Currency', services: [cur('gold', 'Gold (per 1M)')] },
      { code: 'leveling', name: 'Leveling', services: [boost('leveling', 'Leveling', 'MEDIUM', { pricingUnit: 'per_level' })] },
      { code: 'powerleveling', name: 'Powerleveling', services: [boost('powerleveling', 'Powerleveling (piloted)', 'HIGH', { pricingUnit: 'per_level' })] },
      { code: 'gear', name: 'Gear', services: [boost('gear', 'Gear / build', 'MEDIUM')] },
      { code: 'bosses', name: 'Bosses', services: [boost('boss', 'Boss kills', 'MEDIUM', { pricingUnit: 'per_unit' })] },
      { code: 'dungeons', name: 'Dungeons', services: [boost('dungeon', 'Dungeon runs', 'LOW', { trial: true, pricingUnit: 'per_run' })] },
      { code: 'endgame', name: 'Endgame', services: [boost('endgame', 'Endgame progression', 'MEDIUM')] },
      { code: 'materials', name: 'Materials', services: [{ ...cur('materials', 'Materials (per unit)'), pricingUnit: 'per_unit' }] },
      { code: 'farming', name: 'Farming', services: [boost('farming', 'Farming', 'LOW', { trial: true })] },
      { code: 'seasonal', name: 'Seasonal Content', services: [boost('seasonal', 'Season journey / battle pass', 'MEDIUM')] },
      other(),
    ],
  },
];
