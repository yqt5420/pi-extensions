import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentScope, discoverAgents, type SubagentSettings } from "./agents.js";
import type { AgentRegistry, ManagedAgent } from "./registry.js";
import { safeTerminalLine } from "./safe-text.js";
import { readSubagentSettings } from "./settings.js";

export function assertNoSharedWriteConflict(
	registry: AgentRegistry,
	agentName: string,
	cwd: string,
	scope: AgentScope,
	settings?: SubagentSettings,
): void {
	const agents = discoverAgents(cwd, scope, settings ?? readSubagentSettings()).agents;
	const requested = agents.find((agent) => agent.name === agentName);
	if (!isWriteCapable(requested?.tools)) return;
	for (const active of registry.list()) {
		if (
			!isSameCwd(active.cwd, cwd) ||
			(active.state !== "running" && active.state !== "starting")
		) {
			continue;
		}
		const activeConfig = agents.find((agent) => agent.name === active.agent);
		if (isWriteCapable(activeConfig?.tools)) {
			throw new Error(
				`Write-capable subagent ${active.id} is already active in shared workspace ${cwd}. ` +
					"Prefer one subagent_spawn covering combined asynchronous work. Use the blocking subagent parallel mode only when concurrent synchronous outputs justify making the main agent unavailable. Otherwise let the active agent finish or close it; set allowConcurrentWrites only when overlapping writes are knowingly safe, or use workspaceMode worktree when repository isolation is needed.",
			);
		}
	}
}

export function assertFollowUpWriteAllowed(
	registry: AgentRegistry,
	agent: ManagedAgent,
	allowConcurrentWrites: boolean,
	isolatedWorkspace: boolean,
	settings?: SubagentSettings,
): void {
	if (allowConcurrentWrites || isolatedWorkspace) return;
	assertNoSharedWriteConflict(
		registry,
		agent.agent,
		agent.cwd,
		agent.agentScope ?? "user",
		settings,
	);
}

export function isWriteCapable(tools: string[] | undefined): boolean {
	if (!tools) return true;
	return tools.some((tool) => ["bash", "write", "edit"].includes(tool));
}

export async function confirmProjectAgent(
	name: string,
	scope: AgentScope,
	confirm: boolean,
	ctx: ExtensionContext,
	cwd: string,
	settings?: SubagentSettings,
): Promise<void> {
	if (scope !== "project" && scope !== "both") return;
	if (!isSameCwd(cwd, ctx.cwd)) {
		throw new Error("Project-local subagent definitions cannot run with an overridden cwd");
	}
	if (!ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	const discovery = discoverAgents(cwd, scope, settings ?? readSubagentSettings());
	const agent = discovery.agents.find((candidate) => candidate.name === name);
	if (agent?.source !== "project") return;
	if (confirm && ctx.hasUI) {
		const approved = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${safeTerminalLine(name, 256)}\nSource: ${safeTerminalLine(agent.filePath)}`,
		);
		if (!approved) throw new Error("Project-local subagent was not approved");
	}
}

function isSameCwd(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return path.resolve(left) === path.resolve(right);
	}
}
