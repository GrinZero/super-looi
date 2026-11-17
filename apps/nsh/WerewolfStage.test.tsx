import { expect, open, test } from "nsh/test";
import { encodeQrMatrix } from "./plugins/werewolf-judge/ui/QrCodeCanvas";

function assertFinderPatternAt(
  matrix: boolean[][],
  topRow: number,
  leftCol: number,
): void {
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      const isOuterRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const isInnerCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const expected = isOuterRing || isInnerCore;
      expect(matrix[topRow + dr]![leftCol + dc]).toBe(expected);
    }
  }
}

test("encodeQrMatrix produces ISO/IEC 18004 compliant finder patterns, separators, timing tracks, and deterministic multi-version matrices", () => {
  const sampleUrls = [
    "http://127.0.0.1:43120",
    "http://192.168.31.88:52814",
    "http://172.20.10.1:49152/?room=werewolf&lang=zh-CN",
    "http://192.168.100.205:60123/companion?session=abcdef0123456789abcdef0123456789&mode=6p_joy&v=2",
  ];

  for (const url of sampleUrls) {
    const matrixA = encodeQrMatrix(url);
    const matrixB = encodeQrMatrix(url);
    expect(matrixA).toEqual(matrixB);

    const n = matrixA.length;
    expect(n >= 21 && n <= 41).toBe(true);
    expect((n - 21) % 4).toBe(0);
    for (const row of matrixA) {
      expect(row.length).toBe(n);
    }

    // Three 7x7 finder patterns
    assertFinderPatternAt(matrixA, 0, 0);
    assertFinderPatternAt(matrixA, 0, n - 7);
    assertFinderPatternAt(matrixA, n - 7, 0);

    // White separator ring around top-left finder
    for (let i = 0; i < 8; i += 1) {
      expect(matrixA[7]![i]).toBe(false);
      expect(matrixA[i]![7]).toBe(false);
    }

    // Alternating timing pattern along row 6 and col 6 between separators
    for (let idx = 8; idx < n - 8; idx += 1) {
      expect(matrixA[6]![idx]).toBe(idx % 2 === 0);
      expect(matrixA[idx]![6]).toBe(idx % 2 === 0);
    }

    // Always-dark module at (4 * version + 9, 8) = (n - 8, 8)
    expect(matrixA[n - 8]![8]).toBe(true);
  }

  // Empty string and UTF-8 multibyte URLs encode cleanly; >134 UTF-8 bytes throws structured error
  const emptyMatrix = encodeQrMatrix("");
  expect(emptyMatrix.length).toBe(21);
  assertFinderPatternAt(emptyMatrix, 0, 0);

  const utf8Matrix = encodeQrMatrix("http://192.168.1.8:8080/狼人杀房间");
  expect(utf8Matrix.length >= 25 && utf8Matrix.length <= 41).toBe(true);
  assertFinderPatternAt(utf8Matrix, 0, 0);

  const max134Matrix = encodeQrMatrix("x".repeat(134));
  expect(max134Matrix.length).toBe(41);

  let oversizeErr: unknown = null;
  try {
    encodeQrMatrix("x".repeat(135));
  } catch (error) {
    oversizeErr = error;
  }
  expect(Boolean(oversizeErr)).toBe(true);
  expect((oversizeErr as { code?: string }).code).toBe("ERR_QR_PAYLOAD_TOO_LONG");
});

async function runFullLandscapeMatch(variant: {
  colorScheme: "light" | "dark";
  reducedMotion: boolean;
}): Promise<void> {
  const app = await open("./WerewolfStageProbe.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: variant.colorScheme,
    reducedMotion: variant.reducedMotion,
  });

  try {
    await app.waitUntil(() => app.shows("id:connection-settings"), { timeout: 10000 });
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:exit-plugin-stage")).toBe(false);

    // 1. Navigate to Plugins management space & inspect vision-person-tracker
    await app.press("id:connection-settings");
    await app.waitFor("id:nav-plugins");
    await app.press("id:nav-plugins");
    await app.waitFor("id:plugin-vision-person-tracker");
    await app.waitFor("id:plugin-werewolf-judge");

    await app.press("id:plugin-vision-person-tracker");
    await app.waitFor("id:vision-person-tracker-settings");
    expect(app.shows("id:vision-stream-status")).toBe(true);
    expect(app.shows("id:vision-companion-follow")).toBe(true);
    expect(app.shows("id:vision-actuator-mode")).toBe(true);
    expect(app.shows("id:vision-tracking-status")).toBe(true);
    expect(app.shows("id:vision-capture-portrait")).toBe(true);
    await app.press("id:vision-toggle-calibration");
    await app.waitFor("id:vision-camera-preview");
    await app.press("id:vision-capture-portrait");
    await app.waitFor("id:vision-captured-portrait");
    await app.press("id:vision-companion-follow");
    await app.waitUntil(
      () => app.shows("id:vision-commanded-turn") && app.shows("id:vision-commanded-pitch"),
      { timeout: 3000 },
    );

    // Leaving settings with both companion follow & calibration active closes calibration while keeping companion streaming
    await app.press("id:plugin-back-to-list");
    await app.waitFor("id:plugin-vision-person-tracker");
    await app.press("id:plugin-vision-person-tracker");
    await app.waitFor("id:vision-person-tracker-settings");
    expect(app.shows("id:vision-camera-preview")).toBe(false);
    expect(app.shows("id:vision-error-banner")).toBe(false);
    expect(app.texts()).toContain("纯眼神跟随");

    await app.press("id:vision-companion-follow");
    await app.press("id:vision-alpha-025");
    await app.press("id:vision-alpha-045");
    await app.press("id:plugin-back-to-list");

    // 2. Open werewolf-judge settings, verify tap-to-enlarge QR modal in SettingsView, then launch onto MorphableStage ("登上首屏开局")
    await app.waitFor("id:plugin-werewolf-judge");
    await app.press("id:plugin-werewolf-judge");
    await app.waitFor("id:werewolf-settings-view");
    expect(app.shows("id:werewolf-settings-faction-summary")).toBe(true);

    await app.press("id:werewolf-settings-toggle-lan");
    await app.waitFor("id:werewolf-settings-qr");
    await app.waitUntil(
      () => app.texts().some((txt) => txt.includes("http://")),
      { timeout: 5000 },
    );
    expect(app.shows("id:werewolf-settings-qr-canvas")).toBe(true);
    await app.press("id:werewolf-settings-qr");
    await app.waitFor("id:werewolf-settings-qr-zoom-card");
    expect(app.shows("id:werewolf-settings-qr-zoom-canvas")).toBe(true);
    await app.press("id:werewolf-settings-qr-zoom-copy");
    await app.waitUntil(
      () => app.texts().includes("已复制链接"),
      { timeout: 3000 },
    );
    await app.press("id:werewolf-settings-qr-zoom-qr");
    await app.waitUntil(
      () => !app.shows("id:werewolf-settings-qr-zoom-card"),
      { timeout: 3000 },
    );
    await app.press("id:werewolf-settings-qr");
    await app.waitFor("id:werewolf-settings-qr-zoom-card");
    expect(app.texts().includes("已复制链接")).toBe(false);
    await app.press("id:werewolf-settings-qr-zoom-close");
    await app.waitUntil(
      () => !app.shows("id:werewolf-settings-qr-zoom-card"),
      { timeout: 3000 },
    );
    await app.press("id:werewolf-settings-toggle-lan");
    await app.waitUntil(() => !app.shows("id:werewolf-settings-qr"), {
      timeout: 3000,
    });

    await app.press("id:werewolf-launch-stage-btn");

    // Verify MorphableStage lobby mounted in landscape with persistent RobotFace
    await app.waitFor("id:werewolf-lobby-panel");
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:exit-plugin-stage")).toBe(true);
    // StageCapsule sits directly inside top bar alongside RobotFace without colliding with host controls
    expect(app.shows("id:werewolf-stage-capsule")).toBe(true);
    expect(app.shows("id:werewolf-capsule-phase")).toBe(true);

    // 3. Select 6p_joy, toggle LAN Companion QR on to verify native LanRoomHost + QrCodeCanvas + tap-to-enlarge modal, then switch back to on_device
    await app.press("id:werewolf-preset-6p_joy");
    await app.press("id:werewolf-surface-lan_companion");
    await app.waitFor("id:werewolf-qr-card");
    await app.waitUntil(
      () => app.texts().some((txt) => txt.includes("http://")),
      { timeout: 5000 },
    );
    expect(app.shows("id:werewolf-qr-canvas")).toBe(true);

    await app.press("id:werewolf-qr-card");
    await app.waitFor("id:werewolf-qr-card-zoom-card");
    expect(app.shows("id:werewolf-qr-card-zoom-canvas")).toBe(true);
    await app.press("id:werewolf-qr-card-zoom-close");
    await app.waitUntil(
      () => !app.shows("id:werewolf-qr-card-zoom-card"),
      { timeout: 3000 },
    );

    await app.press("id:werewolf-surface-on_device");
    await app.wait(120);

    // 4. Start Dealing & exercise Hold-to-Reveal privacy shield across seats 1..6
    await app.press("id:werewolf-start-dealing-btn");
    await app.waitFor("id:werewolf-dealing-panel");
    expect(app.shows("id:werewolf-stage-capsule")).toBe(true);
    expect(app.shows("id:werewolf-stage-companion")).toBe(true);

    const wolfSeats: number[] = [];
    let witchSeat = 0;
    let seerSeat = 0;
    const villagerSeats: number[] = [];

    for (let seat = 1; seat <= 6; seat += 1) {
      expect(app.shows("id:werewolf-deal-masked-card")).toBe(true);
      expect(app.shows("id:werewolf-deal-role-card")).toBe(false);
      if (seat === 1 && app.shows("id:werewolf-capture-portrait-btn")) {
        await app.press("id:werewolf-capture-portrait-btn");
        await app.wait(60);
      }

      // Hold-to-reveal: press & hold shield button, inspect role while held, then release (>=220ms) for 0ms instant mask!
      await app.dragAndHold("id:werewolf-deal-reveal-btn", { x: 0, y: 0 });
      await app.waitFor("id:werewolf-deal-role-card");

      const visibleTexts = app.texts();
      if (visibleTexts.includes("狼人")) {
        wolfSeats.push(seat);
      } else if (visibleTexts.includes("女巫")) {
        witchSeat = seat;
      } else if (visibleTexts.includes("预言家")) {
        seerSeat = seat;
      } else {
        villagerSeats.push(seat);
      }

      await app.wait(250);
      await app.drop();
      await app.waitFor("id:werewolf-deal-masked-card");
      expect(app.shows("id:werewolf-deal-role-card")).toBe(false);

      await app.press("id:werewolf-deal-confirm-btn");
      await app.wait(60);
    }

    expect(wolfSeats.length).toBe(2);
    expect(witchSeat > 0).toBe(true);
    expect(seerSeat > 0).toBe(true);
    expect(villagerSeats.length).toBe(2);

    // 5. Enter Night 1 -> Werewolf attack -> Witch poison Wolf #1 -> Seer check Wolf #2!
    await app.waitFor("id:werewolf-begin-night-btn");
    await app.press("id:werewolf-begin-night-btn");

    // Wait past night_intro (~1.2s) into night_wolf privacy gate
    await app.waitUntil(() => app.shows("id:werewolf-night-gate-btn"), { timeout: 6000 });
    await app.press("id:werewolf-night-gate-btn");
    await app.waitFor("id:werewolf-night-unlocked-panel");

    // Wolves bite Villager #1 (keeping Witch & Seer alive)
    const bittenVillager = villagerSeats[0]!;
    await app.press(`id:werewolf-night-seat-${bittenVillager}`);
    await app.press("id:werewolf-wolf-submit-btn");

    // Witch turn: unlock privacy shield & poison Wolf #1!
    await app.waitUntil(() => app.shows("id:werewolf-night-gate-btn"), { timeout: 5000 });
    await app.press("id:werewolf-night-gate-btn");
    await app.waitFor("id:werewolf-night-unlocked-panel");
    const poisonedWolf = wolfSeats[0]!;
    await app.press(`id:werewolf-night-seat-${poisonedWolf}`);
    await app.press("id:werewolf-witch-poison-btn");

    // Seer turn: unlock privacy shield, inspect Wolf #2 -> verify "查杀 · 狼人阵营"!
    await app.waitUntil(() => app.shows("id:werewolf-night-gate-btn"), { timeout: 5000 });
    await app.press("id:werewolf-night-gate-btn");
    await app.waitFor("id:werewolf-night-unlocked-panel");
    const remainingWolf = wolfSeats[1]!;
    await app.press(`id:werewolf-night-seat-${remainingWolf}`);
    await app.press("id:werewolf-seer-check-btn");
    await app.waitFor("id:werewolf-seer-result-card");
    expect(app.texts().some((t) => t.includes("狼人"))).toBe(true);
    await app.press("id:werewolf-finish-seer-btn");

    // 6. Dawn Night-1 last words resolution -> Day Discussion tabletop stage
    await app.waitUntil(
      () =>
        app.shows("id:werewolf-finish-last-words-btn") ||
        app.shows("id:werewolf-tabletop-stage"),
      { timeout: 5000 },
    );
    while (app.shows("id:werewolf-finish-last-words-btn")) {
      await app.press("id:werewolf-finish-last-words-btn");
      await app.wait(80);
    }

    await app.waitFor("id:werewolf-tabletop-stage");
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:werewolf-stage-capsule")).toBe(true);
    expect(app.shows("id:werewolf-stage-companion")).toBe(true);

    // Pause/resume speaker timer and advance one speaker
    await app.press("id:werewolf-pause-timer-btn");
    await app.press("id:werewolf-pause-timer-btn");
    await app.press("id:werewolf-next-speaker-btn");

    // Verify Host Exit ("退出舞台") pauses match & releases stage, and settings CTA resumes cleanly
    await app.press("id:exit-plugin-stage");
    await app.waitUntil(() => !app.shows("id:exit-plugin-stage"), { timeout: 3000 });
    expect(app.count("id:looi-face")).toBe(1);

    await app.press("id:connection-settings");
    await app.waitFor("id:nav-plugins");
    await app.press("id:nav-plugins");
    if (!app.shows("id:werewolf-launch-stage-btn")) {
      await app.press("id:plugin-werewolf-judge");
    }
    await app.waitFor("id:werewolf-launch-stage-btn");
    await app.press("id:werewolf-launch-stage-btn");
    await app.waitFor("id:werewolf-tabletop-stage");

    // 7. Exile vote: remaining good players vote out remainingWolf -> Good Camp Wins!
    await app.press("id:werewolf-start-voting-btn");
    await app.waitFor("id:werewolf-voting-panel");

    const survivingGoodVoters = [witchSeat, seerSeat, villagerSeats[1]!];
    for (const voter of survivingGoodVoters) {
      await app.press(`id:werewolf-voter-${voter}`);
      await app.press(`id:werewolf-vote-target-${remainingWolf}`);
      await app.wait(50);
    }
    await app.press(`id:werewolf-voter-${remainingWolf}`);
    await app.press("id:werewolf-vote-abstain");
    await app.press("id:werewolf-finalize-votes-btn");

    // 8. Game Over full-deck reveal + timeline tab + Play Again + Exit Stage
    await app.waitFor("id:werewolf-gameover-panel");
    expect(app.shows("id:werewolf-winner-banner")).toBe(true);
    expect(app.shows("id:werewolf-role-reveal-grid")).toBe(true);
    expect(app.shows("id:werewolf-mvp-card")).toBe(true);
    expect(app.shows("id:werewolf-truth-timeline")).toBe(false);
    await app.press("id:werewolf-gameover-tab-timeline");
    await app.waitFor("id:werewolf-truth-timeline");
    await app.press("id:werewolf-gameover-tab-roles");
    await app.waitFor("id:werewolf-role-reveal-grid");
    expect(app.texts().some((t) => t.includes("好人阵营获胜"))).toBe(true);

    await app.press("id:werewolf-play-again-btn");
    await app.waitFor("id:werewolf-lobby-panel");

    await app.press("id:exit-plugin-stage");
    await app.waitUntil(() => !app.shows("id:exit-plugin-stage"), { timeout: 3000 });
    expect(app.count("id:looi-face")).toBe(1);
  } finally {
    app.dispose();
  }
}

test(
  "Werewolf + Vision Person Tracker full landscape 844x390 E2E flow (Light theme, standard motion)",
  async () => {
    await runFullLandscapeMatch({ colorScheme: "light", reducedMotion: false });
  },
  180_000,
);

test(
  "Werewolf + Vision Person Tracker full landscape 844x390 E2E flow (Dark theme, reducedMotion)",
  async () => {
    await runFullLandscapeMatch({ colorScheme: "dark", reducedMotion: true });
  },
  120_000,
);

test(
  "Werewolf LAN Companion night peek drawer, secret ballot waiting UI & StageCapsule menu actions",
  async () => {
    const app = await open("./WerewolfStageProbe.tsx", {
      width: 844,
      height: 390,
      locale: "zh-CN",
      colorScheme: "light",
      reducedMotion: true,
    });

    try {
      await app.waitUntil(() => app.shows("id:connection-settings"), { timeout: 10000 });
      await app.press("id:connection-settings");
      await app.waitFor("id:nav-plugins");
      await app.press("id:nav-plugins");
      await app.waitFor("id:plugin-werewolf-judge");
      await app.press("id:plugin-werewolf-judge");
      await app.waitFor("id:werewolf-launch-stage-btn");
      await app.press("id:werewolf-launch-stage-btn");

      await app.waitFor("id:werewolf-lobby-panel");
      await app.press("id:werewolf-preset-6p_joy");
      await app.press("id:werewolf-surface-lan_companion");
      await app.waitFor("id:werewolf-qr-card");
      await app.press("id:werewolf-start-dealing-btn");
      await app.waitFor("id:werewolf-dealing-panel");

      expect(app.shows("id:werewolf-begin-night-btn")).toBe(false);
      for (let seat = 1; seat <= 6; seat += 1) {
        await app.press("id:werewolf-deal-confirm-btn");
        await app.wait(50);
      }

      await app.waitFor("id:werewolf-begin-night-btn");
      await app.press("id:werewolf-begin-night-btn");

      // LAN Companion keeps Night phase compact in a peek drawer while StageCapsule stays in top bar
      await app.waitUntil(() => app.shows("id:werewolf-night-lan-peek"), { timeout: 6000 });
      expect(app.shows("id:werewolf-stage-capsule")).toBe(true);

      // Wolf turn via host override
      await app.press("id:werewolf-lan-host-override-btn");
      await app.waitFor("id:werewolf-night-gate-btn");
      await app.press("id:werewolf-night-gate-btn");
      await app.waitFor("id:werewolf-wolf-empty-btn");
      await app.press("id:werewolf-wolf-empty-btn");

      // Witch turn via host override
      await app.waitUntil(() => app.shows("id:werewolf-lan-host-override-btn"), { timeout: 5000 });
      await app.press("id:werewolf-lan-host-override-btn");
      await app.waitFor("id:werewolf-night-gate-btn");
      await app.press("id:werewolf-night-gate-btn");
      await app.waitFor("id:werewolf-witch-pass-btn");
      await app.press("id:werewolf-witch-pass-btn");

      // Seer turn via host override
      await app.waitUntil(() => app.shows("id:werewolf-lan-host-override-btn"), { timeout: 5000 });
      await app.press("id:werewolf-lan-host-override-btn");
      await app.waitFor("id:werewolf-night-gate-btn");
      await app.press("id:werewolf-night-gate-btn");
      await app.waitFor("id:werewolf-night-seat-1");
      const checkSeat = [1, 2, 3, 4, 5, 6].find((s) =>
        app.enabled(`id:werewolf-night-seat-${s}`),
      )!;
      await app.press(`id:werewolf-night-seat-${checkSeat}`);
      await app.press("id:werewolf-seer-check-btn");
      await app.waitFor("id:werewolf-finish-seer-btn");
      await app.press("id:werewolf-finish-seer-btn");

      // Advance Day 1 -> check Self-Explode Dialog from StageCapsule [...] Menu during day_discussion
      await app.waitFor("id:werewolf-tabletop-stage");
      if (app.shows("id:werewolf-ack-dawn-btn")) {
        await app.press("id:werewolf-ack-dawn-btn");
      }
      await app.waitUntil(() => app.shows("id:werewolf-start-voting-btn"), { timeout: 5000 });

      await app.press("id:werewolf-more-menu-btn");
      await app.waitFor("id:werewolf-open-explode-btn");
      await app.press("id:werewolf-open-explode-btn");
      await app.waitFor("id:werewolf-explode-dialog");
      await app.press("id:werewolf-cancel-explode-btn");
      await app.waitUntil(() => !app.shows("id:werewolf-explode-dialog"), { timeout: 3000 });

      // Start Voting -> LAN secret ballot waiting screen masks targets and keeps finalize disabled until all votes arrive
      await app.press("id:werewolf-start-voting-btn");
      await app.waitFor("id:werewolf-voting-panel");

      expect(app.shows("id:werewolf-vote-progress-count")).toBe(true);
      expect(app.enabled("id:werewolf-finalize-votes-btn")).toBe(false);
      expect(app.texts()).toContain("等待全员投票");
      expect(app.shows("id:werewolf-vote-target-1")).toBe(false);

      await app.press("id:werewolf-lan-vote-override-btn");
      await app.waitFor("id:werewolf-lan-vote-back-btn");
      await app.press("id:werewolf-lan-vote-back-btn");
      await app.waitFor("id:werewolf-lan-vote-override-btn");

      // StageCapsule [...] Menu during voting exposes early-finalize & Abort AlertDialog confirm -> Lobby
      app.onDialog(() => "终止本局");
      await app.press("id:werewolf-more-menu-btn");
      await app.waitFor("id:werewolf-early-finalize-menu-btn");
      await app.waitFor("id:werewolf-abort-match-btn");
      await app.press("id:werewolf-abort-match-btn");
      await app.waitFor("id:werewolf-lobby-panel");
    } finally {
      app.dispose();
    }
  },
  120_000,
);
