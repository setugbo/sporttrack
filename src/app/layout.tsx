import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Virtual Football Match Tracker',
  description:
    'Collects SportyBet virtual football live scores and builds an independent historical results database for manual study.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0b0f14',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="container">
            <div className="brand">
              Virtual Football Match Tracker{' '}
              <span>&middot; data collection only</span>
            </div>
            <nav className="site-nav">
              <Link href="/">Dashboard</Link>
              <Link href="/debug">Raw data</Link>
              <a href="/api/health">Health</a>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}