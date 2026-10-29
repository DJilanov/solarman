import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { request } from "./api";
import { useWorkspace } from "./context";
import { tr } from "./i18n";
import { Notice } from "./components";
import type { EnergyData, EnergyProfile } from "./energy-types";

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = "any",
  optional = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  optional?: boolean;
}): ReactNode {
  return (
    <label className="energy-field">
      <span>{tr(label)}</span>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        required={!optional}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? null : Number(event.target.value),
          )
        }
      />
    </label>
  );
}
function timeValue(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function parseTime(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function EnergySettings({
  data,
  onSaved,
}: {
  data: EnergyData;
  onSaved: () => void;
}): ReactNode {
  const { session } = useWorkspace();
  const [profile, setProfile] = useState<EnergyProfile>(() =>
    structuredClone(data.profile),
  );
  const [savedRevision, setRevision] = useState(data.revision),
    [dirty, setDirty] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty && savedRevision !== data.revision) {
      setProfile(structuredClone(data.profile));
      setRevision(data.revision);
    }
  }, [data.profile, data.revision, dirty, savedRevision]);
  const edit = (operation: (value: EnergyProfile) => void): void => {
    setProfile((previous) => {
      const next = structuredClone(previous);
      operation(next);
      return next;
    });
    setDirty(true);
    setMessage(null);
  };
  const post = async (path: string, body: unknown): Promise<void> => {
    await request(`/energy/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
  };
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await post("settings", { revision: savedRevision, profile });
      setDirty(false);
      setMessage(
        "Energy settings saved. Refresh the forecast to calculate a new recommendation.",
      );
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save energy settings",
      );
    } finally {
      setPending(false);
    }
  };
  const hints = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const result = await request<{
        latitude: number | null;
        longitude: number | null;
        panelKwp: number | null;
      }>("/energy/hints", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: "{}",
      });
      edit((value) => {
        value.site.latitude = result.latitude;
        value.site.longitude = result.longitude;
        if (!value.site.arrays.length && result.panelKwp !== null)
          value.site.arrays.push({
            name: tr("Roof section"),
            kwp: result.panelKwp,
            tilt: 30,
            azimuth: 180,
            lossFraction: 0.14,
            geometryConfirmed: false,
          });
      });
      setMessage(
        "Registered SOLARMAN location imported. Check the roof direction and tilt before saving.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to import installation details",
      );
    } finally {
      setPending(false);
    }
  };
  const changed = dirty && savedRevision !== data.revision;
  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
      className="energy-settings"
    >
      {error && <Notice tone="danger">{tr(error)}</Notice>}
      {message && <Notice tone="success">{tr(message)}</Notice>}
      {changed && (
        <Notice tone="danger">
          {tr(
            "Settings changed in another session. Reload the saved values before editing again.",
          )}{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setDirty(false);
              setProfile(structuredClone(data.profile));
              setRevision(data.revision);
            }}
          >
            {tr("Reload saved values")}
          </button>
        </Notice>
      )}
      <fieldset disabled={pending}>
        <legend>{tr("Your installation")}</legend>
        <p className="fine-print">
          {tr(
            "These values improve estimates. They do not change the inverter’s physical limits.",
          )}
        </p>
        <button
          className="button secondary small"
          type="button"
          onClick={() => {
            void hints();
          }}
        >
          {tr("Import SOLARMAN location")}
        </button>
        <div className="energy-fields">
          <NumberField
            label="Latitude"
            value={profile.site.latitude}
            min={-90}
            max={90}
            onChange={(value) =>
              edit((next) => {
                next.site.latitude = value;
              })
            }
          />
          <NumberField
            label="Longitude"
            value={profile.site.longitude}
            min={-180}
            max={180}
            onChange={(value) =>
              edit((next) => {
                next.site.longitude = value;
              })
            }
          />
          <NumberField
            label="Inverter power · kW"
            value={profile.site.inverterKw}
            min={0.1}
            onChange={(value) =>
              edit((next) => {
                next.site.inverterKw = value;
              })
            }
          />
          <NumberField
            label="Battery capacity · kWh"
            value={profile.battery.capacityKwh}
            min={0.1}
            onChange={(value) =>
              edit((next) => {
                next.battery.capacityKwh = value;
              })
            }
          />
        </div>
        {profile.site.arrays.map((roof, index) => (
          <div className="energy-roof" key={index}>
            <label className="energy-field">
              <span>{tr("Roof section")}</span>
              <input
                required
                maxLength={80}
                value={roof.name}
                onChange={(event) =>
                  edit((next) => {
                    next.site.arrays[index].name = event.target.value;
                  })
                }
              />
            </label>
            <div className="energy-fields">
              <NumberField
                label="Panel capacity · kWp"
                value={roof.kwp}
                min={0.01}
                onChange={(value) =>
                  edit((next) => {
                    next.site.arrays[index].kwp = value ?? 0;
                  })
                }
              />
              <NumberField
                label="Direction · degrees from north"
                value={roof.azimuth}
                min={0}
                max={359}
                onChange={(value) =>
                  edit((next) => {
                    next.site.arrays[index].azimuth = value ?? 0;
                  })
                }
              />
              <NumberField
                label="Tilt · degrees"
                value={roof.tilt}
                min={0}
                max={90}
                onChange={(value) =>
                  edit((next) => {
                    next.site.arrays[index].tilt = value ?? 0;
                  })
                }
              />
              <NumberField
                label="System losses · %"
                value={Number((roof.lossFraction * 100).toFixed(3))}
                min={0}
                max={50}
                onChange={(value) =>
                  edit((next) => {
                    next.site.arrays[index].lossFraction = (value ?? 0) / 100;
                  })
                }
              />
            </div>
            <p className="fine-print">
              {tr("North 0° · East 90° · South 180° · West 270°")}
            </p>
            <label className="energy-check">
              <input
                type="checkbox"
                checked={roof.geometryConfirmed}
                onChange={(event) =>
                  edit((next) => {
                    next.site.arrays[index].geometryConfirmed =
                      event.target.checked;
                  })
                }
              />
              {tr("Direction and tilt are known")}
            </label>
            <button
              type="button"
              className="button secondary small"
              onClick={() =>
                edit((next) => {
                  next.site.arrays.splice(index, 1);
                })
              }
            >
              {tr("Remove roof section")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button secondary small"
          disabled={profile.site.arrays.length >= 8}
          onClick={() =>
            edit((next) => {
              next.site.arrays.push({
                name: `${tr("Roof section")} ${next.site.arrays.length + 1}`,
                kwp: 1,
                tilt: 30,
                azimuth: 180,
                lossFraction: 0.14,
                geometryConfirmed: false,
              });
            })
          }
        >
          {tr("Add roof section")}
        </button>
      </fieldset>
      <fieldset disabled={pending}>
        <legend>{tr("Electricity prices")}</legend>
        <p className="fine-print">
          {tr(
            "Use your full price per kWh, including applicable charges. Savings use these configured prices.",
          )}
        </p>
        <div className="energy-fields">
          <label className="energy-field">
            <span>{tr("Currency")}</span>
            <input
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              value={profile.tariff.currency}
              onChange={(event) =>
                edit((next) => {
                  next.tariff.currency = event.target.value.toUpperCase();
                })
              }
            />
          </label>
          <NumberField
            label="Day price / kWh"
            value={profile.tariff.dayPrice}
            min={0}
            onChange={(value) =>
              edit((next) => {
                next.tariff.dayPrice = value;
              })
            }
          />
          <NumberField
            label="Night price / kWh"
            value={profile.tariff.nightPrice}
            min={0}
            onChange={(value) =>
              edit((next) => {
                next.tariff.nightPrice = value;
              })
            }
          />
          <NumberField
            label="Export payment / kWh"
            value={profile.tariff.exportPrice}
            min={0}
            onChange={(value) =>
              edit((next) => {
                next.tariff.exportPrice = value ?? 0;
              })
            }
          />
          <NumberField
            label="Battery wear allowance / delivered kWh"
            optional
            value={profile.tariff.cyclingCost}
            min={0}
            onChange={(value) =>
              edit((next) => {
                next.tariff.cyclingCost = value;
              })
            }
          />
        </div>
        <p className="fine-print">
          {tr(
            "Export payment defaults to zero. An empty wear allowance excludes battery wear from the cost estimate.",
          )}
        </p>
        <details>
          <summary>{tr("Tariff hours and timezone")}</summary>
          <label className="energy-field">
            <span>{tr("IANA timezone")}</span>
            <input
              value={profile.timezone}
              required
              onChange={(event) =>
                edit((next) => {
                  next.timezone = event.target.value;
                })
              }
            />
          </label>
          {profile.tariff.windows.map((window, index) => (
            <div className="energy-fields energy-roof" key={index}>
              <label className="energy-field">
                <span>{tr("Months · comma-separated 1–12")}</span>
                <input
                  required
                  key={`${savedRevision}:${index}:${window.months.join(",")}`}
                  defaultValue={window.months.join(",")}
                  onBlur={(event) =>
                    edit((next) => {
                      next.tariff.windows[index].months = event.target.value
                        .split(",")
                        .map(Number);
                    })
                  }
                />
              </label>
              <label className="energy-field">
                <span>{tr("Cheap rate starts")}</span>
                <input
                  type="time"
                  step={900}
                  required
                  value={timeValue(window.startMinute)}
                  onChange={(event) =>
                    edit((next) => {
                      next.tariff.windows[index].startMinute = parseTime(
                        event.target.value,
                      );
                    })
                  }
                />
              </label>
              <label className="energy-field">
                <span>{tr("Cheap rate ends")}</span>
                <input
                  type="time"
                  step={900}
                  required
                  value={timeValue(window.endMinute)}
                  onChange={(event) =>
                    edit((next) => {
                      next.tariff.windows[index].endMinute = parseTime(
                        event.target.value,
                      );
                    })
                  }
                />
              </label>
              <button
                className="button secondary small"
                type="button"
                onClick={() =>
                  edit((next) => {
                    next.tariff.windows.splice(index, 1);
                  })
                }
              >
                {tr("Remove tariff period")}
              </button>
            </div>
          ))}
          <button
            className="button secondary small"
            type="button"
            disabled={profile.tariff.windows.length >= 12}
            onClick={() =>
              edit((next) => {
                next.tariff.windows.push({
                  months: [],
                  startMinute: 1380,
                  endMinute: 420,
                });
              })
            }
          >
            {tr("Add tariff period")}
          </button>
          <p className="fine-print">
            {tr(
              "The Bulgarian template changes on 1 April and 1 November, independently of daylight saving time.",
            )}
          </p>
        </details>
      </fieldset>
      <details>
        <summary>{tr("Battery and forecast assumptions")}</summary>
        <fieldset disabled={pending}>
          <legend>{tr("Planning assumptions")}</legend>
          <div className="energy-fields">
            <NumberField
              label="Operating reserve · %"
              value={profile.battery.reserveSoc}
              min={0}
              max={95}
              onChange={(value) =>
                edit((next) => {
                  next.battery.reserveSoc = value ?? 0;
                })
              }
            />
            <NumberField
              label="Backup protection floor · %"
              value={profile.battery.backupFloorSoc}
              min={0}
              max={profile.battery.reserveSoc}
              onChange={(value) =>
                edit((next) => {
                  next.battery.backupFloorSoc = value ?? 0;
                })
              }
            />
            <NumberField
              label="Maximum night target · %"
              value={profile.planning.maximumSoc}
              min={profile.battery.reserveSoc}
              max={100}
              step={1}
              onChange={(value) =>
                edit((next) => {
                  next.planning.maximumSoc = value ?? 0;
                })
              }
            />
            <NumberField
              label="Grid charging · kW"
              value={profile.battery.gridChargeKw}
              min={0.1}
              onChange={(value) =>
                edit((next) => {
                  next.battery.gridChargeKw = value ?? 0;
                })
              }
            />
            <NumberField
              label="Solar battery charging · kW"
              value={profile.battery.pvChargeKw}
              min={0.1}
              onChange={(value) =>
                edit((next) => {
                  next.battery.pvChargeKw = value ?? 0;
                })
              }
            />
            <NumberField
              label="Battery discharge · kW"
              value={profile.battery.dischargeKw}
              min={0.1}
              onChange={(value) =>
                edit((next) => {
                  next.battery.dischargeKw = value ?? 0;
                })
              }
            />
            <NumberField
              label="Charge efficiency · %"
              value={Number(
                (profile.battery.chargeEfficiency * 100).toFixed(3),
              )}
              min={50}
              max={100}
              onChange={(value) =>
                edit((next) => {
                  next.battery.chargeEfficiency = (value ?? 0) / 100;
                })
              }
            />
            <NumberField
              label="Discharge efficiency · %"
              value={Number(
                (profile.battery.dischargeEfficiency * 100).toFixed(3),
              )}
              min={50}
              max={100}
              onChange={(value) =>
                edit((next) => {
                  next.battery.dischargeEfficiency = (value ?? 0) / 100;
                })
              }
            />
            <NumberField
              label="Initial solar range · ±%"
              value={profile.planning.solarMargin * 100}
              min={5}
              max={75}
              onChange={(value) =>
                edit((next) => {
                  next.planning.solarMargin = (value ?? 0) / 100;
                })
              }
            />
            <NumberField
              label="Household demand margin · %"
              value={profile.planning.loadMargin * 100}
              min={0}
              max={100}
              onChange={(value) =>
                edit((next) => {
                  next.planning.loadMargin = (value ?? 0) / 100;
                })
              }
            />
            <NumberField
              label="Daily household estimate · kWh"
              optional
              value={profile.planning.fallbackDailyKwh}
              min={0.1}
              onChange={(value) =>
                edit((next) => {
                  next.planning.fallbackDailyKwh = value;
                })
              }
            />
            <NumberField
              label="Essential backup load · W"
              optional
              value={profile.battery.essentialLoadW}
              min={50}
              onChange={(value) =>
                edit((next) => {
                  next.battery.essentialLoadW = value;
                })
              }
            />
            <NumberField
              label="Heating sensitivity · kW per °C"
              value={profile.planning.heatingKwPerDegree}
              min={0}
              onChange={(value) =>
                edit((next) => {
                  next.planning.heatingKwPerDegree = value ?? 0;
                })
              }
            />
            <NumberField
              label="Heating base temperature · °C"
              value={profile.planning.heatingBaseC}
              min={-20}
              max={35}
              onChange={(value) =>
                edit((next) => {
                  next.planning.heatingBaseC = value ?? 0;
                })
              }
            />
          </div>
          <label className="energy-check">
            <input
              type="checkbox"
              checked={profile.battery.powerConfirmed}
              onChange={(event) =>
                edit((next) => {
                  next.battery.powerConfirmed = event.target.checked;
                })
              }
            />
            {tr("Battery planning power values are confirmed")}
          </label>
          <p className="fine-print">
            {tr(
              "Unconfirmed battery power values are conservative planning assumptions. The inverter and BMS determine actual power. Heating adjustment needs observed temperatures or an explicit household estimate.",
            )}
          </p>
        </fieldset>
      </details>
      <details>
        <summary>{tr("Flexible household loads")}</summary>
        <fieldset disabled={pending}>
          <legend>{tr("Suggested solar times")}</legend>
          <p className="fine-print">
            {tr(
              "Recommendations only. No appliance is switched by this dashboard.",
            )}
          </p>
          {profile.loads.map((load, index) => (
            <div className="energy-fields energy-roof" key={index}>
              <label className="energy-field">
                <span>{tr("Appliance name")}</span>
                <input
                  required
                  maxLength={80}
                  value={load.name}
                  onChange={(event) =>
                    edit((next) => {
                      next.loads[index].name = event.target.value;
                    })
                  }
                />
              </label>
              <NumberField
                label="Appliance power · kW"
                value={load.powerKw}
                min={0.05}
                onChange={(value) =>
                  edit((next) => {
                    next.loads[index].powerKw = value ?? 0;
                  })
                }
              />
              <NumberField
                label="Duration · minutes"
                value={load.durationMinutes}
                min={15}
                max={480}
                step={15}
                onChange={(value) =>
                  edit((next) => {
                    next.loads[index].durationMinutes = value ?? 0;
                  })
                }
              />
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  edit((next) => {
                    next.loads.splice(index, 1);
                  })
                }
              >
                {tr("Remove appliance")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button secondary small"
            disabled={profile.loads.length >= 12}
            onClick={() =>
              edit((next) => {
                next.loads.push({
                  name: tr("Appliance"),
                  powerKw: 1,
                  durationMinutes: 60,
                });
              })
            }
          >
            {tr("Add appliance")}
          </button>
        </fieldset>
      </details>
      <p className="fine-print">
        {tr(
          "Saving settings pauses Automatic and cancels upcoming plans. Stop an active night plan first.",
        )}
      </p>
      <button
        className="button primary"
        disabled={
          pending ||
          changed ||
          !dirty ||
          (data.control.active && data.control.purpose === "night")
        }
      >
        {tr(pending ? "Saving…" : "Save installation settings")}
      </button>
    </form>
  );
}
