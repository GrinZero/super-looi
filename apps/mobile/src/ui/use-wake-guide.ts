import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";

const WAKE_GUIDE_DISMISSED_KEY = "super-looi.wake-guide-dismissed.v1";

async function readDismissal(): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(WAKE_GUIDE_DISMISSED_KEY);
  const file = new File(Paths.document, WAKE_GUIDE_DISMISSED_KEY);
  return file.exists ? file.text() : null;
}

async function saveDismissal(): Promise<void> {
  if (Platform.OS === "web") localStorage.setItem(WAKE_GUIDE_DISMISSED_KEY, "1");
  else new File(Paths.document, WAKE_GUIDE_DISMISSED_KEY).write("1");
}

/** Wait for local storage before showing onboarding, so returning users see no flash. */
export function useWakeGuide() {
  const [visible, setVisible] = useState(false);
  const dismissed = useRef(false);

  useEffect(() => {
    let active = true;
    void readDismissal().then((value) => {
      if (active && !dismissed.current) setVisible(value !== "1");
    }).catch(() => {
      // Unknown saved state should not resurface an already dismissed guide.
    });
    return () => { active = false; };
  }, []);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    setVisible(false);
    void saveDismissal().catch(() => {
      console.warn("Could not save wake guide dismissal");
    });
  }, []);

  return { visible, dismiss };
}
