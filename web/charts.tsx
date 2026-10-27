import { useState, type ReactNode } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Analytics } from "./types";
import { COLORS, when } from "./format";

export function PowerChartContent({
  data,
  timezone = "Europe/Sofia",
}: {
  data: Analytics;
  timezone?: string;
}): ReactNode {
  const [visible, setVisible] = useState<Record<string, boolean>>({
    solar: true,
    house: true,
    grid: true,
    battery: true,
    soc: true,
  });
  const chart = data.points.map((p) => ({
    ...p,
    solar: p.pvW === null ? null : p.pvW / 1000,
    house: p.loadW === null ? null : p.loadW / 1000,
    grid: p.gridW === null ? null : p.gridW / 1000,
    battery: p.batteryW === null ? null : p.batteryW / 1000,
  }));
  const labels: Record<string, string> = {
    solar: "Solar",
    house: "House",
    grid: "Grid",
    battery: "Battery",
    soc: "Battery SOC",
  };
  const time = (at: number): string =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
  return (
    <>
      <div className="chart-legend">
        {Object.keys(visible).map((key) => (
          <button
            key={key}
            className={!visible[key] ? "muted" : ""}
            aria-pressed={visible[key]}
            onClick={() => setVisible((old) => ({ ...old, [key]: !old[key] }))}
          >
            <i style={{ background: COLORS[key as keyof typeof COLORS] }} />
            {labels[key]}
          </button>
        ))}
      </div>
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chart}
            margin={{ top: 15, right: 6, left: 0, bottom: 5 }}
            accessibilityLayer
          >
            <CartesianGrid
              vertical={false}
              stroke="#28343c"
              strokeDasharray="3 6"
            />
            <XAxis
              dataKey="at"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={time}
              tick={{ fill: "#83929c", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={60}
            />
            <YAxis
              yAxisId="power"
              tick={{ fill: "#83929c", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={43}
              unit=" kW"
            />
            <YAxis
              yAxisId="soc"
              orientation="right"
              domain={[0, 100]}
              unit="%"
              tick={{ fill: "#83929c", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={40}
              hide={!visible.soc}
            />
            <Tooltip
              contentStyle={{
                background: "#19232a",
                border: "1px solid #34434c",
                borderRadius: 10,
                fontSize: 12,
              }}
              labelFormatter={(label) => when(Number(label), timezone)}
              formatter={(value, name) => [
                typeof value === "number"
                  ? `${value.toFixed(2)}${name === "Battery SOC" ? "%" : " kW"}`
                  : "—",
                name,
              ]}
            />
            {visible.solar && (
              <Area
                yAxisId="power"
                type="linear"
                dataKey="solar"
                name="Solar"
                stroke={COLORS.solar}
                fill={COLORS.solar}
                fillOpacity={0.07}
                strokeWidth={2}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            {(["house", "grid", "battery"] as const)
              .filter((key) => visible[key])
              .map((key) => (
                <Line
                  key={key}
                  yAxisId="power"
                  type="linear"
                  dataKey={key}
                  name={labels[key]}
                  stroke={COLORS[key]}
                  dot={false}
                  strokeWidth={1.8}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            {visible.soc && (
              <Line
                yAxisId="soc"
                type="linear"
                dataKey="soc"
                name="Battery SOC"
                stroke={COLORS.soc}
                strokeDasharray="4 4"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-caption">
        Grid: positive imports, negative exports. Battery: positive supplies
        your home, negative charges. Times in {timezone}.
      </p>
    </>
  );
}

export function DailyChartContent({ data }: { data: Analytics }): ReactNode {
  return (
    <div className="daily-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data.daily}
          margin={{ top: 10, right: 10, left: 0, bottom: 5 }}
          accessibilityLayer
        >
          <CartesianGrid
            vertical={false}
            stroke="#28343c"
            strokeDasharray="3 6"
          />
          <XAxis
            dataKey="day"
            tickFormatter={(day: string) => day.slice(5)}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#83929c", fontSize: 11 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            unit=" kWh"
            tick={{ fill: "#83929c", fontSize: 11 }}
            width={58}
          />
          <Tooltip
            contentStyle={{
              background: "#19232a",
              border: "1px solid #34434c",
              borderRadius: 10,
            }}
            formatter={(value) => `${Number(value).toFixed(2)} kWh`}
          />
          <Bar
            dataKey="solarKwh"
            name="Solar"
            fill={COLORS.solar}
            radius={[3, 3, 0, 0]}
          />
          <Bar
            dataKey="loadKwh"
            name="House"
            fill={COLORS.house}
            radius={[3, 3, 0, 0]}
          />
          <Bar
            dataKey="importKwh"
            name="Grid import"
            fill={COLORS.grid}
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
