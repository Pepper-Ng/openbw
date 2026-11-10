# Campaign Mission Implementation Manual

## Purpose And Document Ownership

Use this manual when adding an authorized campaign mission or fixing a demonstrated campaign compatibility gap. It assumes no knowledge of the implementation conversation.

The original scenario defines the mission. The shared engine interprets its units, settings, triggers and AI programs. The browser presents the resulting events. Implement missing shared behavior rather than recreating the mission in JavaScript or changing its source map.

This manual owns the implementation procedure, commands, debugging advice and verification requirements. [CAMPAIGN_PLAN.md](CAMPAIGN_PLAN.md) owns current coverage, decisions, source identities, mission evidence, publication history and the validation backlog. Record a completed mission there; improve reusable instructions here.

MPQ is the game's archive format; CHK is the binary scenario inside it. Use Map Settings (UMS) preserves authored scenario setup. DAT tables define native unit/order data. WASM is the WebAssembly build; WASI supplies the preparation/native runners' filesystem bridge. TRIG contains gameplay triggers; MBRF contains briefing actions.

### Operating Rules

- Implement only the requested mission or demonstrated shared gap. Existing catalogue entries are not unfinished work.
- Preserve the original scenario bytes, actor identities, costs, waits, objectives and outcome predicates.
- Keep proprietary archives, scenarios, dialogue, media, packs and generated audits under ignored local data. Publish only authorized source and documentation.
- Preserve unrelated work, melee defaults, bots, multiplayer and existing controls.
- A required unsupported operation is a blocker. Do not bypass it by removing a trigger, granting units or substituting a melee bot.
- Label compatibility inferences and evidence limits. A protected outcome fixture does not establish a normal-control victory or exact classic difficulty.
- Commit, push, merge, deployment and asset distribution are separate actions. Follow the current authorization for each.

## Tasks

Complete the stages in order. Each stage ends with an observable result; resolve its failures before widening the implementation.

| Stage | Result required before continuing |
| --- | --- |
| 1. Establish scope and baseline | Known mission/source mapping, understood worktree and relevant passing baseline. |
| 2. Extract the original mission | Verified owned source and bounded, unchanged scenario/audio extraction. |
| 3. Derive the mission contract | Numeric start, progression, outcome and presentation requirements. |
| 4. Disassemble required AI | Correct binaries, reachable instructions, operands, owners and activation gates. |
| 5. Find and reproduce gaps | Existing implementation classified against each required behavior; a small failing check. |
| 6. Implement shared semantics | Focused checks pass without source-map edits or gameplay shortcuts. |
| 7. Wire the catalogue | Preparation, native tests, browser tests, menu and saves agree on the new ID. |
| 8. Prove native mission behavior | Independent outcome cases and actual source-driven production/combat pass. |
| 9. Prove input and recovery | Normal paid commands reconstruct the saved in-flight state exactly. |
| 10. Check the browser workflow | Isolated launch, presentation, outcomes, retry/navigation and appropriate layout checks pass. |
| 11. Run the release gate | Proportional regressions and asset-identity checks pass against rebuilt binaries. |
| 12. Record and deliver | Accurate evidence, source-only changes and any authorized publication are verified. |

## 1. Establish Scope And Baseline

Read [the plan's status and backlog](CAMPAIGN_PLAN.md#status-and-scope), then the nearest mission evidence. Choose one bounded mission or compatibility issue.

From the repository root, inspect:

```powershell
git branch --show-current
git rev-parse HEAD
git --no-pager status --short
git --no-pager diff --stat
git ls-remote origin refs/heads/campaign
```

Work on the authorized branch, currently `campaign`. Understand staged and unstaged changes before editing. Preserve existing commits and user edits.

Identify the stable public ID, source request, campaign edition and chronological position. Do not infer the archive path from a displayed title.

- Original public `terran07`, `terran08`, `terran09`, `terran10` request archive `terran08`, `terran09`, `terran11`, `terran12`, respectively.
- The unused original archive prototypes `terran07` and `terran10` are not shipping mission aliases.
- Expansion public `bwprotossNN` maps to `campaign\expprotoss\protossNN\staredit\scenario.chk`.
- Expansion public `bwterranNN` maps to `campaign\expterran\terranNN\staredit\scenario.chk`.
- Another expansion episode needs its own verified path mapping.

Keep canonical titles in catalogue metadata. Preserve legacy scenario name strings.

### Files And Entry Points

Search the named functions in these files rather than relying on old line numbers.

| File | Existing responsibility and useful entry points |
| --- | --- |
| [web/campaign_pack.cpp](web/campaign_pack.cpp) | `main`, embedded MPQ reader, source allowlist/path mapping, `make_pack`, production round-trip. |
| [web/prepare-campaign.mjs](web/prepare-campaign.mjs) | `missions`, exported `campaignMissions`, source descriptors, `prepare`, `auditScenario`, `scenarioSections`, `scenarioStrings`, `triggerProfile`, `auditAiScript`, `readPlainMissionPack`, `waveMetadata`. |
| [web/prepare-campaigns.mjs](web/prepare-campaigns.mjs) | `ensureSource`, verified server preparation and source-download safety checks. |
| [data_loading.h](data_loading.h) | Production MPQ, Huffman, ADPCM and DAT readers. |
| [bwgame.h](bwgame.h) | `game_load_functions::load_map`, CHK tag readers, `test_trigger_condition`, `execute_trigger_action`, `execute_trigger`, `process_triggers`, `trigger_give_unit_to`, campaign AI functions. |
| [actions.h](actions.h) | Native paid player commands, research, training and construction. |
| [web/wasm_sim_test.cpp](web/wasm_sim_test.cpp) | `campaign_checks`, mission-specific fresh-map cases, `expansion_ai_binary_checks`, main dispatch. |
| [web/run-sim.mjs](web/run-sim.mjs) | Native WASI runner and catalogue-derived mission validation. |
| [web/sandbox.h](web/sandbox.h) | Campaign mode, command cards, native mission events, audio and outcome boundary. |
| [web/wasm_main.cpp](web/wasm_main.cpp) | `openbw_init_campaign`, mission Begin/step, capabilities, input and debug exports. |
| [web/run-wasm-node.mjs](web/run-wasm-node.mjs) | `testCampaign`, browser-engine assertions, synchronized input capture and fresh-instance recovery. |
| [web/openbw.js](web/openbw.js), [web/index.html](web/index.html) | Mission IDs/options, editions, prerequisites, lifecycle, briefing and presentation. |
| [web/campaign-saves.js](web/campaign-saves.js) | Supported save IDs, integrity, compatibility and journal bounds. |
| [web/net.js](web/net.js) | Existing local-human command scheduling; change only for a demonstrated scheduling defect. |

### Toolchain And Baseline Checks

Use Node, PowerShell and [web/build-wasm.ps1](web/build-wasm.ps1). The verified default SDK directory is `%LOCALAPPDATA%\OpenBW\tools\wasi-sdk-33.0-x86_64-windows`. `-WasiSdk` or `WASI_SDK` overrides it.

Do not introduce WSL, SDL, BWAPI bots or another build system for the existing browser engine.

Run the relevant existing mission and shared test before changing its owner. Keep its result as the baseline.

Use the nearest existing mission as a worked example, not a template for its gameplay facts:

- `escape_aiur_mission_cases`: no-base hero/rescue flow, wrong-actor rejection and a complete scripted ending.
- `dunes_shakuras_mission_cases`: phased defeat rules, exact reinforcement branches, unused-slot scoring and source-driven AI.
- `legacy_xelnaga_mission_cases`: two independent boss gates, native special-effect expiry, disconnected enemy terrain and cutscene ownership.
- `testCampaign`'s matching branches: normal movement, paid Nexus construction and an incomplete paid Gateway training queue.

| Changed source | Rebuild before testing |
| --- | --- |
| Extractor or MPQ codec | `& .\web\build-wasm.ps1 -CampaignPack` |
| Native engine or native test | `& .\web\build-wasm.ps1 -SimulationTest` |
| Engine, native UI or WASM exports | `& .\web\build-wasm.ps1` |
| JavaScript/documentation only | No C++ rebuild unless the contract also changed. |

The known builds emit three nontrivial `memcpy` warnings. The browser build also emits two existing C++17-extension warnings. Investigate new failures separately.

## 2. Obtain And Extract The Original Mission

### Verify Sources Before Registering A Profile

Reuse owned data in ignored `web\data`. [The plan's asset inventory](CAMPAIGN_PLAN.md#verified-asset-inventory) records provenance. `campaignSource` and `broodWarSource` in [web/prepare-campaign.mjs](web/prepare-campaign.mjs) contain the current filenames, lengths, SHA-256 values and URLs.

The shared `STARDAT.MPQ`, `BROODAT.MPQ` and `patch_rt.mpq` are distinct from the larger campaign/CD archives. Both native and browser tests need the shared data.

If a campaign source is missing, use `ensureSource` with the applicable descriptor. It verifies an existing file or downloads and verifies a missing one. An invalid existing source is an explicit failure, not permission to overwrite user data.

Campaign/CD archives have executable-style prefixes. Read them as data; never execute them. The production extractor validates the embedded version-0 MPQ and its bounds.

For a new mission, first extend only the extractor's source allowlist and path mapping. Preserve every existing entry. Compare this edit with HEAD before rebuilding the packer.

The normal preparation command requires a registered profile with a known scenario hash. Do not invent that hash or weaken the assertion to perform the initial audit. Use the existing packer directly through WASI instead.

### Initial Extraction And Audit Example

This example audits the next expansion Protoss mission after adding its extractor request. Replace both variables with the audited public ID and source request.

```powershell
& .\web\build-wasm.ps1 -CampaignPack
if ($LASTEXITCODE -ne 0) { throw 'Campaign packer build failed' }
$mission = 'bwprotoss04'
$sourceRequest = 'bwprotoss04'
@'
import assert from 'node:assert/strict';
import { WASI } from 'node:wasi';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { ensureSource } from './web/prepare-campaigns.mjs';
import { campaignSource, broodWarSource, readPlainMissionPack, auditScenario, scenarioSections } from './web/prepare-campaign.mjs';
const [mission, request] = process.argv.slice(2);
const source = mission.startsWith('bw') ? broodWarSource : campaignSource;
const directory = resolve('web', 'data', 'campaign');
mkdirSync(directory, { recursive: true });
const sourceFile = await ensureSource(resolve('web', 'data'), source);
const wasi = new WASI({
  version: 'preview1', returnOnExit: true,
  args: ['campaign-pack', `/input/${basename(sourceFile)}`, request, `/output/${mission}.source.mpq`],
  preopens: { '/input': resolve('web', 'data'), '/output': directory },
});
const module = await WebAssembly.compile(readFileSync(resolve('web', 'campaign-pack.wasm')));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
assert.equal(wasi.start(instance), 0, 'Initial source extraction failed');
const read = readPlainMissionPack(readFileSync(resolve(directory, `${mission}.source.mpq`)));
const scenario = read('staredit\\scenario.chk');
const audit = auditScenario(scenario);
const sections = scenarioSections(scenario);
writeFileSync(resolve(directory, `${mission}.source.chk`), scenario);
writeFileSync(resolve(directory, `${mission}.audit.json`), JSON.stringify(audit, null, 2));
console.log({
  sha256: audit.sha256, version: audit.version,
  controllers: audit.controllers, races: audit.races,
  units: audit.units.length, triggers: audit.gameplay.records.length,
  briefings: audit.briefing.records.length, sounds: audit.wavePaths.length,
  conditions: audit.gameplay.conditions, actions: audit.gameplay.actions,
  briefingActions: audit.briefing.actions,
  sections: [...sections].map(([name, bytes]) => [name, bytes.length]),
});
'@ | node --input-type=module - $mission $sourceRequest
if ($LASTEXITCODE -ne 0) { throw 'Initial mission audit failed' }
```

Forward slashes in WASI preopens are guest paths, not Windows filesystem paths.

The extractor writes an ordinary plain MPQ and rereads its entries through the production reader. The JavaScript reader independently checks its tables.

If a decoder changes, cross-check original bytes independently before accepting new hashes. Round-tripping through the same faulty decoder can repeat its error. The earlier partial-word decryption defect produced false hashes and a bogus briefing opcode.

### Check Pack Contents

- Preserve the raw CHK at `staredit\scenario.chk`.
- Resolve mission-relative audio against the original mission root. Audit active TRIG/MBRF references and the WAV table.
- Use the production codecs for Huffman/ADPCM. Do not add a competing JavaScript decoder or omit undecodable audio.
- Validate every required RIFF/PCM file, declared length, channel/sample format and logical duration.
- Retain bounded entry sizes, normalized paths, traversal/NUL/absolute-path rejection and collision checks.
- Publish generated outputs atomically through temporary files. Failed preparation must not replace a working pack.
- Measure generated pack bytes and hashes. Compressed source sizes do not predict the plain-pack download size.
- Keep source wrappers unchanged. Do not relocate encrypted blocks without correct decryption/rekeying.

**Stage result:** the original scenario has a measured identity, every required file resolves, and extraction completes without bypassing validation.

## 3. Derive A Numeric Mission Contract

Read the generated audit, raw sections and native loader together. The audit is a starting summary, not a complete semantic decoder.

| Inspect | Record and verify |
| --- | --- |
| `VER ` | Original format 59 or expansion format 205. A new format needs its own bounded support and tests. |
| `OWNR`, `SIDE`, `FORC` | Human slot/race, computer/rescue/neutral slots, force membership, alliances and shared vision. |
| `UNIT`, `THG2` | Actors across all twelve owners, start markers, resources/powerups, heroes, sprites/traps, placed properties and initial orders. |
| `MRGN` | Referenced rectangle bounds, location names and elevation masks. |
| `UPRP` | Creation properties, validity flags, hit points, shields, energy, invincibility, hallucination and burrow state where used. |
| `PUNI`, `PTEC`/`PTEx`, upgrade sections | Availability versus researched state, player overrides, starting/max upgrade levels. |
| `UNIS`/`UNIx`, `TECS`/`TECx` and related sections | Custom statistics, technology costs and edition-specific data used by the loader. |
| `TRIG` | Owners, enabled conditions/actions, order, comparisons, counters, switches, waits, AI activation and all outcome branches. |
| `MBRF`, `STR `, `WAV ` | Briefing operations, objectives, speaker identities and referenced audio dependencies. |

`scenarioSections` appends repeated UNIT/TRIG/MBRF sections and uses replacement semantics for other sections. UNIT records are 36 bytes; TRIG/MBRF records are 2,400 bytes. Do not concatenate every repeated tag indiscriminately.

Use `scenarioStrings(sections.get('STR '))` for local string inspection. Keep narrative output out of tracked documentation.

To inspect individual records without dumping dialogue:

```powershell
$mission = 'bwprotoss04' # Replace with the mission being audited.
@'
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mission = process.argv[2];
const audit = JSON.parse(readFileSync(resolve('web', 'data', 'campaign', `${mission}.audit.json`)));
for (const [index, record] of audit.gameplay.records.entries()) {
  const actions = record.actions.map(({ text, wave, ...numeric }) => numeric);
  console.log(JSON.stringify({ index, owners: record.owners, flags: record.flags, conditions: record.conditions, actions }));
}
'@ | node --input-type=module - $mission
```

Read only the relevant records when output becomes large. Keep full JSON ignored; emit compact numeric summaries.

### Translate Records Into Behavior

1. List initial live actors by owner/type. Exclude start markers and distinguish turret subunits from placed actors.
2. Record natural startup rescue and initial trigger grants separately from placement.
3. Trace each objective phase through its conditions, actions, switches and waits.
4. Write every victory requirement and each independent defeat predicate.
5. Add negative boundaries: wrong hero, missing unit/building, one surviving enemy, missing cargo or incomplete counter.
6. Trace reinforcement quantities, properties, locations, ownership changes and cutscene movement through terminal outcome.
7. Record research/prerequisites and normal costs needed for the planned player-input test.
8. Record each AI script's owner, activation predicate, location and earliest source wait.

Resolve numeric unit IDs against repository enums and loaded DAT data. Familiar names can mislead: an infested Command Center is not a Hatchery. A source may represent a character with another hero's unit type.

Use the raw action's defined fields, not generic names from the audit. `amount` can represent a script ID, destination, switch or property index. Create With Properties stores its property index separately from quantity. Raw Exactly is 10.

For example, raw gameplay actions 48, 49, 51 and 57 are Give Units, Modify Hit Points, Modify Shields and Set Alliance Status. Check the format reference and current dispatch instead of guessing sequential meanings. MBRF uses its own action table.

Do not infer a last-hit requirement from story wording. Legacy of the Xel'Naga checks a Dark Templar's nearby presence when a Cerebrate is absent. Its original trigger supplies the rule.

Treat location IDs as one-based at the CHK boundary; native vector indexing is zero-based. Inspect the loader before translating other indices.

For location `n`, inspect the twenty-byte MRGN record at `(n - 1) * 20`. Signed 32-bit left/top/right/bottom fields begin at offsets 0/4/8/12; the elevation mask is a 16-bit field at 18. Check bounds before reading. These are pixel coordinates; choose legal terrain inside the rectangle rather than assuming its center is walkable.

Make a compact working table with `source record -> predicate -> state change -> expected result -> test`. Store durable results in the plan after verification.

**Stage result:** every required phase and operation has a source-backed expected result, including false and failure branches.

## 4. Disassemble Required AI Programs

Register the offline preparation profile now, using stage 2's measured hash/counts and stage 3's verified edition/order. Keep it out of the browser menu until its implementation passes.

The profile belongs in `missions` in [web/prepare-campaign.mjs](web/prepare-campaign.mjs). Set `source` only when the archive request differs from the public ID. Compare the nearest profile's fields rather than inventing additional metadata.

Prepare the normal pack and disassemble its scripts:

```powershell
$mission = 'bwprotoss04' # Replace with the mission being implemented.
node .\web\prepare-campaign.mjs $mission
if ($LASTEXITCODE -ne 0) { throw 'Mission preparation failed' }
node .\web\prepare-campaign.mjs --audit-ai $mission
if ($LASTEXITCODE -ne 0) { throw 'AI audit failed' }
```

The existing command extracts and verifies both binaries, discovers active action-15/16 script IDs and writes the mission's `.ai.audit.json`.

If an audit is needed before profile registration, the same WASI packer can extract the binaries:

- Request `--ai-script` from `patch_rt.mpq`.
- Request `--bw-script` from `BROODAT.MPQ`, not the campaign `BroodWar.mpq`.
- Use `auditAiScript(bytes, [id])` for original entries and `auditAiScript(bytes, [id], true)` for expansion entries.
- Resolve each ID through the original table first. Offset zero routes to the matching expansion-table entry.

The original table uses sixteen-byte entries. The expansion table uses eight-byte entries. Their first word points to the header table, not a common executable entry.

The normal audit command does this routing already. Do not independently disassemble offset zero or parse the expansion table with the original width.

Inspect `.scripts[].instructions` for offsets, names and operands:

1. Follow reachable jumps, calls and child threads, including branches not reached during a short idle test.
2. Separate AI frame waits from trigger millisecond waits and elapsed game seconds.
3. Identify town/area-town setup, build requests, research, defenses, caps, attack composition and launch conditions.
4. Check action ownership and activation switches against actual runtime controllers.
5. Classify each reachable opcode against `progress_campaign_ai_scripts` and its owning town/combat helper.
6. Derive observation bounds from original waits, native production time, grouping deadlines and travel distance.

An empty Run AI Script set does not prove that AI work is unnecessary. Placed units/buildings can enter ComputerAI through their DAT idle orders.

**Stage result:** every reachable required opcode has a valid operand layout and an implementation/test or an explicit blocking gap.

## 5. Find Prior Art And Reproduce Each Gap

Search the operation in the shared owner and nearest original-map test. Do not add a new implementation because a new mission uses it.

Build a gap table:

| Requirement | Existing owner | Evidence | Next action |
| --- | --- | --- | --- |
| Already supported | Existing helper/operation | Passing relevant test | Reuse and add this mission's integration assertion. |
| Supported with uncertain semantics | Existing operation | Missing boundary/original-record check | Add a discriminating failing test before changing it. |
| Missing | Existing dispatch or loader boundary | Required opcode/order traps or preflight rejects | Implement the smallest shared operation and its tests. |
| Reference uncertain | Source plus behavior reference | No reliable classic trace | Record a narrow inference and comparison gap. |

Start with a short strict readiness case in [web/wasm_sim_test.cpp](web/wasm_sim_test.cpp). Reuse the fresh-map setup in the adjacent expansion mission function.

- Route the new ID to that function in `main` before testing. An expansion case must return before original-only availability assertions.
- Set mission setup overrides as existing campaign dispatch does: UMS, no generic melee starts and no injected minerals. If the original scenario has no placed human force but its start location and triggers prove that it expects standard starting units, enable those units only for the authored human slot and record the evidence.
- Enable `st.strict_triggers`.
- Assert actual slot/race, original actors, natural rescue, funding, availability, script activation and no premature outcome.
- Step the real engine; do not skip initialization or convert an unsupported computer owner to human control.

If execution traps, inspect the first required unsupported operation. Fix that owning boundary and rerun the short check before extending the scenario.

## 6. Implement Shared Semantics

### Loader, Actors And Ownership

- Finalize UMS mode before mode-dependent initialization. Preserve OWNR/SIDE/FORC, fog, custom stats, availability, upgrades and locations.
- Keep shared buffers at asset indices 0-2 and the prepared mission pack at 3. Mount mission-relative files before Patch/BrooDat/StarDat fallback.
- Normalize CHK zero-based forces into the runtime's one-based force convention at the loader boundary.
- Normalize open humans and computers correctly. Runtime computers use `controller_computer_game`, not pregame `controller_computer`.
- Keep original computer-to-computer alliances, rescue neutrality and later explicit alliance actions distinct.
- Run eligible neutral/rescue-owner triggers without including those owners indiscriminately in victory/combat groups.
- Use `trigger_give_unit_to` and native ownership helpers. Rescue remains proximity-based, including whole-player transfer through an active grounded depot.
- Keep rescue distinct from scripted Give Unit. Propagate its ownership-only mode to cargo/add-ons; retain recipient research and restore loaded infantry to BunkerGuard. Scripted transfers inherit only researched donor technologies and applicable donor upgrades.
- Honor explicit creation/score owner indices even for unused slots. Do not activate their controller or town AI as a side effect.
- Preserve format-59 expansion-production restrictions. Expansion availability must follow the actual format and source settings.
- Read availability and research separately. Hero command cards use native family/ability eligibility, not copied ordinary-caster IDs.

Collect actors before kill, hide, remove or teleport operations that mutate spatial indexes. Use generation-safe unit IDs for retained references. Death is staged; counters can change after the Die order.

For fixture relocation, call `unit_finder_remove` before `move_unit` followed by `refresh_unit_position`. The refresh inserts spatial-index endpoints; calling it on an indexed actor creates duplicates.

Scripted placement and ordinary worker construction have different constraints. Reuse the appropriate helper for each. For teleporting between disconnected regions, search legal placement from the destination region and reset movement state; retain failed actors at their source.

Scripted grounded-building moves retain destination centers on legal terrain, including packed layouts with overlapping collision-box margins. Ordinary construction keeps its existing placement checks.

### Trigger Semantics And Clocks

- Stop condition/action lists at the first type-zero record and honor disabled flags.
- Preserve append order and stable references when multiple TRIG sections exist. Test the native loader, not only the authoring parser.
- Preserve Force/All Players/Current Player expansion, explicit slots, raw comparisons and resource Set/Add/Subtract boundaries.
- Preserve a waiting trigger's continuation index, execution/preserve flags and per-player waits. Earlier-trigger rechecks are separate from replaying the blocked trigger's own previous actions.
- Keep world time, trigger service ticks, briefing time and manual pause distinct.
- At verified Fastest timing, game seconds use sixteen world ticks, regular scans are thirty-one ticks apart, and the first UMS scan occurs at tick two.
- Wait quantization uses 42 ms steps: 0/42 ms resume after two service ticks, 43/84 after three, and 85 after four.
- Scripted Pause Game freezes world movement/combat while trigger waits continue. Action 30 mutes unit speech; action 5 pauses gameplay.
- Transmission `time` is the stored base; `group2` supplies Set/Add/Subtract adjustment. Briefing and gameplay share the native formula.
- Browser audio completion and render frequency must not control authoritative trigger progression.
- Preserve Set Next Scenario as per-player state. Record its filename on victory; defeats and debug-mode wins must not write new branches.

Verify ambiguous fields against an original record as well as a synthetic fixture. Move Location searches `location` and moves `group2_n`; reversing both implementation and synthetic test can hide a defect.

Preserve the audited compatibility scope. Zero-count creation currently has a one-actor rule for formats 59 and 205. This is not a generic zero-means-All policy for other actions.

Expose required support through the existing runtime capability mechanism and compare it with preparation requirements. Do not maintain unrelated support tables or silently treat an unknown operation as optional. Errors should identify the operation, source record, owner and instruction/action position where available.

### AI, Orders And Combat

- Extend `start_campaign_ai_script`, `progress_campaign_ai_scripts` or the owning native helper, rather than scripting mission-specific waves.
- Keep town/area-town production counts separate from player-wide military state.
- Count pending construction, training and two-unit eggs. Apply defined caps before spending, including a zero cap.
- Match stable idle transitions such as Guard to PlayerGuard. Retry failed unstarted requests without charging twice; preserve active builders.
- Keep native placement, paid production, research, attack acquisition, projectiles and terrain reachability authoritative.
- Separate strategic destination selection from direct weapon eligibility. A remembered target is not necessarily a visible in-range engagement.
- Test remembered out-of-range targets separately from valid visible engagements. Clear stale acquisition before military continuation without interrupting real combat.
- Coordinate regional defense and attacks without recruiting occupied bunker guards or engaged defenders. Treat defense batch sizes as requests, not permanent global reserves.
- Test simultaneous regional incursions, independent ground/air demand caps and defender release. A single nearby threat does not cover regional allocation.
- Service standalone `Suic` assaults after the short script ends, without activating an economy or granting troops.
- Credit Kills at lethal damage, including captured projectile ownership. Scripted deaths, friendly fire and instant-kill paths need distinct tests when relevant.
- Complete animation-driven orders at their signal boundary. Release non-interruptible state before idle or queued actions; test both disable and re-enable.
- Seed/random-switch operations use the existing deterministic random stream and correctly sized operands.

For a narrow new opcode, add an isolated assertion as well as the original mission case. The expansion tests demonstrate binary routing, shared-vision direction and an exact four-byte seed.

### Presentation, Downloads And Session State

- Parse MBRF separately from gameplay TRIG; their opcode meanings differ.
- Keep the world unstepped before Begin and mission strings escaped. Preserve relevant line breaks and allowed color controls.
- Use the existing ordered native-event boundary. Acknowledge transient events once; keep objectives/leaderboards as persistent state.
- Preserve event generation/sequence/owner data and bounded queues. Overflow is an explicit session error, not dropped presentation.
- Resolve arbitrary mission WAV paths through the mission overlay/native sound bridge. Narration is distinct from positional audio and unit acknowledgements.
- Preserve master mute and readable text under blocked/rejected audio. Cancel stale asynchronous playback when a session ends.
- Use a fresh engine/session for retry. Clear waits, events, UI selection and audio generation without stacking listeners.
- Keep local command producers human-only. Scenario computers/rescue players do not need network turn producers.
- Accept only original-trigger outcomes. Stop terminal sessions and record completion once after victory, never defeat/cancellation/runtime failure.
- Stop stepping/render requests after a WASM trap and offer recovery. Do not continue a failed session behind a frozen display.
- Preserve melee replay export. Campaign replays need correct UMS metadata; do not label a mission replay as melee.
- Preserve version/hash-keyed mission caching, full size/hash validation and a good cache entry after a failed replacement.
- Preload required files before briefing. Network waits do not belong inside synchronous simulation.
- Download only the selected mission plus missing shared data. Keep cinematics optional and separately cached; do not prefetch without consent.
- Handle quota/storage errors explicitly. Asset deletion and progress reset remain separate operations.
- Preserve local play when progress persistence fails, with the existing user-visible failure state.

## 7. Wire Every Catalogue Surface

The offline profile already exists from stage 4. Finish the runtime/test wiring, then expose the verified mission in the UI. Check each row:

| Surface | Required change or verification |
| --- | --- |
| `missions` in [web/prepare-campaign.mjs](web/prepare-campaign.mjs) | Title, edition/episode, chronological order, source alias when needed, original CHK hash, UNIT/TRIG/audio counts. |
| [web/campaign_pack.cpp](web/campaign_pack.cpp) | Source request is allowed and maps to the correct archive root; earlier aliases remain intact. |
| `campaignMissionIds` in [web/openbw.js](web/openbw.js) | Append the stable public ID in canonical order. |
| Options in [web/index.html](web/index.html) | Correct edition/chapter, public ID and title. |
| Save ID validation in [web/campaign-saves.js](web/campaign-saves.js) | Accept exactly the newly supported IDs without an unrestricted wildcard. |
| Main dispatch in [web/wasm_sim_test.cpp](web/wasm_sim_test.cpp) | Explicit mission case reaches its own assertions; expansion dispatch precedes original-only availability checks. |
| `testCampaign` in [web/run-wasm-node.mjs](web/run-wasm-node.mjs) | Initial actors/slot/race/resources, actual opening-dialogue expectations and a meaningful normal-input recovery fixture. |
| [web/run-sim.mjs](web/run-sim.mjs), [web/prepare-campaigns.mjs](web/prepare-campaigns.mjs) | Verify their exported-catalogue paths cover the mission; avoid duplicate allowlists. |

Preserve the current edition decision: independent StarCraft/Brood War entry, sequential victories within each edition. Return and Next must preserve the correct edition.

Keep portable progress-code meanings and canonical ordering stable. Expansion-only victories do not fabricate original victories. Extend catalogue order; do not reorder published entries.

Local victory progress can include an authored bare filename at `nextScenarios[missionId]`. Preserve it through progress-code merges. Portable codes encode ordered clears, not story branches; validate and wire variant routing before exposing a following forked mission.

Verify the stage-4 manifest's schema/content version, source hash, pack URL/size/hash, human slot/race, capabilities and per-file metadata. Reprepare after an extractor/profile change. Do not edit generated manifests to disguise a profile mismatch.

## 8. Prove Native Mission Behavior

Use separate fresh-map cases in the existing native test file. Add small synthetic operation checks where the mission does not distinguish an important boundary.

Cover:

1. Original startup, idle behavior and no early outcome.
2. Each independent loss condition, including post-rescue or later-phase variants.
3. Each missing victory requirement and each threshold's false/true boundary.
4. The complete original victory chain, including waits, ownership changes, movement, dialogue and final outcome.
5. Original-timed AI production and actual weapon fire from every relevant enemy program.
6. Required unit/technology behavior, special effects and expiry, not merely actor creation or queued orders.

For rescued bunkers, inspect hidden passenger orders and observe actual targeting, weapon fire and damage before any unload/reload. Verify player and enemy research separately before and after ownership changes. Protect the original building-clear gates when isolating a different activation route.

Outcome fixtures may relocate original actors, weaken a boss or protect targets to isolate a trigger. Keep these changes test-only and list them in mission evidence. Do not call them normal-control victories.

Prefer protective matrices or bounded HP refresh for combat fixtures. Invulnerability can make the AI correctly reject a target. Observe turret subunits for tanks/Goliaths and actual launched ammunition for Carriers/Reavers.

Verify reachability before demanding an attack. A same-landmass relocated target proves local production/combat, not cross-water transport strategy. To claim a drop, observe native loading, flight, unloading and subsequent weapon fire.

Wait for native transitions, not arbitrary sleeps. A switch may precede another owner's AI activation, and death may precede counter updates. Keep the complete source countdown when expiry is the contract.

Run against the rebuilt binary:

```powershell
& .\web\build-wasm.ps1 -SimulationTest
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
$mission = 'bwprotoss04' # Replace with the mission being implemented.
node .\web\run-sim.mjs --test-campaign $mission
if ($LASTEXITCODE -ne 0) { throw 'Native mission checks failed' }
```

Derive deadlines from source waits, build times, scheduler cadence and path length. Record measured behavior separately from test headroom. Rerun the same focused check immediately after each owning-code fix.

## 9. Prove Normal Input And Deterministic Recovery

Extend `testCampaign` rather than adding a second recovery system. The existing wrapper records `openbw_apply` packets and service ticks after Begin, then reconstructs a fresh engine.

1. Assert original startup, pre-Begin freeze, briefing, capabilities, resources, audio and objective events.
2. Choose a meaningful action the original state can afford. Check gas, prerequisites and research as well as minerals.
3. Select an original actor, render/consume the updated command card, and use normal keyboard/pointer input.
4. Read `openbw_out_*`, copy the packet into `openbw_in_ptr`, and apply it with `mission.humanSlot`.
5. Assert actual cost and native progress. Use `openbw_status` for production; debug actor lists can include unfinished training units.
6. Save while movement, construction, training, cargo or a scripted wait remains in flight.
7. Let the existing recovery harness compare frame, unsigned checksum, actors, owners, positions and orders in a fresh instance.

Debug selection or camera framing may prepare input. Debug HP, resource, ownership, teleport or unit-creation mutations are not recorded commands and invalidate normal recovery proof.

When constructing raw commands, preserve the normal length-prefixed stream. Escape from Aiur's working movement fixture encodes:

```text
selection = [9, 1, unitIdLow, unitIdHigh]
move      = [21, xLow, xHigh, yLow, yHigh, 0, 0, 228, 0, 6, 0]
batch     = [selectionLengthLow, selectionLengthHigh, ...selection,
             moveLengthLow, moveLengthHigh, ...move]
```

Prefer existing input handlers over hand-encoding. An unframed concatenation can produce no movement without proving an engine defect.

Normalize checksum metadata with `>>> 0`; WASM exports expose signed i32 values. Saves require compatible engine/assets, not just a matching mission name.

Run:

```powershell
& .\web\build-wasm.ps1
if ($LASTEXITCODE -ne 0) { throw 'Browser engine build failed' }
$mission = 'bwprotoss04' # Replace with the mission being implemented.
node .\web\run-wasm-node.mjs --test-campaign-save $mission
if ($LASTEXITCODE -ne 0) { throw 'Recorded-input recovery failed' }
node .\web\run-wasm-node.mjs --test-campaign-menu
if ($LASTEXITCODE -ne 0) { throw 'Campaign menu checks failed' }
```

## 10. Check An Isolated Browser Workflow

The Node browser-engine runner is not a GUI test. Use an isolated browser context with its own local storage and IndexedDB.

Use available browser tools or existing local automation. Never reset normal user progress, navigate an unshared user page or kill unrelated browser/server processes.

If a temporary local server is needed, bind it to loopback, verify an HTTP response and close it after checking. The existing `createSignallingServer({ webRoot })` in [web/signalling-server.mjs](web/signalling-server.mjs) can serve the web directory.

Always close the private context, browser and task-owned server in `finally`.

Check through visible controls:

- Correct edition, mission order, available/locked rows, totals and selected mission.
- Fresh independent edition entry and unchanged sequential gating/progress-code behavior.
- Selected-manifest/pack download only, progress, failure/cancel/retry and cached restart.
- Original briefing at frame zero, Play/Skip/Begin, readable objectives/captions and actual narration.
- Nonblank gameplay and at least one original normal command.
- Defeat without completion, fresh Retry and return navigation to the correct edition.
- Save from Settings, return to menu, Resume, and resumed simulation. Recovery intentionally returns paused; use the pause control to continue.
- When UI changed, desktop and narrow/mobile landscape/portrait bounds without overlapping controls, text or objectives.

Do not invent opening dialogue for location-driven missions. Audio decoding, human audibility, physical-device acceptance and classic comparison are distinct checks.

### Input And Automation Details

- Wait for selection/menu input to be consumed before dependent clicks. Inspect command bytes when the visible action does not occur.
- Convert world coordinates with the current camera and actual canvas scaling. Verify dimensions after debounced resize.
- Select the worker before `openbw_debug_build_check`; placement checks read primary selection, not just mission race.
- Preserve armed targeting/placement across pointer-mode changes. Test immediate Attack plus click in the same task when changing that path.
- Mouse placement previews on hover and places with one click. Touch uses its existing preview/Confirm flow; input capability is not screen width.
- Use synchronous browser wait predicates with explicit polling, such as `{ polling: 100 }`. Do not freeze `requestAnimationFrame` to limit simulation; automation can freeze while its timer keeps stepping.
- Restore temporary touch emulation and remove test frames afterward.

## 11. Run Proportional Regressions

Run the smallest focused checks after each fix. Once the mission passes, cover affected earlier missions and shared behavior.

For shared native/codec changes with broad impact, run every catalogue mission in both native and recorded-input modes, plus the six shared modes. Derive mission IDs from `campaignMissions`.

The following PowerShell sequence fails on the first unsuccessful process:

```powershell
$missions = node --input-type=module -e "import { campaignMissions } from './web/prepare-campaign.mjs'; process.stdout.write(JSON.stringify(campaignMissions));"
if ($LASTEXITCODE -ne 0) { throw 'Catalogue read failed' }
$missions = $missions | ConvertFrom-Json
foreach ($mission in $missions) {
    node .\web\run-sim.mjs --test-campaign $mission
    if ($LASTEXITCODE -ne 0) { throw "Native mission failed: $mission" }
    node .\web\run-wasm-node.mjs --test-campaign-save $mission
    if ($LASTEXITCODE -ne 0) { throw "Mission recovery failed: $mission" }
}
node .\web\run-sim.mjs --test-ai-combat
if ($LASTEXITCODE -ne 0) { throw 'Shared AI/combat failed' }
foreach ($mode in @('--test-campaign-menu', '--test-commands', '--test-protoss-selection', '--test-network', '--test-lobby')) {
    node .\web\run-wasm-node.mjs $mode
    if ($LASTEXITCODE -ne 0) { throw "Shared browser check failed: $mode" }
}
Write-Output ("Passed {0} modes" -f (2 * $missions.Count + 6))
```

Before that gate, rebuild every affected binary. Do not run preparation concurrently with a process reading the same output packs. Windows can reject atomic replacement of an open file.

After preparation/reader changes:

```powershell
node .\web\prepare-campaign.mjs --test
if ($LASTEXITCODE -ne 0) { throw 'Scenario/AI reader checks failed' }
node .\web\prepare-campaigns.mjs --test
if ($LASTEXITCODE -ne 0) { throw 'Source download checks failed' }
```

Reprepare affected assets and compare their full bytes/hash against manifests and the plan's prior identities. Recheck all original packs after shared decoding changes. Investigate a mismatch instead of replacing its baseline automatically.

`prepare-campaigns.mjs` supports `--test`; its normal path prepares and copies the full catalogue. Do not use an assumed `--help` or arbitrary argument as a harmless probe.

Check changed JavaScript with `node --check` and run `git --no-pager diff --check`. Syntax checks do not prove native gameplay or recovery.

For Vulture selection, mine availability or targeting changes, also run `node .\web\run-wasm-node.mjs --test-group-mines`. This focused mode isolates its extra army and supply from the general command suite. Check actual native order behavior as well as transmitted Shift flags; a flag alone does not establish that an order is queueable.

Documentation-only changes need link/content checks, not the full game suite.

## 12. Record Evidence And Deliver

Update the mission evidence in [CAMPAIGN_PLAN.md](CAMPAIGN_PLAN.md) with:

- Stable ID, edition/order, source CHK hash, record/dependency counts and generated pack size/hash.
- Actual human slot/race, starting actors/funding and relevant original progression/outcome rules.
- Required scripts/operations, owning shared fixes and source-backed versus inferred behavior.
- Native cases and exact fixture overrides, including protection, weakening, relocation or forced switches.
- Normal input, actual source costs, meaningful saved state and reconstruction results.
- GUI/browser/device checks, command results, runtime revision and unresolved comparison items.
- Publication state, only after it is verified.

Keep reusable procedures in this manual rather than copying them into each evidence entry.

Report evidence levels separately: synthetic semantics, original-map fixtures, source-timed AI/combat, normal-input recovery, GUI smoke, full human victory and classic comparison.

For classic comparisons, record game version, mission/source identity, route/input, game time and observed result. A reported easier-AI impression is not a numerical balance target.

Before any authorized commit:

1. Inspect source-only scope, staged/unstaged changes and `git diff --check`.
2. Exclude ignored archives, packs, audits, binaries, screenshots/media and task-only tooling.
3. Follow requested commit grouping, message, trailer and signing rules. Normally keep one mission per commit; isolate substantial framework work.
4. Preserve repository-local author/signing configuration and the user's global identity. Verify signatures when signing was requested.
5. Verify the committed content, parent links and remaining worktree.

When a push is authorized, push only the named branch. For the current campaign workflow:

```powershell
git push origin campaign
if ($LASTEXITCODE -ne 0) { throw 'Campaign push failed' }
$local = git rev-parse HEAD
$remote = git ls-remote origin refs/heads/campaign
if ($LASTEXITCODE -ne 0) { throw 'Remote verification failed' }
if (($remote -split '\s+')[0] -ne $local) { throw 'Remote campaign tip differs from HEAD' }
```

Keep `sandbox` and other branches unchanged unless separately requested. Remove only task-created temporary files, contexts, servers and temporary signer lists. Preserve keys, trust settings and user history.

Do not infer deployment from a Git push. If rollout is authorized, verify the live image/revision, prepared manifests/pack hashes and browser startup independently. Cached image tags can hide an older image even after Compose fetches newer source.

Private preparation retains its named data volume and keeps source archives/audits outside the HTTP document root. Public asset hosting requires separate authorization. A range-based alternative must prove `206`, correct ranges and CORS on the exact source; never silently download the full archive after an ignored Range request.

If future packaging deduplicates shared media, compare content hashes rather than filenames. A future local browser importer must use bounded slices rather than loading a campaign archive wholly into mobile memory.

## Troubleshooting Reference

| Symptom | Investigate before changing behavior |
| --- | --- |
| Unexpected slot, actors or AI owner | Decode OWNR/SIDE/FORC and all twelve UNIT owners. Check natural rescue and runtime controller normalization. |
| Missing mission object | Inspect neutral/hidden actors and original creation triggers. Do not add a duplicate fallback spawn. |
| Hallucination exists but Command count is zero | Inspect live generation-safe actor IDs and counter semantics; retain source outcomes pending classic comparison. |
| AI has a party but never fires | Check source waits, native production, grouping, weapon eligibility, actual reachability, visibility and target owner/alliance. Observe cooldown/projectile damage, not just party membership. |
| Wave cannot cross water | Test real transport loading/flight/unloading. Relocating a target establishes only local combat. |
| Carrier/Reaver cannot attack | Buy an Interceptor/Scarab normally and observe its launch. Preserve original empty hangars and ammunition costs. |
| Cutscene actor absent | Check explicit unused owner slots, valid placement and original actor type before activating controllers or substituting heroes. |
| Dialogue freezes | Distinguish manual pause, scripted world pause, trigger waits, speech mute and pending native orders. Inspect service ticks as well as world frames. |
| Teleport/landing fails | Inspect footprint, elevation masks and connected ground regions. A location's center can be illegal. |
| Spatial mutation crashes or actor changes identity | Collect before mutating finders; wait for staged death; use generation-safe IDs rather than recycled pointers. |
| UI command does nothing | Consume selection/card changes, inspect packet framing, apply to the real human slot, check cost/research/placement. |
| Saved state diverges | Remove unrecorded gameplay mutations, retain exact service ticks/packet bytes, normalize unsigned checksum metadata and verify engine/asset identity. |
| Webs expired but a counter remains nonzero | Inspect surviving actors' actual `cannot_attack` state. A bookkeeping count alone is not proof of persistent suppression. |
| Preparation rename returns EPERM | Stop only the task-owned readers of that specific pack, then retry preparation sequentially. Do not weaken atomic publication. |
| Audit suddenly discovers an implausible opcode | Verify decoder bytes, record offsets, enabled flags, first-zero termination and the correct binary before implementing it. |

Native tooling uses custom containers: `unit_id.raw_value`, `range_size` for intrusive lists, and qualified `data_loading::value_at`/`set_value_at`. Standard `printf` and the custom `error` formatter have different capabilities.

Use PowerShell here-strings for larger Node snippets. Tool calls can start fresh shells; set variables and environment in the same invocation as dependent commands. In ambiguous terminal integrations, avoid quoted inline JavaScript containing shell-sensitive `&&`/`||`.

After an interruption, inspect current commits, index/worktree, live refs and completed test evidence before repeating work. Do not delete history, restart editor windows or terminate unrelated jobs as an automatic repair.

## Optional Cinematic Work

Cinematics are a separately authorized feature, not a prerequisite for implementing the next scenario. [The plan](CAMPAIGN_PLAN.md#cinematic-findings-and-future-processing) retains source/prototype findings and comparison limits.

When that work is requested:

1. Resolve original ordering and mission transitions separately from MBRF and authoritative triggers.
2. Extract only the selected original clip from verified owned data.
3. Transcode offline or on the private server; cache by source hash, FFmpeg version and parameters.
4. Encode every variant from the original SMK, not another lossy converted variant.
5. Preserve source timing, dimensions/aspect and track selection; compare presentation with classic before applying a stretch.
6. Probe video/audio together with `canPlayType` or Media Capabilities. Check decoded frames, decoded audio and human audibility.
7. Keep separate source/output hashes, codec, dimensions, duration and audio metadata in a cinematic manifest.
8. Provide accessible Play, Skip and Return, with the simulation stopped. Handle mute, blocked autoplay, failure and cancellation.
9. Test inline/fullscreen mobile playback, seeking, sync, transitions and recovered sessions on desktop, iPhone and Android separately.

An example candidate encoding, after inspecting source streams:

```text
ffmpeg -i original.smk -map 0:v:0 -map 0:a:0 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -ar 44100 -b:a 128k -movflags +faststart clip-aac.mp4
```

An independently encoded test fallback can replace audio options with `-c:a libmp3lame -ar 44100 -b:a 128k`. Neither variant establishes universal browser support. Keep media, portable executables and prototype pages outside tracked source and public build inputs.

## Format And Behavior References

Use original data and existing tests first. Consult these references for a specific unresolved contract. Pin new normative revisions and check licensing before copying any implementation.

- [PyMS filename catalogue](https://github.com/poiuyqwert/PyMS/blob/master/PyMS/Data/Listfile.txt): candidate archive paths; verify each against actual hash-table entries.
- [CHK layout, operation IDs, player selectors and MBRF](https://wiki.staredit.net/w/index.php?title=Scenario.chk&oldid=1105).
- [CHK action-field reference](https://www.starcraftai.com/map-making/chk-format).
- [Trigger owner expansion/order](https://wiki.staredit.net/w/index.php?title=Triggers&oldid=560).
- [Per-player waits](https://wiki.staredit.net/w/index.php?title=Wait_blocks&oldid=629), [quantization caveats](https://wiki.staredit.net/w/index.php?title=Hyper_Triggers&oldid=559) and [game-speed measurements](https://wiki.staredit.net/w/index.php?title=Game_speed&oldid=699).
- [Rescue behavior](https://github.com/BoomerangAide/GPTP/blob/ce321f0fa83174aee741b91f1b2eaec30300773e/GPTP/hooks/orders/rescuable_order.cpp): behavior reference, not permission to copy code.
- [Transmission/scheduling reference](https://github.com/neivv/teippi/blob/05c006c2f74ad11285c39d37135aed03d1fb8806/src/triggers.cpp).
- [StormLib block decryption](https://github.com/ladislav-zezula/StormLib/blob/master/src/SBaseCommon.cpp): whole-word handling.
- [PyMS license](https://github.com/poiuyqwert/PyMS/blob/master/LICENSE.md).

References describe intended formats or behavior. They do not prove that this engine implements a contract or matches classic difficulty.
