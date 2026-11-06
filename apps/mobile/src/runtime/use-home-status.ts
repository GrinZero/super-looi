import { useEffect } from "react";
import { AppState } from "react-native";
import type { CabinSpaceController } from "../ui/cabin-space.js";
import type { HomeClient } from "./local-control-center.js";

/** Keep the shared HA badge honest even while the home page is closed. */
export function useHomeStatus(origin: string, cabin: CabinSpaceController, client?: HomeClient, revision?: number): void {
  useEffect(() => {
    let mounted = true;
    let request: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      if (request || AppState.currentState !== "active") return;
      request = new AbortController();
      timeout = setTimeout(() => request?.abort(), 12000);
      try {
        if (client) {
          const data = await client.getConnection();
          if (mounted) cabin.updateSubsystemStatus("homeAssistant", data.healthy ? "connected" : "disconnected", data.lastVerifiedAt ?? undefined);
          return;
        }
        const response = await fetch(`${origin.replace(/\/+$/, "")}/api/console/status`, { signal: request.signal });
        if (!response.ok) throw new Error("hub_unavailable");
        const data = await response.json() as { home: { healthy: boolean; lastVerifiedAt: string | null } };
        if (mounted) cabin.updateSubsystemStatus("homeAssistant", data.home.healthy ? "connected" : "disconnected", data.home.lastVerifiedAt ?? undefined);
      } catch { if (mounted) cabin.updateSubsystemStatus("homeAssistant", "disconnected"); }
      finally { if (timeout) clearTimeout(timeout); timeout = null; request = null; }
    }
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void poll(); else request?.abort(); });
    return () => { mounted = false; subscription.remove(); clearInterval(timer); if (timeout) clearTimeout(timeout); request?.abort(); };
  }, [origin, cabin, client, revision]);
}
