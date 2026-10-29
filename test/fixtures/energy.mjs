import { emptyEnergyProfile } from "../../src/energy-profile.mjs";
/** Synthetic installation used only by automated tests. */
export function energyProfile() {
  const profile = emptyEnergyProfile();
  profile.site = {
    latitude: 42.7,
    longitude: 23.3,
    inverterKw: 20,
    arrays: [
      {
        name: "Fixture roof",
        kwp: 10,
        tilt: 30,
        azimuth: 90,
        lossFraction: 0.14,
        geometryConfirmed: true,
      },
    ],
  };
  profile.battery.capacityKwh = 20;
  profile.battery.pvChargeKw = 5;
  profile.battery.dischargeKw = 5;
  profile.battery.powerConfirmed = true;
  profile.tariff.dayPrice = 0.11;
  profile.tariff.nightPrice = 0.055;
  profile.tariff.cyclingCost = 0.005;
  profile.planning.fallbackDailyKwh = 24;
  return profile;
}
export function energyWeather(now = Date.now()) {
  const slots = [];
  for (
    let at = Math.floor((now - 2 * 86400000) / 3600000) * 3600000;
    at < now + 5 * 86400000;
    at += 3600000
  )
    slots.push({
      start: at,
      end: at + 3600000,
      rawKw: 0,
      expectedKw: 0,
      lowKw: 0,
      highKw: 0,
      temperatureC: 10,
      cloudCover: 100,
    });
  return {
    provider: "fixture",
    sourceUrl: "https://example.test",
    attribution: "Synthetic test weather",
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3 * 3600000).toISOString(),
    slots,
    calibration: {
      scale: 1,
      lowScale: 0.75,
      highScale: 1.25,
      days: 0,
      source: "configured-scenarios",
    },
  };
}
