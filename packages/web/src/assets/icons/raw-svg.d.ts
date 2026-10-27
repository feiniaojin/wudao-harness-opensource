// raw-svg.d.ts — vite `?raw` 导入的 TS 声明（components/Icon.tsx 消费）。
// vite 客户端类型未在本包 tsconfig 引入（无 client 三斜线），此处自带最小声明。
declare module "*.svg?raw" {
  const content: string;
  export default content;
}
