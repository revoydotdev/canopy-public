/**
 * Screen composition root for operational TUI screens (roadmap 4C).
 *
 * Registers every leaf screen module that has a real canonical backend
 * capability. Registration is central (here) so leaf modules stay isolated
 * and tests can call `clearRegisteredScreens()`. Screens whose capabilities
 * are absent remain unregistered — the composition layer only offers them
 * when the transport grants the required capabilities (see availableScreens).
 *
 * Depends only on @arbor/core and the sibling screen modules — never @arbor/mcp.
 */

import { registerScreen } from "./screen.js";
import { campaignsScreen } from "./campaigns.js";
import { treeScreen } from "./tree.js";
import { tasksScreen } from "./tasks.js";
import { operationsScreen } from "./operations.js";
import { recoveryScreen } from "./recovery.js";
import { outputScreen } from "./output.js";
import { resultReviewScreen } from "./result-review.js";
import { communicationsScreen } from "./communications.js";
import { diagnosticsScreen } from "./diagnostics.js";
import { configScreen } from "./config.js";
import { nativeBudgetScreen } from "./native-budget.js";
import { agentsScreen } from "./agents.js";
import { jobsScreen } from "./jobs.js";
import { approvalsScreen } from "./approvals.js";
import { interviewsScreen } from "./interviews.js";
import { devtoolsScreen } from "./devtools.js";
import { commandHistoryScreen } from "./command-history.js";
import { governanceScreen } from "./governance.js";
import { backlogScreen } from "./backlog.js";
import { kbScreen } from "./kb.js";
import { auditScreen } from "./audit.js";
import { compactionScreen } from "./compaction.js";
import { siblingsScreen } from "./siblings.js";
import { surveillanceScreen } from "./surveillance.js";
import { capabilitiesScreen } from "./capabilities.js";
import { threadsScreen } from "./threads.js";
import { busScreen } from "./bus.js";
import { a2aScreen } from "./a2a.js";
import { overlaysScreen } from "./overlays.js";
import { telemetryScreen } from "./telemetry.js";
import { trustScreen } from "./trust.js";
import { harnessConnectorsScreen } from "./harness-connectors.js";
import { harnessReadinessScreen } from "./harness-readiness.js";
import { harnessSessionsScreen } from "./harness-sessions.js";
import { harnessEvaluationsScreen } from "./harness-evaluations.js";
import { taskComposerScreen } from "./task-composer.js";
import { liveSessionScreen } from "./live-session.js";
import { projectRegistryScreen } from "./project-registry.js";
import { controlScreen } from "./control.js";
import { consoleScreen } from "./console.js";

/** Register every wired operational screen. Idempotent per screen. */
export function installScreens(): void {
  registerScreen(projectRegistryScreen);
  registerScreen(campaignsScreen);
  registerScreen(treeScreen);
  registerScreen(diagnosticsScreen);
  registerScreen(tasksScreen);
  registerScreen(operationsScreen);
  registerScreen(recoveryScreen);
  registerScreen(outputScreen);
  registerScreen(resultReviewScreen);
  registerScreen(communicationsScreen);
  registerScreen(configScreen);
  registerScreen(nativeBudgetScreen);
  registerScreen(agentsScreen);
  registerScreen(jobsScreen);
  registerScreen(approvalsScreen);
  registerScreen(interviewsScreen);
  registerScreen(devtoolsScreen);
  registerScreen(commandHistoryScreen);
  registerScreen(governanceScreen);
  registerScreen(backlogScreen);
  registerScreen(kbScreen);
  registerScreen(auditScreen);
  registerScreen(compactionScreen);
  registerScreen(siblingsScreen);
  registerScreen(surveillanceScreen);
  registerScreen(capabilitiesScreen);
  registerScreen(threadsScreen);
  registerScreen(busScreen);
  registerScreen(a2aScreen);
  registerScreen(overlaysScreen);
  registerScreen(telemetryScreen);
  registerScreen(trustScreen);
  registerScreen(harnessConnectorsScreen);
  registerScreen(harnessReadinessScreen);
  registerScreen(harnessSessionsScreen);
  registerScreen(harnessEvaluationsScreen);
  registerScreen(taskComposerScreen);
  registerScreen(liveSessionScreen);
  registerScreen(controlScreen);
  registerScreen(consoleScreen);
}
