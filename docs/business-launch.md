# Customer launch acceptance

The launch objective covers commercial API capacity, administrator security, customer documents, a second-home onboarding flow and a defined offer/support process. This record separates implemented behavior from production acceptance and customer actions.

## Provider and commercial access

The owner supplied the following provider details on 2 November 2026:

- JILANOVI Ltd, company number 205509804, VAT BG205509804.
- Sofia, Bulgaria, kv. Levski G, bl. 4E, ap. 170.
- Representative: Nikolai Jilanov. Public service contact: sales@jilanov.com.

The owner confirmed an existing email conversation in which SOLARMAN accepted the intended commercial use. They will expand the API plan when customers arrive. No further vendor message is authorized or needed for this increment. The current 200,000-call allowance must remain unchanged until the purchased entitlement changes. At the audit, the existing controlled home projected 187,537 routine calls/year against a planning allowance of 188,000; a second controlled home did not fit. This is projected annual load, not calls already consumed.

The owner has no second installation available yet and requested preparation of the onboarding flow. Software acceptance must not be described as a second physical-home test.

## Acceptance requirements

| Area | Required result | Authoritative acceptance |
| --- | --- | --- |
| API capacity | Onboarding explains available monitoring/control capacity and the quota upgrade path; existing reservations and recovery capacity are preserved. | Current provider allowance, actual admission calculation, blocked-overcapacity regression and deployed administrator view. |
| Administrator access | Shared test password replaced; owner has a saved recovery key and verified passkey MFA. Password alone cannot open an enrolled account. | Actual owner setup, fresh login with a real authenticator, rejected password-only/replay/wrong-origin attempts, and session/recovery/restore tests. |
| Public documents | English and Bulgarian privacy, terms, provider/contact and service-offer pages describe the actual service and appear in public navigation. | Published HTML, correct provider identity, language/canonical links, complete disclosures and responsive/accessibility checks. |
| Customer onboarding | Invitation, secure activation, own SOLARMAN connection, installation selection, capacity/compatibility checks, preferences and monitoring-to-control handoff are usable. | End-to-end disposable-customer journey and explicit future physical commissioning for that customer's inverter. |
| Offer and support | Customer sees the service scope, price or quotation process, support contact/hours, cancellation and invoicing process before accepting paid service. | Owner-approved commercial offer and deployed service page; no fabricated prices, payments or commitments. |

## Approved offer and phone experience

Demos lead to an individual written quotation before paid service, with manual invoicing and no automatic paid conversion. Support is sales@jilanov.com, Monday–Friday 09:00–18:00 Sofia local time, first reply by the next business day. The provider identity is shared between both public languages and administration.

The landing page leads with installing the existing PWA on iPhone/Android and receiving useful notifications, rather than hiding that benefit in a small feature list. An interactive phone preview, explicitly illustrative alert, installation instructions and a phone FAQ are prerendered in both languages. Notification permission remains a deliberate action inside the authenticated app. Customer onboarding includes installation/notification setup and marks that step complete only after a device is enabled and verified. This is not an offline-control or immediate household-outage detection promise.

## Release evidence

Local validation on 2 November 2026 passed TypeScript/syntax checks, the build of eight public pages, 223 PostgreSQL integration cases and 287 unit tests; three unit cases require Linux and are skipped on this Mac. The browser suite covered 91 cases. Three older activation cases were updated for the required terms acceptance/onboarding destination and passed focused reruns. Public pages, phone layouts, installation instructions, real signed passkey assertions, password-only/replay/origin rejection, recovery re-enrollment, tenant isolation and one-use concurrent challenges are included.

The owner administrator had not changed the initial password or created a saved recovery key at the last production check before release. Those owner actions and a real device passkey enrollment/fresh MFA login remain required; a virtual browser authenticator proves software behavior, not owner enrollment or recovery-key custody. Production customer administration changes are blocked until that setup is complete. The administrator must save secrets privately, never in chat or support email.

The current home trial and native inverter policy are outside this change. Before release, energy settings revision 3 remained automatic with a 60-minute tariff buffer, and the existing plan e3c875e3-d077-48b7-8274-7ad9434afd88 remained scheduled for 2 November 21:00 UTC–3 November 03:00 UTC (23:00–05:00 Sofia). Deployment must preserve that exact configuration and the 8 November expiry/review timers.

Release operations stage a matching root-owned recovery capsule, prove an older backup upgrade with migrations 028/029 and pending-passkey quarantine, then use the existing PM2 deployment script. A fresh post-release backup and isolated restore are separate checks. The release SHA is exposed by the existing health endpoint and the operational restore reports retain their own nonsecret evidence. The second physical installation remains a future customer commissioning step because the owner explicitly requested preparation of its onboarding flow rather than a nonexistent hardware test.
