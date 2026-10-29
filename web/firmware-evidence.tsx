import { useState, type ReactNode } from "react";
import { Copy, Download, FileText } from "lucide-react";
import { Notice, Panel } from "./components";
import { tr } from "./i18n";
import type { ControllerStatus, FirmwareIdentity } from "./types";

interface FirmwareEvidenceProps {
  controller: ControllerStatus | null;
}

function recordedTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return tr("Not recorded");
  return new Date(value).toISOString();
}

function version(value: string | null | undefined): string {
  return value && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value)
    ? value
    : tr("Not recorded");
}

function firmwareLines(firmware: FirmwareIdentity | null | undefined): string[] {
  return [
    `${tr("Protocol version")}: ${version(firmware?.protocol)}`,
    `${tr("Main DSP version")}: ${version(firmware?.dsp)}`,
    `${tr("HMI version")}: ${version(firmware?.hmi)}`,
  ];
}

function diagnosticReport(controller: ControllerStatus): string {
  const { verification, firmware, verificationStatus } = controller.control;
  const stateLabels: Record<typeof verificationStatus.state, string> = {
    missing: tr("No settings report"),
    failed: tr("Settings report failed"),
    outdated: tr("Settings report is outdated"),
    expired: tr("Settings report expired"),
    verified: tr("Settings report verified"),
  };
  const checks = [
    { label: "Inverter rating", unit: "W" },
    { label: "Operating mode", unit: "" },
    { label: "Run and backup flags", unit: "" },
    { label: "AC charging setting", unit: "W" },
    { label: "Grid charging SOC target", unit: "%" },
    { label: "Overall SOC maximum", unit: "%" },
    { label: "On-grid battery reserve", unit: "%" },
  ];
  const settings = checks.map(({ label, unit }): string => {
    const value = verification?.checks.find(
      (check) => check.label === label,
    )?.actual;
    return `${tr(label)}: ${typeof value === "number" && Number.isFinite(value) ? String(value) + (unit ? " " + unit : "") : tr("Not recorded")}`;
  });
  const words = (
    ["2504", "2505", "3005", "3022", "3023", "3036"] as const
  ).map((address): string => {
    const value = verification?.holdingRegisters?.[address];
    return `${address}: ${typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535 ? String(value) : tr("Not recorded")}`;
  });
  return [
    tr("Saved device evidence"),
    `${tr("Selected model and profile")}: BSE20KH3 / bluesun-bse20kh3`,
    "",
    tr(
      "Solar charging follows the inverter and battery limits, up to the 100% SOC target.",
    ),
    "",
    tr("Latest observed firmware"),
    `${tr("Observed at")}: ${recordedTime(firmware?.collectedAt)}`,
    ...firmwareLines(firmware),
    "",
    tr("Saved settings report"),
    `${tr("Status")}: ${stateLabels[verificationStatus.state]}`,
    `${tr("Checked at")}: ${recordedTime(verification?.checkedAt)}`,
    ...firmwareLines(verification?.firmware),
    tr(
      "These values come from the saved diagnostic report. Run Verify device settings for a fresh readback.",
    ),
    ...settings,
    "",
    tr("Saved holding-register words"),
    tr(
      "Raw words are retained for diagnostics. Their interpretation depends on the selected firmware; missing values are shown as unrecorded.",
    ),
    ...words,
    "",
    tr(
      "This report records saved evidence and does not authorize inverter changes.",
    ),
    "",
  ].join("\n");
}

export function FirmwareEvidence({ controller }: FirmwareEvidenceProps): ReactNode {
  const [outcome, setOutcome] = useState<{
    state: "copied" | "failed";
    contents: string;
  } | null>(null);
  const [copying, setCopying] = useState(false);
  if (!controller || controller.profile !== "bluesun-bse20kh3") return null;
  const contents = diagnosticReport(controller);
  const copy = async (): Promise<void> => {
    setCopying(true);
    setOutcome(null);
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(contents);
      setOutcome({ state: "copied", contents });
    } catch {
      setOutcome({ state: "failed", contents });
    } finally {
      setCopying(false);
    }
  };
  const download = (): void => {
    const address = URL.createObjectURL(
      new Blob([contents], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = address;
    anchor.download = "solarman-device-evidence.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(address), 1000);
  };
  return (
    <Panel
      title={tr("Saved device evidence")}
      action={<FileText size={22} />}
    >
      <p>
        {tr(
          "Review or export saved firmware versions and numeric settings. This uses cached records and grants no control permission.",
        )}
      </p>
      <details>
        <summary>{tr("Review saved device evidence")}</summary>
        <pre
          className="firmware-evidence-preview"
          tabIndex={0}
          role="region"
          aria-label={tr("Device evidence preview")}
        >
          {contents}
        </pre>
      </details>
      <div className="readiness-actions">
        <button
          className="button secondary"
          disabled={copying}
          onClick={() => {
            void copy();
          }}
        >
          <Copy size={16} />
          {tr("Copy diagnostic report")}
        </button>
        <button className="button secondary" onClick={download}>
          <Download size={16} />
          {tr("Download diagnostic report")}
        </button>
      </div>
      {outcome?.contents === contents && (
        <Notice tone={outcome.state === "failed" ? "danger" : "success"}>
          {tr(
            outcome.state === "copied"
              ? "Diagnostic report copied"
              : "Clipboard access is unavailable. Download the diagnostic report instead.",
          )}
        </Notice>
      )}
    </Panel>
  );
}
