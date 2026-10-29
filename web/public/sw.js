/* Push only: authenticated pages, readings and commands are never cached or replayed. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json();
      } catch {
        payload = null;
      }
      const valid =
        payload &&
        typeof payload.title === "string" &&
        payload.title.length <= 200 &&
        typeof payload.body === "string" &&
        payload.body.length <= 1000;
      const url =
        payload?.url === "/settings/notifications"
          ? "/settings/notifications"
          : "/settings/health";
      const reference =
        typeof payload?.reference === "string" &&
        /^[a-f0-9-]{36}$/.test(payload.reference)
          ? payload.reference
          : "alert";
      await self.registration.showNotification(
        valid ? payload.title : "Solarman",
        {
          body: valid
            ? payload.body
            : "Open Solarman to review your notifications.",
          icon: "/icons/app-192.png",
          badge: "/icons/app-192.png",
          tag: "solarman-" + reference,
          data: { url },
        },
      );
      const receipt = payload?.receipt;
      if (
        !receipt ||
        !/^[a-f0-9-]{36}$/.test(receipt.id) ||
        !/^[a-f0-9-]{36}$/.test(receipt.attempt) ||
        !/^[a-f0-9]{64}$/.test(receipt.token)
      )
        return;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 8000);
      try {
        await fetch("/api/notifications/push/receipt", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: abort.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(receipt),
        });
      } catch {
        // Display is still useful offline; the server retains an unconfirmed receipt.
      } finally {
        clearTimeout(timeout);
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const path =
        event.notification.data?.url === "/settings/notifications"
          ? "/settings/notifications"
          : "/settings/health";
      const url = new URL(path, self.location.origin).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.navigate(url);
          await client.focus();
          return;
        } catch {
          /* Try another window. */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
