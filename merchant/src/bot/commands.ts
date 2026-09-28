// Slash command definitions (guild-scoped). Every handler re-checks
// authorization in the backend, so being able to see a command grants nothing.
import { SlashCommandBuilder } from 'discord.js';

const orderRef = (o: any) => o.setName('order').setDescription('TM-00012345, marketplace order id').setRequired(true);

export const COMMANDS = [
  new SlashCommandBuilder().setName('order').setDescription('Orders (staff)')
    .addSubcommand((s) => s.setName('find').setDescription('Show an order').addStringOption(orderRef))
    .addSubcommand((s) => s.setName('import').setDescription('Import a marketplace order by hand')
      .addStringOption((o) => o.setName('marketplace_order_id').setDescription('Order number on the marketplace').setRequired(true))
      .addStringOption((o) => o.setName('service').setDescription('Service').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('price').setDescription('What the customer paid, e.g. 60.00').setRequired(true))
      .addBooleanOption((o) => o.setName('paid').setDescription('Payment confirmed on the marketplace?').setRequired(true))
      .addStringOption((o) => o.setName('commission').setDescription('Marketplace commission if known (else estimated)'))
      .addNumberOption((o) => o.setName('deadline_hours').setDescription('Hours from now until the deadline').setMinValue(0.25))
      .addStringOption((o) => o.setName('customer').setDescription('Marketplace username'))
      .addStringOption((o) => o.setName('version').setDescription('Game version').setAutocomplete(true))
      .addStringOption((o) => o.setName('quote_code').setDescription('TM-Q-xxxxx if this came from a quote')))
    .addSubcommand((s) => s.setName('classify').setDescription('Fix an order in manual review').addStringOption(orderRef)
      .addStringOption((o) => o.setName('service').setDescription('Service').setAutocomplete(true))
      .addStringOption((o) => o.setName('price').setDescription('Correct price')))
    .addSubcommand((s) => s.setName('note').setDescription('Add an internal note').addStringOption(orderRef).addStringOption((o) => o.setName('text').setDescription('Note').setRequired(true)))
    .addSubcommand((s) => s.setName('price').setDescription('Change price, commission or provider cost (managers)').addStringOption(orderRef)
      .addStringOption((o) => o.setName('field').setDescription('Which amount').setRequired(true).addChoices({ name: 'Customer price', value: 'customer_price' }, { name: 'Marketplace commission', value: 'marketplace_commission' }, { name: 'Provider cost', value: 'provider_cost' }))
      .addStringOption((o) => o.setName('amount').setDescription('New amount').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true)))
    .addSubcommand((s) => s.setName('cost').setDescription('Record another cost on an order (managers)').addStringOption(orderRef)
      .addStringOption((o) => o.setName('type').setDescription('e.g. replacement, goodwill').setRequired(true))
      .addStringOption((o) => o.setName('amount').setDescription('Amount').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Note').setRequired(true)))
    .addSubcommand((s) => s.setName('refund').setDescription('Record a refund (managers)').addStringOption(orderRef)
      .addStringOption((o) => o.setName('amount').setDescription('Refunded amount').setRequired(true))
      .addStringOption((o) => o.setName('liability').setDescription('Who pays for it').setRequired(true).addChoices({ name: 'TheMerchant', value: 'MERCHANT' }, { name: 'Provider', value: 'PROVIDER' }, { name: 'Split', value: 'SPLIT' }))
      .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true))
      .addStringOption((o) => o.setName('provider_share').setDescription('Provider share (for Split, or a partial Provider amount)')))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel an order (managers)').addStringOption(orderRef).addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true)))
    .addSubcommand((s) => s.setName('complete').setDescription('Record marketplace completion').addStringOption(orderRef).addIntegerOption((o) => o.setName('rating').setDescription('Customer rating 1-5').setMinValue(1).setMaxValue(5)))
    .addSubcommand((s) => s.setName('dispute').setDescription('Open a dispute (managers)').addStringOption(orderRef).addStringOption((o) => o.setName('reason').setDescription('What happened').setRequired(true)))
    .addSubcommand((s) => s.setName('resolve').setDescription('Resolve a dispute (managers)').addStringOption(orderRef)
      .addStringOption((o) => o.setName('outcome').setDescription('Outcome').setRequired(true).addChoices({ name: 'Continue work', value: 'CONTINUE' }, { name: 'Completed', value: 'COMPLETE' }))
      .addStringOption((o) => o.setName('notes').setDescription('Notes').setRequired(true))),

  new SlashCommandBuilder().setName('staff').setDescription('Staff roles (executives)')
    .addSubcommand((s) => s.setName('set').setDescription('Set someone\'s role and games')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('role').setDescription('Role').setRequired(true).addChoices({ name: 'Staff', value: 'STAFF' }, { name: 'Manager', value: 'MANAGER' }, { name: 'Executive', value: 'EXECUTIVE' }, { name: 'Customer (remove staff)', value: 'CUSTOMER' }))
      .addStringOption((o) => o.setName('games').setDescription('Game codes, comma separated: wow, albion, runescape, diablo'))
      .addStringOption((o) => o.setName('approval_limit').setDescription('Managers: max order value they can approve'))),

  new SlashCommandBuilder().setName('provider').setDescription('Providers (managers / executives)')
    .addSubcommand((s) => s.setName('info').setDescription('Provider details').addStringOption((o) => o.setName('code').setDescription('P-123').setRequired(true)))
    .addSubcommand((s) => s.setName('suspend').setDescription('Suspend a provider').addStringOption((o) => o.setName('code').setDescription('P-123').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true)).addStringOption((o) => o.setName('game').setDescription('Only for this game (managers)').setAutocomplete(true)))
    .addSubcommand((s) => s.setName('unsuspend').setDescription('Lift a suspension').addStringOption((o) => o.setName('code').setDescription('P-123').setRequired(true)).addStringOption((o) => o.setName('game').setDescription('Game-scoped suspension').setAutocomplete(true)))
    .addSubcommand((s) => s.setName('level').setDescription('Set a level (executives)').addStringOption((o) => o.setName('code').setDescription('P-123').setRequired(true))
      .addStringOption((o) => o.setName('level').setDescription('Level').setRequired(true).addChoices(...['NEW', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'ELITE'].map((l) => ({ name: l, value: l }))))
      .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true)))
    .addSubcommand((s) => s.setName('reveal-payout').setDescription('Reveal payout details (executives, logged)').addStringOption((o) => o.setName('code').setDescription('P-123').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true)))
    .addSubcommand((s) => s.setName('adjust').setDescription('Balance adjustment or bonus (executives)').addStringOption((o) => o.setName('code').setDescription('P-123').setRequired(true))
      .addStringOption((o) => o.setName('type').setDescription('Type').setRequired(true).addChoices({ name: 'Adjustment', value: 'ADJUSTMENT' }, { name: 'Bonus', value: 'BONUS' }, { name: 'Correction', value: 'CORRECTION' }))
      .addStringOption((o) => o.setName('amount').setDescription('Signed amount, e.g. -5.00').setRequired(true))
      .addStringOption((o) => o.setName('memo').setDescription('Why').setRequired(true))),

  new SlashCommandBuilder().setName('report').setDescription('Executive report for a date range').addStringOption((o) => o.setName('from').setDescription('YYYY-MM-DD').setRequired(true)).addStringOption((o) => o.setName('to').setDescription('YYYY-MM-DD (inclusive)').setRequired(true)),
  new SlashCommandBuilder().setName('dashboard').setDescription('Provider performance for a game (managers)').addStringOption((o) => o.setName('game').setDescription('Game').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder().setName('settings').setDescription('System settings (executives)')
    .addSubcommand((s) => s.setName('show').setDescription('Show all settings'))
    .addSubcommand((s) => s.setName('set').setDescription('Change a setting').addStringOption((o) => o.setName('key').setDescription('Setting').setRequired(true).setAutocomplete(true)).addStringOption((o) => o.setName('value').setDescription('JSON value, e.g. 0.15 or "Europe/Madrid"').setRequired(true))),

  new SlashCommandBuilder().setName('catalog').setDescription('Catalog (executives)')
    .addSubcommand((s) => s.setName('map-listing').setDescription('Map a marketplace listing to a service').addStringOption((o) => o.setName('listing_id').setDescription('Listing id').setRequired(true)).addStringOption((o) => o.setName('service').setDescription('Service').setRequired(true).setAutocomplete(true)).addStringOption((o) => o.setName('version').setDescription('Version').setAutocomplete(true)))
    .addSubcommand((s) => s.setName('fee-rule').setDescription('Marketplace commission rate').addNumberOption((o) => o.setName('rate').setDescription('e.g. 0.10 for 10%').setRequired(true).setMinValue(0).setMaxValue(0.99)).addStringOption((o) => o.setName('game').setDescription('Only this game').setAutocomplete(true)).addStringOption((o) => o.setName('service').setDescription('Only this service').setAutocomplete(true)))
    .addSubcommand((s) => s.setName('service').setDescription('Edit a service').addStringOption((o) => o.setName('service').setDescription('Service').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('risk').setDescription('Risk tier').addChoices({ name: 'LOW', value: 'LOW' }, { name: 'MEDIUM', value: 'MEDIUM' }, { name: 'HIGH', value: 'HIGH' }))
      .addStringOption((o) => o.setName('profile').setDescription('Scoring profile').addChoices(...['CURRENCY', 'BOOSTING', 'RAID', 'DEFAULT'].map((p) => ({ name: p, value: p }))))
      .addBooleanOption((o) => o.setName('trial').setDescription('Trial-eligible for new providers'))
      .addIntegerOption((o) => o.setName('window_minutes').setDescription('Bid window').setMinValue(1).setMaxValue(1440))
      .addIntegerOption((o) => o.setName('hold_days').setDescription('Earning hold period').setMinValue(0).setMaxValue(60))
      .addStringOption((o) => o.setName('ceiling').setDescription('Hidden max bid, or "none"'))
      .addBooleanOption((o) => o.setName('active').setDescription('Active'))),
];

export const commandJson = () => COMMANDS.map((c) => c.toJSON());
