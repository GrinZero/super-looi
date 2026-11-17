import {
  Canvas,
  Clipboard,
  computed,
  effect,
  reduceMotion,
  Scroll,
  signal,
  Text,
  token,
  View,
  windowSize,
} from "nsh";
import { Button, Dialog } from "nsh/base";
import { ActionButton } from "../../../ui/Controls";

interface QrVersionSpec {
  readonly version: number;
  readonly size: number;
  readonly ecLevelBits: number; // M = 0b00, L = 0b01
  readonly totalDataCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly numBlocks: number;
  readonly alignmentCenters: readonly number[];
}

/**
 * ISO/IEC 18004 Table 9 specs for Versions 1–6 (supports UTF-8 URLs up to 134 bytes).
 * Versions 1–6 Level M provide 15% error correction for angled tabletop phone scans;
 * Version 6 Level L extends capacity to 134 bytes without needing Version 7+ info blocks.
 */
const QR_VERSION_SPECS: readonly QrVersionSpec[] = [
  {
    version: 1,
    size: 21,
    ecLevelBits: 0b00,
    totalDataCodewords: 16,
    ecCodewordsPerBlock: 10,
    numBlocks: 1,
    alignmentCenters: [],
  },
  {
    version: 2,
    size: 25,
    ecLevelBits: 0b00,
    totalDataCodewords: 28,
    ecCodewordsPerBlock: 16,
    numBlocks: 1,
    alignmentCenters: [6, 18],
  },
  {
    version: 3,
    size: 29,
    ecLevelBits: 0b00,
    totalDataCodewords: 44,
    ecCodewordsPerBlock: 26,
    numBlocks: 1,
    alignmentCenters: [6, 22],
  },
  {
    version: 4,
    size: 33,
    ecLevelBits: 0b00,
    totalDataCodewords: 64,
    ecCodewordsPerBlock: 18,
    numBlocks: 2,
    alignmentCenters: [6, 26],
  },
  {
    version: 5,
    size: 37,
    ecLevelBits: 0b00,
    totalDataCodewords: 86,
    ecCodewordsPerBlock: 24,
    numBlocks: 2,
    alignmentCenters: [6, 30],
  },
  {
    version: 6,
    size: 41,
    ecLevelBits: 0b00,
    totalDataCodewords: 108,
    ecCodewordsPerBlock: 16,
    numBlocks: 4,
    alignmentCenters: [6, 34],
  },
  {
    version: 6,
    size: 41,
    ecLevelBits: 0b01,
    totalDataCodewords: 136,
    ecCodewordsPerBlock: 18,
    numBlocks: 2,
    alignmentCenters: [6, 34],
  },
];

function encodeUtf8Bytes(input: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >>> 12),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function gfMultiply(x: number, y: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((y >>> i) & 1) * x;
  }
  return result;
}

function buildReedSolomonDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1]!;
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function computeReedSolomonRemainder(
  data: Uint8Array,
  divisor: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i]! ^ result[0]!;
    result.copyWithin(0, 1);
    result[divisor.length - 1] = 0;
    for (let j = 0; j < divisor.length; j += 1) {
      result[j] ^= gfMultiply(divisor[j]!, factor);
    }
  }
  return result;
}

function appendBits(target: number[], value: number, bitLength: number): void {
  for (let i = bitLength - 1; i >= 0; i -= 1) {
    target.push((value >>> i) & 1);
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function drawFormatBits(
  modules: boolean[][],
  isFunction: boolean[][],
  ecLevelBits: number,
  mask: number,
): void {
  const size = modules.length;
  const data5 = (ecLevelBits << 3) | mask;
  let rem = data5 << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  const bits = ((data5 << 10) | rem) ^ 0x5412;

  const setFn = (col: number, row: number, dark: boolean) => {
    modules[row]![col] = dark;
    isFunction[row]![col] = true;
  };

  for (let i = 0; i <= 5; i += 1) setFn(8, i, ((bits >>> i) & 1) !== 0);
  setFn(8, 7, ((bits >>> 6) & 1) !== 0);
  setFn(8, 8, ((bits >>> 7) & 1) !== 0);
  setFn(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, ((bits >>> i) & 1) !== 0);

  for (let i = 0; i < 8; i += 1) {
    setFn(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  }
  for (let i = 8; i < 15; i += 1) {
    setFn(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  }
  setFn(8, size - 8, true);
}

function computePenaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: runs of >= 5 identical modules in row/col
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r]![0]!;
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r]![c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r]![c]!;
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0]![c]!;
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r]![c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r]![c]!;
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 solid blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = modules[r]![c]!;
      if (
        color === modules[r]![c + 1] &&
        color === modules[r + 1]![c] &&
        color === modules[r + 1]![c + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns preceded or followed by 4 light modules
  const matchesRule3At = (line: readonly boolean[], start: number): boolean => {
    const patA = [true, false, true, true, true, false, true, false, false, false, false];
    const patB = [false, false, false, false, true, false, true, true, true, false, true];
    let okA = true;
    let okB = true;
    for (let k = 0; k < 11; k += 1) {
      if (line[start + k] !== patA[k]) okA = false;
      if (line[start + k] !== patB[k]) okB = false;
      if (!okA && !okB) return false;
    }
    return true;
  };
  for (let r = 0; r < size; r += 1) {
    const row = modules[r]!;
    for (let c = 0; c <= size - 11; c += 1) {
      if (matchesRule3At(row, c)) penalty += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    const colLine: boolean[] = [];
    for (let r = 0; r < size; r += 1) colLine.push(modules[r]![c]!);
    for (let r = 0; r <= size - 11; r += 1) {
      if (matchesRule3At(colLine, r)) penalty += 40;
    }
  }

  // Rule 4: dark/light balance
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r]![c]) darkCount += 1;
    }
  }
  const total = size * size;
  const k = Math.ceil((Math.abs(darkCount * 20 - total * 10) + total - 1) / total) - 1;
  if (k > 0) penalty += k * 10;

  return penalty;
}

/**
 * Encodes an ASCII / UTF-8 string (such as a LAN companion room URL) into an ISO/IEC 18004
 * boolean module matrix (`true` = dark module, `false` = light module).
 */
export function encodeQrMatrix(text: string): boolean[][] {
  const payload = encodeUtf8Bytes(text);
  const spec = QR_VERSION_SPECS.find(
    (item) => payload.length + 2 <= item.totalDataCodewords,
  );
  if (!spec) {
    throw Object.assign(
      new Error(
        `[stage=qr.encode code=ERR_QR_PAYLOAD_TOO_LONG] QR payload (${payload.length} bytes) exceeds 134-byte capacity`,
      ),
      { stage: "qr.encode", code: "ERR_QR_PAYLOAD_TOO_LONG" },
    );
  }

  const capacityBits = spec.totalDataCodewords * 8;
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // Byte mode indicator
  appendBits(bits, payload.length, 8); // 8-bit char count (Versions 1–9)
  for (let i = 0; i < payload.length; i += 1) {
    appendBits(bits, payload[i]!, 8);
  }
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);

  const dataCodewords = new Uint8Array(spec.totalDataCodewords);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) {
      byte = (byte << 1) | bits[i + b]!;
    }
    dataCodewords[i >>> 3] = byte;
  }
  let padToggle = 0;
  for (let idx = bits.length >>> 3; idx < spec.totalDataCodewords; idx += 1) {
    dataCodewords[idx] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }

  const dataPerBlock = spec.totalDataCodewords / spec.numBlocks;
  const rsDivisor = buildReedSolomonDivisor(spec.ecCodewordsPerBlock);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let b = 0; b < spec.numBlocks; b += 1) {
    const slice = dataCodewords.subarray(b * dataPerBlock, (b + 1) * dataPerBlock);
    dataBlocks.push(slice);
    ecBlocks.push(computeReedSolomonRemainder(slice, rsDivisor));
  }

  const allCodewords: number[] = [];
  for (let i = 0; i < dataPerBlock; i += 1) {
    for (let b = 0; b < spec.numBlocks; b += 1) {
      allCodewords.push(dataBlocks[b]![i]!);
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i += 1) {
    for (let b = 0; b < spec.numBlocks; b += 1) {
      allCodewords.push(ecBlocks[b]![i]!);
    }
  }

  const size = spec.size;
  const baseModules: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );

  const setFn = (col: number, row: number, dark: boolean) => {
    if (col < 0 || col >= size || row < 0 || row >= size) return;
    baseModules[row]![col] = dark;
    isFunction[row]![col] = true;
  };

  const drawFinder = (centerCol: number, centerRow: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(centerCol + dx, centerRow + dy, dist !== 2 && dist !== 4);
      }
    }
  };

  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  for (let i = 0; i < size; i += 1) {
    if (!isFunction[6]![i]) setFn(i, 6, i % 2 === 0);
    if (!isFunction[i]![6]) setFn(6, i, i % 2 === 0);
  }

  for (const cy of spec.alignmentCenters) {
    for (const cx of spec.alignmentCenters) {
      if (
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format area before placing data zigzag
  drawFormatBits(baseModules, isFunction, spec.ecLevelBits, 0);

  let bitCursor = 0;
  const totalCodewordBits = allCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip vertical timing column
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!isFunction[row]![col]) {
          let dark = false;
          if (bitCursor < totalCodewordBits) {
            const byte = allCodewords[bitCursor >>> 3]!;
            dark = ((byte >>> (7 - (bitCursor & 7))) & 1) !== 0;
          }
          baseModules[row]![col] = dark;
          bitCursor += 1;
        }
      }
    }
  }

  let bestMatrix = baseModules;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = baseModules.map((row, r) =>
      row.map((val, c) =>
        isFunction[r]![c] ? val : val !== maskBit(mask, r, c),
      ),
    );
    const fnCopy = isFunction.map((row) => [...row]);
    drawFormatBits(candidate, fnCopy, spec.ecLevelBits, mask);
    const penalty = computePenaltyScore(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate;
    }
  }

  return bestMatrix;
}

interface QrRenderState {
  readonly matrix: boolean[][] | null;
  readonly error: string | null;
}

function resolveQrState(raw: string): QrRenderState {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { matrix: null, error: null };
  }
  try {
    return { matrix: encodeQrMatrix(trimmed), error: null };
  } catch (err) {
    const record = err as { code?: unknown; stage?: unknown; message?: unknown } | null;
    const message =
      err instanceof Error
        ? err.message
        : typeof record?.message === "string"
          ? record.message
          : String(err);
    const code = typeof record?.code === "string" ? record.code : "ERR_QR_ENCODE_FAILED";
    const stage = typeof record?.stage === "string" ? record.stage : "qr.encode";
    return {
      matrix: null,
      error: message.includes("code=") ? message : `[stage=${stage} code=${code}] ${message}`,
    };
  }
}

function QrMatrixCanvas(props: {
  state: () => QrRenderState;
  locale: () => "zh-CN" | "en-US";
  testID: string;
}) {
  return (
    <If
      when={Boolean(props.state().matrix)}
      else={
        <If
          when={Boolean(props.state().error)}
          else={
            <Text class="text-stage-bg text-xs text-center px-1.5">
              {props.locale() === "en-US" ? "Waiting for LAN URL" : "等待局域网地址"}
            </Text>
          }
        >
          <Text
            testID={`${props.testID}-error`}
            class="text-stage-bg text-xs font-medium text-center px-1"
            style={{ numberOfLines: 4 }}
          >
            {props.state().error}
          </Text>
        </If>
      }
    >
      <Canvas
        testID={props.testID}
        class="w-full h-full"
        style={{ pointerEvents: "none" }}
        draw={(cx, canvasSize) => {
          cx.clearRect(0, 0, canvasSize.width, canvasSize.height);
          const matrix = props.state().matrix;
          if (!matrix) return;
          const moduleCount = matrix.length;
          const quietModules = 4;
          const totalGrid = moduleCount + quietModules * 2;
          const side = Math.min(canvasSize.width, canvasSize.height);
          const cell = Math.max(1, Math.floor(side / totalGrid));
          const drawnSpan = cell * totalGrid;
          const originX = Math.floor((canvasSize.width - drawnSpan) / 2);
          const originY = Math.floor((canvasSize.height - drawnSpan) / 2);

          cx.fillStyle = token("face-ivory-core");
          cx.fillRect(0, 0, canvasSize.width, canvasSize.height);

          cx.fillStyle = token("stage-bg");
          for (let r = 0; r < moduleCount; r += 1) {
            const row = matrix[r]!;
            const py = originY + (r + quietModules) * cell;
            for (let c = 0; c < moduleCount; c += 1) {
              if (row[c]) {
                const px = originX + (c + quietModules) * cell;
                cx.fillRect(px, py, cell, cell);
              }
            }
          }
        }}
      />
    </If>
  );
}

/**
 * Renders a high-contrast QR matrix card that opens an enlarged landscape modal
 * when tapped (disable via `zoomable={false}` when embedding in non-interactive surfaces).
 */
export function QrCodeCanvas(props: {
  value: string;
  size?: number;
  label?: string;
  testID?: string;
  zoomable?: boolean;
  locale?: "zh-CN" | "en-US";
  surface?: "card" | "stage";
  onNotify?: (message: string) => void;
}) {
  const expanded = signal(false);
  const copied = signal(false);
  const copyError = signal("");

  const loc = (): "zh-CN" | "en-US" => props.locale ?? "zh-CN";
  const isEn = () => loc() === "en-US";
  const boxSize = () => props.size ?? 136;
  const qrState = computed(() => resolveQrState(props.value));
  const canZoom = () => Boolean(qrState().matrix);
  const cardTestId = () => props.testID ?? "werewolf-qr-card";
  const smallCanvasTestId = () =>
    cardTestId() === "werewolf-qr-card"
      ? "werewolf-qr-canvas"
      : `${cardTestId()}-canvas`;
  const borderClass = () =>
    props.surface === "stage" ? "border-stage-pill-border" : "border-border";
  const maxDialogHeight = () => Math.max(160, windowSize().height - 32);
  const enlargedSize = () =>
    Math.max(
      120,
      Math.min(256, Math.min(windowSize().width - 220, maxDialogHeight() - 36)),
    );
  const titleText = () =>
    props.label ?? (isEn() ? "LAN Companion QR" : "局域网扫码副屏");

  const cardStyle = () => ({
    width: boxSize(),
    height: boxSize(),
    backgroundColor: token("face-ivory-core"),
  });

  const baseCardClass = () =>
    `rounded-2xl border ${borderClass()} p-1.5 items-center justify-center shrink-0 overflow-hidden`;

  const triggerFocusClass = () =>
    props.surface === "stage"
      ? "focus-visible:border-face-amber-edge"
      : "focus-visible:border-ring dark:focus-visible:border-face-amber-edge";

  const cardAccessibilityLabel = (interactive: boolean) => {
    const err = qrState().error;
    const prefix = titleText();
    if (err) {
      return isEn()
        ? `${prefix}: unavailable (${err})`
        : `${prefix}：无法生成（${err}）`;
    }
    const url = props.value.trim();
    if (!url) {
      return isEn()
        ? `${prefix}: waiting for LAN URL`
        : `${prefix}：等待局域网地址`;
    }
    if (!interactive) {
      return isEn() ? `${prefix}: ${url}` : `${prefix}：${url}`;
    }
    return isEn()
      ? `${prefix}: ${url} (Tap to enlarge QR code)`
      : `${prefix}：${url}（点击放大二维码）`;
  };

  let lastNotifiedQrError: string | null = null;
  effect(() => {
    const err = qrState().error;
    if (err && err !== lastNotifiedQrError) {
      lastNotifiedQrError = err;
      props.onNotify?.(err);
    } else if (!err) {
      lastNotifiedQrError = null;
    }
  });

  effect(() => {
    if (!canZoom() || props.zoomable === false) {
      expanded.set(false);
    }
  });

  let prevUrl = props.value;
  let wasExpanded = false;
  effect(() => {
    const nextUrl = props.value;
    const isExpanded = expanded();
    if (nextUrl !== prevUrl || isExpanded !== wasExpanded) {
      prevUrl = nextUrl;
      wasExpanded = isExpanded;
      copied.set(false);
      copyError.set("");
    }
  });

  effect(() => {
    if (!copied()) return;
    const timer = setTimeout(() => copied.set(false), 1800);
    return () => clearTimeout(timer);
  });

  const renderSmallMatrix = () => (
    <QrMatrixCanvas
      state={qrState}
      locale={loc}
      testID={smallCanvasTestId()}
    />
  );

  return (
    <If
      when={props.zoomable !== false}
      else={
        <View
          testID={cardTestId()}
          role="image"
          accessibilityLabel={cardAccessibilityLabel(false)}
          class={baseCardClass()}
          style={cardStyle()}
        >
          {renderSmallMatrix()}
        </View>
      }
    >
      <View class="shrink-0">
        <Button
          testID={cardTestId()}
          disabled={!canZoom()}
          accessibilityLabel={cardAccessibilityLabel(true)}
          onPress={() => {
            if (canZoom()) {
              expanded.set(true);
            }
          }}
          class={`${baseCardClass()} transition-transform duration-180 active:scale-[0.97] motion-reduce:active:scale-100 ${triggerFocusClass()} disabled:opacity-60`}
          style={cardStyle()}
        >
          {renderSmallMatrix()}
        </Button>

        <Dialog
          testID={`${cardTestId()}-zoom-dialog`}
          open={expanded() && canZoom()}
          animation={reduceMotion() ? "none" : "fade"}
          presentation="fullScreen"
          accessibilityLabel={titleText()}
          closeOnEscape={true}
          closeOnSwipe={true}
          closeOnBackdropPress={true}
          onOpenChange={(e) => {
            if (!e.open) {
              expanded.set(false);
            }
          }}
          backdropClass="bg-backdrop"
          backdropTestID={`${cardTestId()}-zoom-backdrop`}
          class="m-auto rounded-2xl border border-border bg-popover p-4 shadow-lg"
          style={{
            width: Math.min(560, windowSize().width - 32),
            maxHeight: maxDialogHeight(),
          }}
        >
          <View
            testID={`${cardTestId()}-zoom-card`}
            class="flex-row items-center gap-4"
          >
            <Button
              testID={`${cardTestId()}-zoom-qr`}
              accessibilityLabel={
                isEn() ? "Collapse enlarged QR code" : "收起放大二维码"
              }
              onPress={() => expanded.set(false)}
              class="rounded-xl border border-border p-2 items-center justify-center shrink-0 overflow-hidden transition-transform duration-180 active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:border-ring dark:focus-visible:border-face-amber-edge"
              style={{
                width: enlargedSize(),
                height: enlargedSize(),
                backgroundColor: token("face-ivory-core"),
              }}
            >
              <QrMatrixCanvas
                state={qrState}
                locale={loc}
                testID={`${cardTestId()}-zoom-canvas`}
              />
            </Button>

            <Scroll
              class="flex-1 min-w-0"
              style={{ maxHeight: enlargedSize() }}
              contentClass="justify-between gap-3"
            >
              <View class="gap-1">
                <Text
                  class="text-foreground text-base font-bold"
                  role="header"
                >
                  {titleText()}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {isEn()
                    ? "Scan with your phone camera or browser to join. Tap QR code or backdrop to close."
                    : "使用手机相机或浏览器扫码加入房间，点击二维码或空白处可收起"}
                </Text>
              </View>

              <View class="rounded-lg border border-border bg-muted px-3 py-2">
                <Text
                  testID={`${cardTestId()}-zoom-url`}
                  class="text-foreground text-xs font-mono"
                  style={{ numberOfLines: 2 }}
                >
                  {props.value}
                </Text>
              </View>

              <If when={Boolean(copyError())}>
                <Text
                  testID={`${cardTestId()}-zoom-copy-error`}
                  class="text-destructive text-xs"
                >
                  {copyError()}
                </Text>
              </If>

              <View class="flex-row flex-wrap items-center gap-2">
                <ActionButton
                  testID={`${cardTestId()}-zoom-copy`}
                  compact
                  label={
                    copied()
                      ? isEn()
                        ? "URL Copied"
                        : "已复制链接"
                      : isEn()
                        ? "Copy URL"
                        : "复制链接"
                  }
                  onPress={() => {
                    const url = props.value.trim();
                    if (!url) return;
                    void Clipboard.writeText(url)
                      .then(() => {
                        copyError.set("");
                        copied.set(true);
                      })
                      .catch((err) => {
                        const detail =
                          err instanceof Error ? err.message : String(err);
                        const message = detail.includes("code=")
                          ? detail
                          : `[stage=qr.copy code=ERR_CLIPBOARD_WRITE] ${detail || "Clipboard write failed"}`;
                        copied.set(false);
                        copyError.set(message);
                        props.onNotify?.(message);
                      });
                  }}
                />
                <ActionButton
                  testID={`${cardTestId()}-zoom-close`}
                  compact
                  kind="primary"
                  label={isEn() ? "Close QR" : "收起二维码"}
                  onPress={() => expanded.set(false)}
                />
              </View>
            </Scroll>
          </View>
        </Dialog>
      </View>
    </If>
  );
}
