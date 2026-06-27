const DEFAULT_SERVER_URL = "http://192.168.3.71:8080";

function getServerUrl(): string {
  return process.env.EXPO_PUBLIC_LOOI_SERVER_URL || DEFAULT_SERVER_URL;
}

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getServerUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function uploadEvidenceFrame(imageBase64: string): Promise<{ url: string; filename: string }> {
  return fetchJSON("/api/evidence/upload", {
    method: "POST",
    body: JSON.stringify({ imageBase64 }),
  });
}

export function createFrameWebSocket(): WebSocket {
  const wsUrl = getServerUrl().replace(/^http/, "ws");
  return new WebSocket(`${wsUrl}/ws/frames`);
}
