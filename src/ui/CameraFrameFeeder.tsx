import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { cameraPerceiver } from "../perceivers/camera-perceiver";
import { isAndroidEmulator } from "../core/runtime-profile";

const CAPTURE_INTERVAL_MS = 3000;
const CAMERA_START_DELAY_MS = 1500;

export function CameraFrameFeeder() {
  const cameraRef = useRef<CameraView>(null);
  const readyRef = useRef(false);
  const [permission] = useCameraPermissions();
  const [canStartCamera, setCanStartCamera] = useState(false);
  const skipCamera = isAndroidEmulator();

  useEffect(() => {
    if (skipCamera) {
      console.log("[CameraFrameFeeder] Skipping camera preview on Android emulator");
      return;
    }

    const timer = setTimeout(() => setCanStartCamera(true), CAMERA_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [skipCamera]);

  useEffect(() => {
    if (skipCamera || !canStartCamera) return;
    if (!permission?.granted) return;

    let cancelled = false;
    cameraPerceiver.start().catch((error) => {
      console.warn("[CameraFrameFeeder] Failed to start camera perceiver:", error);
    });

    const captureFrame = async () => {
      if (cancelled || !readyRef.current || !cameraRef.current) return;

      try {
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.35,
          skipProcessing: true,
        });

        if (photo?.base64) {
          cameraPerceiver.addFrame(photo.base64);
        }
      } catch (error) {
        console.warn("[CameraFrameFeeder] Failed to capture camera frame:", error);
      }
    };

    captureFrame();
    const interval = setInterval(captureFrame, CAPTURE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      cameraPerceiver.stop().catch((error) => {
        console.warn("[CameraFrameFeeder] Failed to stop camera perceiver:", error);
      });
    };
  }, [canStartCamera, permission?.granted, skipCamera]);

  if (skipCamera || !canStartCamera || !permission?.granted) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.hiddenCamera}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="front"
        onCameraReady={() => {
          readyRef.current = true;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenCamera: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    overflow: "hidden",
  },
});
