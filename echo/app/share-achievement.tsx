'use client';

import { useState } from 'react';
import { Check, Copy, Download, Loader2, Share2 } from 'lucide-react';
import { useI18n, type TranslationArgs } from '@/lib/i18n';
export type Achievement = { practice?:boolean; correct: number; total: number; score: number; xpAwarded: number; collectionTitle: string };
type Props = { achievement: Achievement; compact?: boolean };

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, weight = 700) {
  let actual = size; context.font = `${weight} ${actual}px Inter, Segoe UI, Arial, sans-serif`;
  while (actual > 23 && context.measureText(text).width > maxWidth) { actual -= 1; context.font = `${weight} ${actual}px Inter, Segoe UI, Arial, sans-serif`; }
  return actual;
}
function wrapText(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number, maxLines: number) {
  const words = text.split(/\s+/); let line = '', row = 0;
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (context.measureText(candidate).width > width && line) {
      context.fillText(line, x, y + row * lineHeight); row++; line = words[i];
      if (row >= maxLines - 1) { const rest = [line, ...words.slice(i + 1)].join(' '); let last = rest; while (context.measureText(`${last}…`).width > width && last.length) last = last.slice(0, -1); context.fillText(last === rest ? rest : `${last}…`, x, y + row * lineHeight); return; }
    } else line = candidate;
  }
  if (line) context.fillText(line, x, y + row * lineHeight);
}
export async function createAchievementBanner(achievement: Achievement, t: (key: string, args?: TranslationArgs) => string, locale: string, url: string): Promise<Blob> {
  await document.fonts?.ready;
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1080;
  const context = canvas.getContext('2d'); if (!context) throw new Error(t('share.error'));
  const background = context.createLinearGradient(0, 0, 1080, 1080); background.addColorStop(0, '#0f1730'); background.addColorStop(.48, '#212562'); background.addColorStop(1, '#6639bb');
  context.fillStyle = background; context.fillRect(0, 0, 1080, 1080);
  const glow = context.createRadialGradient(940, 120, 0, 940, 120, 740); glow.addColorStop(0, '#5797ff99'); glow.addColorStop(1, '#5797ff00'); context.fillStyle = glow; context.fillRect(0, 0, 1080, 1080);
  context.strokeStyle = '#ffffff18'; context.lineWidth = 2;
  for (const radius of [170, 245, 320, 395]) { context.beginPath(); context.arc(980, 390, radius, 0, Math.PI * 2); context.stroke(); }
  context.textBaseline = 'alphabetic'; context.fillStyle = '#ffffff'; context.font = '800 76px Inter, Segoe UI, Arial, sans-serif'; context.fillText('echo', 76, 144);
  context.fillStyle = '#d8fc71'; context.fillText('.', 267, 144);
  context.fillStyle = '#cfd4ef'; context.font = '500 23px Inter, Segoe UI, Arial, sans-serif'; context.fillText(t('share.title'), 78, 204);
  context.fillStyle = '#ffffff'; fitText(context, achievement.collectionTitle, 900, 42); wrapText(context, achievement.collectionTitle, 78, 281, 900, 50, 2);
  context.fillStyle = '#ffffff0c'; context.beginPath(); context.roundRect(76, 359, 928, 316, 28); context.fill();
  context.fillStyle = '#d8fc71'; context.font = '750 152px Inter, Segoe UI, Arial, sans-serif';
  const score = achievement.practice?`${achievement.correct} / ${achievement.total}`:new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(achievement.score);
  fitText(context, score, 620, 152, 750); context.fillText(score, 112, 518);
  context.fillStyle = '#c6cdec'; context.font = '600 22px Inter, Segoe UI, Arial, sans-serif'; context.fillText(t(achievement.practice?'share.guessed':'share.score'), 116, 564);
  context.fillStyle = '#ffffff'; context.font = '700 42px Inter, Segoe UI, Arial, sans-serif'; context.fillText(`${achievement.correct} / ${achievement.total}`, 113, 628);
  context.fillStyle = '#c6cdec'; context.font = '600 20px Inter, Segoe UI, Arial, sans-serif'; context.fillText(t('share.guessed'), 370, 626);
  if(!achievement.practice){  context.fillStyle = '#c6cdec'; fitText(context, `${achievement.xpAwarded > 0 ? '+' : ''}${new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(achievement.xpAwarded)} XP`, 180, 25); context.textAlign = 'right'; context.fillText(`${achievement.xpAwarded > 0 ? '+' : ''}${new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(achievement.xpAwarded)} XP`, 972, 645); context.textAlign = 'left';
}
  context.save(); context.translate(847, 498); context.rotate(-.08);
  context.strokeStyle = '#d8fc71'; context.lineWidth = 8; context.beginPath(); context.arc(0, 0, 86, 0, Math.PI * 2); context.stroke();
  context.lineWidth = 3; context.beginPath(); context.arc(0, 0, 58, 0, Math.PI * 2); context.stroke();
  context.fillStyle = '#d8fc71'; context.beginPath(); context.arc(0, 0, 14, 0, Math.PI * 2); context.fill(); context.restore();
  context.fillStyle = '#ffffff'; fitText(context, t('share.cta'), 918, 43); context.fillText(t('share.cta'), 78, 770);
  context.fillStyle = '#d8fc71'; context.beginPath(); context.roundRect(76, 824, 928, 104, 20); context.fill();
  context.fillStyle = '#17230d'; fitText(context, t('share.free'), 826, 34); context.textAlign = 'center'; context.fillText(t('share.free'), 540, 891); context.textAlign = 'left';
  context.fillStyle = '#d9def4'; fitText(context, url.replace(/^https?:\/\//, '').replace(/\/$/, ''), 926, 24, 500); context.fillText(url.replace(/^https?:\/\//, '').replace(/\/$/, ''), 78, 993);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('share.error'))), 'image/png'));
}

export default function ShareAchievement({ achievement, compact = false }: Props) {
  const { locale, t } = useI18n(); const [busy, setBusy] = useState<string | null>(null), [status, setStatus] = useState('');
  const url = () => 'https://echo-music-quiz-danil.everesko1.chatgpt.site/';
  const downloadBlob = (blob: Blob) => { const object = URL.createObjectURL(blob), link = document.createElement('a'); link.href = object; link.download = 'echo-result.png'; link.click(); window.setTimeout(() => URL.revokeObjectURL(object), 1000); };
  const run = async (action: 'share' | 'download' | 'copy') => {
    if (busy) return; setBusy(action); setStatus('');
    try {
      if (action === 'copy') { await navigator.clipboard.writeText(url()); setStatus(t('share.copied')); return; }
      const blob = await createAchievementBanner(achievement, t, locale, url());
      const file = new File([blob], 'echo-result.png', { type: 'image/png' });
      if (action === 'share' && navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: t('share.title'), text: t(achievement.practice?'share.practiceText':'share.text', { correct: achievement.correct, total: achievement.total, score: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(achievement.score) }), url: url() });
      } else { downloadBlob(blob); setStatus(t('share.saved')); }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus(t('share.error')); }
    finally { setBusy(null); }
  };
  return <div className={`achievement-share ${compact ? 'compact' : ''}`}><div className="achievement-share-actions">
    <button className="button-primary" disabled={!!busy} onClick={() => void run('share')}>{busy === 'share' ? <Loader2 className="spin" size={17} /> : <Share2 size={17} />}{t('share.button')}</button>
    <button className="share-icon-button" disabled={!!busy} onClick={() => void run('download')} aria-label={t('share.download')} title={t('share.download')}>{busy === 'download' ? <Loader2 className="spin" size={17} /> : <Download size={17} />}</button>
    <button className="share-icon-button" disabled={!!busy} onClick={() => void run('copy')} aria-label={t('share.copy')} title={t('share.copy')}>{busy === 'copy' ? <Loader2 className="spin" size={17} /> : <Copy size={17} />}</button>
  </div>{status && <p className="share-status" role="status"><Check size={14} />{status}</p>}</div>;
}
