'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { GenerationState } from './generation-progress';

type ArcadeGameId = 'flappy' | 'sudoku' | 'mines' | 'doodle' | 'snake';

interface SudokuCell {
  sol: number;
  val: number;
  fixed: boolean;
  error: boolean;
}

interface MineCell {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adj: number;
}

const SUDOKU_SYMBOLS = ['', '♩', '♪', '♫', '♬', '🎧', '🎹', '🎸', '🎷', '💿'];

export default function ArcadeHub({
  open,
  onClose,
  generationState,
  generating,
  onCancelGeneration,
  readyToEnter,
  readyCount,
  onEnterReady,
}: {
  open: boolean;
  onClose: () => void;
  generationState?: GenerationState | null;
  generating?: boolean;
  onCancelGeneration?: () => void;
  readyToEnter?: boolean;
  readyCount?: number;
  onEnterReady?: () => void;
}) {
  const [activeGame, setActiveGame] = useState<ArcadeGameId>('flappy');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open || !generating) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open, generating]);

  // ==================== 1. FLAPPY NOTE ====================
  const flappyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const flappyRafRef = useRef<number | null>(null);
  const [flappyRunning, setFlappyRunning] = useState(false);
  const [flappyGameOver, setFlappyGameOver] = useState(false);
  const [flappyScore, setFlappyScore] = useState(0);
  const [flappyBest, setFlappyBest] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return parseInt(localStorage.getItem('echo_flappy_best') || '0', 10) || 0;
  });
  const flappyStateRef = useRef({
    noteX: 120,
    noteY: 150,
    velY: 0,
    gravity: 0.33,
    jump: -6.2,
    trail: [] as { x: number; y: number; alpha: number }[],
    pipes: [] as { x: number; w: number; topH: number; bottomY: number; passed: boolean }[],
    frame: 0,
  });

  const renderFlappy = useCallback(() => {
    const canvas = flappyCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const st = flappyStateRef.current;
    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#181411';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(244, 235, 220, 0.07)';
    ctx.lineWidth = 1;
    for (let x = -((st.frame * 1.5) % 32); x < W; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y < H; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    for (const p of st.pipes) {
      ctx.fillStyle = '#ea631f';
      ctx.strokeStyle = '#181411';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(p.x, -2, p.w, p.topH + 2, [0, 0, 10, 10]);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f2b735';
      ctx.beginPath();
      ctx.roundRect(p.x, p.bottomY, p.w, H - p.bottomY + 2, [10, 10, 0, 0]);
      ctx.fill();
      ctx.stroke();
    }

    for (const tr of st.trail) {
      ctx.fillStyle = `rgba(234, 99, 31, ${tr.alpha * 0.55})`;
      ctx.beginPath();
      ctx.arc(tr.x, tr.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(st.noteX, st.noteY);
    ctx.rotate(Math.max(-0.4, Math.min(0.4, st.velY * 0.05)));
    ctx.fillStyle = '#181411';
    ctx.beginPath();
    ctx.arc(3, 3, 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f4ebdc';
    ctx.strokeStyle = '#181411';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#181411';
    ctx.font = '900 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', 0, 1);
    ctx.restore();
  }, []);

  const stopAllLoops = useCallback(() => {
    if (flappyRafRef.current) {
      cancelAnimationFrame(flappyRafRef.current);
      flappyRafRef.current = null;
    }
    if (doodleRafRef.current) {
      cancelAnimationFrame(doodleRafRef.current);
      doodleRafRef.current = null;
    }
    if (snakeTimerRef.current) {
      clearInterval(snakeTimerRef.current);
      snakeTimerRef.current = null;
    }
    setFlappyRunning(false);
    setDoodleRunning(false);
    setSnakeRunning(false);
  }, []);

  const flapNote = useCallback(() => {
    if (!flappyRunning) {
      setFlappyRunning(true);
      setFlappyGameOver(false);
      setFlappyScore(0);
      flappyStateRef.current = {
        noteX: 120,
        noteY: 150,
        velY: -5.5,
        gravity: 0.33,
        jump: -6.2,
        trail: [],
        pipes: [],
        frame: 0,
      };
      const loop = () => {
        const st = flappyStateRef.current;
        const W = 640;
        const H = 300;
        st.frame++;
        st.velY += st.gravity;
        st.noteY += st.velY;

        st.trail.push({ x: st.noteX, y: st.noteY, alpha: 0.75 });
        if (st.trail.length > 12) st.trail.shift();
        for (const t of st.trail) {
          t.x -= 3.1;
          t.alpha *= 0.88;
        }

        if (st.frame % 80 === 1) {
          const gap = 104;
          const topH = Math.floor(34 + Math.random() * (H - gap - 68));
          st.pipes.push({ x: W + 20, w: 44, topH, bottomY: topH + gap, passed: false });
        }

        const r = 13;
        for (let i = st.pipes.length - 1; i >= 0; i--) {
          const p = st.pipes[i];
          p.x -= 3.1;
          if (!p.passed && p.x + p.w < st.noteX) {
            p.passed = true;
            setFlappyScore((prev) => {
              const next = prev + 1;
              setFlappyBest((b) => {
                const best = Math.max(b, next);
                try {
                  localStorage.setItem('echo_flappy_best', String(best));
                } catch {}
                return best;
              });
              return next;
            });
          }
          if (st.noteX + r > p.x && st.noteX - r < p.x + p.w) {
            if (st.noteY - r < p.topH || st.noteY + r > p.bottomY) {
              setFlappyRunning(false);
              setFlappyGameOver(true);
              renderFlappy();
              return;
            }
          }
          if (p.x + p.w < -20) st.pipes.splice(i, 1);
        }

        if (st.noteY + r >= H - 4 || st.noteY - r <= 4) {
          setFlappyRunning(false);
          setFlappyGameOver(true);
          renderFlappy();
          return;
        }

        renderFlappy();
        flappyRafRef.current = requestAnimationFrame(loop);
      };
      flappyRafRef.current = requestAnimationFrame(loop);
      return;
    }
    flappyStateRef.current.velY = flappyStateRef.current.jump;
  }, [flappyRunning, renderFlappy]);

  // ==================== 2. SUDOKU 9x9 ====================
  const [sudokuBoard, setSudokuBoard] = useState<SudokuCell[]>([]);
  const [selectedSudokuIdx, setSelectedSudokuIdx] = useState<number>(0);
  const [sudokuMistakes, setSudokuMistakes] = useState(0);
  const [sudokuWon, setSudokuWon] = useState(false);
  const [sudokuIcons, setSudokuIcons] = useState(false);

  const initSudoku = useCallback(() => {
    const base = [
      1, 2, 3, 4, 5, 6, 7, 8, 9,
      4, 5, 6, 7, 8, 9, 1, 2, 3,
      7, 8, 9, 1, 2, 3, 4, 5, 6,
      2, 3, 1, 5, 6, 4, 8, 9, 7,
      5, 6, 4, 8, 9, 7, 2, 3, 1,
      8, 9, 7, 2, 3, 1, 5, 6, 4,
      3, 1, 2, 6, 4, 5, 9, 7, 8,
      6, 4, 5, 9, 7, 8, 3, 1, 2,
      9, 7, 8, 3, 1, 2, 6, 4, 5,
    ];
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (let i = digits.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [digits[i], digits[j]] = [digits[j], digits[i]];
    }
    const cells: SudokuCell[] = base.map((v) => {
      const sol = digits[v - 1];
      const fixed = Math.random() > 0.45;
      return { sol, val: fixed ? sol : 0, fixed, error: false };
    });
    setSudokuBoard(cells);
    setSudokuMistakes(0);
    setSudokuWon(false);
    setSelectedSudokuIdx(cells.findIndex((c) => !c.fixed));
  }, []);

  const inputSudokuNumber = useCallback(
    (num: number) => {
      if (sudokuWon || selectedSudokuIdx < 0) return;
      setSudokuBoard((prev) => {
        const target = prev[selectedSudokuIdx];
        if (!target || target.fixed) return prev;
        const next = [...prev];
        if (num === 0) {
          next[selectedSudokuIdx] = { ...target, val: 0, error: false };
          return next;
        }
        const isErr = num !== target.sol;
        if (isErr) setSudokuMistakes((m) => m + 1);
        next[selectedSudokuIdx] = { ...target, val: num, error: isErr };
        if (next.every((c) => c.val === c.sol)) setSudokuWon(true);
        return next;
      });
    },
    [selectedSudokuIdx, sudokuWon]
  );

  const giveSudokuHint = useCallback(() => {
    if (sudokuWon) return;
    setSudokuBoard((prev) => {
      let idx = selectedSudokuIdx;
      if (idx < 0 || prev[idx]?.fixed || prev[idx]?.val === prev[idx]?.sol) {
        idx = prev.findIndex((c) => !c.fixed && c.val !== c.sol);
      }
      if (idx < 0) return prev;
      setSelectedSudokuIdx(idx);
      const next = [...prev];
      next[idx] = { ...next[idx], val: next[idx].sol, error: false };
      if (next.every((c) => c.val === c.sol)) setSudokuWon(true);
      return next;
    });
  }, [selectedSudokuIdx, sudokuWon]);

  // ==================== 3. MINESWEEPER ====================
  const [minesGrid, setMinesGrid] = useState<MineCell[]>([]);
  const [minesFlagMode, setMinesFlagMode] = useState(false);
  const [minesGameOver, setMinesGameOver] = useState(false);
  const [minesWon, setMinesWon] = useState(false);
  const minesCount = 7;

  const initMines = useCallback(() => {
    const total = 48;
    const cells: MineCell[] = Array.from({ length: total }, () => ({
      mine: false,
      revealed: false,
      flagged: false,
      adj: 0,
    }));
    let placed = 0;
    while (placed < minesCount) {
      const idx = Math.floor(Math.random() * total);
      if (!cells[idx].mine) {
        cells[idx].mine = true;
        placed++;
      }
    }
    for (let i = 0; i < total; i++) {
      if (cells[i].mine) continue;
      const r = Math.floor(i / 8);
      const c = i % 8;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < 6 && nc >= 0 && nc < 8 && cells[nr * 8 + nc].mine) count++;
        }
      }
      cells[i].adj = count;
    }
    setMinesGrid(cells);
    setMinesGameOver(false);
    setMinesWon(false);
  }, []);

  const clickMineCell = (idx: number, forceFlag = false) => {
    if (minesGameOver) return;
    setMinesGrid((prev) => {
      const next = prev.map((c) => ({ ...c }));
      const cell = next[idx];
      if (!cell || cell.revealed) return prev;
      if (forceFlag || minesFlagMode) {
        cell.flagged = !cell.flagged;
        return next;
      }
      if (cell.flagged) return prev;
      cell.revealed = true;
      if (cell.mine) {
        next.forEach((c) => {
          if (c.mine) c.revealed = true;
        });
        setMinesGameOver(true);
        setMinesWon(false);
        return next;
      }
      if (cell.adj === 0) {
        const q = [idx];
        while (q.length > 0) {
          const curr = q.shift()!;
          const r = Math.floor(curr / 8);
          const c = curr % 8;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < 6 && nc >= 0 && nc < 8) {
                const nIdx = nr * 8 + nc;
                const nb = next[nIdx];
                if (!nb.revealed && !nb.mine && !nb.flagged) {
                  nb.revealed = true;
                  if (nb.adj === 0) q.push(nIdx);
                }
              }
            }
          }
        }
      }
      if (next.filter((c) => !c.mine && !c.revealed).length === 0) {
        setMinesGameOver(true);
        setMinesWon(true);
      }
      return next;
    });
  };

  // ==================== 4. DOODLE JUMP ====================
  const doodleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const doodleRafRef = useRef<number | null>(null);
  const [doodleRunning, setDoodleRunning] = useState(false);
  const [doodleGameOver, setDoodleGameOver] = useState(false);
  const [doodleScore, setDoodleScore] = useState(0);
  const doodleStateRef = useRef({
    x: 320,
    y: 210,
    targetX: 320,
    vy: -7,
    gravity: 0.25,
    bounce: -8.0,
    platforms: [] as { x: number; y: number; w: number; h: number }[],
  });

  const renderDoodle = useCallback(() => {
    const canvas = doodleCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const st = doodleStateRef.current;
    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#181411';
    ctx.fillRect(0, 0, W, H);

    for (const p of st.platforms) {
      ctx.fillStyle = '#ea631f';
      ctx.strokeStyle = '#f4ebdc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, 6);
      ctx.fill();
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.fillStyle = '#f2b735';
    ctx.strokeStyle = '#181411';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#181411';
    ctx.font = '900 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♫', 0, 1);
    ctx.restore();
  }, []);

  const initDoodle = useCallback(() => {
    const platforms = Array.from({ length: 7 }, (_, i) => ({
      x: 70 + Math.random() * 460,
      y: 42 * i + 28,
      w: 78,
      h: 12,
    }));
    doodleStateRef.current = {
      x: 320,
      y: 210,
      targetX: 320,
      vy: -7,
      gravity: 0.25,
      bounce: -8.0,
      platforms,
    };
    setDoodleRunning(false);
    setDoodleGameOver(false);
    setDoodleScore(0);
    renderDoodle();
  }, [renderDoodle]);

  const startDoodle = useCallback(() => {
    if (doodleRunning) return;
    initDoodle();
    setDoodleRunning(true);
    const loop = () => {
      const st = doodleStateRef.current;
      st.x += (st.targetX - st.x) * 0.22;
      st.vy += st.gravity;
      st.y += st.vy;

      if (st.y < 135 && st.vy < 0) {
        const shift = -st.vy;
        st.y = 135;
        setDoodleScore((s) => s + Math.round(shift));
        for (const p of st.platforms) {
          p.y += shift;
          if (p.y > 300) {
            p.y = 0;
            p.x = 40 + Math.random() * 520;
          }
        }
      }

      if (st.vy > 0) {
        for (const p of st.platforms) {
          if (st.x + 12 > p.x && st.x - 12 < p.x + p.w && st.y + 14 >= p.y && st.y + 14 <= p.y + p.h + 8) {
            st.vy = st.bounce;
            break;
          }
        }
      }

      if (st.y > 315) {
        setDoodleRunning(false);
        setDoodleGameOver(true);
        renderDoodle();
        return;
      }

      renderDoodle();
      doodleRafRef.current = requestAnimationFrame(loop);
    };
    doodleRafRef.current = requestAnimationFrame(loop);
  }, [doodleRunning, initDoodle, renderDoodle]);

  // ==================== 5. VINYL SNAKE (5-Я ИГРА!) ====================
  const snakeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const snakeTimerRef = useRef<number | null>(null);
  const [snakeRunning, setSnakeRunning] = useState(false);
  const [snakeGameOver, setSnakeGameOver] = useState(false);
  const [snakeScore, setSnakeScore] = useState(0);
  const [snakeBest, setSnakeBest] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return parseInt(localStorage.getItem('echo_snake_best') || '0', 10) || 0;
  });
  const snakeStateRef = useRef({
    body: [
      { x: 8, y: 7 },
      { x: 7, y: 7 },
      { x: 6, y: 7 },
    ],
    dir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    food: { x: 14, y: 7 },
  });

  const renderSnake = useCallback(() => {
    const canvas = snakeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const COLS = 20;
    const ROWS = 12;
    const cellW = canvas.width / COLS;
    const cellH = canvas.height / ROWS;
    const st = snakeStateRef.current;

    ctx.fillStyle = '#181411';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(244, 235, 220, 0.06)';
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, 0);
      ctx.lineTo(c * cellW, canvas.height);
      ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellH);
      ctx.lineTo(canvas.width, r * cellH);
      ctx.stroke();
    }

    // Food (golden vinyl disc)
    const fx = (st.food.x + 0.5) * cellW;
    const fy = (st.food.y + 0.5) * cellH;
    ctx.fillStyle = '#f2b735';
    ctx.strokeStyle = '#181411';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fx, fy, Math.min(cellW, cellH) * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#181411';
    ctx.beginPath();
    ctx.arc(fx, fy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Snake segments
    st.body.forEach((seg, idx) => {
      ctx.fillStyle = idx === 0 ? '#ea631f' : '#f4ebdc';
      ctx.strokeStyle = '#181411';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(seg.x * cellW + 2, seg.y * cellH + 2, cellW - 4, cellH - 4, 6);
      ctx.fill();
      ctx.stroke();
    });
  }, []);

  const setSnakeDirection = useCallback((dx: number, dy: number) => {
    const cur = snakeStateRef.current.dir;
    if (cur.x + dx === 0 && cur.y + dy === 0) return;
    snakeStateRef.current.nextDir = { x: dx, y: dy };
  }, []);

  const startSnake = useCallback(() => {
    if (snakeTimerRef.current) clearInterval(snakeTimerRef.current);
    snakeStateRef.current = {
      body: [
        { x: 8, y: 6 },
        { x: 7, y: 6 },
        { x: 6, y: 6 },
      ],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      food: { x: 14, y: 6 },
    };
    setSnakeScore(0);
    setSnakeGameOver(false);
    setSnakeRunning(true);
    renderSnake();

    snakeTimerRef.current = window.setInterval(() => {
      const st = snakeStateRef.current;
      const COLS = 20;
      const ROWS = 12;
      st.dir = st.nextDir;
      const head = {
        x: (st.body[0].x + st.dir.x + COLS) % COLS,
        y: (st.body[0].y + st.dir.y + ROWS) % ROWS,
      };
      if (st.body.some((b) => b.x === head.x && b.y === head.y)) {
        if (snakeTimerRef.current) clearInterval(snakeTimerRef.current);
        snakeTimerRef.current = null;
        setSnakeRunning(false);
        setSnakeGameOver(true);
        renderSnake();
        return;
      }
      const nextBody = [head, ...st.body];
      if (head.x === st.food.x && head.y === st.food.y) {
        setSnakeScore((prev) => {
          const next = prev + 10;
          setSnakeBest((b) => {
            const best = Math.max(b, next);
            try {
              localStorage.setItem('echo_snake_best', String(best));
            } catch {}
            return best;
          });
          return next;
        });
        let fx = Math.floor(Math.random() * COLS);
        let fy = Math.floor(Math.random() * ROWS);
        while (nextBody.some((b) => b.x === fx && b.y === fy)) {
          fx = Math.floor(Math.random() * COLS);
          fy = Math.floor(Math.random() * ROWS);
        }
        st.food = { x: fx, y: fy };
      } else {
        nextBody.pop();
      }
      st.body = nextBody;
      renderSnake();
    }, 125);
  }, [renderSnake]);

  useEffect(() => {
    initSudoku();
    initMines();
  }, [initSudoku, initMines]);

  useEffect(() => {
    if (!open) {
      stopAllLoops();
      return;
    }
    const t = window.setTimeout(() => {
      if (activeGame === 'flappy') renderFlappy();
      if (activeGame === 'doodle') initDoodle();
      if (activeGame === 'snake') renderSnake();
    }, 30);
    return () => window.clearTimeout(t);
  }, [open, activeGame, renderFlappy, initDoodle, renderSnake, stopAllLoops]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (activeGame === 'flappy' && (e.code === 'Space' || e.code === 'ArrowUp')) {
        e.preventDefault();
        flapNote();
      } else if (activeGame === 'sudoku') {
        if (e.key >= '1' && e.key <= '9') {
          e.preventDefault();
          inputSudokuNumber(parseInt(e.key, 10));
        } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
          e.preventDefault();
          inputSudokuNumber(0);
        }
      } else if (activeGame === 'snake') {
        if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          setSnakeDirection(0, -1);
        } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
          e.preventDefault();
          setSnakeDirection(0, 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
          e.preventDefault();
          setSnakeDirection(-1, 0);
        } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          setSnakeDirection(1, 0);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeGame, flapNote, inputSudokuNumber, setSnakeDirection]);

  if (!open) return null;

  const progressPct = generationState
    ? Math.floor(
        Math.min(
          100,
          generationState.percent ??
            (generationState.available / Math.max(1, generationState.required)) * 100
        )
      )
    : readyToEnter
      ? 100
      : 0;

  const elapsedSec = generationState
    ? Math.max(0, Math.floor((now - generationState.started) / 1000))
    : 0;

  const games: { id: ArcadeGameId; name: string; icon: string }[] = [
    { id: 'flappy', name: 'Flappy Note', icon: '🎵' },
    { id: 'sudoku', name: 'Судоку 9×9', icon: '🧩' },
    { id: 'mines', name: 'Сапёр', icon: '💣' },
    { id: 'doodle', name: 'Doodle Jump', icon: '🚀' },
    { id: 'snake', name: 'Змейка', icon: '🐍' },
  ];

  return (
    <div className="nb-arcade-overlay" role="dialog" aria-label="Мини-игры в ожидании">
      <div className="nb-arcade-modal">
        {/* ВЕРХНЯЯ ПАНЕЛЬ БЕЗ СПОЙЛЕРОВ */}
        <div className="nb-arcade-header">
          <div className="nb-arcade-status">
            <div className="nb-arcade-title-row">
              {generating ? (
                <span className="nb-pulse-dot" />
              ) : readyToEnter ? (
                <span className="nb-ready-dot" />
              ) : null}
              <strong>
                {generating && generationState
                  ? `Секретная сборка: ${generationState.available} / ${generationState.required} (${elapsedSec}с)`
                  : readyToEnter
                    ? `✓ Подборка готова (${readyCount || ''} треков)!`
                    : 'Аркадный зал · 5 Игр'}
              </strong>
            </div>
            <span className="nb-arcade-sub">
              {generating
                ? 'Без спойлеров — названия песен скрыты'
                : 'Мини-игры во время ожидания'}
            </span>
          </div>

          <div className="nb-arcade-actions">
            {readyToEnter && onEnterReady && (
              <button type="button" className="nb-btn nb-btn-primary" onClick={onEnterReady}>
                Играть сейчас →
              </button>
            )}
            {generating && onCancelGeneration && (
              <button type="button" className="nb-btn nb-btn-ghost" onClick={onCancelGeneration}>
                Отмена
              </button>
            )}
            {!generating && (
              <button type="button" className="nb-icon-close" onClick={onClose} aria-label="Закрыть">
                ✕
              </button>
            )}
          </div>
        </div>

        {(generating || readyToEnter) && (
          <div className="nb-arcade-progress">
            <div className="nb-arcade-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        )}

        {/* ПЕРЕКЛЮЧАТЕЛЬ 5 ИГР */}
        <div className="nb-arcade-tabs">
          {games.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`nb-arcade-tab ${activeGame === g.id ? 'active' : ''}`}
              onClick={() => {
                stopAllLoops();
                setActiveGame(g.id);
              }}
            >
              <span>{g.icon}</span>
              <span>{g.name}</span>
            </button>
          ))}
        </div>

        {/* ИГРОВОЕ ПОЛЕ */}
        <div className="nb-arcade-stage">
          {activeGame === 'flappy' && (
            <div
              className="nb-canvas-wrap"
              onMouseDown={(e) => {
                e.preventDefault();
                flapNote();
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                flapNote();
              }}
            >
              <canvas ref={flappyCanvasRef} width={640} height={300} className="nb-arcade-canvas" />
              <div className="nb-canvas-hud">
                <span>Счёт: <b>{flappyScore}</b></span>
                <span>Рекорд: <b>{flappyBest}</b></span>
              </div>
              {!flappyRunning && (
                <div className="nb-canvas-overlay">
                  <strong>{flappyGameOver ? `Счёт: ${flappyScore}` : 'Flappy Note'}</strong>
                  <span>Клик или Пробел — полёт сквозь басы</span>
                  <span className="nb-btn nb-btn-primary">
                    {flappyGameOver ? 'Ещё раз' : 'Старт'}
                  </span>
                </div>
              )}
            </div>
          )}

          {activeGame === 'sudoku' && (
            <div className="nb-sudoku-wrap">
              <div className="nb-sudoku-side">
                <div>
                  <span className="nb-badge">SUDOKU 9×9</span>
                  <h4>{sudokuWon ? '🎉 Решено!' : 'Заполните 1–9'}</h4>
                  <p>Ошибок: <b>{sudokuMistakes}</b></p>
                </div>
                <div className="nb-sudoku-numpad">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="nb-num-btn"
                      onClick={() => inputSudokuNumber(n)}
                    >
                      {sudokuIcons ? SUDOKU_SYMBOLS[n] : n}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="nb-num-btn danger"
                    onClick={() => inputSudokuNumber(0)}
                  >
                    ⌫
                  </button>
                </div>
                <div className="nb-sudoku-tools">
                  <button type="button" className="nb-btn nb-btn-secondary" onClick={giveSudokuHint}>
                    💡 Подсказка
                  </button>
                  <button
                    type="button"
                    className="nb-btn nb-btn-ghost"
                    onClick={() => setSudokuIcons((v) => !v)}
                  >
                    {sudokuIcons ? '123' : '🎵'}
                  </button>
                  <button type="button" className="nb-btn nb-btn-ghost" onClick={initSudoku}>
                    🔄
                  </button>
                </div>
              </div>

              <div className="nb-sudoku-grid">
                {sudokuBoard.map((cell, idx) => {
                  const r = Math.floor(idx / 9);
                  const c = idx % 9;
                  const br = c === 2 || c === 5 ? 'block-r' : '';
                  const bb = r === 2 || r === 5 ? 'block-b' : '';
                  const sel = selectedSudokuIdx === idx ? 'selected' : '';
                  const st = cell.error ? 'error' : cell.fixed ? 'fixed' : cell.val > 0 ? 'filled' : '';
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`nb-sudoku-cell ${br} ${bb} ${sel} ${st}`}
                      onClick={() => setSelectedSudokuIdx(idx)}
                    >
                      {cell.val ? (sudokuIcons ? SUDOKU_SYMBOLS[cell.val] : cell.val) : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeGame === 'mines' && (
            <div className="nb-sudoku-wrap">
              <div className="nb-sudoku-side">
                <div>
                  <span className="nb-badge">BEAT SWEEPER</span>
                  <h4>
                    {minesGameOver
                      ? minesWon
                        ? '🎉 Разминировано!'
                        : '💥 Бас-бомба!'
                      : 'Чистые ноты'}
                  </h4>
                  <p>
                    Бомб: <b>{minesCount}</b> · Флагов:{' '}
                    <b>{minesGrid.filter((c) => c.flagged).length}</b>
                  </p>
                </div>
                <button
                  type="button"
                  className={`nb-btn ${minesFlagMode ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
                  onClick={() => setMinesFlagMode((v) => !v)}
                >
                  Режим: {minesFlagMode ? '🚩 Флаг' : '🎵 Открыть'}
                </button>
                <button type="button" className="nb-btn nb-btn-ghost" onClick={initMines}>
                  🔄 Новое поле
                </button>
              </div>

              <div className="nb-mines-grid">
                {minesGrid.map((cell, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={`nb-mine-cell ${cell.revealed ? (cell.mine ? 'mine' : 'open') : ''}`}
                    onClick={() => clickMineCell(idx, false)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      clickMineCell(idx, true);
                    }}
                  >
                    {cell.revealed
                      ? cell.mine
                        ? '💣'
                        : cell.adj > 0
                          ? cell.adj
                          : '♪'
                      : cell.flagged
                        ? '🚩'
                        : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeGame === 'doodle' && (
            <div
              className="nb-canvas-wrap"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
                doodleStateRef.current.targetX = Math.max(20, Math.min(620, ratio * 640));
              }}
              onTouchMove={(e) => {
                if (!e.touches[0]) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = (e.touches[0].clientX - rect.left) / Math.max(1, rect.width);
                doodleStateRef.current.targetX = Math.max(20, Math.min(620, ratio * 640));
              }}
              onMouseDown={startDoodle}
            >
              <canvas ref={doodleCanvasRef} width={640} height={300} className="nb-arcade-canvas" />
              <div className="nb-canvas-hud">
                <span>Высота: <b>{doodleScore}</b></span>
                <span>Ведите курсором влево/вправо</span>
              </div>
              {!doodleRunning && (
                <div className="nb-canvas-overlay">
                  <strong>{doodleGameOver ? `Высота: ${doodleScore}` : 'Doodle Note Jump'}</strong>
                  <span>Двигайте мышью — нотка прыгает по платформам</span>
                  <span className="nb-btn nb-btn-primary">
                    {doodleGameOver ? 'Прыгать снова' : 'Старт'}
                  </span>
                </div>
              )}
            </div>
          )}

          {activeGame === 'snake' && (
            <div className="nb-canvas-wrap">
              <canvas ref={snakeCanvasRef} width={640} height={300} className="nb-arcade-canvas" />
              <div className="nb-canvas-hud">
                <span>Очки: <b>{snakeScore}</b></span>
                <span>Рекорд: <b>{snakeBest}</b></span>
              </div>
              {snakeRunning && (
                <div className="nb-snake-pad">
                  <button type="button" onClick={() => setSnakeDirection(0, -1)}>▲</button>
                  <div className="nb-snake-pad-mid">
                    <button type="button" onClick={() => setSnakeDirection(-1, 0)}>◀</button>
                    <button type="button" onClick={() => setSnakeDirection(1, 0)}>▶</button>
                  </div>
                  <button type="button" onClick={() => setSnakeDirection(0, 1)}>▼</button>
                </div>
              )}
              {!snakeRunning && (
                <div className="nb-canvas-overlay" onClick={startSnake}>
                  <strong>{snakeGameOver ? `Очки: ${snakeScore}` : 'Ритм-Змейка'}</strong>
                  <span>Собирайте золотые пластинки (стрелки / WASD)</span>
                  <span className="nb-btn nb-btn-primary">
                    {snakeGameOver ? 'Заново' : 'Старт'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
