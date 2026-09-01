/**
 * 核心优势板块（wearview features 风格）
 *
 * 卡片：图 + 标题 + 描述 + 了解更多，hover 时标题右移、卡片描边变深。
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
  title: string;
  subtitle?: string;
  items: Advantage[];
}

const DEFAULT_ADVANTAGES: AdvantagesData = {
  title: "从草图到货架，一站式 AI 视觉流水线",
  subtitle: "专为 Amazon 卖家打造：产品图进来，可直接上架的商品详情页与全套视觉素材出去",
  items: [
    {
      title: "从产品图到货架",
      desc: "上传一张白底产品图，自动完成特征分析、场景图生成、A+ 详情页排版、打包交付。一条流水线直达 Amazon 货架。",
      emoji: "🏭",
      href: "/build",
    },
    {
      title: "市场潜力数据预测",
      desc: "生成同时并行联网分析 Amazon US 市场：销量、定价、竞争、成本与利润预估，让每一款选品都有数据支撑。",
      emoji: "📈",
    },
    {
      title: "5 种风格 + 变体模板",
      desc: "Editorial 暖杂志、Swiss 瑞士风、Product Launch 暗底 Hero 等内置风格，外加客户模板，一图多变体。",
      emoji: "🎨",
      href: "/build",
    },
    {
      title: "AI 偏好学习",
      desc: "你的点赞与反馈会被记录进偏好画像，越用越懂你的审美，生成结果持续贴合品牌调性。",
      emoji: "🧠",
    },
    {
      title: "客户模板保护",
      desc: "品牌 Logo、价格等关键元素可标记保护，AI 生成时绝不改动，多轮交付保持一致。",
      emoji: "🔒",
    },
    {
      title: "多用户隔离协作",
      desc: "每位卖家独立数据空间，管理员可总览全局；登录、配额、并发全部内置，团队协作开箱即用。",
      emoji: "👥",
    },
  ],
};

export default function AdvantagesSection({ data }: { data?: AdvantagesData }) {
  const d = data || DEFAULT_ADVANTAGES;
  if (!d.items || d.items.length === 0) return null;

  return (
    <section id="advantages" className="py-12 lg:py-24 bg-gray-50">
      <div className="text-center mb-10 lg:mb-14 px-4">
        <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight mb-3">{d.title}</h2>
        {d.subtitle && (
          <p className="text-gray-500 max-w-2xl mx-auto text-sm sm:text-base">{d.subtitle}</p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-7xl mx-auto px-4">
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
                  <span className="text-5xl sm:text-6xl">{item.emoji}</span>
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
    </section>
  );
}
