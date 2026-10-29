# External notifications

Settings → Notifications supports browser device subscriptions and an optional Telegram destination. A new or restored workspace has delivery disabled. The application never derives a destination from dashboard or SOLARMAN email addresses.

## iPhone and browser notifications

1. On iPhone, open the dashboard in Safari, use **Share → Add to Home Screen**, and leave **Open as Web App** enabled if that option appears. Web Push requires iOS 16.4 or later. Open the new Home Screen icon and sign in. [Apple documents these requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers); an Apple Developer membership is not required.
2. Open **Settings → Notifications**, name the device, enter the current dashboard password and tap **Enable device notifications**. The iPhone/browser permission request runs directly from this tap, never on page load. A denied permission needs to be changed in device settings.
3. The server queues a test. Push service acceptance is shown separately from display confirmation. After the service worker successfully displays it, a one-use encrypted receipt confirms that device and completes the requested activation. A missing receipt leaves activation pending. Use **Refresh device notifications** after an uncertain response; the browser does not silently repeat registration.
4. **Send device test** uses the existing subscription, with a one-minute cooldown. **Remove device subscription** disables that target, clears its encrypted credentials, cancels its pending deliveries and removes its local browser subscription when accessible. Removing one target does not abort another target's delivery.

Subscriptions belong to a user and workspace. At most ten non-revoked browser devices and 50 new registrations per workspace per 24 hours are admitted. Subscription endpoints and encryption keys are sealed with authenticated encryption bound to that workspace/channel. Status and archives exclude endpoints, subscription keys, server private keys and receipt tokens. The endpoint allowlist covers Apple's push service, Google FCM and Mozilla's production service; credentials, unusual ports, private hosts and other destinations are rejected. [Mozilla describes its opaque production endpoints](https://mozilla-services.github.io/autopush-rs/http.html).

The server uses `web-push` for the standard payload encryption and VAPID signatures, with a fixed ten-second absolute delivery deadline, five-minute service retention and no redirects. Configure `WEB_PUSH_PUBLIC_KEY` and `WEB_PUSH_PRIVATE_KEY` once in the private environment; keep the pair across restarts and back it up with the environment. The deployment configures these values without printing them. The public key alone is returned to signed-in clients. A changed application key or expired endpoint requires renewing the browser subscription.

Notifications use generic event text on the lock screen. Tapping opens the same-origin health or notification page, where normal sign-in protects private details and controls. The service worker caches no pages, readings or commands, and performs no inverter action or offline command replay. Its receipt authenticates with a one-use token inside the encrypted push and therefore works independently of dashboard session expiry; normal origin and abuse checks still apply. Receipt races, stale revisions, closure and restore cannot re-enable a revoked or quarantined target.

## Optional Telegram setup

1. Create a bot using Telegram's [official tutorial](https://core.telegram.org/bots/tutorial). Keep the token private. For a private conversation, contact the bot first; for a group, add it with permission to send messages.
2. Enter the bot token, numeric chat ID and English or Bulgarian message language. Enter the current **dashboard** password and save. An empty token field on a later save retains the encrypted token; the token is never returned to the browser.
3. Request **Send test**, then review its delivery history. A queued request is not confirmation. Confirmation requires a successful Telegram response containing a message ID for the exact configured chat.
4. Enable notifications after the test is confirmed. Enabling also queues currently active incidents; it does not send the old resolved backlog. Changing the token, destination or language disables delivery and requires a new test.

Tests require a unique request identifier and have a one-minute cooldown. Configuration and delivery controls require a valid session, CSRF protection, the current password and the displayed configuration revision. An uncertain response requires refreshing the saved status before another action. Disable cancels pending work and interrupts in-flight delivery; a message already accepted by Telegram cannot be withdrawn by cancelling the request.

The destination is a numeric chat ID, not an email or public username. The worker calls only Telegram's fixed HTTPS API host, sends plain text and disables link previews. It does not enable paid broadcast options. Telegram's [sendMessage API](https://core.telegram.org/bots/api#sendmessage) defines the destination and response contract.

## Incidents and delivery evidence

Incident opening, severity escalation and recovery are captured in the same database transaction as their outbox records. Repeated monitor passes and acknowledgments do not send the same incident revision again. Supported incidents include stale/offline readings, failed communication, explicit provider authentication rejection, control faults, unresolved cleanup and API capacity/allowance problems. Backup, restore, erasure-receipt and operational-monitor health changes go only to a configured workspace belonging to a platform administrator.

The worker runs every five seconds and records an attempt before sending. Each message has one stable event reference. History distinguishes queued, sending, retry scheduled, confirmed, failed, cancelled and unconfirmed outcomes, including every recorded attempt. A confirmed response after cancellation is recorded honestly, without verifying an obsolete destination configuration.

There are at most four attempts within 24 hours, with ordinary retry delays of 60, 300 and 900 seconds. A valid Telegram rate-limit delay takes precedence; a delay beyond the message deadline ends the request. Invalid credentials or a rejected destination disable the channel and cancel pending deliveries. A workspace can have at most 100 pending messages; further events retain a visible failed outbox record while their incident remains recorded.

A timeout, lost connection, restart or failure to save a result can leave delivery uncertain. Retrying may deliver a duplicate: Telegram does not provide an idempotency parameter for this method. History keeps the uncertainty warning even when a later attempt is confirmed, and every retry carries the same event reference. No delivery result is inferred from a successful HTTP request alone.

`/healthz` includes a generic notification-worker heartbeat and returns 503 when it is more than one minute overdue. This is separate from inverter telemetry freshness and operational-monitor health.

## Privacy, closure and recovery

Bot tokens and browser subscriptions use authenticated encryption bound to the workspace and channel identity. Fixed error codes replace provider response text and token-bearing URLs in the interface and logs. The workspace archive includes channel metadata, message contents, display timestamps, delivery attempts and configuration history, without tokens or ciphertext. Retention removes terminal delivery history in bounded batches and preserves pending messages and their referenced incidents.

Workspace closure disables all its channels, cancels pending work and drains in-flight transport before erasure can be authorized. Authorized erasure removes encrypted credentials before bounded history deletion. Restores quarantine every channel and pending activation, cancel pending messages, record interrupted attempts as unconfirmed, and require fresh opt-in and a displayed test for browser devices. Recovery drills seed enabled, pending and in-flight browser/Telegram canaries, reject their stale receipts, and prove quarantine, archive coverage and zero external-delivery calls before accepting a restore.

## Remaining operational acceptance

The owner selected iPhone Web Push. The owner must install/open the Home Screen app and grant the device's permission to complete real delivery acceptance; no permission is granted or message sent by deployment. Telegram setup is optional. The [independent watchdog](watchdog.md) implements reachability and fresh `/healthz` checks without depending on this app's database. It still needs a separate monitoring host and a selected destination with proven outage/recovery delivery. The application cannot report its own stopped process or unreachable host through its in-app worker; the iPhone subscription alone does not replace that independent checker.
