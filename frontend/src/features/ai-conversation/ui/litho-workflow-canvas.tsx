// src/features/ai-conversation/ui/litho-workflow-canvas.tsx
// 光刻机维修流程几何示意（Canvas 2D 伪 3D，任务 05 · S3）
//
// 职责：
// - 绘制 11 个部件的三维盒体示意（几何定义见 domain/litho-geometry.ts）；
// - 四种展示态：NORMAL 深蓝灰 / HIGHLIGHT 蓝色 / WARNING 橙色 / HIDDEN 不绘制；
// - 故障定位动效（对齐 V44 原型 AI39DrawOverlay / AI41FaultDisplay）：
//   等待扫描 → 镜头平滑聚焦（旋转 + 缩放）→ 目标部件脉冲 → 锁定终态；
//   锁定终态 = 目标部件转故障红 + 红色定位环 + 指向故障短卡的引线；
// - 故障短卡只显示可解释的本地化部件名与简短描述，详情仍在对话里；
// - 交互：拖动旋转、滚轮缩放、键盘方向键/加减号/Home；
// - 颜色全部来自 CSS 变量（组件内不写死色值），支持深色模式与 reduced-motion
//   （减少动态时直接给出同样可读的终态，不做镜头运动）。
//
// 动效身份：同一轮同一故障件复用一次动效；换了故障件或换了轮次必须换 identity，
// 让动效重新开始（旧响应晚到时由上游清空 focusPartId，不会复用旧动效）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '@/shared/i18n';

import {
  AI_BOX_FACES,
  type AiPartGeometry,
  buildAiBoxVertices,
  findAiPartGeometry,
  isPointInAiPolygon,
  projectAiVertex,
} from '../domain/litho-geometry';
import type { AiPartDisplay } from '../infrastructure/ai-conversation.types';

/** 动效节奏（毫秒）：扫描线 → 聚焦 → 脉冲 → 锁定 */
const SCAN_END_MS = 1580;
const FOCUS_START_MS = 1250;
const PULSE_START_MS = 1530;
const LOCK_START_MS = 2850;
const ANIMATION_DURATION_MS = 3900;
/** 镜头聚焦时长（原型 2600ms 缓动） */
const FOCUS_CAMERA_MS = 2600;
/** 聚焦目标视角（原型 0.37rad） */
const FOCUS_TARGET_ANGLE = 0.37;
/** 聚焦缩放系数：宽屏 1.12 / 窄屏 1.06（原型同值） */
const FOCUS_ZOOM_DESKTOP = 1.12;
const FOCUS_ZOOM_COMPACT = 1.06;
/** 窄屏判定（原型 clientWidth < 440） */
const COMPACT_WIDTH_PX = 440;

/** 可见面：不画底面（原型 faceIndices 同样只取 5 面） */
const VISIBLE_AI_BOX_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
  [4, 5, 6, 7],
];

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
  /**
   * 故障定位动效身份：轮次 + 部件。
   * 换轮次或换部件必须换身份，否则会复用上一次动效（原型按 animationId 处理）。
   */
  readonly faultIdentity?: string | null;
  /** 故障短卡描述：安全可展示的简短描述（详情仍在对话里） */
  readonly faultDescription?: string | null;
  /** 悬停部件回调（partId 为 null 表示离开） */
  readonly onHoverPart?: (partId: string | null) => void;
  /** 无障碍标签 */
  readonly ariaLabel: string;
  /** 交互提示文案 */
  readonly gestureHint: string;
};

/** 绘制展示态：协议四种 + 锁定终态的故障红（FAULT 只在画布内出现） */
type CanvasDisplay = AiPartDisplay | 'FAULT';

type ResolvedColors = {
  readonly fill: Record<string, string>;
  readonly outline: Record<string, string>;
  readonly base: string;
  readonly baseDark: string;
  readonly grid: string;
  readonly scan: string;
  /** 面片斜向网格线（原型技术线框质感） */
  readonly hatch: string;
};

function readToken(token: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim();
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
    hatch: read('--ai-geo-hatch'),
  };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

/**
 * 背面剔除：投影后顺时针面积过小的面不再绘制（原型同规则）。
 * 少画背面才能露出内部层次，避免「大面积不透明盒体」。
 */
function isBackFace(polygon: ReadonlyArray<{ x: number; y: number }>): boolean {
  const [a, b, d] = [polygon[0], polygon[1], polygon[3]];
  if (a === undefined || b === undefined || d === undefined) {
    return false;
  }
  return (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x) <= 0.01;
}

/** 分面明暗：顶面最亮，侧面两档（原型每种展示态三档面色） */
function faceAlpha(faceIndex: number): number {
  if (faceIndex === 4) {
    return 1;
  }
  return faceIndex % 2 === 1 ? 0.72 : 0.88;
}

/** 平滑步进（原型 smoothstep：m²(3-2m)） */
function smoothStep(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

export function LithoWorkflowCanvas({
  ariaLabel,
  displays,
  faultDescription,
  faultIdentity,
  focusPartId,
  gestureHint,
  onHoverPart,
}: LithoWorkflowCanvasProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  /** 最新绘制函数引用：动画循环内不直接捕获 draw，避免自引用与过期闭包 */
  const drawRef = useRef<((timestamp: number) => void) | null>(null);
  /** 当前动效（身份 + 起始时间 + 聚焦基准视角） */
  const animationRef = useRef<{
    identity: string;
    startedAt: number;
    baseAngle: number;
    baseZoom: number;
  } | null>(null);
  /** 实际用于绘制的视角（用户操作 + 镜头聚焦偏移），命中测试同源 */
  const viewRef = useRef<{ angle: number; zoom: number }>({ angle: INITIAL_ANGLE, zoom: 1 });
  /** 用户已接管视角：不再叠加镜头聚焦偏移（避免与用户操作打架） */
  const cameraTakenOverRef = useRef(false);
  const [angle, setAngle] = useState(INITIAL_ANGLE);
  const [zoom, setZoom] = useState(1);
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const dragRef = useRef<{ x: number; angle: number } | null>(null);

  const visibleParts = useMemo(
    () =>
      Object.entries(displays)
        .filter(([, display]) => display !== 'HIDDEN')
        .map(([partId]) => findAiPartGeometry(partId))
        .filter((part): part is AiPartGeometry => part !== null),
    [displays],
  );

  const focusGeometry = useMemo(
    () => (focusPartId === null ? null : findAiPartGeometry(focusPartId)),
    [focusPartId],
  );

  const focusTitle = useMemo(() => {
    if (focusGeometry === null) {
      return null;
    }
    return `${t(focusGeometry.labelKey)} · ${t('ai.scene.faultLocked')}`;
  }, [focusGeometry, t]);

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
      if (
        canvas.width !== Math.floor(width * ratio) ||
        canvas.height !== Math.floor(height * ratio)
      ) {
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const colors = resolveColors();
      const reduced = prefersReducedMotion();
      const identity = focusPartId === null ? null : (faultIdentity ?? focusPartId);

      // 动效身份变化（换轮次或换部件）→ 重新开始一次定位动效
      if (identity === null) {
        animationRef.current = null;
      } else {
        const current = animationRef.current;
        if (current === null || current.identity !== identity) {
          animationRef.current = {
            identity,
            startedAt: timestamp,
            baseAngle: viewRef.current.angle,
            baseZoom: viewRef.current.zoom,
          };
          cameraTakenOverRef.current = false;
        }
      }

      const animation = animationRef.current;
      const elapsed =
        animation === null ? 0 : reduced ? ANIMATION_DURATION_MS : timestamp - animation.startedAt;

      // 镜头聚焦：未锁定前平滑旋转到目标视角并轻微放大；用户接管后不再叠加
      let viewAngle = angle;
      let viewZoom = zoom;
      if (
        animation !== null &&
        !reduced &&
        !cameraTakenOverRef.current &&
        elapsed < ANIMATION_DURATION_MS
      ) {
        const ease = smoothStep(elapsed / FOCUS_CAMERA_MS);
        const delta = FOCUS_TARGET_ANGLE - animation.baseAngle;
        const direction = Math.atan2(Math.sin(delta), Math.cos(delta)) * ease;
        const compact = width < COMPACT_WIDTH_PX;
        const factor = compact ? FOCUS_ZOOM_COMPACT : FOCUS_ZOOM_DESKTOP;
        viewAngle = animation.baseAngle + direction;
        viewZoom = clampZoom(animation.baseZoom * (1 - ease) + ease * factor);
      }
      viewRef.current = { angle: viewAngle, zoom: viewZoom };

      const options = { width, height, angle: viewAngle, zoom: viewZoom };
      const isLocked = elapsed >= LOCK_START_MS;
      const ghostOthers = focusPartId !== null && elapsed >= FOCUS_START_MS;

      drawBase(context, options, colors);
      for (const part of visibleParts) {
        const isFocus = part.partId === focusPartId;
        const display = isFocus
          ? isLocked
            ? 'FAULT'
            : 'HIGHLIGHT'
          : (displays[part.partId] ?? 'NORMAL');
        drawPart(context, part, options, colors, display, {
          ghost: ghostOthers && !isFocus,
        });
      }
      // HIDDEN 部件只有在被锁定为故障目标时才绘制（原型同规则）
      if (focusPartId !== null && !visibleParts.some((part) => part.partId === focusPartId)) {
        const hidden = findAiPartGeometry(focusPartId);
        if (hidden !== null) {
          drawPart(context, hidden, options, colors, isLocked ? 'FAULT' : 'HIGHLIGHT', {
            ghost: false,
          });
        }
      }

      if (focusPartId !== null && focusGeometry !== null) {
        const anchor = resolveFaultAnchor(context, focusGeometry, options);
        const card = cardRef.current;
        const cardAnchor = card === null ? null : { x: card.offsetLeft, y: card.offsetTop + 22 };
        drawFaultOverlay(context, anchor, cardAnchor, colors, elapsed, reduced, height);
      }

      if (isLocked !== locked) {
        setLocked(isLocked);
      }

      const animationRunning = focusPartId !== null && !reduced && elapsed < ANIMATION_DURATION_MS;
      if (animationRunning) {
        frameRef.current = requestAnimationFrame((next) => drawRef.current?.(next));
      } else {
        frameRef.current = null;
      }
    },
    [angle, displays, faultIdentity, focusGeometry, focusPartId, locked, visibleParts, zoom],
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
      const view = viewRef.current;
      const options = {
        width: rect.width,
        height: rect.height,
        angle: view.angle,
        zoom: view.zoom,
      };
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
    [visibleParts],
  );

  /** 用户接管视角：不再叠加镜头聚焦偏移，但动效时间线继续走完 */
  const takeOverCamera = useCallback(() => {
    cameraTakenOverRef.current = true;
  }, []);

  const hoveredGeometry = hoveredPartId === null ? null : findAiPartGeometry(hoveredPartId);

  return (
    <div className="relative h-full w-full">
      <canvas
        aria-describedby="ai-geo-gesture"
        aria-label={ariaLabel}
        className="block h-full w-full cursor-grab touch-pan-y"
        onKeyDown={(event) => {
          takeOverCamera();
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
          takeOverCamera();
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
            takeOverCamera();
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
          takeOverCamera();
          setZoom((current) => clampZoom(current * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        }}
        ref={canvasRef}
        role="img"
        tabIndex={0}
      />
      <p className="absolute bottom-2 left-3 text-xs text-text-secondary" id="ai-geo-gesture">
        {gestureHint}
      </p>
      {focusTitle !== null ? (
        <div aria-hidden={!locked} className="ai-fault-card" data-locked={locked} ref={cardRef}>
          <strong>{focusTitle}</strong>
          {faultDescription !== null && faultDescription !== undefined ? (
            <span title={faultDescription}>{faultDescription}</span>
          ) : null}
        </div>
      ) : null}
      {hoveredGeometry !== null ? (
        <span className="pointer-events-none absolute right-3 top-3 rounded bg-fill-secondary px-2 py-1 text-xs text-text-primary shadow-card">
          {t(hoveredGeometry.labelKey)}
        </span>
      ) : null}
    </div>
  );
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
  for (const [faceIndex, face] of VISIBLE_AI_BOX_FACES.entries()) {
    const polygon = face.map((vertexIndex) => projected[vertexIndex]);
    if (isBackFace(polygon)) {
      continue;
    }
    context.globalAlpha = faceAlpha(faceIndex);
    context.beginPath();
    context.moveTo(polygon[0].x, polygon[0].y);
    for (const point of polygon.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.closePath();
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
  }
  context.globalAlpha = 1;
  drawBaseGrid(context, projected, colors);
}

/**
 * 底座顶面网格：V44 构图里的底座网格（仅在顶面可见时绘制）。
 * 颜色取受控令牌 --ai-geo-grid。
 */
function drawBaseGrid(
  context: CanvasRenderingContext2D,
  projected: ReadonlyArray<{ x: number; y: number }>,
  colors: ResolvedColors,
): void {
  const steps = 12;
  context.save();
  context.strokeStyle = colors.grid;
  context.lineWidth = 0.5;
  context.globalAlpha = 0.55;
  for (let index = 1; index < steps; index += 1) {
    const ratio = index / steps;
    // 沿 X 方向的线：前左→后左 与 前右→后右 之间插值
    const start = lerpPoint(projected[4], projected[7], ratio);
    const end = lerpPoint(projected[5], projected[6], ratio);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    // 沿 Z 方向的线
    const startZ = lerpPoint(projected[4], projected[5], ratio);
    const endZ = lerpPoint(projected[7], projected[6], ratio);
    context.beginPath();
    context.moveTo(startZ.x, startZ.y);
    context.lineTo(endZ.x, endZ.y);
    context.stroke();
  }
  context.restore();
  context.globalAlpha = 1;
}

function lerpPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  ratio: number,
): { x: number; y: number } {
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function drawPart(
  context: CanvasRenderingContext2D,
  part: AiPartGeometry,
  options: { width: number; height: number; angle: number; zoom: number },
  colors: ResolvedColors,
  display: CanvasDisplay,
  modifiers: { readonly ghost: boolean },
): void {
  const vertices = buildAiBoxVertices(part);
  const projected = vertices.map((vertex) => projectAiVertex(vertex, options));
  const faces = VISIBLE_AI_BOX_FACES.map((face, index) => {
    const polygon = face.map((vertexIndex) => projected[vertexIndex]);
    const depth =
      polygon.reduce((sum, point) => sum + point.depth, 0) / Math.max(1, polygon.length);
    return { index, polygon, depth };
  }).sort((left, right) => left.depth - right.depth);

  const fill = colors.fill[display] ?? colors.fill.NORMAL;
  const outline = colors.outline[display] ?? colors.outline.NORMAL;
  for (const face of faces) {
    if (isBackFace(face.polygon)) {
      continue;
    }
    context.beginPath();
    context.moveTo(face.polygon[0].x, face.polygon[0].y);
    for (const point of face.polygon.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.closePath();
    // 分面明暗形成透明层次（原型每种展示态三档面色）
    const shade = faceAlpha(face.index);
    // 聚焦期间其他部件淡出（原型 ghost：填充 0.28 / 描边 0.52）
    context.globalAlpha = (modifiers.ghost ? 0.28 : 1) * shade;
    context.fillStyle = fill;
    context.fill();
    context.globalAlpha = (modifiers.ghost ? 0.52 : 1) * shade;
    context.strokeStyle = outline;
    context.lineWidth = display === 'WARNING' || display === 'FAULT' ? 1.6 : 1;
    context.stroke();
    drawFaceHatch(context, face.polygon, {
      color:
        display === 'FAULT'
          ? colors.outline.FAULT
          : display === 'WARNING'
            ? colors.outline.WARNING
            : colors.hatch,
      alpha:
        (modifiers.ghost ? 0.52 : 1) * (display === 'WARNING' || display === 'FAULT' ? 0.5 : 1),
    });
  }
  context.globalAlpha = 1;
}

/**
 * 面片内部斜向网格线（原型技术线框质感）
 *
 * 原型在每个可见面片内绘制两组四等分斜线，使部件呈现工程示意图的通透质感；
 * 只画线不填充，不影响部件色面与拾取判定。
 */
function drawFaceHatch(
  context: CanvasRenderingContext2D,
  polygon: ReadonlyArray<{ x: number; y: number }>,
  options: { color: string; alpha: number },
): void {
  const [a, b, c, d] = polygon;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return;
  }
  context.save();
  context.globalAlpha = options.alpha;
  context.strokeStyle = options.color;
  context.lineWidth = 0.55;
  for (let index = 1; index < 4; index += 1) {
    const ratio = index / 4;
    // a→b 与 d→c 之间连线
    context.beginPath();
    context.moveTo(lerpNumber(a.x, b.x, ratio), lerpNumber(a.y, b.y, ratio));
    context.lineTo(lerpNumber(d.x, c.x, ratio), lerpNumber(d.y, c.y, ratio));
    context.stroke();
    // a→d 与 b→c 之间连线
    context.beginPath();
    context.moveTo(lerpNumber(a.x, d.x, ratio), lerpNumber(a.y, d.y, ratio));
    context.lineTo(lerpNumber(b.x, c.x, ratio), lerpNumber(b.y, c.y, ratio));
    context.stroke();
  }
  context.restore();
}

function lerpNumber(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}

/** 故障部件的定位锚点：部件中心高度 72% 处（与原型一致） */
function resolveFaultAnchor(
  context: CanvasRenderingContext2D,
  part: AiPartGeometry,
  options: { width: number; height: number; angle: number; zoom: number },
): { x: number; y: number } {
  void context;
  const projected = projectAiVertex(
    { x: part.x, y: part.y - part.height / 2 + part.height * 0.72, z: part.z },
    options,
  );
  return { x: projected.x, y: projected.y };
}

/**
 * 故障定位覆盖层：扫描线 → 脉冲环 → 锁定引线。
 *
 * - 等待期只显示扫描，不暗示故障已被识别；
 * - 锁定后（LOCK_START_MS）定位环转故障红，并从部件拉一条虚线引线到故障短卡；
 * - 减少动态效果时直接给出锁定终态（同样可读）。
 */
function drawFaultOverlay(
  context: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  cardAnchor: { x: number; y: number } | null,
  colors: ResolvedColors,
  elapsed: number,
  reduced: boolean,
  height: number,
): void {
  const width = context.canvas.width / (window.devicePixelRatio || 1);
  if (elapsed < SCAN_END_MS) {
    const scanY = height * (0.08 + 0.83 * Math.min(1, elapsed / 1450));
    const gradient = context.createLinearGradient(0, scanY - 68, 0, scanY + 10);
    gradient.addColorStop(0, 'transparent');
    gradient.addColorStop(0.87, colors.scan);
    gradient.addColorStop(1, 'transparent');
    context.fillStyle = gradient;
    context.globalAlpha = 0.18;
    context.fillRect(0, scanY - 68, width, 78);
    context.globalAlpha = 0.6;
    context.fillStyle = colors.scan;
    context.fillRect(0, scanY - 1, width, 2);
    context.globalAlpha = 1;
  }

  if (elapsed < PULSE_START_MS) {
    return;
  }

  const locked = elapsed >= LOCK_START_MS;
  const wave = ((elapsed - PULSE_START_MS) % 360) / 360;
  const sweep = ((elapsed - PULSE_START_MS) % 600) / 600;
  context.save();
  // 锁定前用扫描色（表示「正在定位」），锁定后转故障红
  context.strokeStyle = locked ? colors.outline.FAULT : colors.scan;
  context.fillStyle = context.strokeStyle;
  context.lineWidth = 1.5;
  context.globalAlpha = 0.75;
  context.beginPath();
  context.arc(anchor.x, anchor.y, locked ? 18 : 22 - wave * 5, 0, Math.PI * 2);
  context.stroke();
  if (!locked && elapsed < ANIMATION_DURATION_MS) {
    context.globalAlpha = 0.6 * (1 - sweep);
    context.beginPath();
    context.arc(anchor.x, anchor.y, 18 + sweep * 38, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 1;
  context.beginPath();
  context.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2);
  context.fill();

  if (locked && cardAnchor !== null) {
    context.setLineDash([4, 5]);
    context.lineWidth = 1.6;
    context.strokeStyle = colors.outline.FAULT;
    context.beginPath();
    context.moveTo(anchor.x, anchor.y - 17);
    context.bezierCurveTo(
      anchor.x,
      anchor.y - 83,
      cardAnchor.x - 47,
      cardAnchor.y,
      cardAnchor.x,
      cardAnchor.y,
    );
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();
  void reduced;
}
