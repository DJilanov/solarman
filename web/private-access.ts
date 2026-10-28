import { useEffect, useState } from "react";

export interface PrivateAccess {
  token: string;
  email: string;
  key: string;
  revision: number;
}

export function usePrivateAccess(): PrivateAccess {
  const read = (): Omit<PrivateAccess, "revision"> => {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    return {
      token: fragment.get("token") ?? url.searchParams.get("token") ?? "",
      email: fragment.get("email") ?? "",
      key: fragment.get("key") ?? "",
    };
  };
  const [access, setAccess] = useState<PrivateAccess>(() => ({
    ...read(),
    revision: 0,
  }));
  useEffect(() => {
    const path = window.location.pathname;
    const scrub = (): void =>
      window.history.replaceState(window.history.state, "", path);
    const capture = (): void => {
      if (window.location.pathname !== path) return;
      const next = read();
      if (!next.token && !next.key) return;
      setAccess((previous) => ({ ...next, revision: previous.revision + 1 }));
      scrub();
    };
    scrub();
    window.addEventListener("hashchange", capture);
    window.addEventListener("popstate", capture);
    return () => {
      window.removeEventListener("hashchange", capture);
      window.removeEventListener("popstate", capture);
    };
  }, []);
  return access;
}
