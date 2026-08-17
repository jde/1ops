/**
 * Which simulators / emulators are booted RIGHT NOW — the "is my mobile dev
 * environment up?" sensor. Read-only: `xcrun simctl list ... booted` and
 * `adb devices`. Never boots or kills anything (that's an explicit action).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface BootedDevice {
  platform: "ios" | "android";
  udid: string; // iOS sim UDID or android serial
  name?: string;
  state?: string;
}

export interface BootedReport {
  ios: BootedDevice[];
  android: BootedDevice[];
  iosOk: boolean; // could we even ask? (xcrun present)
  androidOk: boolean; // (adb present)
}

async function bootedIos(): Promise<{ devices: BootedDevice[]; ok: boolean }> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "booted", "--json"], {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
    const devices: BootedDevice[] = [];
    for (const list of Object.values(parsed.devices ?? {})) {
      for (const d of list) {
        if (d.state === "Booted") devices.push({ platform: "ios", udid: d.udid, name: d.name, state: d.state });
      }
    }
    return { devices, ok: true };
  } catch {
    return { devices: [], ok: false };
  }
}

async function bootedAndroid(): Promise<{ devices: BootedDevice[]; ok: boolean }> {
  try {
    const { stdout } = await exec("adb", ["devices"], { timeout: 5000 });
    const devices: BootedDevice[] = [];
    for (const line of stdout.split("\n").slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === "device") devices.push({ platform: "android", udid: serial, state });
    }
    return { devices, ok: true };
  } catch {
    return { devices: [], ok: false };
  }
}

export async function getBootedSimulators(): Promise<BootedReport> {
  const [ios, android] = await Promise.all([bootedIos(), bootedAndroid()]);
  return { ios: ios.devices, android: android.devices, iosOk: ios.ok, androidOk: android.ok };
}
