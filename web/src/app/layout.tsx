import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WhyDunit — the clock is the cause",
  description:
    "Diagnoses why each failed UPI AutoPay debit actually failed, then executes a bounded recovery action matched to that cause.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@300;400;500&family=Schibsted+Grotesk:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
