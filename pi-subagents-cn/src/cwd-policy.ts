import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ConsultationCwdPolicy, DelegationCwdPolicy } from "./agents.js";
import { safeTerminalLine } from "./safe-text.js";

export type TargetBoundary = "current-workspace" | "external";
export type TargetTrustKind =
	| "session-trusted"
	| "session-untrusted"
	| "saved-trusted"
	| "saved-denied"
	| "unsaved"
	| "trust-error";

export interface ResolvedTargetTrust {
	kind: TargetTrustKind;
	projectTrusted: boolean;
	sourcePath?: string;
	warning?: string;
}

export interface ResolvedSubagentTarget {
	cwd: string;
	workspace: string;
	boundary: TargetBoundary;
	trust: ResolvedTargetTrust;
}

export interface TargetPolicyAudit {
	cwd: string;
	boundary: TargetBoundary;
	trust: {
		kind: TargetTrustKind;
		projectTrusted: boolean;
		sourcePath?: string;
		warning?: string;
	};
}

export function targetPolicyAudit(target: ResolvedSubagentTarget): TargetPolicyAudit {
	return {
		cwd: safeTerminalLine(target.cwd),
		boundary: target.boundary,
		trust: {
			...target.trust,
			sourcePath: target.trust.sourcePath ? safeTerminalLine(target.trust.sourcePath) : undefined,
			warning: target.trust.warning ? safeTerminalLine(target.trust.warning, 512) : undefined,
		},
	};
}

export interface ResolveSubagentTargetOptions {
	workspace: string;
	requestedCwd?: string;
	currentProjectTrusted: boolean;
	agentDir?: string;
}

export function resolveSubagentTarget(
	options: ResolveSubagentTargetOptions,
): ResolvedSubagentTarget {
	const workspace = canonicalDirectory(options.workspace, "Current workspace");
	const requested = path.resolve(options.workspace, options.requestedCwd ?? options.workspace);
	const cwd = canonicalDirectory(requested, "Subagent working directory");
	const boundary: TargetBoundary = isEqualOrDescendant(cwd, workspace)
		? "current-workspace"
		: "external";
	if (boundary === "current-workspace") {
		return {
			cwd,
			workspace,
			boundary,
			trust: {
				kind: options.currentProjectTrusted ? "session-trusted" : "session-untrusted",
				projectTrusted: options.currentProjectTrusted,
				sourcePath: workspace,
			},
		};
	}
	try {
		const entry = new ProjectTrustStore(options.agentDir ?? getAgentDir()).getEntry(cwd);
		if (!entry) {
			return {
				cwd,
				workspace,
				boundary,
				trust: { kind: "unsaved", projectTrusted: false },
			};
		}
		return {
			cwd,
			workspace,
			boundary,
			trust: {
				kind: entry.decision ? "saved-trusted" : "saved-denied",
				projectTrusted: entry.decision,
				sourcePath: entry.path,
			},
		};
	} catch {
		return {
			cwd,
			workspace,
			boundary,
			trust: {
				kind: "trust-error",
				projectTrusted: false,
				warning: safeTerminalLine(
					"Could not resolve Pi trust store; protected target resources were disabled. Repair trust with Pi /trust and restart Pi.",
					512,
				),
			},
		};
	}
}

export function assertConsultationTargetAllowed(
	target: ResolvedSubagentTarget,
	policy: ConsultationCwdPolicy,
): void {
	if (policy === "current-workspace" && target.boundary !== "current-workspace") {
		throw new Error(
			`只读咨询目标超出当前工作区：${safeTerminalLine(target.cwd)}`,
		);
	}
}

export function assertDelegationTargetAllowed(
	target: ResolvedSubagentTarget,
	policy: DelegationCwdPolicy,
): void {
	if (target.boundary === "current-workspace" || policy === "anywhere") return;
	if (policy === "trusted-targets" && target.trust.kind === "saved-trusted") return;
	if (policy === "current-workspace") {
		throw new Error(
			`常规委派目标超出当前工作区：${safeTerminalLine(target.cwd)}`,
		);
	}
	const reason =
		target.trust.kind === "trust-error"
			? target.trust.warning
			: `目标信任级别：${target.trust.kind}。`;
	throw new Error(
		[
			`常规委派目标不是已保存的受信任文件夹：${safeTerminalLine(target.cwd)}`,
			reason,
			"在该文件夹中打开 Pi，用 /trust 管理信任，重启 Pi，或在 /subagents 设置中选择「任意位置」。",
		]
			.filter(Boolean)
			.join(" "),
	);
}

function canonicalDirectory(value: string, label: string): string {
	let canonical: string;
	try {
		canonical = fs.realpathSync(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`${label} does not exist: ${safeTerminalLine(value)}`);
		}
		throw new Error(
			`${label} cannot be resolved: ${safeTerminalLine(value)}: ${formatError(error)}`,
		);
	}
	if (!fs.statSync(canonical).isDirectory()) {
		throw new Error(`${label} is not a directory: ${safeTerminalLine(canonical)}`);
	}
	return canonical;
}

function isEqualOrDescendant(candidate: string, workspace: string): boolean {
	const relative = path.relative(workspace, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
