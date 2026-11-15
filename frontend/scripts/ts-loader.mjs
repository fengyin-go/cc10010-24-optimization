/**
 * 仅核验脚本用：让 Node 原生 ESM 能解析源码里 Vite/TS 风格的无扩展名相对导入。
 * 业务代码仍保持 bundler 写法，这个钩子不参与 vite 构建。
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
