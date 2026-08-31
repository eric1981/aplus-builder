"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, logout } from "../lib/auth-client";

/** 亚马逊风格顶部导航（深藏青 #131921） */
export default function AmazonNav() {
  const { user } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="amz-navbar">
      <div className="max-w-[1500px] mx-auto px-4 h-12 sm:h-14 flex items-center gap-4 sm:gap-8">
        <Link href="/" className="text-base sm:text-lg font-bold whitespace-nowrap shrink-0">
          <span className="text-[#ff9900]">aplus</span>
          <span className="text-white">-builder</span>
        </Link>

        <nav className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm flex-1 overflow-x-auto">
          <Link href="/build" className="whitespace-nowrap hover:text-[#ff9900]">生成</Link>
          <Link href="/output" className="whitespace-nowrap hover:text-[#ff9900]">产出</Link>
          <Link href="/customers" className="whitespace-nowrap hover:text-[#ff9900]">客户</Link>
          <Link href="/style-extract" className="whitespace-nowrap hover:text-[#ff9900]">风格复刻</Link>
          {user?.role === "admin" && (
            <Link href="/admin" className="whitespace-nowrap hover:text-[#ff9900]">管理后台</Link>
          )}
        </nav>

        <div className="flex items-center gap-3 text-xs sm:text-sm whitespace-nowrap shrink-0">
          {user ? (
            <>
              <span className="text-gray-300 hidden md:inline">你好，{user.name}</span>
              <button onClick={handleLogout} className="hover:text-[#ff9900] cursor-pointer">退出</button>
            </>
          ) : (
            <Link href="/login" className="hover:text-[#ff9900]">登录</Link>
          )}
        </div>
      </div>
    </header>
  );
}
