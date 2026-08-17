import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBootedSimulators } from "@/lib/simulators";

const exec = promisify(execFile);

export const dynamic = "force-dynamic";

/**
 * POST /api/open-deeplink  { url, udid? }
 *
 * Fires a deep link at running simulators/emulators — the mobile "quick login":
 *   iOS:     xcrun simctl openurl <udid> "<url>"
 *   Android: adb -s <serial> shell am start -a VIEW -d "<url>"
 *
 * Opens on the given udid, or on ALL currently-booted targets. The app must
 * handle the scheme (e.g. crewchamp://login?…) to actually pre-fill the form;
 * this just delivers the URL to the device. Runs on the same Mac as the sims.
 */
export async function POST(req: Request) {
  const { url, udid } = (await req.json().catch(() => ({}))) as { url?: string; udid?: string };
  if (!url || typeof url !== "string") {
    return Response.json({ ok: false, error: "missing url" }, { status: 400 });
  }
  // Only allow a custom scheme or http(s) — don't shell arbitrary args.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return Response.json({ ok: false, error: "url must be a scheme://… deep link" }, { status: 400 });
  }

  const booted = await getBootedSimulators();
  const results: { target: string; platform: string; ok: boolean; detail?: string }[] = [];

  const iosTargets = udid ? booted.ios.filter((d) => d.udid === udid) : booted.ios;
  for (const d of iosTargets) {
    try {
      await exec("xcrun", ["simctl", "openurl", d.udid, url], { timeout: 8000 });
      results.push({ target: d.name ?? d.udid, platform: "ios", ok: true });
    } catch (e) {
      results.push({ target: d.name ?? d.udid, platform: "ios", ok: false, detail: e instanceof Error ? e.message.split("\n")[0] : "failed" });
    }
  }

  const androidTargets = udid ? booted.android.filter((d) => d.udid === udid) : booted.android;
  for (const d of androidTargets) {
    try {
      await exec("adb", ["-s", d.udid, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { timeout: 8000 });
      results.push({ target: d.udid, platform: "android", ok: true });
    } catch (e) {
      results.push({ target: d.udid, platform: "android", ok: false, detail: e instanceof Error ? e.message.split("\n")[0] : "failed" });
    }
  }

  if (results.length === 0) {
    return Response.json({ ok: false, error: "no booted simulators/devices to open on" });
  }
  return Response.json({ ok: results.some((r) => r.ok), results });
}
