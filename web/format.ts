import { tr, locale } from "./i18n";
import type { ControllerStatus } from "./types";

export const COLORS = {
  solar: "#f4cc86",
  house: "#d0c4f3",
  grid: "#a7d2fb",
  battery: "#bcf9d9",
  soc: "#d7e1e7",
};

export function power(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return Math.abs(value) < 1000
    ? `${formatNumber(Math.abs(value))} ${tr("W")}`
    : `${formatNumber(Math.abs(value) / 1000, 2)} ${tr("kW")}`;
}
export function energy(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatNumber(value, 2);
}
export function formatNumber(
  value: number,
  maximumFractionDigits = 0,
  minimumFractionDigits = maximumFractionDigits,
): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat(locale(), {
        minimumFractionDigits,
        maximumFractionDigits,
      }).format(value)
    : "—";
}
export function when(
  value: string | number,
  timezone = "Europe/Sofia",
  timeStyle: "short" | "medium" = "short",
): string {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle,
  }).format(new Date(value));
}

export function verificationValue(
  check: NonNullable<
    ControllerStatus["control"]["verification"]
  >["checks"][number],
  value: number | null,
): string {
  if (value === null) return tr("Unavailable");
  if (check.unit === "s") return tr("{{count}} seconds", { count: value });
  if (check.label === "Firmware compatibility")
    return tr(value === 1 ? "Validated firmware" : "Unvalidated firmware");
  if (check.label === "Operating mode")
    return tr(value === 0 ? "SelfUse" : "Other operating mode");
  if (check.label === "Run and backup flags")
    return tr(
      value === 9 ? "Running with backup enabled" : "Unexpected device flags",
    );
  if (check.unit === "W")
    return Math.abs(value) >= 1000
      ? `${formatNumber(value / 1000, 2, 0)} ${tr("kW")}`
      : `${formatNumber(value, 0)} ${tr("W")}`;
  return `${formatNumber(value, 0)}${check.unit}`;
}
export function age(value: string | null | undefined): string {
  if (!value) return tr("No readings yet");
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return tr("Just updated");
  if (seconds < 3600)
    return tr("{{count}} min ago", { count: Math.floor(seconds / 60) });
  if (seconds < 86400)
    return tr("{{count}} hr ago", { count: Math.floor(seconds / 3600) });
  return tr("{{count}} days ago", { count: Math.floor(seconds / 86400) });
}
