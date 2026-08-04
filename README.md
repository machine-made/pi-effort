# pi-effort

Extension for [pi](https://github.com/badlogic/pi-mono): small command surface for reasoning effort and OpenAI/Codex fast mode.

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
| max-capable reasoning | `minimal` | `max` | `minimal`, `low`, `medium`, `high`, `max` |

Examples:

```text
/effort min
/effort medium
/effort max
```

## Fast mode

Fast mode is the latency/service-tier knob. When enabled, `pi-effort` adds
`service_tier: "priority"` to GPT-5 / OpenAI-Codex provider requests that do not
already specify a tier.

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

```bash
pi install npm:pi-effort
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
