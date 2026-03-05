import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import "./globals.css";

export const metadata: Metadata = {
  title: "SellerBunker — Amazon Profit Dashboard",
  description: "Your Amazon profit, inventory, and ROI in one dashboard. Built for FBA & FBM sellers.",
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
    else if (window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
})();
`;

  return (
    <ClerkProvider
      appearance={{
        theme: shadcn,
      }}
      signInFallbackRedirectUrl="/start-trial"
      signUpFallbackRedirectUrl="/start-trial"
    >
      <html lang="en" suppressHydrationWarning>
        <head>
          <script
            dangerouslySetInnerHTML={{ __html: themeScript }}
          />
        </head>
        <body className="antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
