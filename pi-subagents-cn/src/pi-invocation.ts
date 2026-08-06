import * as fs from "node:fs";
import * as path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const CORE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_DISPLAY_PATH_LENGTH = 500;

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface PiInvocationRuntime {
	execPath: string;
	packageDir: string;
	runtimeKind: "node" | "bun" | "unsupported";
}

export class PiInvocationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiInvocationError";
	}
}

function displayPath(value: string): string {
	const suffix = value.length > MAX_DISPLAY_PATH_LENGTH ? "…" : "";
	return JSON.stringify(`${value.slice(0, MAX_DISPLAY_PATH_LENGTH)}${suffix}`);
}

function resolutionError(packageDir: string, reason: string): PiInvocationError {
	return new PiInvocationError(
		`无法从已加载的 ${CORE_PACKAGE_NAME} 包中解析 Pi CLI（位于 ${displayPath(packageDir)}）：${reason}。使用子进程传输前，请重新安装匹配的 Pi 核心包。`,
	);
}

function currentRuntime(): PiInvocationRuntime {
	let packageDir: string;
	try {
		packageDir = getPackageDir();
	} catch {
		throw resolutionError("<unavailable>", "Pi core did not provide its package directory");
	}
	const runtimeKind = process.versions.bun
		? "bun"
		: process.release.name === "node" && !process.versions.electron
			? "node"
			: "unsupported";
	return {
		execPath: process.execPath,
		packageDir,
		runtimeKind,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithinDirectory(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

function readCoreManifest(packageDir: string): Record<string, unknown> {
	const manifestPath = path.join(packageDir, "package.json");
	let source: string;
	try {
		source = fs.readFileSync(manifestPath, "utf8");
	} catch {
		throw resolutionError(packageDir, "the package manifest is unavailable");
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(source);
	} catch {
		throw resolutionError(packageDir, "the package manifest is invalid JSON");
	}
	if (!isRecord(manifest)) {
		throw resolutionError(packageDir, "the package manifest is invalid");
	}
	if (manifest.name !== CORE_PACKAGE_NAME) {
		throw resolutionError(packageDir, "the package manifest has an unexpected package name");
	}
	return manifest;
}

function resolveDeclaredBin(packageDir: string, manifest: Record<string, unknown>): string {
	const bin = manifest.bin;
	const piBin = isRecord(bin) ? bin.pi : undefined;
	if (typeof piBin !== "string" || !piBin.trim()) {
		throw resolutionError(packageDir, "package.json bin.pi must be a non-empty string");
	}
	const candidate = path.resolve(packageDir, piBin);
	if (path.isAbsolute(piBin) || !isWithinDirectory(packageDir, candidate)) {
		throw resolutionError(packageDir, "the declared bin.pi target escapes the package directory");
	}
	return candidate;
}

function resolveExistingFile(packageDir: string, candidate: string, reason: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync(candidate);
		if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
	} catch {
		throw resolutionError(packageDir, reason);
	}
	if (!isWithinDirectory(packageDir, resolved)) {
		throw resolutionError(packageDir, "the declared bin.pi target escapes the package directory");
	}
	return resolved;
}

function resolveStandaloneExecutable(
	packageDir: string,
	runtime: PiInvocationRuntime,
): string | undefined {
	if (runtime.runtimeKind !== "bun") return undefined;
	const { execPath } = runtime;
	if (!/^pi(?:\.exe)?$/i.test(path.basename(execPath))) return undefined;
	let resolved: string;
	let mode: number;
	try {
		resolved = fs.realpathSync(execPath);
		const stat = fs.statSync(resolved);
		if (!stat.isFile()) throw new Error("not a file");
		mode = stat.mode;
	} catch {
		throw resolutionError(packageDir, "the standalone Pi executable is unavailable");
	}
	if (path.dirname(resolved) !== packageDir) return undefined;
	if (process.platform !== "win32" && (mode & 0o111) === 0) {
		throw resolutionError(packageDir, "the standalone Pi executable is not executable");
	}
	return resolved;
}

export function resolvePiInvocation(
	args: string[],
	runtime: PiInvocationRuntime = currentRuntime(),
): PiInvocation {
	let packageDir: string;
	try {
		packageDir = fs.realpathSync(runtime.packageDir);
		if (!fs.statSync(packageDir).isDirectory()) throw new Error("not a directory");
	} catch {
		throw resolutionError(runtime.packageDir, "the package directory is unavailable");
	}

	const manifest = readCoreManifest(packageDir);
	const declaredBin = resolveDeclaredBin(packageDir, manifest);
	const standalone = resolveStandaloneExecutable(packageDir, runtime);
	if (standalone) return { command: standalone, args: [...args] };

	if (runtime.runtimeKind !== "node" && runtime.runtimeKind !== "bun") {
		throw resolutionError(packageDir, "the host does not provide a supported Node or Bun runtime");
	}
	const cliPath = resolveExistingFile(
		packageDir,
		declaredBin,
		"the declared bin.pi target is unavailable",
	);
	return { command: runtime.execPath, args: [cliPath, ...args] };
}
