import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { Topbar } from "@/components/topbar";

export const metadata: Metadata = {
  title: "Seller Dashboard",
  description: "Seller Dashboard for Amazon",
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
    >
      <html lang="en" suppressHydrationWarning>
        <head>
          <script
            dangerouslySetInnerHTML={{ __html: themeScript }}
          />
        </head>
        <body className="antialiased">
          <MobileNav />
          <div className="hidden md:fixed md:inset-y-0 md:left-0 md:z-10 md:flex md:w-56">
            <Sidebar />
          </div>
          <main className="flex min-h-screen flex-col md:pl-56">
            <Topbar />
            <div className="min-h-0 flex-1">{children}</div>
          </main>
        </body>
      </html>
    </ClerkProvider>
  );
}
