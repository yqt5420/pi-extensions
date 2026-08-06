import {
	DefaultResourceLoader,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ConsultResourcePolicy } from "./agents.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { assertPiPromptSourcesAreReadableFiles } from "./prompt-source-safety.js";
import type { ChildLaunchPolicy } from "./runner.js";

const MINIMAL_CONSULT_SYSTEM_PROMPT =
	"You are a read-only consultation assistant. Analyze the delegated task using only executor-provided capabilities and return a grounded answer.";

/**
 * Resolve Pi-owned prompt files without loading target settings, packages, or extensions.
 * The child still owns context-file, skill, and prompt-template loading according to this policy.
 */
export async function resolveConsultResourceLaunchPolicy(
	policy: ConsultResourcePolicy,
	projectTrusted: boolean,
	cwd: string,
): Promise<ChildLaunchPolicy> {
	if (policy === "none") {
		return {
			disableExtensions: true,
			disableSkills: true,
			disablePromptTemplates: true,
			disableContextFiles: true,
			projectTrust: false,
			baseSystemPrompt: MINIMAL_CONSULT_SYSTEM_PROMPT,
		};
	}

	const agentDir = getAgentDir();
	assertPiPromptSourcesAreReadableFiles(cwd, agentDir, projectTrusted, [
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
	]);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory({}, { projectTrusted }),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const discoveredSystemPrompt = loader.getSystemPrompt();
	const baseSystemPrompt = discoveredSystemPrompt
		? truncateUtf8(discoveredSystemPrompt, DEFAULT_MAX_CONTEXT_BYTES).text
		: undefined;
	const appendSystemPromptPaths = loader
		.getAppendSystemPromptSources()
		.map((source) => source.path);
	const shared = {
		disableExtensions: true,
		disableContextFiles: !projectTrusted,
		projectTrust: projectTrusted,
		baseSystemPrompt,
		appendSystemPromptPaths:
			appendSystemPromptPaths.length > 0 ? appendSystemPromptPaths : undefined,
	};
	if (policy === "project-context") {
		return {
			...shared,
			disableSkills: true,
			disablePromptTemplates: true,
		};
	}
	return shared;
}
