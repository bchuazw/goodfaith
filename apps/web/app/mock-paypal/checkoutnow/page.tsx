import { isMockPayPal } from "@goodfaith/paypal";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getServices } from "@/lib/server/runtime";
import { MockSheet } from "./mock-sheet";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Simulated PayPal approval (MOCK)", robots: { index: false } };

type RawOrder = { purchase_units?: Array<{ description?: string; items?: Array<{ name?: string }> }> };

/**
 * MOCK ONLY. Where the PayPal mock's approval links point (PAYPAL_MOCK_WEB_BASE_URL=/mock-paypal): a
 * stand-in for PayPal's checkout window that calls simulateBuyerApproval. It does not exist in live mode.
 */
export default async function MockCheckoutNow({ searchParams }: PageProps<"/mock-paypal/checkoutnow">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : undefined;
  const embed = params.embed === "1";
  const svc = getServices();
  if (!isMockPayPal(svc.paypal)) notFound();
  const order = token ? await svc.paypal.getOrder(token).catch(() => undefined) : undefined;
  const unit = (order?.raw as RawOrder | undefined)?.purchase_units?.[0];
  return (
    <MockSheet
      embed={embed}
      order={
        order
          ? {
              id: order.id,
              status: order.status,
              intent: order.intent === "AUTHORIZE" ? "AUTHORIZE" : "CAPTURE",
              ...(order.amount ? { amount: order.amount } : {}),
              ...(unit?.description ? { description: unit.description } : {}),
              ...(unit?.items?.[0]?.name ? { item: unit.items[0].name } : {}),
            }
          : undefined
      }
      token={token}
    />
  );
}
