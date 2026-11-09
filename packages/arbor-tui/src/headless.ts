import { initialModel } from "./model.js";
import { update } from "./update.js";
import { screenForQueryKind } from "./screens/screen.js";
import type { AppError, AppEvent, AppLimits, AppModel, Effect } from "./types.js";
import type { TelemetrySourcePort } from "./telemetry-types.js";
import type { RuntimeCommandRequest, RuntimePort } from "./runtime-port.js";

export interface HeadlessClient {
  connect(target: string): void | Promise<void>;
  disconnect(): void | Promise<void>;
  requestSnapshot(afterCursor: string | null): void | Promise<void>;
  close(): void | Promise<void>;
  interruptCampaign(): void | Promise<void>;
}

export interface HeadlessTerminal {
  restore(): void | Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface HeadlessDependencies {
  readonly client: HeadlessClient;
  readonly terminal: HeadlessTerminal;
  readonly clock: Clock;
  readonly telemetrySource: TelemetrySourcePort;
  /** Canonical runtime command/query bus. Every harness composition supplies it explicitly. */
  readonly runtime: RuntimePort;
  /** MCP-owned filesystem bridge for the path-only task composer effect. */
  readonly submitTaskComposerAttachments?: (request: RuntimeCommandRequest, attachmentPaths: readonly string[]) => void | Promise<void>;
  /** Composition-owned $VISUAL/$EDITOR bridge; null means the operator cancelled. */
  readonly openExternalEditor?: (request: { readonly request_id: string; readonly title: string; readonly text: string; readonly language: "markdown"; readonly max_chars: number }) => string | null | Promise<string | null>;
}

export class HeadlessHarness {
  private current: AppModel;
  private readonly effectLog: Effect[] = [];

  constructor(private readonly dependencies: HeadlessDependencies, limits?: AppLimits) {
    this.current = initialModel(limits);
  }

  get model(): AppModel { return this.current; }
  get effects(): readonly Effect[] { return [...this.effectLog]; }
  now(): number { return this.dependencies.clock.now(); }

  async dispatch(event: AppEvent): Promise<void> {
    const next = update(this.current, event);
    this.current = next.model;
    for (const effect of next.effects) {
      this.effectLog.push(effect);
      await this.interpret(effect);
    }
  }

  private async interpret(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "connect": await this.dependencies.client.connect(effect.target); return;
      case "disconnect": await this.dependencies.client.disconnect(); return;
      case "request_snapshot": await this.dependencies.client.requestSnapshot(effect.afterCursor); return;
      case "close_client": await this.dependencies.client.close(); return;
      case "restore_terminal": await this.dependencies.terminal.restore(); return;
      case "interrupt_campaign": await this.dependencies.client.interruptCampaign(); return;
      case "schedule_repeat_confirmation_clear": {
        const timer = setTimeout(() => { void this.dispatch({ type: "repeat_confirmation_elapsed", token: effect.token }); }, Math.max(0, effect.at - this.dependencies.clock.now()));
        timer.unref?.();
        return;
      }
      case "fetch_telemetry": {
        try {
          const snapshot = await this.dependencies.telemetrySource.fetch(effect.campaignId);
          await this.dispatch({ type: "telemetry_received", snapshot });
        } catch (error) {
          await this.dispatch({
            type: "error_raised",
            error: {
              code: "unavailable",
              message: error instanceof Error ? error.message : String(error),
              source: "telemetry",
              recoverable: true,
              fingerprint: "telemetry:fetch-failed",
            },
            at: this.dependencies.clock.now(),
          });
        }
        return;
      }
      case "dispatch_command": {
        const runtime = this.dependencies.runtime;
        try {
          const response = await runtime.command(effect.request);
          if (!response.ok) await this.dispatch({
            type: "error_raised",
            error: commandFailure(effect.request.kind, response.error),
            at: this.dependencies.clock.now(),
          });
        } catch (error) {
          await this.dispatch({
            type: "error_raised",
            error: {
              code: "transport",
              message: `Harness fault while running ${effect.request.kind}: ${error instanceof Error ? error.message : String(error)}`,
              source: "harness-fault",
              recoverable: true,
              fingerprint: `command:${effect.request.kind}:harness-fault:transport`,
            },
            at: this.dependencies.clock.now(),
          });
        }
        return;
      }
      case "submit_taskcomposer_attachments": {
        const submit = this.dependencies.submitTaskComposerAttachments;
        if (!submit) return;
        try {
          await submit(effect.request, effect.attachment_paths);
        } catch (error) {
          await this.dispatch({
            type: "error_raised",
            error: {
              code: "validation",
              message: error instanceof Error ? error.message : String(error),
              source: "taskcomposer-attachment-paths",
              recoverable: true,
              fingerprint: "taskcomposer:image-paths",
            },
            at: this.dependencies.clock.now(),
          });
        }
        return;
      }
      case "open_external_editor": {
        const open = this.dependencies.openExternalEditor;
        if (!open) return;
        try {
          const text = await open(effect);
          await this.dispatch({ type: "external_editor_result", request_id: effect.request_id, text, at: this.dependencies.clock.now() });
        } catch (error) {
          await this.dispatch({
            type: "error_raised",
            error: {
              code: "transport",
              message: error instanceof Error ? error.message : String(error),
              source: "external-editor",
              recoverable: true,
              fingerprint: "external-editor:failed",
            },
            at: this.dependencies.clock.now(),
          });
        }
        return;
      }
      case "run_query": {
        const runtime = this.dependencies.runtime;
        try {
          const result = await runtime.query(effect.request);
          if (result.ok) {
            // Background refreshes may be owned by a stable projection rather
            // than the currently focused screen. An explicit target is an
            // internal, typed routing decision; ordinary interactive queries
            // retain the existing registered-screen/focus resolution.
            const screen = effect.screen ?? screenForQueryKind(effect.request.kind, this.current.screen) ?? this.current.screen;
            await this.dispatch({ type: "query_results", queryId: effect.request.query_id, screen, value: result.value });
          } else {
            await this.dispatch({
              type: "error_raised",
              error: {
                code: result.error.code,
                message: result.error.summary,
                source: "runtime-query",
                recoverable: true,
                fingerprint: `query:${effect.request.kind}:${result.error.code}`,
              },
              at: this.dependencies.clock.now(),
            });
          }
        } catch (error) {
          await this.dispatch({
            type: "error_raised",
            error: {
              code: "transport",
              message: error instanceof Error ? error.message : String(error),
              source: "runtime-query",
              recoverable: true,
              fingerprint: `query:${effect.request.kind}:transport`,
            },
            at: this.dependencies.clock.now(),
          });
        }
        return;
      }
      case "set_screen":
        await this.dispatch({ type: "screen_changed", screen: effect.screen });
        return;
    }
  }
}

function commandFailure(kind: string, error: { readonly code: AppError["code"]; readonly summary: string }): AppError {
  if (error.code === "permission") return {
    code: error.code,
    message: `Capability denied for ${kind}: ${error.summary}`,
    source: "capability-gate",
    recoverable: true,
    fingerprint: `command:${kind}:capability-gate:${error.code}`,
  };
  if (error.code === "validation" || error.code === "conflict" || error.code === "cancellation") return {
    code: error.code,
    message: `Operator action not applied for ${kind}: ${error.summary}`,
    source: "operator-decision",
    recoverable: true,
    fingerprint: `command:${kind}:operator-decision:${error.code}`,
  };
  return {
    code: error.code,
    message: `Harness fault while running ${kind}: ${error.summary}`,
    source: "harness-fault",
    recoverable: true,
    fingerprint: `command:${kind}:harness-fault:${error.code}`,
  };
}
