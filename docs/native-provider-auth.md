# Native provider authentication

Canopy’s native executor owns the session, prompt, model tool requests, tool execution, and governance. Provider authentication selects the transport credentials only; a provider CLI never becomes a second agent harness.

## OpenAI

Use `native.auth_route: "openai_codex_cli"` with `provider_id: "openai"` and `adapter_id: "openai-compatible"` to use an operator’s first-party Codex CLI login. Authenticate with `codex login` before starting a native session. Canopy invokes `codex exec` as a model-only inference transport, with isolated `HOME`, ignored user config and rules, an ephemeral session, read-only sandboxing, and CLI shell, MCP, plugins, hooks, apps, web search, and multi-agent surfaces disabled. The first-party `CODEX_HOME/auth.json` remains the CLI’s durable auth store so Codex can persist rotated refresh tokens; Canopy serializes its own calls around that file and does not store prompts or session state there. An expired access token remains ready when the record has a refresh token, allowing the CLI to refresh it. The route requires an owned, non-symlink `CODEX_HOME` without group or other write access and an owned, non-symlink `auth.json` with mode `0600`; readiness reports unsafe stores as unavailable. The upstream CLI does not provide a shared cross-process lock for refresh writes, so do not run another Codex CLI or Codex client against the same `CODEX_HOME` concurrently with Canopy. The subscriber credential is never sent to the public OpenAI API. The CLI process is terminated after five minutes, with `SIGKILL` escalation if graceful termination does not complete. The CLI transport currently does not expose provider usage counters to Canopy, so usage accounting is unavailable.

Canopy’s auth-store lock is atomically claimed and serializes Canopy invocations. It reclaims a dead inference owner only while holding its own reaper lock. If a process crashes while holding the reaper, or a lock record is malformed, Canopy leaves it untouched and fails closed after a bounded wait. The error names the exact lock path and recorded PID when available. For manual recovery, inspect the named record, verify the PID belongs to the recorded owner and is no longer running, then remove only that exact stale lock file; never remove a lock with a live or indeterminate owner. See the [Codex CLI reference](https://developers.openai.com/codex/cli/reference) and [Codex config reference](https://developers.openai.com/codex/config-reference). Use `native.auth_route: "provider_api"` (the default) with `OPENAI_API_KEY` or `ARBOR_NATIVE_API_KEY` for public OpenAI API inference.

## Anthropic

Use `native.auth_route: "claude_code_cli"` with `provider_id: "anthropic"` and `adapter_id: "anthropic-messages"` to retain sign-in inside Claude Code. The local bridge disables the CLI’s own tools, settings, hooks, and MCP and translates only Canopy-composed tool requests into structured model output. Use `provider_api` and an Anthropic API key for direct Messages API inference. Claude subscription OAuth is not treated as a direct API key. See [Claude Code authentication](https://docs.anthropic.com/en/docs/claude-code/getting-started).

## OpenRouter

Manual API keys remain supported through `OPENROUTER_API_KEY` or `ARBOR_NATIVE_API_KEY`. For provider-owned OAuth consent, run `arbor native-auth openrouter login`, then select `native.credential_source: "openrouter_oauth"`. Canopy uses [OpenRouter’s documented PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth) and exchanges the one-time code for the user-controlled API key. The key is stored outside project configuration and environment overlays at `${XDG_CONFIG_HOME:-~/.config}/arbor/credentials/openrouter.json`; the directory is owned by the current user with mode `0700`, and the file is written atomically with mode `0600`. The runtime checks ownership and permissions before resolving it into the existing opaque credential overlay and session-scoped lease.

This is a private user file, not an encrypted OS keychain. Remove it to revoke the local copy; revoke the provider key in the OpenRouter account to invalidate the credential itself. The path can be overridden with `ARBOR_OPENROUTER_OAUTH_CREDENTIAL_PATH` for controlled deployments; an override must point into an existing owned private parent directory, which Canopy will not chmod or create.

## Ollama

Local Ollama needs no credential. Ollama Cloud uses `OLLAMA_API_KEY`; its bearer credential is attached only to the configured Ollama endpoint.
