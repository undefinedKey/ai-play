# v0.14 adventure contract

Implementation contract, 2026-10-31; baseline v0.13.0. The companion Chinese goal prompt defines product intent. This file fixes shared names and boundaries before parallel implementation.

## Exploration

Action `adventure_event {event_id, choice_id}`. Public/self path `adventure.encounter` (nullable); fields `event_id, template_id, zone_id, position, status, found_at, expires_at, choices, selected_choice_id, resolved_at, public_result`. Status `pending | resolved | declined | expired | interrupted`. Keep one current/last record only. Private source run/epoch are never projected.

Three templates: `supply_cache` (forest/ruins; `wood`: 4 energy -> 2 wood; `ore`: 4 energy -> 1 ore), `wild_garden` (forest; `turnip`: 3 energy -> 2 turnip; `seed`: 2 energy -> 1 wheat_seed), `spring` (forest/ruins; `heal`: +12 HP; `refresh`: +15 energy). Every template also offers `decline`, no cost/reward. A full relevant stat rejects without consuming the event. Catalog choice fields: `choice_id,name,energy_cost,items,heal,restore_energy`; public choices describe fixed rules, never private affordability.

On a successful non-camp exploration arrival, end movement plan and create an encounter if global discovery cooldown permits. Select a location-compatible template without model calls. Pending lifetime **150 seconds**, absolute, protected from monster aggro/damage while awaiting choice. Global per-role discovery cooldown **300 seconds from creation** (also bounds alternating-zone protection); persist on decline/expiry/restart. Use `adventure.discovery_ready_at` and publish both timers/rules. Repeated explore must not refresh either deadline.

Pending allows say/wait and inventory use plus goal management; manual move/new adventure work/hunt returns `ENCOUNTER_PENDING` without cancelling. `adventure_plan stop/retreat` may explicitly interrupt for safety; no action starts retreat automatically. Life/game/activity/group operations cannot silently invalidate a pending choice. Explicit pause/recall/lease loss/session change/restart interrupts. Skill must surface this constraint and offer decline. Choice validates ID, owner/run/epoch, active permission, deadline/location and costs; economic change exactly once under existing transactional action receipts. On resolution protection ends. Global cooldown prevents re-roll/immune loops. No offline rewards.

Public event types `exploration_found`, `exploration_resolved`, `exploration_ended`; include actor, event/template/zone/position/status, selected choice and concise real result as appropriate. Public result records actual changes of this action, not private balances.

## Strategy equipment

Add items/recipes:

| ID | Name | Ingredients | Effect |
|---|---|---|---|
| hunter_bow | 猎弓 | wood 5, ore 1 | attack bonus 1, range 3, interval 2000 ms, attack energy 2 |
| heavy_hammer | 重锤 | wood 3, ore 5 | attack bonus 8, range 1, interval 2000 ms, attack energy 5 |
| heavy_armor | 重型护甲 | wood 2, ore 8 | defense 5, extra attack interval 1000 ms, movement energy multiplier 2 |

Old equipment default range 1, interval 1000 ms, attack energy 3, movement multiplier 1, old bonuses unchanged. Weapons slot `weapon`, heavy armor existing armor slot. Publish effective `life.stats`: retain existing keys plus `range, attack_interval_ms, attack_energy, move_energy_per_tile`; `attack` remains compatible existing bonus unless a new separately named final damage is needed. Do not silently redefine existing fields. Apply damage/fatigue once. Publish item modifiers for comparisons.

One derived combat/movement calculation shared by server actions and plans. Preserve private `next_attack_at` across plan resets, equip and restart; no catch-up attacks. Reward eligibility uses actual contribution and legal attack range; no shooting from safe camp. Minimum energy checks use derived per-hit cost. New recipes available at existing crafting place. No new resource type required.

## AI-published short goal

Action `personal_goal {intent:'set'|'confirm'|'cancel',kind?,target_id?,target_count?,duration_seconds?,title?}`. `set` replaces any prior goal with a fresh ID (explicit revise); count integer 1..10; duration 300..1800, default 900 seconds, clipped to existing run authorization deadline. Title optional <=60 Unicode characters, explicitly public, never copied from ownerGoal. Reject irrelevant/unknown fields.

Kinds `collect_item` (wood/ore/turnip/wheat/seeds, actual positive acquisitions after set), `cook_item` (turnip_soup/wheat_bread, successful craft), `resolve_exploration` (forest/ruins, successful non-decline choice), `defeat_monster` (catalog monster ID, actual eligible reward). Rules expose allowed kinds/targets/count/deadlines and action examples. No goal reward or action automation.

Public/self top-level `personal_goal` nullable: `goal_id,kind,target_id,target_count,progress,title,status,created_at,updated_at,expires_at,review_reason`. Status `active|needs_review|completed|cancelled|expired`. Store one record, no history. Progress from successful real events after creation, never from current inventory, failed actions, duplicate receipts or older events. It is fine to use central economic-delta hooks if transactional and same-source dedup is bounded.

Pause, lease loss, epoch/run change, restart -> unfinished active becomes needs_review. No progress until original AI confirms using current goal ID (add required `goal_id` to confirm/cancel for stale response protection). Deadline does not extend; expiry wins. Completed/cancelled remain terminal. Finishing a goal does not stop or start a plan. Public event types `personal_goal_set`, `personal_goal_progress`, `personal_goal_ended`, `personal_goal_review`; whitelist only public fields.

## Cross-layer version and capabilities

App/Skill 0.14.0; rules version `0.14.0-adventure`. Protocol compatibility versions unchanged unless necessary. Expand capability-array schema limit uniformly to **16**. Keep existing twelve; new flags `exploration_events`, `strategic_equipment`, `personal_goals` (15 total). New bridge advertises each only when actual matching rules/actions are present; old server remains twelve. Health exposes three booleans. Rule catalog exposes limit16. New action types must reach MCP schema, action catalog, runtime validation, dsh compact prompt, suggestions, public projection, docs and fixtures.

Goal fields and pending choices get compact projection; preserve danger, full bounded ownerGoal/message, food, receipts, <=2000 UTF-16 dsh budget. Do not silently discard pending event batches when dropping an obsolete model decision. Pending encounter wait must wake on its new event/status/expiry, not use an infinite wait.

## Ownership and implementation sequence

1. Prompt and this contract first (complete); then implementation.
2. Server agent owns server modules except index.js; server tests/contracts schema docs. Runtime agent owns skills and their tests/docs. UI agent owns src, art, public/pixel-world, pixel scripts/browser tests. Root owns index.js version, package lock/version, HTTP integration, load scenario, reports, release.
3. Review integration before full tests. Run real HTTP/bridge/browser checks and a thirty-minute isolated 5-controller/20-viewer load on final server candidate; preserve original production role pause/identity/config/budgets. GitHub, deploy, full Skill upgrade and actual health/UI/data checks close the goal.
