/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is SubagentThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as SubagentThinkingLevel);
}

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface SubagentAgentConfig {
	tools?: string[];
	model?: string | null;
	thinkingLevel?: SubagentThinkingLevel | null;
	timeoutMs?: number | null;
}

export type SubagentTransportKind = "subprocess" | "in-process";

export type CompletionDelivery = "next-turn" | "auto-resume";

export const CONSULT_RESOURCE_POLICIES = ["project-context", "none", "all"] as const;

export type ConsultResourcePolicy = (typeof CONSULT_RESOURCE_POLICIES)[number];

export interface SubagentConsultSettings {
	resources?: ConsultResourcePolicy;
}

export const CONSULTATION_CWD_POLICIES = ["anywhere", "current-workspace"] as const;
export type ConsultationCwdPolicy = (typeof CONSULTATION_CWD_POLICIES)[number];

export const DELEGATION_CWD_POLICIES = [
	"trusted-targets",
	"current-workspace",
	"anywhere",
] as const;
export type DelegationCwdPolicy = (typeof DELEGATION_CWD_POLICIES)[number];

export interface SubagentCwdPolicySettings {
	consultation?: ConsultationCwdPolicy;
	delegation?: DelegationCwdPolicy;
}

export interface SubagentBlockingSettings {
	enabled?: boolean;
}

export interface SubagentRuntimeSettings {
	enabled?: boolean;
	transport?: SubagentTransportKind;
	completionDelivery?: CompletionDelivery;
	maxAgents?: number;
	maxActiveTurns?: number;
	maxDepth?: number;
	maxChildrenPerAgent?: number;
	maxMailboxMessages?: number;
	maxMailboxMessageBytes?: number;
	idleTtlMs?: number;
	retentionDays?: number;
	maxStoredAgents?: number;
}

export interface SubagentSettings {
	agents?: Record<string, SubagentAgentConfig>;
	blocking?: SubagentBlockingSettings;
	stateful?: SubagentRuntimeSettings;
	consult?: SubagentConsultSettings;
	cwdPolicy?: SubagentCwdPolicySettings;
}

const BUILT_IN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description:
			"Read-only codebase reconnaissance; returns concise findings with paths and evidence.",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "built-in",
		filePath: "built-in:scout",
		systemPrompt: [
			"You are a scout subagent. Explore the codebase quickly and report grounded findings.",
			"Do not edit files. Prefer read, grep, find, ls, and safe bash inspection commands.",
			"Return concise bullets with exact file paths, symbols, and open questions.",
		].join("\n"),
	},
	{
		name: "planner",
		description: "Turns reconnaissance into a lean implementation or migration plan.",
		tools: ["read", "grep", "find", "ls"],
		source: "built-in",
		filePath: "built-in:planner",
		systemPrompt: [
			"You are a planner subagent. Produce executable, verifiable plans only.",
			"Do not modify files. Ground the plan in the repository's actual structure.",
			"Call out assumptions, risks, sequencing, and verification commands.",
		].join("\n"),
	},
	{
		name: "reviewer",
		description: "Independent code review agent that inspects existing verification evidence.",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "built-in",
		filePath: "built-in:reviewer",
		systemPrompt: [
			"You are a reviewer subagent. Review changes adversarially and assess claims against the code and existing evidence.",
			"Do not edit files or run tests, builds, benchmarks, formatters, or other long-running verification commands.",
			"Inspect code, diffs, test definitions, and existing verification evidence. Recommend any additional commands for the main agent to run.",
			"Report PASS, FAIL, or PARTIAL with evidence, commands inspected, and specific follow-ups.",
		].join("\n"),
	},
	{
		name: "worker",
		description: "General-purpose implementation worker with the default Pi tool set.",
		source: "built-in",
		filePath: "built-in:worker",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general",
		description: "Alias for worker; kept for model-generated subagent names.",
		source: "built-in",
		filePath: "built-in:general",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general-purpose",
		description: "Alias for worker; compatible with common subagent naming conventions.",
		source: "built-in",
		filePath: "built-in:general-purpose",
		systemPrompt: workerSystemPrompt(),
	},
];

function workerSystemPrompt(): string {
	return [
		"You are a focused worker subagent running in an isolated Pi process.",
		"Complete the delegated task directly. Keep scope tight and avoid unrelated changes.",
		"When done, summarize files changed, commands run, and any remaining risks.",
	].join("\n");
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	omittedAgentDefinitions?: number;
	metadataDiscoveryIncomplete?: boolean;
}

export interface AgentDiscoveryOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

interface LoadedAgents {
	agents: AgentConfig[];
	omittedAgentDefinitions: number;
	metadataDiscoveryIncomplete: boolean;
}

function readFileBoundedSync(
	filePath: string,
	maxBytes: number | undefined,
): { content?: string; bytes: number; limited: boolean } {
	if (maxBytes === undefined) {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			return { content, bytes: Buffer.byteLength(content), limited: false };
		} catch {
			return { bytes: 0, limited: false };
		}
	}

	const readLimit = Math.max(0, maxBytes);
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		if (!fs.fstatSync(fd).isFile()) return { bytes: 0, limited: false };
		const buffer = Buffer.allocUnsafe(readLimit + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > readLimit) return { bytes: offset, limited: true };
		return { content: buffer.subarray(0, offset).toString("utf-8"), bytes: offset, limited: false };
	} catch {
		return { bytes: 0, limited: false };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
	options: AgentDiscoveryOptions = {},
): LoadedAgents {
	const agents: AgentConfig[] = [];
	let omittedAgentDefinitions = 0;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			agents,
			omittedAgentDefinitions,
			metadataDiscoveryIncomplete: (error as NodeJS.ErrnoException).code !== "ENOENT",
		};
	}

	const agentEntries = entries
		.filter((entry) => entry.name.endsWith(".md"))
		.filter((entry) => entry.isFile() || entry.isSymbolicLink());
	let totalBytes = 0;

	for (const [index, entry] of agentEntries.entries()) {
		if (options.maxFiles !== undefined && index >= options.maxFiles) {
			omittedAgentDefinitions += agentEntries.length - index;
			break;
		}
		const filePath = path.join(dir, entry.name);
		const remainingBytes =
			options.maxTotalBytes === undefined ? undefined : options.maxTotalBytes - totalBytes;
		if (remainingBytes !== undefined && remainingBytes <= 0) {
			omittedAgentDefinitions++;
			continue;
		}
		const maxBytes =
			options.maxFileBytes === undefined
				? remainingBytes
				: remainingBytes === undefined
					? options.maxFileBytes
					: Math.min(options.maxFileBytes, remainingBytes);
		const loaded = readFileBoundedSync(filePath, maxBytes);
		totalBytes += Math.min(loaded.bytes, maxBytes ?? loaded.bytes);
		if (loaded.limited || loaded.content === undefined) {
			if (loaded.limited) omittedAgentDefinitions++;
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(loaded.content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const hasTools = hasOwn(frontmatter, "tools");
		const rawTools = frontmatter.tools;
		let tools: string[] | undefined;
		if (hasTools) {
			if (rawTools === null) {
				tools = [];
			} else if (Array.isArray(rawTools)) {
				if (!rawTools.every((tool): tool is string => typeof tool === "string")) continue;
				tools = rawTools.map((tool) => tool.trim()).filter(Boolean);
			} else if (typeof rawTools === "string") {
				tools = rawTools
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean);
			} else {
				continue;
			}
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			...(hasTools ? { tools: tools ?? [] } : {}),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinkingLevel: isThinkingLevel(frontmatter.thinkingLevel)
				? frontmatter.thinkingLevel
				: undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return { agents, omittedAgentDefinitions, metadataDiscoveryIncomplete: false };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	config?: SubagentSettings,
	options: AgentDiscoveryOptions = {},
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userLoaded =
		scope === "project"
			? { agents: [], omittedAgentDefinitions: 0, metadataDiscoveryIncomplete: false }
			: loadAgentsFromDir(userDir, "user", options);
	const projectLoaded =
		scope === "user" || !projectAgentsDir
			? { agents: [], omittedAgentDefinitions: 0, metadataDiscoveryIncomplete: false }
			: loadAgentsFromDir(projectAgentsDir, "project", options);
	const userAgents = userLoaded.agents;
	const projectAgents = projectLoaded.agents;

	const agentMap = new Map<string, AgentConfig>();

	// Lowest priority: built-ins are always available, then user agents, then
	// trusted project agents if requested. This mirrors the subagent boundary
	// pattern in ./src: stable built-ins plus overridable local definitions.
	for (const agent of BUILT_IN_AGENTS) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	// Apply user-configured overrides (from /subagents → Agent tool settings) on top of
	// the final resolved agent map, regardless of agent source.
	for (const [name, override] of Object.entries(config?.agents ?? {})) {
		const agent = agentMap.get(name);
		if (!agent) continue;

		const nextAgent: AgentConfig = { ...agent };
		if (hasOwn(override, "tools")) nextAgent.tools = override.tools;
		if (hasOwn(override, "model")) {
			nextAgent.model = override.model === null ? undefined : override.model;
		}
		if (hasOwn(override, "thinkingLevel")) {
			nextAgent.thinkingLevel =
				override.thinkingLevel === null ? undefined : override.thinkingLevel;
		}
		if (hasOwn(override, "timeoutMs")) {
			nextAgent.timeoutMs = override.timeoutMs === null ? undefined : override.timeoutMs;
		}
		agentMap.set(name, nextAgent);
	}

	const omittedAgentDefinitions =
		userLoaded.omittedAgentDefinitions + projectLoaded.omittedAgentDefinitions;
	const metadataDiscoveryIncomplete =
		userLoaded.metadataDiscoveryIncomplete || projectLoaded.metadataDiscoveryIncomplete;
	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
		...(omittedAgentDefinitions > 0 ? { omittedAgentDefinitions } : {}),
		...(metadataDiscoveryIncomplete ? { metadataDiscoveryIncomplete } : {}),
	};
}

export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

export interface AgentCatalog {
	/** The effective catalog for the default invocation scope. */
	user: AgentDiscoveryResult;
	/** The project-scope catalog; custom project definitions are loaded only after project trust. */
	project?: AgentDiscoveryResult;
}

export interface AgentCatalogFormatOptions {
	maxItems?: number;
	maxDescriptionLength?: number;
	maxCharacters?: number;
}

export interface AgentCatalogFormatResult {
	text: string;
	omitted: number;
}

export const DEFAULT_AGENT_CATALOG_MAX_ITEMS = 32;
export const DEFAULT_AGENT_CATALOG_MAX_DESCRIPTION_LENGTH = 240;
export const DEFAULT_AGENT_CATALOG_MAX_CHARACTERS = 6_000;
export const DEFAULT_AGENT_CATALOG_MAX_FILES_PER_SCOPE = 128;
export const DEFAULT_AGENT_CATALOG_MAX_FILE_BYTES = 64 * 1024;
export const DEFAULT_AGENT_CATALOG_MAX_TOTAL_BYTES_PER_SCOPE = 2 * 1024 * 1024;

const BUILT_IN_AGENT_ORDER = new Map(BUILT_IN_AGENTS.map((agent, index) => [agent.name, index]));

function compareCatalogAgents(left: AgentConfig, right: AgentConfig): number {
	const leftBuiltInOrder = BUILT_IN_AGENT_ORDER.get(left.name);
	const rightBuiltInOrder = BUILT_IN_AGENT_ORDER.get(right.name);
	if (leftBuiltInOrder !== undefined || rightBuiltInOrder !== undefined) {
		if (leftBuiltInOrder === undefined) return 1;
		if (rightBuiltInOrder === undefined) return -1;
		return leftBuiltInOrder - rightBuiltInOrder;
	}
	return left.name.localeCompare(right.name);
}

function normalizeCatalogDescription(description: string, maxLength: number): string {
	const normalized = description.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	const suffix = "…";
	return `${normalized.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

type CatalogScope = "user" | "project" | "project-fallback";

function catalogAgentLine(
	agent: AgentConfig,
	scope: CatalogScope,
	userNames: ReadonlySet<string>,
	maxDescriptionLength: number,
): string {
	const scopeLabel =
		scope === "user"
			? 'agentScope: "user"'
			: scope === "project"
				? 'requires agentScope: "project" or "both"'
				: 'requires agentScope: "project" ("both" selects the user definition)';
	const collision =
		scope !== "user" && userNames.has(agent.name)
			? scope === "project"
				? "; overrides the default user definition for project/both"
				: "; scope-specific fallback for the default user override"
			: "";
	return `- ${agent.name} [source: ${agent.source}; ${scopeLabel}${collision}] — ${normalizeCatalogDescription(agent.description, maxDescriptionLength)}`;
}

/**
 * Format the effective agent variants that the parent model can invoke.
 *
 * User-authored descriptions are prompt text, so this formatter deliberately normalizes and bounds
 * them. Project definitions are supplied separately by the caller so an untrusted project is never
 * read merely to build model-facing metadata.
 */
export function formatAgentCatalog(
	catalog: AgentCatalog,
	options: AgentCatalogFormatOptions = {},
): AgentCatalogFormatResult {
	const maxItems = Math.max(0, options.maxItems ?? DEFAULT_AGENT_CATALOG_MAX_ITEMS);
	const maxDescriptionLength = Math.max(
		1,
		options.maxDescriptionLength ?? DEFAULT_AGENT_CATALOG_MAX_DESCRIPTION_LENGTH,
	);
	const maxCharacters = Math.max(1, options.maxCharacters ?? DEFAULT_AGENT_CATALOG_MAX_CHARACTERS);
	const userDiscoveryIncomplete =
		(catalog.user.omittedAgentDefinitions ?? 0) > 0 ||
		catalog.user.metadataDiscoveryIncomplete === true;
	const projectDiscoveryIncomplete =
		(catalog.project?.omittedAgentDefinitions ?? 0) > 0 ||
		catalog.project?.metadataDiscoveryIncomplete === true;
	const discoveredUserAgents = [...catalog.user.agents].sort(compareCatalogAgents);
	const discoveredProjectScopeAgents = [...(catalog.project?.agents ?? [])].sort(
		compareCatalogAgents,
	);
	const userAgents = userDiscoveryIncomplete ? [] : discoveredUserAgents;
	const projectScopeAgents = projectDiscoveryIncomplete ? [] : discoveredProjectScopeAgents;
	const projectAgents = projectScopeAgents.filter((agent) => agent.source === "project");
	const discoveredUserByName = new Map(discoveredUserAgents.map((agent) => [agent.name, agent]));
	const userByName = new Map(userAgents.map((agent) => [agent.name, agent]));
	const userNames = new Set(userByName.keys());
	const potentialProjectFallbackAgents = discoveredProjectScopeAgents.filter(
		(agent) =>
			agent.source === "built-in" && discoveredUserByName.get(agent.name)?.source === "user",
	);
	const projectFallbackAgents =
		userDiscoveryIncomplete || projectDiscoveryIncomplete ? [] : potentialProjectFallbackAgents;
	const allEntries = [
		...userAgents.map((agent) => ({ agent, scope: "user" as const })),
		...projectAgents.map((agent) => ({ agent, scope: "project" as const })),
		...projectFallbackAgents.map((agent) => ({ agent, scope: "project-fallback" as const })),
	];
	const boundedEntries = allEntries.slice(0, maxItems);
	const suppressedMetadataEntries =
		(userDiscoveryIncomplete ? discoveredUserAgents.length : 0) +
		(projectDiscoveryIncomplete
			? discoveredProjectScopeAgents.filter((agent) => agent.source === "project").length +
				potentialProjectFallbackAgents.length
			: 0);
	const discoveryOmissions =
		(catalog.user.omittedAgentDefinitions ?? 0) +
		(catalog.project?.omittedAgentDefinitions ?? 0) +
		suppressedMetadataEntries;
	const discoveryIncomplete =
		catalog.user.metadataDiscoveryIncomplete === true ||
		catalog.project?.metadataDiscoveryIncomplete === true;

	const render = (entries: typeof allEntries, omitted: number): string => {
		const lines = [
			"Available agent definitions (metadata only; runtime validation and trust remain authoritative).",
		];
		const userLines = entries
			.filter((entry) => entry.scope === "user")
			.map((entry) => catalogAgentLine(entry.agent, entry.scope, userNames, maxDescriptionLength));
		if (userLines.length > 0) {
			lines.push('Default scope (agentScope: "user"):');
			lines.push(...userLines);
		}
		const projectLines = entries
			.filter((entry) => entry.scope !== "user")
			.map((entry) => catalogAgentLine(entry.agent, entry.scope, userNames, maxDescriptionLength));
		if (projectLines.length > 0) {
			lines.push("Trusted project/scope variants (use the required agentScope shown):");
			lines.push(...projectLines);
		}
		const collisionNames = entries
			.filter((entry) => entry.scope !== "user" && userNames.has(entry.agent.name))
			.map((entry) => entry.agent.name);
		if (collisionNames.length > 0 && projectLines.length > 0) {
			const precedence = entries
				.filter((entry) => entry.scope !== "user" && userNames.has(entry.agent.name))
				.map((entry) =>
					entry.scope === "project"
						? `${entry.agent.name}: user with "user", project with "project"/"both"`
						: `${entry.agent.name}: user with "user"/"both", built-in with "project"`,
				);
			lines.push(`Same-name precedence: ${precedence.join("; ")}.`);
		}
		if (omitted > 0) {
			lines.push(
				`[${omitted} additional agent definition${omitted === 1 ? "" : "s"} omitted due to metadata bounds or incomplete discovery.]`,
			);
		}
		if (discoveryIncomplete) {
			lines.push("[Agent metadata discovery was incomplete; some definitions may be unavailable.]");
		}
		return lines.join("\n");
	};

	let listedCount = boundedEntries.length;
	let text = render(
		boundedEntries.slice(0, listedCount),
		allEntries.length - listedCount + discoveryOmissions,
	);
	while (text.length > maxCharacters && listedCount > 0) {
		listedCount -= 1;
		text = render(
			boundedEntries.slice(0, listedCount),
			allEntries.length - listedCount + discoveryOmissions,
		);
	}
	return { text, omitted: allEntries.length - listedCount + discoveryOmissions };
}

export function discoverAgentCatalog(
	cwd: string,
	projectTrusted: boolean,
	config?: SubagentSettings,
): AgentCatalog {
	const options: AgentDiscoveryOptions = {
		maxFiles: DEFAULT_AGENT_CATALOG_MAX_FILES_PER_SCOPE,
		maxFileBytes: DEFAULT_AGENT_CATALOG_MAX_FILE_BYTES,
		maxTotalBytes: DEFAULT_AGENT_CATALOG_MAX_TOTAL_BYTES_PER_SCOPE,
	};
	return {
		user: discoverAgents(cwd, "user", config, options),
		project: projectTrusted ? discoverAgents(cwd, "project", config, options) : undefined,
	};
}
