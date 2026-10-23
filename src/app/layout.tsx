import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OSS Contributor',
  description: 'Operator dashboard for the autonomous open-source contribution agent',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
