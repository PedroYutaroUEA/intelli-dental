import { GlobalLoadingBar } from "@/components/global-loading-bar";
import { Analytics } from "@vercel/analytics/next";
import { Inter } from "next/font/google";
import { JetBrains_Mono } from "next/font/google";
import type { Metadata } from "next";
import type React from "react";
import { Suspense } from "react";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Intelli Dental",
  description: "Sistema Inteligente de gestão para clínicas odontológicas",
  generator: "v0.app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`font-sans ${inter.variable} ${jetbrainsMono.variable}`}>
        <GlobalLoadingBar />
        <Suspense fallback={null}>{children}</Suspense>
        <Analytics />
      </body>
    </html>
  );
}
