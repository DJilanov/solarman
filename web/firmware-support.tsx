import { useState, type ReactNode } from "react";
import { Copy, Download, FileText } from "lucide-react";
import { Notice, Panel } from "./components";
import { tr } from "./i18n";
import type { ControllerStatus, FirmwareIdentity } from "./types";

interface FirmwareSupportProps {
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

function supportRequest(controller: ControllerStatus): string {
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
    tr("Firmware register clarification request"),
    `${tr("Selected model and profile")}: BSE20KH3 / bluesun-bse20kh3`,
    "",
    tr(
      "Requested behavior: solar supplies the home first and may charge the battery to 100%, at up to 5 kW. Grid top-up is available all day at up to 2 kW, stops at 50%, and does not prevent solar charging above 50%. The battery supplies the home down to a 50% on-grid reserve.",
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
      "These numbers are the application's interpretation of a saved diagnostic report, not fresh readbacks or a manufacturer-confirmed register contract.",
    ),
    ...settings,
    "",
    tr("Saved holding-register words"),
    tr(
      "These are individual 16-bit words from the saved diagnostic run. Their source-power units, scaling and enforcement still need confirmation; missing words are not inferred from interpreted settings.",
    ),
    ...words,
    "",
    tr(
      "Please provide the register table that applies to these exact protocol, DSP and HMI versions, including the following:",
    ),
    `1. ${tr("Confirm addresses, data types, byte order, units, scaling and allowed ranges for AC charging power/SOC (2504/2505), overall SOC (3005), maximum charging power (3022-3023) and on-grid reserve (3036).")}`,
    `2. ${tr("Explain whether the AC limit applies to the grid contribution or total battery charging during mixed solar/grid operation, including native reserve charging with scheduled AC permission off.")}`,
    `3. ${tr("Identify the supported setting for a 5 kW solar-to-battery charging cap. Explain whether it limits solar only or total battery charging, and whether it is enforced in SelfUse mode with a lithium BMS.")}`,
    `4. ${tr("Describe required operating modes, flags, readback checks and restoration of original values. Identify settings that require the inverter to stop before changing them.")}`,
    "",
    tr(
      "The independent power limits remain unverified. This request records requirements and saved evidence; it does not establish that either limit is enforced.",
    ),
    "",
  ].join("\n");
}

export function FirmwareSupport({ controller }: FirmwareSupportProps): ReactNode {
  const [outcome, setOutcome] = useState<{
    state: "copied" | "failed";
    contents: string;
  } | null>(null);
  const [copying, setCopying] = useState(false);
  if (!controller || controller.profile !== "bluesun-bse20kh3") return null;
  const contents = supportRequest(controller);
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
    anchor.download = "solarman-firmware-support.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(address), 1000);
  };
  return (
    <Panel
      title={tr("Resolve the firmware power-limit mapping")}
      action={<FileText size={22} />}
    >
      {!controller.policy.solarPowerCapVerified && (
        <Notice>
          {tr(
            "The firmware mapping for independent source limits is unverified. Approval stays blocked until the requested 2 kW grid and 5 kW solar limits are established.",
          )}
        </Notice>
      )}
      <p>
        {tr(
          "Prepare a request to share with your manufacturer or installer. It contains the selected model, observed versions and saved numeric settings. A settings check can provide newer evidence; preparing this request uses the existing report.",
        )}
      </p>
      <details>
        <summary>{tr("Review the firmware support request")}</summary>
        <pre
          className="firmware-support-preview"
          tabIndex={0}
          role="region"
          aria-label={tr("Support request preview")}
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
          {tr("Copy support request")}
        </button>
        <button className="button secondary" onClick={download}>
          <Download size={16} />
          {tr("Download support request")}
        </button>
      </div>
      {outcome?.contents === contents && (
        <Notice tone={outcome.state === "failed" ? "danger" : "success"}>
          {tr(
            outcome.state === "copied"
              ? "Support request copied"
              : "Clipboard access is unavailable. Download the support request instead.",
          )}
        </Notice>
      )}
    </Panel>
  );
}
