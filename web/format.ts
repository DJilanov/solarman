import { tr, locale } from "./i18n";

export const COLORS = {
  solar: "#e9bf70",
  house: "#aaa4f1",
  grid: "#77b8ed",
  battery: "#9ddcc4",
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
): string {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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
