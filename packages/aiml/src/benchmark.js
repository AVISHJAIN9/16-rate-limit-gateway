import { VolumetricDDoSDetector } from '@rlgw/security';
export class ModelBenchmarkHarness {
    static evaluate(testData, model, seed = 42) {
        // 1. Evaluate Heuristic (EWMA + z-score)
        const heuristicDetector = new VolumetricDDoSDetector(20, 2.5);
        let hTruePos = 0;
        let hFalsePos = 0;
        let hFalseNeg = 0;
        let hTrueNeg = 0;
        const startH = process.hrtime.bigint();
        for (const row of testData) {
            const isActualAttack = row.label !== 'benign';
            const check = heuristicDetector.recordRequest(row.subjectId, row.rejectRatio > 0.5, row.windowStartMs);
            const isPredictedAttack = check.isSurge;
            if (isPredictedAttack && isActualAttack)
                hTruePos++;
            else if (isPredictedAttack && !isActualAttack)
                hFalsePos++;
            else if (!isPredictedAttack && isActualAttack)
                hFalseNeg++;
            else
                hTrueNeg++;
        }
        const endH = process.hrtime.bigint();
        const hLatencyUs = Number(endH - startH) / (testData.length * 1000);
        const hPrecision = hTruePos + hFalsePos > 0 ? hTruePos / (hTruePos + hFalsePos) : 1;
        const hRecall = hTruePos + hFalseNeg > 0 ? hTruePos / (hTruePos + hFalseNeg) : 1;
        const hF1 = hPrecision + hRecall > 0 ? (2 * hPrecision * hRecall) / (hPrecision + hRecall) : 0;
        const hFPR = hFalsePos + hTrueNeg > 0 ? hFalsePos / (hFalsePos + hTrueNeg) : 0;
        // 2. Evaluate Isolation Forest
        let mlTruePos = 0;
        let mlFalsePos = 0;
        let mlFalseNeg = 0;
        let mlTrueNeg = 0;
        const startML = process.hrtime.bigint();
        for (const row of testData) {
            const isActualAttack = row.label !== 'benign';
            const isPredictedAttack = model.isAnomaly(row.features);
            if (isPredictedAttack && isActualAttack)
                mlTruePos++;
            else if (isPredictedAttack && !isActualAttack)
                mlFalsePos++;
            else if (!isPredictedAttack && isActualAttack)
                mlFalseNeg++;
            else
                mlTrueNeg++;
        }
        const endML = process.hrtime.bigint();
        const mlLatencyUs = Number(endML - startML) / (testData.length * 1000);
        const mlPrecision = mlTruePos + mlFalsePos > 0 ? mlTruePos / (mlTruePos + mlFalsePos) : 1;
        const mlRecall = mlTruePos + mlFalseNeg > 0 ? mlTruePos / (mlTruePos + mlFalseNeg) : 1;
        const mlF1 = mlPrecision + mlRecall > 0 ? (2 * mlPrecision * mlRecall) / (mlPrecision + mlRecall) : 0;
        const mlFPR = mlFalsePos + mlTrueNeg > 0 ? mlFalsePos / (mlFalsePos + mlTrueNeg) : 0;
        const recommendation = mlF1 > hF1 && mlFPR <= hFPR ? 'enable_ml_by_default' : 'keep_heuristic_default';
        return {
            timestamp: new Date().toISOString(),
            seed,
            datasetSize: testData.length,
            heuristic: {
                precision: Number(hPrecision.toFixed(4)),
                recall: Number(hRecall.toFixed(4)),
                f1: Number(hF1.toFixed(4)),
                falsePositiveRate: Number(hFPR.toFixed(4)),
                latencyUs: Number(hLatencyUs.toFixed(2))
            },
            isolationForest: {
                precision: Number(mlPrecision.toFixed(4)),
                recall: Number(mlRecall.toFixed(4)),
                f1: Number(mlF1.toFixed(4)),
                falsePositiveRate: Number(mlFPR.toFixed(4)),
                latencyUs: Number(mlLatencyUs.toFixed(2))
            },
            recommendation
        };
    }
}
