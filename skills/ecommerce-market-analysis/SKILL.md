---
name: ecommerce-market-analysis
description: 分析一款产品（亚马逊美国市场）的销售潜力，输出结构化预测 JSON。用于 aplus-builder 的"市场潜力预测"。
---

# ecommerce-market-analysis

分析一张产品图 + 品类 + 描述，评估其在 **Amazon US 市场**的销售潜力，并输出结构化 JSON。

## 输入

任务会通过 prompt 提供以下信息（不要追问，直接分析）：
- `产品图路径`：产品主图（白底或场景图）
- `品类`：如 上衣 / 裤子 / 裙装 / 套装 / 鞋帽 / 箱包（以及更细的产品名）
- `产品描述`：材质、风格、卖点（可能为空，看图推断）
- `风格参考`：生成的风格（Editorial / Swiss / Product Launch 等）
- `输出路径`：必须把 JSON 写入这个文件

## 调研要求（使用 --source web 联网）

针对 Amazon US（amazon.com）调研以下维度，**只写调研到的内容，禁止编造数据**：

1. **同类竞争**：搜同类产品（如 "women linen abaya amazon"）：
   - 前几名商品的**价格区间**（USD）
   - 竞争密度：结果页同款数量 → 低 / 中 / 高
   - 头部商品评价数大致量级（几十 / 几百 / 几千）
2. **需求与趋势**：
   - 该品类当前是旺季 / 平稳 / 淡季（结合季节与当前月份）
   - 趋势：上升 / 平稳 / 下降（结合搜索热度、社交平台声量、时尚风向）
   - 最佳上架季节建议
3. **价格带**：该品类在美亚的主流成交价格区间
4. **成本核算**（Amazon US 卖家视角）：
   - 估算同类产品的**到岸成本**（产品成本 + 头程运费，USD）——按品类经验值估算，标注"估算"
   - **亚马逊费用**：佣金率（多数品类 15%）、按建议售价估算的佣金金额、FBA 履约费（按该品类常见尺寸/重量档位）、合计费用
   - **毛利**：按建议售价 − 到岸成本 − 亚马逊费用，给出单件毛利区间与毛利率区间

## 输出

把以下 JSON 写入 `<输出路径>`（键名严格一致，全部中文文案）：

```json
{
  "score": 78,
  "unitsPerMonth": { "min": 120, "max": 300 },
  "priceRange": { "min": 29.9, "max": 49.9, "currency": "USD" },
  "competition": "medium",
  "seasonality": "stable",
  "trend": "rising",
  "bestSeason": "秋冬（9-11月）",
  "risks": ["同款竞争激烈，需差异化卖点", "面料质感未知，影响复购"],
  "opportunities": ["场景图突出垂坠感，契合当前极简风", "定价低于头部竞品 15% 有竞争力"],
  "sellPoints": ["垂坠廓形", "透气面料", "适合中东裔女性市场"],
  "cost": {
    "estimatedProductCost": { "min": 8, "max": 15 },
    "note": "同类产品到岸成本估算，实际请以你的采购成本为准"
  },
  "amazonFees": {
    "referralRate": 15,
    "estimatedReferral": { "min": 4.5, "max": 7.5 },
    "estimatedFba": { "min": 4, "max": 6 },
    "estimatedTotal": { "min": 8.5, "max": 13.5 }
  },
  "profit": {
    "perUnit": { "min": 5, "max": 15 },
    "margin": { "min": 15, "max": 35 }
  },
  "summary": "该款式需求平稳偏升，竞争中等，建议定价 $35-45；按到岸成本 $8-15 估算，单件毛利约 $5-15（毛利率 15%-35%），主打垂坠感与透气性，秋冬上架为佳。"
}
```

字段说明：
- `score`：0-100 综合卖点评估（需求度、竞争度、价格带、差异化综合）
- `unitsPerMonth`：预估月销量的**保守区间**（件/月），基于调研的同类产品销量量级推断
- `priceRange`：建议定价区间（USD）
- `competition`：`low` | `medium` | `high`
- `seasonality`：`peak` | `stable` | `declining`
- `trend`：`rising` | `flat` | `falling`
- `cost.estimatedProductCost`：同类产品到岸成本估算区间（USD，标注"估算"）
- `amazonFees`：佣金率（%）、按建议售价估算的佣金金额、FBA 履约费、合计（USD）
- `profit.perUnit`：单件毛利区间（USD）；`profit.margin`：毛利率区间（%）
- `risks` / `opportunities` / `sellPoints`：各 1-4 条，每条一句话
- `summary`：150 字以内的中文总结（含成本与毛利结论）

## 规则

1. **不编造数据**：所有数字必须来自调研；找不到就写区间推断并在 summary 注明"基于经验推断"
2. **输出中文**（字段值、文案、总结）
3. JSON 必须**严格合法**，键名与上述一致，缺少的数组用空数组
4. 把 JSON 同时打印到终端（便于收集），并写入 `<输出路径>` 文件
5. 完成后直接结束，不要询问、不要迭代
