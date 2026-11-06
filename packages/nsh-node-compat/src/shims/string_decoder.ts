export class StringDecoder {
  private decoder: TextDecoder;
  constructor(encoding = "utf-8") {
    this.decoder = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding);
  }
  write(data: Uint8Array) {
    return this.decoder.decode(data, { stream: true });
  }
  end(data?: Uint8Array) {
    return (data ? this.write(data) : "") + this.decoder.decode();
  }
}
export default { StringDecoder };
