# TheMerchant: Shop Operations System architecture

**Status:** v0.2 (2026-09-29). The owner approved the plan and answered Q1–Q5, Q8, Q10 and Q13 (see the decisions table at the end). The server structure (§1–3) has been applied. TheMerchant is built in `merchant/` but not yet deployed.

TheMerchant is a **shop that sells inside an existing marketplace**. This system is not a marketplace. It is the back office that runs the shop in Discord: orders, sealed provider bidding, provider selection, fulfillment, accounting, provider balances, reputation and reporting. The marketplace keeps its catalog, checkout, payments, customer accounts and order system. We connect to it through an adapter.

```
CUSTOMER
   ↓
EXISTING MARKETPLACE  ──(API / webhooks, via Marketplace Adapter)──┐
   ↓                                                                │
THEMERCHANT SHOP ORDER  (TM-00018421 ↔ marketplace #928173)  ◄──────┘
   ↓
DISCORD OPERATIONS  (TheMerchant bot + PostgreSQL)
   ↓
ELIGIBLE PROVIDERS  (game + service + level gate + available + capacity)
   ↓
SEALED BIDS  (private desk threads, ephemeral modals)
   ↓
PRICE + REPUTATION + LEVEL + EXPERIENCE  →  Bid Selection Score
   ↓
SYSTEM RECOMMENDATION
   ↓
STAFF / MANAGER CONFIRMATION  (ASSISTED mode)
   ↓
PROVIDER CONFIRMS  (timeout → next bid)
   ↓
FULFILLMENT  (private order room)
   ↓
MARKETPLACE COMPLETION  (event from marketplace, or staff-recorded)
   ↓
ACCOUNTING  (profit = price − commission − provider cost − refunds − other)
   ↓
PROVIDER BALANCE  (append-only ledger: PENDING → AVAILABLE → RESERVED → PAID)
   ↓
THEMERCHANT PROFIT  (reports)
   ↓
PROVIDER REPUTATION UPDATE  (global / game / service; level review)
```

## 0. Two bots, two jobs

| | **ClaudeBot** (exists) | **TheMerchant** (to build, app `1554254355644026910`) |
|---|---|---|
| Purpose | Manages the server's **structure** from this repo, following your instructions in Claude Code chat | Runs the shop's **operations** 24/7 |
| How it runs | On demand, over REST: `server-config.json`, then dry run, then apply | Always-on gateway bot, plus a webhook API and background jobs |
| Touches | Roles, categories, channels, permission overwrites, server settings | Messages, threads, forum posts, buttons, modals, role assignment for approved members |
| Data | None (config in git) | PostgreSQL, the source of truth for all business data |
| Permissions | Structural (Manage Channels, Manage Roles, Manage Server). **Administrator removed.** | Operational only (see §26). No Manage Channels, no Administrator. |

Rule of thumb: **ClaudeBot builds the building, and TheMerchant works inside it.** New games add channels through `server-config.json` (ClaudeBot) and rows in the `games` and `services` tables (TheMerchant). Neither needs code changes.

---

## 1. Discord server tree

Design principles: few permanent channels. Orders live as **forum posts** (one per order, per game, staff only). Work happens in **private threads** (order rooms, provider desks, tickets). Everything sensitive is **ephemeral**. Adding a game adds exactly one category with 4 channels.

```
TheMerchant (guild)
│
├── 📌 START HERE                         everyone: read only
│   ├── #welcome                           what TheMerchant is; onboarding entry
│   ├── #rules                             Community rules channel
│   ├── #announcements                     [announcement] shop news
│   └── #how-to-order                      marketplace-first ordering guide
│
├── 🛒 CUSTOMERS                           Customer (+ staff)
│   ├── #marketplace                       read only: links to TheMerchant listings per game
│   ├── #support                           panel [Open ticket] → private ticket thread per customer
│   └── #direct-order                      panel [Request a quote] → private quote thread
│
├── 🤝 PROVIDER HUB                        Provider / Provider Applicant
│   ├── #provider-rules                    read only
│   ├── #provider-apply                    applicants only: [Apply] → modal + selects
│   ├── #provider-news                     read only announcements to providers
│   ├── #provider-panel                    [Availability] [My balance] [My stats] [My capabilities] → all ephemeral
│   └── #provider-desks                    parent only; each provider has ONE private desk thread
│                                          (opportunities, bid receipts, selection & confirmation)
│
├── ⚔️ WORLD OF WARCRAFT                   "WoW Team" role (staff + managers), plus WoW providers where noted
│   ├── #wow-orders                        [forum] staff only: one post per order, tags = status, bid review
│   ├── #wow-ops                           staff/manager coordination
│   ├── #wow-dashboard                     read only: one live-edited dashboard message
│   └── #wow-order-rooms                   parent only: private thread per active order (provider + assigned staff)
│
├── 🏹 ALBION ONLINE                       same 4 channels: #albion-orders, #albion-ops, #albion-dashboard, #albion-order-rooms
├── 🪓 RUNESCAPE                           same 4 channels: #rs-orders, #rs-ops, #rs-dashboard, #rs-order-rooms
├── 🔥 DIABLO                              same 4 channels: #diablo-orders, #diablo-ops, #diablo-dashboard, #diablo-order-rooms
│
├── 🧭 MANAGEMENT                          Staff / Manager / Executive
│   ├── #staff-room                        all staff (cross-game chat, no financial data)
│   ├── #managers                          managers + executives
│   ├── #provider-applications             [forum] managers: one post per application, tagged by game
│   └── 🔊 Staff Voice
│
├── 🏛️ EXECUTIVE                           Executive only
│   ├── #exec-reports                      daily / weekly / monthly summaries
│   ├── #finance                           payout requests & approvals, adjustments
│   ├── #audit-log                         feed of high-importance audit events
│   └── #exec-chat
│
└── ⚙️ SYSTEM                              Executive only
    ├── #system-alerts                     integration failures, stuck orders, job errors
    └── #integration-events                marketplace event feed (compact)
```

About 40 channels in total, and each extra game adds 4. Discord allows 500 channels per server. Order volume never creates channels, only threads and forum posts, which are archived when they finish.

**Prerequisite:** enable the server's **Community** feature. Announcement channels, Onboarding (which routes new members into customer vs. provider) and the welcome screen need it. ClaudeBot can enable it. It requires a rules channel, an updates channel, a verification level of at least *Low* and the explicit-content filter.

## 2. Roles

Listed highest to lowest. None of them has **Administrator**.

| Role | Who | Server-wide permissions (beyond @everyone baseline) |
|---|---|---|
| `ClaudeBot` (managed) | structure bot | Manage Channels, Manage Roles, Manage Server, View Audit Log. Must stay the highest role. |
| `TheMerchant` (managed) | operations bot | Manage Roles (only for roles below it), Manage Threads, Create Private Threads, Send in Threads, Manage Messages, Embed Links, Moderate Members |
| `Executive` | owners / top admins | View Audit Log, Manage Messages, Manage Threads, Moderate Members, Kick, Ban, Manage Nicknames |
| `Manager` | game managers | Moderate Members (timeouts). Everything else comes from channel overwrites. |
| `Staff` | operations staff | (none) |
| `WoW Team`, `Albion Team`, `RuneScape Team`, `Diablo Team` | staff/managers assigned to a game | (none). These roles make the game category visible. |
| `Provider` | approved providers | (none) |
| `WoW Provider`, `Albion Provider`, `RuneScape Provider`, `Diablo Provider` | providers approved for a game | (none). They open that game's order-rooms parent channel. |
| `Provider Applicant` | applied, not approved | (none) |
| `Customer` | customers | (none) |
| `@everyone` | anyone | Read START HERE only. Tightening this needs a separately confirmed `--allow-everyone` apply. |

**Discord roles control what people can see. The database decides what they're allowed to do.** Every button, command and modal re-checks authorization in the backend (§26). If a role is added by hand in Discord, it doesn't give anyone business permissions. The bot reconciles roles against the database and reports any drift to #system-alerts.

Provider levels (Bronze … Elite) are **not** roles in v1. They live in the database, which avoids role sprawl and stops providers seeing each other's standing. Cosmetic level roles can come later if you want them.

## 3. Permission matrix

✅ = allowed, 🎮 = only for assigned games, 👤 = only own records, ❌ = denied.

| Capability | Executive | Manager | Staff | Provider | Customer | System (bot) |
|---|---|---|---|---|---|---|
| See START HERE / CUSTOMERS channels | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| See game category / order forum | ✅ all | 🎮 | 🎮 | ❌ | ❌ | ✅ |
| See customer price, commission, margin | ✅ | 🎮 | 🎮 | ❌ | ❌ | ✅ |
| See all bids on an order | ✅ | 🎮 | 🎮 | ❌ | ❌ | ✅ |
| Submit / withdraw a bid | ❌ | ❌ | ❌ | 👤 eligible orders only | ❌ | — |
| See other providers' bids, orders, earnings, balance | ✅ | 🎮 (orders/bids only) | 🎮 (orders/bids only) | ❌ | ❌ | ✅ |
| Import / create order manually | ✅ | 🎮 | 🎮 | ❌ | ❌ | ✅ |
| Assign recommended provider (ASSISTED) | ✅ | 🎮 | 🎮 (below value threshold) | ❌ | ❌ | ✅ (AUTO mode only) |
| Override recommendation | ✅ | 🎮 | 🎮 with mandatory reason (below threshold) | ❌ | ❌ | ❌ |
| Approve high-value / high-risk assignment | ✅ | 🎮 | ❌ | ❌ | ❌ | ❌ |
| Change order price / provider cost | ✅ | 🎮 with reason | ❌ | ❌ | ❌ | ✅ (from marketplace events) |
| Cancel order / record refund | ✅ | 🎮 | request only | ❌ | ❌ | ✅ (from marketplace events) |
| Approve provider application / capabilities | ✅ | 🎮 | ❌ | ❌ | ❌ | ❌ |
| Change provider level manually | ✅ | ❌ (request) | ❌ | ❌ | ❌ | ✅ (scheduled evaluation) |
| Suspend provider | ✅ | 🎮 (game-scoped suspension) | ❌ | ❌ | ❌ | ✅ (automatic flags) |
| See provider balance | ✅ | ❌ | ❌ | 👤 | ❌ | ✅ |
| Approve payout / ledger adjustment | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Executive reports / audit log | ✅ | ❌ (own game dashboard only) | ❌ | ❌ | ❌ | ✅ |
| Open support ticket / request quote | — | — | — | ✅ | ✅ | — |
| See own tickets & quotes | ✅ | 🎮 | 🎮 | 👤 | 👤 | ✅ |
| Scoring weights / system settings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

Thresholds such as "high-value" come from `system_settings` (default: order value ≥ €150 or risk tier HIGH).

## 4. Game / service assignment architecture

Everything is data. Adding a game means rows in these tables plus one config block for ClaudeBot. There's no code change.

```
games ─┬─ game_versions          (WoW: Retail | Classic Progression | Classic Era/Hardcore;
       │                          RS: OSRS | RS3; Diablo: IV | II: Resurrected | Immortal;
       │                          Albion: Americas | Europe | Asia)
       ├─ service_categories     (WoW: Mythic+, Raids, PvP, Gold, Leveling, ...)
       │    └─ services          (e.g. "Mythic+ +10 timed", kind = SERVICE|CURRENCY,
       │                          pricing_unit = per_run | per_level | per_1M | fixed,
       │                          scoring_profile = BOOSTING | CURRENCY | ...,
       │                          risk_tier = LOW | MEDIUM | HIGH,
       │                          requirement_schema = JSON (fields the provider needs))
       └─ discord_bindings       (forum channel id, order-rooms channel id, team role id, provider role id)

staff_game_assignments   (user_id, game_id)   many-to-many
manager_game_assignments (user_id, game_id)   many-to-many
provider_capabilities    (provider_id, service_id | category_id, game_version_id?, status=PENDING|APPROVED|REVOKED,
                          approved_by, approved_at)
marketplace_listing_map  (marketplace, external_listing_id → service_id, game_version_id, quantity rule)
```

**Initial taxonomy**, which can be edited any time:

- **World of Warcraft.** Versions: Retail, Classic Progression, Classic Era / Hardcore / Seasonal. Categories: Mythic+, Dungeons, Raids, PvP, Gold, Leveling, Powerleveling, Achievements, Glory Achievements, Mounts, Reputation, Professions, Gear, Questing, Collections, Legacy Content, Coaching, Other.
- **Albion Online.** Servers: Americas, Europe, Asia. Categories: Silver, Gold (currency), Fame Farming, PvE, PvP, Gathering, Crafting, Dungeons (solo/group/avalonian), Mists/Corrupted, Leveling (specs/masteries), Other.
- **RuneScape.** Versions: Old School, RuneScape 3. Categories: Gold, Skills, Questing, Bossing / PvM, Minigames, Achievements & Diaries, Quest Capes, Accounts services (see note), Other.
- **Diablo.** Versions: Diablo IV (Season / Eternal), Diablo II: Resurrected (Ladder / Non-ladder), Diablo Immortal. Categories: Currency, Leveling, Powerleveling, Gear, Bosses, Dungeons, Endgame, Materials, Farming, Seasonal Content, Other.

Discord select menus hold at most 25 options, so choices go **game → version → category → service**, with paging where needed.

## 5. Provider onboarding

```
Joins server ─► Onboarding question: "Customer" or "I want to become a provider"
                    │
                    ▼ (provider)
         role: Provider Applicant  → sees #provider-rules, #provider-apply
                    │
   [Accept rules] button (records rules version + timestamp)
                    │
   [Apply] → modal 1: display name, timezone, experience summary, references/proof link
           → select: games (multi) → select: versions → select: CURRENCY / SERVICE / BOTH
           → select: categories per game → select: specific services (paged)
                    │
   Application stored (status SUBMITTED); capabilities stored as PENDING
                    │
   Forum post in #provider-applications, tagged per game (no financial data)
                    │
   Manager of EACH requested game approves/rejects that game's capabilities
   (a manager can't approve games they don't manage; the provider can't approve anything)
                    │
   First approval ⇒ provider profile created: code P-xxx, level NEW, reputation = prior
                   roles: Provider + <Game> Provider; private desk thread created
                    │
   Eligible for opportunities in approved services only (new-provider limits apply, §17)
```

"Verification" means rules accepted, an account-age check (the Discord account must be at least N days old), optional proof review by the manager, and a payout-details form stored encrypted. Only Executives can reveal payout details.

Later, a provider can request more capabilities with `/capabilities request`, which goes through the same manager approval.

## 6. Provider isolation

**Guaranteed by design:**

- **No shared provider channel carries business data.** Opportunities, bids, selection notices, balances and stats go to the provider's **own private desk thread** or to **ephemeral** replies that only they can see.
- **Order rooms are private threads.** Only the assigned provider and the assigned staff are members. Providers have *View Channel* + *Send Messages in Threads* on the parent channel, but no *Send Messages*, *Manage Threads* or *Create Threads*. So they see nothing except the threads they were added to.
- **Bids are never posted anywhere.** They're submitted through a modal, stored in the database and acknowledged ephemerally. Bid review happens in the staff-only order forum.
- **Providers are shown by code** (P-184) in staff views. Providers never see other providers' codes.
- **Only Executives have Manage Threads on #provider-desks.** Staff and managers can't browse provider desks.
- **Balances and earnings are only shown through ephemeral replies.**

**Discord limit:** Discord shows every member who can view a channel in its member list, and people can see each other's roles. A provider could therefore work out *who else* is a provider (if the Provider role is visible) or *who else is in the server*. They can't see anything about those people's bids, orders or earnings. To minimize this, `Provider` and the game-provider roles are **not hoisted**, have **no color**, and there's no provider chat. See open question Q2.

## 7. Marketplace → Discord order flow

```
Marketplace webhook ─► POST /webhooks/marketplace
   1. verify signature + timestamp (adapter)             ✗ → 401, alert
   2. INSERT integration_events (source, external_event_id) ON CONFLICT DO NOTHING
        already there? → 200 "duplicate", stop            (idempotency)
   3. adapter.normalize(payload) → MarketplaceEvent
   4. enqueue job "process-integration-event" (pg-boss), return 200 fast
Worker:
   5. BEGIN
      upsert orders by UNIQUE (source, marketplace_order_id)   (second guard)
      classify via marketplace_listing_map
         confident → status VALIDATED
         unknown listing / missing fields / price mismatch → MANUAL_REVIEW
      record marketplace commission (actual if provided, else fee rule; flagged "estimated")
      append order_events + audit_logs
      COMMIT
   6. Discord: create forum post in #<game>-orders (or #system-alerts for MANUAL_REVIEW)
   7. VALIDATED + PAYMENT_CONFIRMED → PROCUREMENT → open sealed bidding (§11)
```

Other events map to state transitions. Payment Confirmed unlocks procurement. Customer Message posts into the order room (staff decide what the provider sees). Order Updated re-validates. Cancelled or Refund moves the order to CANCELLED / REFUNDED / PARTIAL_REFUND and creates ledger reversals. Dispute moves it to DISPUTED and alerts the game's manager. Completed moves it to MARKETPLACE_COMPLETION then COMPLETED and releases earnings.

Events that arrive out of order are handled by comparing the marketplace's `updated_at` or version number. A stale update is stored but not applied.

**Before API access exists (Phase 6),** staff run `/order import`: they enter the marketplace order ID and pick the listing, and the modal takes price, commission, quantity, deadline and requirements. The same core path is used, with `source = MANUAL`.

## 8. Discord direct-order flow

Direct orders come second to the marketplace. Every direct request becomes an internal order that uses the **same order and accounting model**.

```
#direct-order [Request a quote]
   → selects: game → version → service ; modal: quantity/spec, deadline, notes
   → private quote thread (customer + that game's staff), order status QUOTE_REQUESTED, source = DISCORD
   → staff reply with [Send quote] (price) and one of:
       B. REDIRECT (default): link to the matching TheMerchant marketplace listing.
          When the marketplace order arrives, the webhook links it to the quote
          (customer enters quote code TM-Q-xxxx in the marketplace order note, or staff link it).
       C. CONVERT: staff create/import the marketplace order and link it; same internal order continues.
       A. DIRECT (disabled by default, per-game flag): processed without the marketplace;
          commission = 0, payment recorded manually by an Executive, same lifecycle and ledger.
```

⚠️ Before enabling mode **A**, check your marketplace's seller terms. Many marketplaces forbid taking customers off-platform.

## 9. Internal order representation

`TM-00018421` is `'TM-' || lpad(seq, 8, '0')` from a Postgres sequence. It's allocated once and never reused.

Core fields (full DDL in §23): `internal_order_id`, `source (MARKETPLACE|MANUAL|DISCORD)`, `marketplace` + `marketplace_order_id` (unique together), `customer_reference` (marketplace username only, the minimum personal data), `game_id`, `game_version_id`, `service_id`, `configuration jsonb` (validated against the service's `requirement_schema`), `quantity`, `currency`, `customer_price`, `marketplace_commission` (+ `commission_is_estimate`), `provider_cost`, `other_costs` / `refunds` (sums of child tables), `final_profit` (computed), `risk_tier`, `assigned_provider_id`, `assigned_staff_id`, `status`, `payment_status`, `provider_payment_status`, `dispute_status`, `deadline_at`, and timestamps for `created`, `validated`, `accepted`, `started`, `delivered` and `completed`. It also stores the Discord IDs of the forum post and order room.

## 10. Order lifecycle (state machine)

```
RECEIVED ─► VALIDATED ─► PROCUREMENT ─► BIDDING ─► BID_REVIEW ─► PROVIDER_SELECTED ─► PROVIDER_CONFIRMED
                                         ▲            │                 │ timeout/decline
                                         └── reopen ──┘                 └──► REASSIGNMENT_REQUIRED ─► BID_REVIEW
PROVIDER_CONFIRMED ─► IN_PROGRESS ─► DELIVERED ─► MARKETPLACE_COMPLETION ─► COMPLETED ─► EARNING_RELEASED

Any non-terminal → MANUAL_REVIEW (and back), CANCELLED, DISPUTED
IN_PROGRESS / DELIVERED → PROVIDER_FAILED → REASSIGNMENT_REQUIRED
DISPUTED → IN_PROGRESS | COMPLETED | REFUNDED | PARTIAL_REFUND
COMPLETED / EARNING_RELEASED → REFUNDED | PARTIAL_REFUND (late refund → ledger reversal)
Terminal: EARNING_RELEASED, CANCELLED, REFUNDED (PARTIAL_REFUND may still complete)
```

This is implemented as a single `transition(order, to, actor, reason)` function in `core`, driven by a table of `{from, to, allowedActors, guards, sideEffects}`. It runs in one transaction with `SELECT … FOR UPDATE` on the order row. Every transition writes to `order_events` and `audit_logs`. An illegal transition throws an error, and no other code updates `orders.status`. Forum tags mirror the state group: *Needs Review, Bidding, Awaiting Provider, In Progress, Delivered, Completed, Problem*.

## 11. Sealed bidding

1. **Eligibility** (a SQL query, not Discord roles). The provider must have an APPROVED capability for the service/version, be ACTIVE (not suspended), have availability AVAILABLE (or BUSY with free capacity if allowed), have active orders below their capacity, meet the level gate for the order's risk tier (§17), and have no conflict flags.
2. **Invite:** one message in each eligible provider's desk thread. It shows the order code, game, service, spec, requirements (redacted to what fulfillment needs), deadline and the bidding window, plus **[Submit bid] [Decline]** buttons. **The customer price and target margin are hidden** (§22).
3. **Bid:** a modal takes the price (decimal, in the order's currency), the ETA (start + duration) and an optional note. The price is validated (> 0, ≤ optional ceiling). The bid is stored and the provider gets an ephemeral receipt. There's one active bid per provider per order (`UNIQUE(order_id, provider_id) WHERE status='ACTIVE'`), and resubmitting replaces the previous bid with an audit entry. Providers can withdraw until the window closes.
4. **Window:** closes at the earliest of the configured duration (per service, for example 10 minutes for currency and 30 for raids), N bids received, or staff clicking *Close bidding*. With zero bids, the window is extended once, then the order goes to REASSIGNMENT_REQUIRED and the manager is alerted.
5. **Sealing:** providers never see the bid count, other bids, or the winning price. Declines are recorded because the acceptance rate is a metric.

## 12. Bid review

The order's forum post (staff-only, per game) is edited in place:

```
ORDER TM-00018421 · WoW Retail · Mythic+ +10 (timed) · EU · deadline 20:00
Customer price €60.00 · Marketplace commission €6.00 · Net before provider €54.00
────────────────────────────────────────────────────────────────────────────
#  Provider  Bid     ETA     Level     Rep  Orders  Compl.  Est. profit  SCORE
1  P-184     €29.00  45 min  Diamond   96   642     99.1%   €25.00       92.9 ★
2  P-448     €31.00  40 min  Platinum  93   391     98.7%   €23.00       89.8
3  P-291     €26.00  60 min  Bronze    73   18      91.0%   €28.00       71.2
Profile: BOOSTING · margin floor 15% ✓ all · risk MEDIUM (staff may assign)
SYSTEM RECOMMENDATION: P-184  (why: +0.23 reliability, +0.59 service expertise vs cheapest)
[Assign recommended] [Select another ▾] [Reopen bidding] [Cancel order]
```

Choosing **Select another** requires a reason (modal) and is logged as `RECOMMENDATION_OVERRIDDEN`. That lets us measure later whether overrides beat the model.

## 13. Provider selection algorithm (Bid Selection Score)

### 13.1 Hard gates (pass/fail, applied before scoring)
- The provider is eligible (§11) and the bid is active.
- **Margin floor:** `(net − bid) / net ≥ min_margin` (default 15%). A bid below the floor is shown but flagged, and only a Manager can pick it.
- **Risk gate:** the level meets the minimum for the order's risk tier: LOW has no minimum, MEDIUM needs Bronze or above, and HIGH needs Gold or above plus Manager approval.
- **Deadline:** if the ETA would miss the deadline, the bid is flagged and only a Manager can pick it.

### 13.2 Normalized components (each in [0, 1])

| Symbol | Component | Formula |
|---|---|---|
| **P** | Price competitiveness | `P = (b_min / b)^k`. `b_min` is the lowest bid that passes the gates and `k` is the price sensitivity (default 2). The ratio makes it independent of order size. |
| **R** | Reliability | `R = GlobalReputation / 100` (§15, already Bayesian-smoothed) |
| **E** | Service expertise | `E = min(1, ln(1+n_s) / ln(1+N_ref)) × (ServiceReputation / 100)`. `n_s` is the number of completed orders of this service and `N_ref` defaults to 100. If `n_s` is 0, game reputation stands in, then global, multiplied by the volume term. |
| **T** | Recent performance | Completion and on-time composite over the last 30 days, Bayesian-smoothed: `(good + m·prior)/(n + m)`, with m = 5 and prior = 0.85 |
| **D** | Delivery confidence | `D = OnTimeRate × sqrt(eta_min / eta)`. `eta_min` is the fastest ETA among bids that pass the gates. |

### 13.3 Score
```
SelectionScore = 100 × (w_P·P + w_R·R + w_E·E + w_T·T + w_D·D)       Σw = 1
```
The weights are stored in `scoring_configurations`, versioned, and chosen by the service's `scoring_profile`:

| Profile | w_P | w_R | w_E | w_T | w_D |
|---|---|---|---|---|---|
| CURRENCY (gold, silver) | .45 | .25 | .10 | .10 | .10 |
| BOOSTING (M+, dungeons, PvP, leveling) | .20 | .30 | .25 | .15 | .10 |
| RAID / HIGH-RISK | .15 | .35 | .25 | .15 | .10 |
| DEFAULT | .30 | .25 | .20 | .15 | .10 |

**Tie-break and fairness:** if the top two scores are within δ = 2.0 points, prefer the provider with fewer assignments in the last 7 days (rotation). Exploration applies on LOW-risk orders only (§17). The score version and every input are stored with the assignment (`order_assignments.score_breakdown jsonb`), so each recommendation can be explained and replayed.

### 13.4 Worked example: TM-00018421, WoW Mythic+ +10, profile BOOSTING

The customer paid €60 and the marketplace commission is €6, so net is €54. The margin floor is 15%, so the maximum bid is €45.90.

| Input | P-184 (Diamond) | P-291 (Bronze) | P-448 (Platinum) |
|---|---|---|---|
| Bid / ETA | €29 / 45 min | €26 / 60 min | €31 / 40 min |
| Global reputation | 96 | 73 | 93 |
| Mythic+ orders completed / service rep | 210 / 97 | 8 / 80 | 95 / 94 |
| 30-day recent composite | 0.97 | 0.84 | 0.99 |
| On-time rate | 0.98 | 0.88 | 0.97 |

Components (b_min = 26, eta_min = 40, k = 2, N_ref = 100):

| | P = (26/b)² | R | E | T | D = OT·√(40/eta) |
|---|---|---|---|---|---|
| P-184 | (0.8966)² = **0.804** | **0.96** | min(1, ln211/ln101=1.16)=1 × 0.97 = **0.970** | **0.97** | 0.98 × 0.943 = **0.924** |
| P-291 | 1² = **1.000** | **0.73** | (ln9/ln101 = 0.476) × 0.80 = **0.381** | **0.84** | 0.88 × 0.816 = **0.719** |
| P-448 | (0.8387)² = **0.703** | **0.93** | (ln96/ln101 = 0.989) × 0.94 = **0.930** | **0.99** | 0.97 × 1 = **0.970** |

BOOSTING weights (.20 / .30 / .25 / .15 / .10):

- **P-184:** 100 × (.20·0.804 + .30·0.96 + .25·0.970 + .15·0.97 + .10·0.924) = 100 × (0.161 + 0.288 + 0.243 + 0.146 + 0.092) = **92.9**
- **P-448:** 100 × (0.141 + 0.279 + 0.232 + 0.149 + 0.097) = **89.8**
- **P-291:** 100 × (0.200 + 0.219 + 0.095 + 0.126 + 0.072) = **71.2**

The recommendation is **P-184 at €29**, giving TheMerchant a profit of €60 − €6 − €29 = **€25**. The cheapest bid (P-291 at €26, €28 profit) loses because it has little Mythic+ track record and weaker reliability. The €3 of extra margin doesn't make up for the higher risk of failure.

**The same bids under the CURRENCY profile** (.45/.25/.10/.10/.10) score P-184 **88.8**, P-448 **83.8** and P-291 **82.6**. Price counts for much more here, so P-291 closes most of the gap. If P-291 had bid €23, it would lead under CURRENCY while still trailing under BOOSTING. That's the intended behavior: price matters more for fungible goods, and reliability matters more for services.

**Expected value check (optional, shown to managers):** `EV = (net − bid) × p_success − failure_cost × (1 − p_success)`, where `p_success` is the Bayesian completion rate. It's used as a sanity check alongside the score, not as a replacement.

## 14. Provider Level (long-term standing)

Levels are evaluated nightly. Promotion requires meeting **all** criteria. Demotion happens only after the provider sits below a threshold minus 5 reputation points for 30 consecutive days (hysteresis), or immediately on suspension-grade flags.

| Level | Completed orders | Tenure | Reputation | Other |
|---|---|---|---|---|
| NEW | 0 | — | — | probation limits (§17) |
| BRONZE | 5 | 7 days | ≥ 70 | no open serious flags |
| SILVER | 25 | 30 days | ≥ 80 | dispute rate ≤ 5% |
| GOLD | 100 | 90 days | ≥ 85 | on-time ≥ 90% |
| PLATINUM | 300 | 180 days | ≥ 90 | dispute rate ≤ 2% |
| DIAMOND | 600 | 365 days | ≥ 93 | active in last 30 days |
| ELITE | 1000 | 365 days | ≥ 95 | Executive confirmation |

Lifetime earnings are **not** a criterion. They're tracked for statistics only. Every level change writes to `provider_level_history` and the audit log. The provider is told in their desk thread, and only they see it.

## 15. Provider Reputation (quality / reliability, 0–100)

Each rate is **Bayesian-smoothed**, `x̂ = (successes + m·prior) / (n + m)`, so a provider with three perfect orders doesn't outrank one with 600 near-perfect orders. Events are **time-decayed**: each order's weight is `0.5^(age_days / 120)`.

```
Reputation = 100 × ( 0.30·CompletionRate
                   + 0.20·OnTimeRate
                   + 0.20·(1 − min(1, 3·DisputeRate))
                   + 0.20·RatingNorm          (customer rating 1–5 → 0–1; prior 0.8)
                   + 0.10·(1 − min(1, 3·FailureRate)) )
Priors: completion 0.90, on-time 0.85, dispute 0.03, failure 0.03, m = 10
```

A new provider starts at about 82 (the priors) and moves toward their real performance as volume builds. Cancellations caused by the customer or marketplace don't count against the provider. Cancellations and timeouts the provider caused count as failures. Tracked counters include lifetime, completed, failed, cancelled (by cause), disputed and refund-associated orders, average rating, average fulfillment time and on-time rate.

## 16. Service-specific reputation

The same formula runs on the subset of orders for a game (`provider_game_stats`) and for a service (`provider_service_stats`). Stats are recomputed incrementally on each terminal order event and fully each night.

A specific reputation is used only when there are at least 5 orders in that game or service. Below that, the value falls back service → game → global, and the volume term in **E** discounts it automatically.

## 17. Provider fairness mechanism

- **Trial orders:** services flagged `trial_eligible` (LOW risk, low value) are the only ones NEW providers can win during probation (first 5 completed orders), with a maximum of 1 active order.
- **Exploration:** on LOW-risk orders, with probability ε (default 10%), the recommendation goes to the best-scoring provider with fewer than 10 completed orders in that service. This happens only if that provider passes every hard gate and scores within 15 points of the top. It's marked "EXPLORATION" in the review UI, and staff can override it.
- **Rotation:** near-ties (δ ≤ 2 points) go to the provider with fewer recent assignments.
- **Capacity caps:** a per-level maximum on concurrent orders (NEW 1, BRONZE 2, SILVER 3, GOLD+ configurable) stops the top providers taking everything.
- **Safety wins:** MEDIUM and HIGH risk tiers disable exploration, and HIGH also requires Gold or above.

## 18. Accounting model (TheMerchant's own books)

```
TheMerchant Profit = customer_price − marketplace_commission − provider_cost − Σ refunds − Σ other_costs
```

- **Money:** Postgres `NUMERIC(14,2)` with `currency CHAR(3)` (EUR in v1). In code, amounts are handled as integer minor units (cents, `bigint`) or through a decimal library. Floats are never used. Rounding is half-even, and happens only at defined points (commission calculation).
- **Commission:** the actual amount from the marketplace when provided. Otherwise it's calculated from `marketplace_fee_rules` (rate by game/service/date) and flagged `commission_is_estimate` until confirmed.
- **Provider cost:** set from the accepted bid when the provider confirms. It can only be changed by a Manager or Executive, with a reason, and the change is audited.
- **Other costs:** `order_costs` rows (type, amount, note), for example a replacement provider or a goodwill bonus.
- **Refunds:** `refunds` rows (full or partial, `liability = MERCHANT|PROVIDER|SPLIT`). If the provider is liable, a `REFUND_REVERSAL` ledger entry follows.
- **Recognition:** profit counts in reports once an order reaches COMPLETED. Earlier orders appear as "in flight". A snapshot of the numbers is stored at completion, and later refunds or costs are added as dated adjustments. That way past reports can be reproduced and the current state is still correct.

## 19. Provider ledger

It's append-only and **no row is ever updated or deleted**. The database role used by the app has no UPDATE or DELETE on this table, and a trigger enforces it.

```
provider_ledger_entries(id, provider_id, entry_type, bucket, amount (signed), currency,
                        order_id?, payout_id?, reverses_entry_id?, memo, created_by, created_at)
entry_type: ORDER_EARNING | PAYOUT | REFUND_REVERSAL | ADJUSTMENT | BONUS | CORRECTION | TRANSFER
bucket:     PENDING | AVAILABLE | RESERVED | PAID
```

- **Order COMPLETED:** `ORDER_EARNING +29.00 → PENDING`.
- **Hold period ends** (default 3 days, per service, which covers the marketplace dispute window): a pair of `TRANSFER` entries, `−29.00 PENDING` and `+29.00 AVAILABLE`, written in one transaction.
- **Payout requested:** `AVAILABLE → RESERVED`, recorded as a pair. An Executive approves in #finance. When paid, `RESERVED → PAID` with a `PAYOUT` record holding the method and external reference.
- **Late refund where the provider is liable:** a `REFUND_REVERSAL` taken from AVAILABLE, or PENDING if not yet released. It can push AVAILABLE negative, and the debt is settled against future earnings.
- **Balances:** `SUM(amount) GROUP BY bucket`. **Lifetime earnings** are `Σ ORDER_EARNING + BONUS − REFUND_REVERSAL`. A `provider_balances` cache is updated in the same transaction as each entry and checked against the sums nightly. Any mismatch alerts #system-alerts.

## 20. Executive reporting

Scheduled jobs post to #exec-reports: **daily** at 08:00, **weekly** on Monday and **monthly** on the 1st, in your timezone (Q9). There's also `/report range:<from>..<to>` on demand, answered ephemerally. Reports are built from SQL views over `orders`, `refunds`, `order_costs`, `provider_ledger_entries` and `order_events`.

- **Financial:** orders, gross customer sales, marketplace commission, net marketplace revenue, provider costs, refunds, other costs, **profit**, **margin %**, outstanding provider balances (pending, available, reserved), payouts, average order value, average provider cost, and revenue and profit by game and by service.
- **Operational:** active providers, orders awaiting a provider, average bids per order, average procurement time (validated → confirmed), provider acceptance rate, disputes, cancellations, provider failures, and the override rate on recommendations.
- **Format:** an embed summary plus an attached CSV for detail.

## 21. Manager dashboards

`#<game>-dashboard` holds one message that the bot edits every 60 seconds, and immediately on state changes, debounced.

```
WOW OPERATIONS · updated 14:32
Active 37 · Needs review 2 · Bidding 5 · Awaiting provider confirm 1 · In progress 24 · Delivered 5
At risk (deadline < 2h or no bids) 3  → TM-…421, TM-…433, TM-…440
Disputes open 1 · Providers available 18/42 · Capacity free 31
Today: completed 12 · avg procurement 9m · acceptance 64% · staff actions 88
```

Managers get `/dashboard game:<wow>` for provider performance tables (per provider: orders, completion, on-time, disputes, reputation, level) and staff activity. The responses are ephemeral and limited to the manager's games. Revenue and profit **per game** are visible to that game's managers. Global financials are for Executives only (Q-list).

## 22. Staff workflow

1. A new forum post appears in #wow-orders (tag *Bidding*, or *Needs Review* if classification failed).
2. For *Needs Review*, staff use [Classify] (selects) and [Confirm details], and the order moves to VALIDATED and then procurement.
3. Bids appear on the post live, and the score table appears when the window closes.
4. [Assign recommended] or [Select another] with a reason. A HIGH-risk order shows [Request manager approval].
5. The provider confirms, and the bot creates the private order room with the provider and assigned staff, posting the fulfillment brief (requirements only).
6. Staff monitor the order and relay customer messages (they choose what to forward). [Mark delivered] needs the provider's delivery note or proof.
7. The marketplace completion event arrives (or staff record it before API access), and the order moves to COMPLETED. The ledger entry is written, the room is archived and the forum post is closed.
8. Problems: [Report issue], [Provider failed] (leads to reassignment), and [Escalate] (pings the game's manager).

Staff use slash commands (`/order find`, `/order import`, `/order note`) and ephemeral responses throughout.

## 23. Database schema (PostgreSQL 16)

These are the key tables with their constraints. The full migration files come in Phase 2–5. Every table has `created_at timestamptz default now()`, and mutable tables also have `updated_at`.

```sql
-- identity & org
users(id uuid pk, display_name, org_role text check (org_role in ('EXECUTIVE','MANAGER','STAFF','PROVIDER','CUSTOMER')),
      status text default 'ACTIVE', ...)
discord_identities(user_id fk users, discord_user_id text unique not null, username, linked_at)
staff_profiles(user_id pk fk), manager_profiles(user_id pk fk, approval_limit numeric(14,2))
staff_game_assignments(user_id fk, game_id fk, primary key(user_id, game_id))
manager_game_assignments(user_id fk, game_id fk, primary key(user_id, game_id))
permissions_overrides(user_id fk, permission text, game_id fk null, granted_by, expires_at)   -- "explicitly elevated"

-- catalog
games(id, code text unique, name, active bool)
game_versions(id, game_id fk, code, name, unique(game_id, code))
service_categories(id, game_id fk, code, name, unique(game_id, code))
services(id, category_id fk, code, name, kind text check (kind in ('SERVICE','CURRENCY')),
         pricing_unit, scoring_profile, risk_tier, trial_eligible bool, bid_window_seconds int,
         hold_days int, requirement_schema jsonb, active bool)
marketplace_listing_map(marketplace, external_listing_id, service_id fk, game_version_id fk,
         quantity_rule jsonb, primary key(marketplace, external_listing_id))
marketplace_fee_rules(id, marketplace, game_id null, service_id null, rate numeric(6,4), valid_from, valid_to)
discord_bindings(game_id pk fk, orders_forum_id, order_rooms_channel_id, team_role_id, provider_role_id)

-- providers
providers(id uuid pk, user_id fk unique, code text unique,            -- 'P-184'
          status text check (status in ('APPLICANT','ACTIVE','PAUSED','SUSPENDED','OFFBOARDED')),
          level text not null default 'NEW', reputation numeric(5,2), max_concurrent int,
          desk_thread_id text, payout_details_enc bytea)
provider_applications(id, provider_id fk, answers jsonb, rules_version, status, reviewed_by, reviewed_at)
provider_capabilities(id, provider_id fk, service_id fk null, category_id fk null, game_version_id fk null,
          status text check (status in ('PENDING','APPROVED','REVOKED')), approved_by fk users, approved_at,
          check (service_id is not null or category_id is not null))
provider_availability(provider_id pk fk, state text check (state in ('AVAILABLE','BUSY','OFFLINE','PAUSED')),
          capacity int, changed_at)
provider_game_stats / provider_service_stats(provider_id, game_id|service_id, completed, failed, cancelled_by_provider,
          disputed, refunded, rating_sum, rating_n, on_time, fulfill_seconds_sum, reputation numeric(5,2),
          primary key(provider_id, game_id|service_id))
provider_reputation(provider_id pk, global numeric(5,2), components jsonb, computed_at)
provider_level_history(id, provider_id fk, from_level, to_level, reason, actor, created_at)
provider_flags(id, provider_id fk, type, severity, note, created_by, resolved_at)

-- orders
create sequence tm_order_seq;
orders(id uuid pk, internal_order_id text unique not null,
       source text check (source in ('MARKETPLACE','MANUAL','DISCORD')),
       marketplace text, marketplace_order_id text, customer_reference text,
       game_id fk, game_version_id fk, service_id fk, configuration jsonb, quantity numeric(14,4),
       currency char(3) not null default 'EUR',
       customer_price numeric(14,2) check (customer_price >= 0),
       marketplace_commission numeric(14,2) check (marketplace_commission >= 0), commission_is_estimate bool,
       provider_cost numeric(14,2), risk_tier text, deadline_at timestamptz,
       status text not null, payment_status text, provider_payment_status text, dispute_status text,
       assigned_provider_id fk providers null, assigned_staff_id fk users null,
       forum_post_id text, order_room_thread_id text, external_updated_at timestamptz,
       accepted_at, started_at, delivered_at, completed_at, version int not null default 0,
       unique (marketplace, marketplace_order_id))
create index on orders (game_id, status); create index on orders (assigned_provider_id, status);
create index on orders (completed_at);
order_events(id bigserial, order_id fk, from_status, to_status, actor_user_id, actor_kind, reason, payload jsonb, created_at)
order_costs(id, order_id fk, type, amount numeric(14,2), note, created_by)
refunds(id, order_id fk, amount numeric(14,2) check (amount > 0), kind text, liability text, external_ref, created_by)
disputes(id, order_id fk, status, opened_at, resolved_at, outcome, notes)
reviews(id, order_id fk unique, rating smallint check (rating between 1 and 5), comment, source)
quotes(id, code text unique, customer_user_id fk, service_id fk, spec jsonb, quoted_price, mode text, order_id fk null)

-- bidding & assignment
provider_bids(id uuid pk, order_id fk, provider_id fk, amount numeric(14,2) check (amount > 0),
       eta_start_min int, eta_duration_min int, note text,
       status text check (status in ('ACTIVE','WITHDRAWN','REPLACED','WON','LOST','EXPIRED')), created_at)
create unique index one_active_bid on provider_bids(order_id, provider_id) where status = 'ACTIVE';
bid_invitations(order_id fk, provider_id fk, sent_at, response text, primary key(order_id, provider_id))
order_assignments(id, order_id fk, provider_id fk, bid_id fk, recommended_provider_id fk, overridden bool,
       override_reason, score_breakdown jsonb, scoring_config_id fk, assigned_by fk, confirm_deadline_at,
       status text check (status in ('PENDING_CONFIRM','CONFIRMED','EXPIRED','DECLINED','FAILED','COMPLETED')))
scoring_configurations(id, profile, version, weights jsonb, params jsonb, active bool, created_by,
       unique(profile, version))

-- money
provider_ledger_entries(id bigserial pk, provider_id fk, entry_type text, bucket text, amount numeric(14,2) not null,
       currency char(3), order_id fk null, payout_id fk null, reverses_entry_id fk null, memo, created_by, created_at)
provider_balances(provider_id pk, pending, available, reserved, paid, lifetime numeric(14,2), updated_at)  -- cache
provider_payouts(id, provider_id fk, amount, currency, status, method, external_ref, requested_at, approved_by, paid_at)

-- integration & audit
integration_events(id bigserial, source text, external_event_id text, event_type, order_ref text,
       payload jsonb, received_at, processed_at, status, error, unique(source, external_event_id))
audit_logs(id bigserial, at timestamptz, actor_user_id, actor_kind text,     -- WHO
       action text, object_type text, object_id text,                        -- WHAT / OBJECT
       old_value jsonb, new_value jsonb, reason text, source text,           -- OLD/NEW/REASON/SOURCE
       request_id text)
system_settings(key text pk, value jsonb, updated_by, updated_at)
```

## 24. Discord bot architecture (TheMerchant)

**Stack:** Node.js 20+, TypeScript, **discord.js v14**, **PostgreSQL** with Drizzle ORM and plain SQL migrations, **Fastify** for webhooks and health checks, **pg-boss** (a Postgres-backed job queue, so there's no Redis to run), Zod for validation, pino for logging and Vitest for tests.

```
merchant/                         (new folder in this repo; ClaudeBot tooling stays at root)
├── apps/
│   ├── bot/        discord.js gateway: interaction router, component handlers, presenters
│   ├── api/        Fastify: POST /webhooks/:marketplace, GET /health
│   └── worker/     pg-boss jobs: bid windows, confirm timeouts, hold releases, reports,
│                   reputation/level recompute, dashboard refresh, reconciliation
├── packages/
│   ├── core/       domain logic, **no Discord or HTTP imports**: order state machine, eligibility,
│   │               scoring, bidding, accounting, ledger, reputation, levels, authz policy
│   ├── db/         schema, migrations, repositories, transactions
│   ├── marketplace/ adapter interface + implementations (Manual, <YourMarketplace>)
│   └── discord-ui/ embed/component builders, custom_id codec, i18n strings
└── test/           unit, integration (real Postgres), contract fixtures, e2e simulations
```

In v1, all three apps can run in **one process** for simplicity and be split later. Core rules for the code:

- Every interaction is **deferred within 3 seconds**, then calls a `core` command with `actor = resolveActor(discordUserId)`.
- **`authz.can(actor, action, resource)`** runs inside `core`, so the Discord layer can't skip it.
- Component `custom_id`s carry only an opaque ID. The server reloads state and never trusts client data.
- Discord side effects (posts, threads, role changes) run **after commit** through an outbox table and a job. If Discord is down or rate-limited, the database stays correct and the job retries.
- The gateway uses the Guilds and Guild Members intents. It **does not need Message Content**, because everything goes through interactions.

## 25. Marketplace integration architecture

```
Existing Marketplace ⇄ MarketplaceAdapter ⇄ Operations Core ⇄ Discord bot
```

```ts
interface MarketplaceAdapter {
  readonly name: string;
  readonly capabilities: { webhooks: boolean; pullOrders: boolean; markDelivered: boolean;
                           sendMessage: boolean; commissionInPayload: boolean };
  verifyWebhook(headers: Headers, rawBody: Buffer): boolean;         // HMAC + timestamp window
  normalize(rawBody: unknown): MarketplaceEvent[];                    // → ORDER_CREATED | PAYMENT_CONFIRMED |
                                                                      //   CUSTOMER_MESSAGE | ORDER_UPDATED | ORDER_CANCELLED |
                                                                      //   REFUND | DISPUTE_OPENED | DISPUTE_RESOLVED | ORDER_COMPLETED
  fetchOrder(externalOrderId: string): Promise<ExternalOrder>;        // reconcile / manual import
  listOrdersSince?(since: Date): Promise<ExternalOrder[]>;            // polling fallback
  markDelivered?(externalOrderId: string, note: string): Promise<void>;
  sendCustomerMessage?(externalOrderId: string, text: string): Promise<void>;
}
```

- Only the adapter knows the marketplace's field names, URLs and auth. The core sees normalized events and never touches marketplace code.
- There are three layers of idempotency: `integration_events.unique(source, external_event_id)` (or a hash of the payload when there's no event ID), `orders.unique(marketplace, marketplace_order_id)`, and state-machine guards, so repeating a transition is a no-op.
- **Reconciliation job:** every 15 minutes it runs `listOrdersSince` or `fetchOrder` on open orders to catch missed webhooks.
- Outbound calls (such as `markDelivered`) use the outbox with retries and backoff, and each carries an idempotency key when the marketplace supports one.

## 26. Security model

- **Least privilege in Discord.** No Administrator anywhere. TheMerchant gets View Channels, Send Messages, Send in Threads, Create Private Threads, Manage Threads, Embed Links, Attach Files, Read Message History, Manage Messages (pins, cleanup), Manage Roles (only for roles below it) and Moderate Members. It doesn't get Manage Channels or Manage Server, which stay with ClaudeBot.
- **Authorization in the backend.** Every sensitive action is checked against the database's org role, game assignments, capabilities and overrides, and denials are audited. Role drift is reconciled.
- **Isolation.** §6. Providers are never shown the customer price, margin, other bids, customer identity or other providers.
- **Customer data minimization.** Only the marketplace username, plus whatever fulfillment actually needs, is stored. **Account credentials for piloted services must never be posted in Discord.** Use the marketplace's secure delivery, or an encrypted field with a one-time, logged reveal to the assigned provider (Q7).
- **Secrets.** `DISCORD_TOKEN` (ClaudeBot), `MERCHANT_DISCORD_TOKEN`, `DATABASE_URL`, `MARKETPLACE_API_KEY`, `MARKETPLACE_WEBHOOK_SECRET` and `PAYOUT_ENC_KEY` live in the host's secret store or a gitignored `.env`. They're never kept in Discord, git or logs, and pino redacts them.
- **Database.** A separate application role with no DDL rights, no UPDATE or DELETE on `audit_logs` or `provider_ledger_entries`, TLS connections and daily backups with point-in-time recovery.
- **Webhooks.** HMAC signature, a replay window (5 minutes), a body size limit, a rate limit, and raw payloads stored for forensics.
- **Abuse controls.** Bid rate limits, a minimum account age for applicants, automatic flags for bid shading (a provider always bidding just under others is impossible to see, but repeated withdraw/resubmit patterns get flagged), and suspension freezes both bidding and payouts.

## 27. Audit model

Each `audit_logs` row records **who** (user, or `SYSTEM`/`MARKETPLACE`), **what** (action), **when**, the **object**, the **old and new values**, the **reason** (mandatory for overrides, price or cost edits, adjustments and suspensions) and the **source** (`DISCORD`, `WEBHOOK`, `JOB`, `CLAUDEBOT`). Logged actions include:

- Order imported or created
- Bid submitted, replaced or withdrawn
- Provider selected, recommendation overridden, confirmation, reassignment, provider failure
- Price, provider cost or commission change
- Refund, payout, balance adjustment
- Capability, level or suspension change
- Every manager and staff action that changes state

High-importance actions are mirrored to #audit-log. The table is append-only and partitioned by month when it gets large. ClaudeBot's structural changes continue to go to `CHANGELOG.md`.

## 28. Scalability strategy

- **Discord limits we design around:** 500 channels per server (we use about 40, and orders never create channels), **1,000 active threads per server** (order rooms and forum posts are archived when they finish, and desk threads auto-archive after 7 days idle and reopen when the bot posts), 25 options per select menu (paged), 5 fields per modal (split into steps), and replying to interactions within 3 seconds (deferred). Rate limits are handled centrally by discord.js, and the outbox paces bulk sends such as opportunity fan-out.
- **Fan-out:** one invitation per eligible provider, each in its own thread. Per-channel limits don't collide, and the global limit (about 50 requests per second) is paced by a job. When there are more than 200 eligible providers, the bot invites the top N by pre-score in waves.
- **Database:** indexes on every hot path. `order_events`, `audit_logs` and `integration_events` are partitioned by month once they pass about 10 million rows. Reports read from views, and materialized views are refreshed nightly if needed.
- **Process:** stateless bot, API and worker. The job queue lives in Postgres, so there's one moving part. There's a single server, so no gateway sharding is needed.
- **Configuration-driven growth:** a new game is catalog rows plus one ClaudeBot config block.

## 29. Testing strategy

- **Unit (core):** state-machine transitions (every allowed and forbidden edge), scoring (including the §13.4 example as a fixed test), reputation and level math, money arithmetic (no floats; rounding cases), and ledger invariants (sum of buckets = lifetime − paid out …).
- **Authorization matrix tests:** table-driven, every role × action × game-assigned-or-not, generated from §3. A provider trying to read another provider's anything must fail.
- **Integration:** real Postgres (container or a Supabase branch) covering constraints, concurrency (two staff assigning at once: one succeeds), duplicate webhook delivery (exactly one order), out-of-order events, and outbox retry.
- **Adapter contract tests:** recorded marketplace payloads as fixtures, plus signature verification.
- **Discord layer:** handlers tested with mocked interactions. Then a **staging server** (a second, private Discord server) where an e2e script walks an order from import to earning release.
- **Structure:** ClaudeBot's `npm test` (fake Discord API) already covers structural sync, and gets extended for forum channels and Community settings.
- **CI:** GitHub Actions runs lint, typecheck, unit and integration tests on every PR.

## 30. Implementation roadmap

| Phase | Deliverable | Built by | Done when |
|---|---|---|---|
| 1 | Discord architecture: Community on, tree from §1 | ClaudeBot (config → dry run → your OK → apply) | inspect matches config |
| 2 | Roles + permission overwrites (§2–3); @everyone tightened (gated); TheMerchant app created and invited | ClaudeBot + you (Developer Portal) | permission audit script passes |
| 3 | Merchant skeleton + DB + provider onboarding (§5), desk threads | TheMerchant | applicant → approved provider end-to-end on staging |
| 4 | Game/service catalog + seed taxonomy (§4), capability management | TheMerchant | new game addable with no code change |
| 5 | Internal order model + state machine + audit (§9–10, §27) | core/db | state machine test suite green |
| 6 | Manual marketplace order import (`/order import`), forum posts | TheMerchant | staff can run an order to COMPLETED manually |
| 7 | Sealed bidding (§11) | TheMerchant | isolation tests green |
| 8 | Assisted selection + scoring (§12–13, §17) | core | worked example reproduced; override logging |
| 9 | Fulfillment workflow: order rooms, confirm timeouts, reassignment | TheMerchant | failure/reassign paths tested |
| 10 | Ledger + accounting + payouts (§18–19) | core | ledger invariants + reconciliation job |
| 11 | Reputation + levels (§14–16) | worker | nightly recompute, history |
| 12 | Executive reports + manager dashboards (§20–21) | worker | daily report posted on staging |
| 13 | Marketplace adapter for your marketplace (§25) | marketplace pkg | contract tests on real fixtures |
| 14 | Automatic ingestion + reconciliation | api/worker | duplicate-delivery test; missed-webhook recovery |
| 15 | AUTOMATIC assignment for low-risk orders | core | enabled per service after data review |

Each phase ships as working code with tests, a permission review, a security review, a scalability note, and updates to this document.

## Decisions

Answers from the owner (2026-09-28/29). "Default, unconfirmed" means the proposal's suggestion was built and the owner hasn't explicitly answered yet.

| # | Decision | Status |
|---|---|---|
| Q1 | Server tree, roles, Community | **Approved** (plan approved and applied 2026-09-29). Built with Executive, Manager and Staff placed above TheMerchant, so the bot can't hand those roles out. |
| Q2 | Provider identity visibility | **Approved:** business data fully isolated; Provider roles not hoisted and uncoloured. |
| Q3 | Hide customer price and margin from providers | **Approved: yes.** |
| Q4 | Direct-order modes | **Approved:** redirect + convert on, direct-in-Discord off until MyGold.gg's seller terms are checked. |
| Q5 | Refund liability and hold period | **Approved:** liability decided per refund; 3-day hold. |
| Q6 | Currency | Default, unconfirmed: EUR only in v1. |
| Q7 | Account credentials never in Discord | Default, unconfirmed (built that way). |
| Q8 | Marketplace | **MyGold.gg.** API/webhook details to follow; manual import until then. |
| Q9 | Report timezone | Default, unconfirmed: Europe/Madrid (the `timezone` setting). |
| Q10 | Hosting | **Database: Supabase project "TheMerchant"** (`gkfqbthkfwefubfzlqxk`, eu-west-1, own organization, free tier). It is migrated (001–004) and seeded as of 2026-09-29. The always-on bot host is still to choose. |
| Q11 | Code location | Default, unconfirmed: `merchant/` in this repo. |
| Q12 | Managers see per-game revenue/profit | Default, unconfirmed: yes, for their games. |
| Q13 | Administrator on ClaudeBot | **Owner restored Administrator on 2026-09-29** to simplify setup. Recommended: remove it again once setup settles. |
