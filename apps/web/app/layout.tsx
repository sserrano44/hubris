import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "../components/providers";
import { Nav } from "../components/nav";
import { WalletControls } from "../components/wallet-controls";

export const metadata: Metadata = {
  metadataBase: new URL("https://elhub.finance"),
  title: "elhub",
  description: "Multi-chain intent-based money market",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    title: "elhub",
    description: "Multi-chain intent-based money market",
    url: "https://elhub.finance",
    siteName: "elhub"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="site-shell">
            <header className="topbar">
              <div>
                <p className="eyebrow">elhub</p>
                <h1>Cross-Chain Money Market</h1>
              </div>
              <WalletControls />
            </header>
            <Nav />
            <main>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
