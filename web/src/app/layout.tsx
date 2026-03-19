import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import '../styles/tokens.css';
import { Sidebar } from '../components/layout/sidebar';

export const metadata: Metadata = {
  title: 'Motiva',
  description: 'AI Agent Orchestrator Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 ml-[120px] p-6">{children}</main>
      </body>
    </html>
  );
}
