/**
 * 市场潜力预测（并行、不依赖生成结果）：
 * - 生成任务创建后，并行 spawn 一个 hermes 市场分析任务（ecommerce-market-analysis skill）
 * - 分析结果写入 <workDir>/sales-prediction.json，解析后回调给调用方
 * - 并发上限：maxAnalysisConcurrent（设置中心，默认 2）
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { getAgentHome } from "./config";
import { getSettingInt } from "./settings";

export interface MarketPrediction {
  score: number;
  unitsPerMonth: { min: number; max: number };
  priceRange: { min: number; max: number; currency: string };
  competition: "low" | "medium" | "high";
  seasonality: "peak" | "stable" | "declining";
  trend: "rising" | "flat" | "falling";
  bestSeason?: string;
  risks: string[];
  opportunities: string[];
  sellPoints: string[];
  summary: string;
}

interface AnalysisJob {
  input: string;
  outputPath: string;
  onDone: (pred: MarketPrediction | null) => void;
}

let active = 0;
const jobs: AnalysisJob[] = [];

const ANALYSIS_TIMEOUT_MS =
  (getSettingInt("analysisTimeoutMinutes", 10) || 10) * 60 * 1000;

function cap(): number {
  return getSettingInt("maxAnalysisConcurrent", 2) || 1;
}

function runJob(job: AnalysisJob) {
  const inputFile = job.input;
  const logFile = job.outputPath.replace(".json", "-agent.log");
  const scriptPath = job.outputPath.replace(".json", "-run.sh");

  const script = [
    `#!/bin/bash`,
    `set -eo pipefail`,
    `cd ${getAgentHome()}`,
    `hermes -p duma -s ecommerce-market-analysis chat \\`,
    `  -q "$(cat '${inputFile}')" \\`,
    `  --quiet --yolo --max-turns 30 --source web`,
  ].join("\n");
  writeFileSync(scriptPath, script, { mode: 0o755 });

  const child = spawn("/bin/bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: getAgentHome() },
    cwd: getAgentHome(),
  });
  child.stdout.on("data", (d: Buffer) => appendFileSync(logFile, d));
  child.stderr.on("data", (d: Buffer) => appendFileSync(logFile, d));

  let settled = false;
  const finish = (pred: MarketPrediction | null) => {
    if (settled) return;
    settled = true;
    active = Math.max(0, active - 1);
    job.onDone(pred);
    pump();
  };

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    finish(null);
  }, ANALYSIS_TIMEOUT_MS);

  child.on("close", () => {
    clearTimeout(timer);
    // 读取 skill 写出的 JSON
    let pred: MarketPrediction | null = null;
    try {
      if (existsSync(job.outputPath)) {
        pred = JSON.parse(readFileSync(job.outputPath, "utf-8"));
      }
    } catch {}
    finish(pred);
  });
  child.on("error", () => {
    clearTimeout(timer);
    finish(null);
  });
}

function pump() {
  while (active < cap() && jobs.length > 0) {
    active++;
    runJob(jobs.shift()!);
  }
}

/**
 * 启动一次市场分析（并行，不阻塞生成队列）。
 * @param taskDir 任务工作目录（分析输入/输出都放这里）
 * @param input   分析 prompt（含产品图路径、品类、描述、输出路径）
 */
export function startMarketAnalysis(
  taskDir: string,
  input: string,
  onDone: (pred: MarketPrediction | null) => void,
): void {
  const inputFile = join(taskDir, "market-input.txt");
  const outputPath = join(taskDir, "sales-prediction.json");
  try {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(inputFile, input, "utf-8");
  } catch {
    onDone(null);
    return;
  }
  jobs.push({ input: inputFile, outputPath, onDone });
  pump();
}

/** 校验并归一化解析出的预测对象（防御坏数据） */
export function normalizePrediction(raw: unknown): MarketPrediction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  try {
    return {
      score: Math.max(0, Math.min(100, num(r.score))),
      unitsPerMonth: {
        min: Math.max(0, num((r.unitsPerMonth as any)?.min)),
        max: Math.max(0, num((r.unitsPerMonth as any)?.max)),
      },
      priceRange: {
        min: Math.max(0, num((r.priceRange as any)?.min)),
        max: Math.max(0, num((r.priceRange as any)?.max)),
        currency: str((r.priceRange as any)?.currency, "USD"),
      },
      competition: ["low", "medium", "high"].includes(str(r.competition))
        ? (str(r.competition) as MarketPrediction["competition"])
        : "medium",
      seasonality: ["peak", "stable", "declining"].includes(str(r.seasonality))
        ? (str(r.seasonality) as MarketPrediction["seasonality"])
        : "stable",
      trend: ["rising", "flat", "falling"].includes(str(r.trend))
        ? (str(r.trend) as MarketPrediction["trend"])
        : "flat",
      bestSeason: str(r.bestSeason) || undefined,
      risks: arr(r.risks),
      opportunities: arr(r.opportunities),
      sellPoints: arr(r.sellPoints),
      summary: str(r.summary),
    };
  } catch {
    return null;
  }
}
