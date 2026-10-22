// Icon.tsx — 116 去廉价化第三弧：本地 SVG 集的统一渲染面。
//
// 图形来源：src/assets/icons/（lucide-static v1.48.0 vendor 子集，脚本
// scripts/vendor-icons.mjs 归一：描边 1.5px / currentColor / 剥 width·height·
// class——收据 arc116c-icon-system 钉 (b)）。零运行时依赖：`?raw` 原文导入，
// 模块加载时一次性剥出 inner 标记，渲染成与 components/icons.tsx 自绘集
// 同规格的 <svg>（同 viewBox/描边/线帽/0.9 光学缩放——两套字形同屏零落差）。
//
// 着色律（116 弧红线）：本组件零自带颜色——currentColor 继承消费面文字色；
// 语义位（warn/danger）由消费面的 CSS 类着 var(--warn)/var(--danger)，
// 中性位随文字色（text-2 由消费面类给）。四主题自动成立，禁裸 hex。
import React from "react";

// 用户 2026-08-22：应用内图标整体缩小 10% —— 与 components/icons.tsx 的
// ICON_SCALE 同值同因（one scale point for every glyph；remove to restore）。
const ICON_SCALE = 0.9;

// vendored 集原文导入（name = 文件名 = 映射表键；清单单源在
// scripts/vendor-icons.mjs 的 MANIFEST）。
import hourglass from "../assets/icons/hourglass.svg?raw";
import zap from "../assets/icons/zap.svg?raw";
import clock from "../assets/icons/clock.svg?raw";
import clipboardList from "../assets/icons/clipboard-list.svg?raw";
import key from "../assets/icons/key.svg?raw";
import cornerDownLeft from "../assets/icons/corner-down-left.svg?raw";
import circleHelp from "../assets/icons/circle-help.svg?raw";
import image from "../assets/icons/image.svg?raw";
import brain from "../assets/icons/brain.svg?raw";
import partyPopper from "../assets/icons/party-popper.svg?raw";
import star from "../assets/icons/star.svg?raw";
import chartColumn from "../assets/icons/chart-column.svg?raw";
import film from "../assets/icons/film.svg?raw";
import fileText from "../assets/icons/file-text.svg?raw";
import trash2 from "../assets/icons/trash-2.svg?raw";
import shield from "../assets/icons/shield.svg?raw";
import shieldX from "../assets/icons/shield-x.svg?raw";
import listChecks from "../assets/icons/list-checks.svg?raw";
import triangleAlert from "../assets/icons/triangle-alert.svg?raw";

/** Icon name = vendored 文件名（ts 推导的字符串字面量联合，写错编译期即报）。 */
export type IconName =
  | "hourglass"
  | "zap"
  | "clock"
  | "clipboard-list"
  | "key"
  | "corner-down-left"
  | "circle-help"
  | "image"
  | "brain"
  | "party-popper"
  | "star"
  | "chart-column"
  | "film"
  | "file-text"
  | "trash-2"
  | "shield"
  | "shield-x"
  | "list-checks"
  | "triangle-alert";

const RAW: Readonly<Record<IconName, string>> = {
  hourglass,
  zap,
  clock,
  "clipboard-list": clipboardList,
  key,
  "corner-down-left": cornerDownLeft,
  "circle-help": circleHelp,
  image,
  brain,
  "party-popper": partyPopper,
  star,
  "chart-column": chartColumn,
  film,
  "file-text": fileText,
  "trash-2": trash2,
  shield,
  "shield-x": shieldX,
  "list-checks": listChecks,
  "triangle-alert": triangleAlert,
};

// 模块加载时一次性解析：外层 <svg …> 剥掉（尺寸/类名/描边由本组件给），
// 留 inner 标记 + viewBox。注意定位必须从 "<svg" 起步——文件头有 @license
// 注释，若只找第一个 ">" 会把注释的 ">" 当开标签尾，内层就会嵌进一个
// 重复的 <svg> 开标签（omega99-224 的字节快照钉住的正是这个坑）。
const parse = (raw: string): { readonly viewBox: string; readonly inner: string } => {
  const openStart = raw.indexOf("<svg");
  const openEnd = raw.indexOf(">", openStart);
  const close = raw.lastIndexOf("</svg>");
  const viewBox = /viewBox="([^"]+)"/.exec(raw)?.[1] ?? "0 0 24 24";
  return { viewBox, inner: raw.slice(openEnd + 1, close) };
};

const PARSED: Readonly<Record<IconName, ReturnType<typeof parse>>> = Object.fromEntries(
  (Object.keys(RAW) as IconName[]).map((n) => [n, parse(RAW[n])]),
) as Readonly<Record<IconName, ReturnType<typeof parse>>>;

export function Icon({
  name,
  size = 16,
  className,
  filled = false,
}: {
  readonly name: IconName;
  /** px（0.9 光学缩放前）；缺省 16 与自绘集一致 */
  readonly size?: number;
  readonly className?: string;
  /** 实心态（目前唯一消费者：ProviderDetail 启动默认模型的已选星 ★）——
   * fill="currentColor" 填充，描边保留（星形填充后线宽视觉收敛，恰好）。 */
  readonly filled?: boolean;
}): React.JSX.Element {
  const { viewBox, inner } = PARSED[name];
  return (
    <svg
      width={(size ?? 16) * ICON_SCALE}
      height={(size ?? 16) * ICON_SCALE}
      viewBox={viewBox}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className={className === undefined ? "ic" : `ic ${className}`}
      // vendored inner 是构建期定死的标记（非用户输入），无注入面。
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
