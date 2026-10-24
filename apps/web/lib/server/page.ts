/** Helpers for server components (pages and layouts). */
import "server-only";
import type { ModeView } from "../view-types";
import { getServices } from "./runtime";
import type { Services } from "./services";

export type ServicesOrError = { svc: Services; error?: undefined } | { svc?: undefined; error: string };

/** Services, or the configuration error that stops them (GOODFAITH_MODE=live without keys fails loudly). */
export function servicesOrError(): ServicesOrError {
  try {
    return { svc: getServices() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function modeView(svc: Services): ModeView {
  return { ...svc.mode, mocks: [...svc.mode.mocks] };
}
