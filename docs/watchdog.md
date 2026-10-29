# Independent outage monitoring

The watchdog checks the public dashboard from a separate Linux server. It needs Node 22+, systemd and util-linux `flock`. It has no database access, SOLARMAN credentials or inverter commands. A small, separately locked dependency set supplies the existing Web Push encryption library. The main application does not start it.

The owner selected `root@89.167.46.193` as the independent host and confirmed the dashboard's iPhone test on October 29. The service is installed and enabled there. The owner confirmed its separate iPhone test. Real stopped-application and isolated network-loss checks each produced an accepted outage/recovery pair; see [deployed acceptance](deployment-acceptance.md#independent-monitor-acceptance). The watchdog supports the selected iPhone subscription as well as Telegram. The main app's subscription alone does not monitor an offline server.

## Checks and durable evidence

Every minute, `/healthz` receives a new random 128-bit `probe`. A passing response must echo that exact probe, report a production release and show both worker heartbeats current. Responses are bounded to 4 KiB, have an eight-second deadline and cannot redirect. Cached successes without the current probe fail. Requests without a probe retain the original health response.

A parallel TCP check of the origin IP/port has a five-second deadline. It supplies context, without overriding a fresh public success: a firewall can accept Cloudflare traffic while refusing direct connections. Failure does not prove the whole machine is off; messages describe the observed connections.

Three consecutive failed public checks open an outage; two consecutive fresh successes confirm recovery. Gaps over 150 seconds reset the counters. Initial success does not send a recovery, and a known outage stays open until recovery is confirmed. Clock regression stops changes and delivery until corrected.

State and attempts live on the monitoring host. Each dispatch is saved and synced first. Interrupted or unsaved results stay unconfirmed. Retries keep one event reference and may duplicate a message already accepted by Telegram. There are at most four attempts within 24 hours, with ordinary delays of one, five and fifteen minutes. Valid provider rate-limit delays take precedence; delays beyond the deadline end delivery. Recovery cancels obsolete outage retries.

## Install separately

Copy `deploy/watchdog.example.json` to a private file outside Git, mode 0600. It is valid, monitors the home dashboard in Bulgarian and has `delivery: null`, so it cannot send messages. Select `en` or `bg`, a public HTTPS `/healthz` URL without credentials/query parameters and a literal origin IP. Plain HTTP is allowed only for loopback test fixtures.

For Telegram, replace `delivery: null` with an object containing the actual `botToken`, numeric `chatId` and `enabled: false`. No recipient is inferred from account emails. Installation uses root ownership, group access only for the dedicated service account and mode 0640. Never commit or log the configuration.

For the existing iPhone, run `scripts/export-watchdog.mjs <channel-id> <unused-absolute-private-path>` with the application's private environment. It requires a currently verified, enabled platform-administrator device and creates a mode-0600 configuration with delivery off. It copies only the selected subscription, its VAPID signing pair and a read-only permission token; database/provider credentials and the application encryption key are absent. Transfer it privately to the installer, then remove temporary export copies. The independent package lock installs only the Web Push library and its dependencies.

The monitor checks a fresh authenticated subscription permission every minute. The token is bound to channel/workspace/user/revision/endpoint; removal, reenrollment, closure or restore stops delivery. During a real application outage, the last allowed permission can be used for at most 24 hours. An answering application with an unavailable permission endpoint cannot authorize a send. A revoked or expired permission cancels pending work and removes approval; later permission success cannot silently restore it. A changed subscription requires a fresh export and test.

Export `WATCHDOG_SSH_TARGET` as the selected separate root SSH target and `WATCHDOG_CONFIG_FILE` as the absolute private path. `WATCHDOG_NODE_BINARY` optionally selects an absolute Node path; its default is `/usr/bin/node`.

```sh
bash scripts/install-watchdog.sh
```

Deploy the matching application health endpoint first. The watchdog installer requires a clean committed checkout, rejects development/loopback health URLs and the application origin or loopback monitoring destinations, stages a release, runs Linux tests and performs a live read-only health probe. Existing state is checked before stopping an earlier watchdog. Only its dedicated units change. Installation sends no delivery test. Failed prerequisites preserve the earlier running service; failures after switching require operator inspection. State is never rolled back, since doing so could resend an accepted message.

The timer uses [systemd monotonic scheduling](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) with one-second accuracy. The dedicated service has private state and restricted filesystem access. Mutating CLI commands use an [OS file lock](https://kernel.googlesource.com/pub/scm/utils/util-linux/util-linux/+/master/sys-utils/flock.1.adoc); exit 75 means another invocation holds it. [Control-group shutdown](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html) stops the child process and releases the lock.

## Test, enable and inspect

Run commands on the monitoring host as `solarman-watchdog`, using the installed Node binary and `/opt/solarman-watchdog/current/scripts/watchdog.mjs`:

| Command | Behavior |
| --- | --- |
| `probe` | Check HTTPS and TCP without changing state or sending messages. |
| `status` | Show health, verification, the last test reference and recent attempt metadata, without tokens or message text. |
| `run` | Record one sample/transitions and dispatch at most one due, permitted message. Used by the timer. |
| `test` | Create the first destination test or resume the same last test. Confirmed tests are not resent. |
| `new-test` | Explicitly request another test; pending work and a one-minute cooldown block it. |
| `confirm-test <reference>` | For Web Push only, record the operator's confirmation of the exact accepted test after it appears on the selected device. This sends no message. |
| `cancel-test` | Cancel future attempts of the last test, preserving history and uncertainty. |
| `quarantine` | Disable effective delivery and cancel restored pending work, without network requests. |

After `test`, inspect `status`. Telegram confirmation requires its message ID for the exact chat. Web Push initially records only `push_accepted`, never device display or automatic verification. After the operator confirms seeing the independent-monitor test, use `confirm-test <reference>` for that exact latest test; status records `push_operator_confirmed` separately from the transport attempt. Then set `delivery.enabled` to `true` in the private configuration. An existing outage is queued when verified delivery becomes enabled. Changing the target, token, chat, label or language invalidates verification and cancels pending work. Credential/destination rejection blocks incident delivery until a new confirmed test.

Set `delivery.enabled` to `false` to cancel pending regular delivery on the next invocation. Explicit tests can run while regular alerts are disabled; use `cancel-test` to cancel those. Stop the timer and service to drain transport before removal or an immediate stop. Accepted messages cannot be withdrawn. History retains uncertainty even after a later confirmed retry.

## Recovery and removal

State uses atomic replacement, file/directory sync, private permissions and strict version validation. Corruption is reported rather than silently reset. Retention keeps up to 100 terminal requests from the last 30 days, all pending requests and the last test. At most 100 requests can be pending; excess events retain a visible failed record.

Keep a separate encrypted operator backup of `/etc/solarman-watchdog/config.json` and `/var/lib/solarman-watchdog/state.json`; these are outside the main database backup. On restore, leave the timer stopped, run `quarantine`, set `delivery.enabled` to `false`, confirm a fresh test and explicitly enable delivery before restarting the timer. Quarantine records interrupted attempts as unconfirmed and blocks testing until configuration is disabled. Do not start directly from an old verified state.

For removal, disable/stop the timer and stop the service, then remove only the dedicated configuration, state, units, releases and account under the operator's retention policy. No application or inverter cleanup is performed.

## Remaining acceptance

Tests use local fixtures or injected senders. They cover a stopped application behind an answering proxy, a closed origin, injected network deadlines, cached responses, permissions, unsaved results, retries, destination changes, restore quarantine, Linux overlap and shutdown. These software fixtures are separate from the later live checks recorded in deployed acceptance.

The selected independent host is installed and its exact test was confirmed by the owner. The live checks proved a stopped app and controlled loss of reachability from the monitor while the push provider remained accessible, followed by recovery. Apple accepted all four incident messages; device display is a separate operator confirmation because the offline dashboard cannot acknowledge it. Keep verifying restart persistence and rejection of cached successes. The watchdog cannot report its own complete outage; that remains an operator monitoring responsibility.
