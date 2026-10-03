/** 文生图仅开放 CloudBase 面积不超过 1024×1024 的尺寸。 */
export const TEXT_IMAGE_SIZES = ['1024x1024', '1280x720', '720x1280'] as const;
export type TextImageSize = typeof TEXT_IMAGE_SIZES[number];
