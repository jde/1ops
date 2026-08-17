import { getBootedSimulators } from "@/lib/simulators";

export const dynamic = "force-dynamic"; // booted state changes as you boot/quit sims

/**
 * GET /api/simulators — which simulators/emulators are booted right now.
 * The mobile card polls this and lights its declared devices that are up.
 * Read-only; runs on the same host as the simulators (the Mac).
 */
export async function GET() {
  const report = await getBootedSimulators();
  return Response.json(report);
}
