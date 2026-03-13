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
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
})();
`;

  return (
    <ClerkProvider
      appearance={{
        theme: shadcn,
      }}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/start-trial"
      signUpFallbackRedirectUrl="/start-trial"
      signUpForceRedirectUrl="/start-trial"
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
        <body className="antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
