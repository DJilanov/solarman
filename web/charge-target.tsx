import { Minus, Plus } from "lucide-react";
import { type CSSProperties, type ReactNode, type Ref } from "react";
import { formatNumber } from "./format";
import { tr } from "./i18n";

interface ChargeTargetProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  dial?: boolean;
  currentSoc?: number;
  inputRef?: Ref<HTMLInputElement>;
}

export function ChargeTarget({
  id,
  label,
  value,
  min,
  max,
  onChange,
  disabled = false,
  dial = false,
  currentSoc,
  inputRef,
}: ChargeTargetProps): ReactNode {
  const target = Math.max(min, Math.min(max, value));
  const progress = max > min ? (target - min) / (max - min) : 1;
  const style: CSSProperties & {
    "--charge-accent": string;
    "--charge-fill": string;
  } = {
    "--charge-accent": `hsl(${44 + progress * 112} 68% 72%)`,
    "--charge-fill": `${progress * 100}%`,
  };
  const current =
    typeof currentSoc === "number" && Number.isFinite(currentSoc)
      ? Math.max(0, Math.min(100, currentSoc))
      : null;
  const angle = ((current ?? 0) / 100) * Math.PI * 2 - Math.PI / 2;
  const select = (next: number): void =>
    onChange(Math.max(min, Math.min(max, next)));
  return (
    <div
      className={`charge-target${dial ? " charge-target-with-dial" : ""}`}
      style={style}
    >
      {dial && (
        <div className="charge-target-dial" aria-hidden="true">
          <svg viewBox="0 0 224 224" focusable="false">
            <circle
              className="charge-target-ticks"
              cx="112"
              cy="112"
              r="104"
              pathLength="100"
            />
            <circle className="charge-target-track" cx="112" cy="112" r="88" />
            <circle
              className="charge-target-progress"
              cx="112"
              cy="112"
              r="88"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - target}
              transform="rotate(-90 112 112)"
            />
            {current !== null && (
              <circle
                className="charge-target-marker"
                cx={112 + 88 * Math.cos(angle)}
                cy={112 + 88 * Math.sin(angle)}
                r="5"
              />
            )}
          </svg>
          <div className="charge-target-value">
            <span className="charge-target-preview">{tr("PREVIEW")}</span>
            <strong>
              {formatNumber(target)}
              <small>%</small>
            </strong>
            <span>{tr("YOUR TARGET")}</span>
          </div>
        </div>
      )}
      <label className="charge-target-label" htmlFor={id}>
        <span>{label}</span>
        <output htmlFor={id}>{formatNumber(target)}%</output>
      </label>
      <div className="charge-target-adjuster">
        <button
          type="button"
          className="charge-target-step"
          aria-label={tr("Decrease charge target")}
          disabled={disabled || target <= min}
          onClick={() => select(target - 1)}
        >
          <Minus size={17} aria-hidden="true" />
        </button>
        <input
          id={id}
          ref={inputRef}
          className="charge-target-range"
          type="range"
          min={min}
          max={max}
          step="1"
          value={target}
          disabled={disabled || min === max}
          onChange={(event) => select(Number(event.target.value))}
          aria-valuetext={`${formatNumber(target)}%`}
        />
        <button
          type="button"
          className="charge-target-step"
          aria-label={tr("Increase charge target")}
          disabled={disabled || target >= max}
          onClick={() => select(target + 1)}
        >
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="charge-target-limits" aria-hidden="true">
        <span>{formatNumber(min)}%</span>
        <span>{formatNumber(max)}%</span>
      </div>
      {dial && (
        <div className="outage-presets" aria-label={tr("Suggested targets")}>
          {[80, 90, 100]
            .filter((preset) => preset >= min && preset <= max)
            .map((preset) => (
              <button
                type="button"
                key={preset}
                className="button secondary"
                aria-pressed={target === preset}
                disabled={disabled}
                onClick={() => select(preset)}
              >
                {formatNumber(preset)}%
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
