# pi-newapi

A [pi](https://pi.dev) extension that adds a custom model provider for any
**OpenAI-compatible gateway** running [NewAPI](https://github.com/QuantumNous/new-api)
or [one-api](https://github.com/songquanpeng/one-api).

It auto-discovers every model your gateway exposes, resolves real per-model
pricing, and configures the right reasoning/thinking compatibility for each
upstream model family (DeepSeek, Qwen, GLM, Kimi, MiniMax, OpenAI o-series,
…) — with **no hardcoded site URL or key** and **no edits to pi's native
config**.

## Features

- **Auto model discovery** — fetches the gateway's `/api/pricing` endpoint at
  startup (NewAPI's public catalog + pricing API, no key required for listing)
  and registers every available model.
- **Real pricing** — converts NewAPI's `model_ratio` / `completion_ratio` /
  `cache_ratio` / `group_ratio` into $/M-token costs for usage tracking.
- **Reasoning compatibility** — detects each model's upstream vendor from its
  name and sets the correct `thinkingFormat` (`deepseek`, `qwen`, `openai`, …)
  and `requiresReasoningContentOnAssistantMessages` so thinking/reasoning
  tokens stream correctly.
- **Zero-invasive** — registered as its own `newapi` provider; never touches
  pi's built-in providers or your `models.json`.
- **Configurable gateway** — point it at any gateway via environment variables
  or `/login`.
- **Offline cache** — if the pricing fetch fails, the last successful catalog
  is reused so models stay available.
- **Per-model overrides** — correct anything the heuristics get wrong for your
  specific gateway in `~/.pi/agent/newapi-overrides.json`.

## Install

### Option A: as a pi package (recommended)

```bash
pi install npm:pi-newapi
```

### Option B: manual

Copy this directory (or a git clone) into your global extensions folder:

```
~/.pi/agent/extensions/pi-newapi/      # global
<project>/.pi/extensions/pi-newapi/    # project-local
```

The `package.json` declares `"pi": { "extensions": ["./extensions"] }`, so pi
auto-discovers `extensions/index.ts`.

## Configure

Create `~/.pi/agent/newapi-config.json` (a plain JSON file — no environment
variables needed):

```json
{
  "baseUrl": "https://your-gateway.example/v1",
  "apiKey": "sk-..."
}
```

That's it. Restart pi and the extension auto-discovers all gateway models on
startup. To switch gateways or rotate keys, just edit this one file and
restart.

### Interactive: `/newapi-url` command

Inside a pi session you can change the gateway URL without editing files:

```
/newapi-url https://api.another-gateway.com/v1
```

Or just `/newapi-url` with no argument — pi prompts you for the URL. The
command normalizes what you type:

- `https://host`         → `https://host/v1`  (appends `/v1`)
- `https://host/`        → `https://host/v1`
- `https://host/v1`      → unchanged
- `https://host/v1/`     → `https://host/v1`  (strips trailing slash)

It writes the result to `newapi-config.json` and auto-reloads so the new
model list appears immediately.

### Alternative: environment variables

If you prefer env vars (e.g. in CI), they still work as a fallback:

```bash
export NEWAPI_BASE_URL="https://your-gateway.example/v1"
export NEWAPI_API_KEY="sk-..."
```

Priority: config file > env vars. `pi login` (`/login newapi`) stores the key
interactively but the base URL must still come from the config file or the
`/newapi-url` command.

## Usage

```bash
# list discovered models
pi --list-models | grep newapi

# use one (with thinking)
pi --model "newapi/DeepSeek-V4-Flash:high" "explain quicksort"

# interactive session — pick via /model
pi
> /model newapi/GLM-5.2
```

## How reasoning is detected

pi-ai's OpenAI-completions provider is fully static-config driven (no runtime
response probing). This extension inspects each model id and maps it to the
upstream vendor's request style:

| Model id matches | vendor | `thinkingFormat` | notes |
|---|---|---|---|
| `deepseek` | deepseek | `deepseek` | forces empty `reasoning_content` on history |
| `qwen` | qwen | `qwen` | top-level `enable_thinking` |
| `glm` | zhipu | `qwen` | NewAPI often proxies GLM via qwen-compat |
| `kimi`/`moonshot` | moonshot | `openai` | k2.x non-reasoning |
| `o1`/`o3`/`o4` | openai | `openai` | top-level `reasoning_effort` |
| `claude` | anthropic | `openai` | passthrough |
| `gemini` | google | `openai` | passthrough |
| `minimax`/`abab` | minimax | `deepseek` | reasoning_content passthrough |
| `*r1`/`*reasoning`/`*thinking` | reasoning | `openai` | generic |

`pool-` prefixed ids (NewAPI aggregate pools) are stripped before matching.

**Response-side is automatic**: pi-ai consumes `reasoning_content` /
`reasoning` / `reasoning_text` from any upstream, so gateways that forward
those fields work without extra config.

## Overrides

Drop `~/.pi/agent/newapi-overrides.json` to correct any model:

```json
{
  "DeepSeek-V4-Flash": {
    "contextWindow": 128000,
    "maxTokens": 16384,
    "reasoning": true,
    "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028, "cacheWrite": 0 }
  },
  "SomeModelIDontWant": { "ignore": true },
  "GLM-5.2": { "reasoning": false, "displayName": "GLM 5.2 (no thinking)" }
}
```

All fields optional; unspecified fields fall back to the heuristics.

## How pricing is computed

NewAPI charges in "quota" with a baseline of $2 / 1M input tokens:

```
input  $/M = model_ratio * group_ratio * 2
output $/M = input * completion_ratio
cacheRead $/M = input * cache_ratio  (if present)
```

The `default` group ratio is used (NewAPI's `/api/pricing` does not say which
group an API key belongs to). For `pool-*` aggregate models the ratio is the
pool's blend and may differ from the upstream price. Override per-model if you
need exact accounting.

## Files created by this extension

- `~/.pi/agent/newapi-models-cache.json` — offline fallback catalog cache
- `~/.pi/agent/newapi-overrides.json` — your optional per-model overrides
  (you create this)

Nothing else is written. pi's native `models.json` / `models-store.json` are
not modified.

## License

MIT
