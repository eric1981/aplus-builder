/**
 * 核心优势板块（wearview 交替行风格）
 *
 * 还原 wearview 排版：
 * - 标题区：uppercase 圆角小标签 + 大标题 + 副标题
 * - 每项优势一行：左图右文 / 右图左文交替（md:order 切换）
 *   - 文字侧：badge 小标签 + h3 大标题 + 描述 + 勾选列表 + 深色圆角按钮
 *   - 图侧：圆角图（hover 放大）
 * 数据由主题配置（brand.advantages）覆盖，未配置时用 aplus-builder 默认优势。
 */
export interface AdvantageRow {
  /** 每项小标签（如"全流程自动化"） */
  badge?: string;
  title: string;
  desc: string;
  /** 勾选列表项 */
  points: string[];
  /** 按钮文案 */
  cta: string;
  /** 点击跳转（默认 /build） */
  href?: string;
  /** 配图（public 路径）；无图时用 emoji */
  image?: string;
  emoji?: string;
}

export interface AdvantagesData {
  /** 板块小标签（如"核心优势"） */
  badge?: string;
  title: string;
  subtitle?: string;
  items: AdvantageRow[];
}

const DEFAULT_ADVANTAGES: AdvantagesData = {
  badge: "核心优势",
  title: "一条 AI 流水线，从产品图到货架",
  subtitle: "四大能力覆盖选品、测款到上架的全流程，专为 Amazon 卖家打造",
  items: [
    {
      badge: "全流程自动化",
      title: "从产品图到货架",
      desc: "上传一张白底产品图，AI 自动完成特征分析、多场景生成与 A+ 详情页排版，一条流水线直达 Amazon 货架。",
      points: [
        "上传白底图，自动分析产品特征",
        "多场景模特图 + A+ 详情页一键排版",
        "HTML + 高清图打包，直接上传上架",
      ],
      cta: "立即体验",
      href: "/build",
      image: "/gallery/product-launch.png",
    },
    {
      badge: "数据驱动选品",
      title: "市场潜力预测",
      desc: "生成同时并行联网分析 Amazon US 市场：销量、定价、竞争与利润预估，让每一款选品都有数据支撑。",
      points: [
        "并行联网分析 Amazon US 市场",
        "销量、定价、竞争、利润全维度预估",
        "每款选品决策都有数据背书",
      ],
      cta: "立即体验",
      href: "/build",
      image: "/gallery/editorial.png",
    },
    {
      badge: "越用越懂你",
      title: "AI 偏好学习",
      desc: "点赞与反馈自动沉淀进偏好画像，越用越懂你的审美，生成结果持续贴合品牌调性。",
      points: [
        "点赞 / 反馈自动沉淀偏好画像",
        "生成结果持续贴合品牌调性",
        "风格一致性跨任务保持",
      ],
      cta: "立即体验",
      href: "/build",
      image: "/models/european.jpg",
    },
    {
      badge: "低成本快速验证",
      title: "低成本快速测款",
      desc: "无需摄影棚与模特，几分钟产出全套场景图，用远低于实拍的成本批量验证款式市场反应。",
      points: [
        "无需摄影棚、模特与摄制团队",
        "几分钟产出全套模特场景图",
        "低成本批量测款，快速验证市场",
      ],
      cta: "立即体验",
      href: "/build",
      image: "/models/east-asian.jpg",
    },
  ],
};

export default function AdvantagesSection({ data }: { data?: AdvantagesData }) {
  const d = data || DEFAULT_ADVANTAGES;
  if (!d.items || d.items.length === 0) return null;

  return (
    <section id="advantages" className="py-12 lg:py-24">
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

        <div className="flex flex-col gap-16 lg:gap-24">
          {d.items.map((item, i) => {
            const textOrder = i % 2 === 0 ? "md:order-2" : "md:order-1";
            const imgOrder = i % 2 === 0 ? "md:order-1" : "md:order-2";
            return (
              <div key={item.title} className="grid md:grid-cols-2 gap-10 lg:gap-12 items-center">
                {/* 文字侧 */}
                <div className={`order-2 ${textOrder}`}>
                  {item.badge && (
                    <div className="uppercase w-fit text-base lg:text-lg font-semibold tracking-widest mb-6 text-gray-500 bg-gray-50 px-4 py-2 rounded-full">
                      {item.badge}
                    </div>
                  )}
                  <h3 className="text-2xl lg:text-4xl mb-6 text-gray-900">{item.title}</h3>
                  <p className="mb-6 leading-relaxed text-gray-600 max-w-lg lg:text-lg">{item.desc}</p>
                  <ul className="mb-8 space-y-3">
                    {item.points.map((pt) => (
                      <li key={pt} className="flex items-start gap-3">
                        <div className="w-6 h-6 bg-gray-900 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-white">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </div>
                        <span className="text-gray-600 lg:text-lg leading-relaxed">{pt}</span>
                      </li>
                    ))}
                  </ul>
                  <a
                    href={item.href || "/build"}
                    className="inline-flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-800 hover:shadow-xl transition-all h-11 px-8 py-6 rounded-full text-lg text-white group"
                  >
                    <span className="flex gap-2 items-center">
                      {item.cta}
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 group-hover:translate-x-1 transition-all">
                        <path d="M5 12h14" />
                        <path d="m12 5 7 7-7 7" />
                      </svg>
                    </span>
                  </a>
                </div>

                {/* 图侧 */}
                <div className={`flex items-center perspective-1000 order-1 ${imgOrder}`}>
                  <div className="flex items-center justify-center relative transition-all duration-200 ease-linear rounded-2xl overflow-hidden shadow-2xl bg-gray-50 border border-gray-200 hover:scale-105 transform-style-preserve-3d w-full max-w-[500px] mx-auto aspect-square">
                    {item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.image} alt={item.title} loading="lazy" className="object-cover w-full h-full mx-auto" />
                    ) : (
                      <span className="text-8xl">{item.emoji}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
