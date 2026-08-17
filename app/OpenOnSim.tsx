"use client";

import { useState } from "react";

/**
 * "open on sim" — fires a pre-filled deep link at the booted simulators so the
 * app lands on a filled-in login. The deep link is built server-side (creds
 * already substituted) and passed in, so this just POSTs it.
 */
export function OpenOnSim({ deepLink, label = "open on sim" }: { deepLink: string; label?: string }) {
  const [state, setState] = useState<"idle" | "opening" | "ok" | "err">("idle");
  const [detail, setDetail] = useState<string>("");

  const open = async () => {
    setState("opening");
    try {
      const res = await fetch("/api/open-deeplink", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: deepLink }),
      });
      const j = await res.json();
      if (j.ok) {
        const hit = (j.results ?? []).filter((r: { ok: boolean }) => r.ok).map((r: { target: string }) => r.target);
        setState("ok");
        setDetail(hit.length ? `→ ${hit.join(", ")}` : "");
      } else {
        setState("err");
        setDetail(j.error ?? (j.results ?? []).map((r: { detail?: string }) => r.detail).filter(Boolean)[0] ?? "failed");
      }
    } catch {
      setState("err");
      setDetail("request failed");
    }
  };

  return (
    <button className={`open-sim open-sim-${state}`} onClick={open} title={deepLink} type="button">
      {state === "opening" ? "opening…" : state === "ok" ? `opened ${detail}` : state === "err" ? `failed: ${detail}` : `📲 ${label}`}
    </button>
  );
}
