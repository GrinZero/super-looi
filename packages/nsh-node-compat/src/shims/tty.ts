import { unsupported } from "../bridge.js";
export const isatty = (_fd: number) => false;
export class ReadStream {
  constructor() {
    unsupported("TTY input");
  }
}
export class WriteStream {
  constructor() {
    unsupported("TTY output");
  }
}
export default { isatty, ReadStream, WriteStream };
