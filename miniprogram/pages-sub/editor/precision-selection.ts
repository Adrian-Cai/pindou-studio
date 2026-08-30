import type { PatternDraft } from '../../models/pattern'
import {
  gridCellToViewportRect,
  type CanvasRect,
  type FittedImageSize,
  type GridCell,
  type ViewTransform,
} from '../services/pattern-editor-service'

export const MAGNIFIER_SIZE = 140
export const MAGNIFIER_CANVAS_HEIGHT = 188
export const MAGNIFIER_HALF_GRID = 3

const MAGNIFIER_PANEL_WIDTH = 156
const MAGNIFIER_PANEL_HEIGHT = MAGNIFIER_CANVAS_HEIGHT + 16
const MAGNIFIER_FINGER_GAP = 44
const VIEWPORT_GUTTER = 8

export interface MagnifierState {
  visible: boolean
  top: number
  left: number
  row: number
  column: number
  colorCode: string
}

export interface TargetHighlightState extends CanvasRect {
  visible: boolean
}

export interface PrecisionSelection {
  target: GridCell | null
  revision: number
}

interface SelectionFeedback {
  targetHighlight: TargetHighlightState
  magnifier: MagnifierState
}

export function createPrecisionSelection(): PrecisionSelection {
  return { target: null, revision: 0 }
}

export function buildPrecisionSelectionFeedback(
  touchClientX: number,
  touchClientY: number,
  cell: GridCell,
  draft: PatternDraft,
  image: FittedImageSize,
  transform: ViewTransform,
  viewport: CanvasRect,
  windowWidth: number,
  windowHeight: number,
): SelectionFeedback {
  const targetHighlight = {
    visible: true,
    ...gridCellToViewportRect(cell, image, transform, viewport.width, viewport.height),
  }
  const showBelow = touchClientY < MAGNIFIER_PANEL_HEIGHT + MAGNIFIER_FINGER_GAP + VIEWPORT_GUTTER
  let top = showBelow
    ? touchClientY + MAGNIFIER_FINGER_GAP
    : touchClientY - MAGNIFIER_FINGER_GAP - MAGNIFIER_PANEL_HEIGHT
  let left = touchClientX - MAGNIFIER_PANEL_WIDTH / 2
  left = Math.max(VIEWPORT_GUTTER, Math.min(windowWidth - MAGNIFIER_PANEL_WIDTH - VIEWPORT_GUTTER, left))
  top = Math.max(VIEWPORT_GUTTER, Math.min(windowHeight - MAGNIFIER_PANEL_HEIGHT - VIEWPORT_GUTTER, top))
  return {
    targetHighlight,
    magnifier: {
      visible: true,
      top,
      left,
      row: cell.row + 1,
      column: cell.column + 1,
      colorCode: draft.cells[cell.index]?.colorCode || '空白',
    },
  }
}
