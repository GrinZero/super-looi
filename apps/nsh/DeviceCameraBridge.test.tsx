import { expect, test } from "nsh/test";
import { DeviceCameraHost } from "super-looi/native";
import { verifyEd25519Signature } from "./generated/looi-runtime.js";
import { DeviceCameraPreview } from "./ui/DeviceCameraPreview";

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

test("Pure RFC 8032 Ed25519 signature verifier executes natively inside QuickJS with __nsh_native/crypto", () => {
  // Official RFC 8032 Section 7.1 TEST 2 vector (message = 0x72)
  const pubKey = fromHex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
  const msg = fromHex("72");
  const sig = fromHex(
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
      "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  );
  expect(verifyEd25519Signature(msg, sig, pubKey)).toBe(true);

  const tamperedMsg = fromHex("73");
  expect(verifyEd25519Signature(tamperedMsg, sig, pubKey)).toBe(false);
});

test("Rust DeviceCameraHost streams downscaled Uint8Array JFIF frames across QuickJS FFI and tears down on background", async () => {
  const host = new DeviceCameraHost();
  try {
    host.setForeground(true);
    expect(host.permission()).toBe("unavailable");

    const sessionId = await host.openSample("front", 640, 25, "qjs-cam-session-1");
    expect(sessionId).toBe("qjs-cam-session-1");

    const statusJson = JSON.parse(host.status(sessionId)) as {
      sessionId: string;
      facing: string;
      width: number;
      height: number;
      closed: boolean;
    };
    expect(statusJson.sessionId).toBe("qjs-cam-session-1");
    expect(statusJson.facing).toBe("front");
    expect(statusJson.width).toBe(640);
    expect(statusJson.height).toBe(360);
    expect(statusJson.closed).toBe(false);

    const frame1 = await host.captureFrame(sessionId, 640, 0);
    expect(frame1.jpeg instanceof Uint8Array).toBe(true);
    expect(frame1.jpeg.byteLength > 100).toBe(true);
    expect(frame1.jpeg[0]).toBe(0xff);
    expect(frame1.jpeg[1]).toBe(0xd8);
    expect(frame1.jpeg[frame1.jpeg.byteLength - 2]).toBe(0xff);
    expect(frame1.jpeg[frame1.jpeg.byteLength - 1]).toBe(0xd9);
    expect(frame1.width).toBe(640);
    expect(frame1.height).toBe(360);
    expect(frame1.facing).toBe("front");

    // Reconfigure ceiling down to 320px and wait for next monotonic frame sequence
    host.reconfigureSession(sessionId, 320, 25);
    const frame2 = await host.captureFrame(sessionId, 640, frame1.seq);
    expect(frame2.seq > frame1.seq).toBe(true);
    expect(frame2.width).toBe(320);
    expect(frame2.height).toBe(184);

    // Preview TSX element constructs cleanly for landscape stage composition
    const states: Array<{ ready: boolean; facing?: "front" | "back"; error?: string }> = [];
    const previewEl = (
      <DeviceCameraPreview
        sessionId={sessionId}
        onState={(s) => states.push(s)}
        style={{ width: 240, height: 135 }}
      />
    );
    expect(Boolean(previewEl)).toBe(true);

    // Backgrounding immediately closes active sessions
    host.setForeground(false);
    let bgErr = "";
    try {
      await host.captureFrame(sessionId, 320, 0);
    } catch (error) {
      bgErr = String(error);
    }
    expect(bgErr.includes("ERR_DEVICE_CAMERA")).toBe(true);

    // Returning to foreground and reopening the SAME sessionId rebinds cleanly and advances frames
    host.setForeground(true);
    const reopenedId = await host.openSample("front", 640, 25, sessionId);
    expect(reopenedId).toBe(sessionId);

    const resumedFrame = await host.captureFrame(sessionId, 640, 0);
    expect(resumedFrame.facing).toBe("front");
    expect(resumedFrame.width).toBe(640);
    expect(resumedFrame.seq >= 1).toBe(true);

    const nextResumedFrame = await host.captureFrame(sessionId, 640, resumedFrame.seq);
    expect(nextResumedFrame.seq > resumedFrame.seq).toBe(true);

    const resumedStatus = JSON.parse(host.status(sessionId)) as {
      sessionId: string;
      facing: string;
      frames: number;
      closed: boolean;
    };
    expect(resumedStatus.sessionId).toBe(sessionId);
    expect(resumedStatus.facing).toBe("front");
    expect(resumedStatus.closed).toBe(false);
    expect(resumedStatus.frames >= nextResumedFrame.seq).toBe(true);
  } finally {
    host.stopAll();
    host.dispose();
  }
});
