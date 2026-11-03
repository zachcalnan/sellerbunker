/** Turn Nest/JSON/OpenAI error bodies into a short user-facing message. */
export function formatApiErrorMessage(
  raw: string,
  fallback = "Request failed.",
): string {
  const text = (raw ?? "").trim();
  if (!text) return fallback;

  let message = text;
  try {
    const parsed = JSON.parse(text) as {
      message?: string | string[];
      error?: string;
    };
    if (Array.isArray(parsed.message)) {
      message = parsed.message.filter(Boolean).join("; ");
    } else if (typeof parsed.message === "string" && parsed.message.trim()) {
      message = parsed.message.trim();
    } else if (typeof parsed.error === "string" && parsed.error.trim()) {
      message = parsed.error.trim();
    }
  } catch {
    // keep raw text
  }

  const lower = message.toLowerCase();
  if (
    lower.includes("credit_balance_exhausted") ||
    lower.includes("insufficient_quota") ||
    lower.includes("no credits remaining")
  ) {
    return "OpenAI billing has no credits left — top up the API account, or enter the purchase manually below.";
  }
  if (lower.includes("openai_api_key is not configured")) {
    return "Screenshot AI is not configured on the server (missing OPENAI_API_KEY). Enter the purchase manually below.";
  }
  if (lower.includes("openai error 429") || lower.includes('"type": "rate_limit')) {
    return "OpenAI rate limit hit — wait a moment and try again, or enter the purchase manually.";
  }

  // Strip nested JSON blobs for readability when still technical.
  if (message.length > 280) {
    return `${message.slice(0, 277)}…`;
  }
  return message;
}
