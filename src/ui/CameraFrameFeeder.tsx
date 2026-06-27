import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { cameraPerceiver } from "../perceivers/camera-perceiver";

const CAPTURE_INTERVAL_MS = 3000;

export function CameraFrameFeeder() {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain) {
      requestPermission().catch((error) => {
        console.warn("[CameraFrameFeeder] Camera permission request failed:", error);
      });
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    if (!permission?.granted || !ready) return;

    let cancelled = false;

    const captureFrame = async () => {
      if (cancelled || !cameraRef.current) return;

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
    };
  }, [permission?.granted, ready]);

  if (!permission?.granted) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.hiddenCamera}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        onCameraReady={() => setReady(true)}
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
