export interface TalliWebMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute(input: unknown, context: { signal: AbortSignal }): Promise<string>;
}

export function createTalliWebMcpTools(deps: {
  requestJson: (
    path: string,
    options?: { body?: string; method?: string; signal?: AbortSignal },
  ) => Promise<unknown>;
  getSessionId: () => string;
  onActivity?: (entry: { timestamp?: string; message: string; kind?: string }) => void;
  onProposalOutcome?: (outcome: unknown) => void;
}): TalliWebMcpTool[];

export function registerTalliWebMcpTools(options: {
  document?: {
    modelContext?: {
      registerTool: (
        tool: TalliWebMcpTool,
        options?: { signal?: AbortSignal },
      ) => Promise<void> | void;
    };
  };
  requestJson?: (
    path: string,
    options?: { body?: string; method?: string; signal?: AbortSignal },
  ) => Promise<unknown>;
  getSessionId?: () => string;
  onActivity?: (entry: { timestamp?: string; message: string; kind?: string }) => void;
  onProposalOutcome?: (outcome: unknown) => void;
}): Promise<boolean> | boolean;

export function abortTalliWebMcpTools(): void;
export function resetTalliWebMcpToolsForTests(): void;
