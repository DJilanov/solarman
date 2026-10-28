import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { tr } from "./i18n";
import { when } from "./format";
import type { WriteRecord, WriteSummary } from "./types";

export function WriteHistory({
  writes,
  timezone,
  linkToCommand = false,
  expandFirst = false,
}: {
  writes: (WriteSummary | WriteRecord)[];
  timezone: string;
  linkToCommand?: boolean;
  expandFirst?: boolean;
}): ReactNode {
  const location = useLocation();
  const operations: Record<WriteSummary["operation"], string> = {
    enable: "Enable scheduled charging",
    disable: "Disable scheduled charging",
    window: "Update charging window",
  };
  return (
    <ol className="write-history">
      {writes.map((write, index) => (
        <li key={write.id}>
          <details open={expandFirst && index === 0 ? true : undefined}>
            <summary>
              <strong>{tr(operations[write.operation])}</strong>
              <span>
                {tr(
                  write.status === "verified"
                    ? "Readback verified"
                    : write.inFlight
                      ? "Waiting for device confirmation"
                      : write.reconciledAt
                        ? "Cleanup confirmed; original write outcome unknown"
                        : write.status === "acknowledged"
                          ? "Acknowledged; readback unconfirmed"
                          : "Write outcome unknown",
                )}
              </span>
            </summary>
            <dl>
              {"device" in write && (
                <div>
                  <dt>{tr("Inverter")}</dt>
                  <dd>
                    <code>{write.device}</code>
                  </dd>
                </div>
              )}
              {"address" in write && (
                <>
                  <div>
                    <dt>{tr("Holding register address")}</dt>
                    <dd>
                      <code>{write.address}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("Requested register values")}</dt>
                    <dd>
                      <code>{write.registerValues.join(", ")}</code>
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>{tr("Intent recorded")}</dt>
                <dd>{when(write.createdAt, timezone, "medium")}</dd>
              </div>
              <div>
                <dt>{tr("Device acknowledgment")}</dt>
                <dd>
                  {write.acknowledgedAt
                    ? when(write.acknowledgedAt, timezone, "medium")
                    : tr("Not recorded")}
                </dd>
              </div>
              <div>
                <dt>{tr("Readback verified")}</dt>
                <dd>
                  {write.verifiedAt
                    ? when(write.verifiedAt, timezone, "medium")
                    : tr("Not recorded")}
                </dd>
              </div>
              {write.reconciledAt && (
                <div>
                  <dt>{tr("Cleanup confirmed")}</dt>
                  <dd>{when(write.reconciledAt, timezone, "medium")}</dd>
                </div>
              )}
            </dl>
            {linkToCommand && write.executionId && (
              <Link
                className="text-link"
                to={`/activity/${write.executionId}`}
                state={{
                  returnTo:
                    location.pathname === "/activity/writes"
                      ? location.pathname + location.search
                      : "/activity",
                }}
              >
                {tr("View command details")}
              </Link>
            )}
            {linkToCommand && !write.executionId && (
              <p className="fine-print">
                {tr("System recovery; no linked command record")}
              </p>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}
