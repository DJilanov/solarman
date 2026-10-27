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
    ? `${Math.round(Math.abs(value))} W`
    : `${(Math.abs(value) / 1000).toFixed(2)} kW`;
}
export function energy(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}
export function when(
  value: string | number,
  timezone = "Europe/Sofia",
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
export function age(value: string | null | undefined): string {
  if (!value) return "No readings yet";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just updated";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}
