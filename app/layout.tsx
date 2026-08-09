import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tamil ↔ Hindi Translator",
  description: "Two-way voice translation between Tamil and Hindi.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximumScale — users must be able to pinch-zoom the translated text.
  // Gesture interference on the buttons is handled by touch-action: none in CSS.
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
