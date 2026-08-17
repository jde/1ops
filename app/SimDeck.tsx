"use client";

import { useEffect, useState } from "react";
import type { Device } from "@/lib/schema";

interface Booted {
  ios: { udid: string; name?: string }[];
  android: { udid: string; name?: string }[];
  iosOk: boolean;
  androidOk: boolean;
}

const POLL_MS = 5000;
const PLATFORM_GLYPH: Record<string, string> = { ios: "", android: "🤖" };

/**
 * The mobile "device deck": each declared simulator/device with a LIVE booted
 * light, polled from /api/simulators. Booted = green (your dev target is up),
 * offline = grey. Matched by UDID, falling back to name.
 */
export function SimDeck({ devices }: { devices: Device[] }) {
  const [booted, setBooted] = useState<Booted | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/simulators", { cache: "no-store" });
        const j = (await res.json()) as Booted;
        if (alive) setBooted(j);
      } catch {
        /* leave last state */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const isBooted = (d: Device): boolean => {
    if (!booted) return false;
    const pool = d.platform === "ios" ? booted.ios : booted.android;
    return pool.some(
      (b) => (d.udid && b.udid === d.udid) || (!!d.name && !!b.name && b.name === d.name)
    );
  };

  const bootedCount = devices.filter(isBooted).length;

  return (
    <div className="simdeck">
      <span className="simdeck-title">
        devices · <span className={bootedCount > 0 ? "sim-up" : "muted"}>{bootedCount}/{devices.length} booted</span>
      </span>
      <div className="sim-list">
        {devices.map((d, i) => {
          const up = isBooted(d);
          return (
            <span key={i} className={`sim ${up ? "sim-on" : "sim-off"}`} title={d.udid ?? d.name}>
              <span className="sim-dot" />
              <span className="sim-plat">{PLATFORM_GLYPH[d.platform] ?? d.platform}</span>
              <span className="sim-name">{d.name}</span>
              {d.dimension && <span className="sim-dim">{d.dimension}</span>}
              {d.kind === "device" && <span className="sim-phys">physical</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
