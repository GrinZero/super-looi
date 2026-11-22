import type { PluginManifest } from "../../runtime/plugins/shared-types.js";
import { PERSON_TRACKER_SERVICE_ID } from "./contracts.js";

export const visionPersonTrackerManifest: PluginManifest = {
  id: "vision-person-tracker",
  version: "1.1.0",
  minHostApiVersion: 2,
  builtinCore: true,
  category: "vision_motion",
  icon: "eye",
  name: {
    "zh-CN": "视觉座位追踪",
    "en-US": "Vision Person Tracker",
  },
  summary: {
    "zh-CN": "硬件 ISP 零体积人脸方位检测、主目标平滑滤波与内存态座位头像抓拍服务",
    "en-US": "Hardware ISP face tracking, EMA primary-target smoothing & in-memory seat portrait capture",
  },
  author: {
    name: "Super LOOI",
    verified: true,
  },
  permissions: ["camera.front", "sensor.motion", "face.control", "body.motion"],
  activation: "startup",
  provides: [
    {
      id: PERSON_TRACKER_SERVICE_ID,
      version: "1.0.0",
      summary: {
        "zh-CN": "前置摄像头实时人脸偏移量滤波与座位缩略图采样",
        "en-US": "Front-camera real-time face offset smoothing & seat portrait sampling",
      },
    },
  ],
};
