import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { modeView, servicesOrError } from "@/lib/server/page";

export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const services = servicesOrError();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <SiteHeader {...(services.svc ? { mode: modeView(services.svc) } : {})} />
      {services.error && (
        <div role="alert" className="border-b border-danger/30 bg-danger-soft">
          <p className="mx-auto max-w-6xl px-4 py-3 text-sm text-danger-strong sm:px-6">
            <strong className="font-semibold">Configuration error.</strong> {services.error}
          </p>
        </div>
      )}
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
