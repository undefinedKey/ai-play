# v0.16 shared contract

Written before implementation against clean `60d813e` (v0.15.0). Product acceptance: [目标提示词](v0.16目标提示词.md). Preserve AI autonomy, existing grant/budget/identity, all v0.15 invariants and two local goal patch anchors. Coordinate cross-owner changes; do not rewrite another agent's files.

## Timings and slow decisions

Export `GAME_TIMING` from server/games.js: `{invitation_seconds:150,registration_seconds:150,turn_seconds:150}`. Keep compatibility rules fields `invitation_seconds` and `game.registration_seconds/turn_seconds`; add same actual registration/turn values to each game catalog entry. A proposed game stores a copy in `game.timing`; start/next turn/RPS round use that copy. Public `game.timing` is safe and scalar-whitelisted, `deadline` remains the actual absolute deadline. Existing saved unfinished games still end on restart; never silently resume/rebase deadlines. Group invitations remain fixed, and identical group/from/target pending invitations cannot stack while still valid. Existing cooldown remains independent. No auto-accept or forced next activity.

Answer-required solo activities (solo_game/riddle/sequence) last 150 seconds. Treasure lasts 900 seconds total with each newly drawn target on-map, distinct from current cell, Manhattan distance <=6 from the current position; three explicit collections and ordinary <=3 movement remain. Keep read/watch/relax durations. Expose actual catalog durations; no hidden client timing values.

Runtime must allow 40–60 second original model replies in BOTH dsh-pet and direct-model modes, including bounded format correction. Use explicit finite timeouts (target: <=10-second host preflight +75-second model phase, with whole decision watchdog sufficient for at most two bounded attempts, <=180 seconds); adapt exact mechanics if needed and document them. Request timeouts do not extend game/grant deadlines. Stop/pause/expiry/session changes still cancel/discard old answers, and each actual retry reserves budget. The existing independent event polling maintains the45-second lease; do not enlarge it to hide failed polling. Any remaining game deadline may legitimately expire during multiple slow requests, yielding STALE_TURN without rewriting IDs.

All model prompt paths show compact remaining seconds derived from `server_time` and absolute game/invitation deadlines, including v0.15 cooperation/long-story fallbacks. Keep <=2000 UTF-16 and original owner/message/threat/exit content. Preserve wait/no-turn/already-submitted no-spin behavior. Skill references remove obsolete enforced-break guidance. Report version0.16.0; do not invent a seventeenth capability. The existing16 remain, conditional on actual supported rules. History is a public read feature, not a new autonomous action.

## Durable public history

Add `server/history.js`, atomically stored inside existing world_state: `history:{version:1,archive_id,started_at,next_sequence,revision,entries}`. Rollback of a failed act includes the archive; event recorder never calls save separately. Bounded rows, no recursive event emission. Existing accepted command/settlement persistence and ordinary deferred checkpoints remain.

Retain at most3584 non-cooperation entries plus512 accepted-cooperation terminal entries, each for at most30days (max4096 total). Separate quota prevents chat from immediately wiping joint outcomes. This is a maximum, not a promise to retain every event for30days. Prune only at defined mutation/startup/periodic maintenance boundaries, not on every public read. Keep sequence monotonic despite pruning. No archive on every SSE frame, receipt, or model observation; only small metadata is added to snapshots.

Entry exact common shape:

```
{entry_id,sequence,occurred_at,category,type,
 actors:[{agent_id,name}],source:{kind,id,event_id?},
 summary,outcome,details}
```

- category enum `speech|activity|game|exploration|life|goal|cooperation`.
- type is the exact original public event type; entry_id stable within archive, sequence safe positive integer; order descending sequence (actual occurred_at displayed, never fabricated).
- source.kind `event|legacy_cooperation`; source.id stable unique key. For event source keep original event_id, deduplicate. Legacy cooperation source identifies exact existing terminal agreement; do not double-import it if its final event is available.
- actors are the actual public participants/actors; use event names where available, otherwise known immutable role names, with explicit unknown fallback. No owner IDs, controller bindings, invitation targets or raw private recipients.
- summary is deterministic factual UI text from allowed outcome; no invented emotions, motivation, relationships or AI-authored narration.
- outcome enum `recorded|completed|cancelled|interrupted|expired|ended`; details is a TYPE-SPECIFIC strict projection, never arbitrary raw payload spread. Store enough to render original full public speech, completed game scores/story/words/revealed rounds and terminal accepted cooperation members/progress/public_result after live records disappear.

Whitelist actual public speech (`message` with nearby/group), activity_finished, game_finished, exploration_resolved/exploration_ended, selected successful life events (gather_finished/traded/harvested/crafted/equipped/tool_upgraded; tool repairs and consumption may also be factual if bounded), personal_goal_ended, and accepted cooperation_completed/cooperation_ended. No movement/per-hit/heartbeat noise, private messages, private control reasons, proposals, unaccepted/refused invitations or hidden RPS choices. Preserve cancellation/interruption distinction; an ended activity is not automatically successful. Coop requires two actual accepted members; every accepted member is indexed. Game actor list includes real contributors who left after contributing (e.g. scores/story authors), not declined registration targets. Game full details only from matching known game state; an old sparse final event may yield a truthful limited summary, not invented missing story.

Legacy import: initialize once using currently retained, strictly projected public source events and existing terminal accepted cooperation snapshots only. Preserve original event/end timestamps, mark import metadata; never invent missing older history. No backfill of ongoing work as completion. Repeated startup is idempotent. The public metadata distinguishes archive creation date from earliest imported source. Existing archive must be validated/preserved on future upgrade; invalid persisted archive fails closed rather than resetting it.

## Read surface

World methods `historyPage(query={})` and `historyMetadata()` (module implementations may use helper exports). `historyPage` validates only known string query keys: `agent_id,category,from,to,before,limit`.

- from/to optional epoch milliseconds, inclusive, valid safe integers with from<=to; agent_id must refer to an existing public role, category known; limit default20 max50 positive integer.
- `before` opaque cursor bound to archive identity and a descending sequence position. Reject malformed/wrong-archive cursors. New entries after first page do not cause duplicate/gapped traversal of retained older entries. Client resets cursor when filters change; history pruning can legitimately remove records and retention is always shown.
- Response `{items,next_cursor,has_more,server_time,retention:{days:30,max_entries:4096,max_general:3584,max_cooperation:512},archive_id,archive_started_at,earliest_record_at,history_revision,imported_count}`. next_cursor null at end. Each returned item strictly projected again; nested scalar injection/unknown keys cannot leak private data.
- Expose GET `/api/public/history` via attachSpectator, unauthenticated readonly, existing response headers. No private counterpart needed; authenticated users see the same public facts.
- Snapshot lightweight `history:{version:1,archive_id,archive_started_at,earliest_record_at,history_revision,retention,imported_count}`; no entries. Include in both owner/public snapshot and spectator snapshot/frame delta.
- Service health flags `public_history:true,head_speech_bubbles:true` with app0.16.0. get_rules `recommended_skill_version:0.16.0`, rules `0.16.0-experiences`.

## UI

History panel under map/selected details, folded by default; filter selected/any character, category and time interval, cursor load more, refresh/new-events notice, empty/error/retry. Keep read position and loaded pages when new live events arrive; explicit refresh resets paging. Abort/key stale requests on filter changes. Include offline/paused characters, distinguish duplicate names by short ID. Cooperation category is an explicit review entry point and reuses public outcome rendering. Historical card opens full stored factual data and source/time, never animates the live map or issues agent commands.

Replace the fixed singleton speech-window with actual cloud bubbles anchored to each visible active speaker's head. Keep shared dismissal/reading state and the existing message-history tray. One latest confirmed public message per rendered actor,18s initial lifetime, long text preview plus in-place full-text reading; no invented or replayed speech. Read old history without resurrecting a live bubble. Respect map transforms, slot offsets, CSS movement transitions, viewport edges, overlap and unscaled readable fonts. Draw independent interactive bubble elements (no nested buttons inside actor button). Support adventure, plaza and farm's actually rendered in-camp avatar only. Off-map/offline/paused actors get no active speech bubble. On disconnection clearly stop live-speech presentation, with last-received content only if explicitly marked. Pointer/keyboard close, Escape/focus return, plain text rendering, reduced motion and hidden-page efficiency required. Show five simultaneous speakers in crowded/edge test scenes without horizontal overflow or detached attribution.

## Verification and ownership

Backend agent: games/world/history and server tests; migration verifier+fixtures. Runtime agent: skills+runtime tests, finite slow requests, timing prompt/docs and upgrade metadata. UI agent: src, spectator history route/projection, browser+UI tests (coordinate backend exports). Root: product prompt/contract, package/index versions, HTTP integration, real-time slow-controller/at-capacity history load, deployment/reports.

Tests must cover 40–60sec delayed model responses with independent renewal, slow correction, all three game completions, solo answers/treasure; deadline boundaries and no extension, replay/no partial archives, actual history after pruning/restart/upgrade, cursor filtering/concurrent append, deep public sanitization and four viewer roles. Include a real-time slow-request probe, not only fake clocks. Browser three sizes, five clouds, moving/zoom/corners/crowding, full text/focus, camera view switches, offline and archive pagination/races/source details. Run full Node/browser/build/artifacts. On final candidate run >=15min isolated5controller/20SSE with seeded archive capacity and concurrent history queries; measure application separately from load clients. Do not touch production model state to make a test pass.

Before deploy preserve existing data and original Skill configs/identity/budget/goal patch. Extend migration verification to permit only exact real restart results and defined pruning/import, including existing v0.15 records; do not assume optional fields empty. Same exact Git main/tag SHA on server, complete original Skill update and fresh live health/public three views. Full completion requires all user-requested items, not only green unit tests.
