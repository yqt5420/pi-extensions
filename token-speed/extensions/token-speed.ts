/**
 * Token Speed Extension
 *
 * Displays real-time token generation speed (tokens/sec) in the footer
 * while the LLM is streaming a response.
 *
 * - Shows live speed during streaming (⚡ 12.5 t/s)
 * - Shows final summary on completion (✓ 512 tok @ 15.3 t/s (33.5s))
 * - Auto-clears after 10 seconds
 *
 * Subagent support (v1.1.0):
 * While a blocking subagent tool (`subagent` / `subagent_consult` from
 * @narumitw/pi-subagents) is running, the footer shows the subagent's
 * token speed (⚡ 子代理 [worker] 1.2k tok @ 15.2 t/s | 首 1.2s), derived
 * from `tool_execution_update` events — pi-subagents forwards one update
 * per assistant message end of the child process, carrying exact usage
 * (output tokens) plus messages for char-based estimation.
 * The main agent's own streaming display is paused while a subagent runs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUBAGENT_TOOLS = new Set(["subagent", "subagent_consult"]);
const APPROX_CHARS_PER_TOKEN = 4;

export default function (pi: ExtensionAPI) {
	// 主 agent 流式显示状态
	let enabled = true;
	let startTime = 0;
	let firstTokenTime = 0;
	let hasFirstToken = false;
	let charCount = 0;
	let thinkingCharCount = 0;
	let toolCallCharCount = 0;
	let preciseOutput = 0;
	let hasPrecise = false;
	let isStreaming = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	let clearTimer: ReturnType<typeof setTimeout> | null = null;
	let latestCtx: ExtensionContext | null = null;

	// 子代理显示状态
	let subActive = false;
	let subStartTime = 0;
	let subFirstUpdateMs = 0;
	let subHasFirstUpdate = false;
	let subStats: SubStats = emptyStats();
	let subTimer: ReturnType<typeof setInterval> | null = null;
	let subClearTimer: ReturnType<typeof setTimeout> | null = null;
	let subLatestCtx: ExtensionContext | null = null;

	function getElapsedSec(): number {
		return (Date.now() - startTime) / 1000;
	}

	function getApproxTokens(): number {
		return Math.round((charCount + thinkingCharCount + toolCallCharCount) / 4);
	}

	function getSpeedStr(approxTokens: number): string {
		if (!isStreaming || approxTokens === 0) return "0 t/s";
		const elapsed = getElapsedSec();
		if (elapsed < 0.05) return "...";
		return `${(approxTokens / elapsed).toFixed(1)} t/s`;
	}

	function fmtTokens(n: number): string {
		if (!Number.isFinite(n) || n <= 0) return "0";
		if (n < 1000) return `${n}`;
		if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
		return `${Math.round(n / 1000)}k`;
	}

	function fmtTTFB(): string {
		return hasFirstToken ? `${(firstTokenTime / 1000).toFixed(1)}s` : "...";
	}

	function buildLabel(
		tokenCount: number,
		elapsedSec: number,
		prefix: string,
	): string {
		const speed = tokenCount > 0 ? (tokenCount / elapsedSec).toFixed(1) : "0";
		const ttfb = hasFirstToken
			? ` | 首 ${(firstTokenTime / 1000).toFixed(1)}s`
			: "";
		return `${prefix} ${fmtTokens(tokenCount)} tok @ ${speed} t/s (${elapsedSec.toFixed(1)}s)${ttfb}`;
	}

	function updateStatus() {
		if (!isStreaming || !latestCtx || !enabled) return;
		// 子代理运行期间暂停主 agent 刷新，避免覆盖子代理速度显示
		if (subActive) return;
		const theme = latestCtx.ui.theme;
		const approxTokens = getApproxTokens();
		latestCtx.ui.setStatus(
			"token-speed",
			theme.fg(
				"accent",
				`⚡ ${fmtTokens(approxTokens)} tok @ ${getSpeedStr(approxTokens)} | 首 ${fmtTTFB()}`,
			),
		);
	}

	// ---------- 子代理统计 ----------

	interface UsageLike {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		contextTokens?: number;
		turns?: number;
		cost?: number;
	}

	interface MessageLike {
		role?: string;
		content?: Array<{ type?: string; text?: string; thinking?: string }>;
	}

	interface SingleResultLike {
		agent?: string;
		exitCode?: number;
		finalOutput?: string;
		messages?: MessageLike[];
		usage?: Partial<UsageLike>;
	}

	interface SubagentDetailsLike {
		mode?: string;
		results?: SingleResultLike[];
	}

	interface SubStats {
		output: number; // 精确 output tokens 累计
		hasUsage: boolean; // 是否拿到过非零精确值
		chars: number; // assistant 消息字符数（估算兜底）
		agents: string[];
	}

	function emptyStats(): SubStats {
		return { output: 0, hasUsage: false, chars: 0, agents: [] };
	}

	/** 从 partialResult.details.results 汇总 token 统计 */
	function collectStats(details: SubagentDetailsLike | undefined): SubStats {
		const stats = emptyStats();
		for (const result of details?.results ?? []) {
			if (typeof result.agent === "string" && result.agent && !stats.agents.includes(result.agent)) {
				stats.agents.push(result.agent);
			}
			const usage = result.usage;
			if (usage && typeof usage.output === "number" && usage.output > 0) {
				stats.output += usage.output;
				stats.hasUsage = true;
			}
			for (const message of result.messages ?? []) {
				if (message.role !== "assistant") continue;
				for (const part of message.content ?? []) {
					if (typeof part.text === "string") stats.chars += part.text.length;
					if (typeof part.thinking === "string") stats.chars += part.thinking.length;
				}
			}
		}
		return stats;
	}

	/** 流式中优先精确值，兜底字符估算 */
	function getSubTokenCount(stats: SubStats): { count: number; precise: boolean } {
		if (stats.hasUsage) return { count: stats.output, precise: true };
		return { count: Math.round(stats.chars / APPROX_CHARS_PER_TOKEN), precise: false };
	}

	function subGetElapsedSec(): number {
		return (Date.now() - subStartTime) / 1000;
	}

	function subGetSpeedStr(count: number): string {
		if (!subActive || count === 0) return "0 t/s";
		const elapsed = subGetElapsedSec();
		if (elapsed < 0.05) return "...";
		return `${(count / elapsed).toFixed(1)} t/s`;
	}

	function subAgentLabel(agents: string[]): string {
		if (agents.length === 0) return "";
		if (agents.length === 1) return ` [${agents[0]}]`;
		return ` [${agents.join("+")}]`;
	}

	/** 从工具 args 中提取 agent 名（single/parallel/chain/consult 各模式） */
	function extractAgentNames(args: unknown): string[] {
		const names: string[] = [];
		if (!args || typeof args !== "object") return names;
		const record = args as Record<string, unknown>;
		const push = (name: unknown) => {
			if (typeof name === "string" && name && !names.includes(name)) names.push(name);
		};
		push(record.agent);
		for (const key of ["tasks", "chain"]) {
			if (!Array.isArray(record[key])) continue;
			for (const item of record[key]) {
				if (item && typeof item === "object") push((item as Record<string, unknown>).agent);
			}
		}
		return names;
	}

	function subUpdateStreaming(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		const { count } = getSubTokenCount(subStats);
		ctx.ui.setStatus(
			"token-speed",
			theme.fg(
				"accent",
				`⚡ 子代理${subAgentLabel(subStats.agents)} ${fmtTokens(count)} tok @ ${subGetSpeedStr(count)} | 首 ${subHasFirstUpdate ? `${(subFirstUpdateMs / 1000).toFixed(1)}s` : "..."}`,
			),
		);
	}

	function subStopStreaming() {
		subActive = false;
		if (subTimer) {
			clearInterval(subTimer);
			subTimer = null;
		}
	}

	// ---------- 命令 ----------

	pi.registerCommand("tokenspeed", {
		description: "Toggle token speed display on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				ctx.ui.notify("Token speed display enabled", "info");
			} else {
				ctx.ui.setStatus("token-speed", undefined);
				ctx.ui.notify("Token speed display disabled", "info");
			}
		},
	});

	// ---------- 生命周期 ----------

	// 清理 timer 和 clearTimer，防止退出时残留
	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = null;
		}
		if (subTimer) {
			clearInterval(subTimer);
			subTimer = null;
		}
		if (subClearTimer) {
			clearTimeout(subClearTimer);
			subClearTimer = null;
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		// 取消上一轮的清除定时器，避免误清本轮状态
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = null;
		}

		startTime = Date.now();
		firstTokenTime = 0;
		hasFirstToken = false;
		charCount = 0;
		thinkingCharCount = 0;
		toolCallCharCount = 0;
		hasPrecise = false;
		preciseOutput = 0;
		isStreaming = true;
		latestCtx = ctx;

		if (!enabled) return;

		timer = setInterval(() => updateStatus(), 200);

		const theme = ctx.ui.theme;
		ctx.ui.setStatus("token-speed", theme.fg("accent", "⚡ ..."));
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!isStreaming || !enabled) return;
		if (event.message.role !== "assistant") return;
		const usage = event.message.usage;
		if (usage?.output) {
			preciseOutput += usage.output;
			hasPrecise = true;
		}
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!isStreaming || !enabled) return;
		const ev = event.assistantMessageEvent;

		// 记录首字时间（第一个 thinking_delta、text_delta 或 toolcall_delta）
		if (
			!hasFirstToken &&
			(ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")
		) {
			firstTokenTime = Date.now() - startTime;
			hasFirstToken = true;
		}

		// Count text tokens (output content)
		if (ev.type === "text_delta") {
			charCount += ev.delta.length;
		}

		// Count thinking tokens
		if (ev.type === "thinking_delta") {
			thinkingCharCount += ev.delta.length;
		}

		// Count tool call tokens (e.g. file write content)
		if (ev.type === "toolcall_delta") {
			toolCallCharCount += ev.delta.length;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		isStreaming = false;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}

		if (!enabled) {
			latestCtx = null;
			return;
		}

		const elapsedSec = getElapsedSec();
		const theme = ctx.ui.theme;

		if (hasPrecise) {
			ctx.ui.setStatus(
				"token-speed",
				theme.fg("success", buildLabel(preciseOutput, elapsedSec, "✓")),
			);
		} else {
			ctx.ui.setStatus(
				"token-speed",
				theme.fg("warning", buildLabel(getApproxTokens(), elapsedSec, "≈")),
			);
		}

		// Auto-clear after 10 seconds（用 latestCtx 避免会话切换后 ctx 失效）
		const clearCtx = latestCtx;
		clearTimer = setTimeout(() => {
			if (clearCtx) clearCtx.ui.setStatus("token-speed", undefined);
			clearTimer = null;
		}, 10000);

		latestCtx = null;
	});

	// ---------- 子代理工具事件 ----------

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!SUBAGENT_TOOLS.has(event.toolName)) return;
		if (!enabled || !ctx.hasUI) return;

		// 取消上一轮的清除定时器
		if (subClearTimer) {
			clearTimeout(subClearTimer);
			subClearTimer = null;
		}

		subActive = true;
		subStartTime = Date.now();
		subFirstUpdateMs = 0;
		subHasFirstUpdate = false;
		subStats = emptyStats();
		subLatestCtx = ctx;

		const theme = ctx.ui.theme;
		const agents = extractAgentNames(event.args);
		ctx.ui.setStatus(
			"token-speed",
			theme.fg("accent", `⚡ 子代理${subAgentLabel(agents)} 启动中...`),
		);

		// 心跳刷新：子代理思考/工具执行期间无 message_end 时保持显示
		subTimer = setInterval(() => {
			if (!subLatestCtx || !subActive) return;
			subUpdateStreaming(subLatestCtx);
		}, 500);
	});

	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!SUBAGENT_TOOLS.has(event.toolName)) return;
		if (!enabled || !subActive || !subLatestCtx) return;

		const details = (event.partialResult as { details?: SubagentDetailsLike } | undefined)?.details;
		const stats = collectStats(details);
		if (stats.agents.length === 0 && stats.output === 0 && stats.chars === 0) return;

		if (!subHasFirstUpdate) {
			subFirstUpdateMs = Date.now() - subStartTime;
			subHasFirstUpdate = true;
		}
		subStats = stats;

		subUpdateStreaming(subLatestCtx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!SUBAGENT_TOOLS.has(event.toolName)) return;
		if (!enabled || !subActive) return;

		subStopStreaming();
		if (!ctx.hasUI) return;

		const details = (event.result as { details?: SubagentDetailsLike } | undefined)?.details;
		subStats = collectStats(details);

		const theme = ctx.ui.theme;
		const { count, precise } = getSubTokenCount(subStats);
		const elapsedSec = subGetElapsedSec();
		const speed = elapsedSec < 0.05 ? "..." : count > 0 ? (count / elapsedSec).toFixed(1) : "0";
		const ttfb = subHasFirstUpdate
			? ` | 首 ${(subFirstUpdateMs / 1000).toFixed(1)}s`
			: "";
		const prefix = precise ? "✓" : "≈";
		const color = precise ? "success" : "warning";
		ctx.ui.setStatus(
			"token-speed",
			theme.fg(
				color,
				`${prefix} 子代理${subAgentLabel(subStats.agents)} ${fmtTokens(count)} tok @ ${speed} t/s (${elapsedSec.toFixed(1)}s)${ttfb}`,
			),
		);

		// Auto-clear after 10 seconds（用 subLatestCtx 避免会话切换后 ctx 失效）
		const clearCtx = subLatestCtx;
		subClearTimer = setTimeout(() => {
			if (clearCtx) clearCtx.ui.setStatus("token-speed", undefined);
			subClearTimer = null;
		}, 10000);

		subLatestCtx = null;
	});
}
