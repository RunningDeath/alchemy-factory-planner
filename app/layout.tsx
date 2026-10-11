import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Cinzel } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { ThemeInitializer } from "@/components/ui/ThemeInitializer";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const siteUrl = "https://alchemyfactorytools.com";
const siteName = "Alchemy Factory Tools";
const siteDescription =
  "Free production planner and calculator for Alchemy Factory. Plan crafting chains, optimize factory layouts, and calculate resource requirements for the Steam factory-building game.";

export const metadata: Metadata = {
  title: {
    default: "Alchemy Factory Tools - Production Planner & Calculator",
    template: "%s | Alchemy Factory Tools",
  },
  description: siteDescription,
  keywords: [
    "alchemy factory",
    "alchemy factory calculator",
    "alchemy factory planner",
    "alchemy factory production planner",
    "alchemy factory crafting",
    "alchemy factory recipes",
    "alchemy factory guide",
    "factory builder game",
    "production calculator",
    "crafting calculator",
  ],
  authors: [
    { name: "RunningDeath", url: "https://github.com/RunningDeath" },
    { name: "moldy530", url: "https://github.com/moldy530" },
  ],
  creator: "RunningDeath",
  metadataBase: new URL(siteUrl),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: siteName,
    title: "Alchemy Factory Tools - Production Planner & Calculator",
    description: siteDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: "Alchemy Factory Tools - Production Planner & Calculator",
    description: siteDescription,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Alchemy Factory Tools",
    description: siteDescription,
    url: siteUrl,
    applicationCategory: "GameApplication",
    operatingSystem: "Web Browser",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    author: [
      {
        "@type": "Person",
        name: "RunningDeath",
        url: "https://github.com/RunningDeath",
      },
      {
        "@type": "Person",
        name: "moldy530",
        url: "https://github.com/moldy530",
      },
    ],
    about: {
      "@type": "VideoGame",
      name: "Alchemy Factory",
      gamePlatform: "Steam",
      genre: "Factory Builder",
    },
  };

  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${cinzel.variable} antialiased min-h-screen flex flex-col`}
      >
        <ThemeInitializer />
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <footer className="py-4 border-t border-[var(--border)] text-center text-sm text-[var(--text-muted)] bg-[var(--background)]">
          <p className="mb-3 max-w-2xl mx-auto px-4">
            A free production planner for{" "}
            <a
              href="https://store.steampowered.com/app/2708770/Alchemy_Factory/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-gold)] hover:underline"
            >
              Alchemy Factory
            </a>
            . Plan crafting chains, calculate resource requirements, and optimize your factory layouts.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <a
              href="https://github.com/RunningDeath/alchemy-factory-planner"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--accent-gold)] transition-colors flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              View on GitHub
            </a>
            <span className="text-[var(--border)]">|</span>
            <span>
              Fork maintained by{" "}
              <a
                href="https://github.com/RunningDeath"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--accent-gold)] transition-colors"
              >
                @RunningDeath
              </a>
              {" "}&middot; based on the original by{" "}
              <a
                href="https://github.com/moldy530/alchemy-factory-planner"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--accent-gold)] transition-colors"
              >
                @moldy530
              </a>
            </span>
          </div>
        </footer>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
