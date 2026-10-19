type DiffReport = {
  regions?: Array<{ column: number; row: number; diffPixels: number; totalPixels: number; diffRatio: number }>
  maxRegionDiffRatio?: number
  diffPixels: number
  diffRatio: number
  height: number
  totalPixels: number
  width: number
}

type DiffPageResult = {
  diffDataUrl: string
  report: DiffReport
}

export type {
  DiffPageResult,
}
