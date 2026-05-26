import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import { Manrope } from "next/font/google";
import { Suspense } from "react";
import { RefAttribution } from "@/components/ref-attribution";
import "./globals.css";

const landingFont = Manrope({
  subsets: ["latin"],
  variable: "--font-landing",
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "SellerBunker — Amazon Profit Dashboard",
  description: "Your Amazon profit, inventory, and ROI in one dashboard. Built for FBA & FBM sellers.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const themeScript = `
(function() {
  var theme = 'dark';
  try {
    var stored = localStorage.getItem('theme');
    if (stored === 'dark' || stored === 'light') theme = stored;
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
})();
`;

  return (
    <ClerkProvider
      appearance={{
        theme: shadcn,
        layout: {
          logoImageUrl: "/sellerbunker-logo.png",
          logoLinkUrl: "/",
          // Hide "Development mode" / staging UI on Clerk dev instances (preview production-looking auth).
          unsafe_disableDevelopmentModeWarnings: true,
        },
        elements: {
          socialButtonsBlockButton__oauth_google: "!hidden",
          socialButtonsIconButton__oauth_google: "!hidden",
          otpCodeFieldInput: "!bg-white !text-neutral-900 !border-neutral-300",
        },
      }}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard?welcome=1"
      signUpForceRedirectUrl="/dashboard?welcome=1"
    >
      <html lang="en" suppressHydrationWarning>
        <head>
          {/* Google tag (gtag.js) */}
          <script
            async
            src="https://www.googletagmanager.com/gtag/js?id=G-HTBWFW5XFQ"
          />
          <script
            dangerouslySetInnerHTML={{
              __html: `
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', 'G-HTBWFW5XFQ');
              `,
            }}
          />
          <script
            dangerouslySetInnerHTML={{ __html: themeScript }}
          />
        </head>
        <body className={`${landingFont.variable} antialiased`}>
          <Suspense fallback={null}>
            <RefAttribution />
          </Suspense>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
