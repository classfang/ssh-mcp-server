export type ToolErrorCode =
  | "COMMAND_VALIDATION_FAILED"
  | "COMMAND_EXECUTION_ERROR"
  | "COMMAND_TIMEOUT"
  | "SSH_CONNECTION_FAILED"
  | "SSH_AUTHENTICATION_MISSING"
  | "LOCAL_PATH_NOT_ALLOWED"
  | "REMOTE_PATH_NOT_ALLOWED"
  | "LOCAL_FILE_READ_FAILED"
  | "LOCAL_FILE_WRITE_FAILED"
  | "SFTP_ERROR"
  | "UNSUPPORTED_IN_SHELL_MODE"
  | "UNKNOWN_ERROR";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function toToolError(
  error: unknown,
  fallbackCode: ToolErrorCode,
): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  if (error instanceof Error) {
    return new ToolError(fallbackCode, error.message, false);
  }

  return new ToolError(fallbackCode, String(error), false);
}
