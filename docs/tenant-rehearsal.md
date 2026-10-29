# Connected tenant rehearsal

The integration suite now exercises one newly invited tenant continuously, from activation through removal, using actual application HTTP requests, browser-session cookies, PostgreSQL records and the SOLARMAN command broker. SOLARMAN REST responses, inverter registers and Telegram delivery are simulated. Custom-command callbacks make real loopback HTTP requests to the application and pass its correlation and Modbus validation.

The rehearsal is in the final test in [tenants.test.mjs](../test/integration/tenants.test.mjs), using [tenant-journey.mjs](../test/fixtures/tenant-journey.mjs). It does not insert a commissioning approval, directly enable control, or replace the controller, journal, request accounting or notification sender with success stubs.

## Coverage

| Stage | Evidence checked |
| --- | --- |
| Private invitation | Actual administrator invitation; one-use activation; member cookie; no administrator access; empty new workspace. |
| Provider setup | Member-owned credentials; App ID in the token URL; lowercase SHA-256 password in the body; plant/inverter discovery; selected device and timezone. |
| Monitoring and settings | Real runtime receives fixture telemetry; a correlated 530 read failure recovers once and nine native checks pass; all seven native attempts are accounted for; no writes during verification; another tenant cannot read the command. |
| Observation and commissioning | Fresh device-bound observation/run; current-password attendance; ordinary Resume rejected; incomplete physical evidence blocks approval. |
| Attended charging | Actual named commands, callbacks and journal records; temporary window/permission written and read back; Stop has a verified disable write. |
| Reserve transition | Diagnostic Refresh performs no write. The actual scheduler callback observes 50%, clears scheduled permission, completes the manual request and remains paused. |
| Solar and battery signs | Fixture charging above 50% and discharging above reserve display with the correct signs; full-resolution CSV retains the solar sample. This is software mapping evidence. |
| Activation rejection | An accepted queue entry reaches a failed terminal state without control activation or another inverter write. |
| Notifications | Actual encrypted destination settings and explicit test/enable sequence; provider-reported offline state becomes an incident; acknowledgment is scoped; recovery resolves it; the real Telegram sender confirms three simulated deliveries. |
| Suspension and resumption | Administrator changes with current revision; member monitoring remains available; verification/activation revoked; resumption preserves pause and requires verification again. |
| Retention and archive | Explicit retention opt-in; complete NDJSON archive with checksum; measurements, commands, writes, observations, commissioning and notification records included; credentials, session secrets and other tenant identifiers absent. |
| Closure and erasure | Closure revokes the old cookie; member can inspect closure before authorization; authorization revokes access; a matching test receipt permits bounded removal; tenant data removed while shared API usage becomes anonymous. |
| Isolation and final state | Administrator workspace stays active; callbacks accepted; discovery/telemetry/custom-command endpoints exercised; 100% overall / 50% grid / 50% reserve values preserved; scheduled permission off. |

## Running it

The existing integration setup explicitly connects to and verifies the database named `solarman_test`. It truncates that test database's fixture tables before and after the suite. Use the established test database credentials in the ignored local environment.

Focused rehearsal:

```sh
node --env-file-if-exists=.env --test \
  --test-name-pattern='invited tenant completes the connected home journey' \
  test/integration/tenants.test.mjs
```

Complete database suite:

```sh
npm run test:integration
```

Run database integration and browser suites sequentially because both own the same test database. Request pacing is shortened and the charging-window clock is fixed for this fixture; application authorization, budget reservations, command serialization, callback parsing and write readbacks remain active. Scheduled cycles are driven through the runtime's timer callback with its existing timer cancelled first.

The transport forwards only the application's loopback origin, rejects redirects, supplies fixture responses for the two provider origins and rejects other destinations. Tokens, provider passwords, App ID and device identity are test-only values. The erasure receipt is a private temporary fixture file with a simulated publisher acknowledgment, removed on completion. No real Telegram recipient or production erasure fence is created.

## What this does not certify

This is a connected software acceptance test. It does not prove the physical grid-charging limit during mixed sources, physical solar priority, native battery/BMS behavior, complete day/night operation, a live outside-host outage, actual Telegram delivery, licensed hosted-user allowance or a deployed browser journey for a new customer.

The exact firmware contract, attended hardware acceptance, chosen real destination, separate monitor host and operator handover remain required in [finish-plan.md](finish-plan.md). The existing browser suite covers EN/BG and phone states for the individual screens; this test adds the continuous backend journey without weakening those remaining requirements.

The separate [deployed customer audit](deployment-acceptance.md) records native Chrome onboarding, actual provider discovery, duplicate-device protection, translated pages and live closure/removal. A different customer's bound inverter and approved physical operation still require their own acceptance.
