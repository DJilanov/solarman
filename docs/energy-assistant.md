# Energy assistant

Automations → **Energy assistant** (`/controls/energy-tools`) combines outage estimates, shared appliance schedules, daily briefings, energy observations, Away mode and a weekly report. It uses stored SOLARMAN readings and the existing weather integration. No home computer or SSH connection is needed for these features. The public [interactive demo](/demo/) uses fictional data. See [the assistant expansion](energy-next.md) for optional provider watches, occupancy behavior and verification evidence.

## Outage estimates

**Prepare for an outage → Plan an outage by hours** accepts a site-local start, duration and either recent household demand or an explicit essential-load wattage. It simulates conservative solar in chronological order, battery efficiency, the backup floor and configured power assumptions. It reports a target, charging time, missing forecast coverage, energy shortages and power shortages. Unconfirmed power assumptions are labelled; an estimate does not establish the inverter's physical output capability.

Choosing **Use this target in the charging controls** only moves the existing slider. The normal review/save and firmware commissioning requirements still apply. The calculator never writes inverter settings, changes the permanent reserve or starts charging.

## Appliance timing

Enter a name, power, running time and earliest start/deadline. The calculation reserves conservative solar for household demand and normal battery charging before estimating surplus available to an appliance. It compares that surplus with the configured import/export tariffs and chooses a start within the window. Fresh battery readings and forecast coverage are required.

Plans are advisory. Optional reminders ask the user to start the appliance manually; there is no relay, smart plug or appliance API integration. Mark completed or cancel a plan when appropriate. Existing tasks reserve their power from the shared solar surplus, so two plans cannot claim the same available solar. Replan future tasks explicitly, or opt into replanning when a new forecast arrives. Already-started or already-reminded tasks keep their times. Revision checks serialize concurrent changes, and obsolete reminders are cancelled. Installation/account changes invalidate timing and pending delivery.

## Daily briefings

Briefings are off by default for each workspace. Enable them with the current dashboard password and a verified notification channel. Default times are 07:15 and 19:00 in the installation timezone. The evening briefing refreshes the existing weather planner; it does not approve a plan or turn repeating night charging on. Morning results distinguish observed charging/target stop and confirmed restoration from unverified outcomes. Missing next-day forecasts remain unavailable.

Each morning/evening receipt is created once per local date. A delayed scheduler catches up within one hour; queued briefings expire after two hours. Appliance reminders expire after at most 15 minutes, and missed starts older than 15 minutes are not sent. Missing fresh readings or forecasts can retry during that window. These are convenience notifications, not guaranteed outage warnings. The existing delivery history distinguishes processing, provider acceptance and confirmed browser display. Push lock-screen content remains generic; opening it leads to the authenticated energy assistant.

## Reports and learning

The weekly report covers the last seven complete local days, including daylight-saving changes. Coverage and missing periods stay visible. Grid cost uses configured tariffs for recorded periods. Savings are a modelled comparison for completed, sufficiently measured plans, with battery wear included only when a cycling cost is configured. CSV export follows the selected dashboard language.

Forecast learning excludes incomplete days, hindsight and suspected curtailed production. Separate hourly adjustments become available after seven qualifying observations for that local hour. A continuous discharge spanning at least 20 percentage points can provide an observed full-capacity estimate; it never changes configured capacity or native limits automatically. Until enough history exists, the dashboard shows learning or unavailable values.

## Data and operations

Migrations `025_energy_experience.sql` and `031_energy_assistant.sql` store workspace preferences, appliance plans, briefing receipts, Away periods, insight evidence and optional provider watches/notices. They are included in workspace archives and erasure; private supply-point references are encrypted and excluded from the archive. Retention removes old completed/expired tasks and advisory history according to the workspace policy, while Away history remains as long as the measurements it qualifies. Restore and rollback quarantine notifications, watches, automatic replanning and future Away adjustments before customer access; the isolated restore drill verifies this explicitly. Normal deployments preserve current inverter settings and the approved night policy.

## Optional local control

The SOLARMAN cloud API covers this release. It needs connectivity to SOLARMAN and cannot deliver new commands to an offline home. Independent server monitoring can still report that the cloud/dashboard is unavailable.

Offline control would require an always-on device on the inverter's home network, a supported local interface and verified firmware-specific reads/writes. A remote server SSH login alone does not provide those. No local gateway is installed or enabled by this release. A future gateway should first verify read-only LAN access and compare its measurements with SOLARMAN before any physical control is commissioned.
