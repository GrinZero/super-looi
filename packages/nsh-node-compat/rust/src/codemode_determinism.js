(function installDeterminism(now, seed) {
  "use strict";
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const NativeDate = Date;
  const parse = (value) => {
    const text = String(value);
    if (/^\d{4}-\d\d-\d\d$/.test(text)) return NativeDate.parse(text);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(text)) return NativeDate.parse(text + "Z");
    if (/(?:Z|[+-]\d\d:?\d\d|GMT|UTC)$/i.test(text)) return NativeDate.parse(text);
    return NaN;
  };
  function VirtualDate(...args) {
    if (!new.target) return new NativeDate(now()).toUTCString();
    const value = !args.length ? now() : args.length > 1 ? NativeDate.UTC(...args) : typeof args[0] === "string" ? parse(args[0]) : args[0];
    const date = new NativeDate(value);
    return Object.setPrototypeOf(date, new.target.prototype);
  }
  // Do not expose NativeDate via either the constructor's or instances' prototype.
  VirtualDate.prototype = Object.create(Object.prototype);
  for (const key of Reflect.ownKeys(NativeDate.prototype)) {
    if (key !== "constructor") Object.defineProperty(VirtualDate.prototype, key, Object.getOwnPropertyDescriptor(NativeDate.prototype, key));
  }
  Object.defineProperty(VirtualDate.prototype, "constructor", { value: VirtualDate, writable: true, configurable: true });
  VirtualDate.now = now;
  VirtualDate.parse = parse;
  VirtualDate.UTC = NativeDate.UTC;
  VirtualDate.prototype.getTimezoneOffset = () => 0;
  for (const name of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"]) {
    VirtualDate.prototype[`get${name}`] = NativeDate.prototype[`getUTC${name}`];
    if (name !== "Day") VirtualDate.prototype[`set${name}`] = NativeDate.prototype[`setUTC${name}`];
  }
  VirtualDate.prototype.toString = NativeDate.prototype.toUTCString;
  VirtualDate.prototype.toDateString = function () { return this.toISOString().slice(0, 10); };
  VirtualDate.prototype.toTimeString = function () { return this.toISOString().slice(11); };
  VirtualDate.prototype.toLocaleString = NativeDate.prototype.toISOString;
  VirtualDate.prototype.toLocaleDateString = VirtualDate.prototype.toDateString;
  VirtualDate.prototype.toLocaleTimeString = VirtualDate.prototype.toTimeString;
  VirtualDate.prototype.getYear = function () { return this.getUTCFullYear() - 1900; };
  VirtualDate.prototype.setYear = function (year) { return this.setUTCFullYear(year >= 0 && year <= 99 ? year + 1900 : year); };
  globalThis.Date = VirtualDate;
  delete globalThis.WeakRef;
  delete globalThis.FinalizationRegistry;
})
