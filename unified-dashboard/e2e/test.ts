import { test as base } from "@playwright/test";
import { koreanLocale } from "./korean-locale.mjs";

export * from "@playwright/test";
export const test = base.extend({ locale: [koreanLocale, { option: true }] });
