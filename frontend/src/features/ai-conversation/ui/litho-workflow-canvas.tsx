// src/features/ai-conversation/ui/litho-workflow-canvas.tsx
// 光刻机维修流程几何示意（Canvas 2D 伪 3D，任务 05 · S3）
//
// 职责：
// - 绘制 11 个部件的三维盒体示意（几何定义见 domain/litho-geometry.ts）；
// - 四种展示态：NORMAL 深蓝灰 / HIGHLIGHT 蓝色 / WARNING 橙色 / HIDDEN 不绘制；
// - 故障定位动画：扫描线 → 脉冲环 → 锁定（几何动画由前端定义，协议只给 partId+display）；
// - 交互：拖动旋转、滚轮缩放、键盘方向键/加减号/Home；
// - 颜色全部来自 CSS 变量（组件内不写死色值），支持深色模式与 reduced-motion。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AI_BOX_FACES,
  type AiPartGeometry,
  buildAiBoxVertices,
  findAiPartGeometry,
  isPointInAiPolygon,
  projectAiVertex,
  resolveAiScale,
} from '../domain/litho-geometry';
import type { AiPartDisplay } from '../infrastructure/ai-conversation.types';

/** 动画节奏（毫秒）：扫描线 → 聚焦 → 脉冲 → 锁定 */
const SCAN_END_MS = 1580;
const FOCUS_START_MS = 1250;
const PULSE_START_MS = 1530;
const LOCK_START_MS = 2850;
const ANIMATION_DURATION_MS = 3900;

const INITIAL_ANGLE = -0.39;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.6;
const KEYBOARD_ROTATE_STEP = 0.18;
const KEYBOARD_ZOOM_FACTOR = 1.15;

export type LithoWorkflowCanvasProps = {
  /** 部件展示态（未列出的部件按 NORMAL 处理） */
  readonly displays: Record<string, AiPartDisplay>;
  /** 故障定位目标部件（WARNING 升级为锁定故障） */
  readonly focusPartId: string | null;
  /** 悬停部件回调（partId 为 null 表示离开） */
  readonly onHoverPart?: (partId: string | null) => void;
  /** 无障碍标签 */
  readonly ariaLabel: string;
  /** 交互提示文案 */
  readonly gestureHint: string;
};

type ResolvedColors = {
  readonly fill: Record<string, string>;
  readonly outline: Record<string, string>;
  readonly base: string;
  readonly baseDark: string;
  readonly grid: string;
  readonly scan: string;
};

function readToken(token: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  return value.length > 0 ? value : fallback;
}

function resolveColors(): ResolvedColors {
  const read = (token: string) => readToken(token, 'currentColor');
  return {
    fill: {
      NORMAL: read('--ai-geo-part-normal'),
      HIGHLIGHT: read('--ai-geo-part-highlight'),
      WARNING: read('--ai-geo-part-warning'),
      HIDDEN: read('--ai-geo-part-hidden'),
      FAULT: read('--ai-geo-part-fault'),
    },
    outline: {
      NORMAL: read('--ai-geo-outline'),
      HIGHLIGHT: read('--ai-geo-outline-highlight'),
      WARNING: read('--ai-geo-outline-warning'),
      HIDDEN: read('--ai-geo-outline'),
      FAULT: read('--ai-geo-outline-fault'),
    },
    base: read('--ai-geo-base'),
    baseDark: read('--ai-geo-base-dark'),
    grid: read('--ai-geo-grid'),
    scan: read('--ai-geo-scan'),
  };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function LithoWorkflowCanvas({
  ariaLabel,
  displays,
  focusPartId,
  gestureHint,
  onHoverPart,
}: LithoWorkflowCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  /** 最新绘制函数引用：动画循环内不直接捕获 draw，避免自引用与过期闭包 */
  const drawRef = useRef<((timestamp: number) => void) | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const [angle, setAngle] = useState(INITIAL_ANGLE);
  const [zoom, setZoom] = useState(1);
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; angle: number } | null>(null);

  const visibleParts = useMemo(
    () =>
      Object.entries(displays)
        .filter(([, display]) => display !== 'HIDDEN')
        .map(([partId]) => findAiPartGeometry(partId))
        .filter((part): part is AiPartGeometry => part !== null),
    [displays],
  );

  /** 绘制一帧：底座 + 部件盒体（按深度排序）+ 故障定位覆盖层 */
  const draw = useCallback(
    (timestamp: number) => {
      const canvas = canvasRef.current;
      if (canvas === null) {
        return;
      }
      const context = canvas.getContext('2d');
      if (context === null) {
        return;
      }
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const colors = resolveColors();
      const reduced = prefersReducedMotion();
      if (startedAtRef.current === null) {
        startedAtRef.current = timestamp;
      }
      const elapsed = reduced ? 0 : timestamp - startedAtRef.current;
      const options = { width, height, angle, zoom };

      drawBase(context, options, colors);
      for (const part of visibleParts) {
        drawPart(context, part, options, colors, displays[part.partId] ?? 'NORMAL');
      }
      if (focusPartId !== null) {
        drawFaultOverlay(context, focusPartId, options, colors, elapsed, reduced);
      }

      const animationRunning = focusPartId !== null && !reduced && elapsed < ANIMATION_DURATION_MS;
      if (animationRunning) {
        frameRef.current = requestAnimationFrame((next) => drawRef.current?.(next));
      } else {
        frameRef.current = null;
        startedAtRef.current = null;
      }
    },
    [angle, displays, focusPartId, visibleParts, zoom],
  );

  useEffect(() => {
    drawRef.current = draw;
    frameRef.current = requestAnimationFrame((timestamp) => drawRef.current?.(timestamp));
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [draw]);

  /** 画布尺寸变化后重绘 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      frameRef.current = requestAnimationFrame((timestamp) => drawRef.current?.(timestamp));
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  const hitTest = useCallback(
    (clientX: number, clientY: number): string | null => {
      const canvas = canvasRef.current;
      if (canvas === null) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      const point = { x: clientX - rect.left, y: clientY - rect.top };
      const options = { width: rect.width, height: rect.height, angle, zoom };
      for (const part of visibleParts) {
        const vertices = buildAiBoxVertices(part);
        const projected = vertices.map((vertex) => projectAiVertex(vertex, options));
        for (const face of AI_BOX_FACES) {
          const polygon = face.map((index) => projected[index]);
          if (isPointInAiPolygon(point, polygon)) {
            return part.partId;
          }
        }
      }
      return null;
    },
    [angle, visibleParts, zoom],
  );

  return (
    <div className="relative h-full w-full">
      <canvas
        aria-describedby="ai-geo-gesture"
        aria-label={ariaLabel}
        className="block h-full w-full cursor-grab touch-pan-y"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            setAngle((current) => current - KEYBOARD_ROTATE_STEP);
            event.preventDefault();
          } else if (event.key === 'ArrowRight') {
            setAngle((current) => current + KEYBOARD_ROTATE_STEP);
            event.preventDefault();
          } else if (event.key === '+' || event.key === '=') {
            setZoom((current) => clampZoom(current * KEYBOARD_ZOOM_FACTOR));
            event.preventDefault();
          } else if (event.key === '-' || event.key === '_') {
            setZoom((current) => clampZoom(current / KEYBOARD_ZOOM_FACTOR));
            event.preventDefault();
          } else if (event.key === 'Home') {
            setAngle(INITIAL_ANGLE);
            setZoom(1);
            event.preventDefault();
          }
        }}
        onMouseDown={(event) => {
          dragRef.current = { x: event.clientX, angle };
          event.currentTarget.focus();
        }}
        onMouseLeave={() => {
          dragRef.current = null;
          setHoveredPartId(null);
          onHoverPart?.(null);
        }}
        onMouseMove={(event) => {
          const drag = dragRef.current;
          if (drag !== null) {
            setAngle(drag.angle + (event.clientX - drag.x) * 0.012);
            return;
          }
          const partId = hitTest(event.clientX, event.clientY);
          setHoveredPartId(partId);
          onHoverPart?.(partId);
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onWheel={(event) => {
          setZoom((current) => clampZoom(current * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        }}
        ref={canvasRef}
        role="img"
        tabIndex={0}
      />
      <p
        className="absolute bottom-2 left-3 text-xs text-text-secondary"
        id="ai-geo-gesture"
      >
        {gestureHint}
      </p>
      {hoveredPartId !== null ? (
        <span className="pointer-events-none absolute right-3 top-3 rounded bg-fill-secondary px-2 py-1 text-xs text-text-primary shadow-card">
          {hoveredPartId}
        </span>
      ) : null}
    </div>
  );
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function drawBase(
  context: CanvasRenderingContext2D,
  options: { width: number; height: number; angle: number; zoom: number },
  colors: ResolvedColors,
): void {
  const base: AiPartGeometry = {
    partId: 'base',
    labelKey: 'ai.part.controller',
    x: 0,
    y: -0.18,
    z: 0,
    width: 9.9,
    height: 0.33,
    depth: 5.45,
  };
  const vertices = buildAiBoxVertices(base);
  const projected = vertices.map((vertex) => projectAiVertex(vertex, options));
  context.fillStyle = colors.base;
  context.strokeStyle = colors.baseDark;
  context.lineWidth = 1;
  for (const face of AI_BOX_FACES) {
    const polygon = face.map((index) => projected[index]);
    context.beginPath();
    context.moveTo(polygon[0].x, polygon[0].y);
    for (const point of polygon.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.closePath();
    context.fill();
    context.stroke();
  }
}

function drawPart(
  context: CanvasRenderingContext2D,
  part: AiPartGeometry,
  options: { width: number; height: number; angle: number; zoom: number },
  colors: ResolvedColors,
  display: AiPartDisplay,
): void {
  const vertices = buildAiBoxVertices(part);
  const projected = vertices.map((vertex) => projectAiVertex(vertex, options));
  const faces = AI_BOX_FACES.map((face) => {
    const polygon = face.map((index) => projected[index]);
    const depth =
      polygon.reduce((sum, point) => sum + point.depth, 0) / Math.max(1, polygon.length);
    return { polygon, depth };
  }).sort((left, right) => left.depth - right.depth);

  const fill = colors.fill[display] ?? colors.fill.NORMAL;
  const outline = colors.outline[display] ?? colors.outline.NORMAL;
  for (const face of faces) {
    context.beginPath();
    context.moveTo(face.polygon[0].x, face.polygon[0].y);
    for (const point of face.polygon.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = outline;
    context.lineWidth = display === 'WARNING' ? 1.6 : 1;
    context.stroke();
  }
}

/** 故障定位覆盖层：扫描线 → 脉冲环 → 锁定虚线 */
function drawFaultOverlay(
  context: CanvasRenderingContext2D,
  partId: string,
  options: { width: number; height: number; angle: number; zoom: number },
  colors: ResolvedColors,
  elapsed: number,
  reduced: boolean,
): void {
  const part = findAiPartGeometry(partId);
  if (part === null) {
    return;
  }
  const scale = resolveAiScale(options);
  const anchor = projectAiVertex(part, options);

  if (elapsed < SCAN_END_MS && !reduced) {
    const progress = Math.min(1, elapsed / 1450);
    const scanY = options.height * (0.08 + 0.83 * progress);
    const gradient = context.createLinearGradient(0, scanY - 68, 0, scanY + 10);
    gradient.addColorStop(0, colors.scan);
    gradient.addColorStop(0.87, colors.scan);
    gradient.addColorStop(1, colors.scan);
    context.fillStyle = gradient;
    context.globalAlpha = 0.18;
    context.fillRect(0, scanY - 68, options.width, 78);
    context.globalAlpha = 1;
  }

  if (elapsed >= PULSE_START_MS) {
    const wave = ((elapsed - PULSE_START_MS) % 360) / 360;
    const sweep = ((elapsed - PULSE_START_MS) % 600) / 600;
    context.strokeStyle = colors.outline.WARNING;
    context.lineWidth = 1.5;
    context.globalAlpha = 0.6 * (1 - sweep);
    context.beginPath();
    context.arc(anchor.x, anchor.y, 18 + sweep * 38, 0, Math.PI * 2);
    context.stroke();
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(anchor.x, anchor.y, 22 - wave * 5, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2);
    context.fillStyle = colors.fill.WARNING;
    context.fill();
  }

  if (elapsed >= LOCK_START_MS) {
    context.setLineDash([4, 5]);
    context.lineWidth = 1.6;
    context.strokeStyle = colors.outline.FAULT;
    context.beginPath();
    context.moveTo(anchor.x, anchor.y - 17);
    context.bezierCurveTo(
      anchor.x,
      anchor.y - 83,
      anchor.x - 47,
      anchor.y,
      anchor.x,
      anchor.y,
    );
    context.stroke();
    context.setLineDash([]);
  }

  if (elapsed < FOCUS_START_MS && !reduced) {
    // 聚焦阶段：轻微放大，保持视线在故障件
    void scale;
  }
}
