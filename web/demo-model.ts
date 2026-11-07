export type DemoScenario = "sunny" | "cloudy" | "outage";
export type DemoMode = "once" | "reserve";
export interface DemoSlot {
  hour: number; solarKw: number; loadKw: number; gridKw: number; batteryKw: number;
  soc: number; gridAvailable: boolean; unservedKwh: number; cost: number;
}
export interface DemoDay {
  slots: DemoSlot[]; solarKwh: number; loadKwh: number; gridKwh: number;
  cost: number; unservedKwh: number; reserveHours: number;
}

export function simulateDemo(scenario: DemoScenario, target: number, mode: DemoMode): DemoDay {
  const capacity = 20, initialSoc = 40, floor = 20, efficiency = 0.94;
  let energy = capacity * initialSoc / 100, chargedOnce = false;
  const slots: DemoSlot[] = [];
  const solar = [0, 0, 0, 0, 0, 0, 0.1, 0.5, 1.4, 2.6, 4.1, 5, 5.7, 5.4, 4.3, 3.1, 1.8, 0.8, 0.2, 0, 0, 0, 0, 0];
  const loads = [0.5, 0.4, 0.4, 0.4, 0.5, 0.6, 1, 1.6, 1.1, 0.8, 0.7, 1.1, 1.5, 0.9, 0.8, 0.9, 1.2, 1.7, 2.3, 2.1, 1.6, 1.2, 0.8, 0.6];
  const boundedTarget = Math.max(20, Math.min(100, target));
  for (let hour = 0; hour < 24; hour++) {
    const solarKw = solar[hour] * (scenario === "sunny" ? 1 : scenario === "cloudy" ? 0.26 : 0.16);
    const loadKw = loads[hour], gridAvailable = scenario !== "outage" || hour < 15 || hour >= 21;
    const direct = Math.min(loadKw, solarKw), deficit = loadKw - direct;
    const solarCharge = Math.min(solarKw - direct, (capacity - energy) / efficiency);
    energy += solarCharge * efficiency;
    if (energy >= capacity * boundedTarget / 100 - 0.001) chargedOnce = true;
    const charging = gridAvailable && (mode === "reserve" || (!chargedOnce && hour < 6));
    const gridCharge = charging ? Math.min(2, Math.max(0, capacity * boundedTarget / 100 - energy) / efficiency) : 0;
    energy += gridCharge * efficiency;
    if (energy >= capacity * boundedTarget / 100 - 0.001) chargedOnce = true;
    const usableFloor = gridAvailable ? (mode === "reserve" ? Math.max(floor, boundedTarget) : floor) : 10;
    const discharge = gridCharge > 0 ? 0 : Math.min(deficit, 5, Math.max(0, energy - capacity * usableFloor / 100) * efficiency);
    energy -= discharge / efficiency;
    const unservedKwh = gridAvailable ? 0 : Math.max(0, deficit - discharge);
    const gridKw = gridAvailable ? deficit - discharge + gridCharge - (solarKw - direct - solarCharge) : 0;
    const cost = Math.max(0, gridKw) * (hour < 7 || hour >= 23 ? 0.055 : 0.11);
    slots.push({ hour, solarKw, loadKw, gridKw, batteryKw: discharge - solarCharge - gridCharge, soc: Math.max(0, Math.min(100, energy / capacity * 100)), gridAvailable, unservedKwh, cost });
  }
  return { slots, solarKwh: slots.reduce((sum, slot) => sum + slot.solarKw, 0), loadKwh: slots.reduce((sum, slot) => sum + slot.loadKw, 0),
    gridKwh: slots.reduce((sum, slot) => sum + Math.max(0, slot.gridKw), 0), cost: slots.reduce((sum, slot) => sum + slot.cost, 0),
    unservedKwh: slots.reduce((sum, slot) => sum + slot.unservedKwh, 0), reserveHours: slots.filter(slot => slot.soc >= boundedTarget - 0.1).length };
}
