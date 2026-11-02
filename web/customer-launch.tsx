import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, ArrowRight } from "lucide-react";
import { useData } from "./api";
import { Panel, Notice, Loading } from "./components";
import { tr, publicHomePath } from "./i18n";
import { formatNumber } from "./format";

interface CustomerLaunchData {
  provider: {
    name: string;
    companyNumber: string;
    email: string;
    termsVersion: string;
  };
  administrator: {
    passwordChanged: boolean;
    recoveryKeySaved: boolean;
    passkeyEnrolled: boolean;
    mfaVerified: boolean;
  };
  capacity: {
    limit: number;
    recoveryReserve: number;
    planningLimit: number;
    currentAnnual: number;
    monitoringHomes: number;
    controlledHomes: number;
    nextMonitoring: { fits: boolean; annual: number; intervalMs: number };
    nextControl: { fits: boolean; annual: number; intervalMs: number };
  } | null;
  customerForecastsConfigured: boolean;
  weatherMode: "disabled" | "evaluation" | "commercial";
}

export function CustomerLaunch(): ReactNode {
  const { data, loading, error, reload } = useData<CustomerLaunchData>(
    "/admin/launch",
    60000,
  );
  const secure = Boolean(data?.administrator.passwordChanged && data.administrator.recoveryKeySaved && data.administrator.passkeyEnrolled && data.administrator.mfaVerified);
  return (
    <Panel
      title={tr("Before inviting a customer")}
      subtitle={tr(
        "Check the actual service capacity before promising control or forecasts.",
      )}
      action={
        <button
          className="button secondary small"
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={15} />
          {tr("Refresh status")}
        </button>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && loading && <Loading />}
      {data && (
        <>
          {!secure && (
            <Notice tone="danger">
              {tr(
                "Finish administrator security setup before onboarding customers",
              )}{" "}
              <Link className="text-link" to="/settings/security">
                {tr("Open account security")}
              </Link>
            </Notice>
          )}
          <p>
            {tr(
              "Commercial access is based on your agreement with SOLARMAN. A quota change becomes available only after the purchased allowance is configured; this page never upgrades or buys a plan.",
            )}
          </p>
          {data.capacity ? (
            <>
              <div className="launch-capacity-grid">
                <div>
                  <span>{tr("Projected routine calls per year")}</span>
                  <strong>
                    {formatNumber(data.capacity.currentAnnual)} /{" "}
                    {formatNumber(data.capacity.planningLimit)}
                  </strong>
                </div>
                <div>
                  <span>{tr("Additional controlled home")}</span>
                  <strong>
                    {tr(
                      data.capacity.nextControl.fits
                        ? "Capacity available"
                        : "API plan upgrade required",
                    )}
                  </strong>
                </div>
                <div>
                  <span>{tr("Additional monitoring home")}</span>
                  <strong>
                    {tr(
                      data.capacity.nextMonitoring.fits
                        ? "Capacity available"
                        : "API plan upgrade required",
                    )}
                  </strong>
                </div>
              </div>
              {data.capacity.nextMonitoring.fits && (
                <p className="fine-print">
                  {tr(
                    "Projected cloud reading interval with the next monitoring home: {{minutes}} minutes.",
                    {
                      minutes: formatNumber(
                        data.capacity.nextMonitoring.intervalMs / 60000,
                      ),
                    },
                  )}
                </p>
              )}
              {!data.capacity.nextControl.fits && (
                <Notice>
                  {tr(
                    "Expand the SOLARMAN allowance before promising another controlled installation. Existing recovery capacity stays reserved. A customer's own approved API credentials have separate accounting.",
                  )}
                </Notice>
              )}
            </>
          ) : (
            <Notice>
              {tr(
                "Shared API access is not configured. Arrange the licensed connection before customer setup.",
              )}
            </Notice>
          )}
          {!data.customerForecastsConfigured && (
            <Notice>
              {tr(
                data.weatherMode === "evaluation"
                  ? "Forecasts are currently limited to the owner's evaluation. Customer forecasts need the commercial Open-Meteo key; do not include them in a paid offer until configured."
                  : "Commercial weather access is not configured. Enable the licensed Open-Meteo connection before including forecasts in a paid offer.",
              )}
            </Notice>
          )}
          <ol className="launch-process">
            <li>
              {tr("Confirm the inverter model and review the demo together.")}
            </li>
            <li>
              {tr(
                "Agree the written quotation, included features and API access before paid service.",
              )}
            </li>
            <li>
              {tr(
                "Create a private invitation. The customer accepts the terms and enters their own provider credentials.",
              )}
            </li>
            <li>
              {tr(
                "Review monitoring first. Enable controls only after this installation passes commissioning.",
              )}
            </li>
          </ol>
          <div className="settings-actions">
            <Link
              className="button secondary small"
              to="/settings/getting-started"
            >
              {tr("Preview customer setup")}
              <ArrowRight size={15} />
            </Link>
            <a
              className="text-link"
              href={`${publicHomePath()}pricing/`}
              target="_blank"
              rel="noopener"
            >
              {tr("Services & support")}
            </a>
            <a
              className="text-link"
              href={`${publicHomePath()}privacy/`}
              target="_blank"
              rel="noopener"
            >
              {tr("Privacy")}
            </a>
          </div>
        </>
      )}
    </Panel>
  );
}
