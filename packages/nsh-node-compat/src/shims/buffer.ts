import * as native from "__nsh_native/buffer";
export * from "__nsh_native/buffer";
export const constants = {
  MAX_LENGTH: 0x7fffffff,
  MAX_STRING_LENGTH: 0x1fffffe8,
};
export default { ...native, constants };
