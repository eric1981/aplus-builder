/**
 * 数据成果展示（适配 aplus-builder 浅色背景）
 *
 * 原版为深色背景白字，这里适配浅色页面：标题/数字用深色、说明用 muted。
 * 数据可由主题配置（brand.stats）覆盖，未配置时使用默认成果数据。
 */
export interface StatsData {
  title: string;
  items: { value: string; label: string }[];
}

const DEFAULT_STATS: StatsData = {
  title: "使用 AI 生成模特进行时尚摄影和品牌画册创作的电商品牌，正在取得可量化的成果",
  items: [
    { value: "-90%", label: "视觉制作成本降低" },
    { value: "10x", label: "产品上线速度提升" },
    { value: "+10%", label: "转化率提升" },
    { value: "+12%", label: "客单价提升" },
    { value: "+30%", label: "广告点击率提升" },
  ],
};

export default function StatsSection({ data }: { data?: StatsData }) {
  const d = data || DEFAULT_STATS;
  if (!d.items || d.items.length === 0) return null;

  return (
    <div className="relative z-10 py-12 sm:py-16">
      <div className="text-center mb-10 sm:mb-12">
        <p className="text-fg text-base lg:text-lg font-medium max-w-3xl mx-auto leading-relaxed px-4">
          {d.title}
        </p>
      </div>
      <div className="flex flex-col gap-8 md:flex-row md:gap-4 lg:gap-8 justify-center items-center max-w-5xl mx-auto px-4">
        {d.items.map((it) => (
          <div key={it.label} className="text-center flex-1">
            <div className="text-3xl lg:text-5xl font-bold text-brand mb-2">{it.value}</div>
            <div className="text-text-muted text-sm lg:text-base font-medium">{it.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
