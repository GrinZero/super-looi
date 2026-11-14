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
    await app.press("id:vision-alpha-025");
    await app.press("id:vision-alpha-045");
    await app.press("id:plugin-back-to-list");

    // 2. Open werewolf-judge settings & launch onto MorphableStage ("登上首屏开局")
    await app.waitFor("id:plugin-werewolf-judge");
    await app.press("id:plugin-werewolf-judge");
    await app.waitFor("id:werewolf-settings-view");
    await app.press("id:werewolf-launch-stage-btn");

    // Verify MorphableStage lobby mounted in landscape with persistent RobotFace
    await app.waitFor("id:werewolf-lobby-panel");
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:exit-plugin-stage")).toBe(true);
    // In large lobby drawer, StageCapsule auto-hides to avoid glass-on-glass overlap behind StageDrawer
    expect(app.shows("id:werewolf-stage-capsule")).toBe(false);

    // Collapsing drawer to peek exposes StageCapsule cleanly; cycling back to large re-hides it
    await app.press("id:stage-drawer-grabber");
    await app.wait(120);
    expect(app.shows("id:werewolf-stage-capsule")).toBe(true);
    await app.press("id:stage-drawer-grabber");
    await app.wait(80);
    await app.press("id:stage-drawer-grabber");
    await app.wait(120);
    expect(app.shows("id:werewolf-stage-capsule")).toBe(false);

    // 3. Select 6p_joy, toggle LAN Companion QR on to verify native LanRoomHost + QrCodeCanvas, then switch back to on_device
    await app.press("id:werewolf-preset-6p_joy");
    await app.press("id:werewolf-surface-lan_companion");
    await app.waitFor("id:werewolf-qr-card");
    await app.waitUntil(
      () => app.texts().some((txt) => txt.includes("http://")),
      { timeout: 5000 },
    );
    expect(app.shows("id:werewolf-qr-canvas")).toBe(true);

    await app.press("id:werewolf-surface-on_device");
    await app.wait(120);

    // 4. Start Dealing & exercise Hold-to-Reveal privacy shield across seats 1..6
    await app.press("id:werewolf-start-dealing-btn");
    await app.waitFor("id:werewolf-dealing-panel");
    expect(app.shows("id:werewolf-stage-capsule")).toBe(true);

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
    await app.press("id:werewolf-finalize-votes-btn");

    // 8. Game Over full-deck reveal + timeline + Play Again + Exit Stage
    await app.waitFor("id:werewolf-gameover-panel");
    expect(app.shows("id:werewolf-winner-banner")).toBe(true);
    expect(app.shows("id:werewolf-role-reveal-grid")).toBe(true);
    expect(app.shows("id:werewolf-mvp-card")).toBe(true);
    expect(app.shows("id:werewolf-truth-timeline")).toBe(true);
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
