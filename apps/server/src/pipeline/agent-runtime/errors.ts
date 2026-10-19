export type AgentRuntimeFailure = {
  message: string;
  name?: string;
  code?: string;
  statusCode?: number;
};

export class AgentRuntimeError extends Error {
  readonly code?: string;
  readonly statusCode?: number;

  constructor(failure: AgentRuntimeFailure) {
    super(failure.message);
    this.name = failure.name ?? 'AgentRuntimeError';
    this.code = failure.code;
    this.statusCode = failure.statusCode;
  }
}
