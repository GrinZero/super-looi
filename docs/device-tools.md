# Device Tool Registration

LOOI now exposes mobile-device and robot-body capabilities to the server-side LLM tool loop through `/api/device-tools`.

## Flow

1. The app bootstraps built-in tools and posts their JSON schemas to `/api/device-tools/register`.
2. Server-side LLM calls see these registered tools alongside built-in server tools.
3. When the LLM calls a device tool, the server enqueues the call for the registered device.
4. The app polls `/api/device-tools/poll`, executes the local capability, and posts the result to `/api/device-tools/result`.

## Built-in client tools

- `device_take_photo`: returns the latest buffered camera frame.
- `device_record_audio`: schema and queue wiring are ready; the native executor is intentionally still a placeholder.
- `device_record_video`: schema and queue wiring are ready; the `CameraView.recordAsync` executor is intentionally still a placeholder.
- `device_get_orientation`: schema is registered; native orientation/motion detection can be wired next.
- `looi_move`: wrapper for the Soopercharge LOOI SDK movement API.
- `looi_set_light`: wrapper for the local Soopercharge LOOI SDK light API.
- `looi_set_head`: wrapper for the local Soopercharge LOOI SDK head API.

The old Soopercharge SDK has been migrated into this monorepo as `packages/looi-sdk` and is consumed through the workspace dependency `@sourcebug/looi-sdk`. Native BLE transport binding remains outside Expo prebuild output and should be added through a config plugin/runtime module.
