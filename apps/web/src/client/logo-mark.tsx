import { cn } from "@/client/lib/utils";

/**
 * nanaichi のマーク。「7·1」は集中7分とジャーナル1分。ヘッダーとログイン画面で使う。
 * 大きさと角の丸みは使う側が className で決める
 */
export const LogoMark = ({ className }: Readonly<{ className?: string }>) => (
  <span
    aria-hidden
    className={cn(
      "flex items-center justify-center bg-primary font-mono font-medium text-primary-foreground",
      className,
    )}
  >
    7·1
  </span>
);
