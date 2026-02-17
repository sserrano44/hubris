import type { Metadata } from "next";
import { Space_Grotesk, Fraunces } from "next/font/google";
import "./globals.css";
import { Providers } from "../components/providers";
import { Nav } from "../components/nav";
import { WalletControls } from "../components/wallet-controls";

const heading = Fraunces({ subsets: ["latin"], variable: "--font-heading" });
const body = Space_Grotesk({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  metadataBase: new URL("https://zkhub.finance"),
  title: "zkhub",
  description: "Multi-chain intent-based money market",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    title: "zkhub",
    description: "Multi-chain intent-based money market",
    url: "https://zkhub.finance",
    siteName: "zkhub"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${heading.variable} ${body.variable}`}>
      <body>
        <Providers>
          <div className="site-shell">
            <header className="topbar">
              <div>
                <p className="eyebrow">zkhub</p>
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
