import { apiAppKey } from "./api-budget.mjs";
import { energyWeatherConfig } from "./energy-forecast.mjs";
import service from "./service-identity.json" with { type: "json" };

/** Read-only admission preview. This never reserves capacity or changes a provider plan.
 * @param {object} hub @param {object} session @returns {Promise<object>}
 */
export async function customerLaunchStatus(hub, session) {
  const appId = hub.env.SOLARMAN_APP_ID?.trim();
  let capacity = null;
  if (appId) {
    const current = await hub.budget.readCapacity(hub.pool, apiAppKey(appId));
    const admitted = current.members.filter(
      (member) => member.monitoring_admitted,
    );
    const monitoring = hub.budget.planCapacity([
      ...admitted,
      { control_enabled: false },
    ]);
    const control = hub.budget.planCapacity([
      ...admitted,
      { control_enabled: true },
    ]);
    capacity = {
      limit: hub.budget.policy.limit,
      recoveryReserve: hub.budget.policy.reserve,
      planningLimit: current.plan.planningLimit,
      currentAnnual: current.plan.reservedAnnual,
      monitoringHomes: admitted.length,
      controlledHomes: admitted.filter((member) => member.control_enabled)
        .length,
      nextMonitoring: {
        fits: monitoring.fits,
        annual: monitoring.reservedAnnual,
        intervalMs: monitoring.monitorMs,
      },
      nextControl: {
        fits: control.fits,
        annual: control.reservedAnnual,
        intervalMs: control.monitorMs,
      },
    };
  }
  const weather = energyWeatherConfig(hub.env);
  return {
    provider: {
      name: service.name,
      companyNumber: service.companyNumber,
      email: service.email,
      termsVersion: service.policyVersion,
    },
    administrator: {
      passwordChanged: Boolean(session.password_changed_at),
      recoveryKeySaved: Boolean(session.has_recovery_key),
      passkeyEnrolled: Boolean(session.has_passkeys),
      mfaVerified: Boolean(session.mfa_verified_at),
    },
    capacity,
    customerForecastsConfigured:
      weather.mode === "commercial" && Boolean(weather.apiKey),
    weatherMode: weather.mode,
  };
}
