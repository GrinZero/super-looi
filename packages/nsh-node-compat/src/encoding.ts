/** UTF-8 fallback for the standalone VM. NSH's native encoders take precedence. */
export class Utf8Encoder {
  readonly encoding = "utf-8";
  encode(text = "") {
    return new Uint8Array(Buffer.from(text, "utf8"));
  }
  encodeInto(text: string, dest: Uint8Array) {
    let read = 0,
      written = 0;
    for (const char of text) {
      const bytes = this.encode(char);
      if (written + bytes.length > dest.length) break;
      dest.set(bytes, written);
      written += bytes.length;
      read += char.length;
    }
    return { read, written };
  }
}
export class Utf8Decoder {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  private pending = new Uint8Array();
  private started = false;
  constructor(
    label = "utf-8",
    options: { fatal?: boolean; ignoreBOM?: boolean } = {},
  ) {
    if (!["utf-8", "utf8"].includes(label.toLowerCase()))
      throw new RangeError("Only UTF-8 decoding is supported");
    this.fatal = options.fatal ?? false;
    this.ignoreBOM = options.ignoreBOM ?? false;
  }
  decode(
    input?: ArrayBuffer | ArrayBufferView,
    options: { stream?: boolean } = {},
  ) {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array();
    const all = new Uint8Array(this.pending.length + bytes.length);
    all.set(this.pending);
    all.set(bytes, this.pending.length);
    this.pending = new Uint8Array();
    let out = "",
      i = 0;
    while (i < all.length) {
      const lead = all[i];
      let width =
        lead < 0x80
          ? 1
          : lead >= 0xc2 && lead <= 0xdf
            ? 2
            : lead >= 0xe0 && lead <= 0xef
              ? 3
              : lead >= 0xf0 && lead <= 0xf4
                ? 4
                : 0;
      let code = width === 1 ? lead : lead & ((1 << (7 - width)) - 1);
      let valid = width > 0;
      let consumed = 1;
      for (let j = 1; j < width && i + j < all.length; j++) {
        const byte = all[i + j];
        if (
          byte < 0x80 ||
          byte > 0xbf ||
          (j === 1 &&
            ((lead === 0xe0 && byte < 0xa0) ||
              (lead === 0xed && byte >= 0xa0) ||
              (lead === 0xf0 && byte < 0x90) ||
              (lead === 0xf4 && byte >= 0x90)))
        ) {
          valid = false;
          break;
        }
        code = (code << 6) | (byte & 63);
        consumed++;
      }
      if (valid && i + width > all.length) {
        if (options.stream) {
          this.pending = all.slice(i);
          break;
        }
        valid = false;
        width = all.length - i;
      }
      if (!valid) {
        if (this.fatal) throw new TypeError("Invalid UTF-8");
        out += "\ufffd";
        i += consumed;
      } else {
        out += String.fromCodePoint(code);
        i += width;
      }
    }
    if (!this.started && out) {
      if (!this.ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
      this.started = true;
    }
    if (!options.stream) this.started = false;
    return out;
  }
}
