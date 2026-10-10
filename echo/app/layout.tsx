import type { Metadata } from 'next';
import './globals.css';
import './home-v5.css';
import './cyber.css';
import './vinyl.css';
import './game-vinyl.css';
import { I18nProvider } from '@/lib/i18n';
export const metadata: Metadata = { title:'ECHO — Впізнаєш із перших секунд?', description:'Музичний квіз і колекція вінілу: впізнавай улюблені пісні та знаходь альбоми на платівках.', icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) {return <html lang="uk"><body><I18nProvider>{children}</I18nProvider></body></html>;}
