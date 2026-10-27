import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: "same-origin",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "Unable to reach the dashboard. Check your connection and try again.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "The dashboard returned an unexpected response. Please try again.",
    );
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("solarman-session-expired"));
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "The request could not be completed.";
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export function useData<T>(
  path: string,
  pollMs = 15_000,
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const previousPath = useRef<string | null>(null);
  const reload = useCallback((): void => setVersion((n) => n + 1), []);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    if (previousPath.current !== path) {
      setLoading(true);
      setData(null);
      setError(null);
    }
    previousPath.current = path;
    const load = async (): Promise<void> => {
      try {
        const result = await request<T>(path, { signal: abort.signal });
        if (active) {
          setData(result);
          setError(null);
        }
      } catch (cause) {
        if (active && !(cause instanceof Error && cause.name === "AbortError"))
          setError(
            cause instanceof Error ? cause.message : "Unable to load data",
          );
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, pollMs);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, [path, pollMs, version]);
  return { data, error, loading, reload };
}

export function dateKey(
  date: Date = new Date(),
  timezone = "Europe/Sofia",
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (kind: string): string =>
    parts.find((p) => p.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function offsetDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
