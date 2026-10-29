/**
 * Shared plan-file location — used by guards.ts (planning mode) and backlog.ts
 * (the "plan" action). Kept dependency-free on purpose: importing it must never
 * drag in the rest of the extension graph (see tools/test-backlog-scroll.ts).
 */
import path from "node:path";

/** The plan file lives inside the project — visible to the user, easy to find. (#12) */
export function defaultPlanFile(cwd: string): string {
	return path.join(cwd, ".pi", "PLAN.md");
}
