import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Good Faith",
  description: "Open-source bug bounties for the AI-slop era: refundable PayPal deposits, AI-reproduced reports, instant PayPal payouts.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
