# OpenBW

An open-source implementation of the StarCraft: Brood War engine, with a browser-playable sandbox. This fork includes desktop and mobile controls, optional computer opponents, replay recording, and peer-to-peer multiplayer.

This is not StarCraft: Remastered. Game graphics, sounds, and data are not included. You need the original game archives to run a local game.

## Run Locally

Run all commands below from the repository root unless stated otherwise.

### Requirements

- Git.
- [WASI SDK 33](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-33), extracted for your operating system.
- Python 3 for the local HTTP server, or another static web server.
- A browser with WebAssembly support.
- The three game archives listed below for playing and headless tests.

The base browser build does not require SDL, CMake, BWAPI, npm, or a StarCraft installation at compile time. Node.js is only needed for the optional headless checks.

### 1. Get The Source

```sh
git clone https://github.com/Pepper-Ng/openbw.git
cd openbw
```

### 2. Add Game Data

Copy these files from your StarCraft: Brood War installation into the following locations. The names are case-sensitive on Linux and some web servers.

```text
web/data/STARDAT.MPQ
web/data/BROODAT.MPQ
web/data/patch_rt.mpq
```

Create the data directory if necessary. These copyrighted archives are ignored by Git and must not be committed or deployed with the site.

Local builds require the files above and report an error if they are missing. The browser caches loaded archives in IndexedDB. Stamped production builds also have the external-download fallback configured in [web/openbw.js](web/openbw.js); the static site itself does not contain game data.

### 3. Build WebAssembly

#### Windows / PowerShell

Set `WASI_SDK` to your extracted SDK directory, then run:

```powershell
$env:WASI_SDK = 'C:\tools\wasi-sdk-33.0-x86_64-windows'
& .\web\build-wasm.ps1
```

Alternatively, pass `-WasiSdk <directory>` to the script. Its default lookup is `%LOCALAPPDATA%\OpenBW\tools\wasi-sdk-33.0-x86_64-windows`.

#### Linux / macOS

Set `WASI_SDK` to the SDK directory for your platform:

```sh
export WASI_SDK=/absolute/path/to/wasi-sdk
bash web/build-wasm.sh
```

Both scripts produce `web/openbw.wasm`. The generated module is ignored by Git. Each build writes a temporary module and renames it when complete, so the web server cannot serve a partially written build.

### 4. Serve And Play

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory web
```

Use `python3` if that is your Python 3 command. Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/). Do not open the HTML directly using `file://`.

For the first run, select **Weave** and leave every opponent set to **None**, then select **Start Game**. This only needs the base module built above. Other listed maps are fetched from external sources; you can also load a local `.scm` or `.scx` file.

Weave is bundled under CC BY 4.0; see [map attribution](web/maps/ATTRIBUTION.md).

## Controls

### Desktop

- Click a friendly unit to select it; drag to box-select. Shift-click adds to the selection.
- Right-click ground, resources, or another unit for a contextual order.
- Use command-card buttons or their configured shortcuts for other actions. A matching letter is highlighted in the name; other keys use a small badge.
- Hold Shift to queue movement and supported commands, including tank transformations.
- Esc cancels placement, targeting, or a submenu first. Otherwise, it cancels the last queued production item, or the item in progress if it is the only one.
- Ctrl + a number assigns a control group; the number recalls it.
- Pan with the minimap, screen edge, arrow keys, or scroll input. Ctrl + scroll zooms the view. Settings contains pointer-lock and fullscreen options.

### Mobile

Landscape is the primary layout; portrait is supported with less room for the map.

- Tap a friendly unit to select it. With a unit selected, tap ground, resources, or enemies for a contextual order.
- Hold, then drag to box-select. Use two fingers to pan and pinch to zoom.
- Action buttons show a name below the icon. Building-strip choices show icons and costs; split grids also show building names.
- **Settings > Controls** contains queue mode, command details, zoom, and control groups. Hold a group button to assign it; tap to recall it.
- With Touch controls, tap or drag to preview a building location, then select Confirm. Cancel abandons placement.

On iPhone, a normal Safari tab may not support fullscreen. Use Safari's **Add to Home Screen** option and launch the app from its icon for a standalone window.

### Interface Options

Open **Options** in the start menu, or **Settings > Options** during play. On narrow screens, the start-menu navigation is behind the menu button.

The in-game menu keeps common actions on its first page. Objectives, Save game, Controls and More open separate views. Back returns to the first page; Close returns to play. Headers remain accessible while long content scrolls inside the panel. Short landscape screens use two columns for common actions.

- Select Automatic, Touch, or Mouse & Keyboard input independently of the visible action buttons.
- Choose contextual essentials or full actions. Contextual SCV orders remain available in either mode.
- Use an adaptive layout or a three-column grid. Grids scroll beyond nine commands.
- Choose a combined building strip or separate Basic and Advanced grids.
- Hide locked units/buildings or show them disabled.
- Adjust UI size from 75% to 150%, with Small, Medium and Large presets. Resources scale gently with this setting and the screen width.
- Set minimap size independently from 50% to 200%. Its on-screen size stays independent of world zoom.
- Choose **Objectives location**: expanded/collapsed on screen, or **Settings menu only**. The live objectives appear in exactly one location; mission timers and counters stay on screen. Menu objectives use their own readable page without the standalone overlay decoration.
- Pin Pause on screen or keep it in the game menu. Multiplayer cannot be paused.
- Pin the sound button beside Settings or keep it in the game menu.

Options preview immediately. **Apply** saves them in this browser; **Cancel** restores the previous settings. Opening Interface Options pauses a running single-player game and restores its previous pause state on close.

Automatic menu defaults follow the screen's pointer profile, not the most recent mouse or touch event. Switching devices therefore does not change explicitly configured menus.

### Keyboard Customization

On desktop, open **Options > Hotkeys** before a game or during play. On mobile, use the smaller **Keyboard shortcuts…** entry under **Options > Controls** or **Settings > Controls**; the Hotkeys tab does not occupy the mobile navigation. It remains available for external keyboards.

Search by unit, producer, ability or action. Select a binding and press a key or chord; use **Unbind** or **Reset** for an individual action.

- Classic uses the engine's original shortcuts. Grid assigns QWE / ASD / ZXC, then additional unused letters, in command-card order.
- Custom bindings override either base profile. For example, assign **A** to **Train Terran Marine** instead of M.
- Bindings use physical key positions, including function, arrow, punctuation and numpad keys. Ctrl, Alt, Shift and Meta can be part of a chord; modifier keys alone remain available for selection and queuing.
- Shift queues ordinary commands unless an explicit Shift shortcut matches. Control groups, camera movement, Cancel and interface actions are also reassignable.
- Conflicting shortcuts in the same context must be resolved before Apply. Different production buildings can reuse a key. New runtime conflicts produce a visible message instead of executing an ambiguous command.
- Escape cancels key capture; **Use Escape** assigns Escape. Escape always closes Options even when the game's Cancel binding changes.
- Browser and operating-system shortcuts cannot all be captured. Common reserved combinations are rejected.
- Button hints and Controls help reflect the current bindings. Matching single-letter keys highlight the character in the name; other keys use a badge. Escape is displayed as **Esc**, numpad digits as **#7**, for example. The implicit Esc shortcut on Cancel/Back is omitted. Modifier chords retain their full hint.
- Hiding an action button does not disable its keyboard command, and unbinding a key does not disable its button.

Apply persists keyboard settings with the interface preferences. Cancel discards the edits. Existing alternate-Escape preferences migrate to the **Alternate Cancel / Back** binding.

Per-unit custom button sets are not yet exposed.

## Optional Computer Opponents

The base build does not include bots. Selecting one requires its separate module:

| Opponent | Browser Module |
| --- | --- |
| ZZZKBot | `web/openbw-bot.wasm` |
| McRave | `web/openbw-mcrave.wasm` |

The bot scripts fetch their own BWAPI and bot sources and require Bash, CMake, Python 3, Git, and WASI SDK. With `WASI_SDK` set, run:

```sh
bash web/bot/vendor.sh
bash web/bot/build-web.sh
BOT=mcrave bash web/bot/build-web.sh
```

These are optional, heavier builds. They are separate from the Windows PowerShell base-build script. See [the bot integration notes](web/bot/README.md) for architecture and porting details; some older status notes there describe earlier versions of the integration.

Bot behavior remains experimental. In particular, McRave has known problematic code paths in this port.

## Multiplayer And Replays

**Host a game** and **Join with a code** use WebRTC data channels with copy-and-paste connection setup. Both players need matching application builds and map data. This does not start a dedicated game server. Restrictive NAT or firewall configurations can prevent a connection because this setup has no TURN relay.

Games record a Brood War `.rep`; the game-over screen offers **Save replay**. An optional WebSocket bridge is a separate path; its build entry point is [web/build-bridge.sh](web/build-bridge.sh).

## Development Checks

After rebuilding the browser module, use Node.js 20 or newer to run the headless command regressions:

```sh
node web/run-wasm-node.mjs --test-commands
node web/run-wasm-node.mjs --test-interface
node web/run-wasm-node.mjs --test-hotkeys
```

The runner loads the local MPQs and bundled Weave map. It checks queued input, control groups, Esc cancellation, refunds, and tank-mode transitions against the real WebAssembly engine.

The interface and hotkey checks also run without game archives. After changing native shortcut tables, regenerate their pre-game catalog with `node web/generate-hotkey-catalog.mjs`. The hotkey checks verify that the committed catalog matches the native sources.

To render a headless framebuffer image instead:

```sh
node web/run-wasm-node.mjs web/frame.ppm
```

The PPM output is ignored by Git. Node may print an experimental WASI warning.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing local game data | Check all three MPQ paths and filename casing above. |
| Computer-opponent module is missing | Set all opponents to None, or build the selected bot module. |
| HTML returned instead of WebAssembly | Check the server URL and that the requested `.wasm` file exists. |
| Changes do not appear | Rebuild after C++ edits, then reload with the browser cache disabled or a fresh URL query string. |
| A listed map fails to load | Try bundled Weave or a local map file; other maps need external network access. |
| Game stalls or stops updating | Inspect the browser console. Include the error, browser, map, selected unit, and preceding action in a bug report. |

This is an experimental engine and sandbox, not a fully certified replacement for the original game. A working base-game smoke test does not establish that every ability, bot, map, or multiplayer configuration works.

## Deployment

Portainer builds the browser module from the [Dockerfile](Dockerfile) using the WASI SDK, then serves the static site with Nginx. No GitHub Actions workflow or container registry is required. Optional computer-opponent modules are not included in this standard build; build them separately using the steps above. No game archives are included.

Deploy [compose.yml](compose.yml) as a Git-backed Portainer stack from the `master` branch and enable Git auto-updates (for example, a five-minute interval). Portainer checks out the changed source and rebuilds the service locally. The Compose file publishes port `18082`; configure your reverse proxy to forward to the Docker host on that port. No domain name is required by the repository.

## Source Layout

| File | Purpose |
| --- | --- |
| [bwgame.h](bwgame.h) | Simulation, orders, and game rules. |
| [web/sandbox.h](web/sandbox.h) | Playable sandbox UI and command serialization. |
| [web/wasm_main.cpp](web/wasm_main.cpp) | Browser-facing engine exports. |
| [web/wasm_backend.cpp](web/wasm_backend.cpp) | Software framebuffer and input backend. |
| [web/openbw.js](web/openbw.js) | Asset loading, browser input, rendering, and startup. |
| [web/net.js](web/net.js) | Peer communication and lockstep scheduling. |
| [web/build-native.sh](web/build-native.sh) | Optional native sandbox build using Clang and SDL2. |

This fork is based on [heiner/openbw](https://github.com/heiner/openbw). For the separate native BWAPI integration, see [OpenBW/bwapi](https://github.com/OpenBW/bwapi); it is not required for the base browser build described above.
