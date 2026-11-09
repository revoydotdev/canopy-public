/**
 * arbor-eval/live-report — renders a `LiveAblationReport` to markdown.
 *
 * ADR-095 Decision 4: "The report format carries both arms' raw results
 * side by side so a losing tree-search arm is exactly as visible as a
 * winning one." This module always prints every raw per-seed attempt for
 * BOTH arms — there is no aggregate-only mode.
 */
import type { LiveAblationReport } from "./live-ablation.js";

export function generateLiveAblationReport(report: LiveAblationReport): string {
  const lines: string[] = [];
  lines.push("# Arbor Eval — Live Model Ablation Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Model: ${report.model.provider_id}/${report.model.model_id}`);
  lines.push(`Runs per arm per task: ${report.runs_per_arm_per_task} | Verification-call budget: ${report.max_calls_per_run}`);
  lines.push("");
  lines.push("> **What this measures.** Every result below comes from a real call through");
  lines.push("> the harness's model-port abstraction and a real verification command —");
  lines.push("> `verified` provenance is produced only when that command actually ran and");
  lines.push("> exited 0 (`live-verification.ts`). The comparison metric is success rate at");
  lines.push("> a FIXED verification-call budget, never wall-clock.");
  lines.push("");

  const rateTable = (rates: { governed_tree: number; governed_linear: number; ungoverned_linear: number }): void => {
    lines.push("| Arm | Success rate |");
    lines.push("|-----|--------------|");
    lines.push(`| ungoverned_linear | ${rates.ungoverned_linear} |`);
    lines.push(`| governed_linear | ${rates.governed_linear} |`);
    lines.push(`| governed_tree | ${rates.governed_tree} |`);
    lines.push("");
    lines.push(`Governance effect (governed_linear minus ungoverned_linear): **${round(rates.governed_linear - rates.ungoverned_linear)}**`);
    lines.push(`Search effect (governed_tree minus governed_linear): **${round(rates.governed_tree - rates.governed_linear)}**`);
    lines.push("");
  };

  lines.push("## Calibration set");
  lines.push("");
  rateTable(report.calibration);

  lines.push("## Held-out set (never used to tune scoring constants)");
  lines.push("");
  rateTable(report.held_out);

  lines.push("## Falsifiability findings");
  lines.push("");
  for (const finding of report.falsifiability) {
    lines.push(`### ${finding.claim}: ${finding.treatment_arm} vs ${finding.baseline_arm}`);
    lines.push("");
    lines.push(finding.triggered ? "**TRIGGERED**" : "Not triggered.");
    lines.push("");
    lines.push(finding.detail);
    lines.push("");
    if (finding.recommended_obligation) {
      lines.push("> Recommended obligation to file (operator action required —");
      lines.push("> arbor-eval does not edit decisions/ itself):");
      lines.push(">");
      lines.push(`> ${finding.recommended_obligation}`);
      lines.push("");
    }
  }

  lines.push("## Raw per-seed results — every arm, every task");
  lines.push("");
  lines.push("| Task | Held out | Arm | n | Successes | Success rate | 95% CI | n-of-m verdict |");
  lines.push("|------|----------|-----|---|-----------|--------------|--------|----------------|");
  for (const result of report.task_results) {
    lines.push(
      `| ${result.task_id} | ${result.held_out} | ${result.arm} | ${result.n} | ${result.successes} | ` +
      `${result.success_rate} | [${result.confidence_interval_95[0]}, ${result.confidence_interval_95[1]}] | ${result.verdict_pass ? "pass" : "fail"} |`,
    );
  }
  lines.push("");

  lines.push("### Per-seed attempt detail");
  lines.push("");
  for (const result of report.task_results) {
    lines.push(`#### ${result.task_id} — ${result.arm}${result.held_out ? " (held-out)" : ""}`);
    lines.push("");
    lines.push("| Seed | Success | Calls used | Attempts (exit codes) | Provider usage |");
    lines.push("|------|---------|------------|------------------------|----------------|");
    for (const run of result.runs) {
      const exits = run.attempts.map((a) => `#${a.attempt}:${a.verification.exit_code ?? "n/a"}`).join(", ");
      lines.push(`| ${run.seed} | ${run.success} | ${run.calls_used} | ${exits} | ${formatUsage(run.attempts)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatUsage(attempts: readonly import("./live-ablation.js").LiveAttemptResult[]): string {
  if (attempts.length === 0) return "unavailable";
  let input = 0;
  let output = 0;
  for (const attempt of attempts) {
    const usage = attempt.usage_and_cost;
    if (usage === null || usage.tokens.kind !== "measured") return "unavailable";
    input += usage.tokens.input_tokens + usage.tokens.cache_read_tokens + usage.tokens.cache_write_tokens;
    output += usage.tokens.output_tokens;
  }
  return `in ${input}, out ${output}`;
}

function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
