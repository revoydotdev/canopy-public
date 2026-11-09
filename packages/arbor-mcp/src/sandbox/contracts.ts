export type ConfinementGrade = import("@arbor/harness").ConfinementGrade;

export interface SandboxedCommandRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly workspace_root: string;
  readonly workspace_writable: boolean;
  /**
   * Optional additional root mounted through a host-immutable, tmp-backed
   * overlay (before the workspace, so the writable workspace still wins
   * where they overlap). Exists for
   * linked git worktrees whose dependencies (node_modules) and repository
   * metadata live in the enclosing checkout: without it a declared
   * acceptance command cannot even resolve its modules inside the sandbox.
   */
  readonly readonly_context_root?: string;
  /**
   * Explicit dependency root mounted from a host-immutable, tmp-backed
   * overlay so authorized context symlinks can resolve and tools may write
   * disposable caches without mutating the host dependency tree.
   */
  readonly readonly_dependency_root?: string;
  /** Additional exact dependency roots for workspace-package symlink farms. */
  readonly readonly_dependency_roots?: readonly string[];
  readonly network_denied: boolean;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly signal: AbortSignal;
  /** Optional bounded bytes delivered through a pipe, never argv or environment. */
  readonly stdin?: Buffer;
}

export type SandboxedCommandResult =
  | { readonly kind: "exited"; readonly exit: number; readonly stdout: Buffer; readonly stderr: Buffer; readonly confinement: ConfinementGrade }
  | { readonly kind: "cancelled"; readonly stdout: Buffer; readonly stderr: Buffer; readonly confinement: ConfinementGrade }
  | { readonly kind: "timed_out"; readonly stdout: Buffer; readonly stderr: Buffer; readonly confinement: ConfinementGrade }
  | { readonly kind: "output_limited"; readonly stdout: Buffer; readonly stderr: Buffer; readonly confinement: ConfinementGrade }
  | { readonly kind: "network_isolation_unavailable"; readonly confinement: "application_validated" }
  | { readonly kind: "spawn_failed"; readonly confinement: ConfinementGrade };

export interface SandboxBroker {
  readonly confinement: "application_validated" | "os_confined";
  readonly diagnostic: string;
  run(request: SandboxedCommandRequest): Promise<SandboxedCommandResult>;
}
