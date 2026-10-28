# External notifications

Settings → Notifications configures one Telegram destination per workspace. A new or restored workspace has delivery disabled. The application never derives a destination from dashboard or SOLARMAN email addresses.

## Connect and verify

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

Bot tokens use authenticated encryption bound to the workspace and channel identity. Fixed error codes replace provider response text and token-bearing URLs in the interface and logs. The workspace archive includes channel metadata, message contents, delivery attempts and configuration history, without tokens or ciphertext. Retention removes terminal delivery history in bounded batches and preserves pending messages and their referenced incidents.

Workspace closure disables the channel, cancels pending work and drains in-flight transport before erasure can be authorized. Authorized erasure removes the encrypted token before bounded history deletion. Restores quarantine every channel, cancel pending messages, record interrupted attempts as unconfirmed, and require a fresh save/test/enable sequence. Recovery drills seed enabled and in-flight canaries and prove quarantine, archive coverage and zero external-delivery calls before accepting a restore.

## Remaining operational acceptance

No production recipient has been selected or messaged. The owner must choose a bot/chat, confirm the test and enable it before real delivery can be accepted. An independent reachability and `/healthz` checker must also run outside the application host and prove outage/recovery delivery. The application cannot report its own stopped process or unreachable host through this worker. Keep this dependency open until a separate monitoring location and destination are configured and tested.
