# Campaign Prototype: Findings And Implementation Plan

## Status And Scope

- Research date: 2026-11-04.
- Branch: `campaign`, based on `dev` at `9958fa5034ceb9f6ab1d05c9d240e031020732cb`.
- This document records research and planned work. Campaign gameplay is not implemented yet.
- First playable milestone: the original Terran mission Wasteland, from briefing through actual victory or defeat, using its original scenario rather than a scripted recreation.
- Follow-up missions: Backwater Station and Desperate Alliance. Completing the first mission does not establish support for all campaign maps.
- Keep the working melee sandbox, optional bots, multiplayer, mobile controls, and command regressions intact.
- Use shared cached game data and mission-at-a-time downloads. Do not require the entire campaign/CD archive before the first mission starts.
- Do not commit proprietary archives, mission data, dialogue, videos, or generated packs. Local development assets remain under ignored `web/data/`.
- This change is documentation only. The next implementation session should work through the milestones below after approval.

No blocking product questions are needed to follow this plan. The defaults are English assets, browser single-player, desktop plus the existing mobile interface, local development delivery first, and persistent completed-mission progress. Animated portraits, cinematics, mid-mission saves, and public asset hosting are not first-milestone requirements.

The campaign's game logic must remain authoritative. Do not mark the mission playable merely because terrain renders, replace scripted behavior with a melee bot, remove unsupported triggers, or grant Raynor directly to the player to bypass rescue support.

## Decision Summary

Build a reusable Use Map Settings mission runtime, not a separate implementation for each mission. The scenario supplies units, player settings, conditions, actions, objectives, and dialogue references. The runtime interprets those inputs and reports presentation events to the browser.

Start with Wasteland because its inspected trigger stream has no explicit campaign-AI script action. Implement and verify the semantics it actually uses, then add the additional capabilities exercised by the next two missions. Do not silently skip required actions or claim general campaign compatibility.

Use the existing C++ simulation and MPQ decoder, JavaScript host, and headless WebAssembly runner. Reuse existing ownership boundaries before creating new services or abstractions.

## Verified Asset Inventory

### Shared Game Data

| Local Archive  |      Bytes | Expected CRC32 | Role                                                 |
| -------------- | ---------: | -------------- | ---------------------------------------------------- |
| `STARDAT.MPQ`  | 66,184,491 | `1cd201b1`     | Original game graphics, sounds, tables, and scripts. |
| `BROODAT.MPQ`  | 23,519,727 | `d97eb359`     | Expansion game data.                                 |
| `patch_rt.mpq` |    636,958 | `bd6e74e2`     | Patched data, including the current AI-script table. |

The three archives total 90,341,176 bytes. The browser currently caches each whole archive in IndexedDB. They are distinct from the larger campaign/CD archives below.

### Campaign/CD Archives

| Local Archive   |       Bytes | Expected CRC32 | Embedded MPQ Offset |
| --------------- | ----------: | -------------- | ------------------: |
| `StarCraft.mpq` | 601,389,682 | `c2898267`     |             259,584 |
| `BroodWar.mpq`  | 571,847,688 | `712f7ef1`     |             294,912 |

Both archives were downloaded with permission using the source configured in [web/scdat.py](web/scdat.py). Their complete file sizes and CRC32 values matched. These are provenance/integrity checks against that source, not a claim that CRC32 is a cryptographic authenticity check.

Both files have executable-style prefixes. A valid version-0 MPQ begins at the offset listed above. Read the archive as data; never execute the wrapper. The standalone Python reader assumes an MPQ header at byte zero, so the inventory rebased the embedded archive in memory without modifying the source files.

Neither campaign archive contains a usable `(listfile)`. A public filename catalogue identified 780 of 782 entries in StarCraft and 1,250 of 1,252 in Brood War. Unidentified entries remain an inventory limitation.

| Content Found               | StarCraft | Brood War |
| --------------------------- | --------: | --------: |
| Campaign scenario resources |        35 |        33 |
| WAV entries                 |       500 |       751 |
| SMK/AVI entries             |        27 |         7 |

Scenario-resource counts include tutorials, variants, and extra resources. They are not counts of distinct official playable missions. Catalogue names were checked against actual archive hash tables; this was not just a list of hypothetical filenames.

Campaign scenarios are raw CHK files, for example:

```text
campaign\terran\terran01\staredit\scenario.chk
campaign\terran\terran02\staredit\scenario.chk
campaign\terran\terran03\staredit\scenario.chk
```

Mission-specific audio is stored below the corresponding mission root. The archives also contain installer-prefixed game files such as `files\stardat.mpq`; these are not replacements for the already validated shared archives.

### Inspected Missions

| Mission                | Map Size | UNIT Records | TRIG Records | MBRF Records | Referenced WAVs |
| ---------------------- | -------- | -----------: | -----------: | -----------: | --------------: |
| T1: Wasteland          | 64 x 64  |           49 |            9 |            1 |               8 |
| T2: Backwater Station  | 64 x 64  |           98 |           15 |            1 |              21 |
| T3: Desperate Alliance | 96 x 96  |          199 |           10 |            1 |              14 |

All 43 referenced WAV paths resolved against the local archives. Resolution is not proof of completed browser playback. One inspected sample uses MPQ compression mask `0x41`: Huffman plus mono ADPCM. The Python helper cannot decode that combination, but the main C++ loader already implements both stages in [data_loading.h](data_loading.h#L1113).

UNIT record counts include start-location markers. They are not expected live-unit counts after initialization.

### Reproducible Scenario Identities

| Scenario   | SHA-256 Of Raw CHK                                                 |
| ---------- | ------------------------------------------------------------------ |
| `terran01` | `4c2487ac0219eee53719ff88e068ecc77d0634aad250ecb69d69b0089b849ff9` |
| `terran02` | `fbfc8325fe73e2351771f3b37ce09642a4f88f3ff89e060a61dc8a549c2e721d` |
| `terran03` | `597c34e9f74d1564978a5971a065e2699ae20f49eacfff1ff0e28d2537d7d03e` |

The downloaded original campaign/CD wrapper has SHA-256 `ba155a30ca11a57a2ea917cb4f25715f79bee7397ebb16db4816e7725395e58d`. Retain the source archives unchanged. Generated mission packs need their own hashes; neither source CRC32 nor source CHK hashes are substitutes for pack validation.

### Wasteland Setup Facts

All three inspected scenarios use CHK format version 59. Wasteland's relevant original slots are:

| Zero-Based Slot | Raw OWNR | Meaning                                                      | SIDE      |
| --------------- | -------: | ------------------------------------------------------------ | --------- |
| 1               |        6 | Open human slot, normalized to occupied for a local mission. | Terran, 1 |
| 2               |        3 | Rescue-passive player.                                       | Terran, 1 |
| 4               |        5 | Computer, normalized to computer-game rather than removed.   | Zerg, 0   |

Wasteland is not a slot-zero mission. Derive and validate the player slot from mission metadata and OWNR; do not retain the sandbox's random slot picker or hardcode slot zero in tests.

Its 49 UNIT records comprise:

- Human slot 1: five Marines, five SCVs, one Command Center, one Supply Depot, and one start marker.
- Rescue slot 2: one Jim Raynor Vulture, unit ID 19, and one start marker.
- Computer slot 4: 23 Zerglings and one start marker.
- Neutral slot 11: ten mineral-field records.

This implies 46 live actors if the loader correctly excludes all three start markers and creates no melee starting units. Treat that as a testable expected result, not a result already demonstrated by campaign initialization.

The opening resource action sets slot 1 to 40 minerals. Do not inject the melee sandbox's 50 minerals or assume the resource grant occurs before the first trigger scan. Force ownership matters: several mission triggers are owned by Force 1, ID 18, rather than a literal human slot.

### Wasteland Success And Failure Predicates

The inspected trigger records establish these game-logic requirements:

- Victory requires slot 1 to command at least ten Marines, at least one Barracks, and at least one Jim Raynor Vulture.
- Owning Raynor therefore requires real rescue/ownership transfer from slot 2.
- Defeat is triggered if slot 1 commands at most zero units of type Any Unit, ID 229.
- Defeat is also triggered if All Players, ID 17, command at most zero Jim Raynor Vultures.
- A separate defeat path requires no Command Center, no Barracks, at most nine Marines, and at most 399 minerals for slot 1. Its waits and messages must complete even though that trigger pauses gameplay.
- Another trigger changes objectives and centers the camera after a Barracks exists; it also sets up a Marine-count leaderboard.
- Opening and later elapsed-time triggers initialize resources/objectives and play dialogue. One uses an elapsed-time threshold of 8. This value is not eight simulation frames.

These are derived numeric predicates, not permission to replace the original triggers with mission-specific win checks.

### Required Operation Matrix

Numeric IDs below are the raw CHK IDs, not newly invented internal enums.

| Area             | Wasteland Requires                                                                   | Baseline State / Planned Work                                                                    |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Conditions       | 2 Command; 4 Accumulate; 12 Elapsed Time.                                            | Add Accumulate; verify completed-unit counting, player groups, comparisons, and time conversion. |
| Existing actions | 1 Victory; 2 Defeat; 4 Wait; 26 Set Resources; 38 Move Location.                     | Test semantics rather than assuming existing code is campaign-correct.                           |
| Game pause       | 5 Pause Game; 6 Unpause Game.                                                        | Separate scripted world pause from trigger/presentation progress and manual user pause.          |
| Presentation     | 7 Transmission; 8 Play WAV; 9 Display Text; 10 Center View; 12 Mission Objectives.   | Ordered native events plus browser presentation; no network waits during execution.              |
| Speech           | 30 Mute Unit Speech; 31 Unmute Unit Speech.                                          | Suppress unit acknowledgements, not narration or the master sound setting.                       |
| Leaderboard      | 17 Leaderboard Control; 32 Leaderboard Computer Players.                             | Simple correct Marine-count presentation is sufficient; do not silently ignore these.            |
| Briefing         | MBRF 1 Wait; 3 Text; 4 Objectives; 5 Show Portrait; 6 Hide Portrait; 8 Transmission. | Separate briefing interpreter; portrait names/static images may stand in for animation.          |

Backwater Station additionally uses conditions 1 Countdown Timer, 3 Bring, and 11 Switch; actions 11 Create Unit With Properties, 13 Set Switch, 23 Kill Unit At Location, and 43 Set Invincibility are among its added requirements. Desperate Alliance adds condition 5 Kills and actions 14 Set Countdown Timer, 15/16 AI scripts, and 28 Minimap Ping.

The Desperate Alliance briefing also contains an observed type 29 before the terminator, outside the standard MBRF 1-9 list. Its meaning must be verified before supporting that mission; do not silently reinterpret it as a normal TRIG action.

### AI Data

- Patched `scripts\aiscript.bin`: 62,050 bytes and 293 inspected entries.
- BrooDat `scripts\bwscript.bin`: 26,458 bytes and 78 inspected entries.
- Desperate Alliance references `Ter3` and `Suic`; both have in-bounds code entries in the patched original AI table.
- Wasteland and Backwater Station have no explicit AI-script actions in the inspected active trigger streams. This is not a blanket claim that their enemy behavior requires no compatibility work.
- StarDat also has a legacy AI binary whose header differs from the later format. Do not label it corrupt because a later-format table parser rejects its first word.

## Download Strategy

The desired first-run sequence is application/engine, shared data if uncached, then only the selected mission's required assets. A player with the shared data cached should download just the additional mission content. Cache reuse is conditional on browser storage availability and eviction.

| Mission            | CHK Bytes | CHK + Referenced Audio: Stored MPQ Bytes | Decoded Bytes |
| ------------------ | --------: | ---------------------------------------: | ------------: |
| Wasteland          |    88,628 |                                1,145,976 |     3,581,936 |
| Backwater Station  |   105,877 |                                1,928,875 |     5,913,701 |
| Desperate Alliance |   143,911 |                                2,002,685 |     6,216,575 |

These are measured source representations, not tested deployable pack sizes. They exclude cinematics, music, and unreferenced mission media. Encryption offsets, repackaging, compression, and HTTP transfer encoding can change the eventual download size.

Preload and validate a mission's required files before starting its briefing/gameplay. Do not perform network reads from the synchronous simulation or interrupt a trigger with a network wait.

Actual bandwidth savings require independently accessible authorized mission files/packs or a verified HTTP range source with suitable CORS behavior. Downloading a full archive and splitting it in the browser does not reduce initial bandwidth. The current configured download source has not been validated as a range-capable campaign-delivery backend.

Local development can generate ignored mission packs from the owned archives. Public redistribution rights are not assumed. Public hosting is a separate release gate, not a reason to block local runtime development.

### Chosen First-Prototype Asset Contract

Use a small ordinary version-0 MPQ for each mission. Put the original raw scenario at `staredit/scenario.chk` and its required WAV files at their scenario-relative paths, such as `staredit/wav/...`. Keep the original CHK bytes unchanged so its string paths and trigger references still agree with the pack.

This reuses the existing map buffer at asset index 3 and the production MPQ reader. It avoids either loading a 601 MB archive into the browser or introducing a second runtime filesystem protocol for the first mission.

Preparation is an offline developer tool, not work done during gameplay:

1. Verify the input archive's size/checksum and validate its embedded MPQ header and table bounds.
2. Read the selected scenario and enumerate active TRIG/MBRF WAV references, plus any required dependencies revealed by the mission audit.
3. Extract only those dependencies using the existing C++ MPQ codecs. Do not duplicate Huffman/ADPCM in JavaScript or silently drop undecodable audio.
4. If a small writer is needed, start with plain unencrypted MPQ entries and reuse the repository's hash/table format. Do not invent a new compression codec. Verify output with the production reader and an independent metadata check.
5. Normalize paths consistently, reject traversal/absolute/NUL paths, check collisions and size limits, and write atomically through temporary outputs.
6. Emit the pack and a manifest under ignored `web/data/campaign/`, never directly into tracked source or the Pages artifact.

The authoring tool may be a small C++ WASI utility run by Node with preopened input/output directories, using the existing SDK and [data_loading.h](data_loading.h). Prefer that over expanding the limited Python decoder with a new codec implementation. The exact tool entry filename is an implementation choice, not a requirement to create a new framework.

The manifest should contain at least schema/content version, stable mission ID, episode/order/title, source CHK hash, pack URL/size/SHA-256, expected human slot/race, required runtime capability IDs, file paths/sizes, and audio-duration metadata needed for deterministic transmissions. Titles and IDs may be public metadata; original narrative text and media remain inside local/properly authorized asset packs.

Before a mission runs, verify all required dependencies and supported operations. A partial download or unsupported action must produce a specific recoverable error, not half-start a mission.

### Caching And Distribution Rules

- Cache shared MPQs separately from mission packs. Reuse the current IndexedDB approach rather than downloading them again per mission.
- Key mission packs by content version/hash; a URL or mission name alone is not sufficient invalidation.
- Treat a pack as complete only after its full expected length and SHA-256 pass. Preserve a working cache entry if a replacement fails.
- Give optional cinematics independent dependencies; no first-mission blocker should fetch every episode's movies.
- Deduplicate shared media by verified content identity when packaging makes this worthwhile. Do not assume identical filenames have identical content across missions.
- Add user-visible size/progress/failure states and a way to delete optional mission downloads without deleting campaign progress or shared data.
- Do not prefetch the next mission without an explicit setting; mobile users may be on metered connections.
- A local archive-import alternative can avoid network downloads for owners. A future browser importer should use bounded file slices, not require a multi-gigabyte whole-file memory allocation on iPhone.
- Serving extracted packs publicly requires authorization. If relying on original remote archives instead, demonstrate byte-range requests, `206` responses, correct content ranges, and CORS on that exact source first. Do not silently fall back to downloading a full archive when a range request is ignored.

## Existing Code And Compatibility Gaps

| Area           | Existing Behavior                                                                            | Campaign Requirement                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Initialization | [web/wasm_main.cpp](web/wasm_main.cpp#L80) always calls melee setup.                         | Add a separate mission path without changing melee defaults.                                                         |
| Scenario setup | [web/sandbox.h](web/sandbox.h#L34) replaces players, resources, starting units, and vision.  | Preserve scenario settings and use the actual human slot.                                                            |
| Map loader     | [bwgame.h](bwgame.h#L21830) already has Use Map Settings support and reads mission sections. | Reuse that path and audit its initialization behavior.                                                               |
| Conditions     | Command, Bring, Elapsed Time, Opponents, Always are implemented. Unknown types error.        | Implement required missing conditions and verify existing semantics.                                                 |
| Actions        | A small subset is implemented; unknown types silently skip.                                  | Implement mission-required actions; fail preflight for unsupported required actions.                                 |
| AI scripts     | Action 15 handles shared vision IDs only.                                                    | A real script interpreter is needed for later missions, not a melee bot substitute.                                  |
| Briefing       | CHKs contain MBRF; the current loader does not expose a briefing runtime.                    | Parse and present the required briefing operations.                                                                  |
| Outcome        | Solo sandbox ignores trigger outcomes; competitive mode has melee elimination logic.         | Dedicated mission success/failure, without last-building heuristics.                                                 |
| Asset bridge   | Three shared MPQs plus a single map buffer; file selection uses name heuristics.             | Explicit mission asset mounting and deterministic path resolution.                                                   |
| Replay         | Initialization records melee metadata.                                                       | Do not produce misleading melee replays for missions.                                                                |
| Persistence    | Shared-asset cache exists; no campaign progression model.                                    | Versioned mission completion and unlock state.                                                                       |
| Rescue         | Initialization and visible/hidden RescuePassive order branches explicitly error.             | Generic rescue support is a first-mission blocker, not just later polish.                                            |
| Computer idle  | Visible/hidden ComputerAI order branches explicitly error.                                   | Audit actual enemy DAT idle orders and implement required guard/combat behavior before declaring UMS loading usable. |

The simulation already contains an in-memory deep state-copy helper. This is not a browser save-game file format and does not establish reliable mid-mission save/load support.

### Specific Baseline Hazards

These are source-audit findings to turn into failing tests, not changes made by this document:

1. `game_load_functions::load_map` initializes `use_map_settings` to false, runs earlier mode-dependent player handling, and assigns the final mode later. Audit/reorder this so fixed SIDE races and mission controllers are not processed as melee first. Preserve existing callback/replay behavior under regression tests.
2. Rescue-passive initialization calls `error("fixme rescue passive")`; both visible and hidden RescuePassive dispatch branches also error. Do not work around this by deleting Raynor or changing his owner at load time.
3. ComputerAI dispatch is incomplete. Even a mission without explicit AI-script actions can activate an enemy's DAT idle order. Do not convert computer slots to human slots merely to avoid this path.
4. TRIG parsing currently creates running triggers only for `controller_occupied` players. Later AI missions need computer-owned trigger execution, including the correct Force/All Players expansion.
5. `process_triggers` resets `current_action_index` before execution, although `execute_trigger` already uses that field for continuation. Prove and fix wait/transmission continuation; avoid replaying earlier mutations or dialogue on every resumed scan.
6. Elapsed Time currently compares its threshold directly with `st.current_frame`. Mission time is not raw frame count. Confirm the classic conversion and pause semantics before changing it.
7. Raw CHK comparison 10 means Exactly, but `trigger_count_comparison` accepts internal 2 while the parser reads the byte unchanged. Add explicit comparison tests; do not assume normalization exists elsewhere.
8. The condition evaluator does not visibly skip disabled condition flags in its execution loop. Disabled records and first-type-zero termination need parser/executor tests.
9. Set Resources has two `num_n == 8` branches; the subtraction branch should be checked against raw modifier 9 and underflow behavior.
10. Solo outcomes are currently ignored, and melee elimination heuristics do not represent mission objectives. Campaign outcome handling must use the actual mission trigger result.

### Clock And Event Decisions

Use deterministic logical time, not render frames or real audio playback completion. Keep world advancement, campaign trigger/wait progress, briefing progression, and manual user pause distinguishable.

A scripted Pause Game must freeze relevant world movement/combat/input while allowing its Wait/Transmission sequence to reach Unpause Game or Defeat. Reusing the browser's manual pause flag, which stops stepping entirely, would deadlock this sequence. Conversely, advancing the world frame counter while merely pretending to pause can expire unit deadlines incorrectly.

Prefer a campaign-specific step path in [web/wasm_main.cpp](web/wasm_main.cpp#L174): while the script pauses the world, service the required trigger/presentation clock without calling normal world advancement; otherwise run the normal simulation with exactly one trigger service pass. Finalize the precise clock rules using synthetic traces and the reference gates in P0/P3. Do not alter melee stepping as a shortcut.

The current scheduler uses a 42 ms wait decrement and a 30-frame trigger countdown. Those are observations, not proof of classic timing accuracy. The reference describes normal trigger cycles in game seconds and 42 ms wait quantization at Fastest; verify cadence, initial delay, zero waits, and the 8-second mission condition separately. First-playable timing tests use the existing Fastest setting; other speed settings require their own checked behavior before being offered in campaign mode.

For UI effects, extend the existing state-functions callback boundary with a small ordered mission-event stream. Events should have a generation ID, sequence, owner, type, and typed arguments/string references. Acknowledge consumed events so polling does not replay sounds or camera jumps. Keep persistent state such as objectives/leaderboard separate from transient events, and define queue bounds and overflow as a visible mission error.

Use a new queue only for the actual native-to-browser presentation need. Do not create a parallel worker/model/service layer around the existing simulation.

## Research Status And Remaining Gates

- [x] Verify local archive identities, mission paths, referenced sound availability, and scenario hashes.
- [x] Identify the first three missions' operation sets and AI-script dependencies.
- [x] Inspect Wasteland's controllers, unit records, resource grant, Force owners, and numeric outcomes.
- [x] Locate the existing MPQ/audio, scenario-loader, callback, and single-player lockstep boundaries.
- [x] Find first-mission rescue, UMS-ordering, trigger-continuation, and outcome risks in source.
- [ ] Round-trip a generated mission pack and decode/play its actual dialogue through the production path.
- [ ] Confirm classic timing, pause/skip behavior, rescue rules, and the enemy idle orders activated by the map.
- [ ] Verify nontrivial existing operations, especially Move Location direction/extent handling, before treating them as correct.
- [ ] Resolve public asset-delivery authorization/range support before a public campaign release; local packs do not require resolving public hosting first.

The remaining technical gates have concrete owners and tests below. They are not product questions that need to block this document or require the user to explain implementation details.

## Implementation Milestones

Each milestone is a small reviewable commit or a short sequence of commits with its evidence recorded here. Keep this document current when a gate passes, a design changes, or a reference contradicts an assumption. Do not mark a checkbox complete from static inspection alone when it requires runtime evidence.

### P0: Reproducible Audit And Baseline Fixtures

Owners: [web/scdat.py](web/scdat.py), [web/run-wasm-node.mjs](web/run-wasm-node.mjs), and this document.

Tasks:

1. Reconfirm `campaign`, the baseline SHA, a clean/understood worktree, and the ignored archive paths. Keep personal-account commit configuration local to this repo.
2. Reproduce the bounded CHK scan: validate section sizes, 36-byte UNIT records, 2,400-byte TRIG/MBRF records, and string indices. Append UNIT/TRIG/MBRF sections where required; do not concatenate sections whose format uses replacement semantics.
3. Stop conditions/actions at the first type-zero entry, honor disabled flags, and preserve record order, owner selectors, execution flags, and original string IDs.
4. Emit a local audit containing mission hashes, required operations, dependency paths/sizes, and unsupported capabilities. Store generated detailed reports and copyrighted text only under ignored data.
5. Add small synthetic fixtures for timing, player groups, comparisons, resources, and event ordering. They must be authored test data rather than committed copies of the campaign.
6. Inspect actual DAT idle orders for the placed enemy units and verify reference rescue/trigger timing behavior. Record any reference uncertainty and its reproducer before proceeding.

Gate: the audited Wasteland profile matches the identities and numeric predicates above; every required operation is classified as implemented-and-tested, scheduled work, or an explicit unsupported blocker. Existing command regressions pass unchanged.

### P1: Prepare A Small Local Mission Pack

Owners: the existing MPQ codec in [data_loading.h](data_loading.h), a minimal offline preparation entry point, and [web/scdat.py](web/scdat.py) only where its existing command surface is useful.

Tasks:

1. Add embedded-header/zero-based bounded-reader support for the authoring path without rewriting the downloaded wrappers. Validate tables/entry bounds rather than accepting the first `MPQ` byte sequence found in executable data.
2. Prepare only Wasteland's CHK and eight referenced WAVs. Resolve a mission-relative path against its original mission root before falling back to shared files.
3. Reuse the production Huffman/ADPCM decoder; validate RIFF/WAVE output, declared lengths, PCM/sample-rate/channel metadata, and transmission durations. Missing/undecodable required files are preparation failures.
4. Write a standard small MPQ and manifest, with decoded dependency hashes and a final pack hash. Do not assume old encrypted blocks can be copied to new offsets without rekeying or decoding.
5. Reopen the generated pack with the same C++ MPQ reader used in-browser. Read the CHK and every dependency, not just the pack header. Verify the CHK hash still matches the source.
6. Use generated paths such as `web/data/campaign/terran01.mpq` and a matching manifest. These example output names are proposed, not files that exist already.

Gate: the pack loads all required assets without either full campaign archive present in the browser's request log. Record actual pack bytes, decoded bytes, hash, and codec results. Do not substitute the source 1.15 MB estimate for that measurement.

### P2: Isolated Mission Initialization, Rescue, And Basic Enemy Orders

Owners: [web/wasm_main.cpp](web/wasm_main.cpp), [web/sandbox.h](web/sandbox.h), and [bwgame.h](bwgame.h).

Tasks:

1. Add an explicit campaign initialization entry point/mode. Keep the existing melee entry points and bot modules' default behavior unchanged.
2. Use the existing four asset buffers initially: shared archives at 0-2 and the prepared mission MPQ at 3. Replace filename-substring guesses for the mission path with an explicit mapping.
3. Mount the mission MPQ before Patch/BrooDat/StarDat for mission-relative lookups. The public `data_files_loader::mpqs` list and `file_exists` checks provide an existing boundary; avoid adding an unrelated asset service. Preserve shared-archive fallback.
4. Load through Use Map Settings with `victory_condition`, `tournament_mode`, and `starting_units` zero, resource overrides disabled, and no extra melee units. Finalize mode before mode-dependent initialization. Do not use a blanket no-units option that also discards placed units.
5. Preserve OWNR/SIDE/FORC, fog, availability, upgrades, custom stats, and locations. Normalize the scenario's open human/computer controllers without removing rescue-passive players. Validate the manifest's slot/race against the actual map.
6. Fix rescue-passive initialization and visible/hidden order handling. Reuse the engine's ownership-transfer helpers. Implement generic rescue behavior matching the reference; prove Raynor changes from slot 2 to slot 1 when properly approached, not at initial load.
7. Handle the placed computer units' required idle/guard/combat orders. No invented attack waves or replacement melee bot are acceptable. A full town-building AI VM remains later work unless the map audit proves it is needed here.
8. Keep browser command scheduling local-human-only: `Lockstep.slots` describes turn producers, not every scenario player. The native map can retain computer/rescue slots while the host produces turns only for the actual human slot. Do not wait for nonexistent network/bot turns.
9. Start each mission with a fresh engine/session state. For the first prototype, restart/return may reuse the existing full-page reset and persistent asset cache rather than stacking boot listeners, leaking old engines, or refactoring the whole lifecycle.
10. Disable campaign replay export until correct UMS setup/metadata is supported. Preserve melee recording. Do not label a mission replay as game type 2/melee.

Gate: no rescue/ComputerAI trap, correct human slot 1/Terran race, no extra start units, expected initial actors/ownership, expected fog/tech restrictions, live mining/building/combat, and a non-stalling local command loop. Resources become 40 through the original initialization trigger, not a hardcoded loader grant.

### P3: Correct The Required Trigger Runtime

Owners: `test_trigger_condition`, `execute_trigger_action`, `execute_trigger`, `process_triggers`, TRIG loading, and the appropriate native state/callback structures in [bwgame.h](bwgame.h).

Tasks:

1. Preserve raw IDs and centralize the campaign-supported operation set. Have preparation/browser preflight compare requirements against runtime capabilities; avoid three independently maintained support tables.
2. Add Accumulate for ore/gas/combined resources and all required comparison modifiers. Test current holdings versus collected totals against the reference rather than choosing whichever makes the mission pass.
3. Test Command's ownership and completed-unit rules, Any Unit selectors, Force/All Players/Current Player expansion, disabled conditions, and Exactly 10 versus the baseline internal comparison value.
4. Correct Elapsed Time's units and verify default cadence, initial delay, wait quantization, and boundary comparisons. Do not infer game seconds from the JavaScript frame interval alone.
5. Preserve a blocked trigger's continuation and one-shot/preserve flags. Honor per-player wait interactions and the relevant skip-once/execution flags. Do not blindly replay a blocked trigger's own preceding actions; distinguish that from the original scheduler's deliberate earlier-trigger rechecks.
6. Implement Pause/Unpause and Transmission waiting with the separated clocks described above. Test multiple waits/transmissions and defeat after a scripted pause without user intervention.
7. Verify Set Resources set/add/subtract and underflow, plus Move Location's source/destination interpretation, extent preservation, and bounds. Fix defects at the existing abstraction, not in mission-specific wrappers.
8. Implement the native semantics/state of objectives, text/audio/camera events, unit-speech mute, and the two used leaderboard actions. State changes/events must be ordered by trigger execution, not browser render timing.
9. Surface unknown required operations with record/owner/action diagnostics. Keep explicitly harmless Comment actions harmless; do not silently classify an unknown opcode as optional. Preserve existing melee behavior under tests while avoiding campaign traps/false success.

Gate: synthetic traces cover every Wasteland condition and action; resource initialization happens once; narration is not replayed on each scan; timing is independent of 60/120 Hz rendering; scripted pauses resume or finish as intended; all three failure predicates and the full victory predicate resolve through the original trigger records.

### P4: Briefing And Mission Presentation

Owners: CHK parsing/state in [bwgame.h](bwgame.h), mission events and state in [web/sandbox.h](web/sandbox.h), exports in [web/wasm_main.cpp](web/wasm_main.cpp), browser handling in [web/openbw.js](web/openbw.js), and existing UI in [web/index.html](web/index.html).

Tasks:

1. Parse MBRF separately from gameplay TRIG, sharing structural readers where appropriate. Its opcode meanings are different. Do not accidentally run briefing actions as simulation actions.
2. Present Wasteland's briefing text, objectives, speaker identity/static portrait placeholder, narration, and a clear Begin/Skip flow. Keep the world unstepped and game commands disabled while briefing is active.
3. Skip/fast-forward briefing presentation without changing the later gameplay trigger state. Cancel narration and invalidate pending async audio work by mission generation when leaving/restarting.
4. Load arbitrary mission WAV paths through the mission overlay and `native_sound::load_wav`, rather than treating a trigger WAV string index as an `sfxdata.dat` sound ID. Cache by normalized path/content version.
5. Keep narration independent of fog/positional-unit sound audibility. Continue using the master mute setting. Apply Mute Unit Speech only to unit speech/acks, not to the mission voiceover.
6. Use prevalidated WAV duration/action modifier metadata for logical transmission delays. Browser audio decoding/autoplay rejection must not change simulation timing or deadlock the mission. Show text even if audio is unavailable.
7. Consume ordered events exactly once. Center View uses the scenario's actual location rectangle; objectives persist until replaced; the Marine-count leaderboard derives from current game state.
8. Decode the known English strings consistently, preserve useful line breaks/allowed color controls, and render as escaped text. Do not place untrusted map strings directly into HTML.

Gate: briefing can play or be skipped; a real mission dialogue WAV reaches browser audio loading; muted/blocked audio still gives readable text and deterministic progression; no worker HP is shown as briefing/mission metadata; changing render rate does not duplicate dialogue/camera events.

### P5: Mission Selection, Downloads, Outcomes, And Progress

Owners: existing startup/UI/IndexedDB code in [web/openbw.js](web/openbw.js), [web/index.html](web/index.html), mission init/outcome exports, and the manifest from P1.

Tasks:

1. Add a modest Campaign choice alongside the existing sandbox path, not a replacement landing page. Read a small mission catalogue without downloading all missions.
2. Make Wasteland selectable. Show later missions as unimplemented until their own gates pass; do not unlock a launch button that silently enters melee.
3. Fetch/cache/verify only the selected pack and missing shared data. Keep assets out of the service-worker shell cache; the existing app does not need a new service worker merely for mission packs.
4. Allow retry/cancel for downloads; distinguish corrupt/partial packs, missing codec/dependency, unsupported operation, and storage failure. Never start the mission with a partially committed cache entry.
5. Add an explicit native mission mode for outcomes, separate from `competitive`. Accept the actual human's trigger victory/defeat, including force-owned triggers. Do not use sandbox last-standing/zero-building shortcuts.
6. Stop mission advancement once a terminal outcome is committed. Record completion/unlock once only after victory; defeat must not unlock anything. Preserve user pause and restart semantics.
7. Persist a versioned completed-mission set using browser storage with caught quota/security errors. Cache deletion and completion reset are separate actions. Failure to persist progress must not prevent local play.
8. Return/restart through the defined session reset path, rereading the same verified pack from cache and clearing units, triggers, waits, events, UI selection, and audio generation state.
9. On an unexpected WASM trap, stop stepping/render requests for that failed session and offer a recoverable error/return path. Do not leave the simulation running behind a frozen display, and never persist a false victory.

Gate: a fresh browser session can select/download/brief/play/finish Wasteland; a reload remembers completion; an uncached second mission is not fetched automatically; a failed/evicted cache is retriable; sandbox mode and its existing multiplayer/bot paths still work.

### P6: First-Playable Acceptance And Evidence

Use the existing headless WASM runner and debug interfaces, with a clearly named campaign test mode if needed. A proposed future command is `node web/run-wasm-node.mjs --test-campaign`; it does not exist at this baseline. Keep setup ownership-aware rather than assuming slot 0 or a particular screen center.

Required automated checks:

- Pack round-trip, content hashes, dependency completion, codec bounds, and all required capabilities.
- Original player/controller/race/force/fog/tech state, no extra melee units, and the original 40-mineral initialization action.
- Generic rescue: Raynor starts outside human ownership, can be rescued, and contributes to the human Command predicate afterward.
- Victory negative cases: nine Marines, missing Barracks, and Raynor not rescued must each prevent success. All required conditions together must produce victory through the original trigger.
- Failure cases: all human units lost; Raynor lost; and the no-CC/no-Barracks/at-most-nine-Marines/399-mineral state. At 400 minerals the last predicate must not fire.
- Wait/transmission continuation, Force owners, one-shot triggers, pause-to-defeat completion, speech suppression, and no duplicated events across extra renders.
- Briefing skip, master mute, audio rejection, restart cleanup, durable completion, failed storage, and no progress recorded after defeat/runtime failure.
- Network assertions: no full campaign/CD MPQ, other mission, or cinematic request during Wasteland startup/play; cached replay of the mission does not fetch its pack again.
- All existing `--test-commands` cases remain green, including selection, mobile placement, mines, nuclear launch, and queued commands.

Required human/browser play checks:

1. Play from briefing to a genuine Wasteland victory using normal mining, construction, training, and rescue controls. A debug-state win test alone is not acceptance.
2. Exercise defeat and retry, including the paused loss message path.
3. Verify desktop plus mobile landscape/portrait; actions, minimap, objectives, text, and dialogs must not overlap. Preserve the existing touch placement/selection behavior.
4. Confirm browser audio behavior and an actual iPhone Home Screen launch when the device is available. Label emulation as emulation; do not claim device testing from viewport sizing.
5. Record mission hash, runtime commit, browser/device, actual pack/request bytes, completed acceptance rows, screenshots, and unresolved limitations in a concise evidence note. Do not commit proprietary screenshots/audio/story text unless redistribution is explicitly allowed.

Definition of done: Wasteland is genuinely playable from selection through briefing and original-trigger success/failure, restart works, completion persists, only its own additional assets download, no required opcode silently skips, and melee regressions pass. Until then label the work as a partial milestone, not campaign support.

### P7: Extend To The Next Two Missions

Only start this after P6 is demonstrated or after explicitly recording why a dependency must be developed earlier.

- Backwater Station: implement/test countdown and switch conditions, additional rescue behavior, unit-property creation, kill-at-location, and invincibility, together with its actual unit availability and objective flow. Reuse the same manifest, briefing, event, and outcome infrastructure.
- Desperate Alliance: add kills/countdown behavior and computer-owned trigger execution, then interpret the `Ter3`/`Suic` programs from the real AI binaries. Inventory reachable instructions and add unsupported-op diagnostics before promising complete AI coverage. Campaign base building/attack waves must come from the script runtime, not hand-timed substitutes or McRave/ZZZKBot.
- Investigate the observed MBRF type 29 and any newly activated unit orders before enabling T3. Do not edit the source scenario to fit the engine.
- Brood War and other campaigns follow only after their own content/operation audits. The current counts and a working first mission are not a compatibility guarantee.

## Implementation Ownership And Efficiency Rules

| Surface                                                | Planned Responsibility                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [data_loading.h](data_loading.h)                       | Existing MPQ/codec primitives; only narrowly justified reader/writer fixes.           |
| [web/scdat.py](web/scdat.py) / preparation entry point | Reproducible local asset audit/preparation, not gameplay logic.                       |
| [bwgame.h](bwgame.h)                                   | UMS correctness, generic rescue/order/trigger semantics and native callbacks/state.   |
| [web/sandbox.h](web/sandbox.h)                         | Campaign UI mode, pause/outcome state, ordered presentation boundary; preserve melee. |
| [web/wasm_main.cpp](web/wasm_main.cpp)                 | Explicit campaign asset/init/step/export wiring.                                      |
| [web/openbw.js](web/openbw.js)                         | Preload/cache/progress, event presentation, audio and mission lifecycle.              |
| [web/index.html](web/index.html)                       | Selection/briefing/objectives/outcome views using the current visual language.        |
| [web/net.js](web/net.js)                               | Reuse human-only local turns; change only if a proven stepping contract requires it.  |
| [web/run-wasm-node.mjs](web/run-wasm-node.mjs)         | Small synthetic semantics and real-mission acceptance modes.                          |

Start each implementation slice from a concrete failing check, make the smallest owning-code change, and rerun that check before widening scope. Use the real Wasteland asset as an integration fixture but synthetic data for broad edge cases. Keep test helpers reusable and small; do not add overlapping test files or logging-only factories.

Do not silently remove fixed-race/rescue settings, grant resources/units for normal play, disable defeat conditions, substitute a melee AI, or relax timing assertions until a map appears to work. Any consciously reduced presentation fidelity must be stated, not disguised as exact compatibility.

## Risks And Explicit Release Gates

| Risk                                                       | Required Response                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Public asset redistribution is not authorized.             | Keep development packs ignored/local; choose a lawful supply path before public release.                    |
| A source ignores Range or CORS.                            | Do not claim phased download savings; use separately served authorized packs or local import.               |
| Rescue/ComputerAI initialization traps before any trigger. | Fix/test generic initialization/order behavior before debugging the campaign UI.                            |
| Script pause stops the same clock that must unpause it.    | Prove separated world/trigger/presentation clocks with synthetic tests.                                     |
| Timers appear correct only at one render rate.             | Use logical stepping and compare multiple rendering schedules.                                              |
| Shared helpers change melee trigger behavior.              | Run synthetic and existing command/melee regressions at every affected native slice.                        |
| Browser memory/storage is constrained.                     | Small selected packs, bounded decode buffers, no full campaign archive in browser RAM, caught quota errors. |
| Reference documentation omits an original-game quirk.      | Keep a failing reproducer/reference trace and update this plan before implementing a guessed special case.  |

There is no reliable calendar estimate for all campaigns yet. P1-P3 runtime evidence is the point to reassess effort. The plan is intentionally milestone-based rather than promising a fixed completion date.

## Follow-Up Session Checklist

1. Open this file; confirm `campaign` and inspect the actual worktree before editing.
2. Reconfirm the three core archives and the original CD archive locally; do not redownload or commit them unnecessarily.
3. Start P0/P1. Do not begin with a campaign menu that can only load melee maps.
4. Write the first failing pack/UMS/rescue test, then implement only that slice. Keep milestone evidence and open questions here.
5. After P2-P3 work, provide a concrete playable-state report before broadening to more missions. Ask for the user's normal-play/mobile feedback at P6.
6. Commit related milestones on `campaign` with the established personal author/signing setup when requested. Do not merge or deploy to `dev`/`master` without instruction.

## Validation Baseline

Existing commands, from the repository root:

```powershell
& .\web\build-wasm.ps1
node web/run-wasm-node.mjs --test-commands
node --check web/openbw.js
git diff --check
```

Use the WASI SDK setup documented in [README.md](README.md). Add focused mission checks to the existing runner or a small dedicated mission mode only when the current runner cannot hold the scenario cleanly. Generated packs and proprietary fixtures must remain ignored.

## Non-Goals For The First Playable Milestone

- Full compatibility with every official campaign or custom scenario.
- Extended triggers, EUD tricks, mods, or Remastered-specific features.
- A complete campaign-AI interpreter before Wasteland actually requires one.
- SMK cinematic playback or pixel-identical talking portraits.
- Mid-mission save/load, cloud saves, or cross-device progression.
- Campaign multiplayer or campaign BWAPI bots.
- Publishing proprietary assets or changing the existing Pages deployment branches.

## Research Sources

- Local source snapshot `9958fa5034ceb9f6ab1d05c9d240e031020732cb` and verified local archives above.
- [PyMS MPQ filename catalogue](https://github.com/poiuyqwert/PyMS/blob/master/PyMS/Data/Listfile.txt), used to resolve raw scenario and media paths.
- [Existing MPQ reader and configured download metadata](web/scdat.py).
- [Existing browser asset loader](web/openbw.js) and [WASM entry points](web/wasm_main.cpp).
- [Engine trigger conditions/actions and UMS loader](bwgame.h), [shared sandbox UI](web/sandbox.h), and [headless regression runner](web/run-wasm-node.mjs).

External reference licensing must be checked before copying implementation code. File-format documentation can guide an independently written implementation without importing an incompatible dependency.

Additional references checked for this plan:

- [CHK layout, condition/action IDs, player selectors, and MBRF](https://wiki.staredit.net/w/index.php?title=Scenario.chk&oldid=1105).
- [Trigger owner expansion and execution ordering](https://wiki.staredit.net/w/index.php?title=Triggers&oldid=560).
- [Wait-block behavior and per-player waits](https://wiki.staredit.net/w/index.php?title=Wait_blocks&oldid=629).
- [Wait quantization and trigger-cycle caveats](https://wiki.staredit.net/w/index.php?title=Hyper_Triggers&oldid=559).
- [PyMS license](https://github.com/poiuyqwert/PyMS/blob/master/LICENSE.md), identified by GitHub as MIT during this research. No implementation code was copied in this planning change.

References describe intended formats/behavior; they are not evidence that the current engine implements it. Pin any additional reference revision used for code or normative timing tests during implementation.
