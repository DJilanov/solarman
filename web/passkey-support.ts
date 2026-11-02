export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

export function passkeyCancelled(error: unknown): boolean {
  const cancelled = (value: unknown): boolean =>
    typeof value === "object" && value !== null && "name" in value &&
    (value.name === "NotAllowedError" || value.name === "AbortError");
  return cancelled(error) || (typeof error === "object" && error !== null && "cause" in error && cancelled(error.cause));
}
