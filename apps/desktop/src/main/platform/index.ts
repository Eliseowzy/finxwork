import { darwin } from "./darwin";
import { linux } from "./linux";
import type { Platform } from "./types";
import { win32 } from "./win32";

export type { Platform, WindowKind } from "./types";

/** This OS's adapter. */
export const platform: Platform = process.platform === "darwin" ? darwin : process.platform === "win32" ? win32 : linux;
