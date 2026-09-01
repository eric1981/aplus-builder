/**
 * 核心优势板块（wearview features 风格）
 *
 * 还原 wearview 排版：
 * - 标题区：uppercase 圆角小标签 + 大标题 + 副标题
 * - 卡片：图（aspect-[3/2] 圆角 + hover 蒙层渐隐）+ 标题（hover 右移）+ 描述
 *   + "了解更多 →"（hover 右移），卡片 hover 描边变深 + 阴影
 * 数据由主题配置（brand.advantages）覆盖，未配置时用 aplus-builder 默认优势。
 */
export interface Advantage {
  title: string;
  desc: string;
  /** 卡片配图（public 路径） */
  image?: string;
  /** 无图时显示的 emoji */
  emoji?: string;
  /** 点击跳转（可选） */
  href?: string;
}

export interface AdvantagesData {
  /** 小标签（如"核心功能"） */
  badge?: string;
  title: string;
  subtitle?: string;
  items: Advantage[];
}

const DEFAULT_ADVANTAGES: AdvantagesData = {
  badge: "核心优势",
  title: "一条 AI 流水线，从产品图到货架",
  subtitle: "四大能力覆盖选品、测款到上架的全流程，专为 Amazon 卖家打造",
  items: [
    {
      title: "从产品图到货架",
      desc: "上传一张白底产品图，AI 自动完成特征分析、多场景生成与 A+ 详情页排版，一条流水线直达 Amazon 货架。",
      emoji: "🏭",
      href: "/build",
    },
    {
      title: "市场潜力预测",
      desc: "生成同时并行联网分析 Amazon US 市场：销量、定价、竞争与利润预估，让每一款选品都有数据支撑。",
      emoji: "📈",
    },
    {
      title: "AI 偏好学习",
      desc: "点赞与反馈自动沉淀进偏好画像，越用越懂你的审美，生成结果持续贴合品牌调性。",
      emoji: "🧠",
    },
    {
      title: "低成本快速测款",
      desc: "无需摄影棚与模特，几分钟产出全套场景图，用远低于实拍的成本批量验证款式市场反应。",
      emoji: "⚡",
      href: "/build",
    },
  ],
};

export default function AdvantagesSection({ data }: { data?: AdvantagesData }) {
  const d = data || DEFAULT_ADVANTAGES;
  if (!d.items || d.items.length === 0) return null;

  return (
    <section id="advantages" className="py-12 lg:py-24 bg-gray-50">
      <div className="container mx-auto px-4 lg:px-10">
        <div className="text-center mb-12 lg:mb-16">
          {d.badge && (
            <div className="uppercase w-fit mx-auto rounded-full text-base lg:text-lg font-semibold tracking-widest mb-6 text-gray-500">
              {d.badge}
            </div>
          )}
          <h2 className="text-3xl lg:text-5xl text-center text-gray-700 font-medium mb-6 max-w-3xl mx-auto">
            {d.title}
          </h2>
          {d.subtitle && (
            <p className="text-base lg:text-lg text-gray-600 max-w-4xl mx-auto leading-relaxed">
              {d.subtitle}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-7xl mx-auto">
          {d.items.map((item) => {
            const Wrapper = item.href ? "a" : "div";
            return (
              <Wrapper
                key={item.title}
                {...(item.href ? { href: item.href } : {})}
                className="group relative flex flex-col p-4 sm:p-5 rounded-3xl border border-gray-200 bg-white hover:border-black hover:shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-all duration-300 overflow-hidden"
              >
                <div className="relative w-full aspect-[3/2] rounded-2xl overflow-hidden mb-4 bg-gray-100 border border-gray-200 flex items-center justify-center">
                  {item.image ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.image} alt={item.title} loading="lazy" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/5 group-hover:bg-transparent transition-colors duration-500" />
                    </>
                  ) : (
                    <span className="text-6xl sm:text-7xl">{item.emoji}</span>
                  )}
                </div>
                <div className="pb-2 flex flex-col flex-1">
                  <h3 className="text-xl sm:text-2xl font-semibold mb-1 tracking-tight group-hover:translate-x-1 transition-transform duration-300">
                    {item.title}
                  </h3>
                  <p className="text-gray-500 leading-relaxed text-sm sm:text-base">{item.desc}</p>
                </div>
                {item.href && (
                  <div className="flex items-center text-brand font-semibold text-sm group-hover:translate-x-2 transition-transform duration-300">
                    了解更多
                    <span className="ml-1">→</span>
                  </div>
                )}
              </Wrapper>
            );
          })}
        </div>
      </div>
    </section>
  );
}
