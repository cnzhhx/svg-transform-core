const DIFF_BROWSER_REPORT_RUNTIME = String.raw`
  diffContext.putImageData(diffImage, 0, 0)

  window.__DIFF_RESULT__ = {
    diffDataUrl: diffCanvas.toDataURL('image/png'),
    report: {
      diffPixels,
      diffRatio: toFixedNumber(diffPixels / totalPixels),
      totalPixels,
      regions: regions.map((region) => ({ ...region, diffRatio: toFixedNumber(region.diffPixels / Math.max(1, region.totalPixels)) })),
      maxRegionDiffRatio: Math.max(...regions.map((region) => region.diffPixels / Math.max(1, region.totalPixels))),
      width,
      height,
    },
  }

  window.__RENDER_READY__ = true
})
`

export { DIFF_BROWSER_REPORT_RUNTIME }
