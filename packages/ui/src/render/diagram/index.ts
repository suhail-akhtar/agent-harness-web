/** Interactive architecture and flow diagrams (DESIGN section 16); the spec is in @harness/plugin-ui. */
export { DiagramCanvas, Legend, DIAGRAM_DETAILS_PANE, type DiagramCanvasProps, type DiagramCanvasApi, type DiagramSelection } from './Canvas.tsx';
export { DiagramBlock, DiagramError, DiagramOverlay, useDiagramSpec, viewName, type DiagramBlockProps } from './Static.tsx';
export { DiagramDetails } from './Details.tsx';
export { Drawing as DiagramDrawing, DIAGRAM_CSS, TONE_HEX, type DrawState, type FlowDraw } from './Drawing.tsx';
export {
  layoutDiagram, layoutDiagramSync, layoutKey, layeredScene, positionsScene, placeNew, pinnedPositions, moveNodes, positionsOf, routeAll, simpleRoute, toElk, fromElk, visibleGraph, nodeSize, labelSize,
  type Scene, type SceneNode, type SceneEdge, type SceneGroup, type LayoutOptions, type ElkGraph, type ElkResult, type VisibleGraph,
} from './layout.ts';
export { elkLayout } from './elk.ts';
export { useDiagramLayout, rememberedLayout, rememberLayout, forgetLayout } from './useLayout.ts';
export { exportSvg, svgToPng, resolveVars, downloadBlob } from './export.ts';
export { roundedPath, polyLength, pointAt, reversePoints } from './paths.ts';
export { layered } from './layered.ts';
