/** 文生图尺寸与 generateImage 云函数白名单保持一致，不接受前端扩展。 */
export const TEXT_IMAGE_SIZES = ['1024x1024', '1280x1280', '1280x720', '720x1280'] as const;
export type TextImageSize = typeof TEXT_IMAGE_SIZES[number];
