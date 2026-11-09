# Agent Terminal

A desktop terminal for working with coding agents. Every tab is one folder, split in two:

- a **shell pane** (PowerShell, cmd, Git Bash, WSL, bash, zsh, ...) in that folder, and
- an **agent pane** running your agent CLI (Claude Code, GitHub Copilot CLI, Codex, Gemini CLI, OpenCode, or any command you add) in the same folder, **exactly as it looks in a normal terminal**. No chat overlay or wrapper: you get the CLI's own interface.

Tabs live in a vertical sidebar (or a horizontal strip) that shows each tab's folder, git branch and status, and the model its agent is using.

Inspired by [microsoft/intelligent-terminal](https://github.com/microsoft/intelligent-terminal). It keeps that app's sidebar tabs, default profile, split agent pane, color schemes and the applicable actions and key bindings. It drops the ACP chat overlay in favor of the raw CLI.

---

## Install (for the team)

1. Make sure you can see [CNSteuerwald/agent-terminal](https://github.com/CNSteuerwald/agent-terminal) (it's private; ask to be added as a collaborator).
2. Download **`Agent-Terminal-Setup-<version>.zip`** from the [latest release](https://github.com/CNSteuerwald/agent-terminal/releases/latest). It's the only file you need. The release's other files are for auto-update.
3. Extract the zip and run `Agent-Terminal-Setup-<version>.exe`. It installs for your user only, so no admin rights are needed, and adds a Start menu shortcut.
4. The installer isn't code-signed yet, so Windows may still warn you:
   - **"Windows protected your PC":** click **More info → Run anyway**.
   - **Blocked with no "Run anyway":** before running it, right-click the `.exe` → **Properties** → tick **Unblock** → **OK**. In PowerShell, `Unblock-File .\Agent-Terminal-Setup-<version>.exe` does the same.

### Updating

The app checks for new releases on launch and every 4 hours. It downloads them in the background, then offers **Restart now** (your tabs reopen) or installs the next time you quit.

While the repo is private, update checks use your GitHub CLI login. Run `gh auth login` once with the account that can see the repo. Without it, updates are manual: install the newest zip from Releases the same way, and your settings and tabs are kept.

## Releasing a new version (maintainers)

**From GitHub (no local commands):**

1. Open **[Actions → Release](https://github.com/CNSteuerwald/agent-terminal/actions/workflows/release.yml)** and click **Run workflow** (branch: `master`).
2. Pick the bump:
   - **patch:** fixes (0.1.0 → 0.1.1)
   - **minor:** new features (0.1.0 → 0.2.0)
   - **major:** breaking changes (1.0.0)
   - **current:** release the version already in `package.json` without bumping it, for example the very first release
3. Click **Run workflow**.

[`.github/workflows/release.yml`](.github/workflows/release.yml) then runs the tests and bumps the version in `package.json` with a `Release vX.Y.Z` commit on `master` and a tag. It creates the GitHub Release as a draft with auto-generated notes, builds the installer, uploads it with a zipped copy, then publishes the release. Installed copies pick it up automatically. Run `git pull` afterwards to get the version commit locally.

Each release has four files:

| File | What it's for |
|---|---|
| `Agent-Terminal-Setup-<version>.zip` | The installer, zipped. **This is what teammates download**, because browsers and Windows often block a bare unsigned `.exe` download. |
| `Agent-Terminal-Setup-<version>.exe` | The installer itself. Auto-update downloads and runs this. |
| `latest.yml` | Tells installed copies which version is newest and where its installer is. Without it, updates stop. |
| `Agent-Terminal-Setup-<version>.exe.blockmap` | Lets the updater download only the parts that changed since your installed version, instead of the whole ~125 MB installer. Without it, updates fall back to the full download. |

The last three must stay as separate files, and must not be renamed or deleted on a published release. The updater fetches each one by name and can't read them out of a zip.

**From the command line,** if you prefer:

```powershell
git checkout master; git pull
npm version patch      # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Pushing the tag runs the same workflow, which fails if the tag doesn't match `package.json`'s version.

To build an installer locally without publishing, run `npm run dist`. It writes the same three files to `dist\`. Only the `.exe` matters for a local install.

> **Going public later:** make the repo public, remove `"private": true` from `build.publish` in `package.json`, and delete the `gh auth token` shortcut in `src/main/updater.js`. Updates then work for everyone with no GitHub login.

---

## Run it from source (development)

### Prerequisites

| Requirement | Notes |
|---|---|
| [Node.js](https://nodejs.org/) 20 or newer | Includes npm. Check with `node --version`. |
| [Git](https://git-scm.com/) | Used for the git branch/status shown in tabs. |
| At least one agent CLI on your `PATH` | e.g. `claude` ([Claude Code](https://docs.claude.com/en/docs/claude-code)), `copilot`, `codex`, `gemini`, `opencode`. Check with `claude --version`. |
| Windows 10 1809+ / macOS / Linux | Developed and tested on Windows 11. |

### Install and start

```powershell
cd C:\Dev\agent-terminal
npm install
npm start
```

To open a specific folder as the first tab:

```powershell
npm start -- C:\path\to\your\repo
```

On first launch a short **setup wizard** asks for your default agent (it shows which CLIs it found on your `PATH`), default shell, starting folder, layout and colors, and whether to turn on **Docker Sandboxes** support. You can skip it, and you can run it again any time from **Settings → General** or the command palette (*Run setup wizard*).

After setup, the first tab opens in your starting directory with your default shell on one side and your agent on the other.

> **If `npm start` says Electron failed to install:** recent npm versions only run install scripts for packages listed under `allowScripts` in `package.json`. Electron is already listed there. If the download was still skipped, run `node node_modules/electron/install.js` once.
>
> **Linux only:** `node-pty` ships prebuilt binaries for Windows and macOS, but on Linux it compiles from source. Install build tools (`build-essential`, `python3`), then run `npm approve-scripts node-pty && npm rebuild node-pty`.

### Run the tests

```powershell
npm test
```

---

## Using it

### Tabs and the sidebar

- **+ Claude Code** (`Ctrl+Shift+T`) opens a tab with your default agent and a terminal, in the starting directory. The button is named after your default agent.
- **+ Terminal** (`Ctrl+Alt+T`) opens a tab with just a terminal. `cd` wherever you want, then click **+ Claude Code** in the pane header, and the agent starts in the folder your shell is in.
- **Open folder…** (`Ctrl+Shift+O`) picks a folder and opens a tab there.
- The **▾** button opens a tab with a specific shell or a specific agent.
- **Tabs follow your shell.** The directory and git status update as you `cd`. PowerShell, cmd and Git Bash are set up for this automatically (they report the folder at each prompt). Other shells work if they emit the standard OSC 7 / OSC 9;9 sequences.
- **Tabs reopen on launch.** Your tabs, folders, titles, split layout and window size are saved as you go, and restored the next time you start the app. Processes can't survive closing, so each pane restarts. Claude Code, Copilot and OpenCode are started with `--continue` to resume their last conversation in that folder, and start fresh if there isn't one. Turn this off in **Settings → General → Reopen tabs on launch**.
- Each tab shows (toggle each in **Settings → Tabs**):
  - **Directory**: the tab's folder
  - **Git**: branch, ↑ahead / ↓behind, and number of changed files (✓ when clean)
  - **Agent and model**: e.g. `✦ claude-opus-5-5 · Claude Code`
  - **Activity dot**:
    - **Blue, pulsing:** the agent is working.
    - **Green:** the agent finished while you were on another tab.
    - **Amber:** it rang the bell (needs attention).
    - Output caused by your own typing, resizing or switching tabs doesn't count, and nothing counts until you've typed something to that agent.
- Double-click a tab title to rename it. Middle-click closes it. Drag tabs to reorder.
- **Right-click a tab** to color it, rename it or close it. Choose a swatch or a custom color. The focused tab gets a soft tint of its color, and other tabs show just a colored edge. Colors are saved with your tabs.
- Switch between a **vertical** sidebar and **horizontal** tabs in **Settings → Tabs**, or with the *Toggle vertical / horizontal tabs* command. Drag the sidebar edge to resize it. `Ctrl+Shift+S` hides it.

### Panes: as many terminals and agents as you want

Each tab in the sidebar holds a layout of **panes**: terminals and agents, any number of each. Panes sit in **groups**. A group has a tab strip along its top, and groups are split side by side or stacked, like editor groups in VS Code.

- **Add a pane:** the **+** at the right end of a group's tab strip adds a terminal (any shell profile) or an agent (any CLI). The menu also chooses where new panes go: as a **Tab** in that group, **Split right**, or **Split down**. `Ctrl+Shift+E` adds a terminal, `Alt+Shift+=` / `Alt+Shift+-` split one off right / down, and `Ctrl+Shift+.` opens (or cycles through) agent panes.
- **Close a pane** with the **×** next to its name, a middle-click on its tab, or `Ctrl+Shift+W`. Closing a tab's last pane closes the tab.
- **Drag a pane's tab** to rearrange. A highlight shows exactly where it will land:
  - onto the **edge** of a pane: splits that pane, and the pane goes on that side
  - onto the **middle** of a pane: joins that group as a tab
  - onto a **tab strip**: inserts it at that spot (also reorders tabs)
  - onto **another tab in the sidebar**: moves it into that tab, still running
  - onto **empty sidebar space**: opens it as its own tab
  - `Esc` cancels a drag.
- **Resize** by dragging the bar between panes, or with `Alt+Shift+Arrows`. **Move focus** between panes with `Alt+Arrows`. `Ctrl+Shift+I` jumps between your terminal and your agent.
- **Right-click a pane's tab** to rename it, restart it, split it off, move it to a new tab or close it. Double-click renames.
- Each agent's tab icon pulses while that agent works. The sidebar shows the model of the focused (or first) agent, with `+N` when a tab has more.
- New tabs start as a terminal plus your default agent, arranged per **Settings → General → New tab layout** (agent right / left / below / above, or both as tabs in one group).
- **Customize** in **Settings → Panes**: where new panes open, the snap preview and its animation, how much of a pane's edge counts as "split here" (vs. "stack as a tab"), and whether close buttons always show.
- Layouts, including splits, sizes, stacked tabs and pane names, are saved and reopen with your tabs.
- **Ctrl+scroll** over a terminal makes the text bigger or smaller (same as `Ctrl+=` / `Ctrl+-`, with `Ctrl+0` to reset).
- When a process exits, press **Enter** in its pane to restart it.
- In the agent pane, `Shift+Enter` sends a newline (Meta+Enter) instead of submitting, which Claude Code and most agent TUIs understand.

### Docker Sandboxes (sbx)

Turn this on in the setup wizard or **Settings → Sandboxes**. It needs [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) installed, with `sbx` on your `PATH`.

- A tab titled **sbx** is pinned first in the tab list, styled in Docker blue so it stands apart from your workspace tabs. It runs the `sbx` dashboard (TUI) filling the whole tab, and the sidebar shows how many sandboxes are running.
- When you open a sandbox from that dashboard (**Enter**, then **External terminal**), it opens **here as a new tab** named after the sandbox. The tab holds the sandbox session plus a host shell in the sandbox's workspace folder, with git status in the sidebar. Opening a sandbox that already has a tab switches to that tab.
- If you choose **In this terminal** in the dashboard instead, the session runs inside the sbx tab, which is normal sbx behavior.
- Closing the sbx tab is fine. Reopen it with *Open Docker Sandboxes (sbx) tab* from the palette or the **▾** menu.

**How it works (Windows):** when the sbx dashboard sees `WT_SESSION`, it opens sandboxes with `wt.exe -w new nt -- sbx … run --name <sandbox>`. Inside the sbx tab only, Agent Terminal puts its own small `wt.exe` first on `PATH` ([`src/shim/wt.cs`](src/shim/wt.cs)). That `wt.exe` sends the request to the app over a local named pipe, protected by a per-launch random token, and the app opens the tab. It only ever runs `sbx` with the arguments sbx asked for. The `wt.exe` is compiled on first use with the C# compiler built into Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) and cached in the app's data folder. On macOS/Linux the sbx tab works, but sandboxes still open in sbx's own choice of external terminal.

### Copy and paste

- **Select** by dragging, in both the shell and the agent pane. Claude Code and other full-screen CLIs capture the mouse, and in those panes a drag still selects text while a plain click goes to the app, so Claude's clickable buttons keep working. To send drags to the app instead, turn off **Settings → General → Drag selects text in apps that use the mouse**. Then hold Shift to select.
- **Copy** with `Ctrl+C` while text is selected (without a selection `Ctrl+C` still interrupts), `Ctrl+Shift+C`, or **right-click**. A short "Copied N characters" notice confirms it.
- **Paste** with `Ctrl+V`, `Ctrl+Shift+V`, or right-click when nothing is selected.
- CLIs can also copy to your clipboard themselves using OSC 52 (Claude Code, tmux, Neovim). Reading your clipboard that way is blocked.

### How the model name is found

| Agent | Source |
|---|---|
| Claude Code | Live: the newest session transcript in `~/.claude/projects/<folder>/`, so it follows `/model` switches. Falls back to `--model` in the agent command, then `model` in `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`. |
| Codex | `--model`/`-m` in the command, else `model` in `~/.codex/config.toml` |
| Gemini CLI | `--model`/`-m`, else `model.name` in `~/.gemini/settings.json` |
| Copilot CLI | `--model`, else `model` in `~/.copilot/config.json` |
| OpenCode | `--model`/`-m`, else `model` in `opencode.json` (project) or `~/.config/opencode/opencode.json` |

If nothing is found, only the agent name is shown. That usually means the CLI is on its own default model.

### Default keyboard shortcuts

All of these can be rebound in **Settings → Actions** (click the field and press the new keys), or in `settings.json`.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New tab: agent + terminal |
| `Ctrl+Alt+T` | New tab: terminal only |
| `Ctrl+Shift+O` | Open folder in new tab |
| `Ctrl+Shift+D` | Duplicate tab (same panes and layout) |
| `Ctrl+Shift+W` | Close focused pane (the tab closes with its last pane) |
| `Ctrl+Shift+E` | New terminal pane |
| `Alt+Shift+=` / `Alt+Shift+-` | Split right / down with a new terminal |
| `Alt+Arrows` | Focus the pane to the left / right / above / below |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Alt+1`…`8`, `Ctrl+Alt+9` | Switch to tab N / last tab |
| `Ctrl+Shift+S` | Toggle tab sidebar |
| `Ctrl+Shift+.` | Open an agent pane, or cycle focus through agent panes |
| `Ctrl+Shift+I` | Switch focus between terminal and agent |
| `Alt+Shift+Arrows` | Move the split between panes |
| `Ctrl+Shift+P` | Command palette (all actions, color schemes, switch agent, go to tab) |
| `Ctrl+,` | Settings |
| `Ctrl+Shift+,` | Open `settings.json` |
| `Ctrl+Alt+,` | Open the full effective settings (read-only reference) |
| `Ctrl+Shift+C`, `Ctrl+C` with a selection | Copy |
| `Ctrl+Shift+V`, `Ctrl+V` | Paste (if the clipboard has no text, e.g. an image, the key goes to the CLI) |
| `Ctrl+Shift+A` | Select all |
| `Ctrl+Shift+F` | Find |
| `Ctrl+Shift+Up/Down/PgUp/PgDn/Home/End` | Scroll |
| `Ctrl+Shift+K` | Clear buffer |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, Ctrl+scroll | Font size bigger / smaller / reset |
| `Ctrl+Shift+N` | New window |
| `F11`, `Alt+Enter` | Toggle fullscreen |
| `Shift+Enter` (agent pane) | Newline instead of submit |
| `Ctrl+Shift+F12` | Developer tools |

Unbound by default (available in the palette): close tab, rename tab, move tab forward/backward, rename pane, restart pane, move pane to a new tab, toggle split orientation, zoom pane, open the sbx tab, run setup wizard, open tab folder in file explorer, toggle always on top, toggle tab layout.

---

## Settings

Use the **Settings** screen (`Ctrl+,`) for everyday options. Everything lives in one JSON file, which you can also edit by hand. Changes apply immediately.

| OS | Location |
|---|---|
| Windows | `%APPDATA%\agent-terminal\settings.json` |
| macOS | `~/Library/Application Support/agent-terminal/settings.json` |
| Linux | `~/.config/agent-terminal/settings.json` |

The file only holds what you changed. Run *Open default settings* (`Ctrl+Alt+,`) to see every key with its current value.

```jsonc
{
  "setupComplete": true,                   // false (or missing) shows the setup wizard on next launch
  "sandboxEnabled": false,                 // Docker Sandboxes: pinned "sbx" tab
  "sandboxCommand": "sbx",                 // name or full path of sbx
  "defaultProfile": "PowerShell",          // shell for new tabs (a profile name)
  "defaultAgent": "claude",                // agent id for new tabs, "" for none
  "startingDirectory": "~",
  "tabLayout": "vertical",                 // "vertical" | "horizontal"
  "sidebarWidth": 260,
  "tabMetadata": { "directory": true, "git": true, "model": true, "activity": true },
  "agentPanePosition": "right",            // new tab layout: "right" | "left" | "bottom" | "top" | "tab"
  "newPanePlacement": "tab",               // + button: "tab" | "right" | "down"
  "snapPreview": true, "paneAnimations": true,
  "snapEdge": 30,                          // % of a pane that counts as its edge when dropping
  "paneCloseButton": "always",             // "always" | "hover"
  "agentPaneSize": 50,                     // percent
  "theme": "dark",                         // "dark" | "light" | "system"
  "colorScheme": "Campbell",
  "fontFace": "'Cascadia Mono NF', 'Cascadia Mono', Consolas, monospace",
  "fontSize": 14,
  "cursorShape": "bar",                    // "bar" | "block" | "underline"
  "copyOnSelect": false,
  "confirmOnClose": true,                  // ask before closing a window with several tabs ("Don't ask me again" sets false)
  "restoreSession": true,                  // reopen tabs on launch

  // Agents merge with the built-ins by id. Add your own or change a command.
  "agents": [
    { "id": "claude", "command": "claude --model opus", "colorScheme": "One Half Dark" },
    { "id": "aider", "name": "Aider", "command": "aider --no-auto-commits" }
  ],

  // Shell profiles merge with the detected ones by name. "hidden": true removes one.
  "profiles": [
    { "name": "Ubuntu", "commandline": "wsl.exe", "args": ["-d", "Ubuntu"] },
    { "name": "Command Prompt", "hidden": true }
  ],

  // Extra color schemes, in Windows Terminal's format (paste them straight from WT).
  "schemes": [],

  // Action id -> key combo (or a list of combos). "" unbinds.
  "keybindings": { "toggleAgentPane": "ctrl+alt+a", "copy": ["ctrl+shift+c", "ctrl+insert"] }
}
```

*(Comments are for illustration. The real file must be plain JSON.)*

**Color schemes.** These are the same built-in schemes as Intelligent Terminal and Windows Terminal: Campbell, Campbell Powershell, Dimidium, Ottosson, Vintage, One Half Dark/Light, Solarized Dark/Light, Tango Dark/Light, Dark+, VSCode Dark/Light Modern, CGA and IBM 5153. Set a default, override it per shell profile or per agent, or switch the focused pane from the palette (*Color scheme: …*).

**Agent commands** run through your platform shell (`cmd /c` on Windows, `$SHELL -lc` elsewhere). npm shims such as `copilot.cmd` work, and anything you can type at a prompt works too.

---

## Project layout

```
src/
  main/main.js       Electron main process: windows, PTYs (node-pty), IPC, settings file watch
  main/settings.js   Defaults, shell detection, settings merge/patch, launch commands
  main/info.js       Git status and agent-model detection for the sidebar
  main/updater.js    Auto-update from GitHub Releases (electron-updater)
  main/sandbox.js    Docker Sandboxes: sbx lookup, wt.exe stand-in build, named-pipe listener
  shim/wt.cs         The wt.exe stand-in used inside the sbx tab (Windows)
  preload.js         The small, explicit API the UI may call (context-isolated, sandboxed)
  renderer/          UI: index.html, styles.css, app.js (tabs, panes, drag and drop, actions, settings, palette), keys.js
  renderer/layout.js Pane layout tree (splits and groups): pure and unit-tested
  shared/schemes.json  Built-in color schemes
test/                Node test runner tests for the pure logic
```

The UI is plain JavaScript with [xterm.js](https://xtermjs.org/), with no framework and no build step. Edit a file and restart with `npm start`.

## Troubleshooting

- **Prompt shows boxes instead of icons:** your prompt (oh-my-posh, starship) needs a Nerd Font. Install one and set `fontFace` to it, e.g. `"'CaskaydiaCove Nerd Font Mono'"`.
- **`'claude' is not recognized`** in the agent pane: the CLI isn't on the `PATH` the app was started with. Check `claude --version` in a new terminal, then restart Agent Terminal.
- **Started from inside another Claude Code session:** child processes inherit that session's environment variables, and Claude Code may warn about it. Start Agent Terminal from a regular terminal, Explorer or a shortcut.
- **Sandboxes from the sbx tab open in Windows Terminal instead of here:** the `wt.exe` stand-in couldn't be built (no `csc.exe`). Check that `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` exists. Until then, choose **In this terminal** in the sbx dialog.
- **Settings file has a syntax error:** a message appears at the bottom of the window and the app keeps the defaults until the file parses again.

## Not included (yet)

Keeping processes alive across restarts (tabs reopen and agents resume, but processes restart), code signing, macOS/Linux installers, and the original's ACP chat, error auto-fix and session-management features. The agent's own CLI covers most of those.
