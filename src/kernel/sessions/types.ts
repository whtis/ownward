export interface DevMsg { role: "user" | "assistant" | "tool" | "system" | "thinking"; text: string; name?: string; ts: string; images?: string[]; /* /api/agent-image/... URL，agent 眼里的图 */ }
export interface DevImage { media_type: string; data: string; }
export type AgentControl = "ownward" | "external" | "observing";
export interface PlanStep { text: string; status: "pending" | "in_progress" | "completed"; }
export interface TokenUsage { input?: number; output?: number; total?: number; }
