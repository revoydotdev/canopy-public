export const CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Arbor Configuration",
  type: "object",
  properties: {
    agents: {
      type: "object",
      description: "Model assignments for each of the 11 agents",
      additionalProperties: {
        type: "object",
        properties: {
          model: { type: "string" },
          compaction: {
            type: "object",
            properties: { model: { type: "string" } },
          },
          foreground: {
            type: "object",
            properties: {
              modes: { type: "array", items: { type: "string", enum: ["streaming", "steerable", "promote"] }, uniqueItems: true },
              inputs: { type: "array", items: { type: "string" }, uniqueItems: true },
              outputs: { type: "array", items: { type: "string" }, uniqueItems: true },
            },
          },
        },
        required: ["model"],
      },
    },
    categories: {
      type: "object",
      description: "Model assignments for each task category",
      additionalProperties: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
      },
    },
    tree_search: {
      type: "object",
      properties: {
        max_seconds: { type: "number", minimum: 0, description: "Optional campaign wall-clock budget in seconds; 0 disables it" },
        min_score: { type: "number", minimum: 0 },
        exploration_constant: { type: "number", exclusiveMinimum: 0 },
        convergence_iterations: { type: "integer", minimum: 1 },
      },
    },
    kb: {
      type: "object",
      description: "KB storage backend: jsonl (default) or sqlite",
      properties: {
        backend: { type: "string", enum: ["jsonl", "sqlite"] },
      },
    },
    native: {
      type: "object",
      description: "Non-secret revoy-native provider and closed wire-adapter selection. API credentials are callback-only overlays; OpenRouter OAuth keys use a private user credential file.",
      properties: {
        mode: {
          type: "string",
          enum: ["auto", "native", "fallback"],
          description: "\"auto\" (default) prefers direct native execution once adapter_id/provider_id/base_url/model are complete, falling back to the connector otherwise. \"native\" fails closed instead of falling back. \"fallback\" (ADR-099 §2) is the documented, deliberate way to opt into connector delegation even when native.* is complete -- pin the operator's reason for it in an adjacent JSONC comment (e.g. \"// no native credential provisioned for this environment yet\", \"// connector X required for feature Y the native path doesn't cover\").",
        },
        adapter_id: { type: "string", enum: ["openai-compatible", "anthropic-messages", "aws-bedrock-messages", "gcp-vertex-messages", "ollama-native"] },
        provider_id: { type: "string" },
        base_url: { type: "string" },
        model: { type: "string" },
        revision: { type: "string", description: "Optional provider-declared response revision. A supporting adapter must observe an exact match before it is treated as pinned." },
        closed_route: { type: "boolean", description: "Explicit opt-in to the closed frontier route (OpenRouter tool-capable model + Claude-bridge no-tool child, connector fallback forbidden). Absent or false: provider_id \"openrouter\" is an ordinary native provider." },
        openrouter_fallback: {
          type: "object", additionalProperties: false,
          description: "Before-output OpenRouter failover through the local Claude Code bridge. Defaults to enabled with Haiku. Closed routes and strict cost ceilings do not permit this failover.",
          properties: { enabled: { type: "boolean" }, model: { type: "string", minLength: 1 } },
          required: ["enabled", "model"],
        },
        credential_source: { type: "string", enum: ["api_key", "claude_oauth", "codex_oauth", "openrouter_oauth", "openai_wif"], description: "Which credential to use for native model inference. openai_wif accepts a pre-exchanged short-lived OpenAI API workload-identity bearer token and its Unix-seconds expiry from OPENAI_WIF_ACCESS_TOKEN and OPENAI_WIF_EXPIRES_AT; Canopy does not exchange or refresh it. claude_oauth/codex_oauth inspect CLI subscriber credentials but cannot be sent to the unrelated public provider APIs." },
        auth_route: { type: "string", enum: ["provider_api", "claude_code_cli", "openai_codex_cli"], description: "Provider auth route. provider_api (default) uses the provider adapter and Canopy credential lease; claude_code_cli uses stateless `claude -p` with tools, settings, and MCP disabled, leaving Anthropic sign-in in the CLI; openai_codex_cli uses `codex exec` with its tools, settings, and MCP disabled, leaving OpenAI account sign-in in the CLI. CLI routes are inference transports only; Canopy retains all tools and harness authority. claude_code_cli requires Anthropic/anthropic-messages; openai_codex_cli requires OpenAI/openai-compatible." },
        pricing: {
          type: "object",
          description: "Static exact-model price observation; never fetched live by the runtime.",
          properties: {
            price_source_id: { type: "string" }, observed_at: { type: "string" }, provider_id: { type: "string" }, model_id: { type: "string" }, currency: { type: "string" },
            minor_unit_exponent: { type: "integer", minimum: 0 }, input_minor_units_per_million_tokens: { type: "integer", minimum: 0 }, output_minor_units_per_million_tokens: { type: "integer", minimum: 0 }, cache_read_minor_units_per_million_tokens: { type: "integer", minimum: 0 }, cache_write_minor_units_per_million_tokens: { type: "integer", minimum: 0 },
          },
          required: ["price_source_id", "observed_at", "provider_id", "model_id", "currency", "minor_unit_exponent", "input_minor_units_per_million_tokens", "output_minor_units_per_million_tokens", "cache_read_minor_units_per_million_tokens", "cache_write_minor_units_per_million_tokens"],
        },
        max_turns: { type: "integer", minimum: 1, maximum: 512, description: "Authoritative per-session model-turn ceiling for the native executor." },
        max_session_wall_clock_ms: { type: "integer", minimum: 1, maximum: 7200000, description: "Wall-clock ceiling for one native executor session. Defaults to 600000. Raise it for transports where each model turn is a separate process spawn (e.g. a subscription-auth CLI bridge), where turn latency rather than turn count is what bounds the work. Not a substitute for max_turns: both ceilings apply." },
        credential_lease_ttl_ms: { type: "integer", minimum: 1000, maximum: 3600000, description: "Lifetime of a scoped native credential lease. Defaults to 600000, hard-capped at 3600000. Set it at or above native.max_session_wall_clock_ms: a session that outlives its own credential grant fails mid-campaign with 'credential lease unavailable: expired'." },
        usage_budget: {
          type: "object",
          description: "Strict prospective native-session limits, using an explicitly declared conservative estimator.",
          properties: {
            estimate_authority: { type: "string" }, estimate_max_input_tokens: { type: "integer", minimum: 1 }, estimate_max_output_tokens: { type: "integer", minimum: 1, description: "Per-request completion limit, also sent to the provider as max_tokens. Defaults to 8000 so the token budget, not native.transport.max_response_bytes, ends a long reasoning turn." },
            max_session_input_tokens: { type: "integer", minimum: 1 }, max_session_output_tokens: { type: "integer", minimum: 1 }, max_session_cache_read_tokens: { type: "integer", minimum: 1 }, max_session_cache_write_tokens: { type: "integer", minimum: 1 }, max_session_total_tokens: { type: "integer", minimum: 1 },
            max_session_cost: { type: "object", properties: { currency: { type: "string" }, minor_units: { type: "integer", minimum: 0 }, minor_unit_exponent: { type: "integer", minimum: 0 } }, required: ["currency", "minor_units", "minor_unit_exponent"] },
            max_campaign_tokens: { type: "integer", minimum: 1 },
            max_campaign_cost: { type: "object", properties: { currency: { type: "string" }, minor_units: { type: "integer", minimum: 0 }, minor_unit_exponent: { type: "integer", minimum: 0 } }, required: ["currency", "minor_units", "minor_unit_exponent"] },
          },
          required: ["estimate_authority", "estimate_max_input_tokens"],
        },
        usage_accounting_enabled: { type: "boolean", description: "Default-on usage/cost metering, independent of usage_budget's enforcement ceilings; false is the explicit full opt-out." },
        context_compaction: {
          type: "object",
          additionalProperties: false,
          description: "Automatic mid-session context compaction (structural fold, or a model summary when composition provides a summarizer). Enabled by default at a conservative threshold.",
          properties: {
            enabled: { type: "boolean", description: "false turns automatic compaction off entirely; every other value keeps it on." },
            threshold_fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Fraction of the usable context budget that triggers compaction mid-session. Defaults to DEFAULT_COMPACTION_THRESHOLD_FRACTION (0.75)." },
          },
        },
        transport: {
          type: "object",
          additionalProperties: false,
          description: "Bounded non-secret limits for each native model transport attempt.",
          properties: {
            timeout_ms: { type: "integer", minimum: 1, maximum: 300000 },
            max_response_bytes: { type: "integer", minimum: 1, maximum: 8388608 },
          },
        },
        capabilities: {
          type: "object",
          additionalProperties: false,
          properties: {
            image_input: { type: "boolean", description: "Explicitly enables governed image input for the configured adapter; never inferred from a model name." },
            web_fetch: { type: "boolean", description: "Explicitly enables the governed web.fetch tool (HTTPS GET of a model-supplied URL). Default off: this repository has no OS-level network confinement (LR-NH-07)." },
            web_search: { type: "boolean", description: "Explicitly enables the governed web.search tool. Requires native.web_search.provider to be configured or every call is refused as provider_unconfigured. Default off: this repository has no OS-level network confinement (LR-NH-07)." },
          },
        },
        web_search: {
          type: "object",
          additionalProperties: false,
          description: "Pluggable web.search provider selection. The built-in searxng client requires a governed ARBOR_WEB_SEARCH_ENDPOINT.",
          properties: {
            provider: { type: "string", minLength: 1, maxLength: 64, description: "A provider id this deployment's composition root recognizes. Use searxng with ARBOR_WEB_SEARCH_ENDPOINT; unsupported or incompletely configured providers yield provider_unconfigured." },
          },
        },
        mcp_servers: {
          type: "array", maxItems: 8,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              server_id: { type: "string", pattern: "^[a-z0-9-]{1,32}$" },
              transport: { type: "string", enum: ["stdio", "http"] },
              command: { type: "string", minLength: 1, maxLength: 1024 },
              args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } },
              env: { type: "object", maxProperties: 32, additionalProperties: { type: "string", maxLength: 8192 } },
              url: { type: "string", format: "uri", maxLength: 2048 },
              credential_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" },
              read_only_tools: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } },
              mutating_tools: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } },
              resources: { type: "boolean", description: "Explicitly enables MCP resource and resource-template discovery for this server. Default off." },
              prompts: { type: "boolean", description: "Explicitly enables MCP prompt discovery for this server. Default off." },
            },
            required: ["server_id", "transport"],
            oneOf: [
              { properties: { transport: { const: "stdio" } }, required: ["command"], not: { required: ["url"] } },
              { properties: { transport: { const: "http" } }, required: ["url"], not: { anyOf: [{ required: ["command"] }, { required: ["args"] }, { required: ["env"] }] } },
            ],
          },
        },
      },
      required: ["mode", "adapter_id", "provider_id", "base_url", "model"],
    },
    verification: {
      type: "object",
      description: "Project-authored machine verification. acceptance_commands run in order, fail-fast, as the acceptance step for any node whose plan declared no command of its own; authored provenance on every governance tier.",
      properties: {
        acceptance_commands: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 1 } },
        network_egress: {
          type: "array",
          description: "Explicit network opt-in for exact verifier argv. Verifier commands run with no host network by default; an argv listed here (matched exactly, never by pattern) runs with host network, and the reason is recorded in the verification evidence.",
          items: {
            type: "object",
            properties: {
              argv: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
              reason: { type: "string", minLength: 1, maxLength: 200 },
            },
            required: ["argv", "reason"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    connectors: {
      type: "object",
      description: "Harness-connector policy. Canopy (revoy-native) is the only campaign harness before 1.0.0; the opencode, claude-code and codex connectors and native.mode=fallback are deprecated and refused unless allow_deprecated is true with a reason, which is recorded in run evidence.",
      properties: {
        allow_deprecated: { type: "boolean", description: "Post-1.0 opt-in for a deprecated (non-Canopy) harness lane. Default off: selecting one fails closed." },
        reason: { type: "string", minLength: 1, maxLength: 200, description: "Required when allow_deprecated is true. Single line; recorded in the evidence of every run that uses a deprecated lane." },
      },
      additionalProperties: false,
    },
    tui: {
      type: "object",
      description: "Optional, non-secret TUI presentation preferences.",
      properties: {
        color: { type: "string", enum: ["auto", "always", "never"], description: "Interactive color preference. always overrides inherited NO_COLOR; redirected output remains plain." },
        theme: {
          type: "string",
          enum: ["night-bloom", "moss-agate", "verdigris-forge", "sandstone-thicket", "birchwood-frost", "obsidian-fern", "copper-canopy", "slate-orchard"],
          description: "Named palette override; omitted uses the terminal light/dark/color-capability fallback.",
        },
      },
    },
    sandbox: {
      type: "object",
      description: "Command-execution confinement policy for the shell/verification sandbox broker (LR-NH-04).",
      properties: {
        confinement: {
          type: "string",
          enum: ["off", "app_only", "os_best_effort", "os_required"],
          description: "off/app_only disable OS confinement (application-level path/workspace validation still applies); os_best_effort (recommended default) uses OS confinement (bubblewrap namespaces) when the runtime probe succeeds and otherwise honestly falls back to application-level validation; os_required fails closed and refuses to run when OS confinement cannot be proven available.",
        },
      },
    },
  },
} as const;
