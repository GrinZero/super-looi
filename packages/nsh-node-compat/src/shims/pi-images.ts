import { unsupported } from "../bridge.js";
export const resizeImage = async () =>
  unsupported("image resize; install a native image processor");
export const formatDimensionNote = () => undefined;
export const getPhoton = () =>
  unsupported("Photon WASM; install a native image processor");
export const loadPhoton = async () =>
  unsupported("Photon WASM; install a native image processor");
