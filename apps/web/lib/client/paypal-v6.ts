"use client";

/**
 * PayPal JS SDK v6, loaded from PayPal's CDN (https://www.paypal.com/web-sdk/v6/core, or the sandbox host).
 * The types below cover what Good Faith uses, following @paypal/paypal-js's v6 definitions:
 * createInstance({ clientToken, components: ["paypal-payments"] }) -> findEligibleMethods() ->
 * createPayPalOneTimePaymentSession({ onApprove, onCancel, onError }) -> session.start(options, createOrderPromise).
 */

export type PayPalEnvironment = "sandbox" | "production";

export type OnApproveData = { orderId: string; payerId?: string };
export type OnCancelData = { orderId?: string };
export type PayPalSdkError = Error & { code?: string; isRecoverable?: boolean };

export type OneTimePaymentSession = {
  start: (options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, createOrder: Promise<{ orderId: string }>) => Promise<void | { redirectURL?: string }>;
  destroy: () => void;
  cancel: () => void;
};

export type SdkInstance = {
  findEligibleMethods: (opts?: { currencyCode?: string; amount?: string }) => Promise<{ isEligible: (method: string) => boolean }>;
  createPayPalOneTimePaymentSession: (opts: {
    onApprove: (data: OnApproveData) => Promise<void>;
    onCancel?: (data: OnCancelData) => void;
    onError?: (error: PayPalSdkError) => void;
  }) => OneTimePaymentSession;
};

type PayPalNamespace = {
  createInstance: (opts: { clientToken: string; components: string[]; pageType?: string; locale?: string }) => Promise<SdkInstance>;
  version?: string;
};

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

const scriptLoads = new Map<PayPalEnvironment, Promise<PayPalNamespace>>();

export function loadPayPalSdk(environment: PayPalEnvironment): Promise<PayPalNamespace> {
  const existing = scriptLoads.get(environment);
  if (existing) return existing;
  const load = new Promise<PayPalNamespace>((resolve, reject) => {
    if (window.paypal?.createInstance) return resolve(window.paypal);
    const script = document.createElement("script");
    script.src = environment === "production" ? "https://www.paypal.com/web-sdk/v6/core" : "https://www.sandbox.paypal.com/web-sdk/v6/core";
    script.async = true;
    script.onload = () => (window.paypal?.createInstance ? resolve(window.paypal) : reject(new Error("PayPal SDK loaded without paypal.createInstance")));
    script.onerror = () => reject(new Error("Could not load the PayPal SDK"));
    document.head.appendChild(script);
  });
  scriptLoads.set(environment, load);
  load.catch(() => scriptLoads.delete(environment));
  return load;
}

type ClientTokenResponse = { clientToken: string; expiresIn: number; environment: PayPalEnvironment };

/** A browser-safe client token from the app's server (minted per page; PayPal gives it 15 minutes). */
export async function fetchClientToken(): Promise<ClientTokenResponse> {
  const res = await fetch("/api/paypal/client-token", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not get a PayPal client token (${res.status})`);
  return (await res.json()) as ClientTokenResponse;
}

export async function createPayPalInstance(): Promise<{ instance: SdkInstance; eligible: boolean; environment: PayPalEnvironment }> {
  const { clientToken, environment } = await fetchClientToken();
  const paypal = await loadPayPalSdk(environment);
  const instance = await paypal.createInstance({ clientToken, components: ["paypal-payments"], pageType: "checkout", locale: "en-US" });
  const methods = await instance.findEligibleMethods({ currencyCode: "USD" });
  return { instance, eligible: methods.isEligible("paypal"), environment };
}
