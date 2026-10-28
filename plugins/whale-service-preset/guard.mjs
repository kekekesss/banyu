export const name = 'whale-service-no-tools';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '客服模型只生成回复文本；不允许调用外部工具或访问本机。');
}
