import type { AgentRegistry } from "./registry.js";
import type { WorkspaceManager } from "./workspace.js";

export async function disposeStatefulRuntime(
	registry: AgentRegistry | undefined,
	workspaceManager: WorkspaceManager,
): Promise<unknown[]> {
	const errors: unknown[] = [];
	try {
		await registry?.shutdown();
	} catch (error) {
		errors.push(error);
	}
	try {
		await workspaceManager.cleanupAll();
	} catch (error) {
		errors.push(error);
	}
	return errors;
}

export function assertCurrentSpawn(
	signal: AbortSignal | undefined,
	generation: number,
	currentGeneration: number,
): void {
	if (!signal?.aborted && generation === currentGeneration) return;
	const error = new Error("Subagent spawn owner was replaced or aborted");
	error.name = "AbortError";
	throw error;
}
