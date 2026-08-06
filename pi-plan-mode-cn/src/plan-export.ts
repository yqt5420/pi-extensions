import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PLAN_EXPORT_PATH } from "./settings.js";
import type { PlanModeState } from "./state.js";

export { DEFAULT_PLAN_EXPORT_PATH };

export interface PlanExportResult {
	path: string;
}

export interface PlanExportDestination {
	configuredPath: string;
	resolvedPath: string;
}

export interface PlanExportLifecycle {
	signal: AbortSignal;
	isCurrent(): boolean;
	getState?(): PlanModeState;
	finishReady?(): void;
}

export async function exportStoredPlan(
	state: PlanModeState,
	requestedPath: string | undefined,
	ctx: ExtensionContext,
	lifecycle?: PlanExportLifecycle,
	defaultPath = DEFAULT_PLAN_EXPORT_PATH,
) {
	const plan =
		(state.enabled ? state.latestPlan : undefined)?.trim() ??
		state.savedPlan?.plan.trim() ??
		state.activeImplementation?.plan.trim();
	if (!plan) {
		const error = new Error(
			"没有可导出的已完成计划。规划完成后使用 /plan finalize。",
		);
		if (!ctx.hasUI) throw error;
		ctx.ui.notify(error.message, "warning");
		return false;
	}

	const isCurrent = () =>
		!lifecycle ||
		(lifecycle.isCurrent() && (!lifecycle.getState || lifecycle.getState() === state));
	let result: PlanExportResult;
	try {
		result = await exportPlanToFile(
			plan,
			requestedPath,
			ctx.cwd,
			lifecycle?.signal,
			isCurrent,
			defaultPath,
		);
	} catch (error: unknown) {
		if (lifecycle?.signal.aborted || !isCurrent()) return false;
		if (!ctx.hasUI) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(safeNotification(`无法导出计划：${detail}`), "error");
		return false;
	}

	if (!isCurrent()) return false;
	const finishedReady =
		state.enabled && Boolean(state.latestPlan?.trim()) && lifecycle?.finishReady !== undefined;
	if (finishedReady) lifecycle.finishReady?.();
	const detail = finishedReady ? " 计划模式已禁用。" : "";
	ctx.ui.notify(safeNotification(`计划已导出到 ${result.path}。${detail}`), "info");
	return true;
}

export async function exportPlanToFile(
	plan: string,
	requestedPath: string | undefined,
	cwd: string,
	signal?: AbortSignal,
	isCurrent: () => boolean = () => true,
	defaultPath = DEFAULT_PLAN_EXPORT_PATH,
): Promise<PlanExportResult> {
	const path = resolvePlanExportPath(requestedPath, cwd, defaultPath);
	await withFileMutationQueue(path, async () => {
		throwIfCancelled(signal, isCurrent);
		await mkdir(dirname(path), { recursive: true });
		throwIfCancelled(signal, isCurrent);
		try {
			await writeFile(path, `${plan}\n`, { encoding: "utf8", flag: "wx" });
		} catch (error: unknown) {
			if (isNodeError(error) && error.code === "EEXIST") {
				throw new Error(
					`计划导出目标已存在：${path}。请选择其他路径或先删除它。`,
				);
			}
			throw error;
		}
	});
	return { path };
}

export function planExportDestination(defaultPath: string, cwd: string): PlanExportDestination {
	return {
		configuredPath: safeNotification(defaultPath),
		resolvedPath: safeNotification(resolvePlanExportPath(undefined, cwd, defaultPath)),
	};
}

export function resolvePlanExportPath(
	requestedPath: string | undefined,
	cwd: string,
	defaultPath = DEFAULT_PLAN_EXPORT_PATH,
) {
	const rawPath = requestedPath?.trim() || defaultPath;
	const normalizedPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (!normalizedPath.trim()) throw new Error("计划导出路径不能为空。");
	if (normalizedPath.includes("\0")) {
		throw new Error("计划导出路径不能包含 NUL 字节。");
	}
	return resolve(cwd, normalizedPath);
}

function safeNotification(value: string) {
	let sanitized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		sanitized +=
			codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f)
				? character
				: " ";
	}
	return sanitized;
}

function throwIfCancelled(signal: AbortSignal | undefined, isCurrent: () => boolean) {
	if (!signal?.aborted && isCurrent()) return;
	throw signal?.reason instanceof Error
		? signal.reason
		: new DOMException("计划导出已取消", "AbortError");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
