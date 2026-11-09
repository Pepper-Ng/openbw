# Campaign Prototype: Findings And Implementation Plan

## Status And Scope

- Research date: 2026-11-04.
- Branch: `campaign`, based on `dev` at `9958fa5034ceb9f6ab1d05c9d240e031020732cb`.
- The local Wasteland prototype has mission loading, briefing, narration, objectives, rescue, triggers, outcomes, retry, and progression. A normal-control browser victory and the automated Wasteland gates passed. Physical iPhone acceptance remains open; this is not support for the full campaign.
- First playable milestone: the original Terran mission Wasteland, from briefing through actual victory or defeat, using its original scenario rather than a scripted recreation.
- Follow-up missions: Backwater Station, Desperate Alliance, The Jacobs Installation, Revolution, and Norad II. Completing one mission does not establish support for all campaign maps.
- Keep the working melee sandbox, optional bots, multiplayer, mobile controls, and command regressions intact.
- Use shared cached game data and mission-at-a-time downloads. Do not require the entire campaign/CD archive before the first mission starts.
- Do not commit proprietary archives, mission data, dialogue, videos, or generated packs. Local development assets remain under ignored `web/data/`.
- Implementation was approved on 2026-11-04. Work remains on `campaign`; no merge, public deployment, or asset redistribution is authorized.
- The user confirmed successful testing and approved the Wasteland milestone commit on 2026-11-04. The test device was not specified.
- Desperate Alliance is available as a source-backed campaign milestone. Its original scripts drive production and ground/air attacks; native regions govern defense and military coordination. Normal-control victory and exact classic balance remain unverified. Defer UI/mobile optimization, onboarding, and linked mission progression.
- The Jacobs Installation is available through the existing selector. The user playtested it and requested the Attack-input and camera corrections recorded below, followed by a signed personal milestone commit. Exact classic fidelity remains open.
- Revolution's original hero/base rescue, Terran production, scripted ground/air attacks, transport drops and outcome fixtures pass. On 2026-11-05 the user authorized its signed milestone commit and push, then implementation and publication of mission 6. Normal-control playtesting and classic comparison of both missions are deferred until both milestones are finished.
- Revolution is published as signed commit `7ac8955051d1a7cfecb6e271146c8bf85e5e9577`. Recent master through `a3fb4ea` was integrated in signed merge `46804a791d20f438d805d4e29be159585b4c1fc6`, preserving its retirement of the legacy Pages workflow. Both were verified on the live campaign branch.
- Norad II's original rescue win/loss conditions, Deaths-driven script activation, native upgrades, combat, authored burrowed reinforcements and flagship repair fixtures pass. Its signed milestone commit/push is authorized; normal-control and classic playtesting remain deferred.
- On 2026-11-04 the user completed Backwater Station and accepted it as the next playable milestone. The user authorized its commit and continuation to Desperate Alliance; exact classic behavior remains subject to comparison.
- Backwater's accepted milestone is personal signed commit `928ef119265bde9632626ecb3fdda127bb343ac0`. Its history remains intact. On 2026-11-04 the user authorized committing and pushing the improved Desperate Alliance milestone on `campaign`; this does not authorize merging or deploying to `dev`/`master` or publishing proprietary assets.
- On 2026-11-04 the user authorized web-informed, narrowly reasoned behavior assumptions, followed by a classic StarCraft comparison and revision pass. Record inferences explicitly rather than blocking all implementation on an original-game trace.
- The user subsequently compared the PC game: Backwater had slightly stronger sight reactions; Desperate Alliance had some heavier waves and more burrowing/surfacing. Overall differences were described as minor. Keep these observations for targeted fidelity work; do not inflate acquisition ranges or authored waves without a demonstrated cause.
- The Hammer Falls completes the ten original Terran mission selections. The user clarified that mission 10 has not been fully played on either PC or this implementation; do not treat all ten as fully playtested or classically accepted. UI/control irregularities remain. The reported easier or less aggressive AI is an unmeasured impression, not a balance target; make no difficulty changes without concrete evidence. Targeted classic comparison remains open.
- Campaign selection, sequential local progress, victory continuation and local save/recovery are implemented in signed commit `60a218319920c0c787da34b8205d6120dbbc445c`. On 2026-11-05 the user authorized that implementation commit, a separate plan commit, and a push. Cinematic work is recorded in this plan only; its prototype page, media and tools are excluded from publication. Shared computer combat decisions are implemented below; exact classic thresholds and terrain micro remain comparison items.

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
| T3: Desperate Alliance | 96 x 96  |          199 |           10 |            1 |              16 |

All mission-referenced WAV paths resolved against the local archives. Resolution is not proof of completed browser playback. One inspected sample uses MPQ compression mask `0x41`: Huffman plus mono ADPCM. The Python helper cannot decode that combination, but the main C++ loader already implements both stages in [data_loading.h](data_loading.h#L1113).

UNIT record counts include start-location markers. They are not expected live-unit counts after initialization.

### Reproducible Scenario Identities

| Scenario   | SHA-256 Of Raw CHK                                                 |
| ---------- | ------------------------------------------------------------------ |
| `terran01` | `4b0e5009c4ae80cfb4cb13ede30842db0aa05bb3be2eedad695fb093fa5786f6` |
| `terran02` | `d8a7f6b70422ff32e4fd3f6293de4013f883e0761814d4496ffd18b7eb13dfce` |
| `terran03` | `9d83a8bde18c38ee12f54f4c5253bed5466027fc612141e9a7415c94d3346737` |

These hashes supersede the planning audit's hashes. The Python helper previously padded encrypted sector tails before decryption. StormLib decrypts only complete 32-bit words and leaves remaining bytes unchanged. The corrected helper and the production C++ decoder agree byte-for-byte on Wasteland. No source archive or scenario was edited.

All three scenario audits have now been regenerated after that correction. T3 has 16 referenced WAVs and standard briefing actions 1/3/4/5/6/8. The earlier MBRF type 29 was a decoder artifact, not a required briefing operation. The patched AI binary has also been re-extracted and audited with the production decoder.

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

Desperate Alliance's corrected briefing uses the existing standard MBRF operations. No type-29 compatibility rule is needed.

### AI Data

- Patched `scripts\aiscript.bin`: 62,050 bytes and 293 inspected entries.
- BrooDat `scripts\bwscript.bin`: 26,458 bytes and 78 inspected entries.
- Desperate Alliance references `Ter3` at byte 6,874 and `Suic` at 28,794. The corrected patched binary has SHA-256 `635433e546998e05529a9d6acc806c06b528c7ce5075a206f6f2c8de44ffed6e`; its header table starts at 57,358. The bounded reachable-instruction audit finds 127 instructions/22 command types for `Ter3` and two instructions for `Suic`.
- Wasteland and Backwater Station have no explicit AI-script actions in the inspected active trigger streams. This is not a blanket claim that their enemy behavior requires no compatibility work.
- StarDat also has a legacy AI binary whose header differs from the later format. Do not label it corrupt because a later-format table parser rejects its first word.

## Download Strategy

The desired first-run sequence is application/engine, shared data if uncached, then only the selected mission's required assets. A player with the shared data cached should download just the additional mission content. Cache reuse is conditional on browser storage availability and eviction.

| Mission            | CHK Bytes | CHK + Referenced Audio: Stored MPQ Bytes | Decoded Bytes |
| ------------------ | --------: | ---------------------------------------: | ------------: |
| Wasteland          |    88,628 |                                1,145,976 |     3,581,936 |
| Backwater Station  |   105,877 |                                1,928,875 |     5,913,701 |
| Desperate Alliance |   143,911 |                           Not remeasured |     6,590,469 |

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

The table and numbered hazards in this section describe the research baseline. Current implementation results are recorded under Implementation Evidence below.

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
- [x] Round-trip a generated mission pack and decode/play its actual dialogue through the production path.
- [x] Confirm the required timing boundaries, pause/skip behavior, rescue rules, and the guard/combat orders activated by Wasteland against the checked references and runtime tests.
- [x] Verify Move Location direction and extent preservation with an authored native fixture. General custom-map compatibility remains outside this milestone.
- [ ] Resolve public asset-delivery authorization/range support before a public campaign release; local packs do not require resolving public hosting first.

The remaining technical gates have concrete owners and tests below. They are not product questions that need to block this document or require the user to explain implementation details.

### Implementation Evidence: Asset Preparation

Verified locally on 2026-11-04:

- [web/campaign_pack.cpp](web/campaign_pack.cpp) reads the embedded archive through a bounded reader, decodes the original scenario/audio, and writes a plain MPQ. It reopens every generated entry through the production reader and compares bytes.
- [web/prepare-campaign.mjs](web/prepare-campaign.mjs) verifies the source SHA-256, independently reads the output tables, checks CHK structure/operations, validates PCM lengths/formats/durations, and emits the ignored pack, manifest, and audit.
- The production reader now accepts uncompressed unencrypted MPQ entries. Compressed payload lengths exclude their method byte.
- The pack contains nine files, totals 3,582,624 bytes, and has SHA-256 `2045ab3a2a076d23ce1f895fea5ec9069539675d6e4482c16de49c8a60001c87`. Its decoded content totals 3,581,936 bytes. All eight WAVs pass RIFF/PCM metadata checks.
- Synthetic checks cover malformed sections/strings, append-versus-replacement sections, disabled conditions/actions, first-zero termination, owner preservation, and unsafe paths. Python runtime checks cover partial-word decryption and the independent scenario comparison.
- This checkpoint establishes pack preparation. Completed browser playback/network checks are recorded in the mission-runtime evidence below.

Commands:

```powershell
& .\web\build-wasm.ps1 -CampaignPack
node web/prepare-campaign.mjs --test
node web/prepare-campaign.mjs
```

### Implementation Evidence: Mission Runtime

Verified locally on 2026-11-04 for the Wasteland milestone:

- The explicit campaign entry point loads the mission overlay before shared archives, preserves slot 1/Terran and the original 46 actors, and injects no melee units or minerals. The original trigger grants 40 minerals.
- UMS race handling and zero-based CHK force normalization are corrected. Rescue-passive orders use a 64-pixel search box and the existing ownership-transfer helper. Placed Zerglings use the existing guard/combat path; no campaign AI substitute was added.
- Authored checks cover rescue range/ownership, Force/All Players/Current Player selectors, raw Exactly 10, Accumulate holdings, resource modifiers/underflow, disabled conditions, one-shot continuation, Move Location direction/extents, scripted pause, transmission modifiers, ordered events, and the earlier-trigger recheck when Wait starts.
- Elapsed Time uses 16 ticks per game second. Regular scans retain the 31-tick cadence; UMS first scans at tick 2. Waits use the checked Fastest 42 ms quantization and minimum two ticks. Script pause freezes the world while trigger waits continue.
- Eight fresh-state cases pass through the original mission triggers: all three missing-victory-requirement cases, full victory with real rescue transfer, all human units lost, Raynor lost, paused economy defeat at 399 minerals, and survival at 400.
- The browser-module runner covers 1,200 logical steps, separate briefing parsing, pre-Begin freeze, native capabilities, event acknowledgement, render-independent delivery, persistent objectives, actual WAV durations, native sound loading, and sound-handle reuse.
- The browser loads only Wasteland's manifest and pack as campaign content. A subsequent fresh mission session reused the verified cached pack with zero pack network requests. No campaign/CD archive or other mission was requested.
- Browser briefing text and narration were exercised: the first real voice clip decoded and started in Web Audio while the world remained at frame zero. Begin/Skip entered gameplay with the original 40 minerals. Portrait briefing layout passed at 390 x 640 with touch emulation and no horizontal overflow.
- Normal-control play demonstrated gathering, enemy attacks, Raynor rescue, replacement-SCV production, Barracks construction, five additional Marine trainings, and original-trigger victory. No resources or units were granted. Terminal state was ten Marines, one Barracks, human-owned Raynor, outcome 1, and completed mission `terran01` in persistent progress.
- Browser checks also passed defeat without progress writes, fresh retry at frame zero, quota-failed progress storage, unsupported-operation preflight, corrupt-pack rejection, cancelled download, runtime-failure stop/recovery, and preservation of the good cached pack.
- Touch-emulated briefing/gameplay was checked at 390 x 640 and 844 x 390. Expanded objectives initially overlapped narration; the corrected layout places captions beside or below the panel. The checked worker layouts have no control/objective/caption overlap or horizontal overflow. Actual iPhone testing remains open.

The briefing uses unit icons and speaker-name fallbacks rather than animated portraits. Briefing and gameplay share the stored base-duration/adjustment calculation. The action's `time` is the base; `group2` supplies Set/Add/Subtract adjustment, not the WAV length. Waits round up to 42 ms ticks; 0/42/43/84/85 ms boundaries pass. Camera changes are immediate rather than eased. Only Fastest is offered in campaign mode. Later missions remain unavailable.

Acceptance used the integrated Chromium browser on Windows. The normal-control victory occurred at world frame 22,817 on an intermediate build. The subsequent transmission-field and wait-boundary corrections passed the full original-predicate and browser-module suites; the long normal-control playthrough was not repeated after those timing corrections. The final ignored browser module has SHA-256 `a78f2dc6fd637c5974671c786afc0c42fa9fc0a02548b3279fff0692efe62a73`. Implementation milestone `5e33390f6808a3fb9612fe91467c12aa6a3e5ee8` is committed on `campaign`, based on `132f96b165cc051e8d9623f9e65150461a923784`. The user subsequently confirmed successful testing. No merge, push, public deployment, or proprietary-asset publication was performed.

Commands:

```powershell
& .\web\build-wasm.ps1 -SimulationTest
node web/run-sim.mjs --test-campaign
& .\web\build-wasm.ps1
node web/run-wasm-node.mjs --test-campaign
node web/run-wasm-node.mjs --test-commands
```

### Implementation Evidence: Backwater Prototype

Verified locally on 2026-11-04, committed as `928ef119265bde9632626ecb3fdda127bb343ac0` following `34d8402d5be7bdf771d0fbb5e166b2f97bb93736`:

- The existing preparation script now accepts `terran01` or `terran02`, derives the single human slot/race from OWNR/SIDE, and retains pinned source hashes and path validation. No duplicate preparation tool or new UI flow was added.
- Backwater's corrected CHK hash is `d8a7f6b70422ff32e4fd3f6293de4013f883e0761814d4496ffd18b7eb13dfce`. The pack round-trips 22 files, including 21 PCM WAVs. It totals 5,915,109 bytes; decoded content totals 5,913,701 bytes. Pack SHA-256 is `0a702bea4d1a96cc9268f29fe6ab11bbd81752312c394c134450fac3e41e408e`.
- Its 98 UNIT records contain four start markers and 94 placed actors: ten human units, one rescuable Raynor, seven rescuable station units, 61 enemy units/buildings, and 15 neutral resources. Human slot is 1/Terran; rescue players are 2 and 3; the Zerg computer is 4. Normal loader processing naturally rescues nearby Raynor, so the initialized human count is 11 and rescue-slot-2 count is zero.
- The regenerated operation set is conditions 1/2/3/11; actions 1/2/4/5/7/8/9/10/11/12/13/23/26/30/31/38/43; briefing actions 1/2/3/4/5/6/8. No active AI-script action is present.
- Added and tested native countdown/switch state, countdown and switch conditions, set/clear/toggle switches, invincibility, and quantity-aware kill-at-location. Existing Bring handling and whole-station depot rescue pass original-map fixtures.
- The native Backwater harness now uses normal initial world processing; no AI bypass remains. A 1,200-tick idle check preserves the original enemy force and obtains 200 minerals and 200 gas through the original initialization trigger.
- The blocked unit is `Zerg_Infested_Command_Center`, ID 130, not a Hatchery. Earlier descriptions of that ID were incorrect. Its unscripted ComputerAI path retains the order and services queued orders without inventing production. It is restricted to buildings whose human idle behavior is Nothing; other unsupported AI behavior still errors.
- Property-aware creation now uses the existing creation helper and stored UPRP slots. Explicit quantities and hitpoint/invincibility overrides pass authored checks. A zero quantity in legacy format 59 is interpreted as one creation; property index zero means no overrides. This is a reasoned compatibility inference from the repeated original actions and the documented reinforcement totals, pending classic comparison. Other ambiguous zero counts and unsupported property states still error.
- Eight fresh original-map cases pass: idle negative; station rescue yielding five Firebats and two additional SCVs; infested-target destruction through the paused victory ending; Raynor-loss defeat; Marine discovery dialogue; Firebat discovery dialogue; Raynor-only dialogue exclusion; and a placed Zerg guard engaging an approaching Marine. Temporary discovery revealers are removed by the original kill-at-location action. Some fixtures protect units to isolate dialogue/reinforcement assertions; they are not normal-play victory evidence.
- The shared browser-module runner validates normal initialization, original 200/200 resources, briefing modifiers, ordered/acknowledged events and native audio. Browser startup reaches the real briefing at frame zero and Begin advances gameplay with no page errors. Only the selected Backwater manifest/pack was requested as campaign content; no full CD archive was requested.
- Normal browser controls gathered additional minerals and queued a Marine from the original Barracks. Defeat through resign left campaign progress unchanged; retry returned to Backwater's briefing at frame zero with no pack refetch or Wasteland request. The final fresh startup had no page errors. These checks do not replace the full normal-control/classic comparison playthrough.
- The Backwater-ready ignored browser module has SHA-256 `36a3b20c52a81a54133fe3c1a061822da9c3f0b456d72b1e1403e38de2029f60`. The user subsequently completed the mission and approved this playable milestone. No new public asset delivery, full strategic AI, UI/mobile polish, onboarding, or linked mission progression was added.
- Known comparison issue reported by the user: idle defenders visible near the northeast enemy base do not assist when their buildings are attacked until the player approaches their acquisition range. The existing reactive-guard fixture tests proximity engagement only, not group assistance. Preserve this observation for the classic comparison; do not widen acquisition ranges or add speculative assistance/waves before establishing the intended behavior.

#### Narrow Behavior And Classic Comparison

The [StarCraft Wiki mission walkthrough](https://starcraft.fandom.com/wiki/Backwater_Station_(mission)) and [StrategyWiki walkthrough](https://strategywiki.org/wiki/StarCraft/Backwater_Station) describe a fight through placed Zerg groups, rescue of the station, five Firebats/two SCVs, and destruction of an infested Command Center. These are behavioral references, not engine traces or code sources; walkthrough strategy is not a requirement to script attacks.

The scenario contains no Drones and no active Run AI Script action. The provisional target is therefore a placed defending force and a passive unscripted infested building, not a growing melee base or invented timed waves. Exact pursuit/return ranges and the absence of all autonomous production remain classic-comparison items. A full strategic AI VM is not claimed.

Compare these points in classic StarCraft before treating the prototype as faithful:

1. Initial Raynor ownership and enemy activity while the player waits. Check production, construction, attack waves, and guard pursuit/return behavior separately.
2. Station ownership transfer, five Firebats, two additional SCVs, spawn positions and timings. This directly tests the inferred format-59 zero-quantity rule.
3. Marine versus Firebat discovery dialogue, the Raynor-only exclusion, and the timing/visibility of temporary revealers.
4. The infested Command Center's appearance, properties and destruction ending. Victory depends on Force 2 having no unit of type 130, followed by the original paused multi-transmission sequence; approaching it or rescuing the station alone must not win.
5. Raynor loss, paused defeat, retry, briefing/audio, and normal mining/building/combat. Record mismatches and add focused regression cases before revising behavior.

Retain this comparison process for the later sequential mission playtest. UI/mobile optimization, onboarding and linked mission flow remain deferred.

Commands:

```powershell
node web/prepare-campaign.mjs terran02
& .\web\build-wasm.ps1 -SimulationTest
node web/run-sim.mjs --test-campaign terran02
node web/run-wasm-node.mjs --test-campaign terran02
```

All four commands now pass. Proprietary packs, manifests, and detailed audits remain ignored under `web/data/campaign/`.

### Implementation Evidence: Desperate Alliance Prototype

Implemented on 2026-11-04 after the accepted Backwater commit. The user authorized publication after further source-backed AI improvements and validation. This is a tested implementation milestone, not evidence of an unassisted victory or exact classic-game difficulty.

- The corrected original CHK round-trips with 16 PCM WAVs: 17 files, 6,591,797 pack bytes and 6,590,469 decoded bytes. Pack SHA-256 is `ff008ea7ab5466784e85066924d0f1b8deca1153496103d092ab0c7800cb75ed`. The old 14-WAV profile and briefing anomaly are superseded.
- Human slot is 1/Terran and computer slot 4/Zerg. The 199 UNIT records include three start markers, leaving 196 placed actors: 34 human, 135 enemy and 27 neutral resource records. Normal initialization now passes. Native Hatchery processing also creates Larva; do not remove them to force raw source counts.
- The original gameplay uses conditions 1/2/5/11 and actions 1/2/4/5/7/10/11/12/13/14/15/16/26/28/30/31. Its opening countdown is 1,800 game seconds. Countdown thresholds include 600, 300, 120, 60 and zero; victory/defeat must still come from the original triggers.
- Set Countdown Timer action 14 supports Set/Add/Subtract with zero-clamped subtraction and overflow rejection. Set-to-1,800, addition and subtraction checks pass. The HUD reads native countdown state and hides the timer in missions that never activate it. JavaScript does not maintain a second countdown.
- Kills condition 5 now reads per-player/per-type credits from ordinary lethal damage. Checks cover Force 1 building kills, exact unit types, Men/Any Unit groups, nonlethal hits, repeated damage, captured projectile ownership after its source unit disappears, friendly fire and staged scripted deaths. Counters reset with scenario state. Instant-death spell scoring and complete end-game score/HUD statistics are not claimed.
- The existing preparation utility now supports `--audit-ai`, extracting the local patched binary, validating its hash, and recording only ignored local output. Its auditor checks header bounds, duplicate IDs, command operand bounds, overlapping instruction targets and reachable control flow, including parallel threads. Synthetic checks include a multirun fixture and malformed branch/header cases.
- `Ter3` reaches town/campaign setup, `build`, `tech`, eight defense request/use commands, attack clearing/addition/preparation/execution, `capt_expand`, default/max-force controls, frame waits and goto. It does not use a `train` command; production requests cannot be inferred only from that opcode. `Suic` executes `send_suicide` and stops. Command encodings were cross-checked against the [PyMS classic command definitions](https://github.com/poiuyqwert/PyMS/blob/master/PyMS/FileFormats/AIBIN/CodeHandlers/CodeCommands.py) and operand types; no external implementation was copied.
- The [StarCraft Wiki mission guide](https://starcraft.fandom.com/wiki/Desperate_Alliance) and [StrategyWiki guide](https://strategywiki.org/wiki/StarCraft/Desperate_Alliance) describe a thirty-minute defense, two approaches, increasing ground/air attacks and a final assault near two minutes remaining. These constrain the provisional target, not exact AI scheduling or wave sizes. Use the actual script and normal production; do not replace them with hand-timed unit grants.
- A native bytecode interpreter reads the shared patched AI binary through the existing data loader. It resolves actual script entries, preserves frame waits and goto, and executes the required town, production, defense and attack commands. Unknown entries, unsupported opcodes, invalid operands and excessive per-frame execution fail explicitly. No network reads occur inside the simulation.
- Town requests use native worker orders, build validation, resource costs, supply, tech requirements, placement and timed morph/construction. A fixture removes one Drone and observes its normal egg replacement. Another destroys the original Hydralisk Den and observes incomplete construction followed by a completed replacement. The 5,000 mineral/gas AI budget comes from the original trigger, not a new grant.
- Attack preparation recruits actual available units and rallies them to a native pathing region. Readiness uses region membership, not the former fixed 128-pixel radius. `attack_prepare` can launch the party; `attack_do` waits without launching it again. Compositions and waits come from `Ter3`. Active defenders and units with live combat targets are excluded from recruitment. The shared target supports mixed ground/air parties, including attacks on lifted buildings. Idle survivors continue toward live targets rather than parking at a cleared destination.
- Defense now follows native pathing regions rather than one building's sight rectangle. Primary buildings and workers establish defended regions; static colonies/turrets do not create primary town regions. `capt_expand` extends coverage to neighboring regions. GG/AG/GA/AA distinguish terrain walkability and enemy flight. Regional demand aggregates native base strengths, with independent ground/air `max_force` caps. Unique defender assignments prevent double allocation and protect active defense from attack recruitment. Only remaining shortfalls request production; cleared regions release defenders toward their previous positions.
- Computer Larva retain their AI order while using native Larva movement and queued morph commands. Overlords use their native transport-idle handling while retaining AIPatrol. This is not autonomous Overlord scouting. Other unsupported ComputerAI/AIPatrol roles still error.
- Minimap action 28 emits an ordered mission event and uses the existing native position-only alert renderer. It creates no dummy unit and changes no fog. Countdown and expanded objectives fit with narration at 1280 x 800 desktop and 390 x 640 touch-emulated viewports. Both canvases were nonblank; no overlap, horizontal overflow or page errors were observed.
- Native checks cover original startup and town requests, actual resource gathering, timed worker replacement, tech rebuilding and the first ground attack. Thirteen fresh-map cases cover original outcomes, the full unshortened timer, shared destinations, all four defense categories, independent regional budgets and defender allocation/release, mixed-party air capability, engaged-guard exclusion, region-boundary grouping, military retargeting and unprotected combat. Survival fixtures protect human actors to isolate the ending; this is not normal-control victory evidence.
- The unprotected no-player-orders diagnostic confirms weapon fire from deployed waves at frame 3,530. It reaches defeat at frame 17,073 with no human actors left. These are observed results, not required classic timings or a target used to increase difficulty. No resource grants, invincibility or replacement waves are used in that diagnostic.
- The T3 browser-module check passes original actors, 100 starting minerals, pre-Begin freeze, briefing/audio, 1,200 logical steps, countdown progression and ordered pings. Actual browser Begin, paused resign and fresh Retry pass. Defeat does not save completion; Retry reuses the cached T3 pack and returns to its own briefing. Touch emulation and test frames were removed afterward.
- Both earlier missions' native and browser-module checks pass, as do the existing command/melee regressions. Backwater's unscripted defender-assistance behavior remains unchanged. Proprietary content, generated audits/packs and WASM binaries remain ignored. Publish only source/plan changes to the existing `campaign` branch with the personal signing identity.

#### Source-Backed AI Scope

The regional and coordination changes use three complementary references. The [PyMS command definitions](https://github.com/poiuyqwert/PyMS/blob/master/PyMS/FileFormats/AIBIN/CodeHandlers/CodeCommands.py) specify category contracts, attack waits and force limits. Teippi at `05c006c2f74ad11285c39d37135aed03d1fb8806` documents [region/military structures](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/ai.h), [shared attack regions and available-unit constraints](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/ai.cpp), and [guard return behavior](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/unit_ai.cpp). AISE at `b3fc7c47f7c12c6b4900df281f6539e3a4263d1c` supplies [reverse-engineered campaign regional-demand calculations and town-region rules](https://github.com/neivv/aise/blob/b3fc7c47f7c12c6b4900df281f6539e3a4263d1c/src/ai.rs). Only behavior contracts are reused; external implementation was not copied.

This remains a mission-scoped implementation, not StarCraft's complete regional state machine. Placement retains a bounded town-center search. Exact enemy-region ranking, update cadence, spending queues, detailed guard replacement and campaign micro are not verified byte-for-byte. Autonomous Overlord scouting, transport strategy, general expansion logic and unrelated script commands are not implemented. The tests establish the documented contracts and working mission pressure; they do not prove identical difficulty.

For the later classic comparison, record attack launch/arrival times and compositions, air attacks, the final assault, tech destruction/rebuilding, defender assistance and Overlord movement. Normal-control victory and physical-device acceptance remain open. Publication of this source-backed milestone does not close those comparison items.

Reproduce the content/AI audit after building the existing preparation utility:

```powershell
& .\web\build-wasm.ps1 -CampaignPack
node web/prepare-campaign.mjs --test
node web/prepare-campaign.mjs terran03
node web/prepare-campaign.mjs --audit-ai
& .\web\build-wasm.ps1 -SimulationTest
node web/run-sim.mjs --test-campaign terran03
& .\web\build-wasm.ps1
node web/run-wasm-node.mjs --test-campaign terran03
```

### Follow-Up Fixes And Mission 4

The 2026-11-04 comparison identified three local presentation/input defects. Pointer-mode changes cleared an armed Attack target, so the first click could cancel it. The native mode setter now preserves targeting and placement. Both mode directions pass a first-click Attack regression, together with the existing desktop and mobile command checks.

Mixed-selection acknowledgements now prefer an owned selected hero without changing the unit that drives commands or construction. A Backwater fixture records actual native clip handles and verifies Raynor's movement acknowledgement with a Marine selected first. The fixture advances only its audio clock to exercise the existing 80 ms repeat guard; mixer channel equality is not clip identity.

Attack alerts now resolve separate base and forces clips for each race. Building damage uses `*AdUpd00`; field-unit damage uses `*AdUpd01`. Off-screen gating and the existing shared cooldown remain unchanged. The earlier comment incorrectly described `*AdUpd00` as a forces alert.

Original-data inspection found 13 explicitly burrowed Zerglings in Backwater's UNIT records and no pre-burrowed placements in Desperate Alliance. The loader currently ignores the burrow state. An experimental restoration did not validate the subsequent ambush transition and was removed. No experimental burrow code, range increase, extra wave or source-map edit is retained. Desperate Alliance's discretionary burrowing remains an AI comparison item, not an authored placement fix.

Mission 4, The Jacobs Installation, now runs through the existing campaign loader, briefing, audio, selector and retry paths:

- Raw CHK SHA-256: `a48e1d1682f0a6e68eeec4ef0fc82efc48e70a11b4315de8c091079c68e10601`. The production-codec round trip verifies 18 files, including 17 PCM WAVs. The plain pack is 4,949,273 bytes, decoded content is 4,947,929 bytes, and pack SHA-256 is `35a0dca6d179ff3ad7acada3f8a7616cc4db3f0d94940fb9e02624bd79e85bf4`.
- The scenario has 100 UNIT records, 36 gameplay triggers and one briefing. Human slot is 0/Terran. Conditions are 2/3/11/12; actions are 1/2/3/4/5/6/7/8/9/10/11/12/13/22/28/30/31/38/39/42; briefing actions are 1/3/4/5/6/8. No active strategic AI-script action is present.
- The [mission walkthrough](https://strategywiki.org/wiki/StarCraft/The_Jacobs_Installation) describes retrieving data with Raynor alive, placed defenders, security traps, door terminals and teleporters, without a buildable economy. Treat this as a behavioral reference; retain the original triggers and units.
- The original THG2 section contains 36 doodads/sprites. Its two authored disabled floor traps retain their native disabled flag and Disable animation. Normal initialization runs without skipping objects, unsupported orders or world processing. Marine Raynor is rescued naturally at startup.
- HiddenGun uses the native random target-acquisition helper and a 15-tick scan timer. Reveal/Hide animations wait for order-signal bit 1, then release their non-interruptible order before advancing the queued weapon/idle orders. Disabled traps remain concealed and cannot fire. Security changes queue behind non-interruptible animations; queued EnableDoodad can progress through the disabled-unit guard.
- Door animations and sounds use their native DAT/iscript data. Open/Close changes collision only after the animation signal. Original-map checks verify actual native passability, not only flags. Doodad action 42 respects the requested type/location and includes neutral-owned installation doors without changing active-player condition semantics.
- Format-59 action-42 modifier zero is interpreted as Disable. This is a compatibility inference from the original door-opening/security-shutdown records and the mission behavior reference, not a verified general encoding rule. Modern Enable/Disable/Toggle values remain distinct. Compare the original terminal sequence on classic before extending the inference to other formats.
- Move Unit action 39 collects matching actors before relocating them. Quantity zero means all; explicit quantities remain bounded. Native placement searches from the destination region, as in Recall, so groups can cross disconnected installation regions. Movement paths, position-dependent occupancy and stale target references are refreshed; failed placement leaves the actor at its source.
- The original ending creates its data disk through the existing unit-creation path. Powerup completion stores its origin and native idle order. This does not claim general powerup pickup or Capture the Flag support.
- The [GPTP doodad-order reference](https://github.com/BoomerangAide/GPTP/blob/master/GPTP/hooks/orders/doodad_orders.cpp), inspected blob `7607574c2a4baf23955f23bbd677e1d34e4a91ae`, supplies trap/door animation and state contracts. Its [status constants](https://github.com/BoomerangAide/GPTP/blob/master/GPTP/SCBW/enumerations.h) identify doodad state `0x400`, matching the existing disabled flag. The [Teippi flingy reference](https://github.com/neivv/teippi/blob/master/src/flingy.h) distinguishes SetSpawnFrame's nearby facing waypoint from SetFlDirect's immediate heading. The implementation reuses this engine's existing 16-pixel waypoint calculation. External implementation code was not copied.
- The native runner passes door collision/animation boundaries and teleport quantity/placement checks, plus seven fresh original-map cases: idle, data retrieval victory, Raynor loss, whole-squad loss, Bring-triggered teleport, trap combat/state transitions and the Zerg-elimination dialogue. Victory and teleport fixtures position and protect actors to isolate authored predicates; they are not normal-control playthroughs.
- The browser-module runner preserves slot 0, seven Marines, four Firebats and naturally rescued Raynor, with no SCVs or injected resources. It validates capability preflight, briefing narration WAVs, objective events and idle rendering. Unlike the earlier missions, Jacobs has no elapsed-time opening transmission; its location-driven dialogue is not replaced with invented idle speech.
- Integrated-browser checks pass briefing at frame zero, Begin, nonblank gameplay, paused resign without completion writes, and fresh retry at frame zero with zero pack network requests. Desktop and 390 x 640 viewport checks show nonblank rendering and no objective/control overflow. Physical-device testing remains open.
- Preparation is reproducible at the pack size/hash above. Native and browser campaign suites for missions 1-4, the full command suite, and preparation checks pass. Only the existing compiler warnings remain. All mission assets and generated WASM stay ignored. The user authorized the milestone commit; pushing, merging and deployment were not requested.

The user reported three issues after playing Jacobs. The following corrections retain the original scenario:

- Bound keydowns and command-card clicks now process input immediately. Attack arms before the next browser frame rather than waiting for rendering. Integrated-browser checks dispatch a hotkey or full button mouse sequence and its target click in one task; both emit Attack and preserve ordinary versus Shift-queued orders. The native runner also covers held/released A followed by a click without an intervening render. Native FIFO tests alone did not expose the delayed browser activation.
- The Zerg dialogue runs when player 3 has no units and the ending-suppression switch is clear, not simply on first sight. The original sequence moves location 30 onto player 0's Marine Raynor found in Anywhere, then centers the view there.
- The disk victory sequence also moves location 30 onto Raynor. Its intended subject is Raynor, not a hardcoded disk position. Move Location had reversed the source and destination fields; corrected action 38 now searches `location` and moves `group2_n`. Typed searches also reject nonmatching powerups normally rather than aborting when the newly created data disk is encountered.
- The original Zerg and disk sequences now compare camera targets with Raynor's position at the Center View event. The raw action-field regression also verifies that Anywhere stays unchanged. The older authored Move Location fixture encoded the same reversed assumption and was corrected to match the original scenario.

Remaining Jacobs comparison: verify door/security terminal order, trap detection/facing and teleporter behavior against classic. Keep the burrowing investigation dropped as requested. Do not infer exact classic fidelity from protected outcome fixtures.

### Implementation Evidence: Revolution

Revolution uses its original scenario, briefing and AI binaries through the existing campaign host. The new runtime support is limited to the operations and Terran production paths this mission exercises. No source-map edit, resource grant, replacement wave, initialization bypass, or README change was added.

- Original CHK SHA-256 is `35cd98bc0590c0f36e5d8f75e41a29b254db2d6cf8dec5480e6ffd7602609829`. Its 172 UNIT records include four start markers and 168 actors: eight human Marines, two rescuable heroes, 39 neutral Antigan actors, 78 Confederate actors, and 41 neutral resources. Human slot is 0/Terran. Raynor is naturally rescued at startup; Kerrigan remains separately rescuable farther south.
- The production-codec pipeline verifies 18 pack entries, including 17 PCM WAVs. Pack size is 4,732,129 bytes; decoded content is 4,730,785 bytes. Pack SHA-256 is `db96077bba93fd3b6bfcd76241fb80a970124fb016f3d16a362a1c4808ea8209`. The existing preparation tool now pins this profile and can derive mission-specific AI IDs with `--audit-ai terran05`.
- Seventeen original gameplay triggers use conditions 2/3/11/12 and actions 1/2/4/5/6/7/8/9/10/11/12/13/15/16/22/24/26/30/31/39. The briefing uses 1/3/4/5/6/8. The original initialization grants 300 minerals and 300 gas. Idle opening dialogue is location-driven, not an elapsed-time transmission.
- Required scripts are `Rscu` at 28806, `Ter5` at 7194, `Te5H` at 7477, `EnBk` at 28810, and `ClrC` at 28814. The bounded audit finds 103 main-town instructions, nine satellite-town instructions, and two instructions in each utility script. The existing pinned patched AI binary remains unchanged.
- Eligible neutral/rescuable scenario owners now receive and service their original trigger instances. Combat/victory player enumeration remains separate. This is required for Antiga's neutral owner to execute Rscu after Kerrigan's beacon sequence; Rscu changes the controller and assigns native RescuePassive orders rather than directly granting ownership.
- EnBk sends eligible infantry to same-owner, in-location bunkers through native EnterTransport. Pending entrants reserve capacity. ClrC clears in-location military assignments without clearing the owner's unrelated force. Dedicated original-map checks cover both startup loading and the ClrC boundary.
- Main and satellite build requests remain independent. Military coordination remains player-wide. Terran production uses native SCV PlaceBuilding, secondary Train, add-on PlaceAddon and race-correct supply requests. Workers do not choose unreachable resources or interrupt active construction/repair. Fixtures verify a fourth satellite SCV, completed Machine Shop/Control Tower, and local replacement of the destroyed satellite Command Center.
- Scripted ground parties cannot walk to the Antigan island. Native Dropships are produced on demand, then board, fly, unload and return using existing orders. Passengers and flights use generation-safe unit IDs. Bunker occupants do not satisfy available attacking force counts. The original wave quantities and waits remain unchanged; the long fixture observes the original first-ground/first-air schedule, actual island arrival and native weapon fire.
- Transport demand, its current three-ship cap, nearest reachable bunker selection, rectangular town membership and bounded construction placement are explicit implementation policies. They are not verified replicas of classic AI's transport scheduling or town assignment. The [PyMS command definitions](https://github.com/poiuyqwert/PyMS/blob/master/PyMS/FileFormats/AIBIN/CodeHandlers/CodeCommands.py) supply script contracts. The [Revolution behavior reference](https://strategywiki.org/wiki/StarCraft/Revolution) corroborates separate Kerrigan rescue, the cloak/Lockdown infiltration route and later Confederate transport attacks. External implementation code was not copied.
- Kerrigan's card now uses native hero ability eligibility for Cloak and real targeted spells, instead of excluding her through the ordinary Ghost ID. The Nuclear Strike special case keeps its separate caster check. The headless browser runner verifies normal movement/proximity rescue, Cloak/Decloak and Lockdown availability without research grants. Integrated-browser normal movement also rescues Kerrigan; cloak spends energy and follows native state. The original rescue dialogue can pause the world during the transition.
- Native checks cover startup, original beacon/base rescue and captured infantry, both town economies, real transport-supported ground/air combat, idle exclusion, Kerrigan loss, Raynor loss, squad loss, original Confederate-building victory, location-scoped combat clearing and satellite reconstruction. Combat fixtures protect actors through native defensive-matrix HP or restore target HP to isolate the scripted behavior while retaining attack eligibility; they are not normal-control victories.
- Browser checks cover original startup and resources, capability preflight, packed briefing narration, persistent objectives, nonblank desktop rendering, paused resign without completion writes, and fresh retry at frame zero with zero pack network requests. The 390 x 640 viewport has a nonblank resized canvas and fits expanded objectives plus all seven Kerrigan controls without horizontal overflow. Native and browser suites for missions 1-5, the full command suite and preparation synthetic checks pass. Only the existing compiler warnings remain. Physical-device testing remains open.

Remaining Revolution acceptance: complete the route using normal controls and compare bunker allocation, town placement, drop cadence/landing sites and campaign balance against classic. The user authorized a signed milestone commit and push before mission 6 implementation; publication does not claim completed normal-control or classic acceptance. Proprietary archives, mission assets, packs and WASM remain ignored. Merging, deployment, burrowing, UI polish, onboarding and linked mission progression stay deferred.

Commands:

```powershell
node web/prepare-campaign.mjs terran05
node web/prepare-campaign.mjs --audit-ai terran05
& .\web\build-wasm.ps1 -SimulationTest
node web/run-sim.mjs --test-campaign terran05
& .\web\build-wasm.ps1
node web/run-wasm-node.mjs --test-campaign terran05
node web/run-wasm-node.mjs --test-commands
```

## Reusable Implementation Lessons

### Norad II Evidence

The sixth mission retains its original scenario and scripts. The new engine work supports the additional operations it actually exercises. User playtesting of Revolution and Norad II will follow publication; the automated fixtures do not claim exact classic acceptance.

- Original CHK SHA-256: `80dd42e4d4540d0340113b92aae02120b9919a5dac359b010607ec7c26e72ead`. The audited scenario has 221 UNIT records, 20 gameplay triggers, one briefing and 24 WAVs. The 25-entry pack round-trips at 6,846,575 bytes, decoded content 6,845,119 bytes, SHA-256 `c72cf55d039b17ece9b170ebad301652e942fa72403fd6dc058e8af40370efa6`.
- Human slot 0 starts four Marines, one Firebat and two SCVs; Raynor's enhanced Vulture is naturally rescued. The crashed Norad II is the original special unit 126, not the flying hero unit 29, and remains separately rescuable. The opening trigger gives 75 minerals and no gas.
- `Ter6` and `Te6b` each have 94 reachable instructions and run for the two original Zerg owners. Rscu retains native rescue-controller behavior. The existing preparation command audits all required IDs from the verified pack; no original binary or wave request was modified.
- Condition 15 now reads victim-owned Deaths separately from credited kills. Specific types and the original Buildings group use existing comparison/player-group logic. The shared fixture checks scripted deaths, lethal victim counts and repeated Die requests without double-counting.
- AI opcode 7 retains requested upgrade levels and executes native paid Upgrade orders, including cost, prerequisites, construction time and completion. Both original Zerg scripts start and complete their requested first upgrade; their script-driven attacking units fire native weapons in the sustained combat fixture.
- Original Create Unit property records at the crash site request burrowed Zergling/Hydralisk reinforcements. The runtime enters native Burrowing and uses native visibility, attack eligibility, acquisition range and Unburrowing/attack orders for computer emergence. A fixture applies the original UPRP record and verifies state and emergence. No Backwater placement restoration, acquisition-range increase or replacement wave was added.
- Briefing action 7 identifies the existing portrait slot as speaking in the static portrait fallback without blocking the original briefing clock. Animated portraits remain deferred. The browser-module fixture validates the full original briefing action set and real packed narration.
- Fresh-map fixtures cover idle, Raynor with zero or one Dropship, the original paused victory with Raynor plus two Dropships, Raynor loss, flagship loss, squad loss, authored reinforcements, and native flagship rescue/repair. The repair workflow mines original minerals, constructs a Refinery, harvests actual gas, and pays native repair costs; the original rescued base contains an Engineering Bay rather than an existing Refinery.
- Native and browser-module suites for missions 1-6 and the complete command suite pass on the merged baseline. Only existing compiler warnings remain. Protected outcome/combat fixtures isolate semantics, not normal-control victory or exact classic balance.

Publication order remains: signed Norad II milestone first, then a separate live campaign-delivery fix. Norad II is published as `53048c051f20961598659c6230a65bb050b76781`. The previous container omitted ignored campaign manifests/packs and returned 404; a container revision alone did not publish those assets. The user reports a 5-7 minute rollout delay after campaign pushes. Original archives, dialogue, mission packs, generated WASM and temporary signature trust files stay uncommitted.

### The Trump Card Evidence

Mission 7 uses the unchanged retail The Trump Card scenario and its original trigger and AI scripts. Public mission ID `terran07` maps explicitly to archive directory `terran08`. The archive's `terran07` is the unused prerelease Biting the Bullet, not the seventh playable mission. Its version-57 probe is not retained or enabled. The [hidden-mission reference](https://starcraft.fandom.com/wiki/Hidden_Missions#Biting_the_Bullet) corroborates the directory ordering; the actual source names and objectives were checked independently.

- The 171,895-byte version-59 CHK has SHA-256 `dab280d946f059845ba3084da11f159091bfbc24c4cd54eb2a352ff1a165f515`. Independent Python MPQ decoding matches the production C++ decoder. No scenario bytes, ownership, wave quantities, or version fields were rewritten.
- Original data contains 213 UNIT records, ten gameplay triggers, one briefing and sixteen WAVs. The seventeen-entry pack round-trips at 7,219,925 bytes, decoded content 7,218,597 bytes, SHA-256 `786096b3de48a5c905792967647ca59b834fd234858e325b96bdd6166fe749f0`.
- Human slot 0 starts eleven Marines, five SCVs, two Vultures, a Science Vessel and its original base/outposts. Kerrigan is naturally rescued during startup. The original opening gives 170 minerals and no gas, then creates the psi emitter at the authored SCV location. No carrier or resources are granted outside those triggers.
- The required scripts are `Ter8` at 8592, with 124 reachable instructions, and `EnBk` at 28810. AI opcode 9 now waits for completed units in the script's town without creating a build request. Native Control Tower construction releases the actual wait; scripted paid upgrades and both ground/air parties subsequently complete and fire native weapons. Original script bytes and waits remain unchanged.
- PowerupIdle searches the native 24-pixel area for an eligible completed, non-burrowed, non-hallucinated worker without another powerup. Pickup reuses the hidden-unit list, worker item pointer, carrying flag and native carried overlay/offset helpers. The spatial search ends before hiding the item. Worker death drops the surviving emitter at the worker position, and another original SCV can recover it.
- The [powerup-order reference](https://github.com/BoomerangAide/GPTP/blob/master/GPTP/hooks/orders/powerup.cpp), inspected blob `51ef863201e6293c10c3ee682a12eec3eb6d321d`, supplies pickup and overlay contracts. External implementation code was not copied. General Capture the Flag scoring and timed flag-return behavior remain unsupported; this milestone exercises the authored psi-emitter workflow.
- CHK location masks use bits 0-2 for ground and bits 3-5 for air; a set bit excludes that elevation. The shared helper had reversed those groups. The [CHK location reference](https://wiki.staredit.net/wiki/Scenario.chk#%22MRGN%22_-_Locations) and original beacon mask 56 establish the correction. Paired checks admit a ground SCV and exclude the original Science Vessel. Existing Bring accounting then recognizes the carried emitter without a mission-specific predicate.
- This correction also restores Revolution's original air-only activation: trigger 9 sets switch 6 when a human flying unit enters location 18. Ground base rescue alone does not start the Confederate towns. Its two affected fixtures now use the original Kerrigan/base rescue and rescued Wraith's native flight, rather than a ground Marine shortcut. Independent towns, native production, drops and satellite reconstruction still pass.
- Eight fresh-map checks cover idle, an empty worker at the beacon, emitter delivery, Kerrigan loss, force loss, carrier-death recovery, native transport loading/unloading, and the original completed-building wait. Cargo flying over the ground-only beacon does not win; unloading the emitter SCV does. Outcome fixtures protect or position actors; sustained combat refreshes defensive-matrix HP. These checks are not normal-control victory evidence.
- Native and browser-module suites for missions 1-7, the complete command suite, and preparation safety tests pass. Integrated-browser checks pass frame-zero briefing, Begin with original resources, nonblank desktop and 390 x 640 rendering, expanded objectives without horizontal overflow, paused resign without completion writes, and fresh retry with zero pack requests. No JavaScript errors occurred. Physical-device testing remains open.

Remaining comparison: complete the route with normal controls and compare pickup edges, transport-loss recovery, computer micro and campaign balance against classic. Existing bounded town placement and transport policies remain provisional. UI polish, onboarding, animated portraits and linked mission progression are not part of this milestone. Archives, audio, generated packs and WASM remain ignored.

### The Big Push Evidence

Mission 8 runs the original The Big Push scenario through the existing campaign loader. Public ID `terran08` maps to archive directory `terran09`, continuing the retail ordering after the unused Biting the Bullet entry. No map, trigger, AI binary, wave request or starting resource was rewritten.

- The version-59 CHK is 216,795 bytes with SHA-256 `083be62ec869ddf049f816eaf873355c57381b869581717234f3499b39ab23c7`. Independent Python MPQ decoding matches the production C++ decoder. The original 128 x 128 map contains 281 UNIT records, thirteen gameplay triggers, one briefing and fifteen WAVs.
- The sixteen-entry pack round-trips at 4,503,625 bytes, decoded content 4,502,825 bytes, SHA-256 `23e1985103b4e77c8b088584ee07d1b610ea02bec436686ecb1dac52eb4815cf`. Preparation pins this profile and audits both referenced scripts.
- Human slot 0 starts four Marines, two Ghosts, four SCVs, three Wraiths, two Dropships and six airborne buildings. Duke's original Norad II hero Battlecruiser is naturally rescued, retaining its original display color. The opening trigger grants 250 minerals and 100 gas. There is no survival countdown or elapsed-time opening transmission; the arrival line uses the authored add-on-area Bring condition.
- All six starting buildings explicitly have the valid in-transit flag. UNIT loading previously ignored it. The loader now applies the shared native liftoff state transition: flying/movement flags, elevation, collision/index refresh and airborne shadow offset. Authored coordinates stay unchanged. Normal liftoff reuses the same helper; no delayed liftoff order or world-initialization bypass is added.
- Native landing already supports abandoned add-ons. The original two Nuclear Silos, Control Tower, Covert Ops and Machine Shop are claimed by landing their compatible original buildings. The fixture checks actual grounded state, attachment pointers and ownership. An original SCV then boards an original Dropship, unloads on the new base platform, mines original minerals and returns them to a landed Command Center.
- `Tr9H` at 9138 has 84 reachable instructions; `Tr9L` at 8958 has 57. Both use existing supported opcodes. Original Deaths conditions or the 180-second fallback activate their switches and resource initialization. Sustained verification observes weapon fire from both scripted forces, including the light force's air wave, within bounds derived from original waits and grouping deadlines.
- Fresh-map checks cover idle, Duke loss, human-force loss, both Confederate building forces destroyed, one force remaining, and native fleet relocation/economy/combat. The original paused victory and defeat sequences execute without replacing their predicates. Outcome actors are protected; the combat fixture uses refreshed defensive-matrix HP while keeping targets attackable. These are not normal-control victory claims.
- The browser-module runner checks the original 22 human actors, six native Land controls, Duke's Yamato control, required capabilities, speaking-portrait briefing action, packed narration and exact resources. Idle rendering emits objectives but does not invent an arrival transmission. Original-campaign expansion-unit restrictions and rescue-color behavior remain intact.
- Native and browser-module suites for missions 1-8, the complete command suite, and preparation safety tests pass. Actual eight-mission startup preparation produces exactly eight matching manifests and eight packs, with no source archive or audits in public output. Only existing compiler warnings remain.
- Integrated-browser checks pass frame-zero briefing, Begin, native Land/Cancel, nonblank desktop and 390 x 640 rendering, expanded objectives without horizontal overflow, paused resign without completion writes, and fresh retry with zero pack requests. Resizing keeps the existing camera origin; the small-screen capture was framed on the selected building through the normal camera API. No JavaScript errors occurred.

The [mission reference](https://strategywiki.org/wiki/StarCraft/The_Big_Push) corroborates the floating start, two Command Centers and silos, transport relocation and Confederate-elimination objective. Remaining acceptance is a normal-control playthrough and classic comparison of initial flying-building visuals, landing/add-on behavior, computer micro and balance. Existing town-placement and transport policies remain provisional. Physical-device testing, cinematics and linked progression remain deferred. Owned assets and generated WASM stay ignored.

### New Gettysburg Evidence

Mission 9 uses the original New Gettysburg scenario. Public ID `terran09` maps to archive directory `terran11`, skipping the unused Operation Silent Scream entry after The Big Push. The Big Push milestone was signed and published as `50e9340a9349c4c16bcf6ff177d2fafd9e1dc0ce` before this work began. Full missions 1-10 playtesting is deferred until all ten Terran missions are ready.

- The 176,258-byte version-59 CHK has SHA-256 `1b55e907af8c4c5c6c5e0adcc775b8fe82e263d7afb9eba70ded40d11d5e412c`. Independent Python MPQ decoding matches the production C++ decoder. The original 128 x 96 map contains 255 UNIT records, eleven gameplay triggers, one briefing and twenty-two WAVs.
- The twenty-three-entry pack round-trips at 6,481,942 bytes, decoded content 6,480,518 bytes, SHA-256 `651f6b661168d331f2b9873cbc78781461dc665d76daaf3747ceee81540151b7`. Source map, triggers, AI binary and wave quantities remain unchanged.
- Human slot 0 starts six Marines, two Vultures, two SCVs, one Dropship and its original base. Kerrigan is naturally rescued with her original display color. The opening grants 250 minerals and 150 gas, then runs its authored paused dialogue before normal world processing resumes. It is not skipped or replaced with a fabricated initialization sequence.
- Original scripts are `T11z` at 9546 with 86 reachable instructions, `T11a` at 9798 with eleven, `T11b` at 9832 with ninety, and `SuiR` at 28797 with two. Main and lower Protoss town requests remain separate; military coordination remains player-wide.
- The existing campaign production path now accepts Probes and native PlaceProtossBuilding orders, and uses Probe/Pylon worker/supply types for Protoss. Existing placement, prerequisites, resources, psi checks and warp construction remain authoritative. Destroying the original lower Stargate causes a native Probe to complete a replacement; the original air request trains Scouts through a Stargate.
- Random-suicide opcode 31 mode 1 now assigns suitable native hostile targets using deterministic simulation RNG. Existing strategic mode 0 is unchanged. Units with valid engaged targets retain them; new random assignments are detached from old military groups. No units or replacement waves are generated by this opcode.
- The [Teippi AI reference](https://github.com/neivv/teippi/blob/master/src/ai.cpp) supplies SuicideMission/SetSuicideTarget contracts. External implementation code was not copied. Exact classic RNG consumption, target ranking and micro remain comparison items; existing bounded town placement remains provisional.
- Native sustained checks observe weapon fire from both Protoss and Zerg ground/air parties, including completed Protoss Scout production. Fresh-map cases cover idle, Kerrigan loss, whole-force loss, any Zerg-building Deaths defeat, full Protoss-building victory, and partial Protoss destruction without victory. The original ending creates its initial reinforcements and repeats the preserved five-Zergling trigger before victory completes.
- The native fixtures advance paused waits through the existing trigger-aware clock with bounds derived from original wait/transmission data. Outcome actors are protected; the long combat fixture keeps Kerrigan invincible and other targets matrix-protected but attackable. Mission 10 regression also refreshes original human-building HP so targets survive both cooperating enemy computers through the air phase. These fixtures establish semantics, not a normal-control victory or campaign-balance claim.
- A subsequent cloaked-Kerrigan report exposed a reversed Ghost acquisition condition: `!= HoldPosition` suppressed idle and Attack-move acquisition. The one-comparison fix uses `== HoldPosition`, matching [Teippi's pinned GetTargetAcquisitionRange contract](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/unit.cpp). Native Mission 9 regression verifies actual cloaked weapon fire at original Zealots and Dragoons through Attack-move and direct Attack. Cloaked Hold Position remains quiet. Fixtures position targets and protect actors; this is not normal-play victory evidence. Browser hero cloak/decloak controls and the full command suite also pass. On 2026-11-05 the user authorized this follow-up's signed commit and push.
- Native and browser-module suites for missions 1-9, the full command suite, and preparation safety checks pass. Actual nine-mission startup preparation produces exactly nine matching manifests and nine packs, with no source archive or audits copied to public output. Only existing compiler warnings remain.
- Integrated-browser checks pass frame-zero briefing, the complete original paused opening, Begin with original resources, nonblank desktop and 390 x 640 rendering, expanded objectives without horizontal overflow, paused resign without completion writes, and fresh retry with zero pack requests. No JavaScript errors occurred.

Remaining acceptance is the planned 1-10 normal-control playtest and classic comparison of town placement, assault coordination, random-suicide targeting and balance. Physical-device testing, cinematic playback, animated portraits and linked progression remain deferred. Owned archives, dialogue, generated packs and WASM remain ignored.

### The Hammer Falls Evidence

Mission 10 uses the original The Hammer Falls scenario. Public ID `terran10` maps to archive directory `terran12`, completing the retail Terran sequence after the two unused archive missions. Source map, triggers, AI binary, wave requests and initial resources remain unchanged.

- The version-59 CHK is 205,202 bytes with SHA-256 `2a3efca711b5a75ffd0ea569802fe0bd4dbfcfbfa0b0f308d897c0dca698fd7d`. Independent Python MPQ decoding matches the production C++ decoder. The 128 x 128 map contains 331 UNIT records, seven gameplay triggers, one briefing and fourteen WAVs.
- The fifteen-entry pack round-trips at 5,179,816 bytes, decoded content 5,179,032 bytes, SHA-256 `d821561821e8b1e7947872b7c2a1062aacfb71ab001fbd242b4d80a1f20d6576`.
- Human slot 1 starts sixteen Marines, one Vulture, two tanks, four SCVs, two Firebats, one Command Center and three Supply Depots. Vulture Raynor is naturally rescued with his original display color. This is thirty main actors, or thirty-two native actors including tank turrets. Original opening actions grant 500 minerals and 150 gas and emit two Raynor transmissions; there is no survival countdown.
- The objective is the original owner-6 Ion Cannon, unit 127. Its destruction wins while other enemy buildings may remain. Destroying every other enemy building without destroying the cannon does not win. Raynor loss or whole-human-force loss defeats the player through the original waits and actions.
- Original `T12P` at 10509 has 137 reachable instructions; `T12N` at 10082 has 115. The new required opcode is `nuke_rate` 45 with authored operand 15. Control Tower completion, silo requests, grouping, ground parties and later Battlecruiser/Wraith waves retain their source instructions and waits.
- Native computer Nuclear Silos now service queued orders and enter their existing training idle state. The campaign production path pays for an ordinary missile through native prerequisites, supply and training. A ready silo and eligible original Ghost use NukePaint, CastNuclearStrike, NukeTrack and the existing missile launch sequence. Native missile damage, Ghost statistics and player nuclear controls are unchanged.
- UMS computer players must start allied even across different forces, as documented by the [Forces reference](https://wiki.staredit.net/w/index.php?title=Forces&oldid=130). The loader now initializes that default before placed-unit processing, preserving human hostility and rescue neutrality. This prevents one enemy force from destroying the other force's Ion Cannon. Original force assignments are not rewritten.
- The long native fixture verifies the parsed rate, unchanged deadline without a ready missile, no early launch, native paid missile completion, Ghost launch and weapon fire from both original ground/air programs. Heavy-unit cooldown sampling uses the actual attacking turret through `unit_attacking_unit`. Five fresh-map cases retain idle, Raynor loss, force loss, cannon-survives negative, and cannon-only victory checks.
- Outcome fixtures protect actors. Sustained combat keeps Raynor and the cannon invincible while refreshing attackable human targets. These are isolated semantics and AI-progression checks, not normal-control victories or exact classic-balance evidence.
- Native and browser-module missions 1-10, the full command suite, scenario/AI audit tests, and source/cache/cleanup safety tests pass. Actual production preparation produces exactly ten matching manifests and ten SHA-256-verified packs, with no source archive or audits in public output. Only existing compiler warnings remain.
- Integrated-browser checks pass frame-zero briefing, Begin with 500/150 resources, normal SCV selection, Attack/Cancel, Build/Cancel, nonblank desktop and 390 x 640 portrait rendering, and expanded objectives without horizontal overflow. Portrait checks use viewport/native-touch emulation, not a physical phone. Paused resign gives Defeat without completion writes; retry loads fresh frame-zero `terran10` with zero pack requests. No JavaScript errors occurred.

The provisional nuclear policy requests missiles through native silo eligibility, schedules the authored 15 using `15 * 60 * 15` simulation frames, and selects an idle Ghost with the nearest reachable hostile building. Exact classic minute conversion, cadence reset, production priority, target ranking, cloaking and approach micro remain comparison items. Existing bounded town placement and military policies also remain provisional. The user clarified that mission 10 has not been fully played; targeted classic comparison remains open. Profiles, configurable settings, cinematics and animated portraits remain deferred. Campaign continuation and local save/recovery are implemented in the follow-up below.

### Among The Ruins Evidence

The first Zerg mission uses the original `campaign/zerg/zerg01` scenario, briefing, tutorial dialogue and `Zer1` enemy program. It is appended after the ten Terran missions in the existing chronological progression. Normal selection requires those preceding victory flags; the unlinked debug loader remains available for isolated mission testing. No new game-engine behavior, replacement AI or altered scenario bytes were needed.

- The version-59 CHK is 100,739 bytes with SHA-256 `f4794b4f8fc90f6ea9c4a585faa2c0a1de25450311256c7329a288d4dcd826ad`. Independent Python MPQ decoding matches the production C++ decoder. The 64 x 64 map contains 101 UNIT records, thirteen gameplay triggers, one briefing and fifteen WAV dependencies.
- The sixteen-entry pack round-trips at 6,484,201 bytes, decoded content 6,483,401 bytes, SHA-256 `f8bde62cc72ade13275168d8833ef29468b046f689ce80046d019113bc8d06da`. Preparation derives human slot 3, Zerg race 0 and episode 2 from the audited profile/scenario. The packer now selects the race directory while retaining the existing supported-mission allowlist and dependency validation.
- Original human forces are two Drones, twelve Zerglings, one Overlord, a Hatchery, a Creep Colony and the Zerg Beacon. Native initialization adds its ordinary Larva; the browser fixture begins with nineteen human actors and no melee extras. The original opening grants 200 minerals and no gas. Original objectives, Daggoth transmissions, ownership, fog and availability remain intact.
- Victory requires at least one Spawning Pool, at least one Hydralisk Den and zero owner-5 buildings. Each missing requirement prevents victory. Losing every human unit produces the original defeat. The implementation does not invent a Zergling quota, Chrysalis-loss condition or melee last-standing outcome.
- The original 180-second trigger activates `Zer1` at offset 15818. Its fifty-eight reachable instructions use existing capabilities, including authored construction, defenses, force settings, waits and attacks. Native tests verify no early activation, original force settings and actual enemy weapon combat. Protection is confined to the long observation fixture; normal mission resources and combat are unchanged.
- Fresh native outcome fixtures cover idle, enemy cleared with only one required structure, both structures with enemy buildings remaining, full original victory and whole-human-force defeat. A separate economy case gathers real minerals and gas, morphs Drones into a paid Spawning Pool, Extractor and Hydralisk Den, then produces a paid Hydralisk through native Larva/prerequisite rules. It grants no resources and does not enable AI control for the human slot.
- Browser-module checks retain the race, human slot, starting actors, briefing and original presentation events. Native Hatchery/Larva controls produce the third Drone through the normal command stream and pay fifty minerals. Save recovery replays that real command at its original service tick and reconstructs the same frame, checksum and actors.
- Isolated browser checks verify the eleven-mission grouped menu, strict unlock after the existing ten-Terran-clear code, frame-zero briefing, normal Drone selection and Build/Esc controls, and exact paused manual-save recovery. Desktop and 390 x 640 portrait rendering are nonblank and fit without horizontal overflow. Defeat awards no victory; Retry starts fresh at frame zero with no pack refetch. A forced outcome checks only victory UI persistence and the final-entry menu state, not an unassisted gameplay victory. Physical-device and normal-control classic playthrough acceptance remain open.
- Preparation of all eleven missions produces exactly eleven manifests and eleven size/hash-verified packs. Source archives, audits, synthetic test data and screenshots remain ignored and are excluded from the served output. Publication of this mission is authorized as a second commit/push after the separate AI milestone.

### Egression Evidence

The second Zerg mission uses the original `campaign/zerg/zerg02` scenario, briefing, dialogue, restrictions and `Zer2` enemy program. It follows Among the Ruins in the existing campaign menu and requires that mission's victory. Existing twelve-mission progression, progress codes, debug loading and save validation include Egression. On 2026-11-06 the user authorized its separate signed commit and push after the selection/Hatchery milestone `038017cc55a78fcf2ee6a031be73312a8999bb50`.

- The version-59 CHK is 137,159 bytes, SHA-256 `5819629c7bf99c941ab64225de24e4aa60c5164ad5c00345258aa62fe6a0eadf`. Independent Python MPQ decoding matches the native decoder. The 96 x 96 map contains 146 UNIT records, nine gameplay triggers, one briefing and eight WAV dependencies. Source CHK and trigger bytes are unchanged.
- The nine-entry pack round-trips at 4,107,719 bytes, decoded content 4,107,031 bytes, SHA-256 `1aa0b0b3559dc9cd2abf8d44d80479441fff1cf790433e0a4adf86bc1c4865e4`. Production preparation validates all twelve packs and manifests. Archives, packs, audits and screenshots remain ignored; served preparation outputs contain only the mission packs and manifests.
- Original human slot 3 is Zerg, with two Hatcheries, two Drones, three Hydralisks, two Mutalisks, three Overlords, a Spawning Pool, a Creep Colony and the source beacon. Native Hatcheries supply Larva. The original opening grants 300 minerals and no gas. Six Hunter Killers and the destination beacon retain rescue ownership until native contact rescue.
- The original victory requires the carried Young Chrysalis at Warp Point, not an empty Drone or destruction of the Protoss base. Carrier death drops the same portable object. The original warning starts its 120-second recovery countdown; recovery clears it, and expiry reaches the authored destruction message and defeat. Whole-human-force loss also reaches original defeat. The rescue transmission retains its authored Daggoth text and portrait reference rather than correcting the map's mismatch.
- Original `Zer2` begins at offset 15974 with seventy-one reachable instructions. Native tests observe weapon-firing ground and air parties using authored requests and waits. The placed Scout can satisfy the original first Scout request; tests do not require invented extra production. Protection is confined to the observation fixture. Normal funding, composition, timing, statistics and human control are unchanged.

Chrysalis startup is a narrow compatibility inference. The source places a human Zerg Beacon at the Chrysalis location but contains neither a Young Chrysalis UNIT record nor a creation action. Its preserved Move Location action immediately tracks that portable type. Without it, the normal missing-unit fallback moves the safety region to map center and causes a spurious idle recovery defeat. For version-59 UMS maps, initialization creates one native Young Chrysalis at an occupied human source beacon only when an enabled original Move Location action tracks that type in the matching region. An existing matching powerup prevents duplication. The source beacon remains intact; ordinary native pickup, carrying, overlays, drops, Bring, Move Location and timer execution are unchanged. No mission ID or coordinate is hardcoded. The [public Egression walkthrough](https://starcraft.fandom.com/wiki/Egression) supports Drone-contact pickup and recovery after carrier death, but this exact startup mechanism is not a recovered classic implementation. Compare it against the original game before claiming exact fidelity.

Isolated native cases verify an empty Drone cannot win, real Drone movement picks up the Chrysalis and rescues all six Hunter Killers, normal delivery wins, a dropped item expires to defeat, the other original Drone can recover the same item and then win, and whole-force loss defeats. Browser-module tests use a normal synchronized right-click, preserve the original Daggoth transmission and reconstruct the carrying state through deterministic save replay. A private browser context verifies twelve menu entries, fresh locking, the existing eleven-clear resume code, frame-zero briefing, real mouse pickup and exact paused manual-save recovery including checksum, actors and selection. Desktop and 390 x 640 portrait captures are nonblank, fit without horizontal overflow and have no page errors. All twelve native mission, browser-module and deterministic recovery suites pass, as do existing command, mixed-selection and multiplayer regressions. Normal-control full playthrough and classic comparison remain open.

### The New Dominion Evidence

The original third Zerg mission fills the progression gap before the requested fourth and fifth missions. It uses `campaign/zerg/zerg03`, the original scenario and dialogue, and `Zer3`; no source-map or trigger bytes are rewritten. It follows Egression in normal progression and remains available through the existing isolated debug selector.

- The version-59, 64 x 96 CHK is 101,332 bytes, SHA-256 `a62ddf17410b37aa406aaf6a0024edb1aae9f69521e5abeab7a537baf638f7d7`. Independent Python extraction matches the native preparation audit. It has 131 UNIT records, six gameplay triggers, one briefing and eight WAV dependencies. The nine-entry pack is 3,146,008 bytes, SHA-256 `ff007d5bad2a8b3cef3af0a1cbce2be4f7b5db765ca4bbc49440f97121661d32`.
- Original human slot 3 starts with two Drones, four Hydralisks, four Mutalisks, three Overlords, a Hatchery, its authored support structures and the mature Chrysalis. Native Larva are retained. The opening grants 150 minerals and fifty gas. The legacy native display spelling, `Mature Crysalis`, and source map-name string remain unchanged.
- Original triggers drive the enemy-elimination ending and Chrysalis-loss defeat, including their paused waits and dialogue. Isolated native cases verify idle state, victory after enemy buildings are eliminated, and defeat after losing the Chrysalis. `Zer3` at offset 16172 has ninety-two reachable instructions, all supported. Protected observation fixtures verify actual ground and Wraith weapon fire at authored timing, without extra resources or replacement waves.
- An original dialogue file exposed ADPCM sectors with trailing encoded samples beyond their declared output capacity. The decoder now stops before a partial or out-of-bounds sample, matching the reference output-bound behavior in [StormLib](https://github.com/ladislav-zezula/StormLib/blob/master/src/adpcm/adpcm.cpp). The MPQ reader rejects short decoded sectors and computes a full final sector correctly for exact-sector-size files. Synthetic mono/stereo and odd-capacity guard checks pass; no audio dependency is removed or substituted.
- Browser-module initialization, original briefing/audio and exact deterministic recovery pass. The thirteen-entry menu preserves strict Egression-to-New-Dominion unlocking and the existing portable progress-code format. Native mission, decoder-boundary and source-trigger outcome checks pass with only existing compiler warnings. Full normal-control/classic playthrough comparison remains open.

### Shared Computer Combat Decisions

Combat abilities run in the common native world-frame path for computer-controlled players, not in individual mission implementations. This includes placed defenders without a running town script. Human and client-bot slots remain under their existing command producers. Original mission bytes, research availability, training requests, wave timing, resources, weapon statistics and ability costs are unchanged.

Original-behavior evidence:

- [Teippi attack processing](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/unit.cpp) calls the original `Ai_StimIfNeeded` during attack processing and `Ai_SiegeTank` during computer processing. [Its cloak helper](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/unit_ai.cpp) checks native tech eligibility before requesting Wraith/Tom Kazansky cloak. These call sites do not expose every original decision threshold.
- [GPTP attack orders](https://github.com/BoomerangAide/GPTP/blob/ce321f0fa83174aee741b91f1b2eaec30300773e/GPTP/hooks/orders/base_orders/attack_orders.cpp) contain the reverse-engineered tank-turret decision: an eligible computer tank deploys for a visible valid ground target within siege range but outside tank-mode range, excluding critters. The native transformation is followed by a queued attack.
- [GPTP Stim execution](https://github.com/BoomerangAide/GPTP/blob/ce321f0fa83174aee741b91f1b2eaec30300773e/GPTP/hooks/stim_packs.cpp) confirms the ten-HP cost, timer value 37, sound choice and speed update. It is the low-level AI cast, not proof of the caller's health/range policy. [Teippi suicide targeting](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/ai.cpp) also preserves the ability to unsiege and queue a normal attack when no suitable siege-range target exists.

Implemented compatibility policies:

- Computer Marines and Firebats, including their native hero families, may Stim against a live, visible, attackable target in weapon range. They need the authored availability/research, no active Stim and more than thirty HP. The thirty-HP guard is a conservative survival policy, not a recovered original threshold. The native ten-HP cost and timer remain unchanged; active Stim is not repeatedly renewed at the expense of health.
- Wraiths cloak near an observed anti-air engagement, not on long-distance travel. The activation boundary is the larger participating weapon range plus one tile. Activation requires twice the native cost in reserve and charges the normal cost once. A wider three-tile disengagement margin prevents repeated cloak/decloak near the boundary; no nearby anti-air threat allows normal decloak. The reserve and proximity margins are explicit conservative policies, not claims of bit-exact original micro.
- Tanks deploy outside normal gun range but within native siege range. A visible ground threat inside the siege minimum range prompts native unsiege so the normal gun can retaliate. Valid queued movement goals survive both transformations. Tanks retain normal animation locks, detection and attack eligibility. Both modes count toward the same internal AI force request, avoiding replacement production caused only by a mode change; trigger-visible unit counts retain their native types.
- Damage from an undetected attacker can request an available, charged Comsat's native Scanner Sweep. Native detector calculation accounts for working detectors, shared vision, parasites and revealing effects, even before cached detection flags refresh. Pending nearby sweeps and active sweep coverage suppress redundant casts. Disabled, unavailable or undercharged stations cannot supply a scan. The response uses an actual attack source, not a search for hidden units anywhere on the map.
- No new cliff-search/pathing strategy or speculative offensive scanning is added. Tanks can use native range and vision from their current positions and existing attack routes, including existing high-ground placements. Deliberately choosing new cliffs or spending scans on unseen strategic targets needs additional classic evidence. Reactive scan timing and the conservation policies above are qualitative improvements with documented uncertainty, not a difficulty retune or complete reproduction of StarCraft's AI.

`node web/run-sim.mjs --test-ai-combat` uses an isolated state so synthetic actors do not contaminate original mission death counters. It checks native Stim cost/health/research guards, paid near-engagement cloak and far-travel rejection, natural siege/unsiege animations, actual normal-gun retaliation against a close Marine, queued-goal retention, mode-independent army accounting, detector-aware paid scans and overlap suppression. Normal frame progression proves automatic Stim/cloak without a town script; research-capable human units remain untouched. Protected actors and research overrides belong only to this test fixture, not normal mission initialization.

Verification on this pass: all ten original native mission suites, all ten browser-module mission suites and all ten deterministic save-recovery modes pass. The complete command suite and multiplayer ownership/departure regressions also pass. Desperate Alliance's existing unassisted diagnostic retains first combat at frame 3,530 and defeat at frame 17,073; this is a regression observation, not proof of identical balance. Native and browser builds contain only the existing compiler warnings. Normal-control/classic comparison of the new micro policies remains open. On 2026-11-06 the user authorized this AI milestone's commit and push before implementing the first Zerg mission.

### Mixed Selection And Hatchery Controls

Mixed selections retain all selected units while one unit type supplies the command card. Tab cycles forward through selected types; Shift+Tab reverses. Cycling cancels the previous type's targeting, building preview and submenu. Explicit focus follows native morph/type changes. With fewer than two selected types, Tab retains its minimap-terrain toggle.

- Fresh selections prefer heroes, then ordinary units over Larva/eggs, then higher combined mineral/gas cost. Type IDs and generation-safe unit IDs break ties deterministically. This is an explicit usability policy, not a verified reproduction of classic selection-priority metadata.
- Movement, attack and other ordinary group orders still synchronize the entire visual selection. Type-specific abilities and morphs synchronize only the active type; targeted spells use its active caster. Worker construction uses the selected worker's race-specific native build order. The existing command format remains unchanged.
- Hatchery-family Select Larva uses each Larva's native parent link, not visibility or proximity. No matches leaves the Hatchery selected. Repeated S can therefore select its naturally spawned Larva without jumping to another base. Original map bytes, mission availability and normal resources are unchanged.

Regression fixtures cover Drone/Larva precedence and morphing, Raynor/SCV mine placement and construction controls, a three-type Protoss cycle, and whole-group movement. A test-funded second Hatchery is built through normal commands to verify parent-specific selection and empty-Hatchery retention. Real browser Tab/Shift+Tab input, existing command regressions, deterministic Terran/Zerg save recovery and multiplayer checks pass. On 2026-11-06 the user authorized a separate commit and push before implementing Zerg mission 2. Normal-control classic comparison remains open.

### Campaign Menu And Local Recovery

The campaign menu presents the ten original Terran missions and the first two Zerg missions with selected, available, completed and locked states, grouped by campaign. Fresh local progress starts at Wasteland. Every preceding mission must have a saved victory flag before the next can be loaded normally. Progress persists on the browser origin and is separate from downloaded files and save slots. Reset returns selection and unlocks to mission 1 without deleting manual saves or cached assets.

- Progress version 2 stores an explicit boolean victory flag for each mission. Normal victory sets only that mission's flag; defeat, loading and downloading set none. The prior version already stored a completion list from its victory handler, before manual saves existed. Known legacy win records migrate to true flags without fabricating victories for skipped missions. Corrupt version-2 data cannot revive older records implicitly.
- The old unrestricted selector could produce out-of-order win records. The progress heading now counts the consecutive cleared campaign prefix and reports later recorded victories separately. An out-of-order won mission remains locked until every preceding victory exists. This explains old counts such as three recorded wins with mission 1 still uncompleted; it does not award missing victories or unlock levels from cached files.
- Sandbox and Campaign use one menu background, width, alignment, tab styling, launch band and form-control treatment. Stable scrollbar space prevents tab-switch shifts. Direct Sandbox setup initializes its map-probe guard before use. The external original-game link is removed. Desktop and 390 x 640 isolated checks show matching tab geometry and no horizontal overflow.
- A separate unlinked developer loader exposes every implemented mission without normal progress gating. Debug sessions do not award victory flags, migrate progress, create saves or delete existing autosaves. Their navigation retains debug mode. The normal menu neither links to nor advertises the loader. Its page is copied separately by the container build; the cinematic prototype remains excluded.
- The existing runner's `--test-campaign-menu` mode verifies false-by-default victory flags, strict preceding-win unlocks, safe gapped legacy migration, rejection of string-valued flags, corrupt-data handling and debug read-only unlocks. Isolated browser checks verify no progress from downloading/defeat, one true flag from victory, Next Mission unlocking, all-ten debug access and preserved normal progress/autosaves after a simulated debug victory. Forced outcomes are UI-test fixtures, not new normal-play acceptance evidence.

- Victory offers Next Mission and Campaign Menu. Next starts a fresh mission; mission 10 has no next-mission action. Defeat does not unlock missions. Retry explicitly starts fresh rather than restoring an autosave. The existing sandbox path remains available.
- Local IndexedDB storage provides one autosave per mission and three manual slots. Autosaves run every fifteen seconds and on pause/visibility/navigation hooks. Only completed transactions are durable; abrupt process termination can lose changes after the last completed autosave. Menu return normally waits for a successful save and offers an explicit leave-without-saving action if storage fails.
- Saves use a versioned deterministic input journal, not a raw WASM-memory dump or a classic `.sav` file. The journal captures applied input batches at their exact service ticks. Reconstructing the same native simulation restores units, RNG progression, AI and trigger/wait state. Service ticks are separate from world frames because authored pauses still service trigger waits.
- Save compatibility checks cover the actual WASM SHA-256, original mission-pack SHA-256, shared-data fingerprints and save schema. Integrity and payload bounds are validated before recovery. Reconstruction checks the saved world frame and native simulation checksum before offering Resume. Corrupt or incompatible saves remain stored; an explicit Start Fresh action is available. Engine/data upgrades can make existing saves incompatible until a migration path exists.
- Recovery runs in bounded batches with progress and Cancel. Historical presentation events are acknowledged without replaying their audio. Saved camera, selection and caption state are restored, and gameplay remains paused until Resume. Long games can take time to reconstruct; instant structural snapshots are not implemented. Supported journals are bounded to eight MiB of command bytes and two million service ticks.
- The save browser shows mission, slot/autosave, game time and save date, with Resume and confirmed Delete commands. Menu launch actions stay visible while scrolling. Desktop and fixed 390 x 640 browser checks show no horizontal overflow; expanded save settings remain scrollable and above the Paused banner. This is viewport testing, not physical-device acceptance.
- The existing browser-module runner's `--test-campaign-save terranXX` mode checks serialized save-format validation and fresh-instance reconstruction for all ten original missions. Native checksums and actor/owner/position/order records match. Mission 5 includes real movement, rescue and cloak/decloak input. Backwater audio and Norad repair debug-only HP mutations remain in their normal tests, not in replayable player history; both normal fixtures still pass.
- Integrated isolated-origin checks pass fresh-player mission-1 locking, persistent victory unlock and Next Mission, defeat without progress writes, reset, manual slots, periodic autosave, reload recovery, command/selection recovery and recovery during Mission 9's authored pause (world frame 2, service tick 13). Corruption, incompatible engine, cancellation and simulated storage-capacity failures reject safely and preserve prior saves. The complete existing command suite passes. No mission data, native combat or AI behavior changed.
- The container copies the new save module into the public application files. Docker is unavailable locally, so the final container rollout remains a publication-time integration check. Existing user game tabs and their storage were preserved; browser verification used a separate local origin.

### Portable Campaign Progress

The campaign menu displays a six-character hexadecimal progress code and accepts a resume code from another browser or device. The code represents the consecutive cleared campaign prefix, from zero through seventy missions. It transfers mission unlock progress without accounts or server storage. It does not contain in-mission saves or arbitrary combinations of later, still-locked wins.

- An imported code must be ahead of the current consecutive prefix. Valid forward imports mark the preceding known missions won, preserve all existing later victory flags and select the next available uncleared mission. Equal, older and invalid codes do not replace local progress. Existing later wins can extend the resulting prefix beyond the imported count when its gaps are filled.
- Format version 1 hashes the fixed domain `OpenBW campaign progress v1:<count>` with the existing cyrb53 helper and uses its final six hex digits. Decoding deterministically checks the seventy-one supported counts. All codes are unique in that range, and fixed test vectors protect compatibility. Codes are case-insensitive and accept surrounding whitespace. This is a compact, non-obvious progress representation with typo rejection, not encryption, authentication or achievement verification.
- The canonical ordering begins with the existing ten `campaignMissionIds`; future missions must extend that order rather than reorder it. An optional `importedPrefix` in the existing version-2 store retains progress beyond the currently implemented catalogue. Later catalogue entries inherit the imported prefix. A counter contradicting an explicitly false local flag is rejected. Ordinary victory writes preserve the imported prefix, and confirmed progress reset clears it.
- Copy and Apply controls are separate from local save recovery and multiplayer game codes. Debug mode hides the controls, refuses imports and does not migrate or write normal progress. Failed storage writes preserve the prior record. The original ten Terran missions and first Zerg mission are playable; the portable format's remaining capacity does not implement other missions. Existing code vectors remain unchanged when `zerg01` is appended.
- The existing `--test-campaign-menu` checks all seventy-one round trips, unique six-hex codes, golden vectors, forward-only merging, later-win preservation, future catalogue expansion, storage failures and debug isolation. Two isolated browser contexts transfer three clears into a profile with later wins, producing four consecutive clears while preserving mission 9's locked win. The selected mission advances to mission 5. Browser checks also cover future-count persistence after reload, copy invocation, reset, invalid/older rejection and debug read-only behavior. Desktop and 390 x 640 controls fit without horizontal overflow; user storage was not modified.

### Short-Code Multiplayer

Multiplayer supports two players through the selected map's player capacity, up to eight. The host creates one eight-digit code that all guests use. A small same-origin HTTP service reserves distinct slots and exchanges each guest's initial offer and answer. Guest-to-guest setup then travels through the host's direct channel. Gameplay uses a full WebRTC mesh, not a server relay. Every occupied player loads and verifies dependencies before Start.

- Unused codes expire exactly ten minutes after creation. Authenticated polling does not extend that lifetime. After the first join, authenticated host polling maintains a two-minute active-lobby lease. Each unanswered reservation has its own bounded negotiation lifetime. Guest cancellation releases only that guest; the host creates a fresh offer before reusing the slot. Start and host cancellation delete the room; server restart invalidates outstanding codes.
- Codes use cryptographic random generation and retain leading zeroes. Host and guest receive separate private ownership tokens, sent in Authorization headers rather than URLs. Setup payloads, decompression, active rooms and create/join attempts are bounded. Same-origin JSON requests are required. No accounts, persistent room database or gameplay server are introduced.
- The setup UI stays in Sandbox and disables Campaign switching until cancellation/failure. Inactive single-player setup controls are hidden during multiplayer setup and restored on Cancel. Code copying, remaining lifetime, invalid/expired-code recovery, cancellation and direct-connect timeout states replace the response-paste box.
- The lobby displays every map slot, selected race, ready state and player count. Empty slots are optional. Every occupied player must have all required direct connections, verified files and an explicit Ready flag before Start. Roster changes and race revisions invalidate readiness. Membership IDs reject stale failures or setup messages after a slot is reused. The host seals server admissions before countdown, preventing late joins from changing the starting roster. Unready cancels countdown and reopens admissions; controls lock for its final two seconds.
- Entering the lobby preloads the three core archives, selected map and engine for each player. Every occupied row shows loading phase and percentage, with an overall progress bar. Phases cover game files, map, engine compilation, verification and completion. Peers compare map and core-data fingerprints and the engine SHA-256 before Start. The scrollable roster keeps all map slots available; sticky Ready/Start controls remain visible on short screens.
- Start reuses the prepared asset buffers and compiled engine module without dependency downloads or engine compilation. Native game initialization still runs at Start. Failed loading aborts outstanding transfers, keeps the player unready and offers Retry Download. Cancel aborts the preload and restores setup controls. Cached archive sizes are checked, and streamed files reject truncation or excess bytes. Later setups reuse cached game archives and maps.
- Network protocol version 5 covers multi-player reservations, the authoritative roster, peer identities, mesh negotiation and native slot assignments. Each turn's source comes from its direct connection, not a claimed player field. The host chooses unique start positions within map capacity and resolves Random races once. All peers apply the same slot assignments, commands and deterministic simulation. Checksum comparisons retain every peer's result rather than treating the first response as the only opponent.
- Normal surrender remains a synchronized native command. Defeated players keep feeding lockstep while connected. On disconnect, survivors pause, exchange bounded final-input histories and agree on a common departure turn. Missing final inputs are recovered before the existing native surrender command removes that player. Every survivor drops the network wait at the same turn; the lowest surviving player takes coordination when needed. Native elimination tracking prevents a second announcement when an already-resigned player closes the tab. A conflict in final inputs fails safely rather than silently discarding commands. Rejoining a lobby uses a fresh membership and visibly clears readiness; reconnecting to a running game is not implemented.
- Direct P2P only is an explicit constraint. The existing STUN server remains available for address discovery; no TURN server or automatic relay fallback is configured. Restrictive NAT/firewalls can still prevent connection, producing a clear error rather than routing gameplay through the setup service. The old visible manual-response and relay setup paths are removed.
- A private non-root Node service runs as the `signalling` Docker build target. Compose starts it with a health check and no published host port; Nginx proxies only `/signal/` on the existing site origin. The application's public port and private campaign-data volume stay unchanged. Docker DNS resolution supports replacement of the setup container. Signalling request access logs are disabled; SDP and ownership tokens are not logged.
- Explicit `WEB_ROOT` local test mode can serve the existing application beside the setup API. Production does not set that option. The test server is bound to loopback, and no existing user server, campaign progress or save data was modified.
- `node web/signalling-server.mjs --test` verifies codes, expiry, ownership, capacities 2/3/4/8, simultaneous joins, cancellation, fresh slot offers, stale-token isolation, admission locking and automatic client exchange. `node web/run-wasm-node.mjs --test-network` verifies sender identity, buffered fan-out, stale connection isolation, asymmetric final-input recovery, atomic departure turns, host migration and simultaneous departures. `--test-lobby` checks occupied-player consensus, dependency hashes, missing guest-to-guest edges, roster/race revisions, host authority, native slot mapping and prepared boot without fetching. The existing complete command suite passes; no native engine or campaign simulation rules changed.
- Two isolated browser contexts connected through one code, automatically reached the lobby, mirrored race changes and required both ready flags. Selected local and remote candidates were both host-type, not relay. An unready action canceled an initial countdown; a later valid start reached frame 60 on both replicas with checksum 2478797867. Signalling request counts stopped increasing before gameplay while the peer data channel stayed connected.
- A cold-cache test held the guest's archive stream after twenty MB. Both players saw the guest's Game files phase at 49%, and guest Ready and host Start remained disabled. Both peers then reached Loaded. Each made five dependency requests before Start and none afterward, reaching frame 60 with matching checksum 1210679083. A controlled download failure retained Retry; retry completed both loads. Cancel aborted a held transfer and restored both setups. A second setup fetched no archives or map bytes; only the local development engine URL refreshed before Start.
- Invalid-code and build-mismatch browser checks recover without entering the lobby. Cancel restores the other player's setup controls. Desktop and fixed 390 x 640 layout checks keep race and ready controls within their rows with no horizontal overflow. These are browser-context/layout tests, not separate physical-device or different-NAT acceptance.
- The user confirmed a successful normal two-player session with a friend before this extension. Three-player isolated-browser testing then reached a common frame 81/checksum 2255314385 with all direct pairs connected and no dependency downloads after Start. Four-player testing rejected a fifth guest, preserved the existing roster, reused a departed slot and canceled/restarted countdown. After synchronized surrender, all four replicas still matched frame 281/checksum 3387269319; only the surrendering player's outcome was Defeat.
- Actual three-player tab-close tests leave two live survivors with one native elimination message and matching frame-200 checksums: 2101219197 for guest loss and 3851458576 for original-host loss. Four-player resign-then-close testing retains exactly one announcement for the resigned player; a subsequent host close leaves two live survivors matching frame 260/checksum 1802579314. No replacement disconnect popup or duplicate elimination message is inserted.
- Eight isolated browser players joined the real eight-start The Hunters map using one code. Every replica had seven connected direct peers. All eight matched frame 82/checksum 2546380565 with no dependency downloads after Start. A 390 x 640 layout showed eight scrollable rows without horizontal overflow. Separate-device eight-player acceptance and restrictive cross-network mesh connectivity remain unverified.
- Eight-player departure testing closes one guest, then the original host. All six remaining players continue with six native slots, five direct peers each and no game-over screen, matching frame 262/checksum 1911144053. Departure coordination stays on browser-to-browser channels; it does not add gameplay traffic to the setup server.

Docker/Nginx runtime and public routing must be checked on deployment because Docker is unavailable locally. The earlier two-player setup was deployed and verified; the new protocol requires all players to reload together. Cinematic prototype files remain excluded. Shared AI combat changes are a separate follow-up with the evidence and limits above.

### Cinematic Findings And Future Processing

The owned classic archive contains twenty-seven identified SMK/AVI video or animation entries. Direct MPQ lookup confirms `smk/terran1.smk` through `smk/terran4.smk`, with sizes 20,317,884, 8,851,868, 13,426,320 and 43,678,536 bytes, plus smaller pre-Terran entries. These assets are present, not missing. Cinematic integration remains deferred. The local playback experiment established a viable conversion path; only these findings are published, not the prototype page, source videos, converted media or portable tools.

Verified prototype results:

- The existing Python MPQ reader extracted the original `smk/terran1.smk` from the owned classic archive at embedded MPQ offset 259584. Its signature is SMK2. Never execute the archive's executable-style wrapper.
- FFmpeg decoded Smacker video and audio from that one file. The measured clip is 78.66 seconds, 320 x 308 pixels at fifteen frames per second, with stereo audio at 22050 Hz. Sound is embedded; a separate soundtrack file was not required.
- A pinned `imageio-ffmpeg` 0.6.0 Windows wheel supplied a portable FFmpeg executable. Its download was checked against the PyPI SHA-256 metadata. No system installation or PATH change was needed. This is a local experiment, not the selected production tool distribution.
- H.264/yuv420p video and AAC-LC audio in a fast-start MP4 produced a roughly 3.6 MiB clip. The local browser displayed moving, nonblank video, but its AAC decoder was unsupported and decoded-audio bytes remained zero. FFmpeg decoded the soundtrack at mean -18.9 dB and peak 0 dB, ruling out a missing or silent audio track.
- This VS Code browser reported AAC and Opus/WebM unsupported, but MP3 supported. Keeping the H.264 video and replacing audio with 44100 Hz, 128 kbit/s MP3 in MP4 produced nonzero decoded-audio bytes. The user confirmed hearing sound. This result does not imply that all Chrome, Safari or mobile browsers need MP3, or that MP3-in-MP4 is universally supported.
- The quick audio variant was made from the first converted MP4. Production variants must instead be encoded independently from the original SMK to avoid repeated lossy audio conversion. The prototype used native video controls and was left paused at the start with sound enabled. Its aspect/presentation fidelity has not been compared with classic playback.

Future implementation direction:

1. Resolve the original campaign's movie ordering and before/after-mission transitions. Keep movies separate from briefing actions and authoritative scenario triggers.
2. Extract only the selected clip from the verified private owned archive. Cache original and converted clips outside the public source repository and image build inputs. Do not download all cinematics when starting a mission.
3. Transcode once on the private server or during an explicit offline preparation step, rather than decoding Smacker on every client. Key the cache by source hash, FFmpeg version and conversion parameters. Use deterministic output names and verify generated metadata and content hashes.
4. Preserve the source frame timing, dimensions and aspect metadata before introducing presentation scaling. Compare framing with classic on a known clip; do not assume that a hardcoded 4:3 stretch reproduces its presentation.
5. Evaluate H.264 with AAC audio for conventional browsers and an independently encoded compatible fallback where needed. Probe the combined video/audio codecs with `canPlayType` or Media Capabilities. A browser rendering video is not proof that it decoded sound. Check actual video frames and decoded audio, and include a human audio test.
6. A candidate offline command is `ffmpeg -i original.smk -map 0:v:0 -map 0:a:0 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -ar 44100 -b:a 128k -movflags +faststart clip-aac.mp4`. A separately encoded test fallback replaces the audio options with `-c:a libmp3lame -ar 44100 -b:a 128k`. Inspect source streams first; the chosen clip had one soundtrack, but other clips can require different track selection.
7. Add a separate cinematic manifest containing source/output hashes, codec, dimensions, duration and audio metadata. Apply the existing bounded download and content-cache model. Serve converted media only through the authorized private delivery path; do not commit media, portable executables or prototype pages.
8. Keep the simulation stopped during movie presentation. Provide Play, Skip and Return using native or accessible controls. Resume the proper mission transition without fabricating completion or changing trigger state. Handle blocked autoplay, muted sound, loading failures and cancellation explicitly.
9. Test native fullscreen and inline mobile playback, seeking, stereo sound, synchronization, Skip and fresh/recovered mission flow. Verify desktop browsers, iPhone Safari and Android separately; the VS Code browser result is one compatibility datapoint.

### Private Container Campaign Delivery

The container now builds the existing native campaign preparation module and runs verified preparation before starting Nginx. A named `campaign-data` volume holds the private owned source under `/opt/openbw/web/data`, outside the HTTP document root. The first deployment downloads the same pinned 601,389,682-byte source used in local preparation; later redeploys verify and reuse it. This is a one-time server-side download, not a full-archive browser download.

Only supported mission manifests and their approximately 3.6-7.2 MB packs are copied to `/usr/share/nginx/html/data/campaign`. The original source archive and generated audit files are not copied to the served directory. Browsers retain the existing selected-mission download and content-hash cache behavior. Owned-data preparation does not authorize redistribution outside this private test deployment.

- The source download is streamed, bounded by the expected size, SHA-256 checked before atomic publication, and cleaned up on truncated, oversized, wrong-hash or HTTP-error responses. Invalid existing user source files are not silently overwritten.
- Live first-startup inspection found an active 282 MB download after approximately eight minutes. The downloader now applies a 60-second no-progress watchdog rather than a fixed 15-minute total deadline, so slow but advancing downloads can finish without discarding valid progress. The first private volume can also be seeded from the checksum-verified owned PC archive without exposing or committing it.
- `OPENBW_CAMPAIGN_SOURCE_URL` can select an HTTPS source with the same expected size/hash. Credentials are not accepted in the URL. The default is the previously used archive member, which responds successfully at verification time.
- The shared shell build now supports campaign-packer mode using the same WASI flags. The Docker image includes Node and the private preparation tools, and preserves the existing HTTP port. It also includes the existing web-app manifest.
- Live inspection found that Portainer had fetched the new Compose source but still ran the cached older `openbw:latest` image. `pull_policy: build` requires Compose to rebuild that image from the tracked source even when its local tag already exists. Verify the resulting image contains the preparation command; a pulled Git revision alone is not proof of a rebuilt image.
- The startup path was executed against the owned local archive. All eleven packs round-tripped and the public output was independently verified as exactly eleven manifests and eleven matching packs, with no archive or audits. Synthetic source/cache/error/cleanup checks pass. The shell mode compiled successfully through the installed Git Bash/WASI SDK path. Docker is not installed locally; the eleven-mission container rollout requires publication and live integration verification.
- First startup can take longer than the usual Git rollout while the private source downloads. Nginx starts only after the prepared files are ready, so it does not advertise missing mission manifests as a successful deployment. Keep the named volume across redeploys. Do not bake or commit game archives/packs into the source repository or public package builds.

Verify the live Git revision and all manifest/pack hashes after the campaign push and rollout delay; then start the browser mission from `openbw.stefhermans.nl`. No Portainer credentials are stored in this repository.

```powershell
node web/prepare-campaign.mjs terran06
node web/prepare-campaign.mjs --audit-ai terran06
& .\web\build-wasm.ps1 -SimulationTest
node web/run-sim.mjs --test-campaign terran06
& .\web\build-wasm.ps1
node web/run-wasm-node.mjs --test-campaign terran06
node web/run-wasm-node.mjs --test-commands
```

Apply these lessons to later missions. The evidence above records what was tested; it does not establish support for untested scenarios or operations. Update this section when another mission changes a reusable rule.

### Asset Preparation

- Cross-check decoded scenario bytes independently before accepting a new hash. A pack round-trip can repeat the same decoder error. The Python partial-word decryption bug changed hashes and could make unused bytes look like required operations; regenerate affected audits after decoder changes.
- Reuse the production C++ MPQ/audio codecs and the existing offline pack tool. Preserve the original CHK, resolve mission-relative dependencies, and verify every output entry. Measure the generated pack; compressed source sizes do not predict the first plain-pack download size.
- Parameterize the existing preparation and manifest-validation paths for each audited mission. Wasteland's original `terran01`, slot, race, source-hash, and pack-path assumptions have now been removed from the shared paths for T1/T2. Derive and validate these values per mission; do not copy the whole tool or weaken path/hash validation.

### Engine Contracts

- Normalize scenario conventions at the loader boundary. CHK forces are zero-based, while the existing runtime uses one-based force numbers. Validate each mission's OWNR/SIDE/FORC and placed actors; slot zero, melee starts, shared vision, and melee elimination announcements are not campaign defaults.
- Initialize UMS computer-to-computer alliances before placed-unit processing. Separate forces do not make computers hostile to each other. Preserve human enemies, rescue neutrality and later explicit alliance actions.
- Test raw trigger encodings, including termination and disabled records. Raw Exactly is 10. Type zero ends an action or condition list even if unused flags are set. For multiple TRIG sections, add a native-loader test for append order, stable running-trigger references, and absence of duplicate instances; the authoring-parser test alone does not prove this.
- Keep clocks separate. At the verified Fastest setting, game seconds use 16 world ticks, normal trigger scans are 31 ticks apart, and the first UMS scan is tick 2. Waits round up to 42 ms steps: 0/42 ms resume after two service ticks, 43/84 after three, and 85 after four. Script pause must not stop the clock servicing its waits.
- Interpret Transmission fields by their operation, not by an audio-duration guess. `time` is the stored base and `group2` is the Set/Add/Subtract adjustment. Briefing and gameplay share the native formula; browser playback completion must not decide when a trigger resumes.
- Verify action fields with an original scenario, not only an authored fixture. Move Location searches `location` and moves `group2_n`; reversing both the runtime and a synthetic test can hide the defect. Compare camera subjects at event time, since actors can move after a cutscene resumes.
- Preserve a waiting trigger's action index. Do not replay its earlier mutations or dialogue. Keep this distinct from the original scheduler's recheck of earlier triggers when a wait starts. Add interleaving tests when a later mission introduces new simultaneous waits.
- Audit placed-unit orders separately from AI-script actions. Wasteland exercises working guard/combat behavior without an AI VM; this does not implement ComputerAI, town management, or scripted attacks. Rescue must remain a proximity-based ownership transfer, including whole-player transfer through an active grounded depot, not a mission-specific grant.
- Backwater confirms that an empty AI-script action set can still activate ComputerAI through a placed building's DAT idle order. Include building idle orders in the next mission's readiness audit. Verify numeric IDs against the repository enums: mistaking the Infested Command Center for a Hatchery falsely suggested a broader AI requirement.
- Inventory reachable AI instructions, including branches and child threads, before choosing runtime scope. Desperate Alliance requests production through `build`, defense and attack operations without using `train`. Keep AI frame waits separate from trigger millisecond waits; audit the scheduler before assigning wall-clock timing.
- Match stable native idle states, not only DAT entry orders. `Guard` transitions to `PlayerGuard`; missing that transition stalled both resource reassignment and abandoned building recovery. Count active construction and pending eggs, and retry failed unstarted building requests without charging twice.
- Use generation-safe unit IDs for AI parties and destruction/rebuilding fixtures. A dead unit's storage can be reused; pointer equality does not prove that a later actor is the original unit.
- Distinguish strategic movement goals from direct combat eligibility. A party can move toward an enemy position before it can see or attack that unit. Keep actual attack acquisition in the native combat engine.
- Coordinate military by native pathing regions and a shared destination. Check mixed weapon capabilities before rejecting a target, exclude active defenders and engaged guards, and service surviving attackers after their destination clears.
- A living auto-target is not proof of active combat. Idle military continuation must validate visibility, attack eligibility and combat range before deferring to that target. Clear stale acquisition state before issuing the next attack-move order. Test both a remembered enemy outside combat range and a valid visible in-range engagement; the latter must remain untouched.
- Treat defense batch sizes as request/use instructions, not permanent global reserves. Account for demand and assigned base strength per region; cap ground and air need independently. Test simultaneous incursions and defender release, not only one nearby enemy.
- Track Kills at credited lethal damage, not by counting Die orders or decrementing live actors. Preserve captured projectile ownership when its source unit has gone, and test friendly fire and scripted deaths separately. Audit instant-kill spell paths when a later mission activates them.
- Web walkthroughs can justify a narrow provisional target when the user accepts later comparison. Label inferred compatibility rules and test them against original trigger totals; do not present those tests as proof of the original engine's internals.
- Unit death is staged. `kill_unit` assigns the Die order; completed-unit counters update during later processing. Isolated action tests should check the immediate death-order contract rather than assuming counters change synchronously.
- Check object ownership before reusing active-player trigger enumeration. Installation doors are neutral-owned; include them in the relevant doodad action without broadening victory or combat player groups.
- Register scenario triggers for eligible neutral/rescuable owners as well as humans and computers. A neutral player's original Rscu trigger must run before its base can become rescuable. Keep this eligibility separate from combat and victory-player enumeration.
- Separate town build counts from player-wide military state. An area-town's completed Command Center or workers must not satisfy the main town's requests. Service pending native construction and preserve its active SCV.
- Exclude bunker occupants from available wave strength, but distinguish them from legitimate Dropship passengers. Ground attack tests on island maps must prove actual unloading and weapon fire, not only party membership or queued boarding. Derive observation windows from the original waits and campaign deadlines.
- Complete animation-driven orders at their signal boundary. Release non-interruptible order state before returning to idle or activating queued attacks. Test both a deferred disable and a deferred re-enable; a disabled-unit early return can otherwise strand the enable request.
- Search teleport placement from the destination region. The native placement helper checks reachability from the actor's current position, so searching from its source can move only the first member of a group across disconnected regions. Collect actors before changing spatial indexes, preserve failed placements, and check quantities and path reset.

### Validation And Delivery

- Combine small authored semantics tests with the original mission and a normal-control playthrough. Test missing victory requirements and loss boundaries, not only a positive outcome. A rendered map, debug-created victory state, or successful previous mission is not sufficient acceptance.
- Keep attackable targets alive through long isolated combat fixtures. Sample the native attacking subunit for turret-based weapons; parent cooldowns alone can miss valid tank or Goliath fire. Native debug actor totals can include turret subunits.
- Distinguish input timing from engine defects during browser automation. Wait for queued selection/menu input to be consumed before panning or clicking placement. Convert map coordinates using the current camera and canvas scaling. Restore touch emulation and remove test frames afterward.
- Choose placement interaction from input capabilities and actual pointer type, not screen size or the primary-pointer query alone. A coarse-primary browser can still receive mouse input. Mouse placement must preview on hover and place with one click; touch retains its saved preview and Confirm flow. Preserve pending targeting and placement across mode changes so the first click is not discarded. Both mode directions pass first-click Attack checks alongside the existing desktop/mobile placement regression.
- Check immediate command activation through the browser handlers. A native test that renders after A has already supplied the delay a user may report. Assert targeting before any next frame, then dispatch the target click in the same task and verify its command bytes and queue flag.
- Keep transient events ordered and acknowledged, while objectives remain persistent. Use the existing native sound bridge, separate narration from mission beeps, and test muted/rejected audio. Cancel pending playback and close audio on session exit; retry uses a fresh engine rather than stacked listeners.
- Use native unit-family and ability eligibility checks for hero command cards. Raw ordinary-caster IDs can omit a campaign hero's innate abilities. Keep special commands such as Nuclear Strike separately gated, and allow original scripted pauses to service their waits before judging a queued native transition.
- Keep download state, session outcome, and saved completion independent. Verify the complete pack before caching or starting; failed replacements must preserve the good cache. Defeat, cancellation, and runtime failure must not save victory. Storage failure must not prevent local play.
- Add only the next mission's required capabilities and retain Wasteland plus melee regressions. UI/mobile optimization, onboarding, animated presentation, and linked mission flow remain deferred. Physical-device testing and authorized public asset delivery remain separate release checks.

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

Wasteland and Backwater Station are accepted local playable milestones. Desperate Alliance is the next implementation slice; deferred mobile/presentation polish does not block its runtime work. Physical-device and public-delivery checks remain release gates.

Desperate Alliance's corrected pack, script-driven runtime and original outcome checks now pass locally. Use the existing selection surface for its normal-control playtest and classic comparison. Retain both earlier missions' regressions; do not broaden this slice into onboarding or automatic mission-to-mission flow.

- Backwater Station: implement/test countdown and switch conditions, additional rescue behavior, unit-property creation, kill-at-location, and invincibility, together with its actual unit availability and objective flow. Reuse the same manifest, briefing, event, and outcome infrastructure.
- Desperate Alliance: add kills/countdown behavior and computer-owned trigger execution, then interpret the `Ter3`/`Suic` programs from the real AI binaries. Inventory reachable instructions and add unsupported-op diagnostics before promising complete AI coverage. Campaign base building/attack waves must come from the script runtime, not hand-timed substitutes or McRave/ZZZKBot.
- Verify newly activated unit orders and actual AI production/attacks before enabling T3. The old MBRF type 29 was a corrected-decoder artifact; do not add a bogus opcode or edit the source scenario to fit the engine.
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
3. Use the corrected Desperate Alliance pack and `--audit-ai` inventory; read its groundwork evidence above. Do not revive the superseded 14-WAV/MBRF-29 findings.
4. Add a failing check for each newly required operation, then extend the existing runtime. Keep milestone evidence and open questions here.
5. Play Desperate Alliance through normal defensive victory/defeat and compare its provisional town/defense policies with classic StarCraft. Retain both earlier missions' regressions and the deferred Backwater defender-assistance comparison. Keep UI/mobile polish, onboarding, and linked mission flow deferred.
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
- [Game-second, initial-scan, and regular-scan tick measurements](https://wiki.staredit.net/w/index.php?title=Game_speed&oldid=699).
- [Rescue behavior reference](https://github.com/BoomerangAide/GPTP/blob/ce321f0fa83174aee741b91f1b2eaec30300773e/GPTP/hooks/orders/rescuable_order.cpp), consulted for behavior only; no implementation code was copied.
- [Transmission duration fields and trigger scheduling reference](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/triggers.cpp). Its MIT license was checked; no implementation code was copied.
- [StormLib MPQ block decryption](https://github.com/ladislav-zezula/StormLib/blob/master/src/SBaseCommon.cpp), checked for whole-word handling; no implementation code was copied.
- [PyMS license](https://github.com/poiuyqwert/PyMS/blob/master/LICENSE.md), identified by GitHub as MIT during this research. No implementation code was copied in this planning change.

References describe intended formats/behavior; they are not evidence that the current engine implements it. Pin any additional reference revision used for code or normative timing tests during implementation.
