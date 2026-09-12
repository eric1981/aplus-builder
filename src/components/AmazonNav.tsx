"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth, logout, refreshAuth } from "../lib/auth-client";
import { getClientBrand } from "../lib/brand";

/** 品牌风格顶部导航（默认深藏青 #131921，可按客户主题定制） */
export default function AmazonNav() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const brand = getClientBrand();

  // 余额随导航刷新：layout 里的导航在客户端路由切换时不会重新挂载，
  // 因此这里在路径变化时触发一次 auth 重新拉取（含最新积分余额）。
  useEffect(() => {
    refreshAuth();
  }, [pathname]);

  const handleLogout = async () => {
    await logout();
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="amz-navbar">
      <div className="max-w-[1500px] mx-auto px-4 h-12 sm:h-14 flex items-center gap-4 sm:gap-8">
        <Link href="/" className="text-base sm:text-lg font-bold whitespace-nowrap shrink-0">
          <span style={{ color: "var(--accent)" }}>{brand.logoPart1}</span>
          <span className="text-white">{brand.logoPart2}</span>
        </Link>

        <nav className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm flex-1 overflow-x-auto">
          <Link href="/build" className="nav-accent whitespace-nowrap">生成</Link>
          <Link href="/output" className="whitespace-nowrap hover:text-[var(--accent)]">产出</Link>
          <Link href="/customers" className="whitespace-nowrap hover:text-[var(--accent)]">客户</Link>
          <Link href="/style-extract" className="whitespace-nowrap hover:text-[var(--accent)]">风格复刻</Link>
          <Link href="/billing" className="whitespace-nowrap hover:text-[var(--accent)]">充值</Link>
          {user && (
            <Link href="/affiliate" className="whitespace-nowrap hover:text-[var(--accent)]">分销</Link>
          )}
          {user?.role === "admin" && (
            <Link href="/admin" className="whitespace-nowrap hover:text-[var(--accent)]">管理后台</Link>
          )}
        </nav>

        <div className="flex items-center gap-3 text-xs sm:text-sm whitespace-nowrap shrink-0">
          {user ? (
            <>
              <Link href="/billing" className="nav-credits whitespace-nowrap" title="积分余额（点击充值 / 查看账单）">
                积分{" "}
                <span className={typeof user.credits === "number" && user.credits <= 5 ? "nav-credits-low font-semibold" : "font-semibold"}>
                  {typeof user.credits === "number" ? user.credits : "—"}
                </span>
              </Link>
              <span className="text-gray-300 hidden md:inline">你好，{user.name}</span>
              <button onClick={handleLogout} className="hover:text-[var(--accent)] cursor-pointer">退出</button>
            </>
          ) : (
            <Link href="/login" className="hover:text-[var(--accent)]">登录</Link>
          )}
        </div>
      </div>
    </header>
  );
}
