'use client';
import { useState, useEffect } from 'react';
import { Lock, Clock3, Loader2, Headphones, SlidersHorizontal, Check, X } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { useI18n } from '@/lib/i18n';
import { difficultyLevel, type Settings } from '@/lib/quiz';
import { difficultyCap, permitted, nextRequired, upgrades, type Progression } from '@/lib/progression';

export default function GameOptions({
  settings,
  onChange,
  progress,
  inGame = false,
  baseline,
  onUnlock,
  disabled = false,
}: {
  settings: Settings;
  onChange: (value: Settings) => void;
  progress?: Progression;
  inGame?: boolean;
  baseline?: Settings;
  onUnlock?: (id: string) => Promise<boolean>;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const level = difficultyLevel(settings.difficulty);
  const cap = difficultyCap(progress);
  const min = inGame ? difficultyLevel(baseline?.difficulty) : 1;
  const [preview, setPreview] = useState(level);
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    setPreview(level);
  }, [level]);

  const buy = async (id: string, apply: () => void) => {
    if (disabled || buying || !onUnlock) return;
    const next = nextRequired(id, progress) ?? id;
    setBuying(next);
    try {
      if (await onUnlock(next)) {
        if (next === id) apply();
      }
    } finally {
      setBuying(null);
    }
  };

  const labels = {
    uk: {
      difficulty: 'СКЛАДНІСТЬ',
      duration: 'ЧАС ПРОСЛУХОВУВАННЯ',
      timer: 'ЧАС НА ВІДПОВІДЬ',
      sec: 'с',
      yes: 'ТАК',
      no: 'НІ',
    },
    en: {
      difficulty: 'DIFFICULTY',
      duration: 'LISTEN TIME',
      timer: 'ANSWER TIMER',
      sec: 's',
      yes: 'YES',
      no: 'NO',
    },
    ru: {
      difficulty: 'СЛОЖНОСТЬ',
      duration: 'ВРЕМЯ ПРОСЛУШИВАНИЯ',
      timer: 'ВРЕМЯ НА ОТВЕТ',
      sec: 'с',
      yes: 'ДА',
      no: 'НЕТ',
    },
  }[locale];

  const price = (id: string) => {
    const next = nextRequired(id, progress) ?? id;
    const upgrade = upgrades.find((u) => u.id === next);
    return (
      <span className="nb-lock-tag">
        <Lock size={12} />
        {upgrade?.cost ?? 0} XP
      </span>
    );
  };

  return (
    <div className="options-v7 options-v9 nb-visual-options">
      {/* СЛОЖНОСТЬ: только красивый ползунок 1..10 под стиль, без лишнего описания */}
      <div className="difficulty-slider-tile nb-opt-card">
        <div className="nb-opt-head">
          <span className="nb-opt-title">
            <SlidersHorizontal size={15} />
            <span>{labels.difficulty}</span>
          </span>
          <b className="nb-opt-badge">{preview} / 10</b>
        </div>

        <div className="nb-slider-wrap">
          <Slider
            aria-label={labels.difficulty}
            min={1}
            max={10}
            step={1}
            disabled={disabled || !!buying}
            value={[preview]}
            onValueChange={([value]) => {
              const desired = Math.max(min, value);
              setPreview(desired);
              if (desired <= cap) onChange({ ...settings, difficulty: desired });
            }}
          />
          <div className="nb-slider-ticks" aria-hidden="true">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
              <span
                key={num}
                className={num <= preview ? 'active' : ''}
                onClick={() => {
                  if (disabled || !!buying) return;
                  const desired = Math.max(min, num);
                  setPreview(desired);
                  if (desired <= cap) onChange({ ...settings, difficulty: desired });
                }}
              >
                {num}
              </span>
            ))}
          </div>
        </div>

        {preview > cap && (
          <button
            type="button"
            className="locked-setting"
            onClick={() =>
              void buy(`difficulty-${preview}`, () =>
                onChange({ ...settings, difficulty: preview })
              )
            }
            disabled={disabled || !!buying || !onUnlock}
          >
            {buying ? <Loader2 className="spin" size={14} /> : price(`difficulty-${preview}`)}
          </button>
        )}
      </div>

      <div className="setup-columns nb-opt-columns">
        {/* ВРЕМЯ ПРОСЛУШИВАНИЯ: только цифра в секундах (7с / 5с / 3с) */}
        <div className="setup-group nb-opt-card">
          <div className="nb-opt-head">
            <span className="nb-opt-title">
              <Headphones size={15} />
              <span>{labels.duration}</span>
            </span>
          </div>
          <div className="duration-options nb-sec-grid">
            {([7, 5, 3] as const).map((seconds) => {
              const id = `duration-${seconds}`;
              const locked = seconds !== 7 && !permitted(id, progress);
              return (
                <button
                  type="button"
                  aria-pressed={settings.duration === seconds}
                  className={`option-box nb-sec-pill ${
                    settings.duration === seconds ? 'selected' : ''
                  } ${locked ? 'locked' : ''}`}
                  key={seconds}
                  disabled={
                    disabled || !!buying || (inGame && seconds > (baseline?.duration ?? 7))
                  }
                  onClick={() =>
                    locked
                      ? void buy(id, () => onChange({ ...settings, duration: seconds }))
                      : onChange({ ...settings, duration: seconds })
                  }
                >
                  <strong>
                    {seconds}
                    <small>{labels.sec}</small>
                  </strong>
                  {locked && price(id)}
                </button>
              );
            })}
          </div>
        </div>

        {/* ВРЕМЯ НА ОТВЕТ: просто переключатель ДА / НЕТ */}
        <div className="setup-group nb-opt-card">
          <div className="nb-opt-head">
            <span className="nb-opt-title">
              <Clock3 size={15} />
              <span>{labels.timer}</span>
            </span>
          </div>
          <div className="timer-tiles nb-yesno-grid">
            {([true, false] as const).map((value) => {
              const locked = value && !permitted('timer', progress);
              const selected = settings.timer === value;
              return (
                <button
                  type="button"
                  aria-pressed={selected}
                  className={`timer-tile nb-yesno-pill ${selected ? 'selected' : ''}`}
                  key={String(value)}
                  disabled={disabled || !!buying || (!value && inGame && !!baseline?.timer)}
                  onClick={() =>
                    locked
                      ? void buy('timer', () => onChange({ ...settings, timer: true }))
                      : onChange({ ...settings, timer: value })
                  }
                >
                  {value ? <Check size={16} /> : <X size={16} />}
                  <strong>{value ? labels.yes : labels.no}</strong>
                  {locked && price('timer')}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
