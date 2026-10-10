'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Check, Disc3, Loader2, Search, UserRound, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {request as clientRequest,RequestError} from './client-request';
export type ArtistChoice = { id: string; name: string; image?: string; fans?: number; source?: string };
type Page = { artists: ArtistChoice[]; nextCursor: number | null; total?: number;needsDiscovery?:boolean;discovered?:boolean };
type Props = { selected: ArtistChoice[]; onChange: (artists: ArtistChoice[]) => void; onCreate: () => void; busy?: boolean; disabled?: boolean };

export default function ArtistPicker({ selected, onChange, onCreate, busy = false, disabled = false }: Props) {
  const { t } = useI18n(); const [query, setQuery] = useState(''), [artists, setArtists] = useState<ArtistChoice[]>([]), [nextCursor, setNextCursor] = useState<number | null>(null);
  const [sort,setSort]=useState('popular');
  const [loading, setLoading] = useState(true), [moreLoading, setMoreLoading] = useState(false), [error, setError] = useState('');
  const [discovering,setDiscovering]=useState(false),[discovered,setDiscovered]=useState(false);
  const activeQuery = useRef(''), request = useRef<AbortController | null>(null), generation = useRef(0), locked = useRef(false);
  useEffect(() => {
    const version = ++generation.current, controller = new AbortController(); request.current?.abort(); request.current = controller; locked.current = false;
    const timeout = window.setTimeout(async () => {
      activeQuery.current = query.trim(); setLoading(true); setError(''); setMoreLoading(false);setDiscovering(false);setDiscovered(false);
      try {
        const response = await fetch(`/api/artists?q=${encodeURIComponent(query.trim())}&cursor=0&limit=24&sort=${sort}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        let payload = await response.json() as Page & { message?: string };
        if (!response.ok) throw new Error(payload.message || t('request.error'));
        if(payload.needsDiscovery&&!controller.signal.aborted&&generation.current===version){
          setDiscovering(true);
          try{const expanded=await clientRequest<Page>('/api/artists/discover',{query:query.trim()},'POST',controller.signal);if(expanded.artists.length)payload=expanded;else payload={artists:[],nextCursor:null};}
          catch(error){if(!controller.signal.aborted&&generation.current===version){setError(error instanceof RequestError&&['GEMINI_NOT_CONFIGURED','GEMINI_FREE_TIER_REQUIRED'].includes(error.code)?t('artists.discoverySetup'):error instanceof RequestError&&t('cloud.'+error.code)!=='cloud.'+error.code?t('cloud.'+error.code):t('request.error'));payload={artists:[],nextCursor:null};}}
        }
        if (!controller.signal.aborted && generation.current === version) { setArtists(payload.artists); setNextCursor(payload.nextCursor);setDiscovered(!!payload.discovered); }
      } catch { if (!controller.signal.aborted && generation.current === version) { setError(t('request.error')); setArtists([]); setNextCursor(null); } }
      finally { if (!controller.signal.aborted && generation.current === version){setLoading(false);setDiscovering(false);} }
    }, query.trim() ? 300 : 0);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [query, sort, t]);
  const loadMore = async () => {
    if (nextCursor === null || locked.current || loading) return; locked.current = true; setMoreLoading(true); setError(''); const version = generation.current, signal = request.current?.signal;
    try {
      const response = await fetch(`/api/artists?q=${encodeURIComponent(activeQuery.current)}&cursor=${nextCursor}&limit=24&sort=${sort}`, { credentials: 'same-origin', cache: 'no-store', signal });
      const payload = await response.json() as Page & { message?: string }; if (!response.ok) throw new Error(payload.message || t('request.error'));
      if (!signal?.aborted && generation.current === version) { setArtists(previous => [...previous, ...payload.artists.filter(item => !previous.some(old => old.id === item.id))]); setNextCursor(payload.nextCursor); }
    } catch { if (!signal?.aborted && generation.current === version) setError(t('request.error')); }
    finally { if (generation.current === version) { locked.current = false; setMoreLoading(false); } }
  };
  const toggle = (artist: ArtistChoice) => onChange(selected.some(item => item.id === artist.id) ? selected.filter(item => item.id !== artist.id) : [...selected, artist]);
  return <div className="artist-picker"><div className="artist-picker-heading"><div><h3>{t('artists.title')}</h3><p>{t('artists.description')}</p></div><label className="artist-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('artists.search')} aria-label={t('artists.search')} maxLength={100} /></label></div>
    <div className="artist-browse-controls"><button className="filter-chip" onClick={()=>setQuery(t("artists.uaQuery"))}>🇺🇦 {t("artists.ua")}</button><select value={sort} onChange={e=>setSort(e.target.value)} aria-label={t("artists.sort")}><option value="popular">{t("artists.popular")}</option><option value="name">{t("artists.alphabetical")}</option></select></div>
    {selected.length > 0 && <div className="selected-artists" aria-label={t('artists.selected', { count: selected.length })}>{selected.map(artist => <button key={artist.id} className="selected-artist" onClick={() => toggle(artist)} disabled={busy} aria-label={t('artists.remove', { name: artist.name })}>{artist.name}<X size={13} /></button>)}<button className="artist-clear" onClick={() => onChange([])} disabled={busy}>{t('artists.clear')}</button></div>}
    {error && <p className="artist-error" role="alert">{error}</p>}
    {discovered&&!loading&&<p className="artist-added" role="status">{t('artists.discovered')}</p>}
    {loading ? <div className="artist-loading" role="status"><Loader2 className="spin" size={22} />{t(discovering?'artists.discovering':'artists.loading')}</div> : <><div className="artist-portrait-grid">{artists.map(artist => { const picked = selected.some(item => item.id === artist.id); return <button key={artist.id} className={`artist-portrait ${picked ? 'selected' : ''}`} onClick={() => toggle(artist)} disabled={busy} aria-pressed={picked} aria-label={t(picked ? 'artists.remove' : 'artists.add', { name: artist.name })}><span className="artist-portrait-image">{artist.image ? <Image src={artist.image} fill sizes="(max-width: 650px) 28vw, 120px" alt="" unoptimized /> : <UserRound size={36} />}<span className="artist-check">{picked ? <Check size={16} /> : '+'}</span><span className="artist-hover-name">{artist.name}</span></span><span className="artist-caption">{artist.name}</span></button>; })}</div>{!artists.length && <p className="artist-empty">{t('artists.none')}</p>}</>}
    <div className="artist-picker-footer"><span>{t('artists.selected', { count: selected.length })}</span>{nextCursor !== null && !loading && <button className="button-secondary" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading && <Loader2 className="spin" size={15} />}{t('artists.more')}</button>}<button className="button-primary" disabled={!selected.length || busy || disabled} onClick={onCreate}>{busy ? <Loader2 className="spin" size={17} /> : <Disc3 size={17} />}{t('artists.create')}</button></div>
  </div>;
}
