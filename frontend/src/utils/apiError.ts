/**
 * Extract a user-facing error message from a failed API response.
 * Supports JSON objects ({ error }), JSON-encoded strings, and plain text bodies.
 */
export async function readApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = (await response.text()).trim();
  if (!text) return fallback;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) {
        return error.trim();
      }
    }
  } catch {
    return text;
  }

  return fallback;
}
