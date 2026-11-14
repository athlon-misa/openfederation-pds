import type { Metadata } from "next";
import { Geist, Geist_Mono, Public_Sans, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AppearanceProvider } from "@/providers/appearance-provider";
import { appearanceScript } from "@/lib/appearance";
import { StoreHydration } from "@/components/store-hydration";
import { QueryProvider } from "@/providers/query-provider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const publicSans = Public_Sans({ variable: "--font-public-sans", subsets: ["latin"], display: "swap" });
const sourceSerif = Source_Serif_4({ variable: "--font-source-serif", subsets: ["latin"], display: "swap" });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "OpenFederation PDS",
  description: "Manage your OpenFederation communities",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="openfederation" suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${publicSans.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
    >
      <head><script dangerouslySetInnerHTML={{ __html: appearanceScript }} /></head>
      <body className="antialiased">
        <AppearanceProvider>
          <StoreHydration>
            <QueryProvider>
              {children}
              <Toaster />
            </QueryProvider>
          </StoreHydration>
        </AppearanceProvider>
      </body>
    </html>
  );
}
