import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
let clientNow: number | undefined;
// A stable snapshot per page load: useSyncExternalStore re-renders forever on a value that changes every call.
const getSnapshot = () => (clientNow ??= Date.now());
const getServerSnapshot = () => undefined;

/**
 * Date.now() in the browser, and undefined during the server render and hydration. Relative times ("3 min ago")
 * depend on the clock, so rendering them from this value keeps server and client markup identical.
 */
export function useClientNow(): number | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
