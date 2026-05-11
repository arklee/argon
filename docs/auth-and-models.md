# Auth and Models

Argon reads user-level auth and model registry files from `ARGON_HOME`, which defaults to `~/.argon`.

## Authentication

Stored credentials live in `~/.argon/auth.json`.

API key entries:

```json
{
  "openai": {
    "type": "api_key",
    "key": "OPENAI_API_KEY"
  }
}
```

OAuth entries are created by `/login` for subscription providers such as `openai-codex`:

```json
{
  "openai-codex": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1765432100000,
    "accountId": "..."
  }
}
```

Argon resolves request auth from CLI overrides, stored credentials, provider environment variables, then `models.json` provider keys.

## Network Proxies

Argon configures Node's global HTTP dispatcher from common proxy environment variables before model and OAuth requests:

- `http_proxy` / `HTTP_PROXY`
- `https_proxy` / `HTTPS_PROXY`
- `all_proxy` / `ALL_PROXY`
- `no_proxy` / `NO_PROXY`

Lowercase variables take precedence over uppercase variables. `all_proxy` is used as the fallback when a scheme-specific proxy is not set, so values such as `socks5://127.0.0.1:1080` can be shared by HTTP and HTTPS requests.

## Models

Custom model/provider configuration lives in `~/.argon/models.json`. The file supports `//` comments and trailing commas.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" }
      ]
    }
  }
}
```

`/model` lists models whose providers have configured auth and saves the selected model to `~/.argon/settings.json` as the next default.

`/thinking` and `/reasoning` list the thinking levels supported by the active model and save the selected level to `~/.argon/settings.json`. Argon accepts `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`; `off` disables the provider reasoning option for future requests.
