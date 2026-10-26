# pi-effort

Extension for [pi](https://github.com/badlogic/pi-mono): small command surface for reasoning effort and OpenAI/Codex fast mode.

Claude Fable reviewed 0.0.7 on 2026-08-15. See [SECURITY.md](SECURITY.md).

## Commands

Exactly two slash commands are exposed:

```text
/effort [min|minimal|low|medium|high|xhigh|max|off|default]
/fast [on|off]
```

Bare `/effort` opens a picker with the current model's levels; Enter applies, Esc cancels.

No `/effort show`, `/effort options`, `/effort fast`, or `/fast status`. Bare `/fast` toggles the current fast-mode setting.

## Effort

`/effort` accepts the current model's supported reasoning levels plus two adaptive aliases:

| Model type | `min` | `max` | Explicit levels |
|---|---|---|---|
| Non-reasoning | — | — | *(thinking unavailable)* |
| Reasoning | `minimal` | `high` | `minimal`, `low`, `medium`, `high` |
| xhigh-capable reasoning | `minimal` | `xhigh` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| max-capable reasoning | `minimal` | `max` | the model's levels up to `max` |
| max-only reasoning | `max` | `max` | `max` |

`off` and `default` differ:

- `/effort off` turns thinking off. Pi sends an explicit "no thinking" field, for example
  `reasoning: { effort: "none" }` to OpenAI or `thinking: { type: "disabled" }` to Anthropic.
- `/effort default` asks the provider for the model's own default effort. Pi has no such level, so
  the extension runs Pi at `off` and removes those "no thinking" fields from each request. The
  footer shows `think:default`. Any other level ends it.

Models that cannot turn thinking off (their `thinkingLevelMap` sets `off` to `null`, such as `gpt-5`)
offer neither.

Examples:

```text
/effort min
/effort medium
/effort max
/effort off
/effort default
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

- `showModelEffortInWorkingMessage: false` — the extension stops setting the working message and clears the one it set before, so Pi's default message returns.
- `showModelEffortInFooter: false` — the extension clears both footer status keys.

Both default to `true`. Only an explicit `false` hides a display.

## Keyboard shortcut

`Ctrl+Shift+E` cycles through the current model's reasoning levels.

## Per-model effort

The extension remembers the last level you chose for each model, and restores it when you switch
back to that model with `/model` or model cycling. Example: `xhigh` on a GPT model, `medium` on
Opus. Switching from GPT to Opus and back gives `medium`, then `xhigh` again, instead of the level
Pi carried over and clamped.

- A level counts as chosen when you set it with `/effort` (including `default`), `Ctrl+Shift+E`,
  or Pi's own thinking selector. The level Pi picks itself when a model cannot run the previous one is not remembered.
- A pinned level in `enabledModels` or `--models` (for example `anthropic/*:high`) wins when cycling.
- A remembered level the model no longer supports is skipped.
- Startup and resumed sessions keep the level Pi chose (`--effort`, `--thinking`, a `:level` model
  suffix, or the saved default). Restore happens on model switches only.

The levels live in `~/.pi/agent/settings.json`, keyed by `provider/model-id`. Delete a key to make
the extension forget that model:

```json
{
  "pi-effort": {
    "modelEffort": {
      "openai/gpt-5.4": "xhigh",
      "anthropic/claude-opus-4-6": "medium"
    }
  }
}
```

## CLI flag

```bash
pi --effort max
pi --effort min
pi --effort high
pi --effort off
pi --effort default
```

The flag uses the same values as `/effort`.

## Install

Requires Pi 0.84 or newer (`@earendil-works/pi-coding-agent`).

```bash
pi install npm:pi-effort
```

Until npm has the latest tag, install from git:

```bash
pi install git:github.com/machine-made/pi-effort
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
