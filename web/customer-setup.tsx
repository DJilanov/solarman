import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, RefreshCw, ShieldCheck, Mail } from "lucide-react";
import { useData } from "./api";
import { useWorkspace } from "./context";
import { Heading, Notice, Loading, Panel } from "./components";
import { tr, publicHomePath } from "./i18n";
import { when } from "./format";
import type { SettingsData, BrowserPushSettingsData } from "./types";
import type { EnergyData } from "./energy-types";
import { business } from "./business";

export default function CustomerSetup(): ReactNode {
  const {
    session,
    overview,
    overviewError,
    overviewLoading,
    reload: reloadOverview,
  } = useWorkspace();
  const { data, loading, error, reload } = useData<SettingsData>(
    "/settings",
    30000,
  );
  const energy = useData<EnergyData>("/energy", 60000);
  const notifications = useData<BrowserPushSettingsData>("/notifications/push", 60000);
  const account = data?.account;
  const connected = Boolean(
    account?.validated_at && account.connection_status === "connected",
  );
  const selected = Boolean(connected && account?.device_sn);
  const reading = overview?.latest;
  const current = Boolean(
    selected &&
    reading &&
    Date.now() - Date.parse(reading.at) <= 600000 &&
    Date.parse(reading.at) <= Date.now() + 120000,
  );
  const supported = data?.profile === "bluesun-bse20kh3";
  const control = overview?.controller.control;
  const steps = [
    {
      id: "connection",
      title: "Connect your SOLARMAN account",
      complete: connected,
      optional: false,
      text: "Use your own provider account. Save the credentials privately, then test the connection to discover your installations.",
      href: "/settings",
      action: "Connect account",
    },
    {
      id: "installation",
      title: "Choose your installation",
      complete: selected,
      optional: false,
      text: "Select an inverter returned for your account and the matching timezone. Monitoring is the starting point; choosing a model does not enable control.",
      href: "/settings",
      action: "Choose inverter",
    },
    {
      id: "readings",
      title: "Check the first readings",
      complete: current,
      optional: false,
      text: "Confirm that solar, home use and battery readings belong to your installation. Cloud readings normally arrive about every five minutes.",
      href: "/dashboard",
      action: "Open monitoring",
    },
    {
      id: "planning",
      title: "Add your panels, battery and tariff",
      complete: Boolean(energy.data && !energy.data.missing.length),
      optional: true,
      text: "Enter real capacity, panel direction and electricity prices before using charging estimates. Forecast planning also needs commercial weather access for customer workspaces.",
      href: "/controls/night-savings",
      action: "Set planning preferences",
    },
    {
      id: "phone",
      title: "Install on your phone and enable alerts",
      complete: Boolean(notifications.data?.devices.some(device => device.enabled && device.verifiedAt && !device.quarantined && !device.blockedCode)),
      optional: true,
      text: "Add Solarman to your Home Screen on iPhone or Android, then enable device notifications and check the test arrives. You can choose energy briefings after your device is verified.",
      href: "/settings/notifications",
      action: "Set up phone notifications",
    },
    {
      id: "security",
      title: "Save your recovery access",
      complete: Boolean(session.security?.recoveryKeySaved),
      optional: true,
      text: "Save a recovery key and consider a passkey for two-step sign-in. Keep passwords and recovery material out of support emails.",
      href: "/settings/security",
      action: "Open account security",
    },
    {
      id: "control",
      title: "Review battery controls separately",
      complete: Boolean(control?.canStart),
      optional: true,
      text: "Controls require a supported model, available API capacity and commissioning for this inverter. Monitoring can continue while these requirements are resolved.",
      href: "/controls/setup",
      action: "Review control setup",
    },
  ];
  return (
    <>
      <Heading
        eyebrow={tr("WELCOME TO YOUR ENERGY WORKSPACE")}
        title={tr("Let’s set up your home.")}
        description={tr(
          "A few clear steps, using your own installation. No inverter setting changes happen from this checklist.",
        )}
        action={
          <button
            className="button secondary"
            disabled={loading || overviewLoading}
            onClick={() => {
              reload();
              reloadOverview();
              energy.reload();
              notifications.reload();
            }}
          >
            <RefreshCw size={16} />
            {tr("Refresh status")}
          </button>
        }
      />
      {(error || overviewError) && (
        <Notice tone="danger">{error ?? overviewError}</Notice>
      )}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Panel
            title={tr("Start with monitoring")}
            subtitle={tr("{{count}} of 3 connection steps complete", {
              count: steps.slice(0, 3).filter((step) => step.complete).length,
            })}
          >
            <p>
              {tr(
                "Your workspace is separate from other customers. Linking an account does not authorize battery commands or create a paid subscription.",
              )}
            </p>
            {selected && reading && (
              <p className="fine-print">
                {tr("Last installation reading")}:{" "}
                {when(reading.at, session.tenant.timezone, "medium")}
              </p>
            )}
            {selected && !current && (
              <Notice>
                {tr(
                  "Your inverter is selected. Wait for a fresh reading, then refresh this checklist. If readings remain unavailable, contact support with the model and the visible error.",
                )}
              </Notice>
            )}
          </Panel>
          <ol className="customer-setup-list">
            {steps.map((step, index) => (
              <li key={step.id}>
                <span
                  className={`customer-step-number ${step.complete ? "complete" : ""}`}
                  aria-label={step.complete ? tr("Complete") : undefined}
                >
                  {step.complete ? (
                    <Check size={20} aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <div className="customer-step-title">
                    <h2>{tr(step.title)}</h2>
                    {step.optional && <span>{tr("Optional next step")}</span>}
                  </div>
                  <p>{tr(step.text)}</p>
                  {step.id === "phone" && <Link className="text-link" to={`${publicHomePath()}#phone-app`}>{tr("Phone installation guide")}</Link>}
                  {step.id === "phone" && notifications.error && <Notice tone="danger">{notifications.error}</Notice>}
                  {step.id === "control" && !supported && (
                    <p className="fine-print">
                      {tr(
                        "The current verified control profile is Bluesun BSE20KH3. Ask us to review other models before expecting commands.",
                      )}
                    </p>
                  )}
                  {step.id === "planning" && energy.error && (
                    <Notice tone="danger">{energy.error}</Notice>
                  )}
                  {step.id === "planning" &&
                    energy.data &&
                    !energy.data.providerAvailable && (
                      <Notice>
                        {tr(
                          "Customer weather access is not configured yet. Your monitoring and existing inverter settings continue; support can enable forecasts when the commercial service is ready.",
                        )}
                      </Notice>
                    )}
                  <Link className="button secondary small" to={step.href}>
                    {tr(step.action)}
                    <ArrowRight size={15} aria-hidden="true" />
                  </Link>
                </div>
              </li>
            ))}
          </ol>
          <Panel
            title={tr("Need a hand?")}
            subtitle={tr("JILANOVI support · Monday–Friday, 09:00–18:00 Sofia")}
          >
            <p>
              {tr(
                "Email your inverter model and the visible setup message. We reply by the next business day. Never send passwords, API secrets or recovery keys.",
              )}
            </p>
            <a className="button secondary" href={`mailto:${business.email}`}>
              <Mail size={16} />
              {business.email}
            </a>
          </Panel>
          <div className="settings-actions">
            <Link className="button primary" to="/dashboard">
              <ShieldCheck size={16} />
              {tr("Open my workspace")}
            </Link>
          </div>
        </>
      )}
    </>
  );
}
