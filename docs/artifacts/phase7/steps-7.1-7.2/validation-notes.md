# Phase 7 Steps 7.1–7.2 validation

2026-11-04, Asia/Taipei. Commands ran against the current mobile working tree based on `6fcdec4e0977591b55e7815f80c4a4d1cbe91b5b`, including concurrent changes present at validation time.

## Required checks

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm --filter @super-looi/mobile typecheck` | exit 0 | [typecheck-final.log](typecheck-final.log) |
| `pnpm --filter @super-looi/mobile test` | exit 0; 61/61 tests, 16 suites, no failures | [test-final.log](test-final.log) |
| `pnpm --filter @super-looi/mobile build` | exit 0 | [build-final.log](build-final.log) |

The initial checks caught concurrent incomplete Cabin styles and a Metro resolver regression. The complete final rerun above passed after those issues were resolved. Initial root-directory logs are not the final verdict.

## Native observations

The existing iPhone 16e simulator ran the prebuilt RN 0.85.3 app without a native rebuild. Its old Metro process predated the `.js` to TypeScript resolver configuration, causing an initial module-resolution redbox. Restarting the same `expo start --port 8081` service via pnpm resolved it.

- [Verified first screen](ios-firstscreen.png): smooth cyan eyes and blue lower refraction; no concentric plastic rings; no white highlight band or neutral eyebrows. The smile is curved. Quiet presence/Lab entries and the blue-highlighted wake bar are visible. The final horizon has no hard oval edge.
- [Verified helmet avatar](ios-avatar-tasks.png): metallic visor, recessed black screen, side cyan lights, top sensor ornament, cyan eyes and smile. The left navigation shows the final cat-ear brand mark and actual Ionicons rather than fallback dots.
- QuickDrawer was opened through `打开快捷功能抽屉`. The wake bar disappeared, eyes became smaller and shifted upward, and four space cards rendered real icons and live text (`4 条记忆`, `1 项待批授权`, gateway status, verification status). This was observed in the CUA result, but the saved initial screenshot was invalidated by concurrent interaction/hot reload. It is not presented as a stable final screenshot. Utility actions were present in the accessibility tree, but their scrolling/clicking was not fully revalidated.
- Accessibility labels `打开快捷功能抽屉`, `打开仿真演练台`, and the wake-bar trigger were present on the native first screen.

## Coverage limits

Another session was interacting with iPhone 16e while this work ran. To avoid interfering, a separate iPhone 17 was started and the existing Debug `.app` was installed. First boot completed after 3m55s. The clean device had no saved JS bundle URL ([runtime setup screenshot](ios17-unconfigured-bundle-url.png)); this is a fresh-device debug setup issue, while the configured 16e successfully ran the current source.

At that point CUA failed with `Sky Computer Use native pipe closed before response`, including after one session reset/reconnect. No approval rejection occurred. No alternative input-injection mechanism was used. Therefore stable final QuickDrawer utility interactions, SimLab open-state wake hiding, and the speaking-demo subtitle were not completed in native UI. These remain code-reviewed behavior rather than fully exercised native paths.

The prebuilt app is landscape-locked, so rotating its simulator does not validate a portrait viewport. No portrait native pass is claimed; responsive formulas require a portrait-capable runtime or separate component harness for visual confirmation.

No native rebuild/prebuild edits, dependency installation, or environment-secret output was performed. Long-running boot/install/launch waits completed; no other session's processes were stopped. Metro remains available on port 8081.
