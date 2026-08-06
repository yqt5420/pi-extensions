export const READ_ONLY_CONSULT_TOOLS = ["read", "grep", "find", "ls"] as const;

const READ_ONLY_CONSULT_TOOL_SET = new Set<string>(READ_ONLY_CONSULT_TOOLS);

export function resolveConsultTools(tools: readonly string[] | undefined): string[] {
	if (tools === undefined) return [...READ_ONLY_CONSULT_TOOLS];
	const seen = new Set<string>();
	const effective: string[] = [];
	for (const tool of tools) {
		if (!READ_ONLY_CONSULT_TOOL_SET.has(tool) || seen.has(tool)) continue;
		seen.add(tool);
		effective.push(tool);
	}
	return effective;
}
