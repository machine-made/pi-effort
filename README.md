# pi-effort

Extension for [pi](https://github.com/badlogic/pi-mono): small command surface for reasoning effort and OpenAI/Codex fast mode.

Claude Fable reviewed 0.0.7 on 2026-08-15. See [SECURITY.md](SECURITY.md).

## Commands

Exactly two slash commands are exposed:

```text
/effort {min|minimal|low|medium|high|xhigh|max}
/fast [on|off]
```

No `/effort show`, `/effort default`, `/effort options`, `/effort fast`, or `/fast status`. Bare `/fast` toggles the current fast-mode setting.

## Effort

`/effort` accepts the current model's supported reasoning levels plus two adaptive aliases:

| Model type | `min` | `max` | Explicit levels |
|---|---|---|---|
| Non-reasoning | — | — | *(thinking unavailable)* |
| Reasoning | `minimal` | `high` | `minimal`, `low`, `medium`, `high` |
| xhigh-capable reasoning | `minimal` | `xhigh` | `minimal`, `low`, `medium`, `high`, `xhigh` |

Examples:

```text
/effort min
/effort medium
/effort max
```

## Fast mode

Fast mode is the latency/service-tier knob. When enabled, `pi-effort` adds
`service_tier: "priority"` only for OpenAI, Codex, and Azure OpenAI requests
whose model id starts with `gpt-5`. That tier is billed at a higher token
price. The setting is global and persists until `/fast off`. A session that
starts with it on prints a warning.

`/effort` calls Pi's `setThinkingLevel`. Pi saves that as
`defaultThinkingLevel` for later sessions.

```text
/fast      # toggle
/fast on   # force on
/fast off  # force off
```

Fast mode persists in `~/.pi/agent/settings.json` under:

```json
{
  "pi-effort": {
    "fastMode": true
  }
}
```

## Footer status

For compact powerline footers, the extension publishes these status keys:

- `pi-effort-thinking` — `think:<level>`
- `pi-effort-fast` — `fast` only when fast mode is enabled and applies to the current model

## Display settings

The extension also sets the working message to `Working (<level> effort)...`. Turn off either display in `~/.pi/agent/settings.json`:

```json
{
  "pi-effort": {
    "showModelEffortInWorkingMessage": false,
    "showModelEffortInFooter": false
  }
}
```

- `showModelEffortInWorkingMessage: false` — the extension does not touch the working message. A message it already set stays until Pi restarts.
- `showModelEffortInFooter: false` — the extension clears both footer status keys.

Both default to `true`. Only an explicit `false` hides a display.

## Keyboard shortcut

`Ctrl+Shift+E` cycles through the current model's reasoning levels.

## CLI flag

```bash
pi --effort max
pi --effort min
pi --effort high
```

The flag uses the same values as `/effort`.

## Install

Requires Pi 0.84 or newer (`@earendil-works/pi-coding-agent`).

```bash
pi install npm:pi-effort
```

Until npm has the latest tag, install from git:

```bash
pi install git:github.com/ricardofrantz/pi-effort
```

Verify what Pi is loading:

```bash
pi list
npm list -g --depth=0 pi-effort
```

The durable Pi setting is the package entry in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-effort"
  ]
}
```

## Local development

For a one-off local test from this checkout:

```bash
npm install
pi -e ./index.ts
```

For a longer local-path development install:

```bash
pi remove npm:pi-effort
pi install "$(pwd)"
```

After publishing a new version, switch back to the npm package:

```bash
npm publish
pi remove "$(pwd)"
pi install npm:pi-effort
```

## Verification

```bash
npm run check
npm test
npm pack --dry-run
```

## Repo structure

```text
index.ts        Pi extension entrypoint
effort.ts       Parsing, settings, and model capability logic
package.json    Package metadata and Pi manifest
tsconfig.json   TypeScript configuration
```

## License

Apache-2.0

## Disclaimer

This software is provided "as is", without warranty of any kind. To the extent
permitted by law, the authors and contributors are not liable for any damage, loss
or claim arising from its use or misuse. You are responsible for how you use it and
for following the laws and rules that apply to you. The full terms are in
[LICENSE](LICENSE).
