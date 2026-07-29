const MAX_ERROR_MESSAGE_LENGTH = 240;

export function sanitizeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected error";
  const normalized = message.replace(/\s+/g, " ").trim() || "Unexpected error";
  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
