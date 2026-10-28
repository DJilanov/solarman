import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Panel, Notice } from "./components";
import { tr } from "./i18n";
import { when } from "./format";
import type { BackupStatus, BackupIssue } from "./types";

const issueMessages: Record<BackupIssue, string> = {
  backup_failed: "The latest backup failed.",
  restore_failed: "The latest recovery test failed.",
  backup_missing: "No verified offsite backup is recorded.",
  restore_missing: "No successful recovery test is recorded.",
  backup_overdue: "The verified backup is over 26 hours old.",
  restore_overdue: "The recovery test is over eight days old.",
  backup_stalled: "The backup has been running for over 35 minutes.",
  restore_stalled: "The recovery test has been running for over 35 minutes.",
};

export function BackupNotice({ status }: { status?: BackupStatus }): ReactNode {
  if (!status || ["healthy", "running"].includes(status.state)) return null;
  return (
    <Notice tone="danger">
      {tr("Backup and recovery need attention.")}{" "}
      <Link className="text-link" to="/settings/health">
        {tr("Review recovery status")}
      </Link>
    </Notice>
  );
}

export function BackupHealth({
  status,
  timezone,
}: {
  status: BackupStatus;
  timezone: string;
}): ReactNode {
  const date = (value?: string | null): string =>
    value ? when(value, timezone, "medium") : tr("Not recorded");
  const labels: Record<BackupStatus["state"], string> = {
    healthy: "Recovery checks passed",
    attention: "Recovery needs attention",
    running: "Recovery check in progress",
    "not-configured": "Backups are not configured",
    unavailable: "Recovery status is unavailable",
  };
  return (
    <Panel title={tr("Backup and recovery")} className="health-facts">
      <strong>{tr(labels[status.state])}</strong>
      {status.issues && status.issues.length > 0 && (
        <ul>
          {status.issues.map((issue) => (
            <li key={issue}>{tr(issueMessages[issue])}</li>
          ))}
        </ul>
      )}
      {["not-configured", "unavailable"].includes(status.state) ? (
        <p className="fine-print">
          {tr(
            "An administrator must check the backup job and its recovery records.",
          )}
        </p>
      ) : (
        <>
          <dl className="command-facts">
            <div>
              <dt>{tr("Last verified offsite backup")}</dt>
              <dd>{date(status.lastBackupAt)}</dd>
            </div>
            <div>
              <dt>{tr("Last successful recovery test")}</dt>
              <dd>{date(status.lastRestoreAt)}</dd>
            </div>
            <div>
              <dt>{tr("Latest backup attempt")}</dt>
              <dd>
                {date(status.backup?.completedAt ?? status.backup?.startedAt)}
              </dd>
            </div>
            <div>
              <dt>{tr("Latest recovery attempt")}</dt>
              <dd>
                {date(status.restore?.completedAt ?? status.restore?.startedAt)}
              </dd>
            </div>
          </dl>
          {status.restore?.state === "verified" && (
            <p className="fine-print">
              {tr(
                "Recovery verified database inventory, account decryption and sign-in, with restored controls disabled and no device access.",
              )}
            </p>
          )}
          <p className="fine-print">
            {tr(
              "Daily encrypted offsite backups. Current objects expire after 30 days; older versions expire 30 days after replacement. Recovery tests require the separately held recovery key.",
            )}
          </p>
        </>
      )}
    </Panel>
  );
}
