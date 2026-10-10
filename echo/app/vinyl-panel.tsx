'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '../lib/i18n';

const copy = {
  uk: { title: 'Ваша вінілова колекція', text: 'Альбоми, видання та музика — в одному місці.', loading: 'Відкриваємо колекцію…', retry: 'Відкрити ще раз', error: 'Не вдалося відкрити колекцію. Спробуйте ще раз.' },
  en: { title: 'Your vinyl collection', text: 'Albums, pressings and music — in one place.', loading: 'Opening your collection…', retry: 'Open again', error: 'Could not open your collection. Try again.' },
  ru: { title: 'Ваша виниловая коллекция', text: 'Альбомы, издания и музыка — в одном месте.', loading: 'Открываем коллекцию…', retry: 'Открыть ещё раз', error: 'Не удалось открыть коллекцию. Попробуйте ещё раз.' },
};

/** The complete tracker stays mounted: edits, filters and open dialogs survive tab switches. */
export default function VinylPanel({ locale, userId }: { locale: Locale; userId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const src = useMemo(() => `/vinyl/index.html?owner=${encodeURIComponent(userId || 'guest')}&locale=${locale}&reload=${revision}`, [userId, revision]);
  const c = copy[locale];

  useEffect(() => {
    setReady(false);
    setFailed(false);
    const timeout = window.setTimeout(() => setFailed(true), 30_000);
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'echo-vinyl-ready') { setReady(true); setFailed(false); window.clearTimeout(timeout); }
    }
    function refresh() { frame.current?.contentWindow?.postMessage({ type: 'echo-vinyl-refresh', locale }, window.location.origin); }
    window.addEventListener('message', receive);
    window.addEventListener('echo-vinyl-refresh', refresh);
    return () => { window.clearTimeout(timeout); window.removeEventListener('message', receive); window.removeEventListener('echo-vinyl-refresh', refresh); };
  }, [src, locale]);

  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'echo-vinyl-locale', locale }, window.location.origin); }, [locale]);

  return <section className="vinyl-workspace" aria-label={c.title}>
    <div className="vinyl-workspace-heading"><div><span className="eyebrow">ECHO / VINYL</span><h1>{c.title}</h1><p>{c.text}</p></div><span className="vinyl-workspace-disc" aria-hidden="true" /></div>
    {!ready && <div className="vinyl-workspace-loading" role="status"><span className={failed ? '' : 'vinyl-workspace-spinner'} />{failed ? c.error : c.loading}{failed && <button onClick={() => setRevision(n => n + 1)}>{c.retry}</button>}</div>}
    <iframe ref={frame} src={src} title={c.title} className="vinyl-workspace-frame" allow="autoplay; clipboard-write" />
  </section>;
}
