const MAX_OBJECTIVE_LENGTH = 4_000;

export interface GoalCommandFeatures {
	experimentalGoals?: boolean;
}

export interface CommandResult {
	kind:
		| "start"
		| "pause"
		| "resume"
		| "clear"
		| "show"
		| "edit"
		| "add"
		| "prioritize"
		| "drop-last"
		| "skip";
	objective?: string;
	tokenBudget?: number;
}

export interface GoalArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const TOKEN_BUDGET_COMPLETION: GoalArgumentCompletion = {
	value: "--tokens ",
	label: "--tokens",
	description: "在目标前设置 token 预算",
};
const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "pause", label: "pause", description: "暂停活动目标" },
	{ value: "resume", label: "resume", description: "恢复已停止或预算受限的目标" },
	{ value: "clear", label: "clear", description: "清除当前目标" },
	{ value: "edit", label: "edit", description: "编辑当前目标描述" },
	{ value: "status", label: "status", description: "显示当前目标" },
	TOKEN_BUDGET_COMPLETION,
];
const QUEUE_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "add", label: "add", description: "将目标添加到队列末尾" },
	{
		value: "prioritize",
		label: "prioritize",
		description: "在队列前面优先处理新目标",
	},
	{ value: "drop-last", label: "drop-last", description: "移除最后一个目标" },
	{ value: "skip", label: "skip", description: "跳过当前目标" },
];

export function completeGoalArguments(
	argumentPrefix: string,
	features: GoalCommandFeatures = {},
): GoalArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	const completions = features.experimentalGoals
		? [
				...GOAL_ARGUMENT_COMPLETIONS.slice(0, -1),
				...QUEUE_ARGUMENT_COMPLETIONS,
				TOKEN_BUDGET_COMPLETION,
			]
		: [...GOAL_ARGUMENT_COMPLETIONS];
	if (prefix === "") return completions;

	const objectiveOption = features.experimentalGoals
		? /^(edit|add|prioritize)\s+(\S*)$/.exec(prefix)
		: /^edit\s+(\S*)$/.exec(prefix);
	if (objectiveOption) {
		const command = features.experimentalGoals ? (objectiveOption[1] ?? "edit") : "edit";
		const optionPrefix = features.experimentalGoals
			? (objectiveOption[2] ?? "")
			: (objectiveOption[1] ?? "");
		return optionPrefix === "" || "--tokens".startsWith(optionPrefix)
			? [
					{
						value: `${command} --tokens `,
						label: "--tokens",
						description:
							command === "edit"
								? "Set a token budget before the updated goal"
								: "Set a token budget before the queued goal",
					},
				]
			: null;
	}
	if (/\s/.test(prefix)) return null;
	const matches = completions.filter(
		(item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
	);
	return matches.length > 0 ? matches : null;
}

export function parseCommand(
	args: string,
	features: GoalCommandFeatures = {},
): CommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };
	const [first, ...rest] = tokens;
	if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "用法：/goal pause";
	if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "用法：/goal resume";
	if (first === "clear" || first === "stop")
		return rest.length === 0 ? { kind: "clear" } : "用法：/goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "用法：/goal status";
	if (first === "edit") return parseObjective("edit", rest);

	if (features.experimentalGoals) {
		if (first === "drop-last" || first === "pop") {
			return rest.length === 0 ? { kind: "drop-last" } : "用法：/goal drop-last";
		}
		if (first === "skip" || first === "shift") {
			return rest.length === 0 ? { kind: "skip" } : "用法：/goal skip";
		}
		if (first === "add" || first === "push") return parseObjective("add", rest);
		if (first === "prioritize" || first === "unshift") {
			return parseObjective("prioritize", rest);
		}
	}

	return parseObjective("start", tokens);
}

function parseObjective(
	kind: "start" | "edit" | "add" | "prioritize",
	tokens: string[],
): CommandResult | string {
	let tokenBudget: number | undefined;
	const objectiveTokens = [...tokens];
	if (objectiveTokens[0] === "--tokens") {
		const rawBudget = objectiveTokens[1];
		if (!rawBudget) {
			return kind === "start"
				? "用法：/goal --tokens 100k <要完成的目标>"
				: `Usage: /goal ${kind} --tokens 100k <goal_to_complete>`;
		}
		const parsedBudget = parseTokenBudget(rawBudget);
		if (parsedBudget === undefined) return `无效的 token 预算：${rawBudget}`;
		tokenBudget = parsedBudget;
		objectiveTokens.splice(0, 2);
	}
	if (objectiveTokens.length === 0) {
		if (kind === "start") return "用法：/goal <要完成的目标>";
		return `Usage: /goal ${kind} <goal_to_complete>`;
	}
	return { kind, objective: objectiveTokens.join(" "), tokenBudget };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier =
		match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return normalizeTokenBudget(Math.floor(amount * multiplier));
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "用法：/goal <要完成的目标>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `目标描述过长（${trimmed.length}/${MAX_OBJECTIVE_LENGTH} 字符）。请将长指令放入文件，并从 /goal 引用它。`;
	}
	return undefined;
}

function normalizeTokenBudget(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
