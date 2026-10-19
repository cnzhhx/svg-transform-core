import { getDiffRatioThreshold } from "../../../config/index.js";

import type { VerifyResult } from "../../verify.js";

type QualityStatus = "pass" | "partial";

type QualityAssessment = {
  blockingIssues: string[];
  gateSummary: Record<string, unknown>;
  softIssues: string[];
  status: QualityStatus;
};

const formatPercent = (value: number) => (value * 100).toFixed(2);

const buildQualityAssessment = (
  verifyResult: VerifyResult,
  options: { diffRatioThreshold?: number; failedModuleIds?: string[] } = {},
): QualityAssessment => {
  const diffRatioThreshold = options.diffRatioThreshold ?? getDiffRatioThreshold();
  const blockingIssues: string[] = [];
  const softIssues: string[] = [];
  const globalDiffPassed = verifyResult.diffRatio <= diffRatioThreshold;
  const failedModuleIds = options.failedModuleIds ?? [];
  if (failedModuleIds.length) softIssues.push(`Module validation failed: ${failedModuleIds.join(", ")}`);

  if (!globalDiffPassed) {
    softIssues.push(
      `diffRatio ${formatPercent(verifyResult.diffRatio)}% > ${formatPercent(diffRatioThreshold)}%`,
    );
  }

  const status: QualityStatus = softIssues.length ? "partial" : "pass";

  return {
    blockingIssues,
    gateSummary: {
      diffRatio: verifyResult.diffRatio,
      diffRatioThreshold,
      globalDiffPassed,
      regionalDiagnostics: verifyResult.regionalDiagnostics,
      failedModuleIds,
    },
    softIssues,
    status,
  };
};

const qualityCompletionStatus = (quality: QualityAssessment, policy = "report") => {
  if (!["report", "best-effort", "strict"].includes(policy)) throw new Error("Invalid QUALITY_POLICY");
  if (quality.status === "pass" || policy === "report") return "completed" as const;
  return policy === "strict" ? "failed-gate" as const : "best-effort" as const;
};

export { buildQualityAssessment, qualityCompletionStatus };
export type { QualityAssessment };
