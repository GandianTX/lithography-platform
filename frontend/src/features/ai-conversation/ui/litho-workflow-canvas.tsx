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
  AI_PART_MOUNTS,
  AI_SCENE_BASE_GEOMETRY,
  type AiPartGeometry,
  type AiPartRenderState,
  type AiSceneBox,
  type AiSceneSurface,
  buildAiSceneSurfaces,
  findAiPartGeometry,
  findAiSurfacePartId,
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

/** 可见面集合由 domain 层统一提供（原型 faceIndices：4 侧面 + 顶面，不含底面） */

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
};

type ResolvedFaceColors = {
  /** 顶面 */
  readonly top: string;
  /** 奇数侧面（较暗） */
  readonly sideA: string;
  /** 偶数侧面（中间调） */
  readonly sideB: string;
};

type ResolvedColors = {
  readonly fill: Record<string, ResolvedFaceColors>;
  readonly outline: Record<string, string>;
  readonly base: ResolvedFaceColors;
  readonly grid: string;
  readonly scan: string;
  /** 面片斜向网格线（原型技术线框质感），按展示态分档 */
  readonly hatch: Record<string, string>;
  /** 悬停高亮填充（V44 原型同值，见 --ai-geo-hover-fill 基准登记） */
  readonly hoverFill: string;
  /** 悬停高亮描边（V44 原型同值，见 --ai-geo-outline-hover 基准登记） */
  readonly outlineHover: string;
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
  const face = (prefix: string): ResolvedFaceColors => ({
    top: read(`--ai-geo-part-${prefix}-top`),
    sideA: read(`--ai-geo-part-${prefix}-side-a`),
    sideB: read(`--ai-geo-part-${prefix}-side-b`),
  });
  const hidden = read('--ai-geo-part-hidden');
  return {
    fill: {
      NORMAL: face('normal'),
      HIGHLIGHT: face('highlight'),
      WARNING: face('warning'),
      HIDDEN: { top: hidden, sideA: hidden, sideB: hidden },
      FAULT: face('fault'),
    },
    outline: {
      NORMAL: read('--ai-geo-outline'),
      HIGHLIGHT: read('--ai-geo-outline'),
      WARNING: read('--ai-geo-outline-warning'),
      HIDDEN: read('--ai-geo-outline'),
      FAULT: read('--ai-geo-outline-fault'),
    },
    base: {
      top: read('--ai-geo-base-top'),
      sideA: read('--ai-geo-base-side-a'),
      sideB: read('--ai-geo-base-side-b'),
    },
    grid: read('--ai-geo-grid'),
    scan: read('--ai-geo-scan'),
    hatch: {
      NORMAL: read('--ai-geo-hatch'),
      HIGHLIGHT: read('--ai-geo-hatch'),
      WARNING: read('--ai-geo-hatch-warning'),
      HIDDEN: read('--ai-geo-hatch'),
      FAULT: read('--ai-geo-hatch-fault'),
    },
    hoverFill: read('--ai-geo-hover-fill'),
    outlineHover: read('--ai-geo-outline-hover'),
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

/**
 * 分面明暗：顶面最亮、奇数侧面较暗、偶数侧面居中（原型 AI33Paint 同规则）。
 * 用实色表达，不叠加透明度。
 */
function pickFaceColor(palette: ResolvedFaceColors, faceIndex: number): string {
  if (faceIndex === 4) {
    return palette.top;
  }
  return faceIndex % 2 === 1 ? palette.sideA : palette.sideB;
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
  onHoverPart,
}: LithoWorkflowCanvasProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** tooltip 与容器引用（用于贴边翻转定位） */
  const tipRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
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
  /**
   * 相机事实的唯一持有者：绘制、命中测试、故障锚点与用户操作共用同一份「当前相机」。
   *
   * 关键语义（P2-1）：动画结束边界后**保持**聚焦终值，不得回退到旧基准；
   * 用户接管时以这里记录的「屏幕上实际看到的相机」为起点，不产生跳变。
   */
  const cameraRef = useRef<{ angle: number; zoom: number }>({ angle: INITIAL_ANGLE, zoom: 1 });
  /** 用户已接管视角：不再叠加镜头聚焦偏移（避免与用户操作打架） */
  const cameraTakenOverRef = useRef(false);
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  /** 指针在画布内的位置（原型 tooltip 跟随指针） */
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number } | null>(null);
  const [tipPosition, setTipPosition] = useState({ x: 0, y: 0 });
  const [locked, setLocked] = useState(false);
  const dragRef = useRef<{ x: number; angle: number | null } | null>(null);

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
            baseAngle: cameraRef.current.angle,
            baseZoom: cameraRef.current.zoom,
          };
          cameraTakenOverRef.current = false;
        }
      }

      const animation = animationRef.current;
      const elapsed =
        animation === null ? 0 : reduced ? ANIMATION_DURATION_MS : timestamp - animation.startedAt;

      // 镜头聚焦：进度饱和后保持终值（结束边界后不回退到旧基准）。
      // reduced-motion 时直接呈现目标终态（原型同口径：立即到目标视角）。
      let viewAngle = cameraRef.current.angle;
      let viewZoom = cameraRef.current.zoom;
      if (animation !== null && !cameraTakenOverRef.current) {
        const focusProgress = reduced ? 1 : Math.min(1, elapsed / FOCUS_CAMERA_MS);
        const ease = smoothStep(focusProgress);
        const delta = FOCUS_TARGET_ANGLE - animation.baseAngle;
        const direction = Math.atan2(Math.sin(delta), Math.cos(delta)) * ease;
        const compact = width < COMPACT_WIDTH_PX;
        const factor = compact ? FOCUS_ZOOM_COMPACT : FOCUS_ZOOM_DESKTOP;
        viewAngle = animation.baseAngle + direction;
        viewZoom = clampZoom(animation.baseZoom * (1 - ease) + ease * factor);
      }
      cameraRef.current = { angle: viewAngle, zoom: viewZoom };
      // 可观测相机事实：绘制、命中测试与故障锚点共用同一份当前相机。
      // 供回归测试直接断言「动画结束后相机保持终态」，不依赖像素采样或截图等待。
      canvas.dataset.cameraAngle = String(viewAngle);
      canvas.dataset.cameraZoom = String(viewZoom);

      const options = { width, height, angle: viewAngle, zoom: viewZoom };
      const isLocked = elapsed >= LOCK_START_MS;
      const ghostOthers = focusPartId !== null && elapsed >= FOCUS_START_MS;

      // 统一面集合：底座 + 部件 + 支架，按原型口径全局深度排序。
      // 绘制、拾取与遮挡判定共用同一套面，避免「点到的不是看到的」。
      const sceneBoxes = buildAiSceneBoxes(visibleParts, displays, focusPartId, {
        ghostOthers,
        isLocked,
      });
      drawSurfaces(context, buildAiSceneSurfaces(sceneBoxes, options), colors, hoveredPartId);

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
    [displays, faultIdentity, focusGeometry, focusPartId, hoveredPartId, locked, visibleParts],
  );

  /** 请求重绘一帧（用户操作后触发；动画循环进行中时不重复安排） */
  const scheduleDraw = useCallback(() => {
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame((timestamp) => drawRef.current?.(timestamp));
    }
  }, []);

  /** 用户操作相机：以「屏幕上实际看到的相机」为基准继续，不产生跳变 */
  const updateCamera = useCallback(
    (next: { angle?: number; zoom?: number }) => {
      const current = cameraRef.current;
      cameraRef.current = {
        angle: next.angle ?? current.angle,
        zoom: next.zoom ?? current.zoom,
      };
      scheduleDraw();
    },
    [scheduleDraw],
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
      // 走统一的重绘调度：避免覆盖动画循环持有的帧句柄（卸载时才能完整取消）
      scheduleDraw();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw, scheduleDraw]);

  const hitTest = useCallback(
    (clientX: number, clientY: number): string | null => {
      const canvas = canvasRef.current;
      if (canvas === null) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      const point = { x: clientX - rect.left, y: clientY - rect.top };
      const camera = cameraRef.current;
      const options = {
        width: rect.width,
        height: rect.height,
        angle: camera.angle,
        zoom: camera.zoom,
      };
      // 与绘制共用同一套面集合：从最后绘制（最前）的面逆序查找，
      // 命中的必然是屏幕上最靠前的部件。
      const boxes = buildAiSceneBoxes(visibleParts, displays, focusPartId, {
        ghostOthers: false,
        isLocked: false,
      });
      return findAiSurfacePartId(buildAiSceneSurfaces(boxes, options), point);
    },
    [displays, focusPartId, visibleParts],
  );
  /** 用户接管视角：不再叠加镜头聚焦偏移，但动效时间线继续走完 */
  const takeOverCamera = useCallback(() => {
    cameraTakenOverRef.current = true;
  }, []);

  const hoveredGeometry = hoveredPartId === null ? null : findAiPartGeometry(hoveredPartId);

  // 原型：动画播放中不显示部件浮层，锁定后恢复
  const showTip = hoveredGeometry !== null && (focusPartId === null || locked);

  // 原型 tooltip 定位：优先放指针右下方，放不下则翻到左上方
  useEffect(() => {
    const tip = tipRef.current;
    const container = containerRef.current;
    if (tip === null || container === null || hoverPoint === null) {
      return;
    }
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const x =
      hoverPoint.x + 12 + tipWidth <= containerWidth - 4
        ? hoverPoint.x + 12
        : hoverPoint.x - 12 - tipWidth;
    const y =
      hoverPoint.y + 12 + tipHeight <= containerHeight - 4
        ? hoverPoint.y + 12
        : hoverPoint.y - 12 - tipHeight;
    setTipPosition({ x, y });
  }, [hoverPoint]);

  return (
    <div className="relative h-full w-full" ref={containerRef}>
      <canvas
        aria-describedby="ai-geo-gesture"
        aria-label={ariaLabel}
        className="block h-full w-full cursor-grab touch-pan-y"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', '+', '=', '-', '_', 'Home'].includes(event.key)) {
            return;
          }
          takeOverCamera();
          if (event.key === 'ArrowLeft') {
            updateCamera({ angle: cameraRef.current.angle - KEYBOARD_ROTATE_STEP });
            event.preventDefault();
          } else if (event.key === 'ArrowRight') {
            updateCamera({ angle: cameraRef.current.angle + KEYBOARD_ROTATE_STEP });
            event.preventDefault();
          } else if (event.key === '+' || event.key === '=') {
            updateCamera({ zoom: clampZoom(cameraRef.current.zoom * KEYBOARD_ZOOM_FACTOR) });
            event.preventDefault();
          } else if (event.key === '-' || event.key === '_') {
            updateCamera({ zoom: clampZoom(cameraRef.current.zoom / KEYBOARD_ZOOM_FACTOR) });
            event.preventDefault();
          } else if (event.key === 'Home') {
            updateCamera({ angle: INITIAL_ANGLE, zoom: 1 });
            event.preventDefault();
          }
        }}
        onMouseDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          setHoveredPartId(null);
          setHoverPoint(null);
          onHoverPart?.(null);
          // 仅在实际拖动时接管；普通点击不应中断自动聚焦。
          dragRef.current = { x: event.clientX, angle: null };
          event.currentTarget.focus();
        }}
        onMouseLeave={() => {
          dragRef.current = null;
          setHoveredPartId(null);
          setHoverPoint(null);
          onHoverPart?.(null);
        }}
        onMouseMove={(event) => {
          const drag = dragRef.current;
          if (drag !== null) {
            if (drag.angle === null) {
              if (event.clientX === drag.x) {
                return;
              }
              drag.angle = cameraRef.current.angle;
            }
            takeOverCamera();
            updateCamera({ angle: drag.angle + (event.clientX - drag.x) * 0.012 });
            return;
          }
          const partId = hitTest(event.clientX, event.clientY);
          setHoveredPartId(partId);
          const rect = event.currentTarget.getBoundingClientRect();
          setHoverPoint(
            partId === null ? null : { x: event.clientX - rect.left, y: event.clientY - rect.top },
          );
          onHoverPart?.(partId);
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onWheel={(event) => {
          takeOverCamera();
          updateCamera({
            zoom: clampZoom(cameraRef.current.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)),
          });
        }}
        ref={canvasRef}
        role="img"
        tabIndex={0}
      />
      {focusTitle !== null ? (
        <div aria-hidden={!locked} className="ai-fault-card" data-locked={locked} ref={cardRef}>
          <strong>{focusTitle}</strong>
          {faultDescription !== null && faultDescription !== undefined ? (
            <span title={faultDescription}>{faultDescription}</span>
          ) : null}
        </div>
      ) : null}
      {showTip && hoveredGeometry !== null ? (
        <div
          className="ai-part-tip"
          ref={tipRef}
          role="tooltip"
          style={{ left: tipPosition.x, top: tipPosition.y }}
        >
          {t(hoveredGeometry.labelKey)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 组装场景盒体集合：底座 + 部件 + 支架
 *
 * 支架沿用所属部件的展示态与拾取归属（原型 `box([partId,'',...mount], mode)`）；
 * HIDDEN 部件只有在被锁定为故障目标时才参与绘制（原型同规则）。
 */
function buildAiSceneBoxes(
  visibleParts: readonly AiPartGeometry[],
  displays: Record<string, AiPartDisplay>,
  focusPartId: string | null,
  options: { readonly ghostOthers: boolean; readonly isLocked: boolean },
): AiSceneBox[] {
  const boxes: AiSceneBox[] = [
    { geometry: AI_SCENE_BASE_GEOMETRY, renderState: 'NORMAL', ghost: false, isBase: true },
  ];
  const pushPart = (part: AiPartGeometry, renderState: AiPartRenderState, ghost: boolean): void => {
    boxes.push({ geometry: part, renderState, ghost, isBase: false });
    for (const mount of AI_PART_MOUNTS) {
      if (mount.ownerPartId !== part.partId) {
        continue;
      }
      boxes.push({ geometry: mount.geometry, renderState, ghost, isBase: false });
    }
  };
  for (const part of visibleParts) {
    const isFocus = part.partId === focusPartId;
    const display: AiPartRenderState = isFocus
      ? options.isLocked
        ? 'FAULT'
        : 'HIGHLIGHT'
      : (displays[part.partId] ?? 'NORMAL');
    pushPart(part, display, options.ghostOthers && !isFocus);
  }
  if (focusPartId !== null && !visibleParts.some((part) => part.partId === focusPartId)) {
    const hidden = findAiPartGeometry(focusPartId);
    if (hidden !== null) {
      pushPart(hidden, options.isLocked ? 'FAULT' : 'HIGHLIGHT', false);
    }
  }
  return boxes;
}

/** 绘制场景面集合（全局深度顺序：后画的盖住先画的） */
function drawSurfaces(
  context: CanvasRenderingContext2D,
  surfaces: readonly AiSceneSurface[],
  colors: ResolvedColors,
  hoveredPartId: string | null,
): void {
  for (const surface of surfaces) {
    drawSurface(context, surface, colors, hoveredPartId);
  }
}

/**
 * 绘制单个面片
 *
 * 底色 → 分面明暗 → 悬停高亮 → 描边 → 技术网格线，顺序与原型一致。
 * 描边宽度取原型口径（普通 1、悬停 1.8），不再自造 1.6 档。
 */
function drawSurface(
  context: CanvasRenderingContext2D,
  surface: AiSceneSurface,
  colors: ResolvedColors,
  hoveredPartId: string | null,
): void {
  const polygon = surface.polygon;
  if (isBackFace(polygon)) {
    return;
  }
  const display = surface.renderState ?? 'NORMAL';
  const palette = surface.isBase ? colors.base : (colors.fill[display] ?? colors.fill.NORMAL);
  const hovered = surface.partId !== null && surface.partId === hoveredPartId;
  const outline = surface.isBase
    ? colors.base.sideA
    : hovered && display !== 'FAULT'
      ? colors.outlineHover
      : (colors.outline[display] ?? colors.outline.NORMAL);

  context.beginPath();
  context.moveTo(polygon[0].x, polygon[0].y);
  for (const point of polygon.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.closePath();

  // 分面明暗用三档实色表达（原型 AI33Paint 同规则：顶面最亮、奇数侧较暗、偶数侧居中），
  // 正常态不再通过降低 globalAlpha 与背景混合，避免发灰与透出后方底座。
  context.fillStyle = pickFaceColor(palette, surface.faceIndex);
  // 聚焦期间其他部件淡出（原型 ghost：填充 0.28 / 描边 0.52）
  context.globalAlpha = surface.ghost ? 0.28 : 1;
  context.fill();

  // 悬停高亮（原型：叠加半透明高亮填充）
  if (hovered) {
    context.globalAlpha = 1;
    context.fillStyle = colors.hoverFill;
    context.fill();
  }

  context.globalAlpha = surface.ghost ? 0.52 : 1;
  context.strokeStyle = outline;
  context.lineWidth = hovered ? 1.8 : 1;
  context.stroke();
  drawFaceHatch(context, polygon, {
    color: colors.hatch[display] ?? colors.hatch.NORMAL,
    alpha: surface.ghost ? 0.52 : 1,
  });
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

/** 故障部件的定位锚点：底面以上 72% 高度处（原型 `project(px, py + h*.72, pz)`） */
function resolveFaultAnchor(
  context: CanvasRenderingContext2D,
  part: AiPartGeometry,
  options: { width: number; height: number; angle: number; zoom: number },
): { x: number; y: number } {
  void context;
  const projected = projectAiVertex(
    { x: part.x, y: part.y + part.height * 0.72, z: part.z },
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
