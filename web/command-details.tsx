import type { ReactNode } from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useData } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { formatNumber, verificationValue, when } from "./format";
import {
  commandLabel,
  Heading,
  Loading,
  Notice,
  Panel,
  StatusBadge,
} from "./components";
import { WriteHistory } from "./write-history";
import type { CommandDetails, WriteHistoryData } from "./types";

function WritePagination({
  data,
  onOffset,
}: {
  data: WriteHistoryData;
  onOffset: (offset: number) => void;
}): ReactNode {
  if (!data.offset && !data.hasMoreWrites) return null;
  return (
    <div className="pagination">
      <span>
        {data.writes.length > 0 &&
          tr("Write records {{from}}–{{to}}", {
            from: formatNumber(data.offset + 1),
            to: formatNumber(data.offset + data.writes.length),
          })}
      </span>
      <div>
        <button
          className="button secondary small"
          disabled={!data.offset}
          onClick={() => onOffset(Math.max(0, data.offset - 25))}
        >
          <ChevronLeft size={15} />
          {tr("Previous")}
        </button>
        <button
          className="button secondary small"
          disabled={!data.hasMoreWrites}
          onClick={() => onOffset(data.offset + 25)}
        >
          {tr("Next")}
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

export function WriteHistoryPage(): ReactNode {
  const { session } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const offsetText = params.get("offset") ?? "0";
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const { data, error, loading, reload } = useData<WriteHistoryData>(
    `/write-history?offset=${offset}`,
    5000,
  );
  return (
    <>
      <Heading
        eyebrow={tr("A RECORD YOU CAN TRUST")}
        title={tr("All inverter writes")}
        description={tr(
          "Includes recovery writes and previous inverter bindings in this workspace.",
        )}
        action={
          <button
            className="button secondary small"
            disabled={loading}
            onClick={reload}
          >
            <RefreshCw size={15} />
            {tr("Refresh record")}
          </button>
        }
      />
      <Link className="text-link command-back" to="/activity">
        <ArrowLeft size={15} />
        {tr("Back to activity")}
      </Link>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && loading && <Loading />}
      {data && (
        <Panel
          title={tr("Recovery and write history")}
          subtitle={tr(
            "Intent, device acknowledgment and readback are recorded separately",
          )}
          className="command-writes"
        >
          {data.writes.length ? (
            <WriteHistory
              writes={data.writes}
              timezone={session.tenant.timezone}
              linkToCommand
              expandFirst
            />
          ) : (
            <p className="command-empty">
              {tr(
                offset
                  ? "No write records on this page."
                  : "No inverter write intents have been recorded for this workspace.",
              )}
            </p>
          )}
          <WritePagination
            data={data}
            onOffset={(next) => setParams({ offset: String(next) })}
          />
        </Panel>
      )}
    </>
  );
}

export default function CommandDetailsPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const { session } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const offsetText = params.get("offset") ?? "0";
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const location = useLocation();
  const state: unknown = location.state;
  const returnCandidate =
    state &&
    typeof state === "object" &&
    "returnTo" in state &&
    typeof state.returnTo === "string"
      ? state.returnTo
      : "/activity";
  const returnTo = /^\/activity(?:\/writes)?(?:\?|$)/.test(returnCandidate)
    ? returnCandidate
    : "/activity";
  const { data, error, loading, reload } = useData<CommandDetails>(
    `/activity/${id ?? ""}?offset=${offset}`,
    5000,
  );
  const timezone = session.tenant.timezone;
  const decision = data?.evidence.decision;
  const verification = data?.evidence.verification;
  const readings = decision
    ? [
        { label: "Battery SOC", value: decision.soc, unit: "%" },
        { label: "Solar power", value: decision.pvW, unit: "W" },
        { label: "Home consumption", value: decision.loadW, unit: "W" },
        { label: "Grid power", value: decision.gridW, unit: "W" },
        { label: "Battery power", value: decision.batteryW, unit: "W" },
      ].flatMap(({ label, value, unit }) =>
        value === null ? [] : [{ label, value, unit }],
      )
    : [];
  const eventLabels: Record<
    CommandDetails["evidence"]["events"][number]["code"],
    string
  > = {
    native_policy_check: "Native policy check",
    manual_topup_expired: "Manual top-up request expired",
    ac_charge_changed: "Scheduled charging permission changed",
    write_acknowledgement_audit_recovered:
      "Device acknowledgment audit recovered",
    write_journal_unavailable: "Write journal was unavailable",
    firmware_verification_invalidated:
      "Firmware verification changed; workspace control was revoked",
  };
  const assessmentLabels = {
    native_audit: "Periodic or required native check",
    observed_policy_deviation: "Observed behavior needs a native check",
    topup_assessment: "Below-reserve top-up assessment",
  };
  return (
    <>
      <Heading
        eyebrow={tr("A RECORD YOU CAN TRUST")}
        title={tr("Command details")}
        description={
          data
            ? commandLabel(data.action)
            : tr("Recorded intent and device results")
        }
        action={
          <button
            className="button secondary small"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw size={15} /> {tr("Refresh record")}
          </button>
        }
      />
      <Link className="text-link command-back" to={returnTo}>
        <ArrowLeft size={15} />{" "}
        {tr(
          returnTo.startsWith("/activity/writes")
            ? "Back to write history"
            : "Back to activity",
        )}
      </Link>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Panel
            title={tr("Request and result")}
            action={<StatusBadge status={data.status} />}
            className="command-record"
          >
            <p className="command-result">
              {tr(
                data.message ??
                  "Waiting for the device response and verification.",
              )}
            </p>
            <dl className="command-facts">
              <div>
                <dt>{tr("Requested action")}</dt>
                <dd>{commandLabel(data.action)}</dd>
              </div>
              <div>
                <dt>{tr("Requested by")}</dt>
                <dd>
                  {data.actor === "Automation" ? tr("Automation") : data.actor}
                </dd>
              </div>
              <div>
                <dt>{tr("Created")}</dt>
                <dd>{when(data.created_at, timezone, "medium")}</dd>
              </div>
              <div>
                <dt>{tr("Completed")}</dt>
                <dd>
                  {data.completed_at
                    ? when(data.completed_at, timezone, "medium")
                    : tr("Not recorded")}
                </dd>
              </div>
              <div>
                <dt>{tr("Inverter")}</dt>
                <dd>
                  <code>{data.device ?? tr("Not recorded")}</code>
                </dd>
              </div>
              <div>
                <dt>{tr("Command ID")}</dt>
                <dd>
                  <code>{data.id}</code>
                </dd>
              </div>
            </dl>
            {!data.device && (
              <p className="fine-print">
                {tr("No inverter identity was recorded for this command.")}
              </p>
            )}
          </Panel>
          {decision && (
            <Panel
              title={tr("Recorded control decision")}
              className="command-record"
            >
              <p className="command-result">
                {tr(
                  decision.charge
                    ? "Scheduled top-up was eligible"
                    : "No scheduled top-up was requested",
                )}
              </p>
              <p className="fine-print">
                {tr(
                  "This records the assessment, not proof that a hardware change occurred.",
                )}
              </p>
              <dl className="command-facts">
                {decision.dryRun !== null && (
                  <div>
                    <dt>{tr("Hardware writes at assessment")}</dt>
                    <dd>{tr(decision.dryRun ? "Disabled" : "Enabled")}</dd>
                  </div>
                )}
                {decision.acEnabled !== null && (
                  <div>
                    <dt>{tr("Scheduled AC permission at assessment")}</dt>
                    <dd>{tr(decision.acEnabled ? "Enabled" : "Disabled")}</dd>
                  </div>
                )}
                {readings.map((reading) => (
                  <div key={reading.label}>
                    <dt>{tr(reading.label)}</dt>
                    <dd>
                      {formatNumber(reading.value)}{" "}
                      {reading.unit === "%" ? "%" : tr("W")}
                    </dd>
                  </div>
                ))}
              </dl>
              {readings.length > 0 && (
                <p className="fine-print">
                  {tr(
                    "Grid: positive imports, negative exports. Battery: positive supplies your home, negative charges. Times in",
                  )}{" "}
                  {timezone}.
                </p>
              )}
            </Panel>
          )}
          {verification && (
            <Panel
              title={tr("Recorded device verification")}
              className="command-record"
            >
              <p className="fine-print">
                {when(verification.checkedAt, timezone, "medium")}
              </p>
              {verification.firmware && (
                <p className="fine-print">
                  {tr(
                    "Recorded firmware: protocol {{protocol}}, DSP {{dsp}}, HMI {{hmi}}",
                    {
                      protocol:
                        verification.firmware.protocol ?? tr("Unavailable"),
                      dsp: verification.firmware.dsp ?? tr("Unavailable"),
                      hmi: verification.firmware.hmi ?? tr("Unavailable"),
                    },
                  )}
                </p>
              )}
              <div className="readiness-checks" role="list">
                {verification.checks.map((check) => (
                  <div
                    className={
                      check.passed
                        ? "readiness-check passed"
                        : "readiness-check attention"
                    }
                    role="listitem"
                    key={check.label}
                  >
                    {check.passed ? (
                      <Check size={17} aria-hidden="true" />
                    ) : (
                      <ShieldCheck size={17} aria-hidden="true" />
                    )}
                    <span>{tr(check.label)}</span>
                    <strong>{verificationValue(check, check.actual)}</strong>
                    <small>
                      {tr(
                        check.comparison === "at_most"
                          ? "Maximum {{value}}"
                          : "Expected {{value}}",
                        { value: verificationValue(check, check.expected) },
                      )}
                    </small>
                    <span className="sr-only">
                      {tr(check.passed ? "Verified" : "Needs attention")}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {data.evidence.events.length > 0 && (
            <Panel title={tr("Recorded control events")}>
              <ol className="command-events">
                {data.evidence.events.map((event, index) => (
                  <li key={`${index}-${event.code}`}>
                    <strong>{tr(eventLabels[event.code])}</strong>
                    {event.reason && (
                      <span>{tr(assessmentLabels[event.reason])}</span>
                    )}
                    {event.enabled !== null && (
                      <span>{tr(event.enabled ? "Enabled" : "Disabled")}</span>
                    )}
                  </li>
                ))}
              </ol>
            </Panel>
          )}
          <Panel
            title={tr("Inverter writes for this command")}
            subtitle={tr(
              "Intent, device acknowledgment and readback are recorded separately",
            )}
            className="command-writes"
          >
            <p className="fine-print">
              {tr(
                "An acknowledgment confirms receipt. Matching readback verifies the requested values. Cleanup does not verify an earlier uncertain write.",
              )}
            </p>
            {data.writes.length ? (
              <WriteHistory
                writes={data.writes}
                timezone={timezone}
                expandFirst
              />
            ) : (
              <p className="command-empty">
                {tr(
                  offset
                    ? "No write records on this page."
                    : "No inverter write intents were recorded for this command.",
                )}
              </p>
            )}
            <WritePagination
              data={data}
              onOffset={(next) =>
                setParams({ offset: String(next) }, { state: location.state })
              }
            />
          </Panel>
        </>
      )}
    </>
  );
}
